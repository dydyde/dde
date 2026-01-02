/**
 * TabSyncService - 多标签页同步服务
 * 
 * 【设计理念】
 * 这是一个"点到为止"的轻量级实现：
 * - 使用 BroadcastChannel API 实现跨标签页通信
 * - 当同一项目在多个标签页打开时，显示友好提示
 * - 【Week 5 增强】添加编辑锁检测，检测并发编辑冲突
 * - **不做强约束**：不禁止编辑，不锁定项目
 * 
 * 为什么不做强约束？
 * 1. 你是唯一的用户，精神分裂式的并发编辑概率极低
 * 2. 现有的"最后写入者胜"策略和冲突解决机制足够应对
 * 3. 复杂的锁定机制只会增加代码熵
 * 
 * 【使用方式】
 * 在组件中注入服务，当切换项目时调用：
 * ```typescript
 * this.tabSync.notifyProjectOpen(projectId, projectName);
 * ```
 * 
 * 【编辑锁】
 * ```typescript
 * // 开始编辑任务时
 * this.tabSync.acquireEditLock(taskId, 'content');
 * // 检查是否有其他标签页正在编辑
 * if (this.tabSync.isBeingEditedByOtherTab(taskId, 'content')) {
 *   // 显示警告
 * }
 * // 结束编辑时
 * this.tabSync.releaseEditLock(taskId, 'content');
 * ```
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
 */
import { Injectable, inject, OnDestroy, signal } from '@angular/core';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

/**
 * 跨标签页消息类型
 */
interface TabMessage {
  type: 'project-opened' | 'project-closed' | 'heartbeat' | 'data-synced' | 'edit-lock' | 'edit-unlock';
  tabId: string;
  projectId?: string;
  projectName?: string;
  timestamp: number;
  /** 【新增】同步完成时的项目更新时间戳（用于 data-synced） */
  projectUpdatedAt?: string;
  /** 【Week 5 新增】编辑锁信息 */
  editLock?: TabEditLock;
}

/**
 * 【Week 5 新增】编辑锁结构
 */
export interface TabEditLock {
  taskId: string;
  tabId: string;
  field: string;
  lockedAt: number;
  expiresAt: number;
}

/**
 * 【Week 5 新增】并发编辑事件
 */
export interface ConcurrentEditEvent {
  taskId: string;
  field: string;
  otherTabId: string;
  ownLockTime: number;
  otherLockTime: number;
}

/**
 * 活跃标签页追踪
 */
interface ActiveTab {
  tabId: string;
  projectId: string;
  projectName: string;
  lastSeen: number;
}

/**
 * 配置常量
 * 【v5.10 增强】从 sync.config.ts 导入配置
 */
import { TAB_CONCURRENCY_CONFIG } from '../config/sync.config';

const TAB_SYNC_CONFIG = {
  /** BroadcastChannel 名称 */
  CHANNEL_NAME: 'nanoflow-tab-sync',
  /** 心跳间隔（毫秒）- 用于清理失效标签页 */
  HEARTBEAT_INTERVAL: 30000,
  /** 标签页超时时间（毫秒）- 超过此时间未心跳则认为已关闭 */
  TAB_TIMEOUT: 60000,
  /** Toast 消息 key（用于去重） */
  TOAST_KEY: 'tab-sync-warning',
  /** 【v5.10】编辑锁超时时间（使用配置）*/
  EDIT_LOCK_TIMEOUT: TAB_CONCURRENCY_CONFIG.EDIT_LOCK_TIMEOUT,
  /** 【v5.10】并发编辑检测策略（使用配置）*/
  CONCURRENT_EDIT_STRATEGY: TAB_CONCURRENCY_CONFIG.CONCURRENT_EDIT_STRATEGY,
  /** 【v5.10】锁刷新间隔 */
  LOCK_REFRESH_INTERVAL: TAB_CONCURRENCY_CONFIG.LOCK_REFRESH_INTERVAL,
  /** 【v5.10】警告冷却时间 */
  WARNING_COOLDOWN: TAB_CONCURRENCY_CONFIG.WARNING_COOLDOWN,
} as const;

@Injectable({
  providedIn: 'root'
})
export class TabSyncService implements OnDestroy {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TabSync');
  private readonly toast = inject(ToastService);
  
  /** 当前标签页唯一 ID */
  private readonly tabId = crypto.randomUUID().substring(0, 8);
  
  /** BroadcastChannel 实例 */
  private channel: BroadcastChannel | null = null;
  
  /** 当前标签页打开的项目 ID */
  private currentProjectId: string | null = null;
  
  /** 当前标签页打开的项目名称 */
  private currentProjectName: string | null = null;
  
  /** 其他标签页追踪 */
  private activeTabs = new Map<string, ActiveTab>();
  
  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 是否支持 BroadcastChannel */
  private readonly isSupported: boolean;
  
  /** 【新增】数据同步回调 - 当其他标签页完成同步时调用 */
  private onDataSyncedCallback: ((projectId: string, updatedAt: string) => void) | null = null;
  
  /** 【Week 5 新增】本地编辑锁 - key: taskId:field */
  private localEditLocks = new Map<string, TabEditLock>();
  
  /** 【Week 5 新增】远程编辑锁（其他标签页的锁） - key: taskId:field */
  private remoteEditLocks = new Map<string, TabEditLock>();
  
  /** 【Week 5 新增】并发编辑回调 */
  private onConcurrentEditCallback: ((event: ConcurrentEditEvent) => void) | null = null;
  
  /** 【Week 5 新增】检测到的并发编辑数量 */
  readonly concurrentEditCount = signal(0);
  
  /** 【v5.10 新增】锁刷新定时器 */
  private lockRefreshTimers = new Map<string, ReturnType<typeof setInterval>>();
  
  /** 【v5.10 新增】警告冷却追踪 */
  private lastWarningTime = new Map<string, number>();
  
  constructor() {
    this.isSupported = typeof BroadcastChannel !== 'undefined';
    
    if (this.isSupported) {
      this.setupChannel();
      this.startHeartbeat();
    } else {
      this.logger.warn('BroadcastChannel 不受支持，多标签页同步已禁用');
    }
  }
  
  ngOnDestroy(): void {
    this.cleanup();
  }
  
  /**
   * 通知其他标签页：当前标签页打开了某个项目
   * 
   * @param projectId 项目 ID
   * @param projectName 项目名称（用于友好提示）
   */
  notifyProjectOpen(projectId: string, projectName: string): void {
    if (!this.isSupported || !this.channel) return;
    
    // 如果之前打开了其他项目，先通知关闭
    if (this.currentProjectId && this.currentProjectId !== projectId) {
      this.notifyProjectClose();
    }
    
    this.currentProjectId = projectId;
    this.currentProjectName = projectName;
    
    const message: TabMessage = {
      type: 'project-opened',
      tabId: this.tabId,
      projectId,
      projectName,
      timestamp: Date.now(),
    };
    
    this.channel.postMessage(message);
    this.logger.debug('广播项目打开', { projectId, projectName });
    
    // 检查是否有其他标签页已打开同一项目
    this.checkConflicts(projectId, projectName);
  }
  
  /**
   * 通知其他标签页：当前标签页关闭了项目
   */
  notifyProjectClose(): void {
    if (!this.isSupported || !this.channel) return;
    if (!this.currentProjectId) return;
    
    const message: TabMessage = {
      type: 'project-closed',
      tabId: this.tabId,
      projectId: this.currentProjectId,
      timestamp: Date.now(),
    };
    
    this.channel.postMessage(message);
    this.logger.debug('广播项目关闭', { projectId: this.currentProjectId });
    
    this.currentProjectId = null;
    this.currentProjectName = null;
  }
  
  /**
   * 获取当前打开同一项目的其他标签页数量
   */
  getOtherTabsCount(projectId: string): number {
    let count = 0;
    const now = Date.now();
    
    for (const [tabId, tab] of this.activeTabs) {
      if (tabId === this.tabId) continue;
      if (tab.projectId !== projectId) continue;
      if (now - tab.lastSeen > TAB_SYNC_CONFIG.TAB_TIMEOUT) continue;
      count++;
    }
    
    return count;
  }
  
  /**
   * 【新增】通知其他标签页：后台同步已完成，数据已更新
   * 
   * 来自高级顾问建议：
   * - 当 Tab A 完成后台同步并写入 IndexedDB 时，广播 data-synced 消息
   * - Tab B 收到后从 IndexedDB 刷新数据到内存，无需再发网络请求
   * 
   * @param projectId 同步完成的项目 ID
   * @param updatedAt 项目最新的 updatedAt 时间戳
   */
  notifyDataSynced(projectId: string, updatedAt: string): void {
    if (!this.isSupported || !this.channel) return;
    
    const message: TabMessage = {
      type: 'data-synced',
      tabId: this.tabId,
      projectId,
      projectUpdatedAt: updatedAt,
      timestamp: Date.now(),
    };
    
    this.channel.postMessage(message);
    this.logger.debug('广播数据同步完成', { projectId, updatedAt });
  }
  
  /**
   * 【新增】设置数据同步回调
   * 
   * 当其他标签页完成后台同步时，会调用此回调
   * 用于触发从 IndexedDB 刷新数据到内存
   * 
   * @param callback 回调函数 (projectId, updatedAt) => void
   */
  setOnDataSyncedCallback(callback: (projectId: string, updatedAt: string) => void): void {
    this.onDataSyncedCallback = callback;
  }
  
  // ========== 私有方法 ==========
  
  private setupChannel(): void {
    try {
      this.channel = new BroadcastChannel(TAB_SYNC_CONFIG.CHANNEL_NAME);
      this.channel.onmessage = (event) => this.handleMessage(event.data as TabMessage);
      this.logger.debug('BroadcastChannel 已建立', { tabId: this.tabId });
    } catch (e) {
      this.logger.error('BroadcastChannel 建立失败', e);
    }
  }
  
  private handleMessage(message: TabMessage): void {
    // 忽略自己发送的消息
    if (message.tabId === this.tabId) return;
    
    switch (message.type) {
      case 'project-opened':
        this.handleProjectOpened(message);
        break;
      case 'project-closed':
        this.handleProjectClosed(message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      case 'data-synced':
        this.handleDataSynced(message);
        break;
      case 'edit-lock':
        this.handleEditLock(message);
        break;
      case 'edit-unlock':
        this.handleEditUnlock(message);
        break;
    }
  }
  
  private handleProjectOpened(message: TabMessage): void {
    if (!message.projectId || !message.projectName) return;
    
    // 更新追踪
    this.activeTabs.set(message.tabId, {
      tabId: message.tabId,
      projectId: message.projectId,
      projectName: message.projectName,
      lastSeen: message.timestamp,
    });
    
    // 如果当前标签页也打开了同一项目，显示警告
    if (this.currentProjectId === message.projectId) {
      this.showConflictWarning(message.projectName);
    }
  }
  
  private handleProjectClosed(message: TabMessage): void {
    this.activeTabs.delete(message.tabId);
  }
  
  private handleHeartbeat(message: TabMessage): void {
    const existing = this.activeTabs.get(message.tabId);
    if (existing) {
      existing.lastSeen = message.timestamp;
    }
  }
  
  /**
   * 【新增】处理其他标签页的数据同步完成通知
   */
  private handleDataSynced(message: TabMessage): void {
    if (!message.projectId || !message.projectUpdatedAt) return;
    
    this.logger.debug('收到其他标签页的数据同步通知', {
      fromTab: message.tabId,
      projectId: message.projectId,
      updatedAt: message.projectUpdatedAt
    });
    
    // 如果当前标签页正在查看该项目，触发数据刷新
    if (this.currentProjectId === message.projectId) {
      if (this.onDataSyncedCallback) {
        this.onDataSyncedCallback(message.projectId, message.projectUpdatedAt);
      }
    }
  }
  
  private checkConflicts(projectId: string, projectName: string): void {
    const otherTabs = this.getOtherTabsCount(projectId);
    if (otherTabs > 0) {
      this.showConflictWarning(projectName);
    }
  }
  
  private showConflictWarning(projectName: string): void {
    this.toast.warning(
      '多窗口提醒',
      `项目「${projectName}」已在其他标签页打开，请注意同步`,
      { duration: 5000 }
    );
  }
  
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.cleanupStaleTabs();
    }, TAB_SYNC_CONFIG.HEARTBEAT_INTERVAL);
  }
  
  private sendHeartbeat(): void {
    if (!this.channel || !this.currentProjectId) return;
    
    const message: TabMessage = {
      type: 'heartbeat',
      tabId: this.tabId,
      projectId: this.currentProjectId,
      timestamp: Date.now(),
    };
    
    this.channel.postMessage(message);
  }
  
  private cleanupStaleTabs(): void {
    const now = Date.now();
    const staleTabIds: string[] = [];
    
    for (const [tabId, tab] of this.activeTabs) {
      if (now - tab.lastSeen > TAB_SYNC_CONFIG.TAB_TIMEOUT) {
        staleTabIds.push(tabId);
      }
    }
    
    for (const tabId of staleTabIds) {
      this.activeTabs.delete(tabId);
      this.logger.debug('清理过期标签页', { tabId });
    }
  }
  
  private cleanup(): void {
    // 通知其他标签页当前标签页关闭
    this.notifyProjectClose();
    
    // 释放所有本地编辑锁
    this.releaseAllEditLocks();
    
    // 【v5.10】清理并发状态
    this.cleanupConcurrencyState();
    
    // 停止心跳
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    // 关闭 channel
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    
    this.activeTabs.clear();
    this.localEditLocks.clear();
    this.remoteEditLocks.clear();
  }
  
  // ========== 【Week 5 新增】编辑锁方法 ==========
  
  /**
   * 获取编辑锁
   * 当开始编辑任务的某个字段时调用
   * 
   * 【v5.10 增强】
   * - 添加锁刷新定时器，持续编辑时自动刷新锁
   * - 添加警告冷却，避免频繁提示
   * 
   * @param taskId 任务 ID
   * @param field 字段名（如 'title', 'content'）
   * @returns 是否成功获取锁（如果其他标签页已锁定则返回 false）
   */
  acquireEditLock(taskId: string, field: string): boolean {
    if (!this.isSupported || !this.channel) return true;
    if (!TAB_CONCURRENCY_CONFIG.DETECT_CONCURRENT_EDIT) return true;
    
    const lockKey = `${taskId}:${field}`;
    const now = Date.now();
    
    // 检查是否有其他标签页已持有此锁
    const remoteLock = this.remoteEditLocks.get(lockKey);
    if (remoteLock && remoteLock.expiresAt > now) {
      // 检测到并发编辑
      this.handleConcurrentEdit(taskId, field, remoteLock);
      
      if (TAB_SYNC_CONFIG.CONCURRENT_EDIT_STRATEGY === 'block') {
        return false;
      }
    }
    
    // 创建本地锁
    const lock: TabEditLock = {
      taskId,
      tabId: this.tabId,
      field,
      lockedAt: now,
      expiresAt: now + TAB_SYNC_CONFIG.EDIT_LOCK_TIMEOUT,
    };
    
    this.localEditLocks.set(lockKey, lock);
    
    // 广播锁
    this.broadcastEditLock(lock);
    
    // 【v5.10】启动锁刷新定时器
    this.startLockRefresh(lockKey, taskId, field);
    
    return true;
  }
  
  /**
   * 【v5.10 新增】启动锁刷新定时器
   * 持续编辑时定期刷新锁，防止锁过期
   */
  private startLockRefresh(lockKey: string, taskId: string, field: string): void {
    // 清除已有的刷新定时器
    this.stopLockRefresh(lockKey);
    
    const timer = setInterval(() => {
      const lock = this.localEditLocks.get(lockKey);
      if (!lock) {
        this.stopLockRefresh(lockKey);
        return;
      }
      
      // 刷新锁
      const now = Date.now();
      lock.expiresAt = now + TAB_SYNC_CONFIG.EDIT_LOCK_TIMEOUT;
      
      // 重新广播
      this.broadcastEditLock(lock);
      this.logger.debug('刷新编辑锁', { taskId, field });
    }, TAB_SYNC_CONFIG.LOCK_REFRESH_INTERVAL);
    
    this.lockRefreshTimers.set(lockKey, timer);
  }
  
  /**
   * 【v5.10 新增】停止锁刷新定时器
   */
  private stopLockRefresh(lockKey: string): void {
    const timer = this.lockRefreshTimers.get(lockKey);
    if (timer) {
      clearInterval(timer);
      this.lockRefreshTimers.delete(lockKey);
    }
  }
  
  /**
   * 释放编辑锁
   * 当结束编辑任务的某个字段时调用
   * 
   * @param taskId 任务 ID
   * @param field 字段名
   */
  releaseEditLock(taskId: string, field: string): void {
    if (!this.isSupported || !this.channel) return;
    
    const lockKey = `${taskId}:${field}`;
    const lock = this.localEditLocks.get(lockKey);
    
    if (lock) {
      // 【v5.10】停止锁刷新定时器
      this.stopLockRefresh(lockKey);
      
      this.localEditLocks.delete(lockKey);
      this.broadcastEditUnlock(lock);
    }
  }
  
  /**
   * 释放所有本地编辑锁
   */
  releaseAllEditLocks(): void {
    // 【v5.10】清除所有锁刷新定时器
    for (const timer of this.lockRefreshTimers.values()) {
      clearInterval(timer);
    }
    this.lockRefreshTimers.clear();
    
    for (const lock of this.localEditLocks.values()) {
      this.broadcastEditUnlock(lock);
    }
    this.localEditLocks.clear();
  }
  
  /**
   * 检查任务字段是否正在被其他标签页编辑
   * 
   * @param taskId 任务 ID
   * @param field 字段名（可选，不传则检查所有字段）
   * @returns 是否正在被其他标签页编辑
   */
  isBeingEditedByOtherTab(taskId: string, field?: string): boolean {
    const now = Date.now();
    
    for (const [_key, lock] of this.remoteEditLocks) {
      if (lock.taskId !== taskId) continue;
      if (field && lock.field !== field) continue;
      if (lock.expiresAt <= now) continue;
      
      return true;
    }
    
    return false;
  }
  
  /**
   * 获取正在编辑指定任务的其他标签页信息
   */
  getOtherEditorsForTask(taskId: string): TabEditLock[] {
    const now = Date.now();
    const editors: TabEditLock[] = [];
    
    for (const lock of this.remoteEditLocks.values()) {
      if (lock.taskId === taskId && lock.expiresAt > now) {
        editors.push(lock);
      }
    }
    
    return editors;
  }
  
  /**
   * 设置并发编辑回调
   */
  setOnConcurrentEditCallback(callback: (event: ConcurrentEditEvent) => void): void {
    this.onConcurrentEditCallback = callback;
  }
  
  // ========== 编辑锁私有方法 ==========
  
  private broadcastEditLock(lock: TabEditLock): void {
    if (!this.channel) return;
    
    const message: TabMessage = {
      type: 'edit-lock',
      tabId: this.tabId,
      timestamp: Date.now(),
      editLock: lock,
    };
    
    this.channel.postMessage(message);
    this.logger.debug('广播编辑锁', { taskId: lock.taskId, field: lock.field });
  }
  
  private broadcastEditUnlock(lock: TabEditLock): void {
    if (!this.channel) return;
    
    const message: TabMessage = {
      type: 'edit-unlock',
      tabId: this.tabId,
      timestamp: Date.now(),
      editLock: lock,
    };
    
    this.channel.postMessage(message);
    this.logger.debug('广播编辑锁释放', { taskId: lock.taskId, field: lock.field });
  }
  
  private handleEditLock(message: TabMessage): void {
    if (!message.editLock) return;
    
    const lock = message.editLock;
    const lockKey = `${lock.taskId}:${lock.field}`;
    
    // 记录远程锁
    this.remoteEditLocks.set(lockKey, lock);
    
    // 检查是否与本地锁冲突
    const localLock = this.localEditLocks.get(lockKey);
    if (localLock) {
      this.handleConcurrentEdit(lock.taskId, lock.field, lock);
    }
  }
  
  private handleEditUnlock(message: TabMessage): void {
    if (!message.editLock) return;
    
    const lock = message.editLock;
    const lockKey = `${lock.taskId}:${lock.field}`;
    
    // 移除远程锁
    this.remoteEditLocks.delete(lockKey);
  }
  
  private handleConcurrentEdit(taskId: string, field: string, remoteLock: TabEditLock): void {
    const localLock = this.localEditLocks.get(`${taskId}:${field}`);
    const lockKey = `${taskId}:${field}`;
    const now = Date.now();
    
    const event: ConcurrentEditEvent = {
      taskId,
      field,
      otherTabId: remoteLock.tabId,
      ownLockTime: localLock?.lockedAt ?? now,
      otherLockTime: remoteLock.lockedAt,
    };
    
    this.concurrentEditCount.update(c => c + 1);
    
    this.logger.warn('检测到并发编辑', event);
    
    // 【v5.10】检查警告冷却
    const lastWarning = this.lastWarningTime.get(lockKey) ?? 0;
    const shouldWarn = now - lastWarning > TAB_SYNC_CONFIG.WARNING_COOLDOWN;
    
    // 根据策略处理
    if (TAB_SYNC_CONFIG.CONCURRENT_EDIT_STRATEGY === 'warn' && shouldWarn) {
      this.toast.warning(
        '并发编辑提醒',
        `此任务正在其他标签页编辑中，注意同步`,
        { duration: 3000 }
      );
      this.lastWarningTime.set(lockKey, now);
    }
    
    // 触发回调
    if (this.onConcurrentEditCallback) {
      this.onConcurrentEditCallback(event);
    }
  }
  
  /**
   * 【v5.10 新增】清理资源
   */
  private cleanupConcurrencyState(): void {
    // 清理锁刷新定时器
    for (const timer of this.lockRefreshTimers.values()) {
      clearInterval(timer);
    }
    this.lockRefreshTimers.clear();
    
    // 清理警告冷却追踪
    this.lastWarningTime.clear();
  }
}
