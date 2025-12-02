import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';

/**
 * 待分配区组件
 * 显示待分配任务列表，支持拖拽和编辑
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
        (click)="store.isTextUnassignedOpen.set(!store.isTextUnassignedOpen())" 
        class="py-2 cursor-pointer flex justify-between items-center group select-none">
        <span class="font-bold text-retro-dark flex items-center gap-2 tracking-tight"
              [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}">
          <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
          待分配
        </span>
        <span class="text-stone-300 text-xs group-hover:text-stone-500 transition-transform" 
              [class.rotate-180]="!store.isTextUnassignedOpen()">▼</span>
      </header>

      @if (store.isTextUnassignedOpen()) {
        <div class="pb-2 animate-collapse-open">
          <div class="flex flex-wrap" [ngClass]="{'gap-2': !isMobile, 'gap-1.5': isMobile}">
            @for (task of store.unassignedTasks(); track task.id) {
              @if (editingTaskId() === task.id) {
                <!-- 编辑模式 -->
                <div 
                  [attr.data-unassigned-task]="task.id"
                  class="w-full p-3 bg-white border-2 border-retro-teal rounded-lg shadow-md animate-collapse-open"
                  (click)="$event.stopPropagation()">
                  <div class="space-y-2">
                    <input
                      #titleInput
                      data-testid="task-title-input"
                      type="text"
                      [value]="task.title"
                      (input)="onTitleInput(task.id, titleInput.value)"
                      (focus)="onInputFocus()"
                      (blur)="onInputBlur()"
                      (keydown.escape)="editingTaskId.set(null)"
                      class="w-full text-sm font-medium text-stone-800 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-retro-teal bg-white"
                      placeholder="任务名称..."
                      autofocus>
                    <textarea
                      #contentInput
                      [value]="task.content"
                      (input)="onContentInput(task.id, contentInput.value)"
                      (focus)="onInputFocus()"
                      (blur)="onInputBlur()"
                      (keydown.escape)="editingTaskId.set(null)"
                      class="w-full text-xs text-stone-600 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-retro-teal bg-white resize-none font-mono h-16"
                      placeholder="任务描述..."></textarea>
                    
                    <!-- 快速待办输入 -->
                    <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded-lg overflow-hidden p-1">
                      <span class="text-retro-rust flex-shrink-0 text-xs pl-1.5">☐</span>
                      <input
                        #quickTodoInput
                        type="text"
                        (keydown.enter)="addQuickTodo(task.id, quickTodoInput.value, quickTodoInput)"
                        (focus)="onInputFocus()"
                        (blur)="onInputBlur()"
                        class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-xs py-1 px-1.5"
                        placeholder="输入待办，按回车添加...">
                      <button
                        (click)="addQuickTodo(task.id, quickTodoInput.value, quickTodoInput)"
                        class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-1 mr-0.5 transition-all"
                        title="添加待办">
                        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                          <line x1="12" y1="5" x2="12" y2="19"/>
                          <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                      </button>
                    </div>
                    
                    <div class="flex justify-end gap-2">
                      <button 
                        (click)="editingTaskId.set(null)"
                        class="px-3 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded transition-all"
                        title="按 ESC 键也可取消">
                        取消
                      </button>
                      <button 
                        (click)="editingTaskId.set(null)"
                        class="px-3 py-1 text-xs text-retro-teal hover:bg-retro-teal/10 rounded transition-all">
                        完成
                      </button>
                    </div>
                  </div>
                </div>
              } @else {
                <!-- 显示模式 -->
                <div 
                  [attr.data-unassigned-task]="task.id"
                  draggable="true"
                  (dragstart)="onDragStart($event, task)"
                  (dragend)="dragEnd.emit()"
                  (touchstart)="onTouchStart($event, task)"
                  (touchmove)="touchMove.emit($event)"
                  (touchend)="touchEnd.emit($event)"
                  class="px-2 py-1 bg-panel/50 backdrop-blur-sm border border-retro-muted/30 rounded-md text-xs font-medium text-retro-muted hover:border-retro-teal hover:text-retro-teal cursor-grab active:cursor-grabbing transition-all"
                  [class.opacity-50]="draggingTaskId === task.id"
                  [class.touch-none]="draggingTaskId === task.id"
                  (click)="onTaskClick(task)">
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
export class TextUnassignedComponent {
  readonly store = inject(StoreService);
  
  @Input() isMobile = false;
  @Input() draggingTaskId: string | null = null;
  
  @Output() taskClick = new EventEmitter<Task>();
  @Output() createUnassigned = new EventEmitter<void>();
  @Output() dragStart = new EventEmitter<{ event: DragEvent; task: Task }>();
  @Output() dragEnd = new EventEmitter<void>();
  @Output() touchStart = new EventEmitter<{ event: TouchEvent; task: Task }>();
  @Output() touchMove = new EventEmitter<TouchEvent>();
  @Output() touchEnd = new EventEmitter<TouchEvent>();
  
  /** 当前编辑的任务ID */
  readonly editingTaskId = signal<string | null>(null);
  
  onTaskClick(task: Task) {
    this.taskClick.emit(task);
    this.editingTaskId.set(task.id);
  }
  
  onDragStart(event: DragEvent, task: Task) {
    this.dragStart.emit({ event, task });
  }
  
  onTouchStart(event: TouchEvent, task: Task) {
    this.touchStart.emit({ event, task });
  }
  
  onInputFocus() {
    this.store.markEditing();
  }
  
  onInputBlur() {
    // 输入框失焦处理
  }
  
  onTitleInput(taskId: string, value: string) {
    this.store.updateTaskTitle(taskId, value);
  }
  
  onContentInput(taskId: string, value: string) {
    this.store.updateTaskContent(taskId, value);
  }
  
  addQuickTodo(taskId: string, text: string, inputElement: HTMLInputElement) {
    const trimmed = text.trim();
    if (!trimmed) return;
    
    this.store.addTodoItem(taskId, trimmed);
    inputElement.value = '';
    inputElement.focus();
  }
  
  /** 设置编辑任务（供父组件调用） */
  setEditingTask(taskId: string | null) {
    this.editingTaskId.set(taskId);
  }
}
