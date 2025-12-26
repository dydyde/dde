import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/**
 * 错误恢复选项
 */
export interface ErrorRecoveryOption {
  /** 选项ID */
  id: string;
  /** 显示文本 */
  label: string;
  /** 选项描述 */
  description?: string;
  /** 按钮样式 */
  style: 'primary' | 'secondary' | 'danger';
  /** 图标（可选） */
  icon?: string;
}

/**
 * 错误恢复结果
 */
export interface ErrorRecoveryResult {
  /** 选择的选项ID */
  optionId: string;
  /** 是否记住选择 */
  rememberChoice?: boolean;
}

/**
 * 错误恢复模态组件
 * 
 * 在发生可恢复错误时，向用户展示友好的恢复选项
 * 例如：
 * - 网络错误：重试 / 离线模式
 * - 保存失败：重试 / 丢弃更改
 * - 同步冲突：使用本地 / 使用远程 / 合并
 */
@Component({
  selector: 'app-error-recovery-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
         (click)="onBackdropClick($event)">
      <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md mx-4 
                  transform transition-all animate-in fade-in zoom-in-95 duration-200"
           (click)="$event.stopPropagation()">
        
        <!-- 头部 -->
        <div class="p-6 pb-4">
          <!-- 图标 -->
          <div class="mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4"
               [class]="iconBgClass">
            <svg *ngIf="type === 'error'" class="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <svg *ngIf="type === 'warning'" class="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <svg *ngIf="type === 'info'" class="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          
          <!-- 标题 -->
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white text-center mb-2">
            {{ title }}
          </h3>
          
          <!-- 消息 -->
          <p class="text-sm text-gray-600 dark:text-gray-300 text-center">
            {{ message }}
          </p>
          
          <!-- 详细信息（可选） -->
          <details *ngIf="details" class="mt-3">
            <summary class="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200">
              查看详细信息
            </summary>
            <pre class="mt-2 p-2 bg-gray-100 dark:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-300 overflow-auto max-h-32">{{ details }}</pre>
          </details>
        </div>
        
        <!-- 选项按钮 -->
        <div class="p-4 pt-0 space-y-2">
          <button *ngFor="let option of options"
                  (click)="selectOption(option)"
                  class="w-full py-3 px-4 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                  [class]="getButtonClass(option.style)">
            <span>{{ option.label }}</span>
          </button>
        </div>
        
        <!-- 记住选择（可选） -->
        <div *ngIf="allowRememberChoice" class="px-6 pb-4">
          <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" 
                   [(ngModel)]="rememberChoice"
                   class="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500" />
            <span>记住此选择</span>
          </label>
        </div>
        
        <!-- 倒计时自动选择（可选） -->
        <div *ngIf="autoSelectIn !== null && autoSelectIn > 0" 
             class="px-6 pb-4 text-center">
          <p class="text-xs text-gray-500 dark:text-gray-400">
            将在 {{ autoSelectIn }} 秒后自动选择 "{{ defaultOption?.label }}"
          </p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes zoom-in-95 {
      from { transform: scale(0.95); }
      to { transform: scale(1); }
    }
    .animate-in {
      animation: fade-in 0.2s ease-out, zoom-in-95 0.2s ease-out;
    }
  `]
})
export class ErrorRecoveryModalComponent implements OnInit, OnDestroy {
  /** 对话框类型 */
  @Input() type: 'error' | 'warning' | 'info' = 'error';
  
  /** 标题 */
  @Input() title = '出错了';
  
  /** 消息 */
  @Input() message = '操作失败，请选择如何处理';
  
  /** 详细信息（技术细节，可折叠显示） */
  @Input() details?: string;
  
  /** 恢复选项 */
  @Input() options: ErrorRecoveryOption[] = [
    { id: 'retry', label: '重试', style: 'primary' },
    { id: 'ignore', label: '忽略', style: 'secondary' }
  ];
  
  /** 是否允许记住选择 */
  @Input() allowRememberChoice = false;
  
  /** 自动选择倒计时（秒），null表示不自动选择 */
  @Input() autoSelectIn: number | null = null;
  
  /** 默认选项ID（用于自动选择） */
  @Input() defaultOptionId?: string;
  
  /** 选择事件 */
  @Output() select = new EventEmitter<ErrorRecoveryResult>();
  
  /** 关闭事件（点击背景） */
  @Output() close = new EventEmitter<void>();
  
  /** 是否记住选择 */
  rememberChoice = false;
  
  /** 自动选择定时器 */
  private autoSelectTimer: ReturnType<typeof setInterval> | null = null;
  
  get iconBgClass(): string {
    switch (this.type) {
      case 'error': return 'bg-red-100 dark:bg-red-900/30';
      case 'warning': return 'bg-amber-100 dark:bg-amber-900/30';
      case 'info': return 'bg-blue-100 dark:bg-blue-900/30';
    }
  }
  
  get defaultOption(): ErrorRecoveryOption | undefined {
    return this.options.find(o => o.id === this.defaultOptionId) ?? this.options[0];
  }
  
  ngOnInit() {
    if (this.autoSelectIn !== null && this.autoSelectIn > 0) {
      this.startAutoSelectTimer();
    }
  }
  
  ngOnDestroy() {
    this.stopAutoSelectTimer();
  }
  
  getButtonClass(style: 'primary' | 'secondary' | 'danger'): string {
    switch (style) {
      case 'primary':
        return 'bg-blue-600 hover:bg-blue-700 text-white';
      case 'secondary':
        return 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200';
      case 'danger':
        return 'bg-red-600 hover:bg-red-700 text-white';
    }
  }
  
  selectOption(option: ErrorRecoveryOption): void {
    this.stopAutoSelectTimer();
    this.select.emit({
      optionId: option.id,
      rememberChoice: this.allowRememberChoice ? this.rememberChoice : undefined
    });
  }
  
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close.emit();
    }
  }
  
  private startAutoSelectTimer(): void {
    this.autoSelectTimer = setInterval(() => {
      if (this.autoSelectIn !== null) {
        this.autoSelectIn--;
        if (this.autoSelectIn <= 0) {
          this.stopAutoSelectTimer();
          if (this.defaultOption) {
            this.selectOption(this.defaultOption);
          }
        }
      }
    }, 1000);
  }
  
  private stopAutoSelectTimer(): void {
    if (this.autoSelectTimer) {
      clearInterval(this.autoSelectTimer);
      this.autoSelectTimer = null;
    }
  }
}
