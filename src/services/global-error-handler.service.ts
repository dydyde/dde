import { ErrorHandler, Injectable, inject, NgZone, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { TOAST_CONFIG } from '../config';

/**
 * 错误级别
 */
export enum ErrorSeverity {
  /** 静默级：记录日志即可，不打扰用户（如 404 图片、无关紧要的数据获取延迟） */
  SILENT = 'silent',
  /** 提示级：需要 Toast 弹窗告诉用户（如保存失败、网络断开） */
  NOTIFY = 'notify',
  /** 可恢复级：显示恢复对话框，让用户选择处理方式 */
  RECOVERABLE = 'recoverable',
  /** 致命级：需要跳转到错误页面（如 Store 初始化失败导致白屏） */
  FATAL = 'fatal'
}

/**
 * 恢复选项
 */
export interface RecoveryOption {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
}

/**
 * 可恢复错误信息
 */
export interface RecoverableError {
  title: string;
  message: string;
  details?: string;
  options: RecoveryOption[];
  defaultOptionId?: string;
  autoSelectIn?: number;
  resolve: (optionId: string) => void;
}

/**
 * 错误分类规则
 * 用于根据错误信息自动判断严重程度
 */
interface ErrorClassificationRule {
  pattern: RegExp | string;
  severity: ErrorSeverity;
  userMessage?: string;
}

/**
 * 全局错误处理服务
 * 
 * 职责：
 * 1. 捕获所有未处理的错误
 * 2. 根据错误类型进行分级处理
 * 3. 静默级：仅记录日志
 * 4. 提示级：显示 Toast 提示用户
 * 5. 致命级：跳转到错误页面
 * 
 * @example
 * // 手动报告错误
 * errorHandler.handleError(new Error('Something went wrong'), ErrorSeverity.NOTIFY);
 * 
 * // 自动分类
 * errorHandler.handleError(new Error('Failed to load image'));  // 自动识别为 SILENT
 */
@Injectable({
  providedIn: 'root'
})
export class GlobalErrorHandler implements ErrorHandler {
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('GlobalErrorHandler');
  private toast = inject(ToastService);
  private router = inject(Router);
  private zone = inject(NgZone);

  /** 当前可恢复错误（用于显示恢复对话框） */
  readonly recoverableError = signal<RecoverableError | null>(null);

  /** 错误分类规则（顺序敏感，优先匹配前面的规则） */
  private readonly classificationRules: ErrorClassificationRule[] = [
    // === 静默级错误 ===
    // Angular NG0203 错误（inject()在错误上下文调用，通常由异步组件加载触发，不影响功能）
    { pattern: /NG0203|inject.*must be called from an injection context/i, severity: ErrorSeverity.SILENT },
    // 图片加载失败
    { pattern: /load.*image|image.*load|img.*error|404.*image/i, severity: ErrorSeverity.SILENT },
    // Supabase Auth 多标签页锁争用（不影响功能，但在 Zone.js 下可能被报告为未处理错误）
    { pattern: /Navigator LockManager lock|lock:sb-.*-auth-token|Acquiring an exclusive Navigator LockManager lock/i, severity: ErrorSeverity.SILENT },
    // 字体加载失败
    { pattern: /font.*load|load.*font/i, severity: ErrorSeverity.SILENT },
    // 非关键资源 404
    { pattern: /404.*(?:favicon|icon|manifest)/i, severity: ErrorSeverity.SILENT },
    // ResizeObserver 循环警告（浏览器内部，无需处理）
    { pattern: /ResizeObserver loop/i, severity: ErrorSeverity.SILENT },
    // 用户取消操作
    { pattern: /abort|cancel|user.*cancel/i, severity: ErrorSeverity.SILENT },
    // 非活动标签页的更新
    { pattern: /not active|inactive tab/i, severity: ErrorSeverity.SILENT },
    // 模态框加载超时（已由 ModalLoaderService 处理，静默记录）
    { pattern: /模态框.*加载超时|modal.*load.*timeout/i, severity: ErrorSeverity.SILENT },
    // Chunk 加载错误（动态导入失败，由重试机制处理）
    { pattern: /ChunkLoadError|Failed to fetch.*chunk|Loading chunk.*failed/i, severity: ErrorSeverity.SILENT },
    
    // === 提示级错误 ===
    // UUID 格式错误
    { 
      pattern: /invalid input syntax for type uuid/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '数据格式错误：ID 必须是有效的 UUID 格式'
    },
    // 网络错误
    { 
      pattern: /network|offline|fetch.*fail|http.*error|timeout|ECONNREFUSED/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '网络连接失败，请检查网络后重试'
    },
    // 保存/同步失败
    { 
      pattern: /save.*fail|sync.*fail|persist.*fail|upload.*fail/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '保存失败，请稍后重试'
    },
    // 认证错误（非致命）
    { 
      pattern: /unauthorized|401|auth.*error|session.*expir/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '登录状态已过期，请重新登录'
    },
    // 权限错误
    { 
      pattern: /forbidden|403|permission.*denied|access.*denied/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '您没有权限执行此操作'
    },
    // 服务端错误
    { 
      pattern: /500|502|503|504|server.*error|internal.*error/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '服务器繁忙，请稍后重试'
    },
    // 数据验证错误
    { 
      pattern: /validation.*fail|invalid.*data|data.*corrupt/i, 
      severity: ErrorSeverity.NOTIFY,
      userMessage: '数据格式错误，请检查输入'
    },
    
    // === 致命级错误 ===
    // Store 初始化失败
    { 
      pattern: /store.*init|init.*store|bootstrap.*fail/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '应用初始化失败'
    },
    // 路由初始化失败
    { 
      pattern: /router.*init|route.*fail|navigation.*fail.*critical/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '页面加载失败'
    },
    // 关键模块加载失败
    { 
      pattern: /chunk.*fail|module.*fail|lazy.*load.*fail/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '模块加载失败'
    },
    // 内存不足
    { 
      pattern: /out.*memory|memory.*exhausted|heap.*overflow/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '内存不足'
    },
    // IndexedDB 关键错误
    { 
      pattern: /indexeddb.*fail|idb.*quota|storage.*quota/i, 
      severity: ErrorSeverity.FATAL,
      userMessage: '存储空间不足'
    }
  ];

  /** 致命错误状态（用于防止重复跳转） */
  private hasFatalError = false;

  /** 错误去重（防止同一错误短时间内重复提示） */
  private recentErrors = new Map<string, number>();
  private readonly ERROR_DEDUP_INTERVAL = TOAST_CONFIG.ERROR_DEDUP_INTERVAL;

  /**
   * Angular ErrorHandler 接口实现
   * 捕获所有未处理的错误
   */
  handleError(error: unknown, forceSeverity?: ErrorSeverity): void {
    // 提取错误信息
    const errorMessage = this.extractErrorMessage(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // 确定错误级别
    const severity = forceSeverity ?? this.classifyError(errorMessage);

    // 错误去重检查
    if (severity !== ErrorSeverity.FATAL && this.isDuplicateError(errorMessage)) {
      this.logger.debug('Duplicate error suppressed', { error: errorMessage });
      return;
    }

    // 根据级别处理
    switch (severity) {
      case ErrorSeverity.SILENT:
        this.handleSilentError(errorMessage, errorStack);
        break;
      case ErrorSeverity.NOTIFY:
        this.handleNotifyError(errorMessage, errorStack, error);
        break;
      case ErrorSeverity.RECOVERABLE:
        // 可恢复错误会被特殊处理，这里只记录日志
        this.logger.warn('Recoverable error', { message: errorMessage, stack: errorStack });
        break;
      case ErrorSeverity.FATAL:
        this.handleFatalError(errorMessage, errorStack, error);
        break;
    }
  }

  /**
   * 手动报告错误（供业务代码使用）
   */
  reportError(error: unknown, severity: ErrorSeverity, customMessage?: string): void {
    if (customMessage) {
      const wrappedError = new Error(customMessage);
      if (error instanceof Error) {
        wrappedError.stack = error.stack;
      }
      this.handleError(wrappedError, severity);
    } else {
      this.handleError(error, severity);
    }
  }

  /**
   * 重置致命错误状态（从错误页面恢复时调用）
   */
  resetFatalState(): void {
    this.hasFatalError = false;
  }

  /**
   * 检查是否处于致命错误状态
   */
  get isFatalState(): boolean {
    return this.hasFatalError;
  }

  /**
   * 显示可恢复错误对话框
   * 返回 Promise，等待用户选择后 resolve
   * 
   * @example
   * const choice = await errorHandler.showRecoveryDialog({
   *   title: '同步失败',
   *   message: '无法将更改同步到云端',
   *   options: [
   *     { id: 'retry', label: '重试', style: 'primary' },
   *     { id: 'offline', label: '离线模式', style: 'secondary' },
   *     { id: 'discard', label: '丢弃更改', style: 'danger' }
   *   ]
   * });
   * 
   * if (choice === 'retry') { ... }
   */
  showRecoveryDialog(config: {
    title: string;
    message: string;
    details?: string;
    options: RecoveryOption[];
    defaultOptionId?: string;
    autoSelectIn?: number;
  }): Promise<string> {
    return new Promise((resolve) => {
      this.zone.run(() => {
        this.recoverableError.set({
          ...config,
          resolve: (optionId: string) => {
            this.recoverableError.set(null);
            resolve(optionId);
          }
        });
      });
    });
  }

  /**
   * 关闭恢复对话框（不选择任何选项）
   * 返回 null
   */
  dismissRecoveryDialog(): void {
    const current = this.recoverableError();
    if (current) {
      current.resolve('dismiss');
      this.recoverableError.set(null);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 提取错误消息
   */
  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object') {
      // 处理 HTTP 错误响应
      const errObj = error as any;
      if (errObj.message) return String(errObj.message);
      if (errObj.error?.message) return String(errObj.error.message);
      if (errObj.statusText) return String(errObj.statusText);
    }
    return 'Unknown error';
  }

  /**
   * 根据错误消息自动分类
   */
  private classifyError(errorMessage: string): ErrorSeverity {
    for (const rule of this.classificationRules) {
      const pattern = typeof rule.pattern === 'string' 
        ? new RegExp(rule.pattern, 'i') 
        : rule.pattern;
      
      if (pattern.test(errorMessage)) {
        return rule.severity;
      }
    }
    
    // 默认为提示级（保守策略，未知错误告知用户）
    return ErrorSeverity.NOTIFY;
  }

  /**
   * 获取用户友好的错误消息
   */
  private getUserMessage(errorMessage: string): string {
    for (const rule of this.classificationRules) {
      const pattern = typeof rule.pattern === 'string' 
        ? new RegExp(rule.pattern, 'i') 
        : rule.pattern;
      
      if (pattern.test(errorMessage) && rule.userMessage) {
        return rule.userMessage;
      }
    }
    return '操作失败，请稍后重试';
  }

  /**
   * 检查是否为重复错误
   */
  private isDuplicateError(errorMessage: string): boolean {
    const key = errorMessage.substring(0, 100); // 截取前100字符作为key
    const now = Date.now();
    const lastTime = this.recentErrors.get(key);
    
    if (lastTime && now - lastTime < this.ERROR_DEDUP_INTERVAL) {
      return true;
    }
    
    this.recentErrors.set(key, now);
    
    // 清理过期的错误记录
    if (this.recentErrors.size > 100) {
      const cutoff = now - this.ERROR_DEDUP_INTERVAL;
      for (const [k, v] of this.recentErrors) {
        if (v < cutoff) {
          this.recentErrors.delete(k);
        }
      }
    }
    
    return false;
  }

  /**
   * 处理静默级错误
   */
  private handleSilentError(message: string, stack?: string): void {
    // 仅记录日志，不打扰用户
    this.logger.debug('Silent error captured', { message, stack });
  }

  /**
   * 处理提示级错误
   */
  private handleNotifyError(message: string, stack?: string, _originalError?: unknown): void {
    // 记录详细日志
    this.logger.warn('Notify-level error', { message, stack });
    
    // 获取用户友好的消息
    const userMessage = this.getUserMessage(message);
    
    // 在 Angular zone 内显示 Toast
    this.zone.run(() => {
      this.toast.error('出错了', userMessage);
    });
  }

  /**
   * 处理致命级错误
   */
  private handleFatalError(message: string, stack?: string, originalError?: unknown): void {
    // 防止重复处理
    if (this.hasFatalError) {
      this.logger.warn('Fatal error already handled, ignoring', { message });
      return;
    }
    
    this.hasFatalError = true;
    
    // 记录错误日志
    this.logger.error('FATAL ERROR', { message, stack, originalError });
    
    // 保存错误信息到 sessionStorage（用于错误页面显示）
    try {
      sessionStorage.setItem('nanoflow.fatal-error', JSON.stringify({
        message,
        userMessage: this.getUserMessage(message),
        timestamp: new Date().toISOString(),
        stack: stack?.substring(0, 2000) // 限制堆栈长度
      }));
    } catch {
      // sessionStorage 不可用，忽略
    }
    
    // 在 Angular zone 内导航到错误页面
    this.zone.run(() => {
      void this.router.navigate(['/error'], { 
        skipLocationChange: true,
        state: { 
          errorMessage: message,
          userMessage: this.getUserMessage(message)
        }
      });
    });
  }
}

/**
 * 错误边界装饰器
 * 用于包装异步方法，自动捕获并处理错误
 * 
 * @example
 * class MyService {
 *   @CatchError(ErrorSeverity.NOTIFY)
 *   async loadData() {
 *     // ...
 *   }
 * }
 */
export function CatchError(severity: ErrorSeverity = ErrorSeverity.NOTIFY, customMessage?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        // 获取 GlobalErrorHandler 实例
        // 注意：这需要在 Angular 上下文中使用
        const errorHandler = (this as any).globalErrorHandler as GlobalErrorHandler | undefined;
        if (errorHandler) {
          errorHandler.reportError(error, severity, customMessage);
        } else {
          console.error(`[${propertyKey}] Error:`, error);
        }
        throw error; // 重新抛出以便调用方知道操作失败
      }
    };
    
    return descriptor;
  };
}
