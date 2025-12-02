import { Injectable, signal } from '@angular/core';
import { Task } from '../../models';
import { TouchDragState, DragExpandState, AutoScrollState, DropTargetInfo } from './text-view.types';

/**
 * 拖拽服务
 * 统一管理鼠标拖拽和触摸拖拽的状态和逻辑
 */
@Injectable({ providedIn: 'root' })
export class TextViewDragDropService {
  // ========== 公共状态（信号） ==========
  
  /** 当前拖拽的任务ID */
  readonly draggingTaskId = signal<string | null>(null);
  
  /** 当前悬停的阶段 */
  readonly dragOverStage = signal<number | null>(null);
  
  /** 放置目标信息 */
  readonly dropTargetInfo = signal<DropTargetInfo | null>(null);
  
  // ========== 私有状态 ==========
  
  /** 鼠标拖拽展开状态 */
  private dragExpandState: DragExpandState = {
    previousHoverStage: null,
    expandedDuringDrag: new Set<number>()
  };
  
  /** 触摸拖拽状态 */
  private touchState: TouchDragState = this.createInitialTouchState();
  
  /** 自动滚动状态 */
  private autoScrollState: AutoScrollState = {
    animationId: null,
    scrollContainer: null,
    lastClientY: 0
  };
  
  /** dragover 事件处理器绑定 */
  private boundHandleDragAutoScroll = this.handleDragAutoScroll.bind(this);
  
  // ========== 初始化方法 ==========
  
  private createInitialTouchState(): TouchDragState {
    return {
      task: null,
      isDragging: false,
      targetStage: null,
      targetBeforeId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      longPressTimer: null,
      dragGhost: null,
      previousHoverStage: null,
      expandedDuringDrag: new Set<number>()
    };
  }
  
  // ========== 鼠标拖拽方法 ==========
  
  /** 开始鼠标拖拽 */
  startDrag(task: Task) {
    this.draggingTaskId.set(task.id);
  }
  
  /** 结束拖拽（鼠标和触摸通用） */
  endDrag() {
    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
    
    // 清理鼠标拖拽展开状态
    this.dragExpandState.previousHoverStage = null;
    this.dragExpandState.expandedDuringDrag.clear();
    
    // 停止自动滚动
    this.stopAutoScroll();
  }
  
  /** 更新放置目标 */
  updateDropTarget(stageNumber: number, beforeTaskId: string | null) {
    this.dropTargetInfo.set({ stageNumber, beforeTaskId });
  }
  
  /** 处理阶段悬停（返回需要展开/折叠的阶段） */
  handleStageDragOver(stageNumber: number, isCollapsed: boolean): { expand?: number; collapse?: number } {
    const result: { expand?: number; collapse?: number } = {};
    
    // 如果切换到新阶段，需要闭合之前因拖拽而展开的阶段
    const prevStage = this.dragExpandState.previousHoverStage;
    if (prevStage !== null && prevStage !== stageNumber && this.dragExpandState.expandedDuringDrag.has(prevStage)) {
      result.collapse = prevStage;
      this.dragExpandState.expandedDuringDrag.delete(prevStage);
    }
    
    this.dragOverStage.set(stageNumber);
    
    // 只有当阶段是折叠状态时才展开并记录
    if (isCollapsed) {
      result.expand = stageNumber;
      this.dragExpandState.expandedDuringDrag.add(stageNumber);
    }
    
    this.dragExpandState.previousHoverStage = stageNumber;
    
    const dropInfo = this.dropTargetInfo();
    if (!dropInfo || dropInfo.stageNumber !== stageNumber) {
      this.dropTargetInfo.set({ stageNumber, beforeTaskId: null });
    }
    
    return result;
  }
  
  /** 处理阶段离开（返回需要折叠的阶段） */
  handleStageDragLeave(stageNumber: number): number | null {
    this.dragOverStage.set(null);
    
    // 如果这个阶段是因为拖拽而临时展开的，返回它以便折叠
    if (this.dragExpandState.expandedDuringDrag.has(stageNumber)) {
      this.dragExpandState.expandedDuringDrag.delete(stageNumber);
      this.dragExpandState.previousHoverStage = null;
      return stageNumber;
    }
    
    this.dragExpandState.previousHoverStage = null;
    return null;
  }
  
  // ========== 触摸拖拽方法 ==========
  
  /** 开始触摸拖拽准备（长按检测） */
  startTouchDrag(task: Task, touch: Touch, onDragStart: () => void): void {
    this.resetTouchState();
    
    this.touchState.task = task;
    this.touchState.startX = touch.clientX;
    this.touchState.startY = touch.clientY;
    this.touchState.currentX = touch.clientX;
    this.touchState.currentY = touch.clientY;
    
    // 长按 200ms 后开始拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      if (this.touchState.task?.id === task.id) {
        this.touchState.isDragging = true;
        this.draggingTaskId.set(task.id);
        this.createDragGhost(task, touch.clientX, touch.clientY);
        onDragStart();
        navigator.vibrate?.(50);
      }
    }, 200);
  }
  
  /** 处理触摸移动 */
  handleTouchMove(touch: Touch): boolean {
    if (!this.touchState.task) return false;
    
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.touchState.isDragging && (deltaX > 10 || deltaY > 10)) {
      this.cancelLongPress();
      return false;
    }
    
    if (this.touchState.isDragging) {
      this.touchState.currentX = touch.clientX;
      this.touchState.currentY = touch.clientY;
      
      // 更新幽灵元素位置
      if (this.touchState.dragGhost) {
        this.touchState.dragGhost.style.left = `${touch.clientX - 40}px`;
        this.touchState.dragGhost.style.top = `${touch.clientY - 20}px`;
      }
      
      return true;
    }
    
    return false;
  }
  
  /** 更新触摸目标阶段 */
  updateTouchTarget(stageNumber: number | null, beforeTaskId: string | null) {
    const prevStage = this.touchState.previousHoverStage;
    
    if (stageNumber !== null) {
      this.touchState.targetStage = stageNumber;
      this.touchState.targetBeforeId = beforeTaskId;
      this.touchState.previousHoverStage = stageNumber;
      this.touchState.expandedDuringDrag.add(stageNumber);
      this.dragOverStage.set(stageNumber);
      this.dropTargetInfo.set({ stageNumber, beforeTaskId });
    } else {
      this.touchState.targetStage = null;
      this.touchState.targetBeforeId = null;
      this.touchState.previousHoverStage = null;
      this.dragOverStage.set(null);
      this.dropTargetInfo.set(null);
    }
    
    // 返回需要折叠的阶段
    if (prevStage !== null && prevStage !== stageNumber) {
      return prevStage;
    }
    return null;
  }
  
  /** 结束触摸拖拽，返回目标信息 */
  endTouchDrag(): { task: Task | null; targetStage: number | null; targetBeforeId: string | null; wasDragging: boolean } {
    this.cancelLongPress();
    
    const result = {
      task: this.touchState.task,
      targetStage: this.touchState.targetStage,
      targetBeforeId: this.touchState.targetBeforeId,
      wasDragging: this.touchState.isDragging
    };
    
    this.removeDragGhost();
    this.resetTouchState();
    
    return result;
  }
  
  /** 获取触摸拖拽状态 */
  get isTouchDragging(): boolean {
    return this.touchState.isDragging;
  }
  
  /** 获取触摸拖拽的任务 */
  get touchDragTask(): Task | null {
    return this.touchState.task;
  }
  
  // ========== 幽灵元素方法 ==========
  
  private createDragGhost(task: Task, x: number, y: number) {
    this.removeDragGhost();
    
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-retro-teal/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名任务';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    ghost.style.transform = 'scale(1.05)';
    ghost.style.opacity = '0.95';
    document.body.appendChild(ghost);
    this.touchState.dragGhost = ghost;
  }
  
  private removeDragGhost() {
    this.touchState.dragGhost?.remove();
    this.touchState.dragGhost = null;
  }
  
  // ========== 自动滚动方法 ==========
  
  /** 启动自动滚动 */
  startAutoScroll(container: HTMLElement, clientY: number) {
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.lastClientY = clientY;
    
    document.addEventListener('dragover', this.boundHandleDragAutoScroll);
  }
  
  /** 执行触摸自动滚动 */
  performTouchAutoScroll(container: HTMLElement, clientY: number) {
    const rect = container.getBoundingClientRect();
    const edgeSize = 80;
    const maxScrollSpeed = 12;
    
    let scrollAmount = 0;
    
    if (clientY < rect.top + edgeSize && clientY > rect.top - 20) {
      const distance = rect.top + edgeSize - clientY;
      scrollAmount = -Math.min(maxScrollSpeed, (distance / edgeSize) * maxScrollSpeed);
    } else if (clientY > rect.bottom - edgeSize && clientY < rect.bottom + 20) {
      const distance = clientY - (rect.bottom - edgeSize);
      scrollAmount = Math.min(maxScrollSpeed, (distance / edgeSize) * maxScrollSpeed);
    }
    
    if (scrollAmount !== 0) {
      container.scrollTop += scrollAmount;
    }
  }
  
  private handleDragAutoScroll(e: DragEvent) {
    this.autoScrollState.lastClientY = e.clientY;
    this.performAutoScroll();
  }
  
  private performAutoScroll() {
    const container = this.autoScrollState.scrollContainer;
    if (!container) return;
    
    const clientY = this.autoScrollState.lastClientY;
    const rect = container.getBoundingClientRect();
    const edgeSize = 60;
    const maxScrollSpeed = 15;
    
    let scrollAmount = 0;
    
    if (clientY < rect.top + edgeSize && clientY > rect.top) {
      const distance = rect.top + edgeSize - clientY;
      scrollAmount = -Math.min(maxScrollSpeed, (distance / edgeSize) * maxScrollSpeed);
    } else if (clientY > rect.bottom - edgeSize && clientY < rect.bottom) {
      const distance = clientY - (rect.bottom - edgeSize);
      scrollAmount = Math.min(maxScrollSpeed, (distance / edgeSize) * maxScrollSpeed);
    }
    
    if (scrollAmount !== 0) {
      container.scrollTop += scrollAmount;
    }
  }
  
  private stopAutoScroll() {
    document.removeEventListener('dragover', this.boundHandleDragAutoScroll);
    
    if (this.autoScrollState.animationId) {
      cancelAnimationFrame(this.autoScrollState.animationId);
    }
    
    this.autoScrollState.scrollContainer = null;
    this.autoScrollState.animationId = null;
  }
  
  // ========== 清理方法 ==========
  
  private cancelLongPress() {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
  }
  
  private resetTouchState() {
    this.cancelLongPress();
    this.touchState = this.createInitialTouchState();
  }
  
  /** 清理所有资源（组件销毁时调用） */
  cleanup() {
    this.resetTouchState();
    this.removeDragGhost();
    this.stopAutoScroll();
    this.endDrag();
  }
}
