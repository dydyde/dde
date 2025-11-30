import { Component, inject, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';
import { TaskCardComponent, TaskConnections } from './task-card.component';

export interface Stage {
  stageNumber: number;
  tasks: Task[];
}

export interface DropTargetInfo {
  stageNumber: number;
  beforeTaskId: string | null;
}

/**
 * 阶段列表组件
 * 展示所有阶段和任务，支持筛选、拖拽
 */
@Component({
  selector: 'app-stage-list',
  standalone: true,
  imports: [CommonModule, TaskCardComponent],
  template: `
    <section 
      class="flex-1 min-h-0 overflow-hidden flex flex-col"
      [ngClass]="{'px-4 pb-6': !isMobile(), 'px-2 pb-4': isMobile()}">
      <div 
        class="rounded-xl bg-panel/40 border border-retro-muted/20 backdrop-blur-md px-2 py-2 shadow-inner w-full h-full flex flex-col overflow-hidden"
        [ngClass]="{'rounded-2xl px-4 py-3': !isMobile()}">
        
        <!-- 筛选栏 -->
        <div class="flex items-center justify-between text-stone-500"
             [ngClass]="{'mb-3': !isMobile(), 'mb-2': isMobile()}">
          <!-- 阶段筛选 -->
          <div class="flex items-center gap-1 relative">
            <span class="font-medium text-retro-muted" 
                  [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">阶段</span>
            <button 
              (click)="toggleStageFilter($event)"
              class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
              [ngClass]="{'text-xs px-3 py-1.5': !isMobile(), 'text-[10px] px-2 py-1': isMobile()}">
              <span>{{ currentStageLabel() }}</span>
              <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile(), 'h-2.5 w-2.5': isMobile()}" [class.rotate-180]="isStageFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            @if (isStageFilterOpen()) {
              <div class="fixed inset-0 z-40" (click)="isStageFilterOpen.set(false)"></div>
              <div class="absolute left-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                   [ngClass]="{'w-32': !isMobile(), 'w-auto min-w-[70px]': isMobile()}">
                <div 
                  (click)="setStageFilter('all')"
                  class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                  [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                  <span>全部</span>
                  @if (store.stageFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                </div>
                <div class="h-px bg-stone-100 my-0.5"></div>
                @for (stage of store.stages(); track stage.stageNumber) {
                  <div 
                    (click)="setStageFilter(stage.stageNumber)"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                    <span>阶段 {{stage.stageNumber}}</span>
                    @if (store.stageFilter() === stage.stageNumber) { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                }
              </div>
            }
          </div>
          
          <!-- 延伸筛选 -->
          <div class="flex items-center gap-1 relative">
            <span class="font-medium text-retro-muted"
                  [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">延伸</span>
            <button 
              (click)="toggleRootFilter($event)"
              class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
              [ngClass]="{'text-xs px-3 py-1.5': !isMobile(), 'text-[10px] px-2 py-1': isMobile()}">
              <span class="truncate" [ngClass]="{'max-w-[100px]': !isMobile(), 'max-w-[60px]': isMobile()}">{{ currentRootLabel() }}</span>
              <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile(), 'h-2.5 w-2.5': isMobile()}" [class.rotate-180]="isRootFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            @if (isRootFilterOpen()) {
              <div class="fixed inset-0 z-40" (click)="isRootFilterOpen.set(false)"></div>
              <div class="absolute right-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                   [ngClass]="{'w-48': !isMobile(), 'w-auto min-w-[90px] max-w-[150px]': isMobile()}">
                <div 
                  (click)="setRootFilter('all')"
                  class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                  [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                  <span>全部任务</span>
                  @if (store.stageViewRootFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                </div>
                <div class="h-px bg-stone-100 my-0.5"></div>
                @for (root of store.allStage1Tasks(); track root.id) {
                  <div 
                    (click)="setRootFilter(root.id)"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                    <span class="truncate">{{root.title}}</span>
                    @if (store.stageViewRootFilter() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                }
              </div>
            }
          </div>
        </div>
        
        <!-- 阶段列表 -->
        <div class="w-full flex-1 min-h-0 overflow-auto flex flex-col gap-3"
             [ngClass]="{'px-1': !isMobile(), 'gap-2': isMobile()}">
          @for (stage of visibleStages(); track stage.stageNumber) {
            <article 
              [attr.data-stage-number]="stage.stageNumber"
              class="flex flex-col bg-retro-cream/70 backdrop-blur border border-retro-muted/20 rounded-xl shadow-sm overflow-visible transition-all flex-shrink-0"
              [ngClass]="{
                'rounded-2xl': !isMobile(), 
                'w-full': isMobile(),
                'border-retro-teal border-2 bg-retro-teal/5': dragOverStage() === stage.stageNumber
              }"
              (dragover)="onStageDragOver($event, stage.stageNumber)"
              (dragleave)="onStageDragLeave($event, stage.stageNumber)"
              (drop)="onStageDrop($event, stage.stageNumber)">
              
              <!-- 阶段标题 -->
              <header 
                class="px-3 py-2 flex justify-between items-center cursor-pointer hover:bg-retro-cream/90 transition-colors select-none"
                [ngClass]="{'px-4 py-3': !isMobile()}"
                (click)="toggleStageCollapse(stage.stageNumber)">
                <h3 class="font-bold text-retro-olive tracking-tight flex items-center"
                    [ngClass]="{'text-sm gap-2': !isMobile(), 'text-xs gap-1.5': isMobile()}">
                  <span class="rounded-full bg-retro-olive" 
                        [ngClass]="{'w-1 h-4': !isMobile(), 'w-0.5 h-3': isMobile()}"></span>
                  阶段 {{stage.stageNumber}}
                </h3>
                <div class="flex items-center" [ngClass]="{'gap-2': !isMobile(), 'gap-1.5': isMobile()}">
                  <span class="text-retro-olive font-mono bg-canvas/60 rounded-full"
                        [ngClass]="{'text-[10px] px-2': !isMobile(), 'text-[9px] px-1.5 py-0.5': isMobile()}">
                    {{stage.tasks.length}}
                  </span>
                  <span class="text-stone-400 text-[10px] transition-transform" 
                        [class.rotate-180]="!isStageExpanded(stage.stageNumber)">▼</span>
                </div>
              </header>

              <!-- 任务列表 -->
              @if (isStageExpanded(stage.stageNumber)) {
                <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 task-stack animate-collapse-open"
                     [ngClass]="{'space-y-2 px-3 pb-3': !isMobile(), 'space-y-1.5 max-h-[40vh]': isMobile()}">
                  @for (task of stage.tasks; track task.id) {
                    @if (dropTargetInfo()?.stageNumber === stage.stageNumber && dropTargetInfo()?.beforeTaskId === task.id) {
                      <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
                    }
                    <app-task-card
                      [task]="task"
                      [isMobile]="isMobile()"
                      [isSelected]="selectedTaskId() === task.id"
                      [isDragging]="draggingTaskId() === task.id"
                      [userId]="userId()"
                      [projectId]="projectId()"
                      [connections]="getTaskConnections(task.id)"
                      (select)="taskSelect.emit($event)"
                      (titleChange)="taskTitleChange.emit($event)"
                      (contentChange)="taskContentChange.emit($event)"
                      (quickTodoAdd)="taskQuickTodoAdd.emit($event)"
                      (addSibling)="taskAddSibling.emit($event)"
                      (addChild)="taskAddChild.emit($event)"
                      (deleteTask)="taskDelete.emit($event)"
                      (attachmentsChange)="taskAttachmentsChange.emit($event)"
                      (attachmentError)="taskAttachmentError.emit($event)"
                      (openLinkedTask)="taskOpenLinked.emit($event)"
                      (inputFocus)="inputFocus.emit()"
                      (inputBlur)="inputBlur.emit()"
                      (dragStart)="taskDragStart.emit($event)"
                      (dragEnd)="taskDragEnd.emit()"
                      (dragOver)="onTaskDragOver($event.event, $event.task, stage.stageNumber)"
                      (touchStart)="taskTouchStart.emit($event)"
                      (touchMove)="taskTouchMove.emit($event)"
                      (touchEnd)="taskTouchEnd.emit($event)">
                    </app-task-card>
                  }
                  @if (dropTargetInfo()?.stageNumber === stage.stageNumber && dropTargetInfo()?.beforeTaskId === null) {
                    <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
                  }
                </div>
              }
            </article>
          }
          
          <!-- 添加阶段按钮 -->
          <div class="flex items-center justify-center rounded-xl border-2 border-dashed border-stone-200 hover:border-stone-300 transition-all cursor-pointer min-h-[60px]"
               [ngClass]="{'py-6': !isMobile(), 'py-4': isMobile()}"
               (click)="addNewStage.emit()">
            <span class="text-stone-400 hover:text-stone-600 text-lg font-light">+ 新阶段</span>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    .animate-dropdown {
      animation: dropdown 0.15s ease-out;
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    @keyframes dropdown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class StageListComponent {
  readonly store = inject(StoreService);
  
  // 输入
  readonly isMobile = input<boolean>(false);
  readonly selectedTaskId = input<string | null>(null);
  readonly draggingTaskId = input<string | null>(null);
  readonly dragOverStage = input<number | null>(null);
  readonly dropTargetInfo = input<DropTargetInfo | null>(null);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  
  // 内部状态
  readonly collapsedStages = signal<Set<number>>(new Set());
  readonly isStageFilterOpen = signal(false);
  readonly isRootFilterOpen = signal(false);
  
  // 计算属性
  readonly currentStageLabel = computed(() => {
    const filter = this.store.stageFilter();
    return filter === 'all' ? '全部' : `阶段 ${filter}`;
  });

  readonly currentRootLabel = computed(() => {
    const filter = this.store.stageViewRootFilter();
    if (filter === 'all') return '全部任务';
    return this.store.allStage1Tasks().find(t => t.id === filter)?.title ?? '全部任务';
  });

  readonly visibleStages = computed(() => {
    const stageFilter = this.store.stageFilter();
    const rootFilter = this.store.stageViewRootFilter();
    let stages = this.store.stages();
    
    if (stageFilter !== 'all') {
      stages = stages.filter(s => s.stageNumber === stageFilter);
    }
    
    if (rootFilter !== 'all') {
      const root = this.store.allStage1Tasks().find(t => t.id === rootFilter);
      if (root) {
        stages = stages.map(stage => ({
          ...stage,
          tasks: stage.tasks.filter(task => 
            task.id === root.id || task.displayId.startsWith(root.displayId + ',')
          )
        })).filter(stage => stage.tasks.length > 0);
      }
    }
    
    return stages;
  });
  
  // 任务相关输出事件
  readonly taskSelect = output<Task>();
  readonly taskTitleChange = output<{ taskId: string; title: string }>();
  readonly taskContentChange = output<{ taskId: string; content: string }>();
  readonly taskQuickTodoAdd = output<{ taskId: string; text: string }>();
  readonly taskAddSibling = output<Task>();
  readonly taskAddChild = output<Task>();
  readonly taskDelete = output<Task>();
  readonly taskAttachmentsChange = output<{ taskId: string; attachments: any[] }>();
  readonly taskAttachmentError = output<string>();
  readonly taskOpenLinked = output<Task>();
  readonly inputFocus = output<void>();
  readonly inputBlur = output<void>();
  
  // 拖拽相关输出事件
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDragEnd = output<void>();
  readonly taskDragOver = output<{ event: DragEvent; task: Task; stageNumber: number }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<TouchEvent>();
  readonly taskTouchEnd = output<TouchEvent>();
  
  // 阶段相关输出事件
  readonly stageDragOver = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDragLeave = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDrop = output<{ event: DragEvent; stageNumber: number }>();
  readonly addNewStage = output<void>();
  
  constructor() {
    // 初始时折叠所有阶段
    queueMicrotask(() => {
      const collapsed = new Set(this.store.stages().map(s => s.stageNumber));
      this.collapsedStages.set(collapsed);
    });
  }
  
  isStageExpanded(stageNumber: number): boolean {
    return !this.collapsedStages().has(stageNumber);
  }
  
  toggleStageCollapse(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.has(stageNumber) ? newSet.delete(stageNumber) : newSet.add(stageNumber);
      return newSet;
    });
  }
  
  expandStage(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.delete(stageNumber);
      return newSet;
    });
  }
  
  toggleStageFilter(event: Event) {
    event.stopPropagation();
    this.isStageFilterOpen.update(v => !v);
    this.isRootFilterOpen.set(false);
  }
  
  toggleRootFilter(event: Event) {
    event.stopPropagation();
    this.isRootFilterOpen.update(v => !v);
    this.isStageFilterOpen.set(false);
  }
  
  setStageFilter(value: 'all' | number) {
    this.store.setStageFilter(value);
    this.isStageFilterOpen.set(false);
  }
  
  setRootFilter(value: string) {
    this.store.stageViewRootFilter.set(value);
    this.isRootFilterOpen.set(false);
  }
  
  getTaskConnections(taskId: string): TaskConnections | null {
    return this.store.getTaskConnections(taskId);
  }
  
  onStageDragOver(event: DragEvent, stageNumber: number) {
    event.preventDefault();
    this.expandStage(stageNumber);
    this.stageDragOver.emit({ event, stageNumber });
  }
  
  onStageDragLeave(event: DragEvent, stageNumber: number) {
    this.stageDragLeave.emit({ event, stageNumber });
  }
  
  onStageDrop(event: DragEvent, stageNumber: number) {
    event.preventDefault();
    this.stageDrop.emit({ event, stageNumber });
  }
  
  onTaskDragOver(event: DragEvent, task: Task, stageNumber: number) {
    event.preventDefault();
    event.stopPropagation();
    this.taskDragOver.emit({ event, task, stageNumber });
  }
}
