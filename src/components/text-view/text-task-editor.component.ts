import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { StoreService } from '../../services/store.service';
import { AttachmentService } from '../../services/attachment.service';
import { ToastService } from '../../services/toast.service';
import { Task, Attachment } from '../../models';
import { renderMarkdownSafe } from '../../utils/markdown';
import { TextTaskConnectionsComponent } from './text-task-connections.component';

/**
 * 任务编辑器组件（展开态）
 * 显示任务的完整编辑界面，包括标题、内容、待办、附件和操作按钮
 * 
 * 预览模式逻辑：
 * - 默认进入编辑状态时为预览模式
 * - 点击预览区域进入编辑模式
 * - 点击空白区域（组件外部）自动切换回预览模式
 * - 预览模式下隐藏底部操作按钮（添加同级、添加下级、删除）
 */
@Component({
  selector: 'app-text-task-editor',
  standalone: true,
  imports: [CommonModule, TextTaskConnectionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="animate-collapse-open"
         (click)="$event.stopPropagation()"
         [ngClass]="{'mt-2 flex gap-3': !isMobile, 'mt-1.5': isMobile}">
      
      <!-- 主编辑区域 -->
      <div [ngClass]="{'flex-1 space-y-2': !isMobile, 'space-y-1.5': isMobile}">
        
          <!-- 标题编辑 -->
        <input
          #titleInput
          data-title-input
          type="text"
          [value]="task.title"
          (input)="onTitleInput(titleInput.value)"
          (focus)="onInputFocus()"
          (blur)="onInputBlur()"
          (mousedown)="isSelecting = true"
          (mouseup)="isSelecting = false"
          class="w-full font-medium text-retro-dark border rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none touch-manipulation transition-colors"
          [ngClass]="{
            'text-sm p-2': !isMobile, 
            'text-xs p-1.5': isMobile,
            'bg-retro-muted/5 border-retro-muted/20': isPreview(),
            'bg-white border-stone-200': !isPreview()
          }"
          placeholder="任务名称...">
        
        <!-- 内容编辑/预览 -->
        <div class="relative">
          <!-- 预览/编辑切换按钮 -->
          <div class="absolute top-1.5 right-1.5 z-10 flex gap-1">
            <button 
              (click)="togglePreview(); $event.stopPropagation()"
              class="px-1.5 py-0.5 text-[9px] rounded transition-all opacity-70 hover:opacity-100"
              [class.bg-indigo-500]="isPreview()"
              [class.text-white]="isPreview()"
              [class.bg-stone-200]="!isPreview()"
              [class.text-stone-500]="!isPreview()"
              [class.hover:bg-stone-300]="!isPreview()"
              title="切换预览/编辑">
              {{ isPreview() ? '编辑' : '预览' }}
            </button>
          </div>
          
          @if (isPreview()) {
            <!-- Markdown 预览 - 点击切换到编辑模式 -->
            <div 
              (click)="togglePreview(); $event.stopPropagation()"
              class="w-full border border-retro-muted/20 rounded-lg bg-retro-muted/5 overflow-y-auto markdown-preview cursor-pointer hover:border-stone-300 transition-colors"
              [ngClass]="{'min-h-24 max-h-48 p-3 text-xs': !isMobile, 'min-h-28 max-h-40 p-2 text-[11px]': isMobile}"
              [innerHTML]="task.content ? renderMarkdown(task.content) : '<span class=&quot;text-stone-400 italic&quot;>点击输入内容...</span>'"
              title="点击编辑">
            </div>
          } @else {
            <!-- Markdown 编辑 -->
            <textarea 
              #contentInput
              [value]="task.content"
              (input)="onContentInput(contentInput.value)"
              (focus)="onInputFocus()"
              (blur)="onInputBlur()"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              class="w-full border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-white resize-none touch-manipulation"
              [ngClass]="{'h-24 text-xs p-2 pr-14': !isMobile, 'h-28 text-[11px] p-2 pr-14': isMobile}"
              placeholder="输入 Markdown 内容..."></textarea>
          }
        </div>
        
        <!-- 快速待办输入 - 仅在编辑模式下显示 -->
        @if (!isPreview()) {
          <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded-lg overflow-hidden"
               [ngClass]="{'p-1': !isMobile, 'p-0.5': isMobile}">
            <span class="text-retro-rust flex-shrink-0"
                  [ngClass]="{'text-xs pl-2': !isMobile, 'text-[10px] pl-1.5': isMobile}">☐</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(quickTodoInput)"
              (focus)="onInputFocus()"
              (blur)="onInputBlur()"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400"
              [ngClass]="{'text-xs py-1.5 px-2': !isMobile, 'text-[11px] py-1 px-1.5': isMobile}"
              placeholder="输入待办内容，按回车添加...">
            <button
              (click)="addQuickTodo(quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded transition-all flex items-center justify-center"
              [ngClass]="{'p-1.5 mr-0.5': !isMobile, 'p-1 mr-0.5': isMobile}"
              title="添加待办">
              <svg [ngClass]="{'w-3.5 h-3.5': !isMobile, 'w-3 h-3': isMobile}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        }
        
        <!-- 桌面端：附件管理独立显示 - 暂时隐藏 -->
        <!-- @if (!isMobile && userId && projectId) {
          <app-attachment-manager
            [userId]="userId"
            [projectId]="projectId"
            [taskId]="task.id"
            [currentAttachments]="task.attachments"
            [compact]="false"
            (attachmentsChange)="onAttachmentsChange($event)"
            (error)="attachmentError.emit($event)">
          </app-attachment-manager>
        } -->
        
        <!-- 操作按钮 - 仅在编辑模式下显示 -->
        @if (!isPreview()) {
          <div class="flex flex-wrap border-t border-stone-100"
               [ngClass]="{'gap-2 pt-2': !isMobile, 'gap-1.5 pt-1.5': isMobile}">
            <button 
              (click)="addSibling.emit()" 
              class="flex-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile, 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile}"
              title="添加同级">
              <svg [ngClass]="{'w-3 h-3': !isMobile, 'w-2.5 h-2.5': isMobile}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              同级
            </button>
            <button 
              (click)="addChild.emit()" 
              class="flex-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile, 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile}"
              title="添加下级">
              <svg [ngClass]="{'w-3 h-3': !isMobile, 'w-2.5 h-2.5': isMobile}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 10 20 15 15 20"/>
                <path d="M4 4v7a4 4 0 0 0 4 4h12"/>
              </svg>
              下级
            </button>
            <!-- 移动端：附件按钮放在同一行 - 暂时隐藏 -->
            <!-- @if (isMobile && userId && projectId) {
              <label 
                class="flex-1 cursor-pointer text-[10px] px-1.5 py-0.5 bg-stone-50 hover:bg-stone-100 text-stone-500 hover:text-stone-700 rounded-md border border-stone-200 transition-colors flex items-center justify-center gap-0.5"
                [class.opacity-50]="isUploading()"
                [class.pointer-events-none]="isUploading()">
                <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                @if (isUploading()) {
                  上传中
                } @else {
                  附件
                }
                @if (task.attachments && task.attachments.length > 0) {
                  <span class="text-[8px] bg-indigo-100 text-indigo-600 px-0.5 rounded">{{ task.attachments.length }}</span>
                }
                <input 
                  type="file" 
                  class="hidden" 
                  multiple 
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md"
                  (change)="onMobileFileSelect($event)"
                  [disabled]="isUploading()">
              </label>
            } -->
            <button 
              (click)="deleteTask.emit()" 
              class="bg-stone-100 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 hover:border-red-500 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs': !isMobile, 'px-1.5 py-0.5 text-[10px]': isMobile}"
              title="删除任务">
              <svg [ngClass]="{'w-3 h-3': !isMobile, 'w-2.5 h-2.5': isMobile}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
          
          <!-- 移动端：附件列表折叠区（如果有附件）- 暂时隐藏 -->
          <!-- @if (isMobile && task.attachments && task.attachments.length > 0) {
            <div class="mt-1.5">
              <button 
                (click)="toggleAttachmentList()"
                class="w-full flex items-center justify-between px-2 py-1 bg-stone-50 hover:bg-stone-100 rounded text-[10px] text-stone-500 transition-colors">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  {{ task.attachments.length }} 个附件
                </span>
                <svg 
                  class="w-3 h-3 transition-transform" 
                  [class.rotate-180]="showAttachmentList()"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              @if (showAttachmentList()) {
                <div class="mt-1 p-1.5 bg-stone-50/50 rounded border border-stone-100 space-y-1 animate-collapse-open">
                  @for (attachment of task.attachments; track attachment.id) {
                    <div 
                      class="group flex items-center gap-1.5 px-1.5 py-1 bg-white hover:bg-stone-50 rounded text-[10px] text-stone-600 border border-stone-100 transition-colors"
                      [class.cursor-pointer]="attachment.type === 'image'"
                      (click)="attachment.type === 'image' && previewImage(attachment)">
                      @if (attachment.type === 'image' && attachment.thumbnailUrl) {
                        <img [src]="attachment.thumbnailUrl" [alt]="attachment.name" class="w-5 h-5 object-cover rounded">
                      } @else {
                        <span class="w-5 h-5 flex items-center justify-center text-[8px] text-stone-400 uppercase bg-stone-100 rounded">{{ getFileExtension(attachment.name) }}</span>
                      }
                      <span class="flex-1 truncate">{{ attachment.name }}</span>
                      <span class="text-[9px] text-stone-400">{{ formatFileSize(attachment.size) }}</span>
                      <button 
                        (click)="deleteAttachment(attachment, $event)"
                        class="text-stone-400 hover:text-red-500 transition-colors p-0.5"
                        title="删除">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          } -->
        }
      </div>
      
      <!-- 关联区域 -->
      <app-text-task-connections
        [connections]="connections"
        [isMobile]="isMobile"
        (openTask)="openLinkedTask.emit($event)">
      </app-text-task-connections>
    </div>
  `,
  styles: [`
    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
  `]
})
export class TextTaskEditorComponent {
  private readonly store = inject(StoreService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly elementRef = inject(ElementRef);
  private readonly attachmentService = inject(AttachmentService);
  private readonly toast = inject(ToastService);
  
  @Input({ required: true }) task!: Task;
  @Input() isMobile = false;
  @Input() userId: string | null = null;
  @Input() projectId: string | null = null;
  @Input() connections: any = null;
  @Input() initialPreview = true;
  
  @Output() addSibling = new EventEmitter<void>();
  @Output() addChild = new EventEmitter<void>();
  @Output() deleteTask = new EventEmitter<void>();
  @Output() attachmentError = new EventEmitter<string>();
  @Output() openLinkedTask = new EventEmitter<{ task: Task; event: Event }>();
  @Output() previewModeChange = new EventEmitter<boolean>();
  
  readonly isPreview = signal(true);
  readonly showAttachmentList = signal(false);
  readonly isUploading = signal(false);
  
  /** 标记是否正在进行文本选择操作 */
  isSelecting = false;
  
  /** 最大附件数量 */
  private readonly maxAttachments = 5;
  /** 最大文件大小 10MB */
  private readonly maxFileSize = 10 * 1024 * 1024;
  
  /** 
   * 监听 document 点击事件
   * 注意：任务卡片内的点击由 text-task-card 处理
   * 这里只处理点击到组件完全外部的情况（如页面其他区域）
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    // 如果已经是预览模式，无需处理
    if (this.isPreview()) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中（用户可能刚完成选择操作）
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      // 有文本被选中，不切换模式
      return;
    }
    
    // 检查点击是否在编辑器组件内部
    const clickedInside = this.elementRef.nativeElement.contains(event.target as Node);
    
    // 如果点击在编辑器内部，不做任何处理（允许正常的编辑操作，包括文本选择）
    if (clickedInside) return;
    
    // 点击在编辑器外部，检查是否在任务卡片内
    const target = event.target as HTMLElement;
    const clickedInTaskCard = target.closest(`[data-task-id="${this.task.id}"]`);
    
    if (!clickedInTaskCard) {
      // 点击完全在任务卡片外，切换到预览模式
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
    // 如果点击在任务卡片内但编辑器外（如卡片头部），由 text-task-card 处理
  }
  
  ngOnInit() {
    this.isPreview.set(this.initialPreview);
  }
  
  togglePreview() {
    const newValue = !this.isPreview();
    this.isPreview.set(newValue);
    this.previewModeChange.emit(newValue);
  }
  
  /**
   * 外部调用：强制切换到预览模式
   */
  setPreviewMode() {
    if (!this.isPreview()) {
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
  }
  
  renderMarkdown(content: string) {
    return renderMarkdownSafe(content, this.sanitizer);
  }
  
  onInputFocus() {
    this.store.markEditing();
  }
  
  onInputBlur() {
    // 输入框失焦处理
    // 延迟清除选择标记，确保点击事件已处理完毕
    setTimeout(() => {
      this.isSelecting = false;
    }, 100);
  }
  
  onTitleInput(value: string) {
    this.store.updateTaskTitle(this.task.id, value);
  }
  
  onContentInput(value: string) {
    this.store.updateTaskContent(this.task.id, value);
  }
  
  addQuickTodo(inputElement: HTMLInputElement) {
    const text = inputElement.value.trim();
    if (!text) return;
    
    this.store.addTodoItem(this.task.id, text);
    inputElement.value = '';
    inputElement.focus();
  }
  
  onAttachmentsChange(attachments: Attachment[]) {
    this.store.updateTaskAttachments(this.task.id, attachments);
  }
  
  // ========== 移动端附件管理方法 ==========
  
  toggleAttachmentList() {
    this.showAttachmentList.update(v => !v);
  }
  
  getFileExtension(filename: string): string {
    const ext = filename.split('.').pop() || '';
    return ext.length > 4 ? ext.substring(0, 4) : ext;
  }
  
  formatFileSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  
  async onMobileFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || !this.userId || !this.projectId) return;
    
    const currentCount = this.task.attachments?.length || 0;
    const remaining = this.maxAttachments - currentCount;
    
    if (remaining <= 0) {
      this.toast.warning('附件数量已达上限', `每个任务最多 ${this.maxAttachments} 个附件`);
      input.value = '';
      return;
    }
    
    const filesToUpload = Array.from(files).slice(0, remaining);
    
    // 检查文件大小
    for (const file of filesToUpload) {
      if (file.size > this.maxFileSize) {
        this.toast.warning('文件过大', `${file.name} 超过 10MB 限制`);
        input.value = '';
        return;
      }
    }
    
    this.isUploading.set(true);
    
    try {
      const newAttachments: Attachment[] = [];
      
      for (const file of filesToUpload) {
        const result = await this.attachmentService.uploadFile(
          this.userId,
          this.projectId,
          this.task.id,
          file
        );
        if (result.success && result.attachment) {
          newAttachments.push(result.attachment);
        } else if (result.error) {
          this.attachmentError.emit(result.error);
        }
      }
      
      if (newAttachments.length > 0) {
        const updatedAttachments = [...(this.task.attachments || []), ...newAttachments];
        this.store.updateTaskAttachments(this.task.id, updatedAttachments);
        this.toast.success('上传成功', `${newAttachments.length} 个文件已上传`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '上传失败';
      this.attachmentError.emit(errorMsg);
      this.toast.error('上传失败', errorMsg);
    } finally {
      this.isUploading.set(false);
      input.value = '';
    }
  }
  
  async deleteAttachment(attachment: Attachment, event: Event) {
    event.stopPropagation();
    
    if (!this.userId || !this.projectId) return;
    
    try {
      // 使用软删除标记附件
      const deletedAttachment = this.attachmentService.markAsDeleted(attachment);
      
      const updatedAttachments = (this.task.attachments || []).map(a => 
        a.id === attachment.id ? deletedAttachment : a
      );
      this.store.updateTaskAttachments(this.task.id, updatedAttachments);
      this.toast.success('删除成功', `${attachment.name} 已删除`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '删除失败';
      this.attachmentError.emit(errorMsg);
      this.toast.error('删除失败', errorMsg);
    }
  }
  
  previewImage(attachment: Attachment) {
    if (attachment.url) {
      window.open(attachment.url, '_blank');
    }
  }
}
