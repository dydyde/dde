import { Injectable, signal, computed } from '@angular/core';
import { TOAST_CONFIG } from '../config/constants';

/**
 * Toast 消息类型
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

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
}

/**
 * Toast 通知服务
 * 提供全局的错误/成功/警告/信息提示功能
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

  /**
   * 显示成功消息
   */
  success(title: string, message?: string, duration?: number): void {
    this.show('success', title, message, duration ?? ToastService.DEFAULT_DURATION);
  }

  /**
   * 显示错误消息
   */
  error(title: string, message?: string, duration?: number): void {
    this.show('error', title, message, duration ?? ToastService.ERROR_DURATION);
  }

  /**
   * 显示警告消息
   */
  warning(title: string, message?: string, duration?: number): void {
    this.show('warning', title, message, duration ?? ToastService.DEFAULT_DURATION);
  }

  /**
   * 显示信息消息
   */
  info(title: string, message?: string, duration?: number): void {
    this.show('info', title, message, duration ?? ToastService.DEFAULT_DURATION);
  }

  /**
   * 显示 Toast 消息
   */
  private show(type: ToastType, title: string, message?: string, duration = ToastService.DEFAULT_DURATION): void {
    const id = crypto.randomUUID();
    const toast: ToastMessage = {
      id,
      type,
      title,
      message,
      duration,
      createdAt: Date.now()
    };

    this.toasts.update(current => {
      const updated = [...current, toast];
      // 限制最大数量，移除最旧的
      if (updated.length > ToastService.MAX_TOASTS) {
        return updated.slice(-ToastService.MAX_TOASTS);
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
