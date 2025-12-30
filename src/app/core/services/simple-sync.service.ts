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
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ChangeTrackerService } from '../../../services/change-tracker.service';
import { Task, Project, Connection, UserPreferences, ThemeType } from '../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import { supabaseErrorToError } from '../../../utils/supabase-error';
import { REQUEST_THROTTLE_CONFIG, SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG } from '../../../config';
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
  private readonly throttle = inject(RequestThrottleService);
  private readonly changeTracker = inject(ChangeTrackerService);
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
  
  /** 同步计数器（用于数据漂移检测） */
  private syncCounter = 0;
  
  /** 
   * 本地 tombstone 缓存 
   * 用于在云端 RPC 不可用时防止已删除任务复活
   * 格式：Map<projectId, Set<taskId>>
   */
  private localTombstones: Map<string, Set<string>> = new Map();
  
  /** 本地 tombstone 持久化 key */
  private readonly LOCAL_TOMBSTONES_KEY = 'nanoflow.local-tombstones';
  
  /** 最大重试次数 */
  private readonly MAX_RETRIES = 5;
  
  /** 重试间隔（毫秒） */
  private readonly RETRY_INTERVAL = 5000;
  
  /** 重试队列最大大小（防止 localStorage 溢出） */
  private readonly MAX_RETRY_QUEUE_SIZE = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE;
  
  /** 重试项最大年龄（毫秒，24 小时） */
  private readonly MAX_RETRY_ITEM_AGE = SYNC_CONFIG.MAX_RETRY_ITEM_AGE;
  
  /** 重试队列持久化 key */
  private readonly RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
  
  /** 重试队列版本号（用于格式兼容） */
  private readonly RETRY_QUEUE_VERSION = 1;
  
  /** 立即重试的最大次数（带指数退避） */
  private readonly IMMEDIATE_RETRY_MAX = 3;
  
  /** 立即重试的基础延迟（毫秒） */
  private readonly IMMEDIATE_RETRY_BASE_DELAY = 1000;
  
  // ==================== Circuit Breaker 状态 ====================
  /** 熔断器状态：closed（正常）| open（熔断）| half-open（试探） */
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  /** 连续失败次数 */
  private consecutiveFailures = 0;
  /** 熔断器打开时间戳 */
  private circuitOpenedAt = 0;
  
  /** Realtime 订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;
  
  constructor() {
    this.loadRetryQueueFromStorage(); // 恢复持久化的重试队列
    this.loadLocalTombstones(); // 恢复本地 tombstone 缓存
    this.setupNetworkListeners();
    this.startRetryLoop();
    
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }
  
  // ==================== 本地 Tombstone 管理 ====================
  
  /**
   * 加载本地 tombstone 缓存
   */
  private loadLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data = localStorage.getItem(this.LOCAL_TOMBSTONES_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.localTombstones = new Map(
          Object.entries(parsed).map(([k, v]) => [k, new Set(v as string[])])
        );
        this.logger.debug('已恢复本地 tombstone 缓存', { 
          projectCount: this.localTombstones.size 
        });
      }
    } catch (e) {
      this.logger.warn('加载本地 tombstone 缓存失败', e);
      this.localTombstones = new Map();
    }
  }
  
  /**
   * 保存本地 tombstone 缓存
   */
  private saveLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data: Record<string, string[]> = {};
      for (const [projectId, taskIds] of this.localTombstones.entries()) {
        data[projectId] = Array.from(taskIds);
      }
      localStorage.setItem(this.LOCAL_TOMBSTONES_KEY, JSON.stringify(data));
    } catch (e) {
      this.logger.warn('保存本地 tombstone 缓存失败', e);
    }
  }
  
  /**
   * 添加本地 tombstone（用于在 RPC 不可用时防止任务复活）
   */
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    if (!this.localTombstones.has(projectId)) {
      this.localTombstones.set(projectId, new Set());
    }
    const set = this.localTombstones.get(projectId)!;
    for (const id of taskIds) {
      set.add(id);
    }
    this.saveLocalTombstones();
    this.logger.debug('添加本地 tombstone', { projectId, taskIds });
  }
  
  /**
   * 获取本地 tombstone（合并云端 tombstone）
   */
  getLocalTombstones(projectId: string): Set<string> {
    return this.localTombstones.get(projectId) || new Set();
  }
  
  /**
   * 清除本地 tombstone（当云端 tombstone 同步成功后）
   */
  clearLocalTombstones(projectId: string, taskIds: string[]): void {
    const set = this.localTombstones.get(projectId);
    if (set) {
      for (const id of taskIds) {
        set.delete(id);
      }
      if (set.size === 0) {
        this.localTombstones.delete(projectId);
      }
      this.saveLocalTombstones();
    }
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
  
  /**
   * 立即刷新重试队列（同步方式）
   * 用于 beforeunload 事件，确保页面关闭前尽可能保存数据
   * 
   * 【设计原则】来自高级顾问审查：
   * - 3 秒防抖在"关闭笔记本"场景下可能丢失数据
   * - beforeunload 时应立即 flush 待处理队列
   */
  flushRetryQueueSync(): void {
    // 确保重试队列已持久化到 localStorage
    this.saveRetryQueueToStorage();
    
    // 记录待处理项数量，供调试
    if (this.retryQueue.length > 0) {
      this.logger.info('beforeunload: 保存待处理同步项', { 
        count: this.retryQueue.length 
      });
    }
  }
  
  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 带指数退避的重试辅助函数
   * 仅对可重试的错误进行重试（5xx, 429, 408, 网络错误等）
   * 
   * @param operation 要执行的操作
   * @param maxRetries 最大重试次数
   * @param baseDelay 基础延迟（毫秒）
   * @returns 操作结果
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = this.IMMEDIATE_RETRY_MAX,
    baseDelay = this.IMMEDIATE_RETRY_BASE_DELAY
  ): Promise<T> {
    let lastError: unknown;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const enhanced = supabaseErrorToError(error);
        
        // 如果不是可重试错误，立即抛出
        if (!enhanced.isRetryable) {
          throw enhanced;
        }
        
        // 如果还有重试机会，等待后重试
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt); // 指数退避：1s, 2s, 4s
          this.logger.debug(`操作失败 (${enhanced.errorType})，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`, enhanced.message);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // 所有重试用尽
          this.logger.warn(`操作失败，已重试 ${maxRetries} 次`, enhanced);
          throw enhanced;
        }
      }
    }
    
    throw lastError;
  }
  
  // ==================== Circuit Breaker ====================
  
  /**
   * Circuit Breaker: 检查是否应该执行请求
   * @returns true 如果可以执行请求，false 如果熔断中
   */
  private checkCircuitBreaker(): boolean {
    if (this.circuitState === 'closed') {
      return true;
    }
    
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME) {
        // 转入半开状态，允许试探请求
        this.circuitState = 'half-open';
        this.logger.info('Circuit Breaker: 进入半开状态，尝试恢复');
        return true;
      }
      // 仍在熔断期
      return false;
    }
    
    // half-open 状态：允许请求
    return true;
  }

  /**
   * Circuit Breaker: 记录请求成功
   */
  private recordCircuitSuccess(): void {
    if (this.circuitState === 'half-open') {
      // 半开状态下成功，关闭熔断器
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      this.logger.info('Circuit Breaker: 恢复正常');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Circuit Breaker: 记录请求失败
   */
  private recordCircuitFailure(errorType: string): void {
    // 只有特定错误类型触发熔断
    if (!CIRCUIT_BREAKER_CONFIG.TRIGGER_ERROR_TYPES.includes(errorType)) {
      return;
    }
    
    this.consecutiveFailures++;
    
    if (this.circuitState === 'half-open') {
      // 半开状态下失败，重新打开熔断器
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn('Circuit Breaker: 半开状态失败，重新熔断');
      return;
    }
    
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn(`Circuit Breaker: 触发熔断，连续失败 ${this.consecutiveFailures} 次，暂停 ${CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME / 1000} 秒`);
    }
  }
  
  // ==================== 任务同步 ====================
  
  /**
   * 推送任务到云端
   * 使用 upsert 实现 LWW
   * 
   * 自动重试策略：
   * - 对于可重试错误（5xx, 429, 408, 网络错误），立即重试 3 次（指数退避：1s, 2s, 4s）
   * - 重试失败后加入持久化重试队列，等待网络恢复后重试
   * - 使用限流服务控制并发请求数量，避免连接池耗尽
   * 
   * 【关键防护】防止已删除任务复活
   * - 推送前检查 task_tombstones 表
   * - 如果任务已在 tombstones 中，跳过推送避免复活
   */
  async pushTask(task: Task, projectId: string): Promise<boolean> {
    // Circuit Breaker 检查：如果熔断中，直接加入重试队列
    if (!this.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过推送', { taskId: task.id });
      this.addToRetryQueue('task', 'upsert', task, projectId);
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('task', 'upsert', task, projectId);
      return false;
    }
    
    try {
      await this.throttle.execute(
        `push-task:${task.id}`,
        async () => {
          // 【关键防护】检查任务是否已被永久删除（在 tombstones 中）
          const { data: tombstone } = await client
            .from('task_tombstones')
            .select('task_id')
            .eq('task_id', task.id)
            .maybeSingle();
          
          if (tombstone) {
            // 任务已被永久删除，跳过推送，防止复活
            this.logger.info('跳过推送已删除任务（tombstone 保护）', { 
              taskId: task.id, 
              projectId 
            });
            return; // 直接返回，不执行 upsert
          }
          
          await this.retryWithBackoff(async () => {
            const { error } = await client
              .from('tasks')
              .upsert({
                id: task.id,
                project_id: projectId,
                title: task.title,
                content: task.content,
                stage: task.stage,
                parent_id: task.parentId,
                order: task.order,
                rank: task.rank,
                status: task.status,
                x: task.x,
                y: task.y,
                short_id: task.shortId,
                deleted_at: task.deletedAt || null,
                updated_at: task.updatedAt || nowISO()
              });
            
            if (error) throw supabaseErrorToError(error);
          });
        },
        { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }  // 30秒超时，平衡用户体验
      );
      
      // Circuit Breaker: 记录成功
      this.recordCircuitSuccess();
      this.state.update(s => ({ ...s, lastSyncTime: nowISO() }));
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // Circuit Breaker: 记录失败
      this.recordCircuitFailure(enhanced.errorType);
      
      // 根据错误类型选择日志级别
      if (enhanced.isRetryable) {
        // 网络相关错误：静默处理，仅 debug 日志
        this.logger.debug(`推送任务失败 (${enhanced.errorType})，已加入重试队列`, enhanced.message);
      } else {
        // 非网络错误：记录完整错误
        this.logger.error('推送任务失败', enhanced);
      }
      
      // 报告到 Sentry，但标记可重试错误的级别
      Sentry.captureException(enhanced, { 
        tags: { 
          operation: 'pushTask',
          errorType: enhanced.errorType,
          isRetryable: String(enhanced.isRetryable)
        },
        level: enhanced.isRetryable ? 'info' : 'error',
        extra: {
          taskId: task.id,
          projectId
        }
      });
      
      this.addToRetryQueue('task', 'upsert', task, projectId);
      return false;
    }
  }
  
  /**
   * 从云端拉取任务
   * LWW：只更新 updated_at 更新的数据
   * 
   * 【关键修复】检查 task_tombstones 表，防止已删除任务复活
   */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      // 1. 并行查询任务和 tombstones
      let tasksQuery = client
        .from('tasks')
        .select('*')
        .eq('project_id', projectId);
      
      if (since) {
        tasksQuery = tasksQuery.gt('updated_at', since);
      }
      
      const [tasksResult, tombstonesResult] = await Promise.all([
        tasksQuery,
        client.from('task_tombstones').select('task_id').eq('project_id', projectId)
      ]);
      
      if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
      
      // 2. 构建 tombstone ID 集合
      const tombstoneIds = new Set<string>();
      if (!tombstonesResult.error && tombstonesResult.data) {
        for (const t of tombstonesResult.data) {
          tombstoneIds.add(t.task_id);
        }
      }
      
      // 3. 转换为本地模型
      // 【关键修复】不再过滤已删除的任务！
      // 同步查询必须返回已删除记录，由客户端处理删除逻辑
      // 否则其他设备无法知道某个任务已被删除，导致任务"复活"
      const allTasks = (tasksResult.data as TaskRow[] || []).map(row => this.rowToTask(row));
      
      // 标记 tombstone 任务（永久删除），客户端应从本地删除这些任务
      return allTasks.map(task => {
        if (tombstoneIds.has(task.id)) {
          this.logger.debug('pullTasks: 标记 tombstone 任务', { taskId: task.id });
          // 将 tombstone 任务也标记为已删除，确保客户端处理
          return { ...task, deletedAt: task.deletedAt || new Date().toISOString() };
        }
        return task;
      });
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
  
  /**
   * 获取项目的所有 tombstone 任务 ID
   * 用于检查任务是否已被永久删除
   * 
   * 【关键修复】合并云端 tombstones 和本地 tombstone 缓存
   * 本地缓存用于 RPC 不可用时的保护
   */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    const tombstoneIds = new Set<string>();
    
    // 1. 首先添加本地 tombstone 缓存（即使云端查询失败也能保护）
    const localTombstones = this.getLocalTombstones(projectId);
    for (const id of localTombstones) {
      tombstoneIds.add(id);
    }
    
    // 2. 查询云端 tombstones
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getTombstoneIds: 离线模式，仅使用本地缓存', { 
        projectId, 
        localCount: localTombstones.size 
      });
      return tombstoneIds;
    }
    
    try {
      const { data, error } = await client
        .from('task_tombstones')
        .select('task_id')
        .eq('project_id', projectId);
      
      if (error) {
        this.logger.warn('获取云端 tombstones 失败，使用本地缓存', error);
        return tombstoneIds;
      }
      
      // 添加云端 tombstones
      for (const t of (data || [])) {
        tombstoneIds.add(t.task_id);
      }
      
      if (localTombstones.size > 0 || tombstoneIds.size > localTombstones.size) {
        this.logger.debug('getTombstoneIds: 合并完成', {
          projectId,
          localCount: localTombstones.size,
          cloudCount: tombstoneIds.size - localTombstones.size,
          totalCount: tombstoneIds.size
        });
      }
      
      return tombstoneIds;
    } catch (e) {
      this.logger.warn('获取 tombstones 异常，使用本地缓存', e);
      return tombstoneIds;
    }
  }
  
  /**
   * 永久删除云端任务（写入 tombstone + 物理删除）
   * 
   * 【关键】这是防止已删除任务复活的核心方法
   * - 调用 purge_tasks_v2 RPC 写入 tombstone 并删除任务
   * - 如果 RPC 不可用，降级为软删除（但这不是理想方案，因为软删除任务仍可能被同步回来）
   * - tombstone 记录会阻止任何后续的 upsert 复活该任务
   * 
   * @returns true 表示成功（包括降级为软删除），false 表示完全失败
   */
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    if (taskIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
      // 离线时加入重试队列
      for (const taskId of taskIds) {
        this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      }
      return false;
    }
    
    try {
      // 优先使用 purge_tasks_v2（支持在 tasks 行不存在时也能写 tombstone）
      this.logger.debug('purgeTasksFromCloud: 调用 purge_tasks_v2', { projectId, taskIds });
      const purgeV2Result = await client.rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV2Result.error) {
        this.logger.info('purgeTasksFromCloud: purge_tasks_v2 成功', { 
          projectId, 
          taskCount: taskIds.length,
          taskIds,
          purgedCount: purgeV2Result.data
        });
        // 【关键】即使 RPC 成功也添加本地 tombstone，确保多设备一致性
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // v2 失败，降级到 v1
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v2 失败，尝试 v1', purgeV2Result.error);
      const purgeV1Result = await client.rpc('purge_tasks', { p_task_ids: taskIds });
      
      if (!purgeV1Result.error) {
        this.logger.info('purgeTasksFromCloud: purge_tasks (v1) 成功', { 
          projectId, 
          taskCount: taskIds.length,
          taskIds,
          purgedCount: purgeV1Result.data
        });
        // 【关键】即使 RPC 成功也添加本地 tombstone，确保多设备一致性
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // 两个 RPC 都失败，降级为软删除
      // 注意：软删除不会写入 tombstone，任务仍可能被其他设备同步回来
      this.logger.warn('purgeTasksFromCloud: RPC 均失败，降级为软删除', { 
        v2Error: purgeV2Result.error,
        v1Error: purgeV1Result.error 
      });
      
      const { error } = await client
        .from('tasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .in('id', taskIds);
      
      if (error) {
        this.logger.error('purgeTasksFromCloud: 软删除也失败', error);
        throw supabaseErrorToError(error);
      }
      
      // 【关键修复】添加本地 tombstone，防止软删除的任务被同步回来
      // 即使云端没有 tombstone，本地也会过滤这些任务
      this.addLocalTombstones(projectId, taskIds);
      
      // 软删除成功，但需要警告
      this.logger.warn('purgeTasksFromCloud: 已降级为软删除（已添加本地 tombstone 保护）', { 
        projectId, 
        taskIds 
      });
      
      // 【重要】软删除成功也返回 true，因为任务确实被标记删除了
      // 本地 tombstone 会防止这些任务在同步时复活
      return true;
    } catch (e) {
      this.logger.error('purgeTasksFromCloud 失败', e);
      Sentry.captureException(e, { 
        tags: { operation: 'purgeTasksFromCloud' },
        extra: { projectId, taskIds }
      });
      return false;
    }
  }
  
  // ==================== 项目同步 ====================
  
  /**
   * 推送项目到云端
   * 注意：RLS 策略要求 owner_id = auth.uid()，所以需要设置 owner_id
   * 使用限流服务控制并发请求数量
   */
  async pushProject(project: Project): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
    
    try {
      await this.throttle.execute(
        `push-project:${project.id}`,
        async () => {
          // 获取当前用户 ID（RLS 策略需要 owner_id = auth.uid()）
          const { data: { session } } = await client.auth.getSession();
          const userId = session?.user?.id;
          if (!userId) {
            throw new Error('用户未登录');
          }
          
          const { error } = await client
            .from('projects')
            .upsert({
              id: project.id,
              owner_id: userId,
              title: project.name,
              description: project.description,
              version: project.version || 1,
              updated_at: project.updatedAt || nowISO(),
              migrated_to_v2: true
            });
          
          if (error) throw supabaseErrorToError(error);
        },
        { priority: 'high', retries: 2 }  // 项目操作优先级高
      );
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 根据错误类型选择日志级别
      if (enhanced.isRetryable) {
        this.logger.debug(`推送项目失败 (${enhanced.errorType})，已加入重试队列`, enhanced.message);
      } else {
        this.logger.error('推送项目失败', enhanced);
      }
      
      Sentry.captureException(enhanced, { 
        tags: { 
          operation: 'pushProject',
          errorType: enhanced.errorType,
          isRetryable: String(enhanced.isRetryable)
        },
        level: enhanced.isRetryable ? 'info' : 'error',
        extra: {
          projectId: project.id,
          projectName: project.name
        }
      });
      
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
   * 
   * 自动重试策略：
   * - 对于可重试错误（5xx, 429, 408, 网络错误），立即重试 3 次（指数退避：1s, 2s, 4s）
   * - 重试失败后加入持久化重试队列，等待网络恢复后重试
   * - 使用限流服务控制并发请求数量
   */
  async pushConnection(connection: Connection, projectId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
    
    try {
      await this.throttle.execute(
        `push-connection:${connection.id}`,
        async () => {
          await this.retryWithBackoff(async () => {
            const { error } = await client
              .from('connections')
              .upsert({
                id: connection.id,
                project_id: projectId,
                source_id: connection.source,
                target_id: connection.target,
                title: connection.title || null,
                description: connection.description || null,
                deleted_at: connection.deletedAt || null
              });
            
            if (error) throw supabaseErrorToError(error);
          });
        },
        { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }  // 30秒超时，平衡用户体验
      );
      
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      this.logger.error('推送连接失败', {
        error: enhanced,
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        isRetryable: enhanced.isRetryable,
        errorType: enhanced.errorType
      });
      
      Sentry.captureException(enhanced, {
        tags: { 
          operation: 'pushConnection',
          errorType: enhanced.errorType,
          isRetryable: String(enhanced.isRetryable)
        },
        extra: {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target
        }
      });
      
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
  }
  
  // ==================== 重试队列 ====================
  
  /**
   * 从 localStorage 加载重试队列
   * 在构造函数中调用，恢复页面刷新前未完成的同步操作
   * 【关键修复】清理无效的连接项，防止外键约束错误累积
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
        // 【关键修复】清理超限的队列
        let items = parsed.items;
        if (items.length > this.MAX_RETRY_QUEUE_SIZE) {
          this.logger.warn('重试队列超限，截断', {
            original: items.length,
            limit: this.MAX_RETRY_QUEUE_SIZE
          });
          items = items.slice(-this.MAX_RETRY_QUEUE_SIZE); // 保留最新的项
          Sentry.captureMessage('重试队列加载时超限', {
            level: 'warning',
            tags: { originalSize: String(parsed.items.length) }
          });
        }
        
        // 【关键修复】清理过期的重试项（超过 24 小时）
        const now = Date.now();
        items = items.filter((item: RetryQueueItem) => {
          if (now - item.createdAt > this.MAX_RETRY_ITEM_AGE) {
            this.logger.debug('移除过期的重试项', {
              type: item.type,
              id: item.data.id,
              age: Math.floor((now - item.createdAt) / 1000 / 60) + ' 分钟'
            });
            return false;
          }
          return true;
        });
        
        this.retryQueue = items;
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
   * 【关键修复】添加队列大小限制，防止 localStorage 配额溢出
   */
  private addToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Task | Project | Connection | { id: string },
    projectId?: string
  ): void {
    // 【关键修复】检查队列大小，超限时清理最老的项
    if (this.retryQueue.length >= this.MAX_RETRY_QUEUE_SIZE) {
      const removed = this.retryQueue.shift(); // 移除最老的项
      this.logger.warn('重试队列已满，移除最老的项', {
        removed: { type: removed?.type, id: removed?.data.id },
        queueSize: this.retryQueue.length
      });
      Sentry.captureMessage('重试队列溢出', {
        level: 'warning',
        tags: { queueSize: String(this.retryQueue.length) }
      });
    }
    
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
   * 【关键修复】按依赖顺序处理：项目 → 任务 → 连接，防止外键约束违反
   */
  private async processRetryQueue(): Promise<void> {
    if (this.state().isSyncing || !this.state().isOnline) return;
    
    this.state.update(s => ({ ...s, isSyncing: true }));
    
    const itemsToProcess = [...this.retryQueue];
    this.retryQueue = [];
    
    // 【关键修复】按类型排序：project → task → connection
    const sortedItems = itemsToProcess.sort((a, b) => {
      const order = { project: 0, task: 1, connection: 2 };
      return order[a.type] - order[b.type];
    });
    
    // 【关键修复】追踪成功推送的任务 ID
    const successfulTaskIds = new Set<string>();
    
    for (const item of sortedItems) {
      let success = false;
      
      try {
        if (item.type === 'task') {
          if (item.operation === 'upsert') {
            success = await this.pushTask(item.data as Task, item.projectId!);
            if (success) {
              successfulTaskIds.add(item.data.id);
            }
          } else {
            success = await this.deleteTask(item.data.id, item.projectId!);
          }
        } else if (item.type === 'project') {
          success = await this.pushProject(item.data as Project);
        } else if (item.type === 'connection') {
          // 【关键修复】验证连接引用的任务是否存在
          const conn = item.data as Connection;
          if (!successfulTaskIds.has(conn.source) && !successfulTaskIds.has(conn.target)) {
            this.logger.warn('跳过连接重试（引用的任务未在本批次成功）', {
              connectionId: conn.id,
              source: conn.source,
              target: conn.target
            });
            // 仍然加回队列，等待下次重试
            item.retryCount++;
            if (item.retryCount < this.MAX_RETRIES) {
              this.retryQueue.push(item);
            }
            continue;
          }
          success = await this.pushConnection(conn, item.projectId!);
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
  
  /**
   * 清理重试队列（公开方法，供紧急情况使用）
   * 【关键修复】用于手动清理累积的无效重试项，防止 localStorage 溢出
   */
  clearRetryQueue(): void {
    const count = this.retryQueue.length;
    this.retryQueue = [];
    this.saveRetryQueueToStorage();
    this.state.update(s => ({ ...s, pendingCount: 0 }));
    
    this.logger.info(`已清理 ${count} 个重试项`);
    this.toast.info(`已清理 ${count} 个待同步项`);
    
    Sentry.captureMessage('手动清理重试队列', {
      level: 'info',
      tags: { clearedCount: String(count) }
    });
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
      title: row.title ?? undefined,
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
  
  // ==================== 数据漂移检测 ====================
  
  /**
   * 检测数据漂移
   * 比较本地和远程的行数差异，如果差异显著则上报 Sentry
   * 
   * 【设计原则】来自高级顾问建议：
   * - 每 50 次同步检查一次
   * - 如果本地和远程行数差异超过 20%，上报警告
   * - 用于检测同步逻辑是否静默丢弃数据
   */
  private async checkDataDrift(projectId: string, localTaskCount: number, localConnectionCount: number): Promise<void> {
    const client = this.getSupabaseClient();
    if (!client) return;
    
    try {
      // 查询远程任务和连接数量
      const [tasksResult, connectionsResult] = await Promise.all([
        client.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', projectId).is('deleted_at', null),
        client.from('connections').select('id', { count: 'exact', head: true }).eq('project_id', projectId).is('deleted_at', null)
      ]);
      
      const remoteTaskCount = tasksResult.count ?? 0;
      const remoteConnectionCount = connectionsResult.count ?? 0;
      
      // 计算差异
      const taskDiff = Math.abs(localTaskCount - remoteTaskCount);
      const connectionDiff = Math.abs(localConnectionCount - remoteConnectionCount);
      
      // 差异阈值：20% 或 5 个以上
      const taskDriftThreshold = Math.max(localTaskCount * 0.2, 5);
      const connectionDriftThreshold = Math.max(localConnectionCount * 0.2, 3);
      
      const hasTaskDrift = taskDiff > taskDriftThreshold;
      const hasConnectionDrift = connectionDiff > connectionDriftThreshold;
      
      if (hasTaskDrift || hasConnectionDrift) {
        this.logger.warn('检测到数据漂移', {
          projectId,
          localTaskCount,
          remoteTaskCount,
          taskDiff,
          localConnectionCount,
          remoteConnectionCount,
          connectionDiff
        });
        
        // 上报 Sentry 警告
        Sentry.captureMessage('Data Drift Detected', {
          level: 'warning',
          tags: {
            operation: 'checkDataDrift',
            projectId
          },
          extra: {
            localTaskCount,
            remoteTaskCount,
            taskDiff,
            localConnectionCount,
            remoteConnectionCount,
            connectionDiff,
            syncCounter: this.syncCounter
          }
        });
      } else {
        this.logger.debug('数据漂移检测通过', {
          projectId,
          localTaskCount,
          remoteTaskCount,
          localConnectionCount,
          remoteConnectionCount
        });
      }
    } catch (e) {
      // 数据漂移检测失败不应影响正常同步流程
      this.logger.debug('数据漂移检测失败', e);
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
   * 
   * 批量推送优化：
   * - 在连续请求之间添加 100ms 延迟，防止触发服务器速率限制
   * - 每个请求自动重试（pushTask/pushConnection 内置重试机制）
   * 
   * 【关键修复】推送前检查 tombstones，防止已删除任务复活
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
      // 【关键防护】先获取 tombstones，过滤已永久删除的任务
      // 【修复】软删除任务（有 deletedAt）必须推送到云端，让其他设备知道任务已被删除
      // 否则云端保留旧数据，Realtime 同步时任务会"复活"
      const tombstoneIds = await this.getTombstoneIds(project.id);
      const tasksToSync = project.tasks.filter(task => {
        if (tombstoneIds.has(task.id)) {
          this.logger.info('saveProjectToCloud: 跳过 tombstone 任务', { taskId: task.id });
          return false;
        }
        // 【关键修复】不再跳过软删除任务！
        // 软删除任务必须推送 deletedAt 到云端，防止任务复活
        // 服务器端用 pg_cron 定期清理 30 天前的软删除记录
        return true;
      });
      
      if (tasksToSync.length !== project.tasks.length) {
        this.logger.info('saveProjectToCloud: 过滤了已删除任务', {
          original: project.tasks.length,
          filtered: tasksToSync.length,
          tombstoneCount: tombstoneIds.size
        });
      }
      
      // 【关键修复】处理永久删除的任务
      // 从 ChangeTracker 获取需要删除的任务 ID，调用 purge RPC 写入 tombstone
      const changes = this.changeTracker.getProjectChanges(project.id);
      if (changes.taskIdsToDelete.length > 0) {
        this.logger.info('saveProjectToCloud: 检测到永久删除任务', { 
          taskIds: changes.taskIdsToDelete 
        });
        const purgeSuccess = await this.purgeTasksFromCloud(project.id, changes.taskIdsToDelete);
        
        // 【关键】purge 成功后清除变更记录，防止重复删除
        if (purgeSuccess) {
          for (const taskId of changes.taskIdsToDelete) {
            this.changeTracker.clearTaskChange(project.id, taskId);
          }
          this.logger.debug('saveProjectToCloud: 已清除永久删除任务的变更记录');
        }
      }
      
      // 1. 保存项目元数据
      await this.pushProject(project);
      
      // 2. 批量保存任务（请求间延迟 100ms 防止速率限制）
      // 【关键修复】收集成功推送的任务 ID，用于后续连接验证
      const successfulTaskIds = new Set<string>();
      for (let i = 0; i < tasksToSync.length; i++) {
        if (i > 0) {
          await this.delay(100); // 防止连续请求触发 504/429
        }
        const success = await this.pushTask(tasksToSync[i], project.id);
        if (success) {
          successfulTaskIds.add(tasksToSync[i].id);
        }
      }
      
      // 3. 批量保存连接（请求间延迟 100ms 防止速率限制）
      // 【修复数据漂移】过滤软删除的连接，与远程查询逻辑保持一致
      // 【关键修复】过滤引用未同步成功任务的连接，防止外键约束违反
      const connectionsToSync = project.connections.filter(conn => {
        if (conn.deletedAt) return false;
        if (!successfulTaskIds.has(conn.source) || !successfulTaskIds.has(conn.target)) {
          this.logger.warn('跳过连接（引用的任务未同步成功）', {
            connectionId: conn.id,
            source: conn.source,
            target: conn.target,
            sourceExists: successfulTaskIds.has(conn.source),
            targetExists: successfulTaskIds.has(conn.target)
          });
          return false;
        }
        return true;
      });
      
      if (connectionsToSync.length !== project.connections.length) {
        this.logger.info('saveProjectToCloud: 过滤了软删除连接', {
          original: project.connections.length,
          filtered: connectionsToSync.length
        });
      }
      
      for (let i = 0; i < connectionsToSync.length; i++) {
        if (i > 0) {
          await this.delay(100); // 防止连续请求触发 504/429
        }
        await this.pushConnection(connectionsToSync[i], project.id);
      }
      
      this.syncState.update(s => ({
        ...s,
        isSyncing: false,
        lastSyncTime: nowISO()
      }));
      
      // 【数据漂移检测】来自高级顾问建议
      // 每 50 次同步检查本地和远程行数差异，上报 Sentry 警告
      // 【修复】使用过滤后的连接数，与远程查询逻辑保持一致
      this.syncCounter++;
      if (this.syncCounter % 50 === 0) {
        this.checkDataDrift(project.id, tasksToSync.length, connectionsToSync.length);
      }
      
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
   * 使用请求限流避免连接池耗尽
   */
  async loadFullProject(projectId: string, _userId: string): Promise<Project | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      // 1. 加载项目元数据（使用限流 + 去重）
      const projectData = await this.throttle.execute(
        `project-meta:${projectId}`,
        async () => {
          const { data, error } = await client
            .from('projects')
            .select('*')
            .eq('id', projectId)
            .single();
          if (error) throw error;
          return data;
        },
        { deduplicate: true, priority: 'normal' }
      );
      
      // 【修复】顺序加载任务和连接，避免绕过限流服务的并发控制
      // 原来使用 Promise.all 会同时发起多个请求，可能导致连接池耗尽
      // 虽然每个请求都通过 throttle.execute 包装，但 Promise.all 会同时触发它们
      // 限流服务会把它们都加入队列，但如果队列处理速度快，仍可能同时发起多个 HTTP 请求
      const tasks = await this.pullTasksThrottled(projectId);
      const connectionsData = await this.throttle.execute(
        `connections:${projectId}`,
        async () => {
          // 【关键修复】不再过滤 deleted_at！
          // 同步查询必须返回已删除记录，由客户端处理删除逻辑
          // 否则其他设备无法知道某个连接已被删除，导致连接"复活"
          const { data } = await client
            .from('connections')
            .select('*')
            .eq('project_id', projectId);
          return data || [];
        },
        { deduplicate: true, priority: 'normal' }
      );
      
      // 转换连接数据，保留 deletedAt 字段
      const connections: Connection[] = connectionsData.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        source: String(row.source_id),
        target: String(row.target_id),
        title: row.title ? String(row.title) : undefined,
        description: String(row.description || ''),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null
      }));
      
      const project = this.rowToProject(projectData);
      // 【关键修复】不再在这里过滤已删除的任务和连接
      // 返回所有数据，由调用方决定如何处理已删除的记录
      project.tasks = tasks;
      project.connections = connections;
      
      return project;
    } catch (e) {
      this.logger.error('加载项目失败', e);
      Sentry.captureException(e, { tags: { operation: 'loadFullProject' } });
      return null;
    }
  }
  
  /**
   * 拉取任务（带限流）
   * 
   * 【关键修复】检查 task_tombstones 表，防止已删除任务复活
   * 
   * 问题场景：
   * 1. 设备 A 删除任务（软删除 + purge 写入 tombstone）
   * 2. 设备 B 本地缓存中仍有该任务
   * 3. 设备 B 同步时如果不检查 tombstones，会把已删除任务推回云端
   * 
   * 解决方案：
   * - 拉取任务时同时查询 task_tombstones
   * - 过滤掉已在 tombstones 中的任务
   * - 过滤掉已软删除（deleted_at 非空）的任务
   */
  private async pullTasksThrottled(projectId: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    return this.throttle.execute(
      `tasks:${projectId}`,
      async () => {
        // 【修复】顺序加载任务和 tombstones，避免绕过限流服务的并发控制
        // 原来使用 Promise.all 会导致限流服务认为只有 1 个请求，实际发起 2 个 HTTP 请求
        // 这会导致连接池耗尽，出现 "Failed to fetch" 错误
        const tasksResult = await client
          .from('tasks')
          .select('*')
          .eq('project_id', projectId);
        
        const tombstonesResult = await client
          .from('task_tombstones')
          .select('task_id')
          .eq('project_id', projectId);
        
        if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
        
        // 2. 构建 tombstone ID 集合（云端 + 本地）
        // tombstones 查询失败时降级：只依赖本地 tombstone 和 deleted_at 过滤
        const tombstoneIds = new Set<string>();
        
        // 添加云端 tombstones
        if (tombstonesResult.error) {
          this.logger.warn('加载云端 tombstones 失败，使用本地缓存', tombstonesResult.error);
        } else {
          for (const t of (tombstonesResult.data || [])) {
            tombstoneIds.add(t.task_id);
          }
        }
        
        // 【关键修复】合并本地 tombstones（用于 RPC 不可用时的保护）
        const localTombstones = this.getLocalTombstones(projectId);
        for (const id of localTombstones) {
          tombstoneIds.add(id);
        }
        
        if (localTombstones.size > 0) {
          this.logger.debug('合并本地 tombstones', { 
            projectId, 
            localCount: localTombstones.size,
            cloudCount: tombstoneIds.size - localTombstones.size
          });
        }
        
        // 3. 【关键修复】返回所有任务，包括已删除的
        // 同步查询必须返回已删除记录，由客户端处理删除逻辑
        // 否则其他设备无法知道某个任务已被删除，导致任务"复活"
        const allTasks = (tasksResult.data as TaskRow[] || []).map(row => this.rowToTask(row));
        
        // 标记 tombstone 任务（永久删除）
        const markedTasks = allTasks.map(task => {
          if (tombstoneIds.has(task.id)) {
            this.logger.debug('标记 tombstone 任务', { taskId: task.id });
            return { ...task, deletedAt: task.deletedAt || new Date().toISOString() };
          }
          return task;
        });
        
        const deletedCount = markedTasks.filter(t => t.deletedAt).length;
        if (tombstoneIds.size > 0 || deletedCount > 0) {
          this.logger.info(`任务同步信息`, {
            projectId,
            totalCount: allTasks.length,
            tombstoneCount: tombstoneIds.size,
            softDeletedCount: deletedCount - tombstoneIds.size
          });
        }
        
        return markedTasks;
      },
      { deduplicate: true, priority: 'normal' }
    );
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
   * 
   * 【关键修复】保存前过滤已删除的任务，防止网络恢复后复活
   */
  saveOfflineSnapshot(projects: Project[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      // 【关键修复】过滤每个项目中已删除的任务
      // 只保存未删除的任务，防止已删除任务在网络恢复后被误认为"本地新增"而复活
      const cleanedProjects = projects.map(p => ({
        ...p,
        tasks: (p.tasks || []).filter(t => !t.deletedAt)
      }));
      
      localStorage.setItem(this.OFFLINE_CACHE_KEY, JSON.stringify({
        projects: cleanedProjects,
        version: this.CACHE_VERSION
      }));
    } catch (e) {
      this.logger.warn('离线快照保存失败', e);
    }
  }
  
  /**
   * 加载离线快照
   * 
   * 【关键修复】加载时防御性过滤已删除任务
   * 虽然 saveOfflineSnapshot 保存时已过滤，但旧版本缓存可能包含已删除任务
   */
  loadOfflineSnapshot(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const cached = localStorage.getItem(this.OFFLINE_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          // 【关键修复】防御性过滤：确保不会从旧版本缓存中恢复已删除任务
          return parsed.projects.map((p: Project) => ({
            ...p,
            tasks: (p.tasks || []).filter((t: Task) => !t.deletedAt)
          }));
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
   * 使用请求限流避免并发请求耗尽连接池
   * 
   * @param userId 用户 ID
   * @param _silent 静默模式（兼容旧接口，忽略）
   */
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    this.isLoadingRemote.set(true);
    
    try {
      // 1. 先加载项目列表（单个请求）
      const projectList = await this.throttle.execute(
        `project-list:${userId}`,
        async () => {
          const { data, error } = await client
            .from('projects')
            .select('*')
            .eq('owner_id', userId)
            .order('updated_at', { ascending: false });
          
          if (error) throw supabaseErrorToError(error);
          return data || [];
        },
        { deduplicate: true, priority: 'high' }
      );
      
      // 2. 【优化】使用 Promise.allSettled 配合限流服务实现有限并行
      // RequestThrottleService 自动控制并发数（默认 4 个），避免连接池耗尽
      // 使用 allSettled 确保部分失败不影响其他项目加载
      
      this.logger.debug('开始并行加载项目', { count: projectList.length });
      
      const loadPromises = projectList.map(row => 
        this.loadFullProject(row.id, userId)
      );
      
      const results = await Promise.allSettled(loadPromises);
      
      const projects: Project[] = [];
      let failedCount = 0;
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          projects.push(result.value);
        } else if (result.status === 'rejected') {
          failedCount++;
          this.logger.warn('加载项目失败', { 
            projectId: projectList[i]?.id,
            error: result.reason 
          });
        }
      }
      
      if (failedCount > 0) {
        this.logger.warn('部分项目加载失败', { 
          total: projectList.length, 
          failed: failedCount,
          success: projects.length 
        });
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
