import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { CACHE_CONFIG, QUEUE_CONFIG } from '../config/constants';
import { Project, Task, UserPreferences } from '../models';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

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
  /** 错误类型：network=网络错误可重试，business=业务错误不可重试 */
  errorType?: 'network' | 'business';
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
export class ActionQueueService implements OnDestroy {
  private logger = inject(LoggerService).category('ActionQueue');
  private toast = inject(ToastService);
  
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 死信队列 - 永久失败的操作 */
  readonly deadLetterQueue = signal<DeadLetterItem[]>([]);
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /** 死信队列大小 */
  readonly deadLetterSize = signal(0);
  
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
  }
  
  ngOnDestroy(): void {
    this.removeNetworkListeners();
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   * @param type 操作类型标识，如 'project:update'
   * @param processor 处理函数，返回 true 表示成功
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<boolean>) {
    this.processors.set(type, processor);
  }
  
  /**
   * 注册失败通知回调
   * 当操作被移动到死信队列时触发
   */
  onFailure(callback: (item: DeadLetterItem) => void) {
    this.failureCallbacks.push(callback);
  }
  
  /**
   * 添加操作到队列 (类型安全版本)
   * 支持优先级分级：
   * - low: 日志/埋点类，失败后静默丢弃
   * - normal: 普通操作（默认），正常重试和死信处理
   * - critical: 关键操作，失败时通知用户
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
      let newQueue = [...queue, queuedAction];
      
      // 分级队列管理：低优先级操作优先淘汰
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
        
        // 如果仍然超过限制，按 FIFO 淘汰
        if (newQueue.length > LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE) {
          newQueue = newQueue.slice(-LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE);
        }
      }
      return newQueue;
    });
    
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
    
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
   */
  async processQueue(): Promise<{ processed: number; failed: number; movedToDeadLetter: number }> {
    if (this.isProcessing() || !this.isOnline) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }
    
    this.isProcessing.set(true);
    
    // 通知开始处理 - 暂停 Realtime 更新
    this.onQueueProcessStart?.();
    
    let processed = 0;
    let failed = 0;
    let movedToDeadLetter = 0;
    
    try {
      const queue = [...this.pendingActions()];
      
      for (const action of queue) {
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
            const result = await this.handleRetry(action, 'Operation returned false');
            if (result === 'dead-letter') {
              movedToDeadLetter++;
            }
            failed++;
          }
        } catch (error: any) {
          const errorMessage = error?.message ?? String(error);
          const result = await this.handleRetry(action, errorMessage);
          if (result === 'dead-letter') {
            movedToDeadLetter++;
          }
          failed++;
        }
      }
    } finally {
      this.isProcessing.set(false);
      // 通知处理结束 - 恢复 Realtime 更新
      this.onQueueProcessEnd?.();
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
  
  // ========== 私有方法 ==========
  
  /**
   * 检测是否为业务错误（不可重试）
   */
  private isBusinessError(errorMessage: string): boolean {
    const lowerMessage = errorMessage.toLowerCase();
    return LOCAL_QUEUE_CONFIG.BUSINESS_ERROR_PATTERNS.some(pattern => 
      lowerMessage.includes(pattern)
    );
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
      if (criticalFailures.length >= LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD) {
        // 触发用户通知
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
   * 处理重试逻辑
   * @returns 'retry' | 'dead-letter' 表示操作后续状态
   */
  private async handleRetry(action: QueuedAction, error: string): Promise<'retry' | 'dead-letter'> {
    // 检测错误类型
    const isBusinessErr = this.isBusinessError(error);
    
    // 业务错误直接移入死信队列，不重试
    if (isBusinessErr) {
      console.warn('Business error detected, moving to dead letter:', error);
      this.moveToDeadLetter(action, `业务错误: ${error}`);
      return 'dead-letter';
    }
    
    // 超过最大重试次数
    if (action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      console.error('Action exceeded max retries, moving to dead letter:', {
        actionId: action.id,
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        error
      });
      this.moveToDeadLetter(action, `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${error}`);
      return 'dead-letter';
    }
    
    // 更新重试次数和错误信息
    this.pendingActions.update(queue => 
      queue.map(a => a.id === action.id 
        ? { ...a, retryCount: a.retryCount + 1, lastError: error, errorType: 'network' as const }
        : a
      )
    );
    this.saveQueueToStorage();
    
    // 指数退避
    const delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, action.retryCount);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return 'retry';
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
   */
  private saveQueueToStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      localStorage.setItem(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        JSON.stringify(this.pendingActions())
      );
    } catch (e) {
      console.warn('Failed to save action queue to storage', e);
    }
  }
  
  /**
   * 从本地存储加载队列
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
        }
      }
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
    
    // 重置网络状态
    this.isOnline = true;
  }
}
