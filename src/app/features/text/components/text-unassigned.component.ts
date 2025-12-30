import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy, ElementRef, HostListener, ChangeDetectorRef, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { StoreService } from '../../../../services/store.service';
import { Task } from '../../../../models';
import { renderMarkdownSafe } from '../../../../utils/markdown';

/**
 * 待分配区组件
 * 显示待分配任务列表，支持拖拽和编辑
 * 
 * 预览/编辑模式逻辑：
 * - 新建任务时直接进入编辑模式
 * - 查阅已有任务时默认为预览模式
 * - 预览模式下隐藏待办输入区域和操作按钮
 * - 点击内容区域切换到编辑模式
 * - 点击外部区域切换回预览模式
 */
@Component({
  selector: 'app-text-unassigned',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section 
      class="flex-none mt-1 mb-2 px-2 pb-1 rounded-xl bg-retro-teal/10 border border-retro-teal/30 transition-all"
      [ngClass]="{'mx-4 mt-2 mb-4': !isMobile, 'mx-2': isMobile}">
      
      <header 
        (click)="store.isTextUnassignedOpen.set(!store.isTextUnassignedOpen()); $event.stopPropagation()" 
        class="py-2 cursor-pointer flex justify-between items-center group select-none touch-manipulation"
        style="-webkit-tap-highlight-color: transparent;">
        <span class="font-bold text-retro-dark flex items-center gap-2 tracking-tight pointer-events-none"
              [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}">
          <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
          待分配
        </span>
        <span class="text-stone-300 text-xs group-hover:text-stone-500 transition-transform pointer-events-none" 
              [class.rotate-180]="!store.isTextUnassignedOpen()">▼</span>
      </header>

      @if (store.isTextUnassignedOpen()) {
        <div class="pb-2 animate-collapse-open">
          <div class="flex flex-wrap" [ngClass]="{'gap-2': !isMobile, 'gap-1.5': isMobile}">
            @for (task of store.unassignedTasks(); track task.id) {
              @if (editingTaskId() === task.id) {
                <!-- 编辑/预览模式 -->
                <div 
                  [attr.data-unassigned-task]="task.id"
                  class="w-full rounded-lg shadow-sm animate-collapse-open"
                  [ngClass]="{
                    'p-2 bg-white border border-retro-teal': isEditMode(),
                    'px-2 py-1.5 bg-retro-teal/5 border border-retro-teal/20 hover:border-retro-teal/40': !isEditMode()
                  }"
                  (click)="$event.stopPropagation()">
                  <div [ngClass]="{'space-y-1.5': isEditMode(), 'space-y-1': !isEditMode()}">
                    <!-- 标题 -->
                    <input
                      #titleInput
                      data-testid="task-title-input"
                      type="text"
                      [value]="localTitle()"
                      (input)="onTitleInput(task.id, titleInput.value)"
                      (focus)="onInputFocus('title'); switchToEditMode()"
                      (blur)="onInputBlur('title')"
                      (keydown.escape)="closeEditor()"
                      spellcheck="false"
                      class="w-full text-xs font-medium text-stone-800 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-retro-teal transition-colors"
                      [ngClass]="{
                        'bg-white border border-stone-200': isEditMode(),
                        'bg-transparent border-none p-0': !isEditMode()
                      }"
                      placeholder="任务名称..."
                      [attr.autofocus]="isEditMode() ? '' : null">
                    
                    <!-- 内容区域 - 预览/编辑切换 -->
                    <div class="relative">
                      @if (isEditMode()) {
                        <!-- 编辑模式：文本框 -->
                        <textarea
                          #contentInput
                          [value]="localContent()"
                          (input)="onContentInput(task.id, contentInput.value)"
                          (focus)="onInputFocus('content')"
                          (blur)="onInputBlur('content')"
                          (keydown.escape)="closeEditor()"
                          spellcheck="false"
                          class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-retro-teal bg-white resize-none font-mono h-10"
                          placeholder="任务描述..."></textarea>
                      } @else {
                        <!-- 预览模式：点击进入编辑 -->
                        @if (task.content) {
                          <div 
                            (click)="switchToEditMode()"
                            class="w-full text-[10px] text-stone-500 cursor-pointer hover:text-stone-600 transition-colors line-clamp-2 leading-relaxed"
                            [innerHTML]="renderMarkdown(task.content)">
                          </div>
                        }
                      }
                    </div>
                    
                    <!-- 快速待办输入 - 仅编辑模式显示 -->
                    @if (isEditMode()) {
                      <div class="flex items-center gap-0.5 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden">
                        <span class="text-retro-rust flex-shrink-0 text-[9px] pl-1">☐</span>
                        <input
                          #quickTodoInput
                          type="text"
                          (keydown.enter)="addQuickTodo(task.id, quickTodoInput.value, quickTodoInput)"
                          (focus)="onInputFocus('todo')"
                          (blur)="onInputBlur('todo')"
                          spellcheck="false"
                          class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[10px] py-0.5 px-1"
                          placeholder="待办，回车添加">
                        <button
                          (click)="addQuickTodo(task.id, quickTodoInput.value, quickTodoInput)"
                          class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded-sm p-0.5 transition-all"
                          title="添加待办">
                          <svg class="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                        </button>
                      </div>
                      
                      <!-- 操作按钮 -->
                      <div class="flex justify-end">
                        <button 
                          (click)="closeEditor()"
                          class="px-1.5 py-0.5 text-[9px] text-stone-500 hover:bg-stone-100 rounded transition-all">
                          完成
                        </button>
                      </div>
                    }
                  </div>
                </div>
              } @else {
                <!-- 收起的标签模式 -->
                <div 
                  [attr.data-unassigned-task]="task.id"
                  draggable="true"
                  (dragstart)="onDragStart($event, task)"
                  (dragend)="dragEnd.emit()"
                  (touchstart)="onTouchStart($event, task)"
                  (touchmove)="touchMove.emit($event)"
                  (touchend)="touchEnd.emit($event)"
                  (touchcancel)="touchCancel.emit($event)"
                  class="px-2 py-1 bg-panel/50 backdrop-blur-sm border border-retro-muted/30 rounded-md text-xs font-medium text-retro-muted hover:border-retro-teal hover:text-retro-teal cursor-grab active:cursor-grabbing transition-all"
                  [class.opacity-50]="draggingTaskId === task.id"
                  [class.touch-none]="draggingTaskId === task.id"
                  (click)="onTaskClick(task, false); $event.stopPropagation()">
                  {{task.title || '点击编辑...'}}
                </div>
              }
            } @empty {
              <span class="text-xs text-stone-400 italic py-1 font-light">暂无</span>
            }
            <button 
              data-testid="add-task-btn"
              (click)="createUnassigned.emit()" 
              class="px-2 py-1 bg-panel/30 hover:bg-retro-teal/20 text-retro-muted hover:text-retro-teal rounded-md text-xs font-medium transition-all">
              + 新建
            </button>
          </div>
        </div>
      }
    </section>
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
export class TextUnassignedComponent implements OnDestroy {
  readonly store = inject(StoreService);
  private readonly elementRef = inject(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly cdr = inject(ChangeDetectorRef);
  
  @Input() isMobile = false;
  @Input() draggingTaskId: string | null = null;
  
  @Output() taskClick = new EventEmitter<Task>();
  @Output() createUnassigned = new EventEmitter<void>();
  @Output() dragStart = new EventEmitter<{ event: DragEvent; task: Task }>();
  @Output() dragEnd = new EventEmitter<void>();
  @Output() touchStart = new EventEmitter<{ event: TouchEvent; task: Task }>();
  @Output() touchMove = new EventEmitter<TouchEvent>();
  @Output() touchEnd = new EventEmitter<TouchEvent>();
  @Output() touchCancel = new EventEmitter<TouchEvent>();
  
  /** 当前编辑的任务ID */
  readonly editingTaskId = signal<string | null>(null);
  
  /** 是否处于编辑模式（vs 预览模式） */
  readonly isEditMode = signal(false);
  
  // ========== Split-Brain 本地状态 ==========
  /** 本地标题 */
  protected readonly localTitle = signal('');
  /** 本地内容 */
  protected readonly localContent = signal('');
  /** 标题输入框是否聚焦 */
  private isTitleFocused = false;
  /** 内容输入框是否聚焦 */
  private isContentFocused = false;
  /** 解锁延迟定时器 */
  private unlockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  
  /** 标记是否正在打开新任务（防止立即被关闭） */
  private isOpening = false;
  
  constructor() {
    // Split-Brain 核心逻辑：仅在非聚焦时从 Store 同步到本地
    effect(() => {
      const taskId = this.editingTaskId();
      if (taskId) {
        const tasks = this.store.unassignedTasks();
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          if (!this.isTitleFocused) {
            this.localTitle.set(task.title || '');
          }
          if (!this.isContentFocused) {
            this.localContent.set(task.content || '');
          }
        }
      }
    });
  }
  
  ngOnDestroy(): void {
    for (const timer of this.unlockTimers.values()) {
      clearTimeout(timer);
    }
    this.unlockTimers.clear();
  }
  
  /** 监听 document 点击事件，当点击组件外部时切换回预览模式 */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    // 如果正在打开新任务，跳过此次检查
    if (this.isOpening) {
      return;
    }
    
    // 如果没有展开的任务，无需处理
    if (!this.editingTaskId()) return;
    
    // 检查点击是否在组件内部
    const clickedInside = this.elementRef.nativeElement.contains(event.target as Node);
    if (!clickedInside) {
      // 点击外部，关闭编辑器
      this.closeEditor();
    }
  }
  
  /** 渲染 Markdown */
  renderMarkdown(content: string) {
    return renderMarkdownSafe(content, this.sanitizer);
  }
  
  /** 切换到编辑模式 */
  switchToEditMode() {
    this.isEditMode.set(true);
  }
  
  /** 关闭编辑器 */
  closeEditor() {
    this.editingTaskId.set(null);
    this.isEditMode.set(false);
  }
  
  onTaskClick(task: Task, isNewTask: boolean = false) {
    // 标记正在打开任务，防止 document 点击事件立即关闭它
    this.isOpening = true;
    
    this.taskClick.emit(task);
    this.editingTaskId.set(task.id);
    // 新建任务时直接进入编辑模式，查阅已有任务时默认预览模式
    this.isEditMode.set(isNewTask);
    
    // 初始化本地状态
    this.localTitle.set(task.title || '');
    this.localContent.set(task.content || '');
    
    // 使用微任务延迟重置 isOpening 标记
    // 确保当前事件循环中的所有同步代码（包括 document 点击处理器）都执行完毕
    queueMicrotask(() => {
      this.isOpening = false;
    });
  }
  
  onDragStart(event: DragEvent, task: Task) {
    this.dragStart.emit({ event, task });
  }
  
  onTouchStart(event: TouchEvent, task: Task) {
    this.touchStart.emit({ event, task });
  }
  
  /**
   * 输入框聚焦处理（Split-Brain 模式）
   */
  onInputFocus(field: 'title' | 'content' | 'todo') {
    this.store.markEditing();
    
    const taskId = this.editingTaskId();
    if (!taskId) return;
    
    if (field === 'title') {
      this.isTitleFocused = true;
      const existingTimer = this.unlockTimers.get('title');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('title');
      }
      this.store.lockTaskFields(taskId, ['title']);
    } else if (field === 'content') {
      this.isContentFocused = true;
      const existingTimer = this.unlockTimers.get('content');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('content');
      }
      this.store.lockTaskFields(taskId, ['content']);
    }
  }
  
  /**
   * 输入框失焦处理（Split-Brain 模式）
   */
  onInputBlur(field: 'title' | 'content' | 'todo') {
    const taskId = this.editingTaskId();
    if (!taskId) return;
    
    if (field === 'title') {
      // 提交到 Store
      this.store.updateTaskTitle(taskId, this.localTitle());
      
      const timer = setTimeout(() => {
        this.isTitleFocused = false;
        this.store.unlockTaskFields(taskId, ['title']);
        this.unlockTimers.delete('title');
      }, 10000);
      this.unlockTimers.set('title', timer);
    } else if (field === 'content') {
      this.store.updateTaskContent(taskId, this.localContent());
      
      const timer = setTimeout(() => {
        this.isContentFocused = false;
        this.store.unlockTaskFields(taskId, ['content']);
        this.unlockTimers.delete('content');
      }, 10000);
      this.unlockTimers.set('content', timer);
    }
  }
  
  onTitleInput(taskId: string, value: string) {
    this.localTitle.set(value);
    this.store.updateTaskTitle(taskId, value);
  }
  
  onContentInput(taskId: string, value: string) {
    this.localContent.set(value);
    this.store.updateTaskContent(taskId, value);
  }
  
  addQuickTodo(taskId: string, text: string, inputElement: HTMLInputElement) {
    const trimmed = text.trim();
    if (!trimmed) return;
    
    this.store.addTodoItem(taskId, trimmed);
    inputElement.value = '';
    inputElement.focus();
  }
  
  /** 设置编辑任务（供父组件调用，用于新建任务或跳转） */
  setEditingTask(taskId: string | null, isNewTask: boolean = true): Promise<void> {
    this.editingTaskId.set(taskId);
    // 新建任务时直接进入编辑模式
    this.isEditMode.set(isNewTask && taskId !== null);
    
    // 初始化本地状态
    if (taskId) {
      const tasks = this.store.unassignedTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        this.localTitle.set(task.title || '');
        this.localContent.set(task.content || '');
      }
    }
    
    // 强制变更检测并等待 DOM 更新
    this.cdr.detectChanges();
    
    return new Promise(resolve => {
      requestAnimationFrame(() => resolve());
    });
  }
}
