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
  
  /** 是否正在进行 DOM 更新（折叠/展开阶段），此时忽略 pointerup/pointercancel */
  private isUpdatingDOM = false;
  
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
  
  /** 拖拽来源阶段 */
  private dragSourceStage: number | null = null;

  /** 来源阶段是否已经因为拖拽而折叠 */
  private sourceStageCollapsed = false;

  /** 因拖拽自动折叠的阶段（用于拖拽结束后恢复） */
  private autoCollapsedSourceStage: number | null = null;

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
      expandedDuringDrag: new Set<number>(),
      originalStage: null  // 任务原始所在的阶段，拖拽期间不折叠
    };
  }
  
  // ========== 鼠标拖拽方法 ==========
  
  /** 开始鼠标拖拽 */
  startDrag(task: Task) {
    this.draggingTaskId.set(task.id);
    this.setDragSourceStage(task.stage ?? null);
  }
  
  /** 结束拖拽（鼠标和触摸通用），返回拖拽期间临时展开但尚未折叠的阶段 */
  endDrag(): number[] {
    const pendingCollapseStages = Array.from(this.dragExpandState.expandedDuringDrag);
    
    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
    
    // 清理鼠标拖拽展开状态
    this.dragExpandState.previousHoverStage = null;
    this.dragExpandState.expandedDuringDrag.clear();
    
    // 停止自动滚动
    this.stopAutoScroll();

    this.dragSourceStage = null;
    this.sourceStageCollapsed = false;

    return pendingCollapseStages;
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
  
  /** 长按延迟时间（毫秒）- 用于区分点击和拖拽 */
  private readonly LONG_PRESS_DELAY = 200;
  
  /** 长按回调 - 用于通知组件拖拽已开始 */
  private onDragStartCallback: (() => void) | null = null;
  
  /** 开始触摸拖拽准备（长按检测） */
  startTouchDrag(task: Task, touch: Touch, onDragStart: () => void): void {
    // console.log('[TouchDrag] startTouchDrag called', {
    //   taskId: task.id.slice(-4),
    //   position: { x: touch.clientX, y: touch.clientY },
    //   originalStage: task.stage
    // });
    
    this.resetTouchState();
    
    this.touchState.task = task;
    this.touchState.startX = touch.clientX;
    this.touchState.startY = touch.clientY;
    this.touchState.currentX = touch.clientX;
    this.touchState.currentY = touch.clientY;
    this.touchState.originalStage = task.stage ?? null;  // 记录任务原始阶段
    this.onDragStartCallback = onDragStart;
    
    // 使用长按延迟来区分点击和拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      if (this.touchState.task) {
        this.activateDrag();
      }
    }, this.LONG_PRESS_DELAY);
  }
  
  /** 激活拖拽状态（长按后或移动距离足够后） */
  private activateDrag(): void {
    if (this.touchState.isDragging || !this.touchState.task) return;
    
    this.touchState.isDragging = true;
    this.setDragSourceStage(this.touchState.originalStage);
    this.draggingTaskId.set(this.touchState.task.id);
    
    // 设置 previousHoverStage 为原始阶段，这样离开时可以触发折叠
    this.touchState.previousHoverStage = this.touchState.originalStage;
    if (this.touchState.originalStage !== null) {
      this.dragOverStage.set(this.touchState.originalStage);
      // 关键修复：将原始阶段也添加到追踪集合中
      // 这样当拖入其他阶段时，原始阶段可以被正确折叠
      this.touchState.expandedDuringDrag.add(this.touchState.originalStage);
    }
    
    // console.log('[TouchDrag] isDragging activated', {
    //   taskId: this.touchState.task.id.slice(-4),
    //   originalStage: this.touchState.originalStage,
    //   previousHoverStage: this.touchState.previousHoverStage
    // });
    this.createDragGhost(this.touchState.task, this.touchState.currentX, this.touchState.currentY);
    this.onDragStartCallback?.();
    navigator.vibrate?.(50);
  }
  
  /** touchmove 超时检测器 */
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastMoveTime: number = 0;
  
  private startMoveTimeoutDetector() {
    this.clearMoveTimeout();
    this.lastMoveTime = Date.now();
    
    // 1.5 秒没有 touchmove 活动，认为用户已经松手但 touchend 丢失
    this.moveTimeoutId = setTimeout(() => {
      const timeSinceLastMove = Date.now() - this.lastMoveTime;
      if (this.touchState.isDragging && this.touchState.task && timeSinceLastMove >= 1300) {
        console.warn('[TouchDrag] Move timeout - no activity for 1.5s, touchend may have been lost');
        // 触发一个自定义事件，让组件处理
        document.dispatchEvent(new CustomEvent('touchDragTimeout', {
          detail: {
            task: this.touchState.task,
            targetStage: this.touchState.targetStage,
            targetBeforeId: this.touchState.targetBeforeId
          }
        }));
      }
    }, 1500); // 1.5 秒没有活动
  }
  
  private clearMoveTimeout() {
    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }
  }
  
  /** 处理触摸移动 */
  handleTouchMove(touch: Touch): boolean {
    if (!this.touchState.task) return false;
    
    // 更新当前触摸位置
    this.touchState.currentX = touch.clientX;
    this.touchState.currentY = touch.clientY;
    
    // 如果还没开始拖拽，检查移动距离是否超过阈值
    if (!this.touchState.isDragging) {
      const deltaX = Math.abs(touch.clientX - this.touchState.startX);
      const deltaY = Math.abs(touch.clientY - this.touchState.startY);
      const moveThreshold = 10; // 移动超过10像素也激活拖拽
      
      if (deltaX > moveThreshold || deltaY > moveThreshold) {
        // 取消长按定时器，直接激活拖拽
        this.cancelLongPress();
        this.activateDrag();
      } else {
        // 移动距离不够，继续等待长按
        return false;
      }
    }
    
    // 重置超时检测器 - 有活动说明还在正常拖拽
    this.startMoveTimeoutDetector();
    
    if (this.touchState.isDragging) {
      // 更新幽灵元素位置
      if (this.touchState.dragGhost) {
        this.touchState.dragGhost.style.left = `${touch.clientX - 60}px`;
        this.touchState.dragGhost.style.top = `${touch.clientY - 24}px`;
      } else {
        // 如果幽灵元素不存在，重新创建它
        console.warn('[TouchDrag] Ghost missing during move, recreating');
        this.createDragGhost(this.touchState.task, touch.clientX, touch.clientY);
      }
      
      return true;
    }
    
    return false;
  }
  
  /** 更新触摸目标阶段
   * 仅折叠“拖拽过程中自动展开”的阶段，避免把原本就展开的阶段折叠掉
   */
  /** 切换到新阶段（处理阶段展开/折叠逻辑） */
  switchToStage(stageNumber: number): number | null {
    const prevStage = this.touchState.previousHoverStage;
    
    // 检查是否需要折叠之前的阶段
    let stageToCollapse: number | null = null;
    if (
      prevStage !== null &&
      prevStage !== stageNumber &&
      this.touchState.expandedDuringDrag.has(prevStage)
    ) {
      stageToCollapse = prevStage;
      this.touchState.expandedDuringDrag.delete(prevStage);
    }
    
    // 更新当前阶段
    this.touchState.previousHoverStage = stageNumber;
    this.touchState.expandedDuringDrag.add(stageNumber);
    this.dragOverStage.set(stageNumber);
    
    return stageToCollapse;
  }
  
  /** 更新触摸目标位置（只更新任务位置，不改变阶段追踪） */
  updateTouchTarget(stageNumber: number | null, beforeTaskId: string | null, _options?: { autoExpanded?: boolean }): number | null {
    // 只更新任务位置，不修改阶段追踪状态
    if (stageNumber !== null) {
      this.touchState.targetStage = stageNumber;
      this.touchState.targetBeforeId = beforeTaskId;
      this.dropTargetInfo.set({ stageNumber, beforeTaskId });
    } else {
      // ⚠️ 离开所有阶段时的特殊处理
      const prevStage = this.touchState.previousHoverStage;
      let stageToCollapse: number | null = null;
      
      if (prevStage !== null && this.touchState.expandedDuringDrag.has(prevStage)) {
        stageToCollapse = prevStage;
        this.touchState.expandedDuringDrag.delete(prevStage);
      }
      
      // ⚠️ 不要清除 targetStage 和 targetBeforeId！
      // 保留之前的目标，这样当用户在阶段外松手时，任务仍会移动到最后一个有效目标
      // 只清除视觉状态和 previousHoverStage
      this.touchState.previousHoverStage = null;
      this.dragOverStage.set(null);
      this.dropTargetInfo.set(null);
      
      return stageToCollapse;
    }
    
    return null;
  }
  
  /** 结束触摸拖拽，返回目标信息以及需要折叠的阶段 */
  endTouchDrag(): { task: Task | null; targetStage: number | null; targetBeforeId: string | null; wasDragging: boolean; autoExpandedStages: number[] } {
    // 取消长按定时器
    // 清除超时检测器
    this.clearMoveTimeout();
    this.cancelLongPress();
    
    // 停止自动滚动
    this.stopTouchAutoScroll();

    const autoExpandedStages = Array.from(this.touchState.expandedDuringDrag);
    
    const result = {
      task: this.touchState.task,
      targetStage: this.touchState.targetStage,
      targetBeforeId: this.touchState.targetBeforeId,
      wasDragging: this.touchState.isDragging,
      autoExpandedStages
    };
    
    // console.log('[TouchDrag] endTouchDrag called', {
    //   taskId: result.task?.id.slice(-4) || 'none',
    //   targetStage: result.targetStage,
    //   targetBeforeId: result.targetBeforeId?.slice(-4) || null,
    //   wasDragging: result.wasDragging
    // });
    
    // 强制清理幽灵元素（必须在重置状态之前）
    this.removeDragGhost();
    
    // 重置触摸状态
    this.resetTouchState();
    
    // 清理拖拽相关的全局状态
    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
    
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
  
  /** 检查是否正在 DOM 更新 */
  get isDOMUpdating(): boolean {
    return this.isUpdatingDOM;
  }
  
  /** 开始 DOM 更新（在折叠/展开阶段前调用） */
  beginDOMUpdate(): void {
    this.isUpdatingDOM = true;
    // 100ms 后自动恢复，防止卡住
    // 需要足够时间让 Angular 完成变更检测并让浏览器完成 DOM 更新
    setTimeout(() => {
      this.isUpdatingDOM = false;
    }, 100);
  }
  
  /** 结束 DOM 更新 */
  endDOMUpdate(): void {
    this.isUpdatingDOM = false;
  }
  
  // ========== 幽灵元素方法 ==========
  
  private createDragGhost(task: Task, x: number, y: number) {
    this.removeDragGhost();
    
    const ghost = document.createElement('div');
    // 添加 data 属性以便后续清理
    ghost.setAttribute('data-drag-ghost', 'true');
    // 使用纯内联样式，避免 Tailwind 类不生效的问题
    ghost.style.cssText = `
      position: fixed;
      z-index: 9999;
      padding: 10px 16px;
      background-color: #4A8C8C;
      color: white;
      border-radius: 8px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      font-size: 14px;
      font-weight: bold;
      pointer-events: none;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transform: scale(1.1);
      opacity: 1;
      will-change: transform, opacity, left, top;
      border: 2px solid rgba(255, 255, 255, 0.3);
      left: ${x - 60}px;
      top: ${y - 24}px;
    `;
    ghost.textContent = task.title || '未命名任务';
    document.body.appendChild(ghost);
    this.touchState.dragGhost = ghost;
    
    // console.log('[TouchDrag] Ghost created:', {
    //   taskId: task.id.slice(-4),
    //   title: task.title || 'untitled',
    //   position: { x: x - 60, y: y - 24 }
    // });
  }
  
  /** 更新幽灵元素的视觉反馈（根据是否在有效目标上） */
  updateGhostVisualFeedback(isOverValidTarget: boolean) {
    if (this.touchState.dragGhost) {
      if (isOverValidTarget) {
        this.touchState.dragGhost.style.opacity = '1';
        this.touchState.dragGhost.style.transform = 'scale(1.1)';
        this.touchState.dragGhost.style.backgroundColor = '#4A8C8C'; // retro-teal
      } else {
        // 不在有效区域时变成警告色
        this.touchState.dragGhost.style.opacity = '0.9';
        this.touchState.dragGhost.style.transform = 'scale(1)';
        this.touchState.dragGhost.style.backgroundColor = '#C87941'; // retro-rust
      }
    }
  }
  
  private removeDragGhost() {
    // 清理当前引用的幽灵元素
    if (this.touchState.dragGhost) {
      try {
        // 方法1: 立即设置为不可见并从DOM移除
        const ghost = this.touchState.dragGhost;
        ghost.style.display = 'none';
        ghost.style.opacity = '0';
        ghost.remove();
      } catch (e) {
        console.warn('Failed to remove drag ghost:', e);
      }
      this.touchState.dragGhost = null;
    }
    
    // 防御性清理：查找并移除所有可能残留的幽灵元素
    // 使用 data 属性来标识幽灵元素
    requestAnimationFrame(() => {
      const ghosts = document.querySelectorAll('[data-drag-ghost="true"]');
      ghosts.forEach(ghost => {
        try {
          (ghost as HTMLElement).style.display = 'none';
          (ghost as HTMLElement).style.opacity = '0';
          ghost.remove();
        } catch (e) {
          console.warn('Failed to remove orphaned ghost element:', e);
        }
      });
    });
  }
  
  // ========== 自动滚动方法 ==========
  
  /** 启动自动滚动 */
  startAutoScroll(container: HTMLElement, clientY: number) {
    document.removeEventListener('dragover', this.boundHandleDragAutoScroll);
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.lastClientY = clientY;
    document.addEventListener('dragover', this.boundHandleDragAutoScroll);
    this.ensureAutoScrollLoop();
  }
  
  /** 执行触摸自动滚动 */
  performTouchAutoScroll(container: HTMLElement, clientY: number) {
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.lastClientY = clientY;
    this.ensureAutoScrollLoop();
  }
  
  private handleDragAutoScroll(e: DragEvent) {
    this.autoScrollState.lastClientY = e.clientY;
  }
  
  private ensureAutoScrollLoop() {
    if (this.autoScrollState.animationId) {
      return;
    }
    const step = () => {
      if (!this.shouldContinueAutoScroll()) {
        this.stopAutoScrollLoop(true);
        return;
      }
      this.performAutoScrollStep();
      this.autoScrollState.animationId = requestAnimationFrame(step);
    };
    this.autoScrollState.animationId = requestAnimationFrame(step);
  }
  
  private shouldContinueAutoScroll(): boolean {
    if (!this.autoScrollState.scrollContainer) {
      return false;
    }
    return this.touchState.isDragging || !!this.draggingTaskId();
  }
  
  private performAutoScrollStep() {
    const container = this.autoScrollState.scrollContainer;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const edgeSize = 100;
    const maxScrollSpeed = 18;
    const clientY = this.autoScrollState.lastClientY;
    let scrollAmount = 0;
    if (clientY < rect.top + edgeSize && clientY > rect.top - 20) {
      const distance = rect.top + edgeSize - clientY;
      const ratio = Math.min(1, Math.max(0, distance / edgeSize));
      scrollAmount = -maxScrollSpeed * ratio * ratio;
    } else if (clientY > rect.bottom - edgeSize && clientY < rect.bottom + 20) {
      const distance = clientY - (rect.bottom - edgeSize);
      const ratio = Math.min(1, Math.max(0, distance / edgeSize));
      scrollAmount = maxScrollSpeed * ratio * ratio;
    }
    if (scrollAmount !== 0) {
      container.scrollTop += scrollAmount;
    }
  }
  
  private stopAutoScroll() {
    document.removeEventListener('dragover', this.boundHandleDragAutoScroll);
    this.stopAutoScrollLoop(true);
  }
  
  /** 停止触摸自动滚动 */
  private stopTouchAutoScroll() {
    this.stopAutoScrollLoop(true);
  }
  
  private stopAutoScrollLoop(clearContainer = true) {
    if (this.autoScrollState.animationId) {
      cancelAnimationFrame(this.autoScrollState.animationId);
      this.autoScrollState.animationId = null;
    }
    if (clearContainer) {
      this.autoScrollState.scrollContainer = null;
    }
  }
  
  // ========== 清理方法 ==========
  
  private cancelLongPress() {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
  }
  
  /** 请求在离开来源阶段时折叠它 */
  requestSourceStageCollapse(currentStageNumber: number | null): number | null {
    if (this.dragSourceStage === null || this.sourceStageCollapsed) {
      return null;
    }
    if (currentStageNumber === this.dragSourceStage) {
      return null;
    }
    this.sourceStageCollapsed = true;
    return this.dragSourceStage;
  }

  /** 标记源阶段是由拖拽自动折叠的，方便事后恢复 */
  markSourceStageAutoCollapsed(stageNumber: number) {
    if (this.dragSourceStage === stageNumber) {
      this.autoCollapsedSourceStage = stageNumber;
    }
  }

  /** 读取并清空自动折叠的源阶段 */
  consumeAutoCollapsedSourceStage(): number | null {
    const stage = this.autoCollapsedSourceStage;
    this.autoCollapsedSourceStage = null;
    return stage;
  }

  private resetTouchState() {
    this.cancelLongPress();
    this.onDragStartCallback = null;
    this.touchState = this.createInitialTouchState();
  }

  private setDragSourceStage(stageNumber: number | null) {
    this.dragSourceStage = stageNumber;
    this.sourceStageCollapsed = false;
  }
  
  /** 清理所有资源（组件销毁时调用） */
  cleanup() {
    this.resetTouchState();
    this.removeDragGhost();
    this.stopAutoScroll();
    this.endDrag();
  }
}
