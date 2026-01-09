import { Component, inject, signal, computed, Output, EventEmitter, OnInit, OnDestroy, ElementRef, ViewChild, NgZone, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { getErrorMessage, isFailure } from '../../../../utils/result';

// 子组件导入
import { TextViewLoadingComponent } from './text-view-loading.component';
import { TextUnfinishedComponent } from './text-unfinished.component';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TextStagesComponent } from './text-stages.component';
import { TextDeleteDialogComponent } from './text-delete-dialog.component';
import { TextViewDragDropService } from './text-view-drag-drop.service';

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
    <div #scrollContainer class="flex flex-col h-full theme-bg overflow-y-auto overflow-x-hidden text-view-scroll-container"
         (click)="onContainerClick($event)"
         (touchmove)="onGlobalTouchMove($event)"
         (touchend)="onGlobalTouchEnd($event)"
         (touchcancel)="onGlobalTouchCancel($event)">
      
      <!-- 只在首次加载（无本地数据）时显示骨架屏，增量同步时保留现有内容 -->
      @if (showLoadingSkeleton()) {
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
          (touchCancel)="onTouchCancel($event)"
        />
        
        <!-- 阶段区 -->
        <app-text-stages
          #stagesRef
          [isMobile]="isMobile()"
          [selectedTaskId]="selectedTaskId()"
          [draggingTaskId]="dragDropService.draggingTaskId()"
          [dragOverStage]="dragDropService.dragOverStage()"
          [dropTargetInfo]="dragDropService.dropTargetInfo()"
          [userId]="userSession.currentUserId()"
          [projectId]="projectState.activeProjectId()"
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
          (taskTouchCancel)="onTouchCancel($event)"
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
export class TextViewComponent implements OnInit, OnDestroy {
  readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly toast = inject(ToastService);
  readonly dragDropService = inject(TextViewDragDropService);
  private readonly elementRef = inject(ElementRef);
  private readonly ngZone = inject(NgZone);
  
  /** 全局触摸事件监听器的绑定引用 */
  private boundGlobalTouchEnd = this.handleGlobalTouchEnd.bind(this);
  private boundGlobalTouchCancel = this.handleGlobalTouchCancel.bind(this);
  /** pointer/click/自定义事件监听器绑定引用（必须复用同一函数引用，否则无法移除监听器） */
  private boundGlobalPointerUp = this.handleGlobalPointerUp.bind(this);
  private boundEmergencyCleanup = this.handleEmergencyCleanup.bind(this);
  private boundTouchDragTimeout = this.handleTouchDragTimeout.bind(this) as EventListener;
  
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
  readonly isMobile = this.uiState.isMobile;
  
  /**
   * 是否显示加载骨架屏
   * 只在首次加载（无本地数据）时显示，增量同步时保留现有内容
   */
  readonly showLoadingSkeleton = computed(() => {
    const isLoading = this.syncCoordinator.isLoadingRemote();
    const hasLocalData = this.projectState.tasks().length > 0 || this.projectState.stages().length > 0;
    // 只有在加载中 且 没有本地数据时，才显示骨架屏
    return isLoading && !hasLocalData;
  });
  
  ngOnInit() {
    // 在 document 上注册全局触摸事件监听器
    // 这样即使被拖拽的元素有 pointer-events-none，也能捕获到 touchend
    // 使用捕获阶段（第三个参数的 capture: true）
    document.addEventListener('touchend', this.boundGlobalTouchEnd, { capture: true, passive: false });
    document.addEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true, passive: false });
    
    // 添加 pointerup 作为备用（比 touchend 更可靠）
    document.addEventListener('pointerup', this.boundGlobalPointerUp, { capture: true });
    document.addEventListener('pointercancel', this.boundGlobalPointerUp, { capture: true });
    
    // 紧急清理：如果用户点击屏幕，强制清理残留的拖拽状态
    document.addEventListener('click', this.boundEmergencyCleanup, { capture: true });
    
    // 超时检测：如果 touchend 丢失，通过超时自动完成拖拽
    document.addEventListener('touchDragTimeout', this.boundTouchDragTimeout);
    
    // console.log('[TextView] Global touch listeners registered with capture=true');
  }
  
  /** 处理 pointerup 事件 - 作为 touchend 的备用 */
  private handleGlobalPointerUp(event: PointerEvent) {
    // 只处理触摸类型的 pointer 事件
    if (event.pointerType !== 'touch') return;
    
    // ⚠️ 如果正在 DOM 更新（折叠/展开阶段），忽略此事件
    if (this.dragDropService.isDOMUpdating) {
      console.log('[GlobalPointerUp] Ignoring - DOM update in progress');
      return;
    }
    
    const hasTask = !!this.dragDropService.touchDragTask;
    const isDragging = this.dragDropService.isTouchDragging;
    
    if (!hasTask && !isDragging) return;
    
    // 🔧 修复：如果拖拽刚刚激活（500ms 内），忽略 pointerup 事件
    // 这可以防止在 DOM 变化后 pointerup 被过早触发
    const dragActivationTime = this.dragDropService.getDragActivationTime();
    if (dragActivationTime && Date.now() - dragActivationTime < 500) {
      console.log('[GlobalPointerUp] Ignoring - drag just activated', {
        elapsed: Date.now() - dragActivationTime
      });
      return;
    }
    
    console.log('[GlobalPointerUp] Processing pointerup', {
      pointerType: event.pointerType,
      hasTask,
      isDragging,
      isPrimary: event.isPrimary
    });
    
    // ⚠️ 只有当触摸真正结束（没有其他手指在屏幕上）时才处理
    // pointerup 可能在 DOM 变化后被过早触发
    // 检查事件是否是主要触点
    if (!event.isPrimary) {
      console.log('[GlobalPointerUp] Not primary pointer, ignoring');
      return;
    }
    
    // 执行与 touchend 相同的逻辑
    this.ngZone.run(() => {
      this.onTouchEnd(event as unknown as TouchEvent);
    });
  }
  
  /** 处理拖拽超时 - 当 touchend 丢失时自动完成拖拽 */
  private handleTouchDragTimeout(event: CustomEvent) {
    const { task, targetStage, targetBeforeId } = event.detail;
    console.warn('[TextView] TouchDragTimeout received', {
      taskId: task?.id.slice(-4),
      targetStage,
      targetBeforeId: targetBeforeId?.slice(-4) || null
    });
    
    if (task && targetStage !== null) {
      // 执行移动操作
      this.ngZone.run(() => {
        // console.log('[TouchDragTimeout] Auto-completing drag', {
        //   from: task.stage,
        //   to: targetStage,
        //   beforeId: targetBeforeId?.slice(-4) || null
        // });
        
        const result = this.taskOpsAdapter.moveTaskToStage(task.id, targetStage, targetBeforeId);
        if (isFailure(result)) {
          const errorDetail = getErrorMessage(result.error);
          console.error('[TouchDragTimeout] Move failed:', errorDetail);
          this.toast.error('移动任务失败', `无法将任务移动到阶段 ${targetStage}：${errorDetail}`);
        } else {
          // console.log('[TouchDragTimeout] Move succeeded');
        }
        
        // 清理拖拽状态并恢复阶段折叠
        const touchEndResult = this.dragDropService.endTouchDrag();
        const mouseExpandedStages = this.dragDropService.endDrag();
        this.collapseAutoExpandedStages(touchEndResult.autoExpandedStages, mouseExpandedStages);
        this.restoreAutoCollapsedSourceStage();
      });
    } else {
      // 只清理状态
      const touchEndResult = this.dragDropService.endTouchDrag();
      const mouseExpandedStages = this.dragDropService.endDrag();
      this.collapseAutoExpandedStages(touchEndResult.autoExpandedStages, mouseExpandedStages);
      this.restoreAutoCollapsedSourceStage();
    }
  }
  
  /** 紧急清理处理器：如果有残留的拖拽状态，强制清理 */
  private handleEmergencyCleanup(_event: MouseEvent) {
    // ⚠️ 重要：如果正在触摸拖拽，不要清理！
    // 移动端浏览器在 touchend 后会自动触发 click 事件
    if (this.dragDropService.isTouchDragging) {
      // console.log('[EmergencyCleanup] Ignoring - touch drag in progress');
      return;
    }
    
    const isDragging = this.dragDropService.draggingTaskId();
    const hasGhost = !!this.dragDropService['touchState']?.dragGhost;
    
    if (isDragging || hasGhost) {
      console.warn('[TextView] Emergency cleanup triggered - found orphaned drag state');
      const touchEndResult = this.dragDropService.endTouchDrag();
      const mouseExpandedStages = this.dragDropService.endDrag();
      this.collapseAutoExpandedStages(touchEndResult.autoExpandedStages, mouseExpandedStages);
      this.restoreAutoCollapsedSourceStage();
    }
  }
  
  ngOnDestroy() {
    // 移除全局触摸事件监听器
    // 注意：removeEventListener 必须与 addEventListener 的 capture 设置匹配
    document.removeEventListener('touchend', this.boundGlobalTouchEnd, { capture: true } as EventListenerOptions);
    document.removeEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointerup', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointercancel', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
    document.removeEventListener('click', this.boundEmergencyCleanup, { capture: true } as EventListenerOptions);
    document.removeEventListener('touchDragTimeout', this.boundTouchDragTimeout);
    // console.log('[TextView] Global touch listeners removed');
    
    this.dragDropService.cleanup();
    // 清理所有待处理的定时器，防止内存泄漏
    this.pendingTimers.forEach(timer => clearTimeout(timer));
    this.pendingTimers = [];
  }
  
  // ========== 容器点击处理 ==========
  
  /**
   * 点击空白区域时收缩已展开的任务
   */
  onContainerClick(event: Event) {
    const target = event.target as HTMLElement;
    
    // 如果点击的是任务卡片内部，不处理（由卡片自己处理）
    if (target.closest('[data-task-id]') || target.closest('[data-unassigned-task]')) {
      return;
    }
    
    // 如果点击的是按钮、输入框等交互元素，不处理
    if (target.closest('button, input, textarea, a, [role="button"]')) {
      return;
    }
    
    // 点击空白区域，收缩当前展开的任务
    if (this.selectedTaskId()) {
      this.selectedTaskId.set(null);
    }
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

  /** 折叠在拖拽过程中临时展开但尚未收起的阶段 */
  private collapseAutoExpandedStages(...stageGroups: Array<number[] | null | undefined>): void {
    if (!this.stagesRef) return;
    const merged: number[] = [];
    for (const group of stageGroups) {
      if (!group?.length) continue;
      merged.push(...group);
    }
    if (!merged.length) return;
    const uniqueStages = Array.from(new Set(merged));
    requestAnimationFrame(() => {
      uniqueStages.forEach(stage => this.stagesRef?.collapseStage(stage));
    });
  }

  /** 根据拖拽来源阶段状态决定是否需要立即折叠 */
  private collapseSourceStageIfNeeded(currentStageNumber: number | null): void {
    const stageToCollapse = this.dragDropService.requestSourceStageCollapse(currentStageNumber);
    if (stageToCollapse !== null) {
      const isExpanded = this.stagesRef?.isStageExpanded(stageToCollapse) ?? false;
      if (isExpanded) {
        this.dragDropService.markSourceStageAutoCollapsed(stageToCollapse);
        this.collapseAutoExpandedStages([stageToCollapse]);
      }
    }
  }

  /** 在拖拽结束后恢复因拖拽自动折叠的阶段 */
  private restoreAutoCollapsedSourceStage(): void {
    const stageToRestore = this.dragDropService.consumeAutoCollapsedSourceStage();
    if (stageToRestore === null) return;
    requestAnimationFrame(() => this.stagesRef?.expandStage(stageToRestore));
  }
  
  // ========== 待办事项处理 ==========
  
  async onJumpToTask(taskId: string) {
    const task = this.projectState.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    if (task.stage) {
      // 有阶段的任务：跳转到阶段区域
      this.stagesRef?.expandStage(task.stage);
      if (this.uiState.stageFilter() !== 'all' && this.uiState.stageFilter() !== task.stage) {
        this.uiState.setStageFilter('all');
      }
      this.selectedTaskId.set(taskId);
      this.scrollToElementById(`[data-task-id="${taskId}"]`);
    } else {
      // 待分配的任务：跳转到待分配区域并展开任务卡片
      // 1. 确保待分配区域展开
      if (!this.uiState.isTextUnassignedOpen()) {
        this.uiState.isTextUnassignedOpen.set(true);
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
    // 子组件的 onTaskClick 已经处理了展开逻辑，这里只需发出事件
    this.focusFlowNode.emit(task.id);
  }
  
  onCreateUnassigned() {
    const result = this.taskOpsAdapter.addTask('', '', null, null, false);
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
    const result = this.taskOpsAdapter.addTask('', '', task.stage, task.parentId, true);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, task.stage);
    }
  }
  
  onAddChild(task: Task) {
    const newStage = (task.stage || 0) + 1;
    const result = this.taskOpsAdapter.addTask('', '', newStage, task.id, false);
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
        this.taskOpsAdapter.deleteTaskKeepChildren(task.id);
      } else {
        this.taskOpsAdapter.deleteTask(task.id);
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
    const maxStage = Math.max(...this.projectState.stages().map(s => s.stageNumber), 0);
    const result = this.taskOpsAdapter.addTask('', '', maxStage + 1, null, false);
    if (isFailure(result)) {
      this.toast.error('创建阶段失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, maxStage + 1);
    }
  }
  
  private navigateToNewTask(taskId: string, stage: number | null) {
    if (stage) {
      this.stagesRef?.expandStage(stage);
      if (this.uiState.stageFilter() !== 'all' && this.uiState.stageFilter() !== stage) {
        this.uiState.setStageFilter('all');
      }
    }
    this.selectedTaskId.set(taskId);
    this.scrollToTaskAndFocus(taskId, 'input[data-title-input]');
  }
  
  hasChildren(task: Task): boolean {
    return this.projectState.tasks().some(t => t.parentId === task.id);
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
    // console.log('[DragEnd] Called', {
    //   isTouchDragging: this.dragDropService.isTouchDragging,
    //   draggingTaskId: this.dragDropService.draggingTaskId()?.slice(-4) || 'none'
    // });
    
    // 如果是触摸拖拽，不在这里清除状态（由 touchend 处理）
    if (this.dragDropService.isTouchDragging) {
      // console.log('[DragEnd] Ignoring because touch drag is active');
      return;
    }
    
    // console.log('[DragEnd] Clearing drag state (mouse drag)');
    const mouseExpandedStages = this.dragDropService.endDrag();
    this.collapseAutoExpandedStages(mouseExpandedStages);
    this.restoreAutoCollapsedSourceStage();
  }
  
  onTaskDragOver(data: { event: DragEvent; task: Task; stageNumber: number }) {
    const { event, task, stageNumber } = data;
    event.preventDefault();
    event.stopPropagation();
    
    // 先触发阶段的拖拽处理，确保跨阶段拖拽时能正确更新目标阶段
    const isCollapsed = !this.stagesRef?.isStageExpanded(stageNumber);
    const result = this.dragDropService.handleStageDragOver(stageNumber, isCollapsed);
    
    if (result.collapse !== undefined) {
      this.stagesRef?.collapseStage(result.collapse);
    }
    if (result.expand !== undefined) {
      this.stagesRef?.expandStage(result.expand);
    }

    this.collapseSourceStageIfNeeded(stageNumber);
    
    // 然后处理任务级别的放置位置
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const isAbove = event.clientY < rect.top + rect.height / 2;
    
    if (isAbove) {
      this.dragDropService.updateDropTarget(stageNumber, task.id);
    } else {
      const stages = this.projectState.stages();
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

    this.collapseSourceStageIfNeeded(stageNumber);
  }
  
  onStageDragLeave(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    const relatedTarget = event.relatedTarget as HTMLElement;
    const currentTarget = event.currentTarget as HTMLElement;
    
    // 检查是否真的离开了这个阶段（而不是进入了子元素）
    // 如果 relatedTarget 为 null 或不在当前阶段内，说明真的离开了
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      const collapseStage = this.dragDropService.handleStageDragLeave(stageNumber);
      if (collapseStage !== null) {
        this.stagesRef?.collapseStage(collapseStage);
      }
      this.collapseSourceStageIfNeeded(null);
    }
  }
  
  onStageDrop(data: { event: DragEvent; stageNumber: number }) {
    const { event, stageNumber } = data;
    event.preventDefault();
    
    // 如果是触摸拖拽，不处理鼠标 drop 事件
    if (this.dragDropService.isTouchDragging) {
      // console.log('[StageDrop] Ignoring because touch drag is active');
      return;
    }
    
    const jsonData = event.dataTransfer?.getData('application/json');
    if (jsonData) {
      const task = JSON.parse(jsonData) as Task;
      const dropInfo = this.dragDropService.dropTargetInfo();

      // 关键逻辑：当把"待分配块"拖入阶段并插到某个块之前时，
      // 需要继承该参照块的 parentId，确保成为"同级任务块"并触发正确的编号重排。
      // 但必须验证该 parentId 对应的父任务是否在正确的阶段（targetStage - 1）
      const beforeTaskId = dropInfo?.beforeTaskId ?? null;
      let inferredParentId: string | null | undefined = undefined;
      
      if (beforeTaskId) {
        // 有明确的插入位置（在某个任务之前）
        const referenceTask = this.projectState.tasks().find(t => t.id === beforeTaskId) || null;
        if (referenceTask?.parentId) {
          // 验证参照任务的父任务是否在正确的阶段
          const parentTask = this.projectState.tasks().find(t => t.id === referenceTask.parentId);
          if (parentTask && parentTask.stage === stageNumber - 1) {
            inferredParentId = referenceTask.parentId;
          } else {
            // 父任务不在正确的阶段，不继承 parentId
            console.log('[StageDrop] 参照任务的 parentId 无效，不继承:', {
              referenceTaskId: beforeTaskId.slice(-4),
              parentId: referenceTask.parentId?.slice(-4),
              parentStage: parentTask?.stage ?? 'not found',
              expectedParentStage: stageNumber - 1
            });
            inferredParentId = null;
          }
        } else {
          inferredParentId = null;
        }
      } else {
        // 没有 beforeTaskId，说明拖到阶段最后
        // 查找该阶段的最后一个任务，将新任务放在它后面
        const stages = this.projectState.stages();
        const targetStage = stages.find(s => s.stageNumber === stageNumber);
        if (targetStage && targetStage.tasks.length > 0) {
          const lastTask = targetStage.tasks[targetStage.tasks.length - 1];
          if (lastTask.parentId) {
            // 验证最后一个任务的父任务是否在正确的阶段
            const parentTask = this.projectState.tasks().find(t => t.id === lastTask.parentId);
            if (parentTask && parentTask.stage === stageNumber - 1) {
              inferredParentId = lastTask.parentId;
            } else {
              // 父任务不在正确的阶段，不继承 parentId
              console.log('[StageDrop] 最后任务的 parentId 无效，不继承:', {
                lastTaskId: lastTask.id.slice(-4),
                parentId: lastTask.parentId?.slice(-4),
                parentStage: parentTask?.stage ?? 'not found',
                expectedParentStage: stageNumber - 1
              });
              inferredParentId = null;
            }
          } else {
            inferredParentId = null;
          }
          // beforeTaskId 保持为 null，这样会插入到最后
        }
      }

      const result = this.taskOpsAdapter.moveTaskToStage(task.id, stageNumber, beforeTaskId, inferredParentId);
      
      if (isFailure(result)) {
        const errorDetail = getErrorMessage(result.error);
        this.toast.error('移动任务失败', `无法将任务移动到阶段 ${stageNumber}：${errorDetail}`);
      } else {
        this.stagesRef?.expandStage(stageNumber);
      }

      this.collapseSourceStageIfNeeded(stageNumber);
    }
    
    const mouseExpandedStages = this.dragDropService.endDrag();
    this.collapseAutoExpandedStages(mouseExpandedStages);
    this.restoreAutoCollapsedSourceStage();
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
    console.log('[TouchStart] 🟢 onTaskTouchStart called', { 
      taskId: task.id.slice(-4),
      touches: event.touches.length,
      isSelected: this.selectedTaskId() === task.id
    });
    if (event.touches.length !== 1) return;
    if (this.selectedTaskId() === task.id) return;
    
    const touch = event.touches[0];
    this.dragDropService.startTouchDrag(task, touch, () => {
      // 拖拽开始回调
      console.log('[TouchStart] Drag start callback fired');
    });
  }
  
  onTouchMove(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const isDragging = this.dragDropService.handleTouchMove(touch);
    
    // 🔧 修复：检查 isTouchDragging 而不仅仅是 handleTouchMove 的返回值
    // 因为在长按激活后的第一次 touchmove 中，handleTouchMove 可能返回 true
    // 但我们需要确保后续的所有 touchmove 都能正确更新 Ghost
    const isActiveDragging = isDragging || this.dragDropService.isTouchDragging;
    
    if (isActiveDragging) {
      event.preventDefault();
      
      // 自动滚动
      const container = this.getScrollContainer();
      if (container) {
        this.dragDropService.performTouchAutoScroll(container, touch.clientY);
      }
      
      // 查找目标阶段
      const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
      let foundStage = false;
      
      // 获取当前拖拽的任务ID，用于过滤
      const draggingTaskId = this.dragDropService.draggingTaskId();
      
      // 获取当前悬停的阶段（避免重复展开/折叠）
      const currentHoverStage = this.dragDropService.dragOverStage();
      
      for (const el of elements) {
        const stageEl = el.closest('[data-stage-number]');
        if (stageEl) {
          const stageNum = parseInt(stageEl.getAttribute('data-stage-number') || '0', 10);
          if (stageNum > 0) {
            // 🔧 重新启用触摸拖拽时的自动展开/折叠
            // 当进入新阶段时：展开目标阶段，折叠之前的阶段
            if (currentHoverStage !== stageNum) {
              const wasCollapsed = this.stagesRef ? !this.stagesRef.isStageExpanded(stageNum) : false;

              // 标记开始 DOM 更新，忽略由此产生的 pointerup/pointercancel 事件
              this.dragDropService.beginDOMUpdate();
              
              // 先立即切换阶段并获取需要折叠的阶段
              const collapseStage = this.dragDropService.switchToStage(stageNum);
              
              console.log('[Stage Switch]', { from: currentHoverStage, to: stageNum, willCollapse: collapseStage });
              
              if (collapseStage !== null) {
                this.stagesRef?.collapseStage(collapseStage);
                console.log('[Stage] Collapsed:', collapseStage);
              }
              
              // 然后异步展开当前阶段
              if (wasCollapsed) {
                requestAnimationFrame(() => {
                  this.stagesRef?.expandStage(stageNum);
                  // DOM 更新完成后立即结束标记
                  setTimeout(() => this.dragDropService.endDOMUpdate(), 50);
                });
              } else {
                // 如果不需要展开，立即结束 DOM 更新标记
                this.dragDropService.endDOMUpdate();
              }
            }

            // 🔧 修复：无论是否切换阶段，都检查是否需要折叠来源阶段
            // 这样可以处理"在目标阶段内部移动"的场景
            this.collapseSourceStageIfNeeded(stageNum);
            
            // 检查是否在某个任务上方
            const taskEl = el.closest('[data-task-id]');
            if (taskEl) {
              const taskId = taskEl.getAttribute('data-task-id');
              
              // 🔧 修复：跳过正在被拖拽的任务本身，但仍然标记找到了阶段
              if (taskId && taskId !== draggingTaskId) {
                const rect = taskEl.getBoundingClientRect();
                const isAbove = touch.clientY < rect.top + rect.height / 2;
                
                if (isAbove) {
                  // console.log('[TouchMove] Target: before task', { stageNum, taskId: taskId.slice(-4) });
                  this.dragDropService.updateTouchTarget(stageNum, taskId);
                } else {
                  const stages = this.projectState.stages();
                  const stage = stages.find(s => s.stageNumber === stageNum);
                  const idx = stage?.tasks.findIndex(t => t.id === taskId) ?? -1;
                  const nextTask = stage?.tasks[idx + 1];
                  // console.log('[TouchMove] Target: after task', { 
                  //   stageNum, 
                  //   taskId: taskId.slice(-4), 
                  //   nextTaskId: nextTask?.id.slice(-4) || 'end' 
                  // });
                  this.dragDropService.updateTouchTarget(stageNum, nextTask?.id ?? null);
                }
              } else if (taskId === draggingTaskId) {
                // 手指在被拖拽任务本身上：设置目标为该任务所在阶段的末尾
                // console.log('[TouchMove] On dragging task itself, setting target to stage end', { stageNum });
                this.dragDropService.updateTouchTarget(stageNum, null);
              }
            } else {
              // console.log('[TouchMove] No task element, stage', stageNum);
              // 没有任务元素：设置目标为阶段开头
              this.dragDropService.updateTouchTarget(stageNum, null);
            }
            
            // 更新幽灵元素视觉反馈：在有效阶段上
            this.dragDropService.updateGhostVisualFeedback(true);
            
            foundStage = true;
            break;
          }
        }
      }
      
      if (!foundStage) {
        // 更新幽灵元素视觉反馈：不在有效阶段上
        this.dragDropService.updateGhostVisualFeedback(false);
        
        // 标记开始 DOM 更新
        this.dragDropService.beginDOMUpdate();
        
        // 获取需要折叠的阶段
        const collapseStage = this.dragDropService.updateTouchTarget(null, null);
        
        // 使用 requestAnimationFrame 延迟折叠，避免中断触摸事件
        if (collapseStage !== null) {
          requestAnimationFrame(() => {
            this.stagesRef?.collapseStage(collapseStage);
            // 折叠完成后立即结束 DOM 更新标记
            setTimeout(() => this.dragDropService.endDOMUpdate(), 50);
          });
        } else {
          // 没有需要折叠的阶段，立即结束 DOM 更新标记
          this.dragDropService.endDOMUpdate();
        }

        this.collapseSourceStageIfNeeded(null);
      }
      
      // console.log('[TouchMove] Completed processing');
    }
  }
  
  onTouchEnd(_event: TouchEvent) {
    // console.log('[onTouchEnd] Called');
    const touchEndResult = this.dragDropService.endTouchDrag();
    const mouseExpandedStages = this.dragDropService.endDrag();
    const { task, targetStage, targetBeforeId, wasDragging, autoExpandedStages } = touchEndResult;
    this.collapseAutoExpandedStages(autoExpandedStages, mouseExpandedStages);
    this.restoreAutoCollapsedSourceStage();
    
    // console.log('[TouchEnd] Drag ended:', {
    //   taskId: task?.id.slice(-4),
    //   targetStage,
    //   targetBeforeId: targetBeforeId?.slice(-4) || null,
    //   wasDragging,
    //   taskStage: task?.stage
    // });
    
    if (!task) {
      console.warn('[TouchEnd] No task found');
      return;
    }
    
    // 只有在真正拖拽到有效目标时才执行移动
    if (wasDragging && targetStage !== null) {
      // console.log('[TouchEnd] Moving task:', {
      //   taskId: task.id.slice(-4),
      //   from: task.stage,
      //   to: targetStage,
      //   beforeId: targetBeforeId?.slice(-4) || null,
      //   sameStage: task.stage === targetStage
      // });
      
      // 即使是同一阶段，也要执行移动（可能改变位置）
      const result = this.taskOpsAdapter.moveTaskToStage(task.id, targetStage, targetBeforeId);
      if (isFailure(result)) {
        const errorDetail = getErrorMessage(result.error);
        console.error('[TouchEnd] Move failed:', errorDetail);
        this.toast.error('移动任务失败', `无法将任务移动到阶段 ${targetStage}：${errorDetail}`);
      } else {
        // console.log('[TouchEnd] Move succeeded');
        // 🔧 修复：不要自动展开目标阶段，因为在拖拽过程中已经处理了展开/折叠
        // 自动展开会覆盖拖拽过程中的折叠操作
        // this.stagesRef?.expandStage(targetStage);
        console.log('[TouchEnd] Task moved, NOT auto-expanding target stage');
      }
    } else {
      // console.log('[TouchEnd] Not moving:', { wasDragging, targetStage });
    }
    // 如果 wasDragging 为 true 但 targetStage 为 null，说明松手时没在有效区域，不执行任何操作
  }

  /**
   * 处理触摸取消事件（系统中断触摸，如来电、通知等）
   * 注意：当阶段折叠时也可能触发 touchcancel，此时不应该结束拖拽
   */
  onTouchCancel(_event: TouchEvent) {
    // 检查是否仍在拖拽状态
    // 如果是因为 DOM 变化（阶段折叠）导致的 touchcancel，不结束拖拽
    // 只有在真正的系统中断时才结束
    // console.log('[TouchCancel] received', {
    //   isDragging: this.dragDropService.isTouchDragging,
    //   hasGhost: !!this.dragDropService.touchDragTask
    // });
    
    // 暂时忽略 touchcancel，让全局的 touchend 处理器来处理
    // 如果真的需要取消，1.5秒超时检测器会清理
  }
  
  /**
   * 全局触摸移动处理器（在顶层容器捕获）
   * 这样即使被拖拽的任务有 pointer-events-none，我们仍然能接收到触摸事件
   */
  onGlobalTouchMove(event: TouchEvent) {
    const hasTask = !!this.dragDropService.touchDragTask;
    const hasDraggingId = !!this.dragDropService.draggingTaskId();
    
    // 🔧 修复：检查是否有待处理的触摸任务（包括尚未激活拖拽的情况）
    // touchDragTask 在 startTouchDrag 时就设置了，但 draggingTaskId 要等 activateDrag 后才设置
    // 如果只检查 draggingTaskId，在长按激活前的移动会被忽略，导致 Ghost 无法创建
    if (!hasDraggingId && !hasTask) {
      return;
    }
    
    console.log('[TouchMove] 🟡 onGlobalTouchMove processing', { hasTask, hasDraggingId });
    
    // 如果正在拖拽或有待处理的触摸任务，处理触摸移动
    this.onTouchMove(event);
  }
  
  /**
   * 全局触摸结束处理器
   */
  onGlobalTouchEnd(event: TouchEvent) {
    // 🔧 修复：检查是否有待处理的触摸任务（包括尚未激活拖拽的情况）
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) {
      return;
    }
    
    this.onTouchEnd(event);
  }
  
  /**
   * 全局触摸取消处理器
   */
  onGlobalTouchCancel(event: TouchEvent) {
    // 🔧 修复：检查是否有待处理的触摸任务（包括尚未激活拖拽的情况）
    if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) {
      return;
    }
    
    this.onTouchCancel(event);
  }
  
  /**
   * document 级别的全局 touchend 处理器
   * 确保即使被拖拽元素有 pointer-events-none 也能捕获到事件
   */
  private handleGlobalTouchEnd(event: TouchEvent) {
    // 无条件记录所有 touchend，确保监听器正常工作
    // console.log('[GlobalTouchEnd] *** CAPTURED ***', {
    //   timeStamp: event.timeStamp,
    //   touches: event.touches.length,
    //   changedTouches: event.changedTouches.length
    // });
    
    // ⚠️ 如果正在 DOM 更新（折叠/展开阶段），忽略此事件
    // 这是因为阶段折叠移除 DOM 元素时可能触发假的 touchend
    if (this.dragDropService.isDOMUpdating) {
      // console.log('[GlobalTouchEnd] Ignoring - DOM update in progress');
      return;
    }
    
    // console.log('[GlobalTouchEnd] RAW event received', {
    //   type: event.type,
    //   timeStamp: event.timeStamp,
    //   target: (event.target as HTMLElement)?.tagName,
    //   touchCount: event.touches.length,
    //   changedTouchCount: event.changedTouches.length
    // });
    
    const _isTouchDragging = this.dragDropService.isTouchDragging;
    const hasTask = !!this.dragDropService.touchDragTask;
    
    // console.log('[GlobalTouchEnd] State check', {
    //   isTouchDragging,
    //   hasTask,
    //   draggingTaskId: this.dragDropService.draggingTaskId()?.slice(-4) || 'none'
    // });
    
    // 检查是否有触摸任务（无论是否已完成 100ms 长按）
    if (!hasTask) {
      // console.log('[GlobalTouchEnd] No touch task, ignoring');
      return;
    }
    
    // console.log('[GlobalTouchEnd] Processing touch end', { isTouchDragging });
    // 在 Angular zone 内执行
    this.ngZone.run(() => {
      this.onTouchEnd(event);
    });
  }
  
  /**
   * document 级别的全局 touchcancel 处理器
   */
  private handleGlobalTouchCancel(event: TouchEvent) {
    // console.log('[GlobalTouchCancel] *** CAPTURED ***', {
    //   timeStamp: event.timeStamp,
    //   touches: event.touches.length
    // });
    
    // ⚠️ 如果正在 DOM 更新（折叠/展开阶段），忽略此事件
    if (this.dragDropService.isDOMUpdating) {
      // console.log('[GlobalTouchCancel] Ignoring - DOM update in progress');
      return;
    }
    
    if (!this.dragDropService.draggingTaskId()) {
      // console.log('[GlobalTouchCancel] No dragging task, ignoring');
      return;
    }
    
    // console.log('[GlobalTouchCancel] Processing');
    this.ngZone.run(() => {
      this.onTouchCancel(event);
    });
  }
}
