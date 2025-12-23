/**
 * SimpleSyncService - 简化的同步服务
 * 
 * 核心原则（来自 agents.md）：
 * - 利用 Supabase Realtime 做同步
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 * 
 * 设计目标：替代 2300+ 行的 sync.service.ts
 * - 移除复杂的冲突处理（LWW 足够）
 * - 移除 RxJS 队列（改用简单数组 + 定时器）
 * - 保留 Realtime 订阅能力
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { Task, Project, Connection, UserPreferences, ThemeType } from '../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import { supabaseErrorToError } from '../../../utils/supabase-error';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

/**
 * 重试队列项
 */
interface RetryQueueItem {
  id: string;
  type: 'task' | 'project' | 'connection';
  operation: 'upsert' | 'delete';
  data: Task | Project | Connection | { id: string };
  projectId?: string;
  retryCount: number;
  createdAt: number;
}

/**
 * 同步状态 - 兼容旧 SyncService 接口
 */
interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  lastSyncTime: string | null;
  pendingCount: number;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: ConflictData | null;
}

/**
 * 冲突数据
 */
interface ConflictData {
  local: Project;
  remote: Project;
  remoteData?: Project;  // 兼容旧接口别名
  projectId: string;
}

/**
 * 远程变更回调 - 兼容旧接口
 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/**
 * 任务变更回调 - 兼容旧接口
 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

@Injectable({
  providedIn: 'root'
})
export class SimpleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SimpleSync');
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  
  /**
   * 获取 Supabase 客户端，离线模式返回 null
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      return null;
    }
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }
  
  /** 同步状态 - 兼容旧 SyncService 接口 */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null,
    pendingCount: 0,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 兼容旧接口：state 别名 */
  readonly state = this.syncState;
  
  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  
  /** 是否正在从远程加载 - 兼容旧接口 */
  readonly isLoadingRemote = signal(false);
  
  /** Realtime 更新是否暂停 */
  private realtimePaused = false;
  
  /** 重试队列 */
  private retryQueue: RetryQueueItem[] = [];
  
  /** 重试定时器 */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 最大重试次数 */
  private readonly MAX_RETRIES = 5;
  
  /** 重试间隔（毫秒） */
  private readonly RETRY_INTERVAL = 5000;
  
  /** 重试队列持久化 key */
  private readonly RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
  
  /** 重试队列版本号（用于格式兼容） */
  private readonly RETRY_QUEUE_VERSION = 1;
  
  /** Realtime 订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;
  
  constructor() {
    this.loadRetryQueueFromStorage(); // 恢复持久化的重试队列
    this.setupNetworkListeners();
    this.startRetryLoop();
    
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }
  
  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    
    const handleOnline = () => {
      this.logger.info('网络恢复');
      this.state.update(s => ({ ...s, isOnline: true }));
      this.processRetryQueue();
    };
    
    const handleOffline = () => {
      this.logger.info('网络断开');
      this.state.update(s => ({ ...s, isOnline: false }));
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    });
  }
  
  /**
   * 启动重试循环
   */
  private startRetryLoop(): void {
    this.retryTimer = setInterval(() => {
      if (this.state().isOnline && this.retryQueue.length > 0) {
        this.processRetryQueue();
      }
    }, this.RETRY_INTERVAL);
  }
  
  /**
   * 清理资源
   */
  private cleanup(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
  
  // ==================== 任务同步 ====================
  
  /**
   * 推送任务到云端
   * 使用 upsert 实现 LWW
   */
  async pushTask(task: Task, projectId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('task', 'upsert', task, projectId);
      return false;
    }
    
    try {
      const { error } = await client
        .from('tasks')
        .upsert({
          id: task.id,
          project_id: projectId,
          title: task.title,
          content: task.content,
          stage: task.stage,
          parent_id: task.parentId,
          order: task.order,  // 数据库列名为 "order"
          rank: task.rank,
          status: task.status,
          x: task.x,
          y: task.y,
          // displayId 由客户端动态计算，不存储到数据库
          short_id: task.shortId,
          deleted_at: task.deletedAt || null,
          updated_at: task.updatedAt || nowISO()
        });
      
      if (error) throw supabaseErrorToError(error);
      
      this.state.update(s => ({ ...s, lastSyncTime: nowISO() }));
      return true;
    } catch (e) {
      const err = e as any;
      const isRetryable = err.isRetryable || false;
      const errorName = err.name || 'Error';
      
      // 根据错误类型选择日志级别
      if (isRetryable) {
        // 网络相关错误：静默处理，仅 debug 日志
        this.logger.debug(`推送任务失败 (${errorName})，已加入重试队列`, err.message);
      } else {
        // 非网络错误：记录完整错误
        this.logger.error('推送任务失败', e);
      }
      
      // 报告到 Sentry，但标记可重试错误的级别
      Sentry.captureException(e, { 
        tags: { 
          operation: 'pushTask',
          errorType: errorName,
          isRetryable: isRetryable.toString()
        },
        level: isRetryable ? 'info' : 'error'
      });
      
      this.addToRetryQueue('task', 'upsert', task, projectId);
      return false;
    }
  }
  
  /**
   * 从云端拉取任务
   * LWW：只更新 updated_at 更新的数据
   */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let query = client
        .from('tasks')
        .select('*')
        .eq('project_id', projectId);
      
      if (since) {
        query = query.gt('updated_at', since);
      }
      
      const { data, error } = await query;
      
      if (error) throw supabaseErrorToError(error);
      
      // 转换为本地模型（data 类型为 TaskRow[]）
      return (data as TaskRow[] || []).map(row => this.rowToTask(row));
    } catch (e) {
      this.logger.error('拉取任务失败', e);
      return [];
    }
  }
  
  /**
   * 删除云端任务
   */
  async deleteTask(taskId: string, projectId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      return false;
    }
    
    try {
      const { error } = await client
        .from('tasks')
        .delete()
        .eq('id', taskId);
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('删除任务失败', e);
      Sentry.captureException(e, { tags: { operation: 'deleteTask' } });
      this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      return false;
    }
  }
  
  // ==================== 项目同步 ====================
  
  /**
   * 推送项目到云端
   * 注意：RLS 策略要求 owner_id = auth.uid()，所以需要设置 owner_id
   */
  async pushProject(project: Project): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
    
    try {
      // 获取当前用户 ID（RLS 策略需要 owner_id = auth.uid()）
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        this.logger.warn('推送项目失败：用户未登录');
        return false;
      }
      
      const { error } = await client
        .from('projects')
        .upsert({
          id: project.id,
          owner_id: userId,  // RLS 策略必需
          title: project.name,
          description: project.description,
          version: project.version || 1,
          updated_at: project.updatedAt || nowISO(),
          migrated_to_v2: true
        });
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('推送项目失败', e);
      Sentry.captureException(e, { tags: { operation: 'pushProject' } });
      this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
  }
  
  /**
   * 拉取项目列表
   */
  async pullProjects(since?: string): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let query = client
        .from('projects')
        .select('*');
      
      if (since) {
        query = query.gt('updated_at', since);
      }
      
      const { data, error } = await query;
      
      if (error) throw supabaseErrorToError(error);
      
      return (data as ProjectRow[] || []).map(row => this.rowToProject(row));
    } catch (e) {
      this.logger.error('拉取项目失败', e);
      return [];
    }
  }
  
  // ==================== 连接同步 ====================
  
  /**
   * 推送连接到云端
   */
  async pushConnection(connection: Connection, projectId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
    
    try {
      const { error } = await client
        .from('connections')
        .upsert({
          id: connection.id,
          project_id: projectId,
          source_id: connection.source,
          target_id: connection.target,
          description: connection.description || null,
          deleted_at: connection.deletedAt || null
        });
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('推送连接失败', e);
      Sentry.captureException(e, { tags: { operation: 'pushConnection' } });
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
  }
  
  // ==================== 重试队列 ====================
  
  /**
   * 从 localStorage 加载重试队列
   * 在构造函数中调用，恢复页面刷新前未完成的同步操作
   */
  private loadRetryQueueFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const stored = localStorage.getItem(this.RETRY_QUEUE_STORAGE_KEY);
      if (!stored) return;
      
      const parsed = JSON.parse(stored);
      
      // 版本检查：如果版本不匹配，丢弃旧数据
      if (parsed.version !== this.RETRY_QUEUE_VERSION) {
        this.logger.warn('重试队列版本不匹配，清空旧数据');
        localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
        return;
      }
      
      // 恢复队列
      if (Array.isArray(parsed.items)) {
        this.retryQueue = parsed.items;
        this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
        this.logger.info(`从存储恢复 ${this.retryQueue.length} 个待同步项`);
      }
    } catch (e) {
      this.logger.error('加载重试队列失败', e);
      localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
    }
  }
  
  /**
   * 将重试队列保存到 localStorage
   * 在队列变化时调用，防止页面刷新丢失
   */
  private saveRetryQueueToStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      if (this.retryQueue.length === 0) {
        // 队列为空时删除存储
        localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
        return;
      }
      
      const data = {
        version: this.RETRY_QUEUE_VERSION,
        items: this.retryQueue,
        savedAt: Date.now()
      };
      
      localStorage.setItem(this.RETRY_QUEUE_STORAGE_KEY, JSON.stringify(data));
      this.logger.debug(`保存 ${this.retryQueue.length} 个待同步项到存储`);
    } catch (e) {
      this.logger.error('保存重试队列失败', e);
    }
  }
  
  /**
   * 添加到重试队列
   */
  private addToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: any,
    projectId?: string
  ): void {
    const item: RetryQueueItem = {
      id: crypto.randomUUID(),
      type,
      operation,
      data,
      projectId,
      retryCount: 0,
      createdAt: Date.now()
    };
    
    this.retryQueue.push(item);
    this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
    this.saveRetryQueueToStorage(); // 持久化
    
    this.logger.debug('添加到重试队列', { type, operation, dataId: data.id });
  }
  
  /**
   * 处理重试队列
   */
  private async processRetryQueue(): Promise<void> {
    if (this.state().isSyncing || !this.state().isOnline) return;
    
    this.state.update(s => ({ ...s, isSyncing: true }));
    
    const itemsToProcess = [...this.retryQueue];
    this.retryQueue = [];
    
    for (const item of itemsToProcess) {
      let success = false;
      
      try {
        if (item.type === 'task') {
          if (item.operation === 'upsert') {
            success = await this.pushTask(item.data as Task, item.projectId!);
          } else {
            success = await this.deleteTask(item.data.id, item.projectId!);
          }
        } else if (item.type === 'project') {
          success = await this.pushProject(item.data as Project);
        } else if (item.type === 'connection') {
          success = await this.pushConnection(item.data as Connection, item.projectId!);
        }
      } catch (e) {
        this.logger.error('重试失败', e);
        Sentry.captureException(e, { tags: { operation: 'retryQueue', type: item.type } });
      }
      
      if (!success) {
        item.retryCount++;
        if (item.retryCount < this.MAX_RETRIES) {
          this.retryQueue.push(item);
        } else {
          this.logger.warn('重试次数超限，放弃', { type: item.type, id: item.data.id });
          this.toast.error('部分数据同步失败，请检查网络连接');
        }
      }
    }
    
    this.saveRetryQueueToStorage(); // 持久化更新后的队列
    
    this.state.update(s => ({
      ...s,
      isSyncing: false,
      pendingCount: this.retryQueue.length
    }));
  }
  
  // ==================== 数据转换 ====================
  
  /**
   * 数据库行转换为 Task 模型
   * 使用 TaskRow 类型确保类型安全
   */
  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title || '',
      content: row.content || '',
      stage: row.stage,
      parentId: row.parent_id,
      order: row.order || 0,
      rank: row.rank || 0,
      status: row.status || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at,
      updatedAt: row.updated_at,
      displayId: '',  // displayId 由客户端计算
      shortId: row.short_id || undefined,
      deletedAt: row.deleted_at || undefined
    };
  }
  
  /**
   * 数据库行转换为 Project 模型
   * 使用 ProjectRow 类型确保类型安全
   */
  private rowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_date || '',
      updatedAt: row.updated_at || undefined,
      version: row.version || 1,
      tasks: [],
      connections: []
    };
  }
  
  /**
   * 数据库行转换为 Connection 模型
   * 使用 ConnectionRow 类型确保类型安全
   */
  private rowToConnection(row: ConnectionRow): Connection {
    return {
      id: row.id,
      source: row.source_id,
      target: row.target_id,
      description: row.description || '',
      deletedAt: row.deleted_at ?? undefined
    };
  }
  
  // ==================== Realtime 订阅 ====================
  
  /**
   * 设置远程变更回调
   */
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.onRemoteChangeCallback = callback;
  }
  
  /**
   * 订阅项目实时变更
   */
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    const client = this.getSupabaseClient();
    if (!client) return;
    
    // 先取消旧订阅
    await this.unsubscribeFromProject();
    
    const channelName = `project:${projectId}:${userId.substring(0, 8)}`;
    
    this.realtimeChannel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          this.logger.debug('收到任务变更', { event: payload.eventType });
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: payload.eventType, 
              projectId 
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'connections',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          this.logger.debug('收到连接变更', { event: payload.eventType });
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: payload.eventType, 
              projectId 
            });
          }
        }
      )
      .subscribe((status) => {
        this.logger.info('Realtime 订阅状态', { status, channel: channelName });
      });
  }
  
  /**
   * 取消订阅
   */
  async unsubscribeFromProject(): Promise<void> {
    if (this.realtimeChannel) {
      const client = this.getSupabaseClient();
      if (client) {
        await client.removeChannel(this.realtimeChannel);
      }
      this.realtimeChannel = null;
    }
  }
  
  // ==================== 用户偏好 ====================
  
  /**
   * 加载用户偏好
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      const { data, error } = await client
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // 没有找到记录，返回 null
          return null;
        }
        throw error;
      }
      
      return {
        theme: (data.theme as ThemeType) || 'default',
        layoutDirection: (data.layout_direction as 'ltr' | 'rtl') || 'ltr',
        floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') || 'auto'
      };
    } catch (e) {
      this.logger.error('加载用户偏好失败', e);
      return null;
    }
  }
  
  /**
   * 保存用户偏好
   */
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client
        .from('user_preferences')
        .upsert({
          user_id: userId,
          theme: preferences.theme,
          updated_at: nowISO()
        });
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('保存用户偏好失败', e);
      return false;
    }
  }
  
  // ==================== 冲突解决（LWW） ====================
  
  /**
   * 解决冲突 - 使用 LWW 策略
   * @param projectId 项目 ID
   * @param resolvedProject 解决后的项目
   * @param strategy 'local' | 'remote' - 仅用于日志
   */
  resolveConflict(projectId: string, resolvedProject: Project, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    
    // 清除冲突状态
    this.syncState.update(s => ({
      ...s,
      hasConflict: false,
      conflictData: null
    }));
  }
  
  /**
   * 设置冲突状态
   */
  setConflict(conflictData: ConflictData): void {
    this.syncState.update(s => ({
      ...s,
      hasConflict: true,
      conflictData
    }));
  }
  
  // ==================== 完整项目同步 ====================
  
  /**
   * 保存完整项目到云端（包含任务和连接）
   * 兼容旧 SyncService 接口
   */
  async saveProjectToCloud(
    project: Project,
    _userId: string
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('project', 'upsert', project);
      return { success: false };
    }
    
    this.syncState.update(s => ({ ...s, isSyncing: true }));
    
    try {
      // 1. 保存项目元数据
      await this.pushProject(project);
      
      // 2. 批量保存任务
      for (const task of project.tasks) {
        await this.pushTask(task, project.id);
      }
      
      // 3. 批量保存连接
      for (const connection of project.connections) {
        await this.pushConnection(connection, project.id);
      }
      
      this.syncState.update(s => ({
        ...s,
        isSyncing: false,
        lastSyncTime: nowISO()
      }));
      
      return { success: true, newVersion: project.version };
    } catch (e) {
      this.logger.error('保存项目失败', e);
      Sentry.captureException(e, { tags: { operation: 'saveProject' } });
      this.syncState.update(s => ({
        ...s,
        isSyncing: false,
        syncError: '保存失败'
      }));
      return { success: false };
    }
  }
  
  /**
   * 智能保存项目（兼容旧 SyncService 接口）
   * SimpleSyncService 使用 LWW 策略，直接调用 saveProjectToCloud
   */
  async saveProjectSmart(
    project: Project,
    userId: string
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[] }> {
    const result = await this.saveProjectToCloud(project, userId);
    return { ...result, newVersion: project.version };
  }
  
  /**
   * 加载完整项目（包含任务和连接）
   */
  async loadFullProject(projectId: string, _userId: string): Promise<Project | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      // 1. 加载项目元数据
      const { data: projectData, error: projectError } = await client
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single();
      
      if (projectError) throw projectError;
      
      // 2. 加载任务
      const tasks = await this.pullTasks(projectId);
      
      // 3. 加载连接
      const { data: connectionsData } = await client
        .from('connections')
        .select('*')
        .eq('project_id', projectId)
        .is('deleted_at', null);
      
      const connections = (connectionsData || []).map((row: any) => ({
        id: row.id,
        source: row.source_id,
        target: row.target_id,
        description: row.description || ''
      }));
      
      const project = this.rowToProject(projectData);
      project.tasks = tasks.filter(t => !t.deletedAt);
      project.connections = connections;
      
      return project;
    } catch (e) {
      this.logger.error('加载项目失败', e);
      Sentry.captureException(e, { tags: { operation: 'loadFullProject' } });
      return null;
    }
  }
  
  /**
   * 清除离线缓存
   */
  clearOfflineCache(): void {
    this.retryQueue = [];
    this.syncState.update(s => ({ ...s, pendingCount: 0 }));
    this.logger.info('离线缓存已清除');
  }
  
  // ==================== 离线快照 ====================
  
  private readonly OFFLINE_CACHE_KEY = 'nanoflow.offline-cache';
  private readonly CACHE_VERSION = 2;
  
  /**
   * 保存离线快照
   * 用于断网时的数据持久化
   */
  saveOfflineSnapshot(projects: Project[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.OFFLINE_CACHE_KEY, JSON.stringify({
        projects,
        version: this.CACHE_VERSION
      }));
    } catch (e) {
      this.logger.warn('离线快照保存失败', e);
    }
  }
  
  /**
   * 加载离线快照
   */
  loadOfflineSnapshot(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const cached = localStorage.getItem(this.OFFLINE_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          return parsed.projects;
        }
      }
    } catch (e) {
      this.logger.warn('离线快照加载失败', e);
    }
    return null;
  }
  
  // ==================== 兼容旧 SyncService 接口 ====================
  
  /** 任务变更回调 */
  private taskChangeCallback: TaskChangeCallback | null = null;
  
  /**
   * 设置远程变更回调
   */
  setRemoteChangeCallback(callback: RemoteChangeCallback): void {
    this.onRemoteChangeCallback = callback;
  }
  
  /**
   * 设置任务变更回调
   */
  setTaskChangeCallback(callback: TaskChangeCallback): void {
    this.taskChangeCallback = callback;
  }
  
  /**
   * 初始化 Realtime 订阅
   * @param userId 用户 ID（兼容旧接口，实际订阅在 subscribeToProject 中进行）
   */
  async initRealtimeSubscription(userId: string): Promise<void> {
    // 旧接口兼容：实际订阅在 subscribeToProject 中按项目维度进行
    // 这里只是标记用户已准备好接收实时更新
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }
  
  /**
   * 关闭 Realtime 订阅
   */
  teardownRealtimeSubscription(): void {
    this.unsubscribeFromProject();
  }
  
  /**
   * 暂停 Realtime 更新
   */
  pauseRealtimeUpdates(): void {
    this.realtimePaused = true;
    this.logger.debug('Realtime 更新已暂停');
  }
  
  /**
   * 恢复 Realtime 更新
   */
  resumeRealtimeUpdates(): void {
    this.realtimePaused = false;
    this.logger.debug('Realtime 更新已恢复');
  }
  
  /**
   * 从云端加载项目列表（包含任务和连接）
   * @param userId 用户 ID
   * @param _silent 静默模式（兼容旧接口，忽略）
   */
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    this.isLoadingRemote.set(true);
    
    try {
      // 注意：projects 表没有 deleted_at 列，项目删除是硬删除
      const { data, error } = await client
        .from('projects')
        .select('*')
        .eq('owner_id', userId)  // 数据库列名为 owner_id
        .order('updated_at', { ascending: false });
      
      if (error) throw supabaseErrorToError(error);
      
      // 为每个项目加载完整数据（任务和连接）
      const projects: Project[] = [];
      for (const row of (data || [])) {
        const project = await this.loadFullProject(row.id, userId);
        if (project) {
          projects.push(project);
        }
      }
      
      return projects;
    } catch (e) {
      this.logger.error('加载项目列表失败', e);
      Sentry.captureException(e, { tags: { operation: 'loadRemoteProjects' } });
      return [];
    } finally {
      this.isLoadingRemote.set(false);
    }
  }
  
  /**
   * 从云端删除项目
   * 注意：projects 表使用硬删除（没有 deleted_at 列）
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      // 硬删除：projects 表没有 deleted_at 列
      // 关联的 tasks 和 connections 会通过外键 CASCADE 自动删除
      const { error } = await client
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('owner_id', userId);  // 数据库列名为 owner_id
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('删除项目失败', e);
      Sentry.captureException(e, { tags: { operation: 'deleteProject' } });
      return false;
    }
  }
  
  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.loadFullProject(projectId, userId);
  }
  
  /**
   * 尝试重新加载冲突数据
   * @param userId 用户 ID
   * @param _findProject 查找项目函数（兼容旧接口，忽略）
   */
  async tryReloadConflictData(
    userId: string, 
    _findProject?: (id: string) => Project | undefined
  ): Promise<Project | undefined> {
    // SimpleSyncService 使用 LWW，冲突场景简化处理
    const state = this.syncState();
    if (!state.hasConflict || !state.conflictData) {
      return undefined;
    }
    const project = await this.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }
  
  /**
   * 销毁服务（清理资源）
   */
  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.retryQueue = [];
    this.logger.info('SimpleSyncService 已销毁');
  }
}
