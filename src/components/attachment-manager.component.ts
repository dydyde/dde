import { Component, input, Output, EventEmitter, inject, signal, computed, effect, OnInit, OnDestroy, Injector } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AttachmentService } from '../services/attachment.service';
import { ToastService } from '../services/toast.service';
import { Attachment } from '../models';

/**
 * 附件管理组件
 * 用于任务编辑中的附件上传、展示、下载和删除
 * 
 * 功能特性：
 * - 自动监控附件 URL 过期并刷新
 * - 支持图片预览、文件下载
 * - 原子级操作事件通知
 */
@Component({
  selector: 'app-attachment-manager',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- 紧凑模式：只显示一个附件按钮 -->
    @if (compact()) {
      <div class="flex items-center gap-1.5 mt-2 pt-2 border-t border-stone-100">
        <!-- 附件按钮 -->
        @if (canAddMore()) {
          <label 
            class="cursor-pointer text-[10px] px-2 py-1 bg-stone-50 hover:bg-stone-100 text-stone-500 hover:text-stone-700 rounded border border-stone-200 transition-colors flex items-center gap-1"
            [class.opacity-50]="isUploading()"
            [class.pointer-events-none]="isUploading()">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            @if (isUploading()) {
              上传中...
            } @else {
              附件
            }
            @if (attachments().length > 0) {
              <span class="text-[9px] bg-indigo-100 text-indigo-600 px-1 rounded">{{ attachments().length }}</span>
            }
            <input 
              type="file" 
              class="hidden" 
              multiple 
              [accept]="acceptedTypes"
              (change)="onFileSelect($event)"
              [disabled]="isUploading()">
          </label>
        } @else {
          <span class="text-[10px] text-stone-400 flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            附件已满
          </span>
        }
        
        <!-- 已有附件的横向滚动列表 -->
        @if (attachments().length > 0) {
          <div class="flex-1 flex gap-1 overflow-x-auto scrollbar-hide">
            @for (attachment of attachments(); track attachment.id) {
              <div 
                class="group relative flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 bg-stone-50 hover:bg-stone-100 rounded text-[10px] text-stone-600 border border-stone-100 transition-colors"
                [class.cursor-pointer]="attachment.type === 'image'"
                (click)="attachment.type === 'image' && previewImage(attachment)">
                @if (attachment.type === 'image' && attachment.thumbnailUrl) {
                  <img [src]="attachment.thumbnailUrl" [alt]="attachment.name" class="w-4 h-4 object-cover rounded" (error)="onThumbnailError($event, attachment)">
                } @else {
                  <span class="text-[8px] text-stone-400 uppercase">{{ getFileExtension(attachment.name) }}</span>
                }
                <span class="max-w-16 truncate">{{ attachment.name }}</span>
                @if (isProcessing(attachment.id)) {
                  <svg class="w-3 h-3 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                } @else {
                  <button 
                    (click)="deleteAttachment(attachment, $event)"
                    class="opacity-0 group-hover:opacity-100 text-stone-400 hover:text-red-500 transition-all"
                    title="删除">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                }
              </div>
            }
          </div>
        }
      </div>
      
      <!-- 上传进度（紧凑模式） -->
      @if (uploadProgress().length > 0) {
        <div class="mt-1 space-y-0.5">
          @for (progress of uploadProgress(); track progress.fileName) {
            <div class="flex items-center gap-1 text-[9px] px-1 py-0.5 bg-stone-50 rounded">
              <span class="truncate max-w-24 text-stone-500">{{ progress.fileName }}</span>
              <div class="flex-1 h-0.5 bg-stone-200 rounded-full overflow-hidden">
                <div 
                  class="h-full transition-all duration-300"
                  [class.bg-indigo-500]="progress.status === 'uploading'"
                  [class.bg-green-500]="progress.status === 'completed'"
                  [class.bg-red-500]="progress.status === 'error'"
                  [style.width.%]="progress.progress">
                </div>
              </div>
            </div>
          }
        </div>
      }
    } @else {
      <!-- 完整模式：保持原有的区域展示 -->
      <div class="border-t border-stone-100 pt-2 mt-2">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-medium text-stone-500 flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            附件 ({{ attachments().length }}/{{ maxAttachments }})
            <span class="text-stone-400">· 单文件≤10MB</span>
          </span>
          
          @if (canAddMore()) {
            <label 
              class="cursor-pointer text-[10px] px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded transition-colors flex items-center gap-1"
              [class.opacity-50]="isUploading()"
              [class.pointer-events-none]="isUploading()">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              上传
              <input 
                type="file" 
                class="hidden" 
                multiple 
                [accept]="acceptedTypes"
                (change)="onFileSelect($event)"
                [disabled]="isUploading()">
            </label>
          }
        </div>
        
        <!-- 上传进度 -->
        @if (uploadProgress().length > 0) {
          <div class="space-y-1 mb-2">
            @for (progress of uploadProgress(); track progress.fileName) {
              <div class="flex items-center gap-2 text-[10px] p-1.5 bg-stone-50 rounded">
                <div class="flex-1 min-w-0">
                  <div class="truncate text-stone-600">{{ progress.fileName }}</div>
                  <div class="h-1 bg-stone-200 rounded-full mt-1 overflow-hidden">
                    <div 
                      class="h-full transition-all duration-300"
                      [class.bg-indigo-500]="progress.status === 'uploading'"
                      [class.bg-green-500]="progress.status === 'completed'"
                      [class.bg-red-500]="progress.status === 'error'"
                      [style.width.%]="progress.progress">
                    </div>
                  </div>
                </div>
                @if (progress.status === 'error') {
                  <span class="text-red-500 text-[9px]">{{ progress.error }}</span>
                }
              </div>
            }
          </div>
        }
        
        <!-- 附件列表 -->
        @if (attachments().length > 0) {
          <div class="grid gap-1.5 grid-cols-1">
            @for (attachment of attachments(); track attachment.id) {
              <div 
                class="group relative flex items-center gap-2 p-1.5 bg-stone-50 hover:bg-stone-100 rounded border border-stone-100 transition-colors"
                [class.cursor-pointer]="attachment.type === 'image'"
                (click)="attachment.type === 'image' && previewImage(attachment)">
                
                @if (attachment.type === 'image' && attachment.thumbnailUrl) {
                  <img 
                    [src]="attachment.thumbnailUrl" 
                    [alt]="attachment.name"
                    class="w-8 h-8 object-cover rounded flex-shrink-0"
                    (error)="onThumbnailError($event, attachment)">
                } @else {
                  <div class="w-8 h-8 rounded bg-stone-200 flex items-center justify-center flex-shrink-0">
                    <span class="text-[10px] text-stone-500 uppercase">{{ getFileExtension(attachment.name) }}</span>
                  </div>
                }
                
                <div class="flex-1 min-w-0">
                  <div class="text-[11px] text-stone-700 truncate" [title]="attachment.name">{{ attachment.name }}</div>
                  <div class="text-[9px] text-stone-400">{{ formatFileSize(attachment.size) }}</div>
                </div>
                
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  @if (isProcessing(attachment.id)) {
                    <div class="p-1">
                      <svg class="w-3 h-3 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </div>
                  } @else {
                    <button 
                      (click)="downloadAttachment(attachment, $event)"
                      class="p-1 hover:bg-white rounded transition-colors"
                      title="下载">
                      <svg class="w-3 h-3 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </button>
                    <button 
                      (click)="deleteAttachment(attachment, $event)"
                      class="p-1 hover:bg-red-50 rounded transition-colors"
                      title="删除">
                      <svg class="w-3 h-3 text-stone-400 hover:text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  }
                </div>
              </div>
            }
          </div>
        } @else if (!isUploading()) {
          <div class="text-[10px] text-stone-400 italic py-2 text-center">
            暂无附件，点击上传添加
          </div>
        }
      </div>
    }
    
    <!-- 图片预览模态框 -->
    @if (previewingImage()) {
      <div 
        class="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
        (click)="closePreview()">
        <div class="relative max-w-full max-h-full">
          <img 
            [src]="previewingImage()!.url" 
            [alt]="previewingImage()!.name"
            class="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl">
          <button 
            class="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
            (click)="closePreview()">
            <svg class="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div class="absolute bottom-2 left-2 right-2 text-center text-white text-sm bg-black/50 rounded py-1 px-2">
            {{ previewingImage()!.name }}
          </div>
        </div>
      </div>
    }
  `
})
export class AttachmentManagerComponent implements OnInit, OnDestroy {
  private attachmentService = inject(AttachmentService);
  private toastService = inject(ToastService);
  private injector = inject(Injector);
  
  /** 用户 ID（必需） */
  readonly userId = input.required<string>();
  
  /** 项目 ID（必需） */
  readonly projectId = input.required<string>();
  
  /** 任务 ID（必需） */
  readonly taskId = input.required<string>();
  
  /** 当前附件列表 */
  readonly currentAttachments = input<Attachment[] | undefined>();
  
  /** 紧凑模式 */
  readonly compact = input<boolean>(false);
  
  /** 附件更新事件（全量替换，向后兼容） */
  @Output() attachmentsChange = new EventEmitter<Attachment[]>();
  
  /** 添加附件事件（原子操作） */
  @Output() attachmentAdd = new EventEmitter<Attachment>();
  
  /** 移除附件事件（原子操作） */
  @Output() attachmentRemove = new EventEmitter<string>();
  
  /** 错误事件 */
  @Output() error = new EventEmitter<string>();
  
  // 内部状态
  readonly attachments = signal<Attachment[]>([]);
  readonly previewingImage = signal<Attachment | null>(null);
  /** 正在处理中的附件 ID 集合（下载/删除操作） */
  readonly processingIds = signal<Set<string>>(new Set());
  
  /** 检查附件是否正在处理中 */
  isProcessing(attachmentId: string): boolean {
    return this.processingIds().has(attachmentId);
  }
  
  /** 标记附件为处理中 */
  private markProcessing(attachmentId: string): void {
    this.processingIds.update(set => new Set(set).add(attachmentId));
  }
  
  /** 取消附件的处理中状态 */
  private unmarkProcessing(attachmentId: string): void {
    this.processingIds.update(set => {
      const newSet = new Set(set);
      newSet.delete(attachmentId);
      return newSet;
    });
  }
  
  // 追踪已监控的附件 ID
  private monitoredAttachmentIds = new Set<string>();
  
  // 当外部附件列表变化时，同步内部状态并更新监控
  private attachmentsSync = effect(() => {
    const current = this.currentAttachments();
    this.attachments.set(current || []);
    
    // 更新附件监控
    this.updateAttachmentMonitoring(current || []);
  }, { injector: this.injector });
  
  // 代理服务状态
  readonly uploadProgress = this.attachmentService.uploadProgress;
  readonly isUploading = this.attachmentService.isUploading;
  
  // 配置
  readonly maxAttachments = 20;
  readonly maxFileSizeBytes = 10 * 1024 * 1024; // 10MB
  readonly acceptedTypes = 'image/*,application/pdf,text/*,.doc,.docx';
  
  // 计算属性
  readonly canAddMore = computed(() => {
    return this.attachments().length < this.maxAttachments && !this.isUploading();
  });
  
  ngOnInit() {
    // 注册 URL 刷新回调
    this.attachmentService.setUrlRefreshCallback((refreshedUrls) => {
      this.onUrlsRefreshed(refreshedUrls);
    });
  }
  
  ngOnDestroy() {
    // 取消所有附件监控
    for (const attachmentId of this.monitoredAttachmentIds) {
      this.attachmentService.unmonitorAttachment(attachmentId);
    }
    this.monitoredAttachmentIds.clear();
  }
  
  /**
   * 更新附件监控 - 添加新附件的监控，移除已删除附件的监控
   */
  private updateAttachmentMonitoring(attachments: Attachment[]) {
    const currentIds = new Set(attachments.map(a => a.id));
    const userId = this.userId();
    const projectId = this.projectId();
    const taskId = this.taskId();
    
    // 验证必要参数
    if (!userId || !projectId || !taskId) return;
    
    // 移除不再存在的附件监控
    for (const id of this.monitoredAttachmentIds) {
      if (!currentIds.has(id)) {
        this.attachmentService.unmonitorAttachment(id);
        this.monitoredAttachmentIds.delete(id);
      }
    }
    
    // 添加新附件的监控
    for (const attachment of attachments) {
      if (!this.monitoredAttachmentIds.has(attachment.id)) {
        this.attachmentService.monitorAttachment(userId, projectId, taskId, attachment);
        this.monitoredAttachmentIds.add(attachment.id);
      }
    }
  }
  
  /**
   * URL 批量刷新回调处理
   */
  private onUrlsRefreshed(refreshedUrls: Map<string, { url: string; thumbnailUrl?: string }>) {
    if (refreshedUrls.size === 0) return;
    
    // 检查是否有当前组件的附件被刷新
    let hasUpdates = false;
    const newAttachments = this.attachments().map(a => {
      const refreshed = refreshedUrls.get(a.id);
      if (refreshed) {
        hasUpdates = true;
        return { ...a, url: refreshed.url, thumbnailUrl: refreshed.thumbnailUrl ?? a.thumbnailUrl };
      }
      return a;
    });
    
    if (hasUpdates) {
      this.attachments.set(newAttachments);
      this.attachmentsChange.emit(newAttachments);
    }
  }
  
  /**
   * 文件选择处理
   */
  async onFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    
    if (!files || files.length === 0) return;
    
    const userIdVal = this.userId();
    const projectIdVal = this.projectId();
    const taskIdVal = this.taskId();
    
    // 输入验证（虽然使用 input.required 但仍保留运行时检查）
    if (!userIdVal || !projectIdVal || !taskIdVal) {
      this.error.emit('缺少必要参数：用户、项目或任务 ID');
      return;
    }
    
    // 检查是否超过限制
    const remainingSlots = this.maxAttachments - this.attachments().length;
    if (files.length > remainingSlots) {
      this.error.emit(`最多还能上传 ${remainingSlots} 个附件`);
    }
    
    // 上传文件
    const filesToUpload = Array.from(files).slice(0, remainingSlots);
    
    // 检查文件大小限制
    const oversizedFiles = filesToUpload.filter(f => f.size > this.maxFileSizeBytes);
    if (oversizedFiles.length > 0) {
      const names = oversizedFiles.map(f => f.name).join(', ');
      this.error.emit(`以下文件超过 10MB 限制: ${names}`);
      // 过滤掉超大文件继续上传
      const validFiles = filesToUpload.filter(f => f.size <= this.maxFileSizeBytes);
      if (validFiles.length === 0) {
        input.value = '';
        return;
      }
    }
    
    const validFilesToUpload = filesToUpload.filter(f => f.size <= this.maxFileSizeBytes);
    const result = await this.attachmentService.uploadFiles(
      userIdVal,
      projectIdVal,
      taskIdVal,
      validFilesToUpload
    );
    
    // 处理结果 - 使用原子操作
    if (result.attachments.length > 0) {
      for (const attachment of result.attachments) {
        // 发出原子添加事件
        this.attachmentAdd.emit(attachment);
      }
      // 更新本地状态
      const newAttachments = [...this.attachments(), ...result.attachments];
      this.attachments.set(newAttachments);
      // 也发出全量事件（向后兼容）
      this.attachmentsChange.emit(newAttachments);
    }
    
    if (result.errors.length > 0) {
      const errorMessage = result.errors.join('\n');
      // 内部 toast 提示，确保用户感知错误
      this.toastService.error('附件上传失败', errorMessage);
      // 同时发出事件供父组件处理（向后兼容）
      this.error.emit(errorMessage);
    }
    
    // 重置 input
    input.value = '';
  }
  
  /**
   * 下载附件
   */
  async downloadAttachment(attachment: Attachment, event: Event) {
    event.stopPropagation();
    
    // 防止重复点击
    if (this.isProcessing(attachment.id)) return;
    
    // 如果有签名 URL，直接打开（无需 loading）
    if (attachment.url) {
      window.open(attachment.url, '_blank');
      return;
    }
    
    // 标记为处理中
    this.markProcessing(attachment.id);
    
    try {
      // 尝试下载
      const blob = await this.attachmentService.downloadFile(
        this.userId(),
        this.projectId(),
        this.taskId(),
        attachment
      );
      
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = attachment.name;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const errorMessage = `下载失败: ${attachment.name}`;
        this.toastService.error('下载失败', errorMessage);
        this.error.emit(errorMessage);
      }
    } finally {
      this.unmarkProcessing(attachment.id);
    }
  }
  
  /**
   * 删除附件
   */
  async deleteAttachment(attachment: Attachment, event: Event) {
    event.stopPropagation();
    
    // 防止重复点击
    if (this.isProcessing(attachment.id)) return;
    
    // 标记为处理中
    this.markProcessing(attachment.id);
    
    try {
      const fileExt = attachment.name.split('.').pop() || '';
      const result = await this.attachmentService.deleteFile(
        this.userId(),
        this.projectId(),
        this.taskId(),
        attachment.id,
        fileExt
      );
      
      if (result.success) {
        // 发出原子移除事件
        this.attachmentRemove.emit(attachment.id);
        // 更新本地状态
        const newAttachments = this.attachments().filter(a => a.id !== attachment.id);
        this.attachments.set(newAttachments);
        // 也发出全量事件（向后兼容）
        this.attachmentsChange.emit(newAttachments);
        this.toastService.success('删除成功', `已删除 ${attachment.name}`);
      } else {
        const errorMessage = result.error || '删除失败';
        this.toastService.error('删除失败', errorMessage);
        this.error.emit(errorMessage);
      }
    } finally {
      this.unmarkProcessing(attachment.id);
    }
  }
  
  /**
   * 预览图片
   */
  previewImage(attachment: Attachment) {
    if (attachment.type === 'image') {
      this.previewingImage.set(attachment);
    }
  }
  
  /**
   * 关闭预览
   */
  closePreview() {
    this.previewingImage.set(null);
  }
  
  /**
   * 缩略图加载失败处理
   */
  onThumbnailError(event: Event, attachment: Attachment) {
    // 尝试刷新 URL
    this.refreshAttachmentUrl(attachment);
  }
  
  /**
   * 刷新附件 URL
   */
  private async refreshAttachmentUrl(attachment: Attachment) {
    const result = await this.attachmentService.refreshUrl(
      this.userId(),
      this.projectId(),
      this.taskId(),
      attachment
    );
    
    if (result) {
      const newAttachments = this.attachments().map(a => 
        a.id === attachment.id 
          ? { ...a, url: result.url, thumbnailUrl: result.thumbnailUrl }
          : a
      );
      this.attachments.set(newAttachments);
      this.attachmentsChange.emit(newAttachments);
    }
  }
  
  /**
   * 获取文件扩展名
   */
  getFileExtension(filename: string): string {
    const ext = filename.split('.').pop() || '';
    return ext.length > 4 ? ext.substring(0, 4) : ext;
  }
  
  /**
   * 格式化文件大小
   */
  formatFileSize(bytes?: number): string {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}
