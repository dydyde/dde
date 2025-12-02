import { Injectable, inject, signal, NgZone } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { FlowDragDropService, InsertPositionInfo } from './flow-drag-drop.service';
import { Task } from '../models';
import { UnassignedTouchState, createInitialUnassignedTouchState } from '../models/flow-view-state';
import { UI_CONFIG } from '../config/constants';
import * as go from 'gojs';

/**
 * 触摸拖放回调
 */
export interface TouchDropCallback {
  (task: Task, position: InsertPositionInfo, docPoint: go.Point): void;
}

/**
 * FlowTouchService - 移动端触摸处理服务
 * 
 * 职责：
 * - 移动端触摸拖放（长按开始拖动）
 * - 幽灵元素管理
 * - 触摸事件节流
 * 
 * 设计原则：
 * - 封装所有触摸相关逻辑
 * - 管理触摸状态机
 * - 正确处理 NgZone
 */
@Injectable({
  providedIn: 'root'
})
export class FlowTouchService {
  private readonly store = inject(StoreService);
  private readonly logger = inject(LoggerService).category('FlowTouch');
  private readonly zone = inject(NgZone);
  private readonly dragDropService = inject(FlowDragDropService);
  
  // ========== 状态 ==========
  
  /** 当前正在拖动的待分配任务ID */
  readonly draggingId = signal<string | null>(null);
  
  /** 触摸状态 */
  private touchState: UnassignedTouchState = createInitialUnassignedTouchState();
  
  /** 销毁标志 */
  private isDestroyed = false;
  
  // ========== 公开方法 ==========
  
  /**
   * 触摸开始（待分配块）
   * @param event 触摸事件
   * @param task 被触摸的任务
   */
  startTouch(event: TouchEvent, task: Task): void {
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
    
    // 长按 250ms 后开始拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhostElement(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, UI_CONFIG.MOBILE_LONG_PRESS_DELAY);
  }
  
  /**
   * 触摸移动
   * @param event 触摸事件
   * @returns 是否应该阻止默认行为
   */
  handleTouchMove(event: TouchEvent): boolean {
    if (!this.touchState.task || event.touches.length !== 1) return false;
    
    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return false; // 不阻止事件，让页面正常滚动
    }
    
    if (this.touchState.isDragging) {
      // 更新幽灵元素位置
      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
      return true; // 阻止默认行为
    }
    
    return false;
  }
  
  /**
   * 触摸结束
   * @param event 触摸事件
   * @param diagramDiv 流程图容器元素
   * @param diagram GoJS Diagram 实例
   * @param callback 拖放结果回调
   */
  endTouch(
    event: TouchEvent,
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback
  ): void {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    
    const { task, isDragging } = this.touchState;
    
    // 移除幽灵元素
    this.removeGhostElement();
    
    if (task && isDragging && diagram && diagramDiv) {
      const touch = event.changedTouches[0];
      const diagramRect = diagramDiv.getBoundingClientRect();
      
      // 检查是否在流程图区域内
      if (touch.clientX >= diagramRect.left && touch.clientX <= diagramRect.right &&
          touch.clientY >= diagramRect.top && touch.clientY <= diagramRect.bottom) {
        
        // 转换为流程图坐标
        const x = touch.clientX - diagramRect.left;
        const y = touch.clientY - diagramRect.top;
        const pt = new go.Point(x, y);
        const loc = diagram.transformViewToDoc(pt);
        
        // 查找插入位置
        const insertInfo = this.dragDropService.findInsertPosition(loc, diagram);
        
        this.zone.run(() => {
          callback(task, insertInfo, loc);
        });
      }
    }
    
    this.cleanup();
  }
  
  /**
   * 清理状态
   */
  cleanup(): void {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    this.removeGhostElement();
    this.draggingId.set(null);
    this.touchState = createInitialUnassignedTouchState();
  }
  
  /**
   * 标记为已销毁
   */
  dispose(): void {
    this.isDestroyed = true;
    this.cleanup();
  }
  
  /**
   * 重置销毁标志（重新激活）
   */
  activate(): void {
    this.isDestroyed = false;
  }
  
  // ========== 抽屉拖动相关 ==========
  
  /**
   * 创建抽屉拖动处理器
   * @param onHeightChange 高度变化回调
   * @param onResizingChange 拖动状态变化回调
   * @param getInitialHeight 获取初始高度
   */
  createDrawerResizeHandler(
    onHeightChange: (height: number) => void,
    onResizingChange: (isResizing: boolean) => void,
    getInitialHeight: () => number
  ): {
    startResize: (event: TouchEvent) => void;
  } {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    
    const onMove = (ev: TouchEvent) => {
      if (!isResizing || ev.touches.length !== 1) return;
      ev.preventDefault();
      
      const deltaY = startY - ev.touches[0].clientY;
      const deltaVh = (deltaY / window.innerHeight) * 100;
      const newHeight = Math.max(15, Math.min(70, startHeight + deltaVh));
      onHeightChange(newHeight);
    };
    
    const onEnd = () => {
      isResizing = false;
      onResizingChange(false);
      
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
    
    return {
      startResize: (event: TouchEvent) => {
        if (event.touches.length !== 1) return;
        event.preventDefault();
        
        isResizing = true;
        onResizingChange(true);
        startY = event.touches[0].clientY;
        startHeight = getInitialHeight();
        
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
      }
    };
  }
  
  /**
   * 创建调色板拖动处理器
   * @param onHeightChange 高度变化回调
   * @param getInitialHeight 获取初始高度
   */
  createPaletteResizeHandler(
    onHeightChange: (height: number) => void,
    getInitialHeight: () => number
  ): {
    startResize: (event: TouchEvent) => void;
  } {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    
    const onMove = (ev: TouchEvent) => {
      if (!isResizing || ev.touches.length !== 1) return;
      ev.preventDefault();
      
      const delta = ev.touches[0].clientY - startY;
      const newHeight = Math.max(80, Math.min(500, startHeight + delta));
      onHeightChange(newHeight);
    };
    
    const onEnd = () => {
      isResizing = false;
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
    
    return {
      startResize: (event: TouchEvent) => {
        if (event.touches.length !== 1) return;
        event.preventDefault();
        
        isResizing = true;
        startY = event.touches[0].clientY;
        startHeight = getInitialHeight();
        
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
      }
    };
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 创建幽灵元素
   */
  private createGhostElement(task: Task, x: number, y: number): void {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }
  
  /**
   * 移除幽灵元素
   */
  private removeGhostElement(): void {
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }
  }
}
