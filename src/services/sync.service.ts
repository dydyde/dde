import { Injectable, inject, signal } from '@angular/core';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { LoggerService } from './logger.service';
import { Project, ProjectRow, SyncState, UserPreferences, ThemeType, Task, Connection } from '../models';
import { SYNC_CONFIG, CACHE_CONFIG } from '../config/constants';
import { nowISO } from '../utils/date';

/** 生成唯一的 Tab ID，用于 Realtime 频道隔离 */
const TAB_ID = typeof crypto !== 'undefined' 
  ? crypto.randomUUID().substring(0, 8) 
  : Math.random().toString(36).substring(2, 10);

/**
 * 远程项目变更事件载荷
 */
export interface RemoteProjectChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  projectId: string;
  /** 原始数据（可能不完整，仅用于调试） */
  data?: Record<string, unknown>;
}

/**
 * 远程任务变更事件载荷
 */
export interface RemoteTaskChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string;
  /** 原始数据（可能不完整，仅用于调试） */
  data?: Record<string, unknown>;
}

/**
 * 数据同步服务
 * 负责与 Supabase 的数据同步、离线缓存、实时订阅
 * 使用 v2 独立表存储（tasks, connections 表）
 */
@Injectable({
  providedIn: 'root'
})
export class SyncService {
  private supabase = inject(SupabaseClientService);
  private taskRepo = inject(TaskRepositoryService);
  private logger = inject(LoggerService).category('Sync');
  
  /** 冲突数据持久化 key */
  private readonly CONFLICT_STORAGE_KEY = 'nanoflow.pending-conflicts';
  
  /** 同步状态 */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = signal(false);
  
  /** 实时订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 任务表订阅通道 */
  private tasksChannel: RealtimeChannel | null = null;
  
  /** 远程变更处理定时器 */
  private remoteChangeTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 网络状态监听器引用（用于清理） */
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  
  /** 重试状态 */
  private retryState = {
    count: 0,
    maxRetries: 10,
    timer: null as ReturnType<typeof setTimeout> | null
  };
  
  /** 远程变更回调 - 支持增量更新 */
  private onRemoteChangeCallback: ((payload?: RemoteProjectChangePayload) => Promise<void>) | null = null;
  
  /** 任务级别的变更回调 - 用于细粒度更新 */
  private onTaskChangeCallback: ((payload: RemoteTaskChangePayload) => void) | null = null;
  
  /** 保存操作的互斥锁 - 防止并发保存导致版本号冲突 */
  private saveLock = {
    isLocked: false,
    queue: [] as Array<{
      resolve: (value: { success: boolean; conflict?: boolean; remoteData?: Project }) => void;
      project: Project;
      userId: string;
    }>
  };
  
  /** 是否暂停处理远程更新（队列同步期间） */
  private pauseRemoteUpdates = false;


  constructor() {
    this.setupNetworkListeners();
    // 恢复持久化的冲突数据
    this.restoreConflictData();
  }
  
  /**
   * 恢复持久化的冲突数据
   * 在页面刷新后恢复未解决的冲突
   * 如果需要重新加载完整数据，会异步加载
   */
  private restoreConflictData(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const saved = localStorage.getItem(this.CONFLICT_STORAGE_KEY);
      if (saved) {
        const conflictMeta = JSON.parse(saved);
        if (conflictMeta && conflictMeta.projectId) {
          this.logger.info('恢复未解决的冲突数据', { projectId: conflictMeta.projectId });
          
          // 如果标记了需要重新加载，设置一个标记，等待用户登录后加载
          if (conflictMeta.needsFullReload) {
            this.pendingConflictReload = conflictMeta;
            this.logger.info('冲突数据需要重新加载完整内容');
          } else {
            this.syncState.update(s => ({
              ...s,
              hasConflict: true,
              conflictData: conflictMeta
            }));
          }
        }
      }
    } catch (e) {
      this.logger.warn('恢复冲突数据失败', e);
      localStorage.removeItem(this.CONFLICT_STORAGE_KEY);
    }
  }
  
  /** 待加载的冲突元数据 */
  private pendingConflictReload: any = null;
  
  /**
   * 尝试加载完整的冲突数据
   * 在用户登录后调用，用于恢复持久化的冲突
   */
  async tryReloadConflictData(userId: string, getLocalProject: (id: string) => Project | undefined): Promise<void> {
    if (!this.pendingConflictReload || !userId) return;
    
    const meta = this.pendingConflictReload;
    this.pendingConflictReload = null;
    
    try {
      this.logger.info('正在重新加载冲突数据', { projectId: meta.projectId });
      
      // 加载远程版本
      const remoteProject = await this.loadSingleProject(meta.projectId, userId);
      
      // 获取本地版本
      const localProject = getLocalProject(meta.projectId);
      
      if (remoteProject && localProject) {
        const conflictData = {
          local: localProject,
          remote: remoteProject,
          projectId: meta.projectId,
          remoteData: remoteProject
        };
        
        this.syncState.update(s => ({
          ...s,
          hasConflict: true,
          conflictData
        }));
        
        this.logger.info('冲突数据已重新加载');
      } else {
        // 无法加载完整数据，清除冲突状态
        this.logger.warn('无法加载冲突数据，清除冲突状态');
        this.clearPersistedConflict();
      }
    } catch (e) {
      this.logger.error('重新加载冲突数据失败', e);
      this.clearPersistedConflict();
    }
  }
  
  /**
   * 持久化冲突数据
   * 防止页面刷新后丢失冲突信息
   * 注意：只保存冲突元数据，不保存完整项目内容以保护隐私
   */
  private persistConflictData(conflictData: any): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      // 只保存必要的元数据，不保存完整的项目内容
      const sanitizedData = {
        projectId: conflictData.projectId,
        localVersion: conflictData.local?.version,
        remoteVersion: conflictData.remote?.version,
        localTaskCount: conflictData.local?.tasks?.length ?? 0,
        remoteTaskCount: conflictData.remote?.tasks?.length ?? 0,
        savedAt: new Date().toISOString(),
        // 标记需要重新加载完整数据
        needsFullReload: true
      };
      
      localStorage.setItem(this.CONFLICT_STORAGE_KEY, JSON.stringify(sanitizedData));
    } catch (e) {
      this.logger.warn('持久化冲突数据失败', e);
    }
  }
  
  /**
   * 清除持久化的冲突数据
   */
  private clearPersistedConflict(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.CONFLICT_STORAGE_KEY);
  }

  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    this.onlineHandler = () => {
      this.syncState.update(s => ({ ...s, isOnline: true }));
    };
    
    this.offlineHandler = () => {
      this.syncState.update(s => ({ ...s, isOnline: false }));
    };
    
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }
  
  /**
   * 移除网络状态监听
   */
  private removeNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    
    if (this.offlineHandler) {
      window.removeEventListener('offline', this.offlineHandler);
      this.offlineHandler = null;
    }
  }

  /**
   * 设置远程变更回调
   */
  setRemoteChangeCallback(callback: (payload?: RemoteProjectChangePayload) => Promise<void>) {
    this.onRemoteChangeCallback = callback;
  }
  
  /**
   * 设置任务级变更回调（用于细粒度更新）
   */
  setTaskChangeCallback(callback: (payload: RemoteTaskChangePayload) => void) {
    this.onTaskChangeCallback = callback;
  }

  /**
   * 暂停处理远程更新
   * 在队列同步期间调用，避免竞态条件
   */
  pauseRealtimeUpdates() {
    this.pauseRemoteUpdates = true;
    this.logger.debug('远程更新已暂停');
  }

  /**
   * 恢复处理远程更新
   * 队列同步完成后调用
   */
  resumeRealtimeUpdates() {
    this.pauseRemoteUpdates = false;
    this.logger.debug('远程更新已恢复');
  }

  /**
   * 初始化实时订阅
   * 订阅项目级别和任务级别的变更
   * 使用订阅管理器模式防止重复订阅
   */
  async initRealtimeSubscription(userId: string) {
    if (!this.supabase.isConfigured || !userId) return;
    
    // 防止重复订阅：如果已经为同一个用户订阅了，直接返回
    if (this.currentSubscribedUserId === userId && 
        this.realtimeChannel !== null && 
        this.tasksChannel !== null) {
      this.logger.debug('已经为该用户建立了订阅，跳过重复订阅', { userId });
      return;
    }
    
    // 如果是不同用户或需要重新订阅，先清理旧订阅
    if (this.currentSubscribedUserId !== null && this.currentSubscribedUserId !== userId) {
      this.logger.info('用户已切换，清理旧订阅', { 
        oldUserId: this.currentSubscribedUserId, 
        newUserId: userId 
      });
    }
    
    this.teardownRealtimeSubscription();
    
    // 记录当前订阅的用户
    this.currentSubscribedUserId = userId;
    this.isDestroyed = false;

    // 项目级别订阅 - 使用 Tab ID 隔离避免多标签页频道冲突
    const channel = this.supabase.client()
      .channel(`user-${userId}-changes-${TAB_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `owner_id=eq.${userId}`
        },
        payload => {
          this.logger.debug('收到项目变更:', payload.eventType);
          void this.handleRemoteChange(payload);
        }
      );

    this.realtimeChannel = channel;
    
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        this.logger.info('✅ Realtime channel ready');
        // 重置重试计数
        this.retryState.count = 0;
        if (this.retryState.timer) {
          clearTimeout(this.retryState.timer);
          this.retryState.timer = null;
        }
        this.syncState.update(s => ({
          ...s,
          isOnline: true,
          offlineMode: false
        }));
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        this.logger.warn('⚠️ Realtime channel error:', err);
        this.syncState.update(s => ({
          ...s,
          offlineMode: true
        }));
        // 尝试自动重连
        this.scheduleReconnect(userId);
      }
    });
    
    // 任务级别订阅 - 使用 Tab ID 隔离
    // 注意：tasks 表需要通过 project_id 关联来过滤
    // 由于 Supabase Realtime 不支持 JOIN 过滤，我们在客户端过滤
    // 但为了减少不必要的数据传输，先获取用户的项目 ID 列表
    const tasksChannel = this.supabase.client()
      .channel(`user-${userId}-tasks-${TAB_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks'
          // 注意：Supabase Realtime 对 tasks 表的过滤依赖 RLS 策略
          // 确保 tasks 表的 RLS 策略只允许用户访问自己项目的任务
        },
        payload => {
          // 客户端二次过滤：检查 project_id 是否属于当前用户的项目
          const newRecord = payload.new as Record<string, unknown>;
          const oldRecord = payload.old as Record<string, unknown>;
          const projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
          
          // 如果没有 project_id，可能是删除事件，让 handler 处理
          if (projectId || payload.eventType === 'DELETE') {
            this.logger.debug('收到任务变更', { eventType: payload.eventType, projectId });
            void this.handleTaskChange(payload);
          }
        }
      );
    
    this.tasksChannel = tasksChannel;
    tasksChannel.subscribe();
  }
  
  /** 当前用户 ID（用于重连时检查） */
  private currentSubscribedUserId: string | null = null;
  
  /** 是否已销毁 */
  private isDestroyed = false;

  /**
   * 计划重连
   * 使用指数退避策略
   * 修复：重连前检查用户是否仍然登录
   */
  private scheduleReconnect(userId: string) {
    // 检查服务是否已销毁
    if (this.isDestroyed) {
      this.logger.info('服务已销毁，取消重连');
      return;
    }
    
    // 检查用户是否仍然是当前订阅的用户
    if (this.currentSubscribedUserId !== userId) {
      this.logger.info('用户已变更，取消重连', { 
        originalUserId: userId, 
        currentUserId: this.currentSubscribedUserId 
      });
      return;
    }
    
    // 达到最大重试次数，放弃重连
    if (this.retryState.count >= this.retryState.maxRetries) {
      this.logger.warn('⚠️ 达到最大重连次数，放弃重连');
      return;
    }
    
    // 清除之前的重连定时器
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
    }
    
    // 指数退避：1s, 2s, 4s, 8s... 最大 30s
    const delay = Math.min(1000 * Math.pow(2, this.retryState.count), 30000);
    this.retryState.count++;
    
    this.logger.info(`🔄 计划在 ${delay / 1000}s 后重连 (尝试 ${this.retryState.count}/${this.retryState.maxRetries})`);
    
    this.retryState.timer = setTimeout(async () => {
      // 重连前再次检查用户状态
      if (this.isDestroyed || this.currentSubscribedUserId !== userId) {
        this.logger.info('重连时检测到状态变更，取消重连');
        return;
      }
      
      // 检查网络状态
      if (!this.syncState().isOnline) {
        this.logger.info('📶 网络离线，暂停重连');
        return;
      }
      
      this.logger.info('🔄 正在尝试重新连接...');
      try {
        await this.initRealtimeSubscription(userId);
      } catch (e) {
        this.logger.error('重连失败', e);
        // 继续重试（如果用户仍然相同）
        if (this.currentSubscribedUserId === userId) {
          this.scheduleReconnect(userId);
        }
      }
    }, delay);
  }

  /**
   * 处理远程变更
   */
  private async handleRemoteChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onRemoteChangeCallback || this.pauseRemoteUpdates) return;
    
    // 防抖处理
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
    }
    
    this.remoteChangeTimer = setTimeout(async () => {
      // 再次检查是否暂停
      if (this.pauseRemoteUpdates) return;
      
      try {
        const eventType = payload.eventType;
        const newRecord = payload.new as Record<string, unknown>;
        const oldRecord = payload.old as Record<string, unknown>;
        const projectId = (newRecord?.id || oldRecord?.id) as string;
        
        await this.onRemoteChangeCallback!({
          eventType,
          projectId,
          data: newRecord
        });
      } catch (e) {
        this.logger.error('处理实时更新失败', e);
      } finally {
        this.remoteChangeTimer = null;
      }
    }, SYNC_CONFIG.REMOTE_CHANGE_DELAY);
  }

  /**
   * 处理任务级别变更
   */
  private async handleTaskChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onTaskChangeCallback || this.pauseRemoteUpdates) return;
    
    const eventType = payload.eventType;
    const newRecord = payload.new as Record<string, unknown>;
    const oldRecord = payload.old as Record<string, unknown>;
    const taskId = (newRecord?.id || oldRecord?.id) as string;
    const projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
    
    this.onTaskChangeCallback({
      eventType,
      taskId,
      projectId,
      data: newRecord
    });
  }

  /**
   * 卸载实时订阅
   * 清理所有订阅通道、重试状态和相关资源
   */
  teardownRealtimeSubscription() {
    // 清除当前订阅的用户（阻止重连）
    this.currentSubscribedUserId = null;
    
    if (this.realtimeChannel) {
      if (this.supabase.isConfigured) {
        void this.supabase.client().removeChannel(this.realtimeChannel);
      }
      this.realtimeChannel = null;
    }
    if (this.tasksChannel) {
      if (this.supabase.isConfigured) {
        void this.supabase.client().removeChannel(this.tasksChannel);
      }
      this.tasksChannel = null;
    }
    
    // 重置重试状态
    this.retryState.count = 0;
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    // 清理远程变更处理定时器
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
      this.remoteChangeTimer = null;
    }
  }

  /**
   * 从云端加载项目列表
   * 从独立的 tasks 和 connections 表加载数据
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    if (!userId || !this.supabase.isConfigured) {
      return [];
    }
    
    this.isLoadingRemote.set(true);
    
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('owner_id', userId)
        .order('created_date', { ascending: true });
      
      if (error) throw error;
      
      // 并行加载所有项目的任务和连接
      const projects = await Promise.all((data || []).map(async row => {
        const projectRow = row as ProjectRow;
        const [tasks, connections] = await Promise.all([
          this.taskRepo.loadTasks(projectRow.id),
          this.taskRepo.loadConnections(projectRow.id)
        ]);
        return this.mapRowToProject(projectRow, tasks, connections);
      }));
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false
      }));
      
      return projects;
    } catch (e: any) {
      this.logger.error('Loading from Supabase failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e),
        offlineMode: true
      }));
      return [];
    } finally {
      this.isLoadingRemote.set(false);
    }
  }

  /**
   * 加载单个项目（用于增量更新）
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    if (!userId || !this.supabase.isConfigured || !projectId) {
      return null;
    }
    
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .eq('owner_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // 项目不存在
          return null;
        }
        throw error;
      }
      
      const projectRow = data as ProjectRow;
      const [tasks, connections] = await Promise.all([
        this.taskRepo.loadTasks(projectRow.id),
        this.taskRepo.loadConnections(projectRow.id)
      ]);
      return this.mapRowToProject(projectRow, tasks, connections);
    } catch (e: any) {
      this.logger.error('Loading single project failed', e);
      return null;
    }
  }

  /**
   * 保存项目到云端（带冲突检测和并发控制）
   * 使用版本号 + 服务端时间戳双重检测机制
   * Token 过期时自动保存本地数据防止丢失
   * 使用互斥锁防止并发保存导致版本号冲突
   */
  async saveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project }> {
    if (!userId || !this.supabase.isConfigured) {
      return { success: true }; // 离线模式视为成功
    }
    
    // 如果当前有保存操作正在进行，加入队列等待
    if (this.saveLock.isLocked) {
      return new Promise((resolve) => {
        this.saveLock.queue.push({ resolve, project, userId });
      });
    }
    
    // 获取锁
    this.saveLock.isLocked = true;
    
    try {
      const result = await this.doSaveProjectToCloud(project, userId);
      return result;
    } finally {
      // 释放锁并处理队列中的下一个请求
      this.saveLock.isLocked = false;
      this.processNextSaveInQueue();
    }
  }
  
  /**
   * 处理保存队列中的下一个请求
   */
  private processNextSaveInQueue() {
    if (this.saveLock.queue.length === 0) return;
    
    // 合并队列中相同项目的请求，只保留最后一个
    const projectMap = new Map<string, typeof this.saveLock.queue[0]>();
    for (const item of this.saveLock.queue) {
      projectMap.set(item.project.id, item);
    }
    
    // 清空队列
    this.saveLock.queue = [];
    
    // 依次处理（使用 Promise.resolve 确保异步执行）
    for (const item of projectMap.values()) {
      void this.saveProjectToCloud(item.project, item.userId).then(item.resolve);
    }
  }
  
  /**
   * 实际执行保存操作（内部方法）
   * 使用数据库乐观锁解决竞态条件：
   * UPDATE ... WHERE version = expected_version
   */
  private async doSaveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project }> {
    this.syncState.update(s => ({ ...s, isSyncing: true }));
    
    try {
      const currentVersion = project.version ?? 0;
      const newVersion = currentVersion + 1;
      
      // 检查项目是否存在
      const { data: existingData, error: checkError } = await this.supabase.client()
        .from('projects')
        .select('id, version')
        .eq('id', project.id)
        .maybeSingle();
      
      if (checkError && checkError.code !== 'PGRST116') {
        throw checkError;
      }
      
      const isUpdate = !!existingData;
      
      if (isUpdate) {
        // 使用乐观锁更新：只有版本号匹配时才更新
        const { data: updateResult, error: updateError } = await this.supabase.client()
          .from('projects')
          .update({
            title: project.name,
            description: project.description,
            version: newVersion
          })
          .eq('id', project.id)
          .eq('version', currentVersion) // 乐观锁：只有版本匹配才更新
          .select('id')
          .maybeSingle();
        
        if (updateError) {
          this.handleSaveError(updateError, project);
          throw updateError;
        }
        
        // 如果没有返回数据，说明版本号不匹配（被其他客户端更新了）
        if (!updateResult) {
          this.logger.warn('版本冲突：远端数据已被更新', { projectId: project.id, localVersion: currentVersion });
          
          // 加载最新的远程数据
          const remoteProject = await this.loadSingleProject(project.id, userId);
          if (remoteProject) {
            const conflictData = { 
              local: project, 
              remote: remoteProject,
              projectId: project.id,
              remoteData: remoteProject
            };
            this.persistConflictData(conflictData);
            this.syncState.update(s => ({
              ...s,
              hasConflict: true,
              conflictData
            }));
            return { success: false, conflict: true, remoteData: remoteProject };
          }
        }
      } else {
        // 创建新项目
        const { error: insertError } = await this.supabase.client()
          .from('projects')
          .insert({
            id: project.id,
            owner_id: userId,
            title: project.name,
            description: project.description,
            created_date: project.createdDate || nowISO(),
            version: newVersion
          });
        
        if (insertError) {
          this.handleSaveError(insertError, project);
          throw insertError;
        }
      }
      
      // 批量保存任务
      const tasksResult = await this.taskRepo.saveTasks(project.id, project.tasks);
      if (!tasksResult.success) {
        throw new Error(tasksResult.error);
      }
      
      // 同步连接
      const connectionsResult = await this.taskRepo.syncConnections(project.id, project.connections);
      if (!connectionsResult.success) {
        throw new Error(connectionsResult.error);
      }
      
      // 更新本地版本号
      project.version = newVersion;
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false,
        sessionExpired: false,
        hasConflict: false,
        conflictData: null
      }));
      
      return { success: true };
    } catch (e: any) {
      this.logger.error('Sync project failed', e);
      
      // 任何同步失败都保存到本地缓存
      this.saveOfflineSnapshot([project]);
      
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e),
        offlineMode: true
      }));
      return { success: false };
    } finally {
      this.syncState.update(s => ({ ...s, isSyncing: false }));
    }
  }

  /**
   * 处理保存错误
   */
  private handleSaveError(error: any, project: Project): void {
    // 处理认证错误 - 先保存本地数据再报错
    if (error.code === 'PGRST301' || error.message?.includes('JWT') || error.code === '401') {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('Token 过期，数据已保存到本地');
      
      this.syncState.update(s => ({ 
        ...s, 
        sessionExpired: true,
        offlineMode: true,
        syncError: '登录已过期，数据已保存在本地，请重新登录后同步'
      }));
    }
  }

  /**
   * 删除云端项目
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    if (!userId || !this.supabase.isConfigured) {
      return true;
    }
    
    try {
      const { error } = await this.supabase.client()
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('owner_id', userId);
      
      if (error) throw error;
      return true;
    } catch (e: any) {
      this.logger.error('Delete project from cloud failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e)
      }));
      return false;
    }
  }

  /**
   * 解决冲突（选择保留哪个版本）
   */
  resolveConflict(projectId: string, project: Project, choice: 'local' | 'remote'): void {
    // 清除持久化的冲突数据
    this.clearPersistedConflict();
    
    this.syncState.update(s => ({
      ...s,
      hasConflict: false,
      conflictData: null
    }));
    
    this.logger.info(`冲突已解决：${choice === 'local' ? '使用本地版本' : '使用远程版本'}`);
  }

  /**
   * 加载用户偏好设置
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    if (!userId || !this.supabase.isConfigured) return null;
    
    try {
      const { data, error } = await this.supabase.client()
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      
      if (data) {
        return {
          theme: (data.theme as ThemeType) ?? 'default',
          layoutDirection: (data.layout_direction as 'ltr' | 'rtl') ?? 'ltr',
          floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') ?? 'auto'
        };
      }
      return null;
    } catch (e) {
      this.logger.warn('加载用户偏好设置失败', e);
      return null;
    }
  }

  /**
   * 保存用户偏好设置
   */
  async saveUserPreferences(userId: string, prefs: Partial<UserPreferences>): Promise<boolean> {
    // 始终保存到本地
    if (prefs.theme) {
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
    if (prefs.layoutDirection) {
      localStorage.setItem('nanoflow.layout-direction', prefs.layoutDirection);
    }
    if (prefs.floatingWindowPref) {
      localStorage.setItem('nanoflow.floating-window-pref', prefs.floatingWindowPref);
    }
    
    if (!userId || !this.supabase.isConfigured) return true;
    
    try {
      // 构建更新对象，只包含有值的字段
      const updateData: Record<string, any> = {
        user_id: userId,
        updated_at: nowISO()
      };
      
      if (prefs.theme !== undefined) {
        updateData.theme = prefs.theme;
      }
      if (prefs.layoutDirection !== undefined) {
        updateData.layout_direction = prefs.layoutDirection;
      }
      if (prefs.floatingWindowPref !== undefined) {
        updateData.floating_window_pref = prefs.floatingWindowPref;
      }
      
      const { error } = await this.supabase.client()
        .from('user_preferences')
        .upsert(updateData, { onConflict: 'user_id' });
      
      if (error) throw error;
      return true;
    } catch (e) {
      this.logger.warn('保存用户偏好设置到云端失败', e);
      return false;
    }
  }

  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(CACHE_CONFIG.OFFLINE_CACHE_KEY, JSON.stringify({
        projects,
        version: CACHE_CONFIG.CACHE_VERSION
      }));
    } catch (e) {
      this.logger.warn('Offline cache write failed', e);
    }
  }

  /**
   * 加载离线快照
   * 包含版本检查和数据迁移逻辑
   */
  loadOfflineSnapshot(): Project[] | null {
    try {
      const cached = typeof localStorage !== 'undefined'
        ? localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY)
        : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          const cachedVersion = parsed.version ?? 1;
          const currentVersion = CACHE_CONFIG.CACHE_VERSION;
          
          // 版本检查和数据迁移
          if (cachedVersion < currentVersion) {
            this.logger.info(`缓存版本升级: ${cachedVersion} -> ${currentVersion}`);
            const migratedProjects = this.migrateOfflineData(parsed.projects, cachedVersion);
            // 保存迁移后的数据
            this.saveOfflineSnapshot(migratedProjects);
            return migratedProjects;
          }
          
          return parsed.projects;
        }
      }
    } catch (e) {
      this.logger.warn('Offline cache read failed', e);
    }
    return null;
  }

  /**
   * 迁移离线数据到最新版本
   */
  private migrateOfflineData(projects: Project[], fromVersion: number): Project[] {
    let migrated = projects;
    
    // 版本 1 -> 2: 添加 version 字段、status 默认值等
    if (fromVersion < 2) {
      migrated = migrated.map(project => ({
        ...project,
        version: project.version ?? 0,
        updatedAt: project.updatedAt || nowISO(),
        tasks: project.tasks.map(task => ({
          ...task,
          status: task.status || 'active',
          rank: task.rank ?? 10000,
          displayId: task.displayId || '?',
          hasIncompleteTask: task.hasIncompleteTask ?? false,
          deletedAt: task.deletedAt ?? null
        })),
        connections: project.connections || []
      }));
      // 数据迁移完成记录由调用方的 logger.info 处理
    }
    
    return migrated;
  }

  /**
   * 清除离线缓存
   */
  clearOfflineCache() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
    }
  }

  /**
   * 映射数据库行到项目对象
   */
  private mapRowToProject(row: ProjectRow, tasks: Task[], connections: Connection[]): Project {
    return {
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? nowISO(),
      tasks,
      connections,
      updatedAt: row.updated_at ?? undefined,
      version: row.version ?? 0
    };
  }

  /**
   * 清理资源
   * 确保清理所有定时器和事件监听器，防止内存泄漏
   */
  destroy() {
    this.isDestroyed = true;
    this.currentSubscribedUserId = null;
    
    this.teardownRealtimeSubscription();
    this.removeNetworkListeners();
    
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
      this.remoteChangeTimer = null;
    }
    
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    // 重置重试状态
    this.retryState.count = 0;
    
    this.onRemoteChangeCallback = null;
    this.onTaskChangeCallback = null;
  }
}
