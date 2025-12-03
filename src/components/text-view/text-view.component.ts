import { Component, inject, signal, Output, EventEmitter, OnDestroy, ElementRef, ViewChild, NgZone, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { ToastService } from '../../services/toast.service';
import { Task } from '../../models';
import { getErrorMessage, isFailure } from '../../utils/result';

// 子组件导入
import { TextViewLoadingComponent } from './text-view-loading.component';
import { TextUnfinishedComponent } from './text-unfinished.component';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TextStagesComponent } from './text-stages.component';
import { TextDeleteDialogComponent } from './text-delete-dialog.component';
import { TextViewDragDropService } from './text-view-drag-drop.service';
import { DropTargetInfo } from './text-view.types';

/**
 * 文本视图容器组件
 * 作为纯粹的协调组件，管理子组件间的通信和状态
 */
@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [
    CommonModule,
    TextViewLoadingComponent,
    TextUnfinishedComponent,
    TextUnassignedComponent,
    TextStagesComponent,
    TextDeleteDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scrollContainer class="flex flex-col h-full bg-canvas overflow-y-auto overflow-x-hidden text-view-scroll-container">
      
      @if (store.isLoadingRemote()) {
        <app-text-view-loading [isMobile]="isMobile()" />
      } @else {
        
        <!-- 待办事项区 -->
        <app-text-unfinished
          [isMobile]="isMobile()"
          (jumpToTask)="onJumpToTask($event)"
        />
        
        <!-- 待分配区 -->
        <app-text-unassigned
          #unassignedRef
          [isMobile]="isMobile()"
          [draggingTaskId]="dragDropService.draggingTaskId()"
          (taskClick)="onUnassignedTaskClick($event)"
          (createUnassigned)="onCreateUnassigned()"
          (dragStart)="onDragStart($event)"
          (dragEnd)="onDragEnd()"
          (touchStart)="onTouchStart($event)"
          (touchMove)="onTouchMove($event)"
          (touchEnd)="onTouchEnd($event)"
        />
        
        <!-- 阶段区 -->
        <app-text-stages
          #stagesRef
          [isMobile]="isMobile()"
          [selectedTaskId]="selectedTaskId()"
          [draggingTaskId]="dragDropService.draggingTaskId()"
          [dragOverStage]="dragDropService.dragOverStage()"
          [dropTargetInfo]="dragDropService.dropTargetInfo()"
          [userId]="store.currentUserId()"
          [projectId]="store.activeProjectId()"
          (addNewStage)="onAddNewStage()"
          (stageDragOver)="onStageDragOver($event)"
          (stageDragLeave)="onStageDragLeave($event)"
          (stageDrop)="onStageDrop($event)"
          (taskSelect)="onTaskSelect($event)"
          (addSibling)="onAddSibling($event)"
          (addChild)="onAddChild($event)"
          (deleteTask)="onDeleteTask($event)"
          (attachmentError)="onAttachmentError($event)"
          (openLinkedTask)="onOpenLinkedTask($event)"
          (taskDragStart)="onDragStart($event)"
          (taskDragEnd)="onDragEnd()"
          (taskDragOver)="onTaskDragOver($event)"
          (taskTouchStart)="onTaskTouchStart($event)"
          (taskTouchMove)="onTouchMove($event)"
          (taskTouchEnd)="onTouchEnd($event)"
        />
        
        <!-- 删除确认弹窗 -->
        @if (deleteConfirmTask()) {
          <app-text-delete-dialog
            [task]="deleteConfirmTask()!"
            [isMobile]="isMobile()"
            [hasChildren]="hasChildren(deleteConfirmTask()!)"
            [keepChildren]="deleteKeepChildren()"
            (confirm)="onConfirmDelete($event)"
            (cancel)="onCancelDelete()"
            (keepChildrenChange)="deleteKeepChildren.set($event)"
          />
        }
        
      }
    </div>
  `
})
export class TextViewComponent implements OnDestroy {
  readonly store = inject(StoreService);
  private readonly toast = inject(ToastService);
  readonly dragDropService = inject(TextViewDragDropService);
  private readonly elementRef = inject(ElementRef);
  private readonly ngZone = inject(NgZone);
  
  @ViewChild('scrollContainer', { static: true }) scrollContainerRef!: ElementRef<HTMLElement>;
  @ViewChild('stagesRef') stagesRef!: TextStagesComponent;
  @ViewChild('unassignedRef') unassignedRef!: TextUnassignedComponent;
  
  @Output() focusFlowNode = new EventEmitter<string>();
  
  // UI 状态
  readonly selectedTaskId = signal<string | null>(null);
  readonly deleteConfirmTask = signal<Task | null>(null);
  readonly deleteKeepChildren = signal(false);
  
  /** 待清理的定时器列表（防止内存泄漏） */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  
  // 计算属性
  readonly isMobile = this.store.isMobile;
  
  ngOnDestroy() {
    this.dragDropService.cleanup();
    // 清理所有待处理的定时器，防止内存泄漏
    this.pendingTimers.forEach(timer => clearTimeout(timer));
    this.pendingTimers = [];
  }
  
  // ========== DOM 辅助方法 ==========
  
  private getScrollContainer(): HTMLElement | null {
    return this.scrollContainerRef?.nativeElement 
      ?? this.elementRef.nativeElement.querySelector('.text-view-scroll-container');
  }
  
  private scrollToElementById(selector: string): void {
    this.ngZone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        const el = this.elementRef.nativeElement.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
  }
  
  private scrollToTaskAndFocus(taskId: string, inputSelector?: string): void {
    this.ngZone.runOutsideAngular(() => {
      // 使用双重 rAF 确保 DOM 已完成渲染
      // 第一个 rAF：等待 Angular 变更检测完成
      // 第二个 rAF：等待浏览器完成布局和绘制
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = this.elementRef.nativeElement.querySelector(`[data-task-id="${taskId}"]`) 
            ?? this.elementRef.nativeElement.querySelector(`[data-unassigned-task="${taskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (inputSelector) {
              // 滚动动画完成后聚焦输入框
              const focusTimer = setTimeout(() => {
                const input = el.querySelector(inputSelector) as HTMLInputElement;
                input?.focus();
                input?.select?.();
                this.removeTimer(focusTimer);
              }, 100);
              this.pendingTimers.push(focusTimer);
            }
          }
        });
      });
    });
  }
  
  /** 移除已执行的定时器 */
  private removeTimer(timer: ReturnType<typeof setTimeout>): void {
    const index = this.pendingTimers.indexOf(timer);
    if (index > -1) {
      this.pendingTimers.splice(index, 1);
    }
  }
  
  // ========== 待办事项处理 ==========
  
  async onJumpToTask(taskId: string) {
    const task = this.store.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    if (task.stage) {
      // 有阶段的任务：跳转到阶段区域
      this.stagesRef?.expandStage(task.stage);
      if (this.store.stageFilter() !== 'all' && this.store.stageFilter() !== task.stage) {
        this.store.setStageFilter('all');
      }
      this.selectedTaskId.set(taskId);
      this.scrollToElementById(`[data-task-id="${taskId}"]`);
    } else {
      // 待分配的任务：跳转到待分配区域并展开任务卡片
      // 1. 确保待分配区域展开
      if (!this.store.isTextUnassignedOpen()) {
        this.store.isTextUnassignedOpen.set(true);
      }
      
      // 2. 等待待分配区域渲染完成（确保 unassignedRef 可用）
      await new Promise<void>(resolve => {
        setTimeout(() => resolve(), 50);
      });
      
      // 3. 设置编辑任务（预览模式）并等待 DOM 更新
      if (this.unassignedRef) {
        await this.unassignedRef.setEditingTask(taskId, false);
      }
      
      // 4. 滚动到任务
      this.ngZone.runOutsideAngular(() => {
        const timer = setTimeout(() => {
          const el = this.elementRef.nativeElement.querySelector(`[data-unassigned-task="${taskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          this.removeTimer(timer);
        }, 100);
        this.pendingTimers.push(timer);
      });
    }
  }
  
  // ========== 待分配区处理 ==========
  
  onUnassignedTaskClick(task: Task) {
    this.focusFlowNode.emit(task.id);
  }
  
  onCreateUnassigned() {
    const result = this.store.addTask('', '', null, null, false);
    if (isFailure(result)) {
      this.toast.error('创建任务失败', getErrorMessage(result.error));
    } else {
      this.unassignedRef?.setEditingTask(result.value, true);  // 新建任务直接进入编辑模式
      this.scrollToTaskAndFocus(result.value, 'input');
    }
  }
  
  // ========== 任务选择和操作 ==========
  
  onTaskSelect(task: Task) {
    const wasSelected = this.selectedTaskId() === task.id;
    this.selectedTaskId.update(id => id === task.id ? null : task.id);
    
    if (!wasSelected && this.selectedTaskId() === task.id && !this.isMobile()) {
      this.focusFlowNode.emit(task.id);
    }
  }
  
  onAddSibling(task: Task) {
    const result = this.store.addTask('', '', task.stage, task.parentId, true);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, task.stage);
    }
  }
  
  onAddChild(task: Task) {
    const newStage = (task.stage || 0) + 1;
    const result = this.store.addTask('', '', newStage, task.id, false);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, newStage);
    }
  }
  
  onDeleteTask(task: Task) {
    this.deleteConfirmTask.set(task);
  }
  
  onConfirmDelete(keepChildren: boolean) {
    const task = this.deleteConfirmTask();
    if (task) {
      this.selectedTaskId.set(null);
      if (keepChildren) {
        this.store.deleteTaskKeepChildren(task.id);
      } else {
        this.store.deleteTask(task.id);
      }
      this.deleteConfirmTask.set(null);
      this.deleteKeepChildren.set(false);
    }
  }
  
  onCancelDelete() {
    this.deleteConfirmTask.set(null);
    this.deleteKeepChildren.set(false);
  }
  
  onAttachmentError(error: string) {
    this.toast.error('附件操作失败', error);
  }
  
  onOpenLinkedTask(data: { task: Task; event: Event }) {
    const { task, event } = data;
    event.stopPropagation();
    if (!task) return;
    
    if (task.stage) {
      this.stagesRef?.expandStage(task.stage);
    }
    
    this.selectedTaskId.set(task.id);
    this.scrollToElementById(`[data-task-id="${task.id}"]`);
  }
  
  onAddNewStage() {
    const maxStage = Math.max(...this.store.stages().map(s => s.stageNumber), 0);
    const result = this.store.addTask('', '', maxStage + 1, null, false);
    if (isFailure(result)) {
      this.toast.error('创建阶段失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, maxStage + 1);
    }
  }
  
  private navigateToNewTask(taskId: string, stage: number | null) {
    if (stage) {
      this.stagesRef?.expandStage(stage);
      if (this.store.stageFilter() !== 'all' && this.store.stageFilter() !== stage) {
        this.store.setStageFilter('all');
      }
    }
    this.selectedTaskId.set(taskId);
    this.scrollToTaskAndFocus(taskId, 'input[data-title-input]');
  }
  
  hasChildren(task: Task): boolean {
    return this.store.tasks().some(t => t.parentId === task.id);
  }
  
  // ========== 鼠标拖拽处理 ==========
  
  onDragStart(data: { event: DragEvent; task: Task }) {
    const { event, task } = data;
    this.dragDropService.startDrag(task);
    event.dataTransfer?.setData('application/json', JSON.stringify(task));
    event.dataTransfer!.effectAllowed = 'move';
    
    const container = this.getScrollContainer();
    if (container) {
      this.dragDropService.startAutoScroll(container, event.clientY);
    }
  }
  
  onDragEnd() {
    this.dragDropService.endDrag();
  }
  
  onTaskDragOver(data: { event: DragEvent; task: Task; stageNumber: number }) {
    const { event, task, stageNumber } = data;
    event.preventDefault();
    event.stopPropagation();
    
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const isAbove = event.clientY < rect.top + rect.height / 2;
    
    if (isAbove) {
      this.dragDropService.updateDropTarget(stageNumber, task.id);
    } else {
      const stages = this.store.stages();
      const stage = stages.find(s => s.stageNumber === stageNumber);
      const idx = stage?.tasks.findIndex(t => t.id === task.id) ?? -1;
      const nextTask = stage?.tasks[idx + 1];
      this.dragDropService.updateDropTarget(stageNumber, nextTask?.id ?? null);
    }
  }
  
  onStageDragOver(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    event.preventDefault();
    
    const isCollapsed = !this.stagesRef?.isStageExpanded(stageNumber);
    const result = this.dragDropService.handleStageDragOver(stageNumber, isCollapsed);
    
    if (result.collapse !== undefined) {
      this.stagesRef?.collapseStage(result.collapse);
    }
    if (result.expand !== undefined) {
      this.stagesRef?.expandStage(result.expand);
    }
  }
  
  onStageDragLeave(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    const relatedTarget = event.relatedTarget as HTMLElement;
    const currentTarget = event.currentTarget as HTMLElement;
    
    if (!currentTarget.contains(relatedTarget)) {
      const collapseStage = this.dragDropService.handleStageDragLeave(stageNumber);
      if (collapseStage !== null) {
        this.stagesRef?.collapseStage(collapseStage);
      }
    }
  }
  
  onStageDrop(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    event.preventDefault();
    
    const jsonData = event.dataTransfer?.getData('application/json');
    if (jsonData) {
      const task = JSON.parse(jsonData) as Task;
      const dropInfo = this.dragDropService.dropTargetInfo();
      const result = this.store.moveTaskToStage(task.id, stageNumber, dropInfo?.beforeTaskId ?? null);
      
      if (isFailure(result)) {
        const errorDetail = getErrorMessage(result.error);
        this.toast.error('移动任务失败', `无法将任务移动到阶段 ${stageNumber}：${errorDetail}`);
      } else {
        this.stagesRef?.expandStage(stageNumber);
      }
    }
    
    this.dragDropService.endDrag();
  }
  
  // ========== 触摸拖拽处理 ==========
  
  onTouchStart(data: { event: TouchEvent; task: Task }) {
    const { event, task } = data;
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    this.dragDropService.startTouchDrag(task, touch, () => {
      // 拖拽开始回调
    });
  }
  
  onTaskTouchStart(data: { event: TouchEvent; task: Task }) {
    const { event, task } = data;
    if (event.touches.length !== 1) return;
    if (this.selectedTaskId() === task.id) return;
    
    const touch = event.touches[0];
    this.dragDropService.startTouchDrag(task, touch, () => {
      // 拖拽开始回调
    });
  }
  
  onTouchMove(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const isDragging = this.dragDropService.handleTouchMove(touch);
    
    if (isDragging) {
      event.preventDefault();
      
      // 自动滚动
      const container = this.getScrollContainer();
      if (container) {
        this.dragDropService.performTouchAutoScroll(container, touch.clientY);
      }
      
      // 查找目标阶段
      const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
      let foundStage = false;
      
      for (const el of elements) {
        const stageEl = el.closest('[data-stage-number]');
        if (stageEl) {
          const stageNum = parseInt(stageEl.getAttribute('data-stage-number') || '0', 10);
          if (stageNum > 0) {
            const collapseStage = this.dragDropService.updateTouchTarget(stageNum, null);
            if (collapseStage !== null) {
              this.stagesRef?.collapseStage(collapseStage);
            }
            this.stagesRef?.expandStage(stageNum);
            
            // 检查是否在某个任务上方
            const taskEl = el.closest('[data-task-id]');
            if (taskEl) {
              const taskId = taskEl.getAttribute('data-task-id');
              const rect = taskEl.getBoundingClientRect();
              const isAbove = touch.clientY < rect.top + rect.height / 2;
              
              if (isAbove) {
                this.dragDropService.updateTouchTarget(stageNum, taskId);
              } else {
                const stages = this.store.stages();
                const stage = stages.find(s => s.stageNumber === stageNum);
                const idx = stage?.tasks.findIndex(t => t.id === taskId) ?? -1;
                const nextTask = stage?.tasks[idx + 1];
                this.dragDropService.updateTouchTarget(stageNum, nextTask?.id ?? null);
              }
            }
            
            foundStage = true;
            break;
          }
        }
      }
      
      if (!foundStage) {
        const collapseStage = this.dragDropService.updateTouchTarget(null, null);
        if (collapseStage !== null) {
          this.stagesRef?.collapseStage(collapseStage);
        }
      }
    }
  }
  
  onTouchEnd(event: TouchEvent) {
    const { task, targetStage, targetBeforeId, wasDragging } = this.dragDropService.endTouchDrag();
    
    if (!task) return;
    
    if (wasDragging && targetStage) {
      const result = this.store.moveTaskToStage(task.id, targetStage, targetBeforeId);
      if (isFailure(result)) {
        const errorDetail = getErrorMessage(result.error);
        this.toast.error('移动任务失败', `无法将任务移动到阶段 ${targetStage}：${errorDetail}`);
      } else {
        this.stagesRef?.expandStage(targetStage);
      }
    }
    
    this.dragDropService.endDrag();
  }
}
