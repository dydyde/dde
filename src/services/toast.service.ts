import { Injectable, signal, computed } from '@angular/core';
import { TOAST_CONFIG } from '../config/constants';

/**
 * Toast 消息类型
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast 操作按钮接口
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Toast 选项接口
 */
export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

/**
 * Toast 消息接口
 */
export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  createdAt: number;
  action?: ToastAction;
}

/**
 * Toast 通知服务
 * 提供全局的错误/成功/警告/信息提示功能
 * 支持错误去重：相同错误在指定时间内不会重复显示
 */
@Injectable({
  providedIn: 'root'
})
export class ToastService {
  /** 当前显示的 Toast 消息列表 */
  private toasts = signal<ToastMessage[]>([]);
  
  /** 只读的 Toast 消息列表 */
  readonly messages = computed(() => this.toasts());
  
  /** 是否有消息 */
  readonly hasMessages = computed(() => this.toasts().length > 0);
  
  /** 默认显示时间（毫秒） */
  private static readonly DEFAULT_DURATION: number = TOAST_CONFIG.DEFAULT_DURATION;
  private static readonly ERROR_DURATION: number = 8000;
  private static readonly MAX_TOASTS: number = 5;
  
  /** 错误去重缓存：记录最近显示的错误及其时间 */
  private recentErrors = new Map<string, number>();

  /**
   * 显示成功消息
   */
  success(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    this.show('success', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }

  /**
   * 显示错误消息
   * 支持去重：相同的 title+message 在 ERROR_DEDUP_INTERVAL 内只显示一次
   */
  error(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    
    // 错误去重检查
    const dedupKey = `error:${title}:${message || ''}`;
    const now = Date.now();
    const lastShown = this.recentErrors.get(dedupKey);
    
    if (lastShown && (now - lastShown) < TOAST_CONFIG.ERROR_DEDUP_INTERVAL) {
      // 在去重间隔内，跳过显示
      return;
    }
    
    // 记录显示时间
    this.recentErrors.set(dedupKey, now);
    
    // 清理过期的去重记录（避免内存泄漏）
    this.cleanupRecentErrors();
    
    this.show('error', title, message, opts.duration ?? ToastService.ERROR_DURATION, opts.action);
  }
  
  /**
   * 清理过期的错误去重记录
   */
  private cleanupRecentErrors(): void {
    const now = Date.now();
    const expireThreshold = TOAST_CONFIG.ERROR_DEDUP_INTERVAL * 2;
    
    for (const [key, timestamp] of this.recentErrors.entries()) {
      if (now - timestamp > expireThreshold) {
        this.recentErrors.delete(key);
      }
    }
  }

  /**
   * 显示警告消息
   */
  warning(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    this.show('warning', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }

  /**
   * 显示信息消息
   */
  info(title: string, message?: string, options?: ToastOptions | number): void {
    const opts = this.normalizeOptions(options);
    this.show('info', title, message, opts.duration ?? ToastService.DEFAULT_DURATION, opts.action);
  }
  
  /**
   * 规范化选项参数（兼容旧的 duration 参数）
   */
  private normalizeOptions(options?: ToastOptions | number): ToastOptions {
    if (typeof options === 'number') {
      return { duration: options };
    }
    return options ?? {};
  }

  /**
   * 显示 Toast 消息
   * 支持消息合并：相同类型和标题的消息不会重复显示
   */
  private show(type: ToastType, title: string, message?: string, duration = ToastService.DEFAULT_DURATION, action?: ToastAction): void {
    // 检查是否已有相同的消息显示中（合并逻辑）
    const existingToast = this.toasts().find(
      t => t.type === type && t.title === title && t.message === message
    );
    
    if (existingToast) {
      // 相同消息已存在，重置其时间（延长显示）
      // 通过移除旧的并添加新的来刷新
      this.dismiss(existingToast.id);
    }
    
    const id = crypto.randomUUID();
    const toast: ToastMessage = {
      id,
      type,
      title,
      message,
      duration,
      createdAt: Date.now(),
      action
    };

    this.toasts.update(current => {
      const updated = [...current, toast];
      // 限制最大数量，移除最旧的（保留错误消息优先级）
      if (updated.length > ToastService.MAX_TOASTS) {
        // 找到第一个非错误类型的消息移除
        const nonErrorIndex = updated.findIndex(t => t.type !== 'error');
        if (nonErrorIndex !== -1) {
          updated.splice(nonErrorIndex, 1);
        } else {
          // 如果全是错误消息，移除最旧的
          return updated.slice(-ToastService.MAX_TOASTS);
        }
      }
      return updated;
    });

    // 自动移除
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }

  /**
   * 手动关闭指定 Toast
   */
  dismiss(id: string): void {
    this.toasts.update(current => current.filter(t => t.id !== id));
  }

  /**
   * 关闭所有 Toast
   */
  dismissAll(): void {
    this.toasts.set([]);
  }
}
