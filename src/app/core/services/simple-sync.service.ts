/**
 * SimpleSyncService - 简化的同步服务
 * 
 * 核心原则（来自 agents.md）：
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 * 
 * 【流量优化】2024-12-31
 * - 默认禁用 Realtime，改用轮询节省流量
 * - 字段筛选替代 SELECT * 节省 60-70% 流量
 * - 增量同步优化
 * - Tombstone 缓存避免重复查询
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ChangeTrackerService } from '../../../services/change-tracker.service';
import { CircuitBreakerService } from '../../../services/circuit-breaker.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { MobileSyncStrategyService } from '../../../services/mobile-sync-strategy.service';
import { Task, Project, Connection, UserPreferences, ThemeType } from '../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import { supabaseErrorToError, EnhancedError } from '../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../utils/timeout';
import { PermanentFailureError, isPermanentFailureError } from '../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG, SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../config';
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

/** 用户偏好变更回调 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

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
  private readonly circuitBreaker = inject(CircuitBreakerService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly mobileSync = inject(MobileSyncStrategyService);
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
  
  /** 重试队列存储大小限制（字节） */
  private readonly RETRY_QUEUE_SIZE_LIMIT = SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES;
  
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

  /** 用户偏好变更回调（Realtime） */
  private onUserPreferencesChangeCallback: UserPreferencesChangeCallback | null = null;
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;
  
  // ==================== 轮询相关（流量优化）====================
  /** 轮询定时器 */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前订阅的项目 ID */
  private currentProjectId: string | null = null;
  /** 用户活跃状态 */
  private isUserActive = true;
  /** 用户活跃超时定时器 */
  private userActiveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最后一次同步时间（用于增量同步） */
  private lastSyncTimeByProject: Map<string, string> = new Map();
  /** Tombstone 缓存（项目ID -> { ids: Set, timestamp }） */
  private tombstoneCache: Map<string, { ids: Set<string>; timestamp: number }> = new Map();
  
  /** Realtime 是否启用（运行时可切换） */
  readonly isRealtimeEnabled = signal<boolean>(SYNC_CONFIG.REALTIME_ENABLED);
  
  /**
   * 处理会话过期错误（统一入口，防止重复 Toast）
   * @param context 操作上下文（用于日志）
   * @param details 详细信息（用于日志）
   * @returns 始终返回 false（表示操作失败）
   */
  private handleSessionExpired(context: string, details?: Record<string, unknown>): never {
    // 幂等性保护：只在首次检测时设置标志和显示提示
    if (!this.syncState().sessionExpired) {
      this.syncState.update(s => ({ ...s, sessionExpired: true }));
      this.logger.warn(`检测到会话过期: ${context}`, details);
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    } else {
      // 已经标记过期，仅记录日志
      this.logger.debug(`会话已过期（已标记）: ${context}`, details);
    }
    // 抛出永久失败异常，防止重试
    throw new PermanentFailureError(
      'Session expired',
      undefined,
      { context, ...details }
    );
  }
  
  /**
   * 检查错误是否为会话过期错误（401, 42501 RLS, AuthError）
   */
  private isSessionExpiredError(error: EnhancedError): boolean {
    return (
      error.errorType === 'AuthError' ||
      error.code === 401 || error.code === '401' ||
      error.code === 42501 || error.code === '42501'
    );
  }
  
  constructor() {
    this.loadRetryQueueFromStorage(); // 恢复持久化的重试队列
    this.loadLocalTombstones(); // 恢复本地 tombstone 缓存
    this.setupNetworkListeners();
    this.startRetryLoop();
    this.setupUserActivityTracking();
    
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }
  
  // ==================== 用户活跃状态追踪 ====================
  
  /**
   * 设置用户活跃状态追踪
   * 用于动态调整轮询频率
   */
  private setupUserActivityTracking(): void {
    if (typeof window === 'undefined') return;
    
    const resetActiveTimer = () => {
      this.isUserActive = true;
      if (this.userActiveTimer) {
        clearTimeout(this.userActiveTimer);
      }
      this.userActiveTimer = setTimeout(() => {
        this.isUserActive = false;
      }, SYNC_CONFIG.USER_ACTIVE_TIMEOUT);
    };
    
    // 监听用户活动事件
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      window.addEventListener(event, resetActiveTimer, { passive: true });
    });
    
    // 初始化
    resetActiveTimer();
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
   * 删除 Storage 中的附件文件
   * 
   * 【v5.7 附件-任务删除联动】
   * 在任务永久删除时，清理关联的附件文件
   * 异步执行，不阻塞任务删除操作
   * 
   * @param client Supabase 客户端
   * @param paths 附件存储路径列表
   */
  private async deleteAttachmentFilesFromStorage(
    client: ReturnType<typeof this.getSupabaseClient>,
    paths: string[]
  ): Promise<void> {
    if (!client || paths.length === 0) return;
    
    try {
      // 批量删除，每次最多 100 个
      const batchSize = 100;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const { error } = await client.storage
          .from('attachments')
          .remove(batch);
        
        if (error) {
          this.logger.warn('deleteAttachmentFilesFromStorage: 批量删除失败', {
            batch: batch.slice(0, 5),
            batchSize: batch.length,
            error: error.message
          });
          // 继续删除下一批，不抛出异常
        } else {
          this.logger.debug('deleteAttachmentFilesFromStorage: 批量删除成功', {
            batchIndex: i / batchSize,
            batchSize: batch.length
          });
        }
      }
      
      this.logger.info('deleteAttachmentFilesFromStorage: 完成', {
        totalPaths: paths.length
      });
    } catch (e) {
      this.logger.error('deleteAttachmentFilesFromStorage: 异常', e);
      // 不抛出，因为任务已经删除，附件清理失败只是资源浪费，不影响功能
    }
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
  
  // ==================== Tombstone 缓存（流量优化）====================
  
  /**
   * 获取 Tombstones（带缓存）
   * 
   * 【流量优化】缓存 tombstone 结果，避免每次同步都查询
   * 缓存有效期：5 分钟（SYNC_CONFIG.TOMBSTONE_CACHE_TTL）
   */
  private async getTombstonesWithCache(
    projectId: string, 
    client: SupabaseClient
  ): Promise<{ data: { task_id: string }[] | null; error: Error | null }> {
    const now = Date.now();
    const cached = this.tombstoneCache.get(projectId);
    
    // 检查缓存是否有效
    if (cached && (now - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      this.logger.debug('使用 Tombstone 缓存', { 
        projectId, 
        count: cached.ids.size,
        age: Math.round((now - cached.timestamp) / 1000) + 's'
      });
      return { 
        data: Array.from(cached.ids).map(id => ({ task_id: id })), 
        error: null 
      };
    }
    
    // 缓存过期或不存在，查询云端
    try {
      const result = await this.throttle.execute(
        `task-tombstones:${projectId}`,
        async () => {
          return await client
            .from('task_tombstones')
            .select(FIELD_SELECT_CONFIG.TOMBSTONE_FIELDS)
            .eq('project_id', projectId);
        },
        { 
          deduplicate: true,
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
        }
      );
      
      // 更新缓存
      if (!result.error && result.data) {
        const ids = new Set<string>();
        for (const row of result.data) {
          ids.add(row.task_id);
        }
        this.tombstoneCache.set(projectId, { ids, timestamp: now });
        this.logger.debug('更新 Tombstone 缓存', { projectId, count: ids.size });
      }
      
      return result;
    } catch (e) {
      return { data: null, error: e as Error };
    }
  }
  
  /**
   * 清除 Tombstone 缓存（当有新的删除操作时）
   */
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneCache.delete(projectId);
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
    
    // 清理 Realtime 订阅，防止资源泄漏
    // 注意：这里不使用 await，因为 cleanup 在 destroyRef 回调中同步调用
    if (this.realtimeChannel) {
      this.realtimeChannel = null;
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
          await this.delay(delay);
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
   * - 推送前检查 task_tombstones 表（除非调用方已完成批量过滤）
   * - 如果任务已在 tombstones 中，跳过推送避免复活
   * 
   * @param skipTombstoneCheck 跳过 tombstone 检查（调用方已批量过滤时使用）
   * @returns Promise<boolean> 成功返回 true，失败返回 false
   * @throws {PermanentFailureError} 版本冲突或会话过期时抛出，不应重试
   */
  async pushTask(task: Task, projectId: string, skipTombstoneCheck = false): Promise<boolean> {
    // 【Critical #1】会话过期检查 - 阻止在会话过期后继续同步
    if (this.syncState().sessionExpired) {
      this.handleSessionExpired('pushTask', { taskId: task.id, projectId });
    }
    
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
      // 【Critical】验证用户会话，防止 RLS 策略违规
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        // 检测到会话丢失，设置 sessionExpired 标志并停止同步
        this.syncState.update(s => ({ ...s, sessionExpired: true }));
        this.logger.warn('检测到会话丢失', { taskId: task.id, operation: 'pushTask' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        // 不加入重试队列（会话过期后重试无意义，需要重新登录）
        return false;
      }
      
      await this.throttle.execute(
        `push-task:${task.id}`,
        async () => {
          // 【防御层 #1】tombstone 检查（除非调用方已批量过滤）
          // skipTombstoneCheck=true: 调用方已通过批量查询过滤，跳过单独检查（性能优化）
          // skipTombstoneCheck=false: 调用方未过滤，执行单独检查（防止复活，fail-safe）
          if (!skipTombstoneCheck) {
            const { data: tombstone } = await client
              .from('task_tombstones')
              .select('task_id')
              .eq('task_id', task.id)
              .maybeSingle();
            
            if (tombstone) {
              this.logger.info('pushTask: 跳过已删除任务（tombstone 防护）', { 
                taskId: task.id, 
                projectId 
              });
              return; // 直接返回，不执行 upsert
            }
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
      
      // 【修复】检测会话过期错误，使用统一处理
      if (this.isSessionExpiredError(enhanced)) {
        this.handleSessionExpired('pushTask', { taskId: task.id, projectId, errorCode: enhanced.code });
      }
      
      // 【乐观锁强化】版本冲突错误不加入重试队列，需要用户刷新后重试
      if (enhanced.errorType === 'VersionConflictError') {
        this.logger.warn('推送任务版本冲突', { taskId: task.id, projectId });
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        Sentry.captureMessage('Optimistic lock conflict in pushTask', {
          level: 'warning',
          tags: { operation: 'pushTask', taskId: task.id, projectId },
          extra: { taskUpdatedAt: task.updatedAt }
        });
        // 抛出永久失败错误，让 processRetryQueue 知道不要重试
        throw new PermanentFailureError(
          'Version conflict',
          enhanced,
          { operation: 'pushTask', taskId: task.id, projectId }
        );
      }
      
      // Circuit Breaker: 记录失败（仅网络错误）
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
      
      // 【关键修复】只有可重试的错误才加入重试队列
      // 数据验证错误（如 "Task must have either title or content"）是不可重试的
      if (enhanced.isRetryable) {
        this.addToRetryQueue('task', 'upsert', task, projectId);
      } else {
        this.logger.warn('不可重试的错误，不加入重试队列', {
          taskId: task.id,
          errorType: enhanced.errorType,
          message: enhanced.message
        });
      }
      return false;
    }
  }
  
  /**
   * 从云端拉取任务
   * LWW：只更新 updated_at 更新的数据
   * 
   * 【关键修复】检查 task_tombstones 表，防止已删除任务复活
   * 
   * 【流量优化】使用字段筛选，不加载 content 字段
   */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      // 1. 并行查询任务和 tombstones（使用缓存）
      // 【流量优化】使用字段筛选，不加载 content
      let tasksQuery = client
        .from('tasks')
        .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)
        .eq('project_id', projectId);
      
      if (since) {
        tasksQuery = tasksQuery.gt('updated_at', since);
      }
      
      // 【流量优化】使用 tombstone 缓存
      const [tasksResult, tombstonesResult] = await Promise.all([
        tasksQuery,
        this.getTombstonesWithCache(projectId, client)
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
    // 【Critical】会话过期检查 - 阻止在会话过期后继续同步
    if (this.syncState().sessionExpired) {
      this.handleSessionExpired('deleteTask', { taskId, projectId });
    }
    
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
      
      // 【流量优化】删除成功后失效 Tombstone 缓存
      // 确保下次同步能获取最新的 tombstone 列表
      this.invalidateTombstoneCache(projectId);
      
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 【修复】检测会话过期错误
      if (this.isSessionExpiredError(enhanced)) {
        this.handleSessionExpired('deleteTask', { taskId, projectId, errorCode: enhanced.code });
      }
      
      this.logger.error('删除任务失败', enhanced);
      Sentry.captureException(enhanced, { 
        tags: { 
          operation: 'deleteTask',
          errorType: enhanced.errorType,
          isRetryable: String(enhanced.isRetryable)
        },
        level: enhanced.isRetryable ? 'info' : 'error'
      });
      
      // 【关键修复】只有可重试的错误才加入重试队列
      if (enhanced.isRetryable) {
        this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      } else {
        this.logger.warn('不可重试的删除错误，不加入重试队列', {
          taskId,
          errorType: enhanced.errorType,
          message: enhanced.message
        });
      }
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
    const result = await this.getTombstoneIdsWithStatus(projectId);
    return result.ids;
  }
  
  /**
   * 【v5.9】获取项目的所有 tombstone 任务 ID（带查询状态）
   * 用于合并时判断是否需要保守处理
   * 
   * @returns TombstoneQueryResult 包含 ID 集合和查询状态
   */
  async getTombstoneIdsWithStatus(projectId: string): Promise<{
    ids: Set<string>;
    fromRemote: boolean;
    localCacheOnly: boolean;
    timestamp: number;
  }> {
    const tombstoneIds = new Set<string>();
    let fromRemote = false;
    let localCacheOnly = true;
    
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
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
    
    try {
      const { data, error } = await client
        .from('task_tombstones')
        .select('task_id')
        .eq('project_id', projectId);
      
      if (error) {
        this.logger.warn('获取云端 tombstones 失败，使用本地缓存', error);
        return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
      }
      
      // 添加云端 tombstones
      for (const t of (data || [])) {
        tombstoneIds.add(t.task_id);
      }
      
      fromRemote = true;
      localCacheOnly = false;
      
      if (localTombstones.size > 0 || tombstoneIds.size > localTombstones.size) {
        this.logger.debug('getTombstoneIds: 合并完成', {
          projectId,
          localCount: localTombstones.size,
          cloudCount: tombstoneIds.size - localTombstones.size,
          totalCount: tombstoneIds.size
        });
      }
      
      return { ids: tombstoneIds, fromRemote, localCacheOnly, timestamp: Date.now() };
    } catch (e) {
      this.logger.warn('获取 tombstones 异常，使用本地缓存', e);
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
  }
  
  /**
   * 获取项目的所有 connection tombstone ID
   * 用于检查连接是否已被永久删除
   * 
   * 【P0 防复活】防止已删除连接被旧客户端复活
   */
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    const tombstoneIds = new Set<string>();
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getConnectionTombstoneIds: 离线模式，返回空集', { projectId });
      return tombstoneIds;
    }
    
    try {
      const { data, error } = await client
        .from('connection_tombstones')
        .select('connection_id')
        .eq('project_id', projectId);
      
      if (error) {
        this.logger.warn('获取连接 tombstones 失败', error);
        return tombstoneIds;
      }
      
      for (const t of (data || [])) {
        tombstoneIds.add(t.connection_id);
      }
      
      if (tombstoneIds.size > 0) {
        this.logger.debug('getConnectionTombstoneIds: 获取完成', {
          projectId,
          count: tombstoneIds.size
        });
      }
      
      return tombstoneIds;
    } catch (e) {
      this.logger.warn('获取连接 tombstones 异常', e);
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
   * - v5.7: 新增 purge_tasks_v3 支持返回附件路径，自动清理 Storage 中的附件文件
   * 
   * @returns true 表示成功（包括降级为软删除），false 表示完全失败
   */
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    if (taskIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
      // 【关键修复】离线时加入重试队列（离线是可重试的网络问题）
      for (const taskId of taskIds) {
        this.addToRetryQueue('task', 'delete', { id: taskId }, projectId);
      }
      return false;
    }
    
    try {
      // 优先使用 purge_tasks_v3（返回附件路径以便删除）
      this.logger.debug('purgeTasksFromCloud: 调用 purge_tasks_v3', { projectId, taskIds });
      const purgeV3Result = await client.rpc('purge_tasks_v3', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV3Result.error && purgeV3Result.data) {
        const { purged_count, attachment_paths } = purgeV3Result.data as { 
          purged_count: number; 
          attachment_paths: string[] 
        };
        
        this.logger.info('purgeTasksFromCloud: purge_tasks_v3 成功', { 
          projectId, 
          taskCount: taskIds.length,
          taskIds,
          purgedCount: purged_count,
          attachmentPathsCount: attachment_paths?.length ?? 0
        });
        
        // 【v5.7】删除附件文件（后台异步，不阻塞返回）
        if (attachment_paths && attachment_paths.length > 0) {
          this.deleteAttachmentFilesFromStorage(client, attachment_paths).catch(err => {
            this.logger.warn('purgeTasksFromCloud: 附件文件删除失败（任务已删除）', err);
          });
        }
        
        // 【关键】即使 RPC 成功也添加本地 tombstone，确保多设备一致性
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // v3 失败，降级到 v2（不返回附件路径）
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v3 失败，尝试 v2', purgeV3Result.error);
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
  
  /**
   * 安全批量软删除任务（服务端防护）
   * 
   * 【P0 熔断层】使用 safe_delete_tasks RPC 确保批量删除不会超过限制：
   * - 单次删除不能超过 50% 或 50 条任务
   * - 项目任务数 > 10 时，不允许删到 0
   * 
   * 此方法应在用户触发批量删除时调用，确保服务端也执行相同的保护逻辑。
   * 客户端 CircuitBreakerService 提供第一层保护，服务端 RPC 提供第二层保护。
   * 
   * @param projectId 项目 ID
   * @param taskIds 要删除的任务 ID 列表
   * @returns 实际删除的任务数量，-1 表示失败
   */
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('softDeleteTasksBatch: 离线模式，跳过服务端删除', { taskIds });
      // 离线模式下由本地处理删除，后续同步时推送 deletedAt
      return taskIds.length;
    }
    
    try {
      this.logger.debug('softDeleteTasksBatch: 调用 safe_delete_tasks RPC', { 
        projectId, 
        taskIds,
        taskCount: taskIds.length 
      });
      
      const { data, error } = await client.rpc('safe_delete_tasks', {
        p_task_ids: taskIds,
        p_project_id: projectId
      });
      
      if (error) {
        // 检查是否是熔断规则阻止
        if (error.message?.includes('Bulk delete blocked')) {
          this.logger.warn('softDeleteTasksBatch: 服务端熔断阻止删除', { 
            projectId, 
            taskIds,
            error: error.message 
          });
          this.toast.warning('删除被阻止', error.message);
          Sentry.captureMessage('Server circuit breaker blocked delete', {
            level: 'warning',
            tags: { operation: 'softDeleteTasksBatch', projectId },
            extra: { taskIds, error: error.message }
          });
          return -1;
        }
        
        throw supabaseErrorToError(error);
      }
      
      this.logger.info('softDeleteTasksBatch: 删除成功', { 
        projectId, 
        requestedCount: taskIds.length,
        affectedCount: data
      });
      
      return data ?? 0;
    } catch (e) {
      this.logger.error('softDeleteTasksBatch 失败', e);
      Sentry.captureException(e, { 
        tags: { operation: 'softDeleteTasksBatch' },
        extra: { projectId, taskIds }
      });
      
      // RPC 失败时降级为逐个软删除
      this.logger.warn('softDeleteTasksBatch: RPC 失败，降级为逐个更新');
      try {
        const { error } = await client
          .from('tasks')
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('id', taskIds);
        
        if (error) {
          this.logger.error('softDeleteTasksBatch: 降级也失败', error);
          throw supabaseErrorToError(error);
        }
        
        return taskIds.length;
      } catch (fallbackError) {
        this.logger.error('softDeleteTasksBatch: 完全失败', fallbackError);
        return -1;
      }
    }
  }
  
  // ==================== 项目同步 ====================
  
  /**
   * 推送项目到云端
   * 注意：RLS 策略要求 owner_id = auth.uid()，所以需要设置 owner_id
   * 使用限流服务控制并发请求数量
   */
  async pushProject(project: Project): Promise<boolean> {
    // 【Critical #6】会话过期检查 - 阻止在会话过期后继续同步
    if (this.syncState().sessionExpired) {
      this.handleSessionExpired('pushProject', { projectId: project.id });
    }
    
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
            // 【修复】检测到会话丢失，handleSessionExpired 会抛出永久失败异常
            this.handleSessionExpired('pushProject.getSession', { projectId: project.id });
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
      
      // 【修复】会话过期标记错误 - 已经处理过，直接返回
      // 检测会话过期错误（401, 42501）
      if (this.isSessionExpiredError(enhanced)) {
        this.handleSessionExpired('pushProject', { projectId: project.id, errorCode: enhanced.code });
      }
      
      // 【乐观锁强化】版本冲突错误不加入重试队列，需要用户刷新后重试
      if (enhanced.errorType === 'VersionConflictError') {
        this.logger.warn('推送项目版本冲突', { projectId: project.id });
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        Sentry.captureMessage('Optimistic lock conflict in pushProject', {
          level: 'warning',
          tags: { operation: 'pushProject', projectId: project.id },
          extra: { projectVersion: project.version }
        });
        // 抛出永久失败错误，让 processRetryQueue 知道不要重试
        throw new PermanentFailureError(
          'Version conflict',
          enhanced,
          { operation: 'pushProject', projectId: project.id }
        );
      }
      
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
      
      // 【关键修复】只有可重试的错误才加入重试队列
      // 版本回退错误（"Version regression not allowed"）是不可重试的
      if (enhanced.isRetryable) {
        this.addToRetryQueue('project', 'upsert', project);
      } else {
        this.logger.warn('不可重试的错误，不加入重试队列', {
          projectId: project.id,
          errorType: enhanced.errorType,
          message: enhanced.message
        });
      }
      return false;
    }
  }
  
  /**
   * 拉取项目列表
   * 
   * 【流量优化】使用字段筛选
   */
  async pullProjects(since?: string): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      // 【流量优化】使用字段筛选替代 SELECT *
      let query = client
        .from('projects')
        .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS);
      
      if (since) {
        query = query.gt('updated_at', since);
      }
      
      const { data, error } = await query;
      
      if (error) throw supabaseErrorToError(error);
      
      return (data || []).map(row => this.rowToProject(row as ProjectRow));
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
   * 
   * 【关键修复】推送前验证引用的任务存在，防止外键约束违规
   * 【P0 防复活】推送前检查 connection_tombstones 表，防止已删除连接复活
   * @param skipTaskExistenceCheck 跳过任务存在性检查（调用方已验证时使用，避免冗余查询超时）
   */
  async pushConnection(connection: Connection, projectId: string, skipTombstoneCheck = false, skipTaskExistenceCheck = false): Promise<boolean> {
    // 【Critical】会话过期检查 - 阻止在会话过期后继续同步
    if (this.syncState().sessionExpired) {
      this.logger.warn('会话已过期，连接同步被阻止', { connectionId: connection.id });
      // 不加入 RetryQueue（会话过期后重试无意义，需要重新登录）
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
      return false;
    }
    
    try {
      // 【Critical】验证用户会话，防止 RLS 策略违规
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        // 检测到会话丢失，设置 sessionExpired 标志并停止同步
        this.syncState.update(s => ({ ...s, sessionExpired: true }));
        this.logger.warn('检测到会话丢失', { connectionId: connection.id, operation: 'pushConnection' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        // 不加入重试队列（会话过期后重试无意义，需要重新登录）
        return false;
      }
      
      // 【防御层 #1】tombstone 检查（除非调用方已批量过滤）
      if (!skipTombstoneCheck) {
        const { data: tombstone } = await client
          .from('connection_tombstones')
          .select('connection_id')
          .eq('connection_id', connection.id)
          .maybeSingle();
        
        if (tombstone) {
          this.logger.info('pushConnection: 跳过已删除连接（tombstone 防护）', { 
            connectionId: connection.id, 
            projectId 
          });
          return false;
        }
      }
      
      // 【关键修复】推送前验证引用的任务存在性，防止外键约束违规
      // 【超时保护】使用 supabaseWithRetry 实现 10 秒超时 + 自动重试（最多3次）
      // 【重要】不过滤 deleted_at，因为数据库外键约束只检查任务行是否存在，不管软删除状态
      // 软删除的任务仍然在 tasks 表中，满足外键约束
      // 【性能优化 v2026-01】当调用方已批量验证任务存在性时，跳过冗余查询，避免频繁超时
      if (!skipTaskExistenceCheck) {
        let existingTasks: Array<{ id: string }> | null = null;
        try {
          const result = await supabaseWithRetry(
            () => client
              .from('tasks')
              .select('id')
              .in('id', [connection.source, connection.target])
              .eq('project_id', projectId),
            {
              timeout: 'QUICK', // 5秒超时（存在性检查应快速完成）
              maxRetries: 2     // 最多重试2次（总超时 < 15秒）
            }
          );
          
          // 【关键修复】检查 Supabase 查询错误
          if (result.error) {
            this.logger.warn('任务存在性查询失败，跳过连接推送', {
              connectionId: connection.id,
              source: connection.source,
              target: connection.target,
              error: result.error
            });
            return false; // fail-safe: 查询失败时不推送连接
          }
          
          existingTasks = result.data;
        } catch (error) {
          // 【错误处理】查询超时或失败视为任务不存在（fail-safe），不推送连接
          this.logger.warn('任务存在性查询失败（超时或错误），跳过连接推送', {
            connectionId: connection.id,
            source: connection.source,
            target: connection.target,
            error: error instanceof Error ? error.message : String(error)
          });
          
          Sentry.captureMessage('任务存在性查询失败', {
            level: 'warning',
            tags: { 
              operation: 'pushConnection', 
              errorType: error instanceof Error && error.message.includes('timeout') ? 'QUERY_TIMEOUT' : 'QUERY_ERROR'
            },
            extra: {
              connectionId: connection.id,
              projectId,
              source: connection.source,
              target: connection.target,
              errorMessage: error instanceof Error ? error.message : String(error)
            }
          });
          
          return false; // 失败不加入重试队列，避免累积
        }
        
        const existingTaskIds = new Set((existingTasks || []).map(t => t.id));
        
        if (!existingTaskIds.has(connection.source) || !existingTaskIds.has(connection.target)) {
          this.logger.warn('跳过推送连接（引用的任务不存在）', {
            connectionId: connection.id,
            source: connection.source,
            target: connection.target,
            sourceExists: existingTaskIds.has(connection.source),
            targetExists: existingTaskIds.has(connection.target)
          });
          
          // 【关键】外键约束违规不可重试，直接失败而不加入重试队列
          Sentry.captureMessage('连接引用的任务不存在', {
            level: 'warning',
            tags: { 
              operation: 'pushConnection',
              errorType: 'FOREIGN_KEY_VIOLATION'
            },
            extra: {
              connectionId: connection.id,
              projectId,
              source: connection.source,
              target: connection.target,
              sourceExists: existingTaskIds.has(connection.source),
              targetExists: existingTaskIds.has(connection.target)
            }
          });
          
          return false;
        }
      }
      
      await this.throttle.execute(
        `push-connection:${connection.id}`,
        async () => {
          await this.retryWithBackoff(async () => {
            // 【关键修复 v2026-01】使用 onConflict 处理复合唯一约束冲突
            // 数据库有两个唯一约束：
            //   1. 主键 id
            //   2. 复合唯一约束 (project_id, source_id, target_id)
            // 默认 upsert 只按主键冲突处理，需要显式指定 onConflict
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
              }, {
                // 按主键冲突时更新
                onConflict: 'id',
                // 忽略复合唯一约束冲突（相同 source/target 已存在时跳过）
                ignoreDuplicates: false
              });
            
            // 【关键修复】处理复合唯一约束冲突（23505 = unique_violation）
            // 如果冲突是因为已存在相同的 source/target 连接，视为幂等成功
            if (error) {
              const code = error.code || (error as { code?: string }).code;
              if (code === '23505' && error.message?.includes('connections_project_id_source_id_target_id')) {
                // 已存在相同连接，幂等成功，无需重复插入
                this.logger.info('连接已存在（幂等成功）', {
                  connectionId: connection.id,
                  source: connection.source,
                  target: connection.target
                });
                return; // 不抛出错误，视为成功
              }
              throw supabaseErrorToError(error);
            }
          });
        },
        { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }  // 30秒超时，平衡用户体验
      );
      
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 【乐观锁强化】版本冲突错误不加入重试队列，需要用户刷新后重试
      if (enhanced.errorType === 'VersionConflictError') {
        this.logger.warn('推送连接版本冲突', { connectionId: connection.id, projectId });
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        Sentry.captureMessage('Optimistic lock conflict in pushConnection', {
          level: 'warning',
          tags: { operation: 'pushConnection', connectionId: connection.id, projectId }
        });
        // 抛出永久失败错误，让 processRetryQueue 知道不要重试
        throw new PermanentFailureError(
          'Version conflict',
          enhanced,
          { operation: 'pushConnection', connectionId: connection.id, projectId }
        );
      }
      
      // 【关键修复】外键约束错误不可重试
      const isForeignKeyError = enhanced.errorType === 'ForeignKeyError' ||
                               enhanced.message?.includes('foreign key constraint') || 
                               enhanced.message?.includes('violates foreign key') ||
                               enhanced.code === '23503' || enhanced.code === 23503;
      
      if (isForeignKeyError) {
        this.logger.error('连接推送失败（外键约束违规）', {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          error: enhanced.message,
          errorCode: enhanced.code
        });
        
        Sentry.captureException(enhanced, {
          tags: { 
            operation: 'pushConnection',
            errorType: 'FOREIGN_KEY_VIOLATION',
            isRetryable: 'false'
          },
          level: 'error',
          extra: {
            connectionId: connection.id,
            projectId,
            source: connection.source,
            target: connection.target,
            errorCode: enhanced.code
          }
        });
        
        // 外键错误不加入重试队列
        return false;
      }
      
      // 根据错误类型选择日志级别
      if (enhanced.isRetryable) {
        this.logger.debug(`推送连接失败 (${enhanced.errorType})，已加入重试队列`, {
          message: enhanced.message,
          connectionId: connection.id
        });
      } else {
        this.logger.error('推送连接失败', {
          error: enhanced,
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          isRetryable: enhanced.isRetryable,
          errorType: enhanced.errorType
        });
      }
      
      Sentry.captureException(enhanced, {
        tags: { 
          operation: 'pushConnection',
          errorType: enhanced.errorType,
          isRetryable: String(enhanced.isRetryable)
        },
        level: enhanced.isRetryable ? 'info' : 'error',
        extra: {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target
        }
      });
      
      // 【关键修复】只有可重试的错误才加入重试队列
      if (enhanced.isRetryable) {
        this.addToRetryQueue('connection', 'upsert', connection, projectId);
      } else {
        this.logger.warn('不可重试的错误，不加入重试队列', {
          connectionId: connection.id,
          errorType: enhanced.errorType,
          message: enhanced.message
        });
      }
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
        
        // 【关键修复】清理连接超过最大重试次数的项
        // 防止无效连接永久占用队列空间
        items = items.filter((item: RetryQueueItem) => {
          if (item.type === 'connection' && item.retryCount >= this.MAX_RETRIES) {
            this.logger.debug('移除超过重试次数的连接', {
              connectionId: item.data.id,
              retryCount: item.retryCount
            });
            return false;
          }
          return true;
        });
        
        this.retryQueue = items;
        this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
        this.logger.info(`从存储恢复 ${this.retryQueue.length} 个待同步项`);
        
        // 【关键修复】异步清理无效连接（引用不存在的任务）
        // 在后台进行，不阻塞应用启动
        if (this.retryQueue.some(item => item.type === 'connection')) {
          this.cleanupInvalidConnections().catch(e => {
            this.logger.error('清理无效连接失败', e);
          });
        }
      }
    } catch (e) {
      this.logger.error('加载重试队列失败', e);
      localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
    }
  }
  
  /**
   * 异步清理重试队列中引用不存在任务的连接
   * 防止外键约束错误累积导致 localStorage 溢出
   * 
   * 【并发保护】检查同步状态，避免与 processRetryQueue 冲突
   */
  private async cleanupInvalidConnections(): Promise<void> {
    // 【并发保护】如果正在同步，跳过清理（避免竞态条件）
    if (this.state().isSyncing) {
      this.logger.debug('跳过无效连接清理（正在同步中）');
      return;
    }
    
    const client = this.getSupabaseClient();
    if (!client) return;
    
    const connectionItems = this.retryQueue.filter(item => item.type === 'connection');
    if (connectionItems.length === 0) return;
    
    try {
      // 批量查询所有引用的任务
      const allReferencedTaskIds = new Set<string>();
      for (const item of connectionItems) {
        const conn = item.data as Connection;
        allReferencedTaskIds.add(conn.source);
        allReferencedTaskIds.add(conn.target);
      }
      
      const { data: existingTasks } = await client
        .from('tasks')
        .select('id')
        .in('id', Array.from(allReferencedTaskIds))
        .is('deleted_at', null);
      
      const existingTaskIds = new Set((existingTasks || []).map(t => t.id));
      
      // 过滤掉引用不存在任务的连接
      const originalLength = this.retryQueue.length;
      this.retryQueue = this.retryQueue.filter(item => {
        if (item.type !== 'connection') return true;
        
        const conn = item.data as Connection;
        const sourceExists = existingTaskIds.has(conn.source);
        const targetExists = existingTaskIds.has(conn.target);
        
        if (!sourceExists || !targetExists) {
          this.logger.info('清理无效连接（引用的任务不存在）', {
            connectionId: conn.id,
            source: conn.source,
            target: conn.target,
            sourceExists,
            targetExists
          });
          return false;
        }
        return true;
      });
      
      const removedCount = originalLength - this.retryQueue.length;
      if (removedCount > 0) {
        this.logger.info(`清理了 ${removedCount} 个无效连接`);
        this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
        this.saveRetryQueueToStorage();
        
        Sentry.captureMessage('清理无效连接', {
          level: 'info',
          tags: { removedCount: String(removedCount) }
        });
      }
    } catch (e) {
      this.logger.error('批量查询任务存在性失败', e);
    }
  }
  
  /**
   * 精简 Task 数据，只保留同步必需的字段
   * 移除客户端临时字段以减少存储大小
   * 返回包含所有必需字段的对象，确保类型安全
   */
  private minifyTaskForStorage(task: Task): Task {
    // 返回精简版 Task，移除客户端临时字段
    return {
      id: task.id,
      title: task.title,
      content: task.content,
      stage: task.stage,
      parentId: task.parentId,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      createdDate: task.createdDate,
      updatedAt: task.updatedAt,
      displayId: task.displayId,
      shortId: task.shortId,
      deletedAt: task.deletedAt,
      // 显式排除大型客户端字段
      // deletedConnections: undefined,
      // deletedMeta: undefined,
      // attachments: undefined,
    };
  }
  
  /**
   * 精简 RetryQueueItem 数据用于存储
   */
  private minifyRetryItemForStorage(item: RetryQueueItem): RetryQueueItem {
    if (item.type === 'task' && item.operation === 'upsert') {
      return {
        ...item,
        data: this.minifyTaskForStorage(item.data as Task)
      };
    }
    return item;
  }
  
  /**
   * 将重试队列保存到 localStorage
   * 在队列变化时调用，防止页面刷新丢失
   * 
   * 【2024-12-31 修复】
   * - 精简存储数据，移除客户端临时字段
   * - QuotaExceeded 时主动缩减队列
   * - 添加存储大小检查
   * @param attempt 当前尝试次数，用于限制递归深度（最多 3 次）
   */
  private saveRetryQueueToStorage(attempt = 0): void {
    const MAX_SAVE_ATTEMPTS = 3;
    
    if (typeof localStorage === 'undefined') return;
    
    // 递归深度限制：防止栈溢出
    if (attempt >= MAX_SAVE_ATTEMPTS) {
      this.logger.error(`保存重试队列失败：超过最大尝试次数 ${MAX_SAVE_ATTEMPTS}，放弃保存`, {
        queueSize: this.retryQueue.length
      });
      Sentry.captureMessage('RetryQueue save failed: max attempts exceeded', {
        level: 'error',
        tags: { queueSize: String(this.retryQueue.length), attempts: String(attempt) }
      });
      return;
    }
    
    try {
      if (this.retryQueue.length === 0) {
        // 队列为空时删除存储
        localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
        return;
      }
      
      // 精简存储数据
      const minifiedItems = this.retryQueue.map(item => this.minifyRetryItemForStorage(item));
      
      const data = {
        version: this.RETRY_QUEUE_VERSION,
        items: minifiedItems,
        savedAt: Date.now()
      };
      
      const jsonStr = JSON.stringify(data);
      
      // 检查大小是否超限
      const sizeBytes = new Blob([jsonStr]).size;
      if (sizeBytes > this.RETRY_QUEUE_SIZE_LIMIT) {
        this.logger.warn('重试队列存储大小超限，开始缩减', {
          sizeBytes,
          limit: this.RETRY_QUEUE_SIZE_LIMIT,
          itemCount: this.retryQueue.length
        });
        this.shrinkRetryQueue();
        // 递归调用，使用缩减后的队列（传递尝试次数）
        this.saveRetryQueueToStorage(attempt + 1);
        return;
      }
      
      localStorage.setItem(this.RETRY_QUEUE_STORAGE_KEY, jsonStr);
      this.logger.debug(`保存 ${this.retryQueue.length} 个待同步项到存储 (${Math.round(sizeBytes / 1024)}KB)`);
    } catch (e) {
      // 处理 QuotaExceededError
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        this.logger.warn('localStorage 配额已满，缩减重试队列');
        Sentry.captureMessage('RetryQueue QuotaExceeded', {
          level: 'warning',
          tags: { queueSize: String(this.retryQueue.length) }
        });
        this.shrinkRetryQueue();
        // 递归调用，使用缩减后的队列（传递尝试次数）
        if (this.retryQueue.length > 0) {
          this.saveRetryQueueToStorage(attempt + 1);
        }
      } else {
        this.logger.error('保存重试队列失败', e);
      }
    }
  }
  
  /**
   * 缩减重试队列
   * 优先移除：1) 重试次数多的 2) 年龄老的 3) 数据大的
   */
  private shrinkRetryQueue(): void {
    const originalLength = this.retryQueue.length;
    
    // 策略1: 移除超过最大重试次数的项
    this.retryQueue = this.retryQueue.filter(item => item.retryCount < this.MAX_RETRIES);
    
    // 策略2: 如果还是太多，移除最老的一半
    if (this.retryQueue.length > this.MAX_RETRY_QUEUE_SIZE / 2) {
      // 按创建时间排序，保留较新的一半
      this.retryQueue.sort((a, b) => b.createdAt - a.createdAt);
      this.retryQueue = this.retryQueue.slice(0, Math.floor(this.MAX_RETRY_QUEUE_SIZE / 2));
    }
    
    // 策略3: 如果还有问题，移除 content 最大的 task 项
    if (this.retryQueue.length > 10) {
      // 按数据大小排序（估算）
      const sizeEstimate = (item: RetryQueueItem): number => {
        if (item.type === 'task') {
          const task = item.data as Task;
          return (task.content?.length || 0) + (task.title?.length || 0);
        }
        return 100; // 默认大小
      };
      
      // 移除最大的 20%
      this.retryQueue.sort((a, b) => sizeEstimate(a) - sizeEstimate(b));
      this.retryQueue = this.retryQueue.slice(0, Math.floor(this.retryQueue.length * 0.8));
    }
    
    const removedCount = originalLength - this.retryQueue.length;
    if (removedCount > 0) {
      this.logger.info(`缩减重试队列: 移除 ${removedCount} 项，剩余 ${this.retryQueue.length} 项`);
      this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
      
      Sentry.captureMessage('RetryQueue shrunk due to quota', {
        level: 'info',
        tags: {
          removedCount: String(removedCount),
          remainingCount: String(this.retryQueue.length)
        }
      });
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
    // 【Critical #17】会话过期检查 - 暂停重试队列处理，等待重新登录
    if (this.syncState().sessionExpired) {
      this.logger.info('会话已过期，暂停重试队列处理，等待重新登录');
      return;
    }
    
    if (this.state().isSyncing || !this.state().isOnline) return;
    
    this.state.update(s => ({ ...s, isSyncing: true }));
    
    const itemsToProcess = [...this.retryQueue];
    this.retryQueue = [];
    
    // 【关键修复】按类型排序：project → task → connection
    const sortedItems = itemsToProcess.sort((a, b) => {
      const order = { project: 0, task: 1, connection: 2 };
      return order[a.type] - order[b.type];
    });
    
    // 【性能优化 v2026-01】批量过滤已在 tombstone 中的任务和连接
    // 避免在 pushTask/pushConnection 中逐个查询 tombstones
    let filteredItems = sortedItems;
    const client = this.getSupabaseClient();
    if (client) {
      try {
        // 收集所有需要检查的任务和连接ID
        const taskIdsToCheck = new Set<string>();
        const connectionIdsToCheck = new Set<string>();
        const projectIds = new Set<string>();
        
        for (const item of sortedItems) {
          if (item.type === 'task' && item.operation === 'upsert') {
            taskIdsToCheck.add(item.data.id);
            if (item.projectId) projectIds.add(item.projectId);
          } else if (item.type === 'connection' && item.operation === 'upsert') {
            connectionIdsToCheck.add(item.data.id);
            if (item.projectId) projectIds.add(item.projectId);
          }
        }
        
        // 批量查询 tombstones（按项目）
        const allTaskTombstones = new Set<string>();
        const allConnectionTombstones = new Set<string>();
        
        for (const projectId of projectIds) {
          if (taskIdsToCheck.size > 0) {
            const taskTombstones = await this.getTombstoneIds(projectId);
            for (const id of taskTombstones) {
              allTaskTombstones.add(id);
            }
          }
          if (connectionIdsToCheck.size > 0) {
            const connTombstones = await this.getConnectionTombstoneIds(projectId);
            for (const id of connTombstones) {
              allConnectionTombstones.add(id);
            }
          }
        }
        
        // 过滤掉 tombstone 中的项
        filteredItems = sortedItems.filter(item => {
          if (item.type === 'task' && item.operation === 'upsert') {
            if (allTaskTombstones.has(item.data.id)) {
              this.logger.info('processRetryQueue: 跳过 tombstone 任务', { taskId: item.data.id });
              return false;
            }
          } else if (item.type === 'connection' && item.operation === 'upsert') {
            if (allConnectionTombstones.has(item.data.id)) {
              this.logger.info('processRetryQueue: 跳过 tombstone 连接', { connectionId: item.data.id });
              return false;
            }
          }
          return true;
        });
        
        if (filteredItems.length < sortedItems.length) {
          this.logger.info('processRetryQueue: 过滤了 tombstone 项', {
            original: sortedItems.length,
            filtered: filteredItems.length
          });
        }
      } catch (e) {
        this.logger.warn('processRetryQueue: 批量查询 tombstones 失败，依赖单独检查', e);
        // 【关键】失败时不跳过单独检查，让 pushTask/pushConnection 执行 tombstone 验证
        Sentry.captureException(e, {
          level: 'warning',
          tags: { operation: 'processRetryQueue', phase: 'batch_tombstone_filter' },
          extra: { itemCount: sortedItems.length }
        });
      }
    }
    
    // 【防御层 #2】追踪批量过滤是否成功
    const batchFilterSucceeded = filteredItems !== sortedItems;
    
    // 【关键修复】追踪本批次尝试同步的任务 ID
    const taskIdsInBatch = new Set<string>(
      filteredItems
        .filter(item => item.type === 'task' && item.operation === 'upsert')
        .map(item => item.data.id)
    );
    
    // 【关键修复】追踪成功推送的任务 ID
    const successfulTaskIds = new Set<string>();
    
    // 【性能优化】批量查询所有连接引用的任务是否存在
    const connectionItems = filteredItems.filter(item => item.type === 'connection');
    const allReferencedTaskIds = new Set<string>();
    for (const item of connectionItems) {
      const conn = item.data as Connection;
      allReferencedTaskIds.add(conn.source);
      allReferencedTaskIds.add(conn.target);
    }
    
    // 批量查询数据库中存在的任务 ID（带超时保护）
    let existingTaskIdsInDb = new Set<string>();
    if (allReferencedTaskIds.size > 0) {
      const client = this.getSupabaseClient();
      if (client) {
        try {
          // 5秒超时保护
          const queryPromise = client
            .from('tasks')
            .select('id')
            .in('id', Array.from(allReferencedTaskIds));
          
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Query timeout')), 5000)
          );
          
          const { data: existingTasks } = await Promise.race([
            queryPromise,
            timeoutPromise
          ]);
          
          existingTaskIdsInDb = new Set((existingTasks || []).map(t => t.id));
          
          this.logger.debug('批量查询任务存在性完成', {
            queried: allReferencedTaskIds.size,
            found: existingTaskIdsInDb.size
          });
        } catch (e) {
          this.logger.error('批量查询任务存在性失败', e);
          // 查询失败时使用空集合，所有连接都会被跳过
        }
      }
    }
    
    for (const item of filteredItems) {
      let success = false;
      
      try {
        if (item.type === 'task') {
          if (item.operation === 'upsert') {
            // 仅当批量过滤成功时才跳过单独 tombstone 检查
            success = await this.pushTask(item.data as Task, item.projectId!, batchFilterSucceeded);
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
          
          // 1. 检查引用的任务是否在本批次中失败
          const sourceFailed = taskIdsInBatch.has(conn.source) && !successfulTaskIds.has(conn.source);
          const targetFailed = taskIdsInBatch.has(conn.target) && !successfulTaskIds.has(conn.target);
          
          if (sourceFailed || targetFailed) {
            this.logger.warn('跳过连接重试（引用的任务在本批次中失败）', {
              connectionId: conn.id,
              source: conn.source,
              target: conn.target,
              sourceFailed,
              targetFailed
            });
            // 仍然加回队列，等待下次重试
            item.retryCount++;
            if (item.retryCount < this.MAX_RETRIES) {
              this.retryQueue.push(item);
            }
            continue;
          }
          
          // 2. 【关键增强】使用批量查询结果验证任务存在性
          const sourceExists = successfulTaskIds.has(conn.source) || existingTaskIdsInDb.has(conn.source);
          const targetExists = successfulTaskIds.has(conn.target) || existingTaskIdsInDb.has(conn.target);
          
          if (!sourceExists || !targetExists) {
            this.logger.warn('跳过连接重试（引用的任务不存在）', {
              connectionId: conn.id,
              source: conn.source,
              target: conn.target,
              sourceExists,
              targetExists
            });
            
            // 任务不存在，增加重试次数但仍然保留
            // 任务可能稍后被其他设备同步过来
            item.retryCount++;
            if (item.retryCount < this.MAX_RETRIES) {
              this.retryQueue.push(item);
            } else {
              // 超过最大重试次数，记录错误并丢弃
              this.logger.error('连接引用的任务持续不存在，已丢弃', {
                connectionId: conn.id,
                source: conn.source,
                target: conn.target
              });
              Sentry.captureMessage('连接引用的任务不存在', {
                level: 'warning',
                tags: { operation: 'processRetryQueue' },
                extra: {
                  connectionId: conn.id,
                  source: conn.source,
                  target: conn.target,
                  projectId: item.projectId
                }
              });
            }
            continue;
          }
          
          // 仅当批量过滤成功时才跳过单独 tombstone 检查
          // skipTaskExistenceCheck=true: 已通过 existingTaskIdsInDb 批量验证任务存在性
          success = await this.pushConnection(conn, item.projectId!, batchFilterSucceeded, true);
        }
      } catch (e) {
        // 【关键修复】检查是否为永久失败（如版本冲突、会话过期）
        if (isPermanentFailureError(e)) {
          this.logger.warn('检测到永久失败，移除队列项', {
            type: item.type,
            id: item.data.id,
            error: e.getFullMessage(),
            context: e.context,
            stack: e.stack
          });
          continue; // 跳过，不加回队列
        }
        
        this.logger.error('重试失败', e);
        Sentry.captureException(e, { tags: { operation: 'retryQueue', type: item.type } });
        // 检查是否为不可重试的错误
        const enhanced = supabaseErrorToError(e);
        if (!enhanced.isRetryable) {
          // 不可重试的错误（如数据验证错误），直接丢弃
          this.logger.warn('检测到不可重试错误，移除队列项', {
            type: item.type,
            id: item.data.id,
            errorType: enhanced.errorType,
            message: enhanced.message
          });
          continue; // 跳过，不加回队列
        }
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
  
  /**
   * 拓扑排序任务，确保父任务在子任务之前
   * 防止推送时违反外键约束 tasks_parent_id_fkey
   */
  private topologicalSortTasks(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      
      const task = taskMap.get(taskId);
      if (!task) return;
      
      // 检测循环依赖：断开循环但仍然添加任务
      if (visiting.has(taskId)) {
        this.logger.warn('检测到任务循环依赖，断开循环', { taskId });
        // 标记为已访问，但不再继续递归，防止无限循环
        // 任务会在外层循环中被添加
        return;
      }
      
      visiting.add(taskId);
      
      // 先访问父任务
      if (task.parentId && taskMap.has(task.parentId)) {
        visit(task.parentId);
      }
      
      visiting.delete(taskId);
      visited.add(taskId);
      sorted.push(task);
    };
    
    // 访问所有任务
    for (const task of tasks) {
      visit(task.id);
    }
    
    this.logger.debug('拓扑排序完成', {
      original: tasks.length,
      sorted: sorted.length
    });
    
    return sorted;
  }
  
  // ==================== 数据转换 ====================
  
  /**
   * 数据库行转换为 Task 模型
   * 使用 TaskRow 类型确保类型安全
   * 
   * 【流量优化】支持不包含 content 的行（列表查询时不加载 content）
   */
  private rowToTask(row: TaskRow | Partial<TaskRow>): Task {
    return {
      id: row.id || '',
      title: row.title || '',
      // 【流量优化】content 可能不存在（列表查询不加载）
      // 不存在时设为 undefined，由调用方按需加载
      content: row.content ?? '',
      stage: row.stage ?? null,
      parentId: row.parent_id ?? null,
      order: row.order || 0,
      rank: row.rank || 0,
      status: (row.status as 'active' | 'completed' | 'archived') || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at || '',
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
  private rowToProject(row: ProjectRow | Partial<ProjectRow>): Project {
    return {
      id: row.id || '',
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
  
  // ==================== Realtime 订阅 / 轮询 ====================
  
  /**
   * 设置远程变更回调
   */
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.onRemoteChangeCallback = callback;
  }

  /**
   * 设置用户偏好变更回调（Realtime）
   * 由 PreferenceService 注册，用于跨端即时更新偏好信号。
   */
  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.onUserPreferencesChangeCallback = callback;
  }
  
  /**
   * 启用/禁用 Realtime（运行时切换）
   * 
   * 【流量优化】允许用户在设置中手动启用 Realtime
   * 默认禁用以节省流量
   */
  setRealtimeEnabled(enabled: boolean): void {
    this.isRealtimeEnabled.set(enabled);
    
    // 如果有当前项目，重新订阅
    if (this.currentProjectId) {
      const projectId = this.currentProjectId;
      this.unsubscribeFromProject().then(() => {
        this.subscribeToProject(projectId, '');
      });
    }
    
    this.logger.info(`Realtime ${enabled ? '已启用' : '已禁用，使用轮询'}`);
  }
  
  /**
   * 订阅项目变更（自动选择 Realtime 或轮询）
   * 
   * 【流量优化】
   * - 默认使用轮询，节省 WebSocket 流量
   * - 可通过 setRealtimeEnabled(true) 启用 Realtime
   */
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    // 先取消旧订阅/轮询
    await this.unsubscribeFromProject();
    
    this.currentProjectId = projectId;
    
    if (this.isRealtimeEnabled()) {
      // 使用 Realtime（需要用户手动启用）
      await this.subscribeToProjectRealtime(projectId, userId);
    } else {
      // 使用轮询（默认，节省流量）
      this.startPolling(projectId);
    }
  }
  
  /**
   * 启动轮询（替代 Realtime）
   * 
   * 【流量优化】
   * - 用户活跃时：每 15 秒轮询一次
   * - 用户不活跃时：每 30 秒轮询一次
   */
  private startPolling(projectId: string): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }
    
    this.logger.info('启动轮询同步', { projectId, interval: SYNC_CONFIG.POLLING_INTERVAL });
    
    const poll = async () => {
      if (!this.syncState().isOnline || this.realtimePaused) return;
      
      try {
        // 触发远程变更回调
        if (this.onRemoteChangeCallback) {
          await this.onRemoteChangeCallback({ 
            eventType: 'polling', 
            projectId 
          });
        }
      } catch (e) {
        this.logger.debug('轮询检查失败', e);
      }
    };
    
    // 动态轮询间隔
    const getPollingInterval = () => 
      this.isUserActive ? SYNC_CONFIG.POLLING_ACTIVE_INTERVAL : SYNC_CONFIG.POLLING_INTERVAL;
    
    // 使用动态间隔的轮询
    const scheduleNextPoll = () => {
      this.pollingTimer = setTimeout(async () => {
        await poll();
        scheduleNextPoll();
      }, getPollingInterval());
    };
    
    // 启动轮询（首次立即执行）
    poll().then(() => scheduleNextPoll());
  }
  
  /**
   * 停止轮询
   * 注意：使用 clearTimeout 因为 scheduleNextPoll 使用递归 setTimeout
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }
  
  /**
   * 订阅项目实时变更（Realtime 模式）
   * 仅在用户手动启用时使用
   * 
   * 【P2 优化】重连后自动触发增量同步
   * 【Stingy Hoarder Protocol】增强安全校验 + 降级逻辑
   * @see docs/plan_save.md Phase 4
   */
  private async subscribeToProjectRealtime(projectId: string, userId: string): Promise<void> {
    const client = this.getSupabaseClient();
    if (!client) return;
    
    const channelName = `project:${projectId}:${userId.substring(0, 8)}`;
    
    this.logger.info('启用 Realtime 订阅', { projectId, channel: channelName });
    
    // 追踪之前的连接状态，用于检测重连
    let previousStatus: string | null = null;
    // 连续错误计数（用于降级到轮询）
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    
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
          // 🔒 二次校验：确保收到的数据属于当前用户（防御性编程）
          // RLS 应该已经过滤，但作为多层防御
          const taskData = payload.new as { user_id?: string; project_id?: string } | undefined;
          if (taskData && taskData.project_id !== projectId) {
            Sentry.captureMessage('Realtime 收到非当前项目数据', { 
              level: 'warning',
              extra: { receivedProjectId: taskData.project_id, expectedProjectId: projectId }
            });
            return; // 静默丢弃
          }
          
          // 🔒 二次校验：确保 user_id 匹配当前用户（如果数据包含该字段）
          if (taskData?.user_id && taskData.user_id !== userId) {
            Sentry.captureMessage('Realtime 收到非本用户数据', { 
              level: 'error',
              extra: { receivedUserId: taskData.user_id, expectedUserId: userId }
            });
            return; // 静默丢弃
          }
          
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
          // 🔒 二次校验
          const connData = payload.new as { project_id?: string } | undefined;
          if (connData && connData.project_id !== projectId) {
            Sentry.captureMessage('Realtime 收到非当前项目连接数据', { 
              level: 'warning',
              extra: { receivedProjectId: connData.project_id, expectedProjectId: projectId }
            });
            return;
          }
          
          this.logger.debug('收到连接变更', { event: payload.eventType });
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
          table: 'user_preferences',
          filter: userId ? `user_id=eq.${userId}` : undefined
        },
        (payload) => {
          // 偏好不属于项目维度，不走 onRemoteChangeCallback（避免触发项目级 reload）
          this.logger.debug('收到用户偏好变更', { event: payload.eventType });
          if (this.onUserPreferencesChangeCallback && !this.realtimePaused && userId) {
            this.onUserPreferencesChangeCallback({
              eventType: payload.eventType,
              userId
            });
          }
        }
      )
      .subscribe((status, err) => {
        this.logger.info('Realtime 订阅状态', { status, channel: channelName, previousStatus });
        
        // 处理错误状态 - 降级到轮询
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          consecutiveErrors++;
          Sentry.captureMessage('Realtime 订阅错误', { 
            level: 'warning',
            extra: { 
              status, 
              error: err?.message,
              consecutiveErrors,
              channel: channelName
            }
          });
          
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.logger.warn('Realtime 连续失败，降级到轮询', { consecutiveErrors });
            this.fallbackToPolling(projectId);
            return;
          }
        } else if (status === 'SUBSCRIBED') {
          // 重置错误计数
          consecutiveErrors = 0;
        }
        
        // 【P2 优化】检测重连：从非 SUBSCRIBED 状态恢复到 SUBSCRIBED
        if (status === 'SUBSCRIBED' && previousStatus && previousStatus !== 'SUBSCRIBED') {
          this.logger.info('Realtime 重连成功，触发增量同步', { previousStatus });
          
          // 异步触发增量同步
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            // 使用 'reconnect' 事件类型表明这是重连后的同步
            this.onRemoteChangeCallback({ 
              eventType: 'reconnect', 
              projectId 
            }).catch(e => {
              this.logger.warn('重连后增量同步失败', e);
            });
          }
        }
        
        previousStatus = status;
      });
  }

  /**
   * Realtime 降级到轮询
   * 当 Realtime 连续失败时调用
   */
  private fallbackToPolling(projectId: string): void {
    this.logger.info('Realtime 降级到轮询模式', { projectId });
    
    // 取消 Realtime 订阅
    if (this.realtimeChannel) {
      const client = this.getSupabaseClient();
      if (client) {
        client.removeChannel(this.realtimeChannel).catch(() => {
          // 忽略取消订阅时的错误
        });
      }
      this.realtimeChannel = null;
    }
    
    // 启动轮询
    this.startPolling(projectId);
    
    // 发送 Toast 通知用户
    this.toast.info('实时同步暂不可用', '已切换到定时同步模式');
  }
  
  /**
   * 取消订阅（同时停止轮询和 Realtime）
   */
  async unsubscribeFromProject(): Promise<void> {
    this.currentProjectId = null;
    
    // 停止轮询
    this.stopPolling();
    
    // 取消 Realtime 订阅
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
   * 
   * 【流量优化】只查询必要字段
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      // 【流量优化】只查询必要字段
      const { data, error } = await client
        .from('user_preferences')
        .select('theme,layout_direction,floating_window_pref')
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

  // ============================================================
  // 【Stingy Hoarder Protocol】Delta Sync 增量同步
  // @see docs/plan_save.md Phase 3
  // ============================================================

  /**
   * Delta Sync 增量检查
   * 
   * 检查服务端是否有自上次同步以来的新变更
   * 只拉取 updated_at > lastSyncTime 的记录
   * 
   * 【核心优化】
   * - 从 MB 级全量拉取降至 ~800 Bytes - 1.5 KB 增量检查
   * - 使用 Sentry Span 追踪性能
   * 
   * @param projectId 项目 ID
   * @returns 增量变更数据，若无变更则返回空数组
   */
  async checkForDrift(projectId: string): Promise<{ tasks: Task[]; connections: Connection[] }> {
    const client = this.getSupabaseClient();
    if (!client) {
      return { tasks: [], connections: [] };
    }

    // 如果 Delta Sync 未启用，返回空结果
    if (!SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      this.logger.debug('Delta Sync 未启用，跳过增量检查');
      return { tasks: [], connections: [] };
    }

    // 【ClockSync 集成】确保时钟同步，防止时间漂移导致 LWW 判断错误
    // @see docs/plan_save.md Phase 3
    try {
      const clockResult = await this.clockSync.ensureSynced();
      if (clockResult.status === 'error') {
        // 时钟严重偏移，记录警告但继续同步
        this.logger.warn('时钟偏移严重，Delta Sync 可能不准确', {
          driftMs: clockResult.driftMs,
          reliable: clockResult.reliable
        });
        
        Sentry.captureMessage('Clock drift may affect Delta Sync', {
          level: 'warning',
          tags: {
            operation: 'checkForDrift',
            clockDriftMs: String(clockResult.driftMs),
            projectId
          }
        });
      } else if (clockResult.status === 'warning') {
        this.logger.debug('时钟有轻微偏移', { driftMs: clockResult.driftMs });
      }
    } catch (clockErr) {
      // 时钟同步失败不应阻塞 Delta Sync
      this.logger.debug('时钟同步检测失败，继续 Delta Sync', clockErr);
    }

    // 获取时钟偏移值用于 Span 属性
    const clockDriftMs = this.clockSync.currentDriftMs();
    const clockStatus = this.clockSync.driftStatus();

    return await Sentry.startSpan(
      {
        name: 'sync-drift-check',
        op: 'sync.delta',
        attributes: {
          projectId,
          'clock.drift_ms': clockDriftMs,
          'clock.status': clockStatus,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (span: any) => {
        try {
          // 获取上次同步时间
          const lastSyncTime = this.lastSyncTimeByProject.get(projectId);
          
          if (!lastSyncTime) {
            // 首次同步，需要全量拉取
            this.logger.debug('首次同步，需要全量拉取', { projectId });
            span.setAttribute('sync_type', 'full');
            return { tasks: [], connections: [] };
          }

          this.logger.debug('开始 Delta Sync 增量检查', { 
            projectId, 
            lastSyncTime 
          });

          // 并行查询增量数据
          const [tasksResult, connectionsResult] = await Promise.all([
            client
              .from('tasks')
              .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)
              .eq('project_id', projectId)
              .gt('updated_at', lastSyncTime)
              .order('updated_at', { ascending: true }),
            client
              .from('connections')
              .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
              .eq('project_id', projectId)
              .gt('updated_at', lastSyncTime)
              .order('updated_at', { ascending: true })
          ]);

          if (tasksResult.error) {
            throw supabaseErrorToError(tasksResult.error);
          }
          if (connectionsResult.error) {
            throw supabaseErrorToError(connectionsResult.error);
          }

          const deltaTasks = (tasksResult.data || []) as unknown as Task[];
          const deltaConnections = (connectionsResult.data || []) as unknown as Connection[];

          // 更新 Span 属性
          span.setAttribute('tasks_synced', deltaTasks.length);
          span.setAttribute('connections_synced', deltaConnections.length);
          span.setStatus({ code: 1 }); // OK

          // 过滤已删除的记录（客户端二次过滤）
          const activeTasks = deltaTasks.filter(t => !t.deletedAt);
          const activeConnections = deltaConnections.filter(c => !c.deletedAt);

          // 更新同步时间
          const now = nowISO();
          this.lastSyncTimeByProject.set(projectId, now);

          if (deltaTasks.length > 0 || deltaConnections.length > 0) {
            this.logger.info('Delta Sync 发现变更', {
              projectId,
              taskChanges: deltaTasks.length,
              connectionChanges: deltaConnections.length,
              activeTaskChanges: activeTasks.length,
              activeConnectionChanges: activeConnections.length
            });
          } else {
            this.logger.debug('Delta Sync 无变更', { projectId });
          }

          return {
            tasks: activeTasks,
            connections: activeConnections
          };
        } catch (err) {
          span.setStatus({ code: 2, message: 'sync_failed' }); // ERROR
          
          const enhancedError = err instanceof Error 
            ? supabaseErrorToError(err) 
            : supabaseErrorToError(new Error(String(err)));

          Sentry.captureException(enhancedError, {
            tags: { 
              context: 'sync-drift-check',
              projectId 
            },
          });

          this.logger.error('Delta Sync 检查失败', { projectId, error: err });
          throw err;
        }
      }
    );
  }

  /**
   * 设置项目的最后同步时间
   * 用于 Delta Sync 增量计算
   */
  setLastSyncTime(projectId: string, timestamp: string): void {
    this.lastSyncTimeByProject.set(projectId, timestamp);
    this.logger.debug('更新同步时间戳', { projectId, timestamp });
  }

  /**
   * 获取项目的最后同步时间
   */
  getLastSyncTime(projectId: string): string | null {
    return this.lastSyncTimeByProject.get(projectId) || null;
  }

  /**
   * 清除项目的同步时间（强制下次全量同步）
   */
  clearLastSyncTime(projectId: string): void {
    this.lastSyncTimeByProject.delete(projectId);
    this.logger.debug('清除同步时间戳', { projectId });
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
   * 【P0 熔断层】推送前进行熔断校验，检测空数据、任务数骤降等异常
   */
  async saveProjectToCloud(
    project: Project,
    _userId: string
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    // 【Stingy Hoarder Protocol】Phase 4.5 - 网络感知检查
    // 在弱网或节省流量模式下，将同步操作加入队列而非立即执行
    // @see docs/plan_save.md Phase 4.5
    if (!this.mobileSync.shouldAllowSync()) {
      const strategy = this.mobileSync.currentStrategy();
      this.logger.debug('网络感知: 同步被延迟', {
        projectId: project.id,
        strategy
      });
      // 加入重试队列，等待网络恢复
      this.addToRetryQueue('project', 'upsert', project);
      return { success: false };
    }

    // 【P0 熔断层】同步前校验 - 检测空数据、任务数骤降、必填字段缺失
    const circuitValidation = this.circuitBreaker.validateBeforeSync(project);
    if (!circuitValidation.passed && circuitValidation.shouldBlock) {
      this.logger.error('熔断: 同步被阻止', {
        projectId: project.id,
        level: circuitValidation.level,
        violations: circuitValidation.violations
      });
      Sentry.captureMessage('CircuitBreaker: Sync blocked in saveProjectToCloud', {
        level: 'error',
        tags: { 
          operation: 'saveProjectToCloud',
          projectId: project.id,
          level: circuitValidation.level
        },
        extra: {
          passed: circuitValidation.passed,
          level: circuitValidation.level,
          severity: circuitValidation.severity,
          shouldBlock: circuitValidation.shouldBlock,
          suggestedAction: circuitValidation.suggestedAction,
          violations: circuitValidation.violations,
        }
      });
      // 熔断时不将数据加入重试队列，需要用户确认后才能继续
      return { success: false };
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.addToRetryQueue('project', 'upsert', project);
      return { success: false };
    }
    
    // 【性能优化】在批量操作开始前进行一次 session 验证
    // 避免在每个 pushTask/pushConnection 中重复检查（40+ 次 → 1 次）
    try {
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        this.syncState.update(s => ({ ...s, sessionExpired: true }));
        this.logger.warn('批量推送前检测到会话丢失', { projectId: project.id, operation: 'saveProjectToCloud' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return { success: false };
      }
    } catch (e) {
      this.logger.error('Session 验证失败', e);
      this.syncState.update(s => ({ ...s, sessionExpired: true }));
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
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
      // 【关键修复】拓扑排序确保父任务在子任务之前推送，防止外键约束违反
      const sortedTasks = this.topologicalSortTasks(tasksToSync);
      
      // 【关键修复】收集成功推送的任务 ID，用于后续连接验证
      const successfulTaskIds = new Set<string>();
      for (let i = 0; i < sortedTasks.length; i++) {
        if (i > 0) {
          // 【优化 v2026-01】增加到200ms，降低后端累积压力，减少504超时
          await this.delay(200);
        }
        // skipTombstoneCheck=true: 已在上方通过 getTombstoneIds 批量过滤
        try {
          const success = await this.pushTask(sortedTasks[i], project.id, true);
          if (success) {
            successfulTaskIds.add(sortedTasks[i].id);
          }
        } catch (e) {
          // 【Critical】永久失败（版本冲突、会话过期）不应中断整个批量同步
          if (isPermanentFailureError(e)) {
            this.logger.warn('跳过永久失败的任务，继续批量同步', {
              taskId: sortedTasks[i].id,
              error: e.getFullMessage(),
              context: e.context
            });
            // 不加入成功集合，继续下一个任务
            continue;
          }
          // 非永久失败的错误，重新抛出（会话初始化失败等）
          throw e;
        }
      }
      
      // 3. 批量保存连接（请求间延迟 100ms 防止速率限制）
      // 【性能优化 v2026-01】批量获取连接 tombstones，避免 pushConnection 中的逐个查询
      const connectionTombstoneIds = await this.getConnectionTombstoneIds(project.id);
      
      // 【修复数据漂移】过滤软删除的连接，与远程查询逻辑保持一致
      // 【关键修复】过滤引用未同步成功任务的连接，防止外键约束违反
      // 【P0 防复活】过滤已在 tombstone 中的连接
      const connectionsToSync = project.connections.filter(conn => {
        if (conn.deletedAt) return false;
        if (connectionTombstoneIds.has(conn.id)) {
          this.logger.info('saveProjectToCloud: 跳过 tombstone 连接', { connectionId: conn.id });
          return false;
        }
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
        this.logger.info('saveProjectToCloud: 过滤了软删除/tombstone 连接', {
          original: project.connections.length,
          filtered: connectionsToSync.length,
          tombstoneCount: connectionTombstoneIds.size
        });
      }
      
      for (let i = 0; i < connectionsToSync.length; i++) {
        if (i > 0) {
          // 【优化 v2026-01】增加到200ms，降低后端累积压力，减少504超时
          await this.delay(200);
        }
        // skipTombstoneCheck=true: 已在上方通过 getConnectionTombstoneIds 批量过滤
        // skipTaskExistenceCheck=true: 已在上方通过 successfulTaskIds 验证任务同步成功
        try {
          await this.pushConnection(connectionsToSync[i], project.id, true, true);
        } catch (e) {
          // 【Critical】永久失败（版本冲突、会话过期）不应中断整个批量同步
          if (isPermanentFailureError(e)) {
            this.logger.warn('跳过永久失败的连接，继续批量同步', {
              connectionId: connectionsToSync[i].id,
              error: e.getFullMessage(),
              context: e.context
            });
            // 继续下一个连接
            continue;
          }
          // 非永久失败的错误，重新抛出（会话初始化失败等）
          throw e;
        }
      }
      
      this.syncState.update(s => ({
        ...s,
        isSyncing: false,
        lastSyncTime: nowISO()
      }));
      
      // 【数据漂移检测】来自高级顾问建议
      // 每 50 次同步检查本地和远程行数差异，上报 Sentry 警告
      // 【修复】使用过滤后的连接数，与远程查询逻辑保持一致
      // 【修复数据漂移误报】过滤软删除任务，与远程查询 `deleted_at IS NULL` 一致
      this.syncCounter++;
      if (this.syncCounter % 50 === 0) {
        const activeTasksCount = tasksToSync.filter(t => !t.deletedAt).length;
        this.checkDataDrift(project.id, activeTasksCount, connectionsToSync.length);
      }
      
      // 【P0 熔断层】同步成功后更新已知任务数量（用于下次骤降检测）
      this.circuitBreaker.updateLastKnownTaskCount(project.id, tasksToSync.length);
      
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
          // 【流量优化】使用字段筛选替代 SELECT *
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('id', projectId)
            .single();
          if (error) throw error;
          return data;
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
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
          // 【流量优化】使用字段筛选替代 SELECT *
          const { data } = await client
            .from('connections')
            .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
            .eq('project_id', projectId);
          return data || [];
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
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
    
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Loading tasks with tombstones',
      level: 'info',
      data: { projectId }
    });
    
    // 【修复】移除嵌套 throttle 调用，避免超时叠加和并发槽位浪费
    // 每个查询独立通过 throttle 包装，使用 BATCH_SYNC_TIMEOUT (90秒)
    // 【流量优化】使用字段筛选替代 SELECT *，不含 content 字段节省 60-70% 流量
    const tasksResult = await this.throttle.execute(
      `tasks-data:${projectId}`,
      async () => {
        return await client
          .from('tasks')
          .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)
          .eq('project_id', projectId);
      },
      { 
        deduplicate: true,
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
      }
    );
    
    // 【流量优化】使用 Tombstone 缓存避免重复查询
    const tombstonesResult = await this.getTombstonesWithCache(projectId, client);
    
    if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
    
    const tasksCount = (tasksResult.data as TaskRow[] || []).length;
    const tombstonesCount = (tombstonesResult.data || []).length;
    
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
    
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Tasks loaded successfully',
      level: 'info',
      data: { 
        projectId, 
        tasksCount, 
        tombstonesCount,
        totalCount: allTasks.length,
        tombstoneCount: tombstoneIds.size,
        deletedCount 
      }
    });
    
    if (tombstoneIds.size > 0 || deletedCount > 0) {
      this.logger.info(`任务同步信息`, {
        projectId,
        totalCount: allTasks.length,
        tombstoneCount: tombstoneIds.size,
        softDeletedCount: deletedCount - tombstoneIds.size
      });
    }
    
    return markedTasks;
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
  
  // 使用配置中的缓存键，确保全局一致
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  private readonly CACHE_VERSION = CACHE_CONFIG.CACHE_VERSION;
  
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
   * 
   * 【流量优化】使用字段筛选
   */
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    this.isLoadingRemote.set(true);
    
    try {
      // 1. 先加载项目列表（单个请求）
      // 【流量优化】使用字段筛选替代 SELECT *
      const projectList = await this.throttle.execute(
        `project-list:${userId}`,
        async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('owner_id', userId)
            .order('updated_at', { ascending: false });
          
          if (error) throw supabaseErrorToError(error);
          return data || [];
        },
        { 
          deduplicate: true, 
          priority: 'high',
          // 【修复】增加超时时间和重试次数，防止在网络拥堵或队列积压时加载失败
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT, 
          retries: 5 
        }
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
