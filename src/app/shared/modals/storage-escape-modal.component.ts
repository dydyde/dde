import { Component, EventEmitter, Input, Output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QueuedAction, DeadLetterItem } from '../../../services/action-queue.service';

/**
 * 存储失败逃生数据
 */
export interface StorageEscapeData {
  queue: QueuedAction[];
  deadLetter: DeadLetterItem[];
  /** 额外需要备份的项目数据（可选） */
  projects?: unknown[];
  /** 时间戳 */
  timestamp: string;
}

/**
 * 存储失败逃生模态框组件
 * 
 * 【设计理念】
 * 当持久化层彻底崩溃时（localStorage 和 IndexedDB 都失败），
 * 我们需要一种"机械式"的可靠性来保护用户数据。
 * 
 * 这个组件做的是：
 * 1. 把当前的脏数据序列化成 JSON 文本
 * 2. 显示在一个 <textarea> 里
 * 3. 让用户手动复制到剪贴板或保存为文件
 * 
 * 这确实不优雅，但在泰坦尼克号沉没时，
 * 你给用户的是救生圈，而不是一张"我们会重试浮起来"的空头支票。
 */
@Component({
  selector: 'app-storage-escape-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (isOpen()) {
      <div class="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <div class="bg-white dark:bg-stone-800 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden border-2 border-red-500">
          <!-- 头部 - 醒目的警告 -->
          <div class="bg-red-600 text-white p-4 flex items-center gap-3">
            <div class="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
              <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h2 class="text-xl font-bold">🚨 存储失败 - 数据紧急备份</h2>
              <p class="text-sm text-red-100 mt-1">浏览器存储不可用，请立即备份您的数据！</p>
            </div>
          </div>
          
          <!-- 内容区域 -->
          <div class="p-5 flex-1 overflow-y-auto">
            <!-- 说明文字 -->
            <div class="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-4 mb-4">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div class="text-sm text-amber-800 dark:text-amber-200">
                  <p class="font-medium mb-1">发生了什么？</p>
                  <p>浏览器的本地存储（localStorage/IndexedDB）无法写入数据。这可能是因为：</p>
                  <ul class="list-disc ml-5 mt-1 space-y-0.5">
                    <li>浏览器处于隐私/无痕模式</li>
                    <li>磁盘空间已满</li>
                    <li>存储配额已超限</li>
                    <li>浏览器权限被限制</li>
                  </ul>
                </div>
              </div>
            </div>
            
            <!-- 数据统计 -->
            <div class="grid grid-cols-2 gap-3 mb-4">
              <div class="bg-stone-100 dark:bg-stone-700 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{{ pendingCount() }}</div>
                <div class="text-xs text-stone-500 dark:text-stone-400">待同步操作</div>
              </div>
              <div class="bg-stone-100 dark:bg-stone-700 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-amber-600 dark:text-amber-400">{{ deadLetterCount() }}</div>
                <div class="text-xs text-stone-500 dark:text-stone-400">失败操作</div>
              </div>
            </div>
            
            <!-- JSON 数据区域 -->
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-sm font-medium text-stone-700 dark:text-stone-300">
                  备份数据 (JSON)
                </label>
                <span class="text-xs text-stone-500">
                  {{ jsonDataSize() }}
                </span>
              </div>
              <textarea
                #jsonTextarea
                readonly
                [value]="formattedJsonData()"
                class="w-full h-48 p-3 font-mono text-xs bg-stone-900 text-green-400 rounded-lg border border-stone-700 resize-none focus:outline-none focus:ring-2 focus:ring-red-500"
                (click)="selectAllText(jsonTextarea)"
              ></textarea>
            </div>
          </div>
          
          <!-- 底部操作区 -->
          <div class="p-4 bg-stone-50 dark:bg-stone-900 border-t border-stone-200 dark:border-stone-700">
            <div class="flex flex-col sm:flex-row gap-3">
              <!-- 复制按钮 -->
              <button 
                (click)="copyToClipboard()"
                class="flex-1 px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium flex items-center justify-center gap-2"
                [class.bg-green-600]="copySuccess()"
                [class.hover:bg-green-700]="copySuccess()">
                @if (copySuccess()) {
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>已复制到剪贴板</span>
                } @else {
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  <span>复制到剪贴板</span>
                }
              </button>
              
              <!-- 下载按钮 -->
              <button 
                (click)="downloadAsFile()"
                class="flex-1 px-4 py-3 bg-stone-700 text-white rounded-lg hover:bg-stone-800 transition-colors font-medium flex items-center justify-center gap-2">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>下载为文件</span>
              </button>
            </div>
            
            <!-- 关闭按钮（次要） -->
            <button 
              (click)="handleClose()"
              class="w-full mt-3 px-4 py-2 text-stone-600 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 text-sm transition-colors">
              我已备份，关闭此窗口
            </button>
            
            <!-- 警告文字 -->
            <p class="text-xs text-center text-red-600 dark:text-red-400 mt-2">
              ⚠️ 关闭此窗口后，未备份的数据可能会丢失！
            </p>
          </div>
        </div>
      </div>
    }
  `
})
export class StorageEscapeModalComponent {
  /** 逃生数据 */
  @Input() data: StorageEscapeData | null = null;
  
  /** 是否显示模态框 */
  @Input() set show(value: boolean) {
    this._isOpen.set(value);
  }
  
  /** 关闭事件 */
  @Output() close = new EventEmitter<void>();
  
  /** 内部状态：是否打开 */
  private _isOpen = signal(false);
  readonly isOpen = this._isOpen.asReadonly();
  
  /** 复制成功状态 */
  readonly copySuccess = signal(false);
  
  /** 待处理操作数量 */
  readonly pendingCount = computed(() => this.data?.queue?.length ?? 0);
  
  /** 死信队列数量 */
  readonly deadLetterCount = computed(() => this.data?.deadLetter?.length ?? 0);
  
  /** 格式化的 JSON 数据 */
  readonly formattedJsonData = computed(() => {
    if (!this.data) return '{}';
    return JSON.stringify(this.data, null, 2);
  });
  
  /** JSON 数据大小 */
  readonly jsonDataSize = computed(() => {
    const json = this.formattedJsonData();
    const bytes = new Blob([json]).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  });
  
  /**
   * 选中文本框全部内容
   */
  selectAllText(textarea: HTMLTextAreaElement): void {
    textarea.select();
  }
  
  /**
   * 复制到剪贴板
   */
  async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.formattedJsonData());
      this.copySuccess.set(true);
      setTimeout(() => this.copySuccess.set(false), 3000);
    } catch (e) {
      // 降级方案：使用 document.execCommand
      const textarea = document.createElement('textarea');
      textarea.value = this.formattedJsonData();
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.copySuccess.set(true);
      setTimeout(() => this.copySuccess.set(false), 3000);
    }
  }
  
  /**
   * 下载为文件
   */
  downloadAsFile(): void {
    const json = this.formattedJsonData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `nanoflow-backup-${timestamp}.json`;
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  /**
   * 关闭模态框
   */
  handleClose(): void {
    this._isOpen.set(false);
    this.close.emit();
  }
}
