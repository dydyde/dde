/**
 * TabSyncService - 多标签页同步服务
 * 
 * 【设计理念】
 * 这是一个"点到为止"的轻量级实现：
 * - 使用 BroadcastChannel API 实现跨标签页通信
 * - 当同一项目在多个标签页打开时，显示友好提示
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
 * @see https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
 */
import { Injectable, inject, OnDestroy } from '@angular/core';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

/**
 * 跨标签页消息类型
 */
interface TabMessage {
  type: 'project-opened' | 'project-closed' | 'heartbeat';
  tabId: string;
  projectId?: string;
  projectName?: string;
  timestamp: number;
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
 */
const TAB_SYNC_CONFIG = {
  /** BroadcastChannel 名称 */
  CHANNEL_NAME: 'nanoflow-tab-sync',
  /** 心跳间隔（毫秒）- 用于清理失效标签页 */
  HEARTBEAT_INTERVAL: 30000,
  /** 标签页超时时间（毫秒）- 超过此时间未心跳则认为已关闭 */
  TAB_TIMEOUT: 60000,
  /** Toast 消息 key（用于去重） */
  TOAST_KEY: 'tab-sync-warning',
} as const;

@Injectable({
  providedIn: 'root'
})
export class TabSyncService implements OnDestroy {
  private readonly logger = inject(LoggerService).category('TabSync');
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
  }
}
