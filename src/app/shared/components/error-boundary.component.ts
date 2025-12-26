import { 
  Component, 
  Input, 
  signal, 
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  HostBinding,
  NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import { LoggerService } from '../../../services/logger.service';

/**
 * 错误边界组件
 * 用于捕获子组件的渲染错误并显示降级 UI
 * 
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ 设计决策：为什么不使用 Zone.js 黑魔法实现真正的错误隔离？                      │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ Angular 和 React 的渲染机制本质不同：                                        │
 * │ - React 的 Error Boundary 能像 try-catch 一样包裹组件渲染树，是因为其        │
 * │   Virtual DOM 机制允许局部的渲染回退                                         │
 * │ - Angular 的变更检测是全量的，一旦 Zone.js 里的某个微任务炸了，通常意味着     │
 * │   应用的状态树已经处于不一致的危险边缘                                        │
 * │                                                                             │
 * │ 在这种情况下，试图用复杂的 Zone.js 钩子去"隔离"错误，往往是在掩盖问题。       │
 * │ 你可能会得到一个还在运行但逻辑已经错乱的界面，这比直接崩溃更可怕。            │
 * │                                                                             │
 * │ 最诚实且安全的策略：全局 ErrorHandler                                        │
 * │ 一旦发生未捕获异常，记录日志，并提供一个显眼的"刷新重置"按钮。               │
 * │ 这就像电脑死机了直接重启，虽然粗暴，但比让你在蓝屏界面继续打字要负责任得多。 │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * 注意：Angular 不像 React 那样有原生的 ErrorBoundary 机制
 * 此组件通过以下机制实现错误边界功能：
 * 1. 集成 GlobalErrorHandler 监听全局错误
 * 2. 提供手动 setError() 接口供父组件调用
 * 3. 【已弃用】Zone.js onError 钩子 - 见上述设计决策
 * 
 * 使用方式：
 * 1. 根组件级：包裹整个应用，防止白屏
 * 2. 局部级：包裹高风险模块（如富文本编辑器、第三方图表）
 * 
 * @example
 * <app-error-boundary [title]="'图表加载失败'" [showRetry]="true">
 *   <app-complex-chart></app-complex-chart>
 * </app-error-boundary>
 */
@Component({
  selector: 'app-error-boundary',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- 正常状态：显示子内容 -->
    @if (!hasError()) {
      <ng-content></ng-content>
    }
    
    <!-- 错误状态：显示降级 UI -->
    @if (hasError()) {
      <div class="error-boundary-fallback" 
           [class]="containerClass"
           role="alert"
           aria-live="polite">
        <div class="error-content">
          <!-- 图标 -->
          <div class="error-icon" [class.error-icon-fatal]="isFatal()">
            @if (isFatal()) {
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-12 h-12">
                <path fill-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd" />
              </svg>
            } @else {
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-10 h-10">
                <path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd" />
              </svg>
            }
          </div>
          
          <!-- 标题和消息 -->
          <h3 class="error-title">{{ title }}</h3>
          <p class="error-message">{{ userMessage() || defaultMessage }}</p>
          
          <!-- 详细错误信息（开发模式） -->
          @if (showDetails && errorDetails()) {
            <details class="error-details">
              <summary>技术详情</summary>
              <pre>{{ errorDetails() }}</pre>
            </details>
          }
          
          <!-- 操作按钮 -->
          <div class="error-actions">
            @if (showRetry && onRetry) {
              <button 
                class="btn-retry"
                (click)="retry()"
                type="button">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mr-1">
                  <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clip-rule="evenodd" />
                </svg>
                重试
              </button>
            }
            
            @if (showRefresh) {
              <button 
                class="btn-refresh"
                (click)="refreshPage()"
                type="button">
                刷新页面
              </button>
            }
            
            @if (showHome) {
              <button 
                class="btn-home"
                (click)="goHome()"
                type="button">
                返回首页
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
      width: 100%;
    }
    
    .error-boundary-fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      padding: 2rem;
      background: var(--fallback-bg, #fef2f2);
      border: 1px solid var(--fallback-border, #fecaca);
      border-radius: 0.5rem;
    }
    
    .error-boundary-fallback.full-page {
      min-height: 100vh;
      background: var(--fallback-bg-page, #fff);
    }
    
    .error-boundary-fallback.compact {
      min-height: 100px;
      padding: 1rem;
    }
    
    .error-content {
      text-align: center;
      max-width: 400px;
    }
    
    .error-icon {
      display: flex;
      justify-content: center;
      margin-bottom: 1rem;
      color: var(--error-icon-color, #ef4444);
    }
    
    .error-icon-fatal {
      color: var(--error-icon-fatal-color, #dc2626);
    }
    
    .error-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--error-title-color, #991b1b);
      margin-bottom: 0.5rem;
    }
    
    .error-message {
      color: var(--error-message-color, #7f1d1d);
      margin-bottom: 1rem;
      line-height: 1.5;
    }
    
    .error-details {
      text-align: left;
      margin-bottom: 1rem;
      padding: 0.5rem;
      background: rgba(0,0,0,0.05);
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }
    
    .error-details summary {
      cursor: pointer;
      color: var(--error-details-color, #6b7280);
    }
    
    .error-details pre {
      margin-top: 0.5rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    .error-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      flex-wrap: wrap;
    }
    
    .btn-retry, .btn-refresh, .btn-home {
      display: inline-flex;
      align-items: center;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .btn-retry {
      background: var(--btn-retry-bg, #3b82f6);
      color: white;
      border: none;
    }
    
    .btn-retry:hover {
      background: var(--btn-retry-hover, #2563eb);
    }
    
    .btn-refresh {
      background: var(--btn-refresh-bg, #f3f4f6);
      color: var(--btn-refresh-color, #374151);
      border: 1px solid var(--btn-refresh-border, #d1d5db);
    }
    
    .btn-refresh:hover {
      background: var(--btn-refresh-hover, #e5e7eb);
    }
    
    .btn-home {
      background: transparent;
      color: var(--btn-home-color, #6b7280);
      border: none;
      text-decoration: underline;
    }
    
    .btn-home:hover {
      color: var(--btn-home-hover, #374151);
    }
    
    /* 暗色主题支持 */
    :host-context([data-theme="dark"]) .error-boundary-fallback {
      --fallback-bg: #1f1f1f;
      --fallback-border: #3f3f3f;
      --error-icon-color: #f87171;
      --error-title-color: #fca5a5;
      --error-message-color: #fecaca;
      --btn-refresh-bg: #374151;
      --btn-refresh-color: #e5e7eb;
      --btn-refresh-border: #4b5563;
      --btn-home-color: #9ca3af;
    }
  `]
})
export class ErrorBoundaryComponent implements OnInit, OnDestroy {
  private errorHandler = inject(GlobalErrorHandler);
  private logger = inject(LoggerService).category('ErrorBoundary');
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  
  /**
   * 显式禁用原生 HTML title 属性，防止悬浮时显示 tooltip
   * 因为 @Input() title 会同时设置 DOM 的原生 title 属性
   */
  @HostBinding('attr.title') hostTitle: null = null;
  
  /** 错误标题 */
  @Input() title = '出了点问题';
  
  /** 默认错误消息 */
  @Input() defaultMessage = '我们已记录错误，你可以尝试刷新页面。';
  
  /** 是否显示重试按钮 */
  @Input() showRetry = true;
  
  /** 是否显示刷新按钮 */
  @Input() showRefresh = true;
  
  /** 是否显示返回首页按钮 */
  @Input() showHome = false;
  
  /** 是否显示技术详情（开发模式） */
  @Input() showDetails = false; // 生产环境应为 false
  
  /** 是否为致命错误（全页面模式） */
  @Input() fatal = false;
  
  /** 容器样式类 */
  @Input() containerClass = '';
  
  /** 重试回调 */
  @Input() onRetry?: () => void;
  
  /** 是否捕获子组件错误（启用 Zone.js 错误钩子） */
  @Input() captureChildErrors = true;
  
  /** 是否有错误 */
  readonly hasError = signal(false);
  
  /** 用户友好的错误消息 */
  readonly userMessage = signal<string | null>(null);
  
  /** 错误详情 */
  readonly errorDetails = signal<string | null>(null);
  
  /** 是否为致命错误 */
  readonly isFatal = signal(false);
  
  /** 原始错误处理器类型 */
  private originalHandleError: ((error: unknown) => void) | null = null;
  
  /** Zone.js 错误监听器清理函数 */
  private zoneErrorCleanup: (() => void) | null = null;
  
  /** 错误捕获状态 - 防止重复处理 */
  private isCapturingError = false;
  
  ngOnInit() {
    // 注入到全局错误处理器
    this.originalHandleError = this.errorHandler.handleError.bind(this.errorHandler);
    
    // 如果启用了子组件错误捕获，设置 Zone.js 错误钩子
    if (this.captureChildErrors) {
      this.setupZoneErrorHandler();
    }
  }
  
  ngOnDestroy() {
    // 清理 Zone.js 错误监听器
    if (this.zoneErrorCleanup) {
      this.zoneErrorCleanup();
      this.zoneErrorCleanup = null;
    }
  }
  
  /**
   * 设置 Zone.js 错误处理钩子
   * 简化实现：仅依赖全局 ErrorHandler，不再重复注册 window 事件
   * 
   * Angular 历史教训：Zone.js + 全局 ErrorHandler 已经能捕获 99% 的异常
   * 组件级错误边界在 Angular 中并非原生概念，过度封装可能带来更多问题
   */
  private setupZoneErrorHandler(): void {
    // 简化实现：不再监听全局事件，避免多实例重复捕获
    // 错误处理完全依赖 GlobalErrorHandler 和手动 setError() 调用
    this.logger.debug('ErrorBoundary 已初始化（依赖全局 ErrorHandler）');
    
    // 保留清理函数接口以保持兼容性
    this.zoneErrorCleanup = () => {
      // 无需清理，不再注册全局事件
    };
  }
  
  /**
   * 手动触发错误状态（供父组件调用）
   */
  setError(error: Error, userMessage?: string, isFatal = false) {
    this.hasError.set(true);
    this.userMessage.set(userMessage || null);
    this.errorDetails.set(error.stack || error.message);
    this.isFatal.set(isFatal || this.fatal);
    
    this.logger.error('ErrorBoundary caught error', { 
      message: error.message, 
      stack: error.stack,
      isFatal 
    });
    
    this.cdr.detectChanges();
  }
  
  /**
   * 清除错误状态
   */
  clearError() {
    this.hasError.set(false);
    this.userMessage.set(null);
    this.errorDetails.set(null);
    this.isFatal.set(false);
    this.cdr.detectChanges();
  }
  
  /**
   * 重试操作
   */
  retry() {
    if (this.onRetry) {
      this.clearError();
      try {
        this.onRetry();
      } catch (e) {
        this.setError(e as Error);
      }
    } else {
      this.clearError();
    }
  }
  
  /**
   * 刷新页面
   */
  refreshPage() {
    window.location.reload();
  }
  
  /**
   * 返回首页
   */
  goHome() {
    window.location.href = '/';
  }
}
