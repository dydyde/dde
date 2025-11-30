import { Component, inject, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { StoreService } from '../../services/store.service';
import { Task, Attachment } from '../../models';
import { renderMarkdownSafe, extractPlainText } from '../../utils/markdown';
import { AttachmentManagerComponent } from '../attachment-manager.component';

export interface OutgoingConnection {
  targetId: string;
  targetTask?: Task;
  description?: string;
}

export interface IncomingConnection {
  sourceId: string;
  sourceTask?: Task;
  description?: string;
}

export interface TaskConnections {
  outgoing: OutgoingConnection[];
  incoming: IncomingConnection[];
}

/**
 * 任务卡片组件
 * 展示单个任务，支持查看和编辑模式
 */
@Component({
  selector: 'app-task-card',
  standalone: true,
  imports: [CommonModule, AttachmentManagerComponent],
  template: `
    <div 
      [attr.data-task-id]="task().id"
      (click)="onCardClick($event)"
      [attr.draggable]="!isSelected()"
      (dragstart)="onDragStart($event)"
      (dragend)="dragEnd.emit()"
      (dragover)="onDragOver($event)"
      (touchstart)="onTouchStart($event)"
      (touchmove)="touchMove.emit($event)"
      (touchend)="touchEnd.emit($event)"
      class="relative bg-canvas/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden"
      [ngClass]="{
        'p-3': !isMobile(), 
        'p-2': isMobile(),
        'shadow-sm border-retro-muted/20': !isSelected(),
        'ring-1 ring-retro-gold shadow-md': isSelected(),
        'opacity-50 touch-none': isDragging()
      }">
      
      <!-- 头部信息 -->
      <div class="flex justify-between items-start"
           [ngClass]="{'mb-1': !isMobile(), 'mb-0.5': isMobile()}">
        <span class="font-mono font-medium text-retro-muted"
              [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">{{store.compressDisplayId(task().displayId)}}</span>
        <span class="text-retro-muted/60 font-light"
              [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">{{task().createdDate | date:'yyyy/MM/dd HH:mm'}}</span>
      </div>
      
      @if (!isSelected()) {
        <!-- 收起状态：简要信息 -->
        <div class="font-medium text-retro-dark leading-snug line-clamp-2"
             [ngClass]="{'text-sm mb-1': !isMobile(), 'text-xs mb-0.5': isMobile()}">{{task().title || '未命名任务'}}</div>
        <div class="text-stone-500 font-light leading-relaxed line-clamp-1"
             [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">{{contentPreview()}}</div>
      } @else {
        <!-- 展开编辑模式 -->
        <div class="animate-collapse-open"
             (click)="$event.stopPropagation()"
             [ngClass]="{'mt-2 flex gap-3': !isMobile(), 'mt-1.5': isMobile()}">
          
          <!-- 主编辑区域 -->
          <div [ngClass]="{'flex-1 space-y-2': !isMobile(), 'space-y-1.5': isMobile()}">
            <!-- 标题编辑 -->
            <input
              #titleInput
              data-title-input
              type="text"
              [value]="task().title"
              (input)="onTitleInput(titleInput.value)"
              (focus)="inputFocus.emit()"
              (blur)="inputBlur.emit()"
              class="w-full font-medium text-retro-dark border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none bg-stone-50 touch-manipulation"
              [ngClass]="{'text-sm p-2': !isMobile(), 'text-xs p-1.5': isMobile()}"
              placeholder="任务名称...">
            
            <!-- 内容编辑/预览 -->
            <div class="relative">
              <div class="absolute top-1 right-1 z-10 flex gap-1">
                <button 
                  (click)="togglePreview(); $event.stopPropagation()"
                  class="px-2 py-0.5 text-[9px] rounded transition-all"
                  [class.bg-indigo-500]="isPreviewMode()"
                  [class.text-white]="isPreviewMode()"
                  [class.bg-stone-100]="!isPreviewMode()"
                  [class.text-stone-500]="!isPreviewMode()"
                  [class.hover:bg-stone-200]="!isPreviewMode()"
                  title="切换预览/编辑">
                  {{ isPreviewMode() ? '编辑' : '预览' }}
                </button>
              </div>
              
              @if (isPreviewMode()) {
                <div 
                  class="w-full border border-stone-200 rounded-lg bg-white overflow-y-auto markdown-preview"
                  [ngClass]="{'min-h-24 max-h-48 p-3 text-xs': !isMobile(), 'min-h-28 max-h-40 p-2 text-[11px]': isMobile()}"
                  [innerHTML]="renderedMarkdown()">
                </div>
              } @else {
                <textarea 
                  #contentInput
                  [value]="task().content"
                  (input)="onContentInput(contentInput.value)"
                  (focus)="inputFocus.emit()"
                  (blur)="inputBlur.emit()"
                  class="w-full border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-stone-50 resize-none touch-manipulation"
                  [ngClass]="{'h-24 text-xs p-2 pt-6': !isMobile(), 'h-28 text-[11px] p-2 pt-6': isMobile()}"
                  placeholder="输入 Markdown 内容..."></textarea>
              }
            </div>
            
            <!-- 快速待办输入 -->
            <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded-lg overflow-hidden"
                 [ngClass]="{'p-1': !isMobile(), 'p-0.5': isMobile()}">
              <span class="text-retro-rust flex-shrink-0"
                    [ngClass]="{'text-xs pl-2': !isMobile(), 'text-[10px] pl-1.5': isMobile()}">☐</span>
              <input
                #quickTodoInput
                type="text"
                (keydown.enter)="onQuickTodoAdd(quickTodoInput)"
                (focus)="inputFocus.emit()"
                (blur)="inputBlur.emit()"
                class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400"
                [ngClass]="{'text-xs py-1.5 px-2': !isMobile(), 'text-[11px] py-1 px-1.5': isMobile()}"
                placeholder="输入待办内容，按回车添加...">
              <button
                (click)="onQuickTodoAdd(quickTodoInput)"
                class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded transition-all flex items-center justify-center"
                [ngClass]="{'p-1.5 mr-0.5': !isMobile(), 'p-1 mr-0.5': isMobile()}"
                title="添加待办">
                <svg [ngClass]="{'w-3.5 h-3.5': !isMobile(), 'w-3 h-3': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
            
            <!-- 附件管理 -->
            @if (userId() && projectId()) {
              <app-attachment-manager
                [userId]="userId()!"
                [projectId]="projectId()!"
                [taskId]="task().id"
                [currentAttachments]="task().attachments"
                [compact]="isMobile()"
                (attachmentsChange)="attachmentsChange.emit({ taskId: task().id, attachments: $event })"
                (error)="attachmentError.emit($event)">
              </app-attachment-manager>
            }
            
            <!-- 操作按钮 -->
            <div class="flex flex-wrap border-t border-stone-100"
                 [ngClass]="{'gap-2 pt-2': !isMobile(), 'gap-1.5 pt-1.5': isMobile()}">
              <button 
                (click)="addSibling.emit(task()); $event.stopPropagation()" 
                class="flex-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 font-medium rounded-md flex items-center justify-center transition-all"
                [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
                title="添加同级">
                <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                同级
              </button>
              <button 
                (click)="addChild.emit(task()); $event.stopPropagation()" 
                class="flex-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 font-medium rounded-md flex items-center justify-center transition-all"
                [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
                title="添加下级">
                <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                下级
              </button>
              <button 
                (click)="deleteTask.emit(task()); $event.stopPropagation()" 
                class="bg-stone-100 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 hover:border-red-500 font-medium rounded-md flex items-center justify-center transition-all"
                [ngClass]="{'px-2 py-1 text-xs': !isMobile(), 'px-1.5 py-0.5 text-[10px]': isMobile()}"
                title="删除任务">
                <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
          
          <!-- 关联区域 -->
          @if (connections(); as conns) {
            @if (conns.outgoing.length > 0 || conns.incoming.length > 0) {
              <div [ngClass]="{
                'flex-shrink-0 border-l border-violet-100 pl-2': !isMobile(),
                'w-36': !isMobile() && !isConnectionsCollapsed(),
                'w-8': !isMobile() && isConnectionsCollapsed(),
                'border-t border-violet-100 pt-2 mt-2': isMobile()
              }" class="transition-all duration-200">
                <div class="flex items-center gap-1 cursor-pointer select-none"
                     [ngClass]="{'mb-1.5': !isConnectionsCollapsed(), 'flex-col': !isMobile() && isConnectionsCollapsed()}"
                     (click)="isConnectionsCollapsed.set(!isConnectionsCollapsed()); $event.stopPropagation()">
                  <span class="text-violet-500 text-xs">🔗</span>
                  @if (!isConnectionsCollapsed()) {
                    <span class="text-[10px] font-medium text-violet-700">关联</span>
                    <span class="text-[9px] text-violet-400">({{conns.outgoing.length + conns.incoming.length}})</span>
                  } @else {
                    <span class="text-[9px] text-violet-400 font-bold">{{conns.outgoing.length + conns.incoming.length}}</span>
                  }
                  <svg class="w-3 h-3 text-violet-400 transition-transform ml-auto"
                       [ngClass]="{'rotate-180': isConnectionsCollapsed(), '-rotate-90': !isMobile() && !isConnectionsCollapsed(), 'rotate-0': isMobile() && !isConnectionsCollapsed()}"
                       fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                  </svg>
                </div>
                
                @if (!isConnectionsCollapsed()) {
                  <div class="animate-collapse-open">
                    @if (conns.outgoing.length > 0) {
                      <div class="mb-2">
                        <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
                          关联到
                        </div>
                        <div class="space-y-1">
                          @for (conn of conns.outgoing; track conn.targetId) {
                            <div class="flex items-start gap-2 p-1.5 bg-violet-50/50 rounded-lg border border-violet-100 group cursor-pointer hover:bg-violet-100/50 transition-all"
                                 (click)="conn.targetTask && openLinkedTask.emit(conn.targetTask); $event.stopPropagation()">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-1.5">
                                  <span class="text-[9px] font-bold text-violet-400">{{store.compressDisplayId(conn.targetTask?.displayId || '?')}}</span>
                                  <span class="text-[11px] text-violet-700 truncate font-medium">{{conn.targetTask?.title || '未命名'}}</span>
                                </div>
                                @if (conn.description) {
                                  <div class="text-[10px] text-violet-500 mt-0.5 italic truncate">"{{conn.description}}"</div>
                                }
                              </div>
                              <svg class="w-3 h-3 flex-shrink-0 text-violet-400 group-hover:text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                            </div>
                          }
                        </div>
                      </div>
                    }
                    
                    @if (conns.incoming.length > 0) {
                      <div>
                        <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16l-4-4m0 0l4-4m-4 4h18"/></svg>
                          被关联
                        </div>
                        <div class="space-y-1">
                          @for (conn of conns.incoming; track conn.sourceId) {
                            <div class="flex items-start gap-2 p-1.5 bg-indigo-50/50 rounded-lg border border-indigo-100 group cursor-pointer hover:bg-indigo-100/50 transition-all"
                                 (click)="conn.sourceTask && openLinkedTask.emit(conn.sourceTask); $event.stopPropagation()">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-1.5">
                                  <span class="text-[9px] font-bold text-indigo-400">{{store.compressDisplayId(conn.sourceTask?.displayId || '?')}}</span>
                                  <span class="text-[11px] text-indigo-700 truncate font-medium">{{conn.sourceTask?.title || '未命名'}}</span>
                                </div>
                                @if (conn.description) {
                                  <div class="text-[10px] text-indigo-500 mt-0.5 italic truncate">"{{conn.description}}"</div>
                                }
                              </div>
                              <svg class="w-3 h-3 flex-shrink-0 text-indigo-400 group-hover:text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                            </div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          }
        </div>
      }
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
export class TaskCardComponent {
  readonly store = inject(StoreService);
  private readonly sanitizer = inject(DomSanitizer);
  
  // 输入
  readonly task = input.required<Task>();
  readonly isMobile = input<boolean>(false);
  readonly isSelected = input<boolean>(false);
  readonly isDragging = input<boolean>(false);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  readonly connections = input<TaskConnections | null>(null);
  
  // 内部状态
  readonly isPreviewMode = signal(true);
  readonly isConnectionsCollapsed = signal(false);
  
  // 输出事件
  readonly select = output<Task>();
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly deleteTask = output<Task>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  readonly openLinkedTask = output<Task>();
  readonly inputFocus = output<void>();
  readonly inputBlur = output<void>();
  
  // 拖拽事件
  readonly dragStart = output<{ event: DragEvent; task: Task }>();
  readonly dragEnd = output<void>();
  readonly dragOver = output<{ event: DragEvent; task: Task }>();
  readonly touchStart = output<{ event: TouchEvent; task: Task }>();
  readonly touchMove = output<TouchEvent>();
  readonly touchEnd = output<TouchEvent>();
  
  // 计算属性
  readonly contentPreview = computed(() => extractPlainText(this.task().content, 80));
  readonly renderedMarkdown = computed(() => renderMarkdownSafe(this.task().content, this.sanitizer));
  
  togglePreview() {
    this.isPreviewMode.update(v => !v);
  }
  
  onCardClick(event: Event) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('input, textarea, button')) {
      return;
    }
    this.select.emit(this.task());
  }
  
  onTitleInput(value: string) {
    this.titleChange.emit({ taskId: this.task().id, title: value });
  }
  
  onContentInput(value: string) {
    this.contentChange.emit({ taskId: this.task().id, content: value });
  }
  
  onQuickTodoAdd(input: HTMLInputElement) {
    const text = input.value.trim();
    if (text) {
      this.quickTodoAdd.emit({ taskId: this.task().id, text });
      input.value = '';
      input.focus();
    }
  }
  
  onDragStart(event: DragEvent) {
    this.dragStart.emit({ event, task: this.task() });
  }
  
  onDragOver(event: DragEvent) {
    this.dragOver.emit({ event, task: this.task() });
  }
  
  onTouchStart(event: TouchEvent) {
    this.touchStart.emit({ event, task: this.task() });
  }
}
