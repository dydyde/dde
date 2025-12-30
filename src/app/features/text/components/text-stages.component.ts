import { Component, inject, Input, Output, EventEmitter, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';
import { DropTargetInfo } from './text-view.types';
import { TextStageCardComponent } from './text-stage-card.component';

/**
 * 阶段区容器组件
 * 管理筛选栏和阶段列表的显示
 */
@Component({
  selector: 'app-text-stages',
  standalone: true,
  imports: [CommonModule, TextStageCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section 
      class="flex-1 min-h-0 overflow-hidden flex flex-col"
      [ngClass]="{'px-4 pb-6': !isMobile, 'px-2 pb-4': isMobile}">
      <div 
        class="rounded-xl bg-panel/40 border border-retro-muted/20 backdrop-blur-md px-2 py-2 shadow-inner w-full flex-1 min-h-0 flex flex-col overflow-hidden"
        [ngClass]="{'rounded-2xl px-4 py-3': !isMobile}">
        
        <!-- 筛选栏 -->
        <div class="flex items-center justify-between text-stone-500"
             [ngClass]="{'mb-3': !isMobile, 'mb-2': isMobile}">
          <!-- 阶段筛选 -->
          <div class="flex items-center gap-1 relative">
            <span class="font-medium text-retro-muted" 
                  [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">阶段</span>
            <button 
              (click)="toggleFilter('stage', $event)"
              class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
              [ngClass]="{'text-xs px-3 py-1.5': !isMobile, 'text-[10px] px-2 py-1': isMobile}">
              <span>{{ currentStageLabel() }}</span>
              <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile, 'h-2.5 w-2.5': isMobile}" [class.rotate-180]="isStageFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            @if (isStageFilterOpen()) {
              <div class="fixed inset-0 z-40" (click)="isStageFilterOpen.set(false)"></div>
              <div class="absolute left-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                   [ngClass]="{'w-32': !isMobile, 'w-auto min-w-[70px]': isMobile}">
                <div 
                  (click)="setStageFilter('all')"
                  class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                  [ngClass]="{'text-xs px-4 py-2': !isMobile, 'text-[10px] py-1': isMobile}">
                  <span>全部</span>
                  @if (uiState.stageFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                </div>
                <div class="h-px bg-stone-100 my-0.5"></div>
                @for (stage of availableStages(); track stage.stageNumber) {
                  <div 
                    (click)="setStageFilter(stage.stageNumber)"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile, 'text-[10px] py-1': isMobile}">
                    <span>阶段 {{stage.stageNumber}}</span>
                    @if (uiState.stageFilter() === stage.stageNumber) { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                }
              </div>
            }
          </div>
          
          <!-- 延伸筛选 -->
          <div class="flex items-center gap-1 relative">
            <span class="font-medium text-retro-muted"
                  [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">延伸</span>
            <button 
              (click)="toggleFilter('root', $event)"
              class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
              [ngClass]="{'text-xs px-3 py-1.5': !isMobile, 'text-[10px] px-2 py-1': isMobile}">
              <span class="truncate" [ngClass]="{'max-w-[100px]': !isMobile, 'max-w-[60px]': isMobile}">{{ currentRootLabel() }}</span>
              <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile, 'h-2.5 w-2.5': isMobile}" [class.rotate-180]="isRootFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            @if (isRootFilterOpen()) {
              <div class="fixed inset-0 z-40" (click)="isRootFilterOpen.set(false)"></div>
              <div class="absolute right-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                   [ngClass]="{'w-48': !isMobile, 'w-auto min-w-[90px] max-w-[150px]': isMobile}">
                <div 
                  (click)="setRootFilter('all')"
                  class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                  [ngClass]="{'text-xs px-4 py-2': !isMobile, 'text-[10px] py-1': isMobile}">
                  <span>全部任务</span>
                  @if (uiState.stageViewRootFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                </div>
                <div class="h-px bg-stone-100 my-0.5"></div>
                @for (root of projectState.allStage1Tasks(); track root.id) {
                  <div 
                    (click)="setRootFilter(root.id)"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile, 'text-[10px] py-1': isMobile}">
                    <span class="truncate">{{root.title || root.displayId || '未命名任务'}}</span>
                    @if (uiState.stageViewRootFilter() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                }
              </div>
            }
          </div>
        </div>
        
        <!-- 阶段列表 -->
        <div class="w-full flex-1 min-h-0 overflow-auto flex flex-col gap-3"
             [ngClass]="{'px-1': !isMobile, 'gap-2': isMobile}">
          @for (stage of visibleStages(); track stage.stageNumber) {
            <app-text-stage-card
              [stage]="stage"
              [isMobile]="isMobile"
              [isExpanded]="isStageExpanded(stage.stageNumber)"
              [selectedTaskId]="selectedTaskId"
              [draggingTaskId]="draggingTaskId"
              [isDragOver]="dragOverStage === stage.stageNumber"
              [dropTargetInfo]="dropTargetInfo"
              [userId]="userId"
              [projectId]="projectId"
              (toggleExpand)="onToggleExpand($event)"
              (stageDragOver)="onStageDragOver($event)"
              (stageDragLeave)="onStageDragLeave($event)"
              (stageDrop)="onStageDrop($event)"
              (taskSelect)="taskSelect.emit($event)"
              (addSibling)="addSibling.emit($event)"
              (addChild)="addChild.emit($event)"
              (deleteTask)="deleteTask.emit($event)"
              (attachmentError)="attachmentError.emit($event)"
              (openLinkedTask)="openLinkedTask.emit($event)"
              (taskDragStart)="taskDragStart.emit($event)"
              (taskDragEnd)="taskDragEnd.emit()"
              (taskDragOver)="taskDragOver.emit($event)"
              (taskTouchStart)="taskTouchStart.emit($event)"
              (taskTouchMove)="taskTouchMove.emit($event)"
              (taskTouchEnd)="taskTouchEnd.emit($event)"
              (taskTouchCancel)="taskTouchCancel.emit($event)">
            </app-text-stage-card>
          }
          
          <!-- 添加阶段按钮 -->
          <div class="flex items-center justify-center rounded-xl border-2 border-dashed border-stone-200 hover:border-stone-300 transition-all cursor-pointer min-h-[60px]"
               [ngClass]="{'py-6': !isMobile, 'py-4': isMobile}"
               (click)="addNewStage.emit()">
            <span class="text-stone-400 hover:text-stone-600 text-lg font-light">+ 新阶段</span>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .animate-dropdown {
      animation: dropdown 0.1s ease-out;
    }
    @keyframes dropdown {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class TextStagesComponent {
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  
  @Input() isMobile = false;
  @Input() selectedTaskId: string | null = null;
  @Input() draggingTaskId: string | null = null;
  @Input() dragOverStage: number | null = null;
  @Input() dropTargetInfo: DropTargetInfo | null = null;
  @Input() userId: string | null = null;
  @Input() projectId: string | null = null;
  
  // 阶段事件
  @Output() addNewStage = new EventEmitter<void>();
  @Output() stageDragOver = new EventEmitter<{ event: DragEvent; stageNumber: number }>();
  @Output() stageDragLeave = new EventEmitter<{ event: DragEvent; stageNumber: number }>();
  @Output() stageDrop = new EventEmitter<{ event: DragEvent; stageNumber: number }>();
  
  // 任务事件
  @Output() taskSelect = new EventEmitter<Task>();
  @Output() addSibling = new EventEmitter<Task>();
  @Output() addChild = new EventEmitter<Task>();
  @Output() deleteTask = new EventEmitter<Task>();
  @Output() attachmentError = new EventEmitter<string>();
  @Output() openLinkedTask = new EventEmitter<{ task: Task; event: Event }>();
  
  // 拖拽事件
  @Output() taskDragStart = new EventEmitter<{ event: DragEvent; task: Task }>();
  @Output() taskDragEnd = new EventEmitter<void>();
  @Output() taskDragOver = new EventEmitter<{ event: DragEvent; task: Task; stageNumber: number }>();
  @Output() taskTouchStart = new EventEmitter<{ event: TouchEvent; task: Task }>();
  @Output() taskTouchMove = new EventEmitter<TouchEvent>();
  @Output() taskTouchEnd = new EventEmitter<TouchEvent>();
  @Output() taskTouchCancel = new EventEmitter<TouchEvent>();
  
  // 筛选状态
  readonly isStageFilterOpen = signal(false);
  readonly isRootFilterOpen = signal(false);
  
  // 折叠状态
  readonly collapsedStages = signal<Set<number>>(new Set());
  
  // 计算属性
  readonly currentStageLabel = computed(() => {
    const filter = this.uiState.stageFilter();
    return filter === 'all' ? '全部' : `阶段 ${filter}`;
  });

  readonly currentRootLabel = computed(() => {
    const filter = this.uiState.stageViewRootFilter();
    if (filter === 'all') return '全部任务';
    const task = this.projectState.allStage1Tasks().find(t => t.id === filter);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });

  /** 可选阶段列表（考虑延伸筛选后的有效阶段） */
  readonly availableStages = computed(() => {
    const rootFilter = this.uiState.stageViewRootFilter();
    let stages = this.projectState.stages();
    
    // 如果有延伸筛选，只保留有该根任务子孙的阶段
    if (rootFilter !== 'all') {
      const root = this.projectState.allStage1Tasks().find(t => t.id === rootFilter);
      if (root) {
        stages = stages.filter(stage => 
          stage.tasks.some(task => 
            task.id === root.id || task.displayId.startsWith(root.displayId + ',')
          )
        );
      }
    }
    
    return stages;
  });

  readonly visibleStages = computed(() => {
    const stageFilter = this.uiState.stageFilter();
    const rootFilter = this.uiState.stageViewRootFilter();
    let stages = this.projectState.stages();
    
    // 应用阶段筛选
    if (stageFilter !== 'all') {
      stages = stages.filter(s => s.stageNumber === stageFilter);
    }
    
    // 应用延伸筛选
    if (rootFilter !== 'all') {
      const root = this.projectState.allStage1Tasks().find(t => t.id === rootFilter);
      if (root) {
        // DEBUG: 追踪带有 "?" displayId 的任务
        const allStage1Tasks = stages.flatMap(s => s.tasks).filter(t => t.stage === 1 && !t.parentId);
        const tasksWithQuestionMark = allStage1Tasks.filter(t => t.displayId === '?');
        if (tasksWithQuestionMark.length > 0) {
          console.warn('[visibleStages] Stage 1 roots with displayId="?":', 
            tasksWithQuestionMark.map(t => ({ id: t.id.slice(-4), title: t.title || 'untitled' }))
          );
        }
        
        const beforeFilter = stages.flatMap(s => s.tasks);
        stages = stages.map(stage => ({
          ...stage,
          tasks: stage.tasks.filter(task => 
            task.id === root.id || task.displayId.startsWith(root.displayId + ',')
          )
        })).filter(stage => stage.tasks.length > 0);
        const afterFilter = stages.flatMap(s => s.tasks);
        
        // DEBUG: 检查是否有任务因为 displayId 问题被过滤掉
        if (beforeFilter.length !== afterFilter.length) {
          const filteredOut = beforeFilter.filter(bt => !afterFilter.some(at => at.id === bt.id));
          const invalidFiltered = filteredOut.filter(t => t.displayId === '?' || !t.displayId.startsWith(root.displayId));
          if (invalidFiltered.length > 0) {
            console.warn('[visibleStages] Tasks filtered out due to displayId mismatch:', {
              rootDisplayId: root.displayId,
              filteredTasks: invalidFiltered.map(t => ({
                id: t.id.slice(-4),
                displayId: t.displayId,
                title: t.title || 'untitled'
              }))
            });
          }
        }
      }
    }
    
    return stages;
  });
  
  constructor() {
    // 初始化时折叠所有阶段
    queueMicrotask(() => {
      const collapsed = new Set(this.projectState.stages().map(s => s.stageNumber));
      this.collapsedStages.set(collapsed);
    });
  }
  
  isStageExpanded(stageNumber: number): boolean {
    return !this.collapsedStages().has(stageNumber);
  }
  
  toggleFilter(type: 'stage' | 'root', event: Event) {
    event.stopPropagation();
    if (type === 'stage') {
      this.isStageFilterOpen.update(v => !v);
      this.isRootFilterOpen.set(false);
    } else {
      this.isRootFilterOpen.update(v => !v);
      this.isStageFilterOpen.set(false);
    }
  }
  
  setStageFilter(value: 'all' | number) {
    this.uiState.setStageFilter(value);
    this.isStageFilterOpen.set(false);
  }
  
  setRootFilter(value: string) {
    this.uiState.stageViewRootFilter.set(value);
    this.isRootFilterOpen.set(false);
    
    // 如果当前阶段筛选在新的延伸筛选下不可用，重置为"全部"
    const currentStageFilter = this.uiState.stageFilter();
    if (currentStageFilter !== 'all') {
      // 需要在下一个微任务中检查，因为 availableStages 依赖 stageViewRootFilter
      queueMicrotask(() => {
        const available = this.availableStages();
        const stillValid = available.some(s => s.stageNumber === currentStageFilter);
        if (!stillValid) {
          this.uiState.setStageFilter('all');
        }
      });
    }
  }
  
  onToggleExpand(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.has(stageNumber) ? newSet.delete(stageNumber) : newSet.add(stageNumber);
      return newSet;
    });
  }
  
  /** 展开指定阶段 */
  expandStage(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.delete(stageNumber);
      return newSet;
    });
  }
  
  /** 折叠指定阶段 */
  collapseStage(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.add(stageNumber);
      return newSet;
    });
  }
  
  onStageDragOver(data: { event: DragEvent; stageNumber: number }) {
    this.stageDragOver.emit(data);
  }
  
  onStageDragLeave(data: { event: DragEvent; stageNumber: number }) {
    this.stageDragLeave.emit(data);
  }
  
  onStageDrop(data: { event: DragEvent; stageNumber: number }) {
    this.stageDrop.emit(data);
  }
}
