/**
 * SimpleSyncService - 简化的同步服务
 * 
 * 核心原则（来自 agents.md）：
 * - 利用 Supabase Realtime 做同步
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 */

import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { Task, Project, Connection } from '../../../models';
import { nowISO } from '../../../utils/date';
import type { SupabaseClient } from '@supabase/supabase-js';

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
 * 同步状态
 */
interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  lastSyncTime: string | null;
  pendingCount: number;
  error: string | null;
}

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
  
  /** 同步状态 */
  readonly state = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    lastSyncTime: null,
    pendingCount: 0,
    error: null
  });
  
  /** 重试队列 */
  private retryQueue: RetryQueueItem[] = [];
  
  /** 重试定时器 */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 最大重试次数 */
  private readonly MAX_RETRIES = 5;
  
  /** 重试间隔（毫秒） */
  private readonly RETRY_INTERVAL = 5000;
  
  constructor() {
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
          order_num: task.order,
          rank: task.rank,
          status: task.status,
          x: task.x,
          y: task.y,
          display_id: task.displayId,
          short_id: task.shortId,
          deleted_at: task.deletedAt || null,
          updated_at: task.updatedAt || nowISO()
        });
      
      if (error) throw error;
      
      this.state.update(s => ({ ...s, lastSyncTime: nowISO() }));
      return true;
    } catch (e) {
      this.logger.error('推送任务失败', e);
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
      
      if (error) throw error;
      
      // 转换为本地模型
      return (data || []).map(row => this.rowToTask(row));
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
      
      if (error) throw error;
      return true;
    } catch (e) {
      this.logger.error('删除任务失败', e);
      this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      return false;
    }
  }
  
  // ==================== 项目同步 ====================
  
  /**
   * 推送项目到云端
   */
  async pushProject(project: Project): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
    
    try {
      const { error } = await client
        .from('projects')
        .upsert({
          id: project.id,
          title: project.name,
          description: project.description,
          version: project.version || 1,
          updated_at: project.updatedAt || nowISO(),
          migrated_to_v2: true
        });
      
      if (error) throw error;
      return true;
    } catch (e) {
      this.logger.error('推送项目失败', e);
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
      
      if (error) throw error;
      
      return (data || []).map(row => this.rowToProject(row));
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
      
      if (error) throw error;
      return true;
    } catch (e) {
      this.logger.error('推送连接失败', e);
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
  }
  
  // ==================== 重试队列 ====================
  
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
    
    this.state.update(s => ({
      ...s,
      isSyncing: false,
      pendingCount: this.retryQueue.length
    }));
  }
  
  // ==================== 数据转换 ====================
  
  /**
   * 数据库行转换为 Task 模型
   */
  private rowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title || '',
      content: row.content || '',
      stage: row.stage,
      parentId: row.parent_id,
      order: row.order_num || 0,
      rank: row.rank || 0,
      status: row.status || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at,
      updatedAt: row.updated_at,
      displayId: row.display_id || '',
      shortId: row.short_id,
      deletedAt: row.deleted_at
    };
  }
  
  /**
   * 数据库行转换为 Project 模型
   */
  private rowToProject(row: any): Project {
    return {
      id: row.id,
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_at,
      updatedAt: row.updated_at,
      version: row.version || 1,
      tasks: [],
      connections: []
    };
  }
}
