import { Injectable, inject, signal, DestroyRef, effect, computed } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
import { Project, Task, UserPreferences } from '../models';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { extractErrorMessage } from '../utils/result';
import * as Sentry from '@sentry/angular';

// ========== IndexedDB 备份支持 ==========
const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
const QUEUE_BACKUP_DB_VERSION = 1;
const QUEUE_BACKUP_STORE_NAME = 'queue-backup';

/**
 * 操作重要性级别
 * Level 1: 日志/埋点类 - 失败后 FIFO 丢弃，无提示
 * Level 2: 重要但可补救的数据 - 失败进入死信队列，有容量和清理策略
 * Level 3: 关键操作 - 失败次数超阈值触发用户提示
 */
export type OperationPriority = 'low' | 'normal' | 'critical';

/**
 * 操作有效载荷类型
 * 根据实体类型和操作类型定义具体的载荷结构
 */
export type ActionPayload = 
  | ProjectPayload
  | ProjectDeletePayload
  | TaskPayload
  | TaskDeletePayload
  | PreferencePayload;

export interface ProjectPayload {
  project: Project;
}

export interface ProjectDeletePayload {
  projectId: string;
  userId: string;
}

export interface TaskPayload {
  task: Task;
  projectId: string;
}

export interface TaskDeletePayload {
  taskId: string;
  projectId: string;
}

export interface PreferencePayload {
  preferences: Partial<UserPreferences>;
  userId: string;
}

/**
 * 操作队列项
 */
export interface QueuedAction<T extends ActionPayload = ActionPayload> {
  id: string;
  type: 'create' | 'update' | 'delete';
  entityType: 'project' | 'task' | 'preference';
  entityId: string;
  payload: T;
  timestamp: number;
  retryCount: number;
  lastError?: string;
  /** 错误类型：network=网络错误可重试，business=业务错误不可重试，timeout=超时，unknown=未知错误 */
  errorType?: 'network' | 'business' | 'timeout' | 'unknown';
  /** 操作优先级：决定失败后的处理策略 */
  priority?: OperationPriority;
}

/**
 * 类型安全的操作入队参数
 */
export type EnqueueParams = 
  | { type: 'create' | 'update'; entityType: 'project'; entityId: string; payload: ProjectPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'project'; entityId: string; payload: ProjectDeletePayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'task'; entityId: string; payload: TaskPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'task'; entityId: string; payload: TaskDeletePayload; priority?: OperationPriority }
  | { type: 'create' | 'update' | 'delete'; entityType: 'preference'; entityId: string; payload: PreferencePayload; priority?: OperationPriority };

/**
 * 死信队列项 - 永久失败的操作
 */
export interface DeadLetterItem {
  action: QueuedAction;
  failedAt: string;
  reason: string;
}

/**
 * 操作队列配置
 */
const LOCAL_QUEUE_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 5,
  /** 重试延迟基数（毫秒） */
  RETRY_BASE_DELAY: QUEUE_CONFIG.RETRY_BASE_DELAY,
  /** 队列存储键 */
  QUEUE_STORAGE_KEY: 'nanoflow.action-queue',
  /** 死信队列存储键 */
  DEAD_LETTER_STORAGE_KEY: 'nanoflow.dead-letter-queue',
  /** 最大队列大小 */
  MAX_QUEUE_SIZE: 100,
  /** 死信队列最大大小 */
  MAX_DEAD_LETTER_SIZE: 50,
  /** 死信队列条目最大存活时间（毫秒）- 24小时 */
  DEAD_LETTER_TTL: 24 * 60 * 60 * 1000,
  /** 无处理器操作超时（毫秒）- 5分钟后移入死信队列 */
  NO_PROCESSOR_TIMEOUT: QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT,
  /** 业务错误模式（这些错误不需要重试） */
  BUSINESS_ERROR_PATTERNS: [
    'not found',
    'permission denied',
    'unauthorized',
    'forbidden',
    'row level security',
    'rls',
    'violates',
    'duplicate key',
    'unique constraint',
    'foreign key',
    'invalid input'
  ],
  /** 关键操作失败通知阈值：当死信队列中关键操作超过此数量时触发用户通知 */
  CRITICAL_FAILURE_NOTIFY_THRESHOLD: 3,
  /** 低优先级队列最大大小（超过后 FIFO 淘汰） */
  LOW_PRIORITY_MAX_SIZE: 20
} as const;

/**
 * 离线操作队列服务
 * 负责存储失败的变更操作，网络恢复后自动重试
 * 实现离线优先架构的可靠性保证
 * 
 * 增强功能：
 * - 死信队列：存储永久失败的操作供用户查看
 * - 业务错误检测：自动区分网络错误和业务错误
 * - 失败通知：支持注册回调处理失败操作
 */
@Injectable({
  providedIn: 'root'
})
export class ActionQueueService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueue');
  private readonly toast = inject(ToastService);
  private readonly sentryAlert = inject(SentryAlertService);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 死信队列 - 永久失败的操作 */
  readonly deadLetterQueue = signal<DeadLetterItem[]>([]);
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /**
   * 用户可见队列大小（过滤低优先级后台操作，避免状态提示抖动）
   */
  readonly userVisibleQueueSize = computed(() => 
    this.pendingActions().filter(action => action.priority !== 'low').length
  );
  
  /** 死信队列大小 */
  readonly deadLetterSize = signal(0);
  
  /** 
   * 存储失败状态 - 用于触发逃生模式
   * 当 localStorage 和 IndexedDB 都失败时设置为 true
   * UI 层应监听此信号并显示数据备份模态框
   */
  readonly storageFailure = signal(false);
  
  /** 
   * 存储失败回调 - 用于通知 UI 层进入逃生模式
   * 传递当前内存中的数据供用户手动备份
   */
  private storageFailureCallback: ((data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) | null = null;
  
  // 【Sentry 上下文】使用 effect 自动同步队列状态到 Sentry
  private readonly syncContextEffect = effect(() => {
    const queueLength = this.pendingActions().length;
    const deadLetterCount = this.deadLetterQueue().length;
    
    this.sentryAlert.updateSyncContext({
      actionQueueLength: queueLength,
      pendingActions: queueLength,
      deadLetterCount: deadLetterCount,
    });
  });
  
  /** 网络状态 */
  private isOnline = true;
  
  /** 处理器函数映射 */
  private processors: Map<string, (action: QueuedAction) => Promise<boolean>> = new Map();
  
  /** 失败通知回调 */
  private failureCallbacks: Array<(item: DeadLetterItem) => void> = [];
  
  /** 网络监听器引用（用于清理） */
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  
  constructor() {
    this.loadQueueFromStorage();
    this.loadDeadLetterFromStorage();
    this.setupNetworkListeners();
    
    // 注册 DestroyRef 清理
    this.destroyRef.onDestroy(() => this.removeNetworkListeners());
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   * @param type 操作类型标识，如 'project:update'
   * @param processor 处理函数，返回 true 表示成功
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<boolean>) {
    this.processors.set(type, processor);
    this.logger.debug('处理器已注册', { type });
  }
  
  /**
   * 验证所有必需的处理器是否已注册
   * 在应用启动后调用，用于早期发现配置问题
   * 
   * @param requiredProcessors 必需的处理器类型列表
   * @returns 缺失的处理器类型列表，空数组表示全部已注册
   */
  validateProcessors(requiredProcessors: string[]): string[] {
    const missing = requiredProcessors.filter(type => !this.processors.has(type));
    if (missing.length > 0) {
      this.logger.error('缺少必需的处理器', { missing });
    }
    return missing;
  }
  
  /**
   * 获取已注册的处理器类型列表（用于调试）
   */
  getRegisteredProcessorTypes(): string[] {
    return Array.from(this.processors.keys());
  }
  
  /**
   * 注册失败通知回调
   * 当操作被移动到死信队列时触发
   */
  onFailure(callback: (item: DeadLetterItem) => void) {
    this.failureCallbacks.push(callback);
  }
  
  /**
   * 注册存储失败回调 - 用于逃生模式
   * 
   * 当 localStorage 和 IndexedDB 都失败时触发
   * UI 层应监听此回调并显示数据备份模态框，让用户手动复制数据
   * 
   * 设计理念（来自用户反馈）：
   * - 不尝试降级到其他存储方案（会导致数据一致性问题）
   * - 用户可见的强提示是唯一的正道
   * - 应用进入"只读/逃生模式"，防止数据丢失
   * 
   * @param callback 接收当前内存中的队列数据，供用户手动备份
   */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) {
    this.storageFailureCallback = callback;
  }
  
  /**
   * 添加操作到队列 (类型安全版本)
   * 支持优先级分级：
   * - low: 日志/埋点类，失败后静默丢弃
   * - normal: 普通操作（默认），正常重试和死信处理
   * - critical: 关键操作，失败时通知用户
   * 
   * 智能合并：对同一实体的连续操作进行合并，减少网络请求
   */
  enqueue(action: EnqueueParams): string {
    // 设置默认优先级：项目操作为 critical，任务为 normal，偏好为 low
    const defaultPriority: OperationPriority = 
      action.entityType === 'project' ? 'critical' :
      action.entityType === 'preference' ? 'low' : 'normal';
    
    const queuedAction: QueuedAction = {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0,
      priority: action.priority ?? defaultPriority
    };
    
    this.pendingActions.update(queue => {
      let newQueue = [...queue];
      
      // ========== 智能合并：对同一实体的操作去重 ==========
      // 策略：
      // 1. 如果队列中已有同一实体的update操作，替换为最新的
      // 2. 如果队列中有delete操作，忽略后续的update
      // 3. create之后的update可以合并
      const existingIndex = newQueue.findIndex(a => 
        a.entityType === action.entityType &&
        a.entityId === action.entityId &&
        a.retryCount === 0 // 只合并未开始重试的操作
      );
      
      if (existingIndex !== -1) {
        const existing = newQueue[existingIndex];
        
        // 场景1: 队列中有delete，新操作是update/create → 忽略新操作（实体已删除）
        if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
          this.logger.debug(`忽略已删除实体的操作`, { 
            entityType: action.entityType, 
            entityId: action.entityId 
          });
          return queue; // 不添加新操作
        }
        
        // 场景2: 队列中有update，新操作也是update → 合并为一次update
        if (existing.type === 'update' && action.type === 'update') {
          this.logger.debug(`合并重复的update操作`, { 
            entityType: action.entityType, 
            entityId: action.entityId 
          });
          newQueue[existingIndex] = { ...queuedAction, id: existing.id }; // 保留原ID
          return newQueue;
        }
        
        // 场景3: 队列中有create，新操作是update → 合并到create中
        if (existing.type === 'create' && action.type === 'update') {
          this.logger.debug(`合并create后的update`, { 
            entityType: action.entityType, 
            entityId: action.entityId 
          });
          newQueue[existingIndex] = { ...queuedAction, type: 'create', id: existing.id };
          return newQueue;
        }
        
        // 场景4: 队列中有create，新操作是delete → 直接移除create（实体从未存在）
        if (existing.type === 'create' && action.type === 'delete') {
          this.logger.debug(`取消未同步的create操作`, { 
            entityType: action.entityType, 
            entityId: action.entityId 
          });
          newQueue.splice(existingIndex, 1);
          return newQueue;
        }
      }
      
      // 没有合并机会，正常添加
      newQueue.push(queuedAction);
      
      // ========== 分级队列管理：低优先级操作优先淘汰 ==========
      if (newQueue.length > LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE) {
        // 先尝试淘汰低优先级操作
        const lowPriorityActions = newQueue.filter(a => a.priority === 'low');
        if (lowPriorityActions.length > LOCAL_QUEUE_CONFIG.LOW_PRIORITY_MAX_SIZE) {
          // 淘汰最旧的低优先级操作
          const toRemove = lowPriorityActions.slice(0, lowPriorityActions.length - LOCAL_QUEUE_CONFIG.LOW_PRIORITY_MAX_SIZE);
          const toRemoveIds = new Set(toRemove.map(a => a.id));
          newQueue = newQueue.filter(a => !toRemoveIds.has(a.id));
          this.logger.debug(`淘汰了 ${toRemove.length} 个低优先级操作`);
        }
        
        // 如果仍然超过限制，按 FIFO 淘汰（但保护 critical 优先级操作）
        if (newQueue.length > LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE) {
          // 分离 critical 和非 critical 操作
          const criticalActions = newQueue.filter(a => a.priority === 'critical');
          const nonCriticalActions = newQueue.filter(a => a.priority !== 'critical');
          
          // 计算需要保留的非 critical 操作数量
          const maxNonCritical = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE - criticalActions.length;
          
          if (maxNonCritical > 0) {
            // 按 FIFO 保留最新的非 critical 操作
            const keptNonCritical = nonCriticalActions.slice(-maxNonCritical);
            newQueue = [...criticalActions, ...keptNonCritical];
            this.logger.warn(`队列溢出：保护了 ${criticalActions.length} 个关键操作，淘汰了 ${nonCriticalActions.length - keptNonCritical.length} 个非关键操作`);
          } else {
            // 极端情况：critical 操作已超出限制，只保留 critical（永不丢弃关键数据）
            newQueue = criticalActions;
            this.logger.error(`队列严重溢出：仅保留 ${criticalActions.length} 个关键操作，用户数据将被保护`);
          }
        }
      }
      return newQueue;
    });
    
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
    
    // Sentry breadcrumb: 记录入队操作
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `Action enqueued: ${action.type} ${action.entityType}`,
      level: 'info',
      data: {
        actionId: queuedAction.id,
        entityType: action.entityType,
        entityId: action.entityId,
        type: action.type,
        priority: queuedAction.priority,
        queueSize: this.pendingActions().length
      }
    });
    
    // 如果在线，立即尝试处理
    if (this.isOnline) {
      void this.processQueue();
    }
    
    return queuedAction.id;
  }
  
  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    this.pendingActions.update(queue => queue.filter(a => a.id !== actionId));
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
  }
  
  /** 队列处理开始前的回调 - 用于暂停 Realtime 更新 */
  private onQueueProcessStart: (() => void) | null = null;
  
  /** 队列处理结束后的回调 - 用于恢复 Realtime 更新 */
  private onQueueProcessEnd: (() => void) | null = null;
  
  /**
   * 设置队列处理生命周期回调
   * 用于在处理队列期间暂停 Realtime 更新，避免竞态条件
   */
  setQueueProcessCallbacks(onStart: () => void, onEnd: () => void) {
    this.onQueueProcessStart = onStart;
    this.onQueueProcessEnd = onEnd;
  }
  
  /**
   * 处理队列中的所有操作
   * 
   * 【依赖顺序控制】
   * 确保操作按正确顺序执行：
   * - Create 操作必须在对应实体的 Update/Delete 操作之前成功
   * - 如果 Create 失败，后续对同一实体的操作将被暂停
   * - 这防止了尝试 Update 一个服务器还不知道的实体
   */
  async processQueue(): Promise<{ processed: number; failed: number; movedToDeadLetter: number }> {
    if (this.isProcessing() || !this.isOnline) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }
    
    const queueSnapshot = this.pendingActions();
    
    // Sentry breadcrumb: 记录队列处理开始
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `Queue processing started`,
      level: 'info',
      data: {
        queueSize: queueSnapshot.length,
        actionTypes: queueSnapshot.map(a => `${a.entityType}:${a.type}`).join(', ')
      }
    });
    
    this.isProcessing.set(true);
    
    // 通知开始处理 - 暂停 Realtime 更新
    this.onQueueProcessStart?.();
    
    let processed = 0;
    let failed = 0;
    let movedToDeadLetter = 0;
    
    // 【依赖顺序控制】跟踪失败的 Create 操作
    // 如果 Create 失败，后续对同一实体的 Update/Delete 将被跳过
    const failedCreateEntities = new Set<string>();
    
    try {
      const queue = [...this.pendingActions()];
      
      for (const action of queue) {
        // 【依赖顺序检查】如果该实体的 Create 操作失败，跳过后续操作
        const entityKey = `${action.entityType}:${action.entityId}`;
        if (action.type !== 'create' && failedCreateEntities.has(entityKey)) {
          this.logger.debug('跳过操作：依赖的 Create 尚未成功', { 
            actionId: action.id, 
            type: action.type,
            entityKey 
          });
          // 不计入失败，等待 Create 成功后再处理
          continue;
        }
        
        // 【依赖顺序检查】检查队列中是否有该实体的 Create 操作尚未处理
        // 如果有，跳过当前的 Update/Delete 操作
        if (action.type !== 'create') {
          const hasUnprocessedCreate = queue.some(a => 
            a.entityType === action.entityType && 
            a.entityId === action.entityId && 
            a.type === 'create' &&
            a.id !== action.id
          );
          if (hasUnprocessedCreate) {
            this.logger.debug('跳过操作：队列中有未处理的 Create', { 
              actionId: action.id, 
              type: action.type,
              entityKey 
            });
            continue;
          }
        }
        
        const processorKey = `${action.entityType}:${action.type}`;
        const processor = this.processors.get(processorKey);
        
        if (!processor) {
          this.logger.warn(`No processor registered for action type: ${processorKey} - action will remain in queue`);
          // 检查操作是否已超时（无处理器且等待超过阈值）
          const waitTime = Date.now() - action.timestamp;
          if (waitTime > QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT) {
            this.logger.warn(`Action ${action.id} has no processor and timed out (${Math.round(waitTime / 1000)}s), moving to dead letter`);
            this.moveToDeadLetter(action, `无处理器且等待超时 (${Math.round(waitTime / 60000)}分钟)`);
            movedToDeadLetter++;
            
            // 如果是 Create 操作超时，标记实体
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
            }
          } else {
            // 没有处理器的操作保留在队列中等待，但记录重试次数
            if (action.retryCount > 2) {
              this.toast.warning('操作待处理', `有 ${processorKey} 类型的操作尚未处理，请稍后重试`);
            }
          }
          failed++;
          continue;
        }
        
        try {
          const success = await processor(action);
          
          if (success) {
            this.dequeue(action.id);
            processed++;
          } else {
            const result = this.handleRetry(action, 'Operation returned false');
            if (result === 'dead-letter') {
              movedToDeadLetter++;
              // 【依赖顺序控制】Create 失败移入死信队列，标记实体
              if (action.type === 'create') {
                failedCreateEntities.add(entityKey);
                this.pauseDependentActions(action.entityType, action.entityId, queue);
              }
            }
            failed++;
          }
        } catch (error: unknown) {
          const errorMessage = extractErrorMessage(error);
          const result = this.handleRetry(action, errorMessage);
          if (result === 'dead-letter') {
            movedToDeadLetter++;
            // 【依赖顺序控制】Create 失败移入死信队列，标记实体
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
              this.pauseDependentActions(action.entityType, action.entityId, queue);
            }
          }
          failed++;
        }
      }
    } finally {
      this.isProcessing.set(false);
      // 通知处理结束 - 恢复 Realtime 更新
      this.onQueueProcessEnd?.();
      
      // Sentry breadcrumb: 记录队列处理完成
      Sentry.addBreadcrumb({
        category: 'sync',
        message: `Queue processing completed`,
        level: processed > 0 ? 'info' : (failed > 0 ? 'warning' : 'info'),
        data: { processed, failed, movedToDeadLetter }
      });
    }
    
    return { processed, failed, movedToDeadLetter };
  }
  
  /**
   * 清空队列
   */
  clearQueue() {
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.saveQueueToStorage();
  }
  
  /**
   * 清空死信队列
   */
  clearDeadLetterQueue() {
    this.deadLetterQueue.set([]);
    this.deadLetterSize.set(0);
    this.saveDeadLetterToStorage();
  }
  
  /**
   * 从死信队列重试操作
   */
  retryDeadLetter(itemId: string) {
    const item = this.deadLetterQueue().find(d => d.action.id === itemId);
    if (!item) return;
    
    // 重置重试次数
    const resetAction: QueuedAction = {
      ...item.action,
      retryCount: 0,
      lastError: undefined,
      errorType: undefined
    };
    
    // 从死信队列移除
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();
    
    // 重新加入主队列
    this.pendingActions.update(q => [...q, resetAction]);
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
    
    // 立即尝试处理
    if (this.isOnline) {
      void this.processQueue();
    }
  }
  
  /**
   * 从死信队列删除操作（放弃同步）
   */
  dismissDeadLetter(itemId: string) {
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();
  }
  
  /**
   * 获取特定实体的待处理操作
   */
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return this.pendingActions().filter(
      a => a.entityType === entityType && a.entityId === entityId
    );
  }
  
  /**
   * 检查是否有待处理的操作
   */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }
  
  /**
   * 检查是否有死信
   */
  hasDeadLetters(): boolean {
    return this.deadLetterQueue().length > 0;
  }
  
  /**
   * 检查指定实体是否有未完成的 Create 操作
   * 用于依赖顺序检查
   */
  hasUncompletedCreate(entityType: string, entityId: string): boolean {
    return this.pendingActions().some(a => 
      a.entityType === entityType && 
      a.entityId === entityId && 
      a.type === 'create'
    );
  }
  
  /**
   * 获取被阻塞的操作（等待 Create 成功）
   */
  getBlockedActions(): QueuedAction[] {
    const queue = this.pendingActions();
    const blocked: QueuedAction[] = [];
    
    for (const action of queue) {
      if (action.type === 'create') continue;
      
      // 检查是否有对应的 Create 操作
      const hasCreate = queue.some(a => 
        a.entityType === action.entityType && 
        a.entityId === action.entityId && 
        a.type === 'create'
      );
      
      if (hasCreate) {
        blocked.push(action);
      }
    }
    
    return blocked;
  }

  // ========== 私有方法 ==========
  
  /**
   * 暂停依赖于失败 Create 的操作
   * 将这些操作的优先级标记，并记录日志
   * 
   * @param entityType 实体类型
   * @param entityId 实体 ID
   * @param queue 当前队列快照
   */
  private pauseDependentActions(entityType: string, entityId: string, queue: QueuedAction[]): void {
    const dependentActions = queue.filter(a => 
      a.entityType === entityType && 
      a.entityId === entityId && 
      a.type !== 'create'
    );
    
    if (dependentActions.length > 0) {
      this.logger.warn('Create 失败，暂停依赖操作', {
        entityType,
        entityId,
        dependentCount: dependentActions.length,
        dependentTypes: dependentActions.map(a => a.type)
      });
      
      // 发送 Sentry 事件
      Sentry.captureMessage('Create failed, dependent actions paused', {
        level: 'warning',
        tags: { 
          operation: 'pauseDependentActions',
          entityType 
        },
        extra: {
          entityId,
          dependentCount: dependentActions.length,
          dependentActions: dependentActions.map(a => ({ id: a.id, type: a.type }))
        }
      });
      
      // 通知用户（仅当有关键操作被阻塞时）
      const hasCriticalBlocked = dependentActions.some(a => a.priority === 'critical');
      if (hasCriticalBlocked) {
        this.toast.warning(
          '同步受阻', 
          '有操作因前置操作失败而暂停，请检查网络连接'
        );
      }
    }
  }

  /**
   * 移动操作到死信队列
   * 根据操作优先级采取不同策略：
   * - low: 静默丢弃，不进入死信队列
   * - normal: 正常进入死信队列
   * - critical: 进入死信队列并检查是否需要通知用户
   */
  private moveToDeadLetter(action: QueuedAction, reason: string) {
    // 低优先级操作静默丢弃，不进入死信队列
    if (action.priority === 'low') {
      this.dequeue(action.id);
      this.logger.debug('低优先级操作失败，静默丢弃', { actionId: action.id, reason });
      return;
    }
    
    const deadLetterItem: DeadLetterItem = {
      action,
      failedAt: new Date().toISOString(),
      reason
    };
    
    // 从主队列移除
    this.dequeue(action.id);
    
    // 添加到死信队列
    this.deadLetterQueue.update(queue => {
      let newQueue = [...queue, deadLetterItem];
      // 限制死信队列大小，移除最旧的
      if (newQueue.length > LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE) {
        newQueue = newQueue.slice(-LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
      }
      return newQueue;
    });
    
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterToStorage();
    
    // 通知监听者
    this.failureCallbacks.forEach(cb => {
      try {
        cb(deadLetterItem);
      } catch (e) {
        console.error('Dead letter callback error:', e);
      }
    });
    
    // 关键操作失败时检查是否需要通知用户
    if (action.priority === 'critical') {
      const criticalFailures = this.deadLetterQueue().filter(d => d.action.priority === 'critical');
      // 改进：首次关键操作失败也通知用户，不再等待累积到阈值
      if (criticalFailures.length === 1) {
        // 首次关键操作失败 - 单独提示
        this.toast.warning(
          '操作未能同步',
          `"${this.getActionDescription(action)}" 同步失败，稍后将自动重试`
        );
        this.logger.warn('首次关键操作失败，已通知用户', { 
          actionId: action.id,
          entityType: action.entityType,
          type: action.type
        });
      } else if (criticalFailures.length >= LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD) {
        // 多个关键操作失败 - 批量提示
        this.toast.error(
          '同步失败', 
          `有 ${criticalFailures.length} 个重要操作无法完成同步，请检查网络或稍后重试`
        );
        this.logger.warn('关键操作失败超过阈值，已通知用户', { 
          count: criticalFailures.length,
          threshold: LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD 
        });
      }
    }
    
    // Sentry breadcrumb: 记录死信转移
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `Action moved to dead letter`,
      level: 'warning',
      data: {
        actionId: action.id,
        entityType: action.entityType,
        entityId: action.entityId,
        type: action.type,
        priority: action.priority,
        reason,
        deadLetterSize: this.deadLetterQueue().length
      }
    });
    
    this.logger.warn('Action moved to dead letter queue:', {
      actionId: action.id,
      type: action.type,
      entityType: action.entityType,
      entityId: action.entityId,
      priority: action.priority,
      reason
    });
  }
  
  /**
   * 获取操作的可读描述
   * 用于用户通知
   */
  private getActionDescription(action: QueuedAction): string {
    const typeMap: Record<string, string> = {
      'create': '创建',
      'update': '更新',
      'delete': '删除'
    };
    const entityMap: Record<string, string> = {
      'project': '项目',
      'task': '任务',
      'preference': '设置'
    };
    
    const actionType = typeMap[action.type] || action.type;
    const entityType = entityMap[action.entityType] || action.entityType;
    
    return `${actionType}${entityType}`;
  }
  
  /**
   * 处理重试逻辑
   * @returns 'retry' | 'dead-letter' 表示操作后续状态
   * 
   * 改进：
   * 1. 根据错误类型分类处理（网络错误 vs 业务错误 vs 权限错误）
   * 2. 动态调整重试延迟（网络错误快速重试，其他错误指数退避）
   * 3. 移除同步等待，改为异步调度
   */
  private handleRetry(action: QueuedAction, error: string): 'retry' | 'dead-letter' {
    // ========== 错误分类 ==========
    const errorType = this.classifyError(error);
    
    // 业务错误和权限错误直接移入死信队列，不重试
    if (errorType === 'business' || errorType === 'permission') {
      console.warn(`${errorType === 'business' ? '业务' : '权限'}错误，不可重试:`, error);
      this.moveToDeadLetter(action, `${errorType === 'business' ? '业务' : '权限'}错误: ${error}`);
      return 'dead-letter';
    }
    
    // 超过最大重试次数
    if (action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      console.error('超过最大重试次数，移入死信队列:', {
        actionId: action.id,
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        error
      });
      this.moveToDeadLetter(action, `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${error}`);
      
      // Critical操作失败时通知用户
      if (action.priority === 'critical') {
        this.toast.error(
          '重要操作失败',
          `${this.getActionLabel(action)} 失败，请检查网络后重试`
        );
      }
      
      return 'dead-letter';
    }
    
    // 更新重试次数和错误信息
    this.pendingActions.update(queue => 
      queue.map(a => a.id === action.id 
        ? { ...a, retryCount: a.retryCount + 1, lastError: error, errorType }
        : a
      )
    );
    this.saveQueueToStorage();
    
    // ========== 动态重试延迟策略 ==========
    let delay: number;
    if (errorType === 'network') {
      // 网络错误：快速重试（线性增长，避免拥塞）
      delay = Math.min(
        QUEUE_CONFIG.RETRY_BASE_DELAY * (action.retryCount + 1),
        5000 // 最多5秒
      );
    } else if (errorType === 'timeout') {
      // 超时错误：中等延迟
      delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(1.5, action.retryCount);
    } else {
      // 其他错误：指数退避
      delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, action.retryCount);
    }
    
    this.logger.debug(`调度重试`, {
      actionId: action.id,
      errorType,
      retryCount: action.retryCount + 1,
      delay: `${delay}ms`
    });
    
    // 异步调度重试
    this.scheduleRetry(delay);
    
    return 'retry';
  }
  
  /**
   * 错误分类
   * @returns 'network' | 'timeout' | 'permission' | 'business' | 'unknown'
   */
  private classifyError(errorMessage: string): 'network' | 'timeout' | 'permission' | 'business' | 'unknown' {
    const msg = errorMessage.toLowerCase();
    
    // 网络错误
    if (msg.includes('network') || 
        msg.includes('failed to fetch') || 
        msg.includes('networkerror') ||
        msg.includes('connection') ||
        msg.includes('offline')) {
      return 'network';
    }
    
    // 超时错误
    if (msg.includes('timeout') || 
        msg.includes('timed out') ||
        msg.includes('deadline exceeded')) {
      return 'timeout';
    }
    
    // 权限错误
    if (msg.includes('permission') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('jwt') ||
        msg.includes('token') ||
        msg.includes('policy')) {
      return 'permission';
    }
    
    // 业务错误（数据约束等）
    // 使用配置中定义的业务错误模式进行匹配
    for (const pattern of LOCAL_QUEUE_CONFIG.BUSINESS_ERROR_PATTERNS) {
      if (msg.includes(pattern.toLowerCase())) {
        return 'business';
      }
    }
    
    return 'unknown';
  }
  
  /**
   * 获取操作的可读标签
   */
  private getActionLabel(action: QueuedAction): string {
    const typeLabels = {
      create: '创建',
      update: '更新',
      delete: '删除'
    };
    const entityLabels = {
      project: '项目',
      task: '任务',
      preference: '偏好设置'
    };
    return `${typeLabels[action.type]}${entityLabels[action.entityType]}`;
  }
  
  /** 重试调度定时器 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  
  /**
   * 调度异步重试
   * 使用单一定时器避免多个重试同时触发
   */
  private scheduleRetry(delay: number): void {
    // 如果已有定时器在等待，不重复调度
    if (this.retryTimer) return;
    
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // 只有在线时才重试
      if (this.isOnline) {
        void this.processQueue();
      }
    }, delay);
  }
  
  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    this.onlineHandler = () => {
      this.isOnline = true;
      // 网络恢复时自动处理队列
      void this.processQueue();
    };
    
    this.offlineHandler = () => {
      this.isOnline = false;
    };
    
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    
    this.isOnline = navigator.onLine;
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
   * 保存队列到本地存储
   * 处理 QuotaExceededError：先尝试 IndexedDB 备份，再清理旧数据
   */
  private saveQueueToStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      localStorage.setItem(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        JSON.stringify(this.pendingActions())
      );
    } catch (e: unknown) {
      // 处理 QuotaExceededError - 检查错误类型
      const isQuotaError = 
        (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) ||
        (e instanceof Error && e.name === 'QuotaExceededError');
      
      if (isQuotaError) {
        this.logger.warn('LocalStorage 配额不足，尝试清理旧数据...');
        
        // 策略 1: 清理死信队列
        this.clearDeadLetterQueue();
        
        // 策略 2: 只保留最新的50%操作
        const currentQueue = this.pendingActions();
        if (currentQueue.length > 10) {
          const reducedQueue = currentQueue.slice(-Math.ceil(currentQueue.length / 2));
          try {
            localStorage.setItem(
              LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
              JSON.stringify(reducedQueue)
            );
            this.pendingActions.set(reducedQueue);
            this.queueSize.set(reducedQueue.length);
            this.toast.warning('存储空间不足', `已清理 ${currentQueue.length - reducedQueue.length} 个较早的操作记录`);
            return;
          } catch {
            // 仍然失败，继续降级策略
          }
        }
        
        // 策略 3: 尝试备份到 IndexedDB 后再清空 localStorage
        this.logger.warn('LocalStorage 配额严重不足，尝试 IndexedDB 备份...');
        void this.backupQueueToIndexedDB(currentQueue).then(success => {
          if (success) {
            // 备份成功，可以安全地清空 localStorage 队列
            localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
            this.logger.info('队列已备份到 IndexedDB，localStorage 已清理');
            this.toast.info('存储空间不足', '操作队列已转移到备用存储，数据安全');
          } else {
            // IndexedDB 也失败，触发逃生模式
            this.triggerStorageFailureEscapeMode();
          }
        });
      } else {
        this.logger.warn('Failed to save action queue to storage', e);
      }
    }
  }
  
  /**
   * 触发存储失败逃生模式
   * 
   * 当 localStorage 和 IndexedDB 都失败时调用
   * 设置 storageFailure 标志并通知 UI 层显示数据备份模态框
   */
  private triggerStorageFailureEscapeMode(): void {
    this.logger.error('【存储灾难】localStorage 和 IndexedDB 均不可用，进入逃生模式');
    
    // 设置存储失败标志
    this.storageFailure.set(true);
    
    // 显示严重错误 toast
    this.toast.error(
      '🚨 存储失败 - 数据可能丢失', 
      '浏览器存储不可用。请立即复制下方数据进行备份！',
      { duration: 0 } // 不自动关闭
    );
    
    // 通知 UI 层进入逃生模式
    if (this.storageFailureCallback) {
      try {
        this.storageFailureCallback({
          queue: this.pendingActions(),
          deadLetter: this.deadLetterQueue()
        });
      } catch (e) {
        this.logger.error('存储失败回调执行异常', e);
      }
    }
  }
  
  /**
   * 备份队列到 IndexedDB
   * 当 localStorage 配额不足时的降级方案
   */
  private async backupQueueToIndexedDB(queue: QueuedAction[]): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;
    
    try {
      const db = await this.openQueueBackupDb();
      
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        
        // 清空旧数据后写入新数据
        const clearRequest = store.clear();
        clearRequest.onsuccess = () => {
          const putRequest = store.put({ id: 'queue', actions: queue, savedAt: new Date().toISOString() });
          putRequest.onsuccess = () => {
            this.logger.info('队列已备份到 IndexedDB', { count: queue.length });
            resolve(true);
          };
          putRequest.onerror = () => {
            this.logger.error('IndexedDB 写入失败', putRequest.error);
            resolve(false);
          };
        };
        clearRequest.onerror = () => {
          this.logger.error('IndexedDB 清空失败', clearRequest.error);
          resolve(false);
        };
      });
    } catch (e) {
      this.logger.error('IndexedDB 备份异常', e);
      return false;
    }
  }
  
  /**
   * 从 IndexedDB 恢复队列备份
   */
  private async restoreQueueFromIndexedDB(): Promise<QueuedAction[] | null> {
    if (typeof indexedDB === 'undefined') return null;
    
    try {
      const db = await this.openQueueBackupDb();
      
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        
        const request = store.get('queue');
        request.onsuccess = () => {
          const data = request.result as { id: string; actions: QueuedAction[]; savedAt: string } | undefined;
          if (data?.actions) {
            this.logger.info('从 IndexedDB 恢复队列备份', { count: data.actions.length, savedAt: data.savedAt });
            resolve(data.actions);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => {
          this.logger.warn('从 IndexedDB 读取备份失败', request.error);
          resolve(null);
        };
      });
    } catch (e) {
      this.logger.warn('IndexedDB 恢复异常', e);
      return null;
    }
  }
  
  /**
   * 打开队列备份数据库
   */
  private openQueueBackupDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME)) {
          db.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }
  
  /**
   * 从本地存储加载队列
   * 优先从 localStorage 加载，失败时尝试 IndexedDB 备份
   */
  private loadQueueFromStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const saved = localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as QueuedAction[];
        if (Array.isArray(queue)) {
          this.pendingActions.set(queue);
          this.queueSize.set(queue.length);
          return;
        }
      }
      
      // localStorage 为空，尝试从 IndexedDB 恢复
      void this.restoreQueueFromIndexedDB().then(backupQueue => {
        if (backupQueue && backupQueue.length > 0) {
          this.pendingActions.set(backupQueue);
          this.queueSize.set(backupQueue.length);
          this.toast.info('队列恢复', `从备用存储恢复了 ${backupQueue.length} 个待处理操作`);
          // 恢复后尝试保存回 localStorage
          this.saveQueueToStorage();
        }
      });
    } catch (e) {
      console.warn('Failed to load action queue from storage', e);
    }
  }
  
  /**
   * 保存死信队列到本地存储
   */
  private saveDeadLetterToStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      localStorage.setItem(
        LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY,
        JSON.stringify(this.deadLetterQueue())
      );
    } catch (e) {
      console.warn('Failed to save dead letter queue to storage', e);
    }
  }
  
  /**
   * 从本地存储加载死信队列
   * 同时清理过期条目（TTL 清理）
   */
  private loadDeadLetterFromStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const saved = localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as DeadLetterItem[];
        if (Array.isArray(queue)) {
          // TTL 清理：移除过期的死信条目
          const now = Date.now();
          const validQueue = queue.filter(item => {
            const failedTime = new Date(item.failedAt).getTime();
            return (now - failedTime) < LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL;
          });
          
          this.deadLetterQueue.set(validQueue);
          this.deadLetterSize.set(validQueue.length);
          
          // 如果有条目被清理，更新存储
          if (validQueue.length < queue.length) {
            this.saveDeadLetterToStorage();
            this.logger.info(`清理了 ${queue.length - validQueue.length} 个过期的死信队列条目`);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load dead letter queue from storage', e);
    }
  }
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   * 
   * 注意：Root 级别的服务在 Angular 设计中不会被销毁，
   * 使用显式 reset() 方法而非 ngOnDestroy 来清理状态
   */
  reset(): void {
    // 移除网络监听器
    this.removeNetworkListeners();
    
    // 清理重试定时器
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    
    // 清空队列
    this.pendingActions.set([]);
    this.deadLetterQueue.set([]);
    this.queueSize.set(0);
    this.deadLetterSize.set(0);
    this.isProcessing.set(false);
    
    // 清空处理器和回调
    this.processors.clear();
    this.failureCallbacks.length = 0;
    
    // 重置回调
    this.onQueueProcessStart = null;
    this.onQueueProcessEnd = null;
    this.storageFailureCallback = null;
    
    // 重置存储失败状态
    this.storageFailure.set(false);
    
    // 重置网络状态
    this.isOnline = true;
  }
}
