import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { StoreService } from '../../services/store.service';
import { Task, Attachment } from '../../models';
import { renderMarkdownSafe } from '../../utils/markdown';
import { AttachmentManagerComponent } from '../attachment-manager.component';
import { TextTaskConnectionsComponent } from './text-task-connections.component';

/**
 * 任务编辑器组件（展开态）
 * 显示任务的完整编辑界面，包括标题、内容、待办、附件和操作按钮
 */
@Component({
  selector: 'app-text-task-editor',
  standalone: true,
  imports: [CommonModule, AttachmentManagerComponent, TextTaskConnectionsComponent],
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
          <div class="absolute top-1 right-1 z-10 flex gap-1">
            <button 
              (click)="togglePreview(); $event.stopPropagation()"
              class="px-2 py-0.5 text-[9px] rounded transition-all"
              [class.bg-indigo-500]="isPreview()"
              [class.text-white]="isPreview()"
              [class.bg-stone-100]="!isPreview()"
              [class.text-stone-500]="!isPreview()"
              [class.hover:bg-stone-200]="!isPreview()"
              title="切换预览/编辑">
              {{ isPreview() ? '编辑' : '预览' }}
            </button>
          </div>
          
          @if (isPreview()) {
            <!-- Markdown 预览 -->
            <div 
              class="w-full border border-retro-muted/20 rounded-lg bg-retro-muted/5 overflow-y-auto markdown-preview"
              [ngClass]="{'min-h-24 max-h-48 p-3 text-xs': !isMobile, 'min-h-28 max-h-40 p-2 text-[11px]': isMobile}"
              [innerHTML]="renderMarkdown(task.content)">
            </div>
          } @else {
            <!-- Markdown 编辑 -->
            <textarea 
              #contentInput
              [value]="task.content"
              (input)="onContentInput(contentInput.value)"
              (focus)="onInputFocus()"
              (blur)="onInputBlur()"
              class="w-full border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-white resize-none touch-manipulation"
              [ngClass]="{'h-24 text-xs p-2 pt-6': !isMobile, 'h-28 text-[11px] p-2 pt-6': isMobile}"
              placeholder="输入 Markdown 内容..."></textarea>
          }
        </div>
        
        <!-- 快速待办输入 -->
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
        
        <!-- 附件管理 -->
        @if (userId && projectId) {
          <app-attachment-manager
            [userId]="userId"
            [projectId]="projectId"
            [taskId]="task.id"
            [currentAttachments]="task.attachments"
            [compact]="isMobile"
            (attachmentsChange)="onAttachmentsChange($event)"
            (error)="attachmentError.emit($event)">
          </app-attachment-manager>
        }
        
        <!-- 操作按钮 -->
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
  
  readonly isPreview = signal(true);
  
  ngOnInit() {
    this.isPreview.set(this.initialPreview);
  }
  
  togglePreview() {
    this.isPreview.update(v => !v);
  }
  
  renderMarkdown(content: string) {
    return renderMarkdownSafe(content, this.sanitizer);
  }
  
  onInputFocus() {
    this.store.markEditing();
  }
  
  onInputBlur() {
    // 输入框失焦处理
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
}
