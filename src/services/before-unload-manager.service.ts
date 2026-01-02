// ============================================
// 统一的 beforeunload 管理服务
// 解决 app.component.ts 和 persistence-failure-handler.service.ts 
// 两个独立监听器冲突的问题
// ============================================

import { Injectable, inject, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';

/**
 * beforeunload 回调接口
 * 返回 true 表示需要显示确认对话框
 */
export type BeforeUnloadCallback = () => boolean | void;

/**
 * 回调注册项
 */
interface CallbackRegistration {
  /** 唯一标识符 */
  id: string;
  /** 回调函数 */
  callback: BeforeUnloadCallback;
  /** 优先级（数字越小越先执行） */
  priority: number;
}

/**
 * 统一的 beforeunload 管理服务
 * 
 * 设计目标：
 * 1. 单一监听器：只注册一个 beforeunload 事件处理器，避免执行顺序不可控
 * 2. 优先级机制：允许多个模块按优先级注册回调
 * 3. 确认对话框：任一回调返回 true 则显示确认对话框
 * 4. 跨浏览器兼容：同时监听 pagehide 和 visibilitychange 事件
 * 
 * 优先级定义：
 * - 0-10: 核心数据保存（同步服务、撤销服务）
 * - 11-20: 辅助数据保存（脏数据逃生舱）
 * - 21+: 其他清理操作
 */
@Injectable({ providedIn: 'root' })
export class BeforeUnloadManagerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('BeforeUnloadManager');
  private readonly destroyRef = inject(DestroyRef);

  /** 已注册的回调列表 */
  private callbacks: CallbackRegistration[] = [];

  /** 事件处理器引用（用于清理） */
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
  private pagehideHandler: ((e: PageTransitionEvent) => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;

  /** 是否已初始化 */
  private initialized = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  /**
   * 初始化事件监听器
   * 应在应用启动时调用一次
   */
  initialize(): void {
    if (this.initialized || typeof window === 'undefined') return;

    this.setupEventListeners();
    this.initialized = true;
    this.logger.debug('BeforeUnloadManager 已初始化');
  }

  /**
   * 注册 beforeunload 回调
   * 
   * @param id 唯一标识符（用于取消注册）
   * @param callback 回调函数，返回 true 表示需要确认
   * @param priority 优先级，数字越小越先执行（默认 10）
   */
  register(id: string, callback: BeforeUnloadCallback, priority = 10): void {
    // 移除已存在的同 ID 注册
    this.unregister(id);

    this.callbacks.push({ id, callback, priority });
    // 按优先级排序
    this.callbacks.sort((a, b) => a.priority - b.priority);

    this.logger.debug(`BeforeUnload 回调已注册: ${id}`, { priority });
  }

  /**
   * 取消注册回调
   * 
   * @param id 注册时使用的唯一标识符
   */
  unregister(id: string): void {
    const index = this.callbacks.findIndex(c => c.id === id);
    if (index !== -1) {
      this.callbacks.splice(index, 1);
      this.logger.debug(`BeforeUnload 回调已取消注册: ${id}`);
    }
  }

  /**
   * 手动触发所有保存回调
   * 用于程序化触发保存（如切换项目前）
   */
  triggerSave(): boolean {
    return this.executeCallbacks();
  }

  // ==================== 私有方法 ====================

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 统一的保存逻辑
    const handleUnload = (e?: BeforeUnloadEvent): void => {
      const needConfirm = this.executeCallbacks();

      if (needConfirm && e) {
        // 显示浏览器确认对话框
        e.preventDefault();
        e.returnValue = '您有未保存的内容，确定要离开吗？';
      }
    };

    this.beforeUnloadHandler = (e: BeforeUnloadEvent) => handleUnload(e);
    this.pagehideHandler = () => handleUnload();
    this.visibilityChangeHandler = () => {
      if (document.visibilityState === 'hidden') {
        handleUnload();
      }
    };

    // 注册事件监听器
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    window.addEventListener('pagehide', this.pagehideHandler as EventListener, { capture: true });
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  /**
   * 按优先级执行所有回调
   * 
   * @returns 是否需要显示确认对话框
   */
  private executeCallbacks(): boolean {
    let needConfirm = false;

    for (const registration of this.callbacks) {
      try {
        const result = registration.callback();
        if (result === true) {
          needConfirm = true;
        }
      } catch (e) {
        this.logger.error(`BeforeUnload 回调执行失败: ${registration.id}`, { error: e });
        // 继续执行其他回调
      }
    }

    return needConfirm;
  }

  /**
   * 清理事件监听器
   */
  private cleanup(): void {
    if (typeof window === 'undefined') return;

    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    }
    if (this.pagehideHandler) {
      window.removeEventListener('pagehide', this.pagehideHandler as EventListener);
    }
    if (this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    }

    this.callbacks = [];
    this.initialized = false;
    this.logger.debug('BeforeUnloadManager 已清理');
  }
}
