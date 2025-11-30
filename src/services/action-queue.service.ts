import { Injectable, inject, signal } from '@angular/core';
import { CACHE_CONFIG, QUEUE_CONFIG } from '../config/constants';
import { Project, Task, UserPreferences } from '../models';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

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
}

/**
 * 类型安全的操作入队参数
 */
export type EnqueueParams = 
  | { type: 'create' | 'update'; entityType: 'project'; entityId: string; payload: ProjectPayload }
  | { type: 'delete'; entityType: 'project'; entityId: string; payload: ProjectDeletePayload }
  | { type: 'create' | 'update'; entityType: 'task'; entityId: string; payload: TaskPayload }
  | { type: 'delete'; entityType: 'task'; entityId: string; payload: TaskDeletePayload }
  | { type: 'create' | 'update' | 'delete'; entityType: 'preference'; entityId: string; payload: PreferencePayload };

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
  ]
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
  
  constructor() {
    this.loadQueueFromStorage();
    this.loadDeadLetterFromStorage();
    this.setupNetworkListeners();
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
   */
  enqueue(action: EnqueueParams): string {
    const queuedAction: QueuedAction = {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0
    };
    
    this.pendingActions.update(queue => {
      // 限制队列大小
      let newQueue = [...queue, queuedAction];
      if (newQueue.length > LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE) {
        // 移除最旧的操作
        newQueue = newQueue.slice(-LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE);
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
  
  /**
   * 处理队列中的所有操作
   */
  async processQueue(): Promise<{ processed: number; failed: number; movedToDeadLetter: number }> {
    if (this.isProcessing() || !this.isOnline) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }
    
    this.isProcessing.set(true);
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
   */
  private moveToDeadLetter(action: QueuedAction, reason: string) {
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
    
    console.warn('Action moved to dead letter queue:', {
      actionId: action.id,
      type: action.type,
      entityType: action.entityType,
      entityId: action.entityId,
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
    
    window.addEventListener('online', () => {
      this.isOnline = true;
      // 网络恢复时自动处理队列
      void this.processQueue();
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
    
    this.isOnline = navigator.onLine;
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
   */
  private loadDeadLetterFromStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const saved = localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as DeadLetterItem[];
        if (Array.isArray(queue)) {
          this.deadLetterQueue.set(queue);
          this.deadLetterSize.set(queue.length);
        }
      }
    } catch (e) {
      console.warn('Failed to load dead letter queue from storage', e);
    }
  }
}
