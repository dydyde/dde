import { Component, input, output, signal, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';

/**
 * 流程图顶部调色板组件
 * 包含待办事项和待分配任务区域
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
      flex-shrink: 0;
    }
  `],
  template: `
    <!-- Top Palette Area (Resizable) - 空白区域支持滑动手势 -->
    <div class="flex-none flex flex-col overflow-hidden transition-none" 
         [style.height.px]="height()"
         (touchstart)="onPaletteAreaTouchStart($event)"
         (touchmove)="onPaletteAreaTouchMove($event)"
         (touchend)="onPaletteAreaTouchEnd($event)">
        <!-- 1. 待完成区域 (To-Do) -->
        <div class="flex-none mx-2 sm:mx-4 mt-2 sm:mt-4 px-2 sm:px-4 pb-1 sm:pb-2 transition-all duration-300 overflow-hidden rounded-xl sm:rounded-2xl bg-orange-50/60 dark:bg-stone-900/80 border border-orange-100/50 dark:border-stone-800/80 backdrop-blur-md z-10 relative">
            <div (click)="uiState.isFlowUnfinishedOpen.set(!uiState.isFlowUnfinishedOpen())" 
                 class="py-2 sm:py-3 cursor-pointer flex justify-between items-center group select-none">
                <span class="font-bold text-stone-700 dark:text-stone-100 text-xs sm:text-sm flex items-center gap-2 tracking-tight">
                    <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
                    待办事项
                </span>
                <span class="text-stone-300 dark:text-stone-500 text-xs transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" [class.rotate-180]="!uiState.isFlowUnfinishedOpen()">▼</span>
            </div>
            
            @if (uiState.isFlowUnfinishedOpen()) {
                <div class="pb-2 sm:pb-4 animate-slide-down max-h-24 sm:max-h-32 overflow-y-auto">
                    <ul class="space-y-1 sm:space-y-2">
                        @for (item of projectState.unfinishedItems(); track item.taskId + item.text) {
                            <li class="text-[10px] sm:text-xs text-stone-600 dark:text-stone-300 flex items-center gap-2 sm:gap-3 bg-white/80 dark:bg-stone-800/80 backdrop-blur-sm border border-stone-100/50 dark:border-stone-700/50 p-1.5 sm:p-2 rounded-lg hover:border-orange-200 dark:hover:border-orange-700 cursor-pointer group shadow-sm transition-all" (click)="centerOnNode.emit(item.taskId)">
                                <span class="w-1 h-1 rounded-full bg-stone-200 dark:bg-stone-600 group-hover:bg-orange-400 transition-colors ml-1"></span>
                                <span class="font-bold text-retro-muted dark:text-stone-400 text-[8px] sm:text-[9px] tracking-wider">{{projectState.compressDisplayId(item.taskDisplayId)}}</span>
                                <span class="truncate flex-1 group-hover:text-stone-900 dark:group-hover:text-stone-100 transition-colors">{{item.text}}</span>
                            </li>
                        }
                        @if (projectState.unfinishedItems().length === 0) {
                            <li class="text-[10px] sm:text-xs text-stone-400 dark:text-stone-500 italic px-2 font-light">暂无待办</li>
                        }
                    </ul>
                </div>
            }
        </div>

        <!-- 2. 待分配区域 (To-Assign) - 可拖动到流程图 -->
        <div class="flex-none mx-2 sm:mx-4 mt-1 sm:mt-2 mb-2 sm:mb-4 px-2 sm:px-4 pb-1 sm:pb-2 transition-all duration-300 overflow-hidden rounded-xl sm:rounded-2xl bg-teal-50/60 dark:bg-stone-900/80 border border-teal-100/50 dark:border-stone-800/80 backdrop-blur-md z-10 relative">
            <div (click)="uiState.isFlowUnassignedOpen.set(!uiState.isFlowUnassignedOpen())" 
                 class="py-2 sm:py-3 cursor-pointer flex justify-between items-center group select-none">
                <span class="font-bold text-stone-700 dark:text-stone-100 text-xs sm:text-sm flex items-center gap-2 tracking-tight">
                    <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
                    待分配
                </span>
                <span class="text-stone-300 dark:text-stone-500 text-xs transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" [class.rotate-180]="!uiState.isFlowUnassignedOpen()">▼</span>
            </div>

            @if (uiState.isFlowUnassignedOpen()) {
                <div class="pb-2 sm:pb-4 animate-slide-down max-h-24 sm:max-h-32 overflow-y-auto">
                    <div class="flex flex-wrap gap-1.5 sm:gap-2 unassigned-drag-area" 
                         id="unassignedPalette"
                         (dragover)="onDragOver($event)"
                         (drop)="onDrop($event)">
                        @for (task of projectState.unassignedTasks(); track task.id) {
                            <div 
                                draggable="true" 
                                (dragstart)="onDragStart($event, task)"
                                (touchstart)="onTouchStart($event, task)"
                                (touchmove)="onTouchMove($event)"
                                (touchend)="onTouchEnd($event)"
                                (click)="taskClick.emit(task)"
                                class="px-2 sm:px-3 py-1 sm:py-1.5 bg-white/80 dark:bg-stone-800/80 backdrop-blur-sm border border-stone-200/50 dark:border-stone-600/50 rounded-md text-[10px] sm:text-xs font-medium hover:border-teal-300 dark:hover:border-teal-600 hover:text-teal-700 dark:hover:text-teal-300 cursor-pointer shadow-sm transition-all active:scale-95 text-stone-500 dark:text-stone-300"
                                [ngClass]="{
                                  'bg-teal-100 dark:bg-teal-800 border-teal-400': draggingId() === task.id
                                }">
                                {{task.title}}
                            </div>
                        }
                        <button data-testid="create-unassigned-btn" (click)="createUnassigned.emit()" class="px-2 sm:px-3 py-1 sm:py-1.5 bg-white/50 dark:bg-stone-800/50 hover:bg-teal-50 dark:hover:bg-teal-900/50 text-stone-400 dark:text-stone-400 hover:text-teal-600 dark:hover:text-teal-300 rounded-md text-[10px] sm:text-xs font-medium border border-transparent transition-all">+ 新建</button>
                    </div>
                    <!-- 拖回待分配区域的提示 -->
                    @if (isDropTargetActive()) {
                      <div class="mt-1 sm:mt-2 p-1.5 sm:p-2 border-2 border-dashed border-teal-300 dark:border-teal-600 rounded-lg bg-teal-50/50 dark:bg-teal-900/30 text-center text-[10px] sm:text-xs text-teal-600 dark:text-teal-400 animate-pulse">
                        拖放到此处解除分配
                      </div>
                    }
                </div>
            }
        </div>
    </div>

    <!-- Resizer Handle -->
    <div class="h-2 sm:h-3 bg-transparent hover:bg-stone-200 dark:hover:bg-stone-700 cursor-row-resize z-20 flex-shrink-0 relative group transition-all flex items-center justify-center"
         [ngClass]="{
           'h-4 bg-stone-100 dark:bg-stone-800': uiState.isMobile()
         }"
         (mousedown)="startResize($event)"
         (touchstart)="startResizeTouch($event)">
         <div class="w-10 sm:w-12 h-0.5 sm:h-1 rounded-full bg-stone-300 dark:bg-stone-600 group-hover:bg-stone-400 dark:group-hover:bg-stone-500 transition-colors"
              [class.w-14]="uiState.isMobile()"
              [class.h-1]="uiState.isMobile()"></div>
    </div>
  `
})
export class FlowPaletteComponent implements OnDestroy {
  // P2-1 迁移：直接注入子服务
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  
  // 输入
  readonly height = input<number>(200);
  readonly isDropTargetActive = input<boolean>(false);
  
  // 输出事件
  readonly heightChange = output<number>();
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();
  
  // 手势滑动事件
  readonly swipeToText = output<void>();      // 向右滑动切换到文本视图
  readonly swipeToSidebar = output<void>();   // 向左滑动打开侧边栏
  
  // 内部状态
  readonly draggingId = signal<string | null>(null);
  
  // 拖动状态
  private isResizing = false;
  private startY = 0;
  private startHeight = 0;
  
  // 组件销毁状态
  private isDestroyed = false;
  
  // 调整大小事件监听器引用（用于清理）
  private resizeMouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private resizeMouseUpHandler: (() => void) | null = null;
  private resizeTouchMoveHandler: ((e: TouchEvent) => void) | null = null;
  private resizeTouchEndHandler: (() => void) | null = null;
  
  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };
  
  // 手势区域滑动状态
  private gestureState = {
    startX: 0,
    startY: 0,
    isSwiping: false,
    isResizing: false  // 是否进入调整大小模式
  };
  
  /**
   * 组件销毁时清理所有资源
   */
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 清理长按定时器
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
    
    // 清理幽灵元素
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }
    
    // 清理调整大小的事件监听器
    if (this.resizeMouseMoveHandler) {
      window.removeEventListener('mousemove', this.resizeMouseMoveHandler);
      this.resizeMouseMoveHandler = null;
    }
    if (this.resizeMouseUpHandler) {
      window.removeEventListener('mouseup', this.resizeMouseUpHandler);
      this.resizeMouseUpHandler = null;
    }
    if (this.resizeTouchMoveHandler) {
      window.removeEventListener('touchmove', this.resizeTouchMoveHandler);
      this.resizeTouchMoveHandler = null;
    }
    if (this.resizeTouchEndHandler) {
      window.removeEventListener('touchend', this.resizeTouchEndHandler);
      window.removeEventListener('touchcancel', this.resizeTouchEndHandler);
      this.resizeTouchEndHandler = null;
    }
    
    // 恢复 body 样式
    if (this.isResizing) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.isResizing = false;
    }
  }
  
  // 拖动事件
  onDragStart(event: DragEvent, task: Task) {
    if (event.dataTransfer) {
      event.dataTransfer.setData("text", JSON.stringify(task));
      event.dataTransfer.setData("application/json", JSON.stringify(task));
      event.dataTransfer.effectAllowed = "move";
    }
    this.taskDragStart.emit({ event, task });
  }
  
  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }
  
  onDrop(event: DragEvent) {
    event.preventDefault();
    this.taskDrop.emit({ event });
  }
  
  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task) {
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
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 250);
    
    this.taskTouchStart.emit({ event, task });
  }
  
  onTouchMove(event: TouchEvent) {
    if (!this.touchState.task || event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }
    
    if (this.touchState.isDragging) {
      event.preventDefault();
      event.stopPropagation();
      
      // 更新幽灵元素位置
      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }
    
    this.taskTouchMove.emit({ event });
  }
  
  onTouchEnd(event: TouchEvent) {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    
    // 移除幽灵元素
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }
    
    this.draggingId.set(null);
    this.taskTouchEnd.emit({ event });
    
    this.touchState = {
      task: null, startX: 0, startY: 0, isDragging: false, longPressTimer: null, ghost: null
    };
  }
  
  private createGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }
  
  // 高度调整
  startResize(e: MouseEvent) {
    e.preventDefault();
    this.isResizing = true;
    this.startY = e.clientY;
    this.startHeight = this.height();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    
    // 先清理可能存在的旧监听器
    if (this.resizeMouseMoveHandler) {
      window.removeEventListener('mousemove', this.resizeMouseMoveHandler);
    }
    if (this.resizeMouseUpHandler) {
      window.removeEventListener('mouseup', this.resizeMouseUpHandler);
    }
    
    this.resizeMouseMoveHandler = (ev: MouseEvent) => {
      if (!this.isResizing || this.isDestroyed) return;
      const delta = ev.clientY - this.startY;
      const newHeight = Math.max(100, Math.min(600, this.startHeight + delta));
      this.heightChange.emit(newHeight);
    };
    
    this.resizeMouseUpHandler = () => {
      this.isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (this.resizeMouseMoveHandler) {
        window.removeEventListener('mousemove', this.resizeMouseMoveHandler);
        this.resizeMouseMoveHandler = null;
      }
      if (this.resizeMouseUpHandler) {
        window.removeEventListener('mouseup', this.resizeMouseUpHandler);
        this.resizeMouseUpHandler = null;
      }
    };
    
    window.addEventListener('mousemove', this.resizeMouseMoveHandler);
    window.addEventListener('mouseup', this.resizeMouseUpHandler);
  }
  
  // ========== 手势区域滑动处理（手机端视图切换） ==========
  
  /**
   * 手势区域触摸开始
   * 手机端用于左右滑动切换视图/打开侧边栏
   * 桌面端用于调整高度
   */
  onGestureAreaTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.gestureState = {
      startX: touch.clientX,
      startY: touch.clientY,
      isSwiping: false,
      isResizing: false
    };
    
    // 非手机端，使用原来的调整大小逻辑
    if (!this.uiState.isMobile()) {
      this.startResizeTouch(e);
    }
  }
  
  /**
   * 手势区域触摸移动
   * 判断是左右滑动还是上下拖动
   */
  onGestureAreaTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    
    // 非手机端不处理滑动手势
    if (!this.uiState.isMobile()) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.gestureState.startX;
    const deltaY = touch.clientY - this.gestureState.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    
    // 如果还没确定是水平滑动还是垂直拖动
    if (!this.gestureState.isSwiping && !this.gestureState.isResizing) {
      // 水平滑动距离大于垂直距离 1.5 倍，且超过 15px，认为是滑动手势
      if (absDeltaX > 15 && absDeltaX > absDeltaY * 1.5) {
        this.gestureState.isSwiping = true;
      } 
      // 垂直拖动距离大于水平距离，且超过 10px，认为是调整大小
      else if (absDeltaY > 10 && absDeltaY > absDeltaX) {
        this.gestureState.isResizing = true;
        // 开始调整大小
        this.isResizing = true;
        this.startY = this.gestureState.startY;
        this.startHeight = this.height();
      }
    }
    
    // 如果是调整大小模式
    if (this.gestureState.isResizing && this.isResizing) {
      e.preventDefault();
      const delta = touch.clientY - this.startY;
      const newHeight = Math.max(80, Math.min(500, this.startHeight + delta));
      this.heightChange.emit(newHeight);
    }
  }
  
  /**
   * 手势区域触摸结束
   * 根据滑动方向触发相应事件
   */
  onGestureAreaTouchEnd(e: TouchEvent) {
    // 非手机端不处理
    if (!this.uiState.isMobile()) return;
    
    // 如果是调整大小模式，结束调整
    if (this.gestureState.isResizing) {
      this.isResizing = false;
      this.gestureState.isResizing = false;
      return;
    }
    
    // 如果不是滑动手势，不处理
    if (!this.gestureState.isSwiping) return;
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - this.gestureState.startX;
    const threshold = 50; // 滑动阈值
    
    if (deltaX > threshold) {
      // 向右滑动 → 切换到文本视图（文本视图在左侧，手指向右滑动=页面向左切换）
      this.swipeToText.emit();
    } else if (deltaX < -threshold) {
      // 向左滑动 → 打开项目列表
      this.swipeToSidebar.emit();
    }
    
    this.gestureState.isSwiping = false;
  }
  
  startResizeTouch(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    this.isResizing = true;
    this.startY = e.touches[0].clientY;
    this.startHeight = this.height();
    
    // 先清理可能存在的旧监听器
    if (this.resizeTouchMoveHandler) {
      window.removeEventListener('touchmove', this.resizeTouchMoveHandler);
    }
    if (this.resizeTouchEndHandler) {
      window.removeEventListener('touchend', this.resizeTouchEndHandler);
      window.removeEventListener('touchcancel', this.resizeTouchEndHandler);
    }
    
    this.resizeTouchMoveHandler = (ev: TouchEvent) => {
      if (!this.isResizing || ev.touches.length !== 1 || this.isDestroyed) return;
      ev.preventDefault();
      const delta = ev.touches[0].clientY - this.startY;
      const newHeight = Math.max(80, Math.min(500, this.startHeight + delta));
      this.heightChange.emit(newHeight);
    };
    
    this.resizeTouchEndHandler = () => {
      this.isResizing = false;
      if (this.resizeTouchMoveHandler) {
        window.removeEventListener('touchmove', this.resizeTouchMoveHandler);
        this.resizeTouchMoveHandler = null;
      }
      if (this.resizeTouchEndHandler) {
        window.removeEventListener('touchend', this.resizeTouchEndHandler);
        window.removeEventListener('touchcancel', this.resizeTouchEndHandler);
        this.resizeTouchEndHandler = null;
      }
    };
    
    window.addEventListener('touchmove', this.resizeTouchMoveHandler, { passive: false });
    window.addEventListener('touchend', this.resizeTouchEndHandler);
    window.addEventListener('touchcancel', this.resizeTouchEndHandler);
  }
  
  // ========== 调色板区域滑动手势（空白区域切换视图） ==========
  
  private paletteSwipeState = {
    startX: 0,
    startY: 0,
    isSwiping: false
  };
  
  /**
   * 调色板区域触摸开始（用于空白区域滑动）
   */
  onPaletteAreaTouchStart(e: TouchEvent): void {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.paletteSwipeState = {
      startX: touch.clientX,
      startY: touch.clientY,
      isSwiping: false
    };
  }
  
  /**
   * 调色板区域触摸移动
   */
  onPaletteAreaTouchMove(e: TouchEvent): void {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.paletteSwipeState.startX;
    const deltaY = Math.abs(touch.clientY - this.paletteSwipeState.startY);
    const absDeltaX = Math.abs(deltaX);
    
    // 水平滑动距离大于垂直距离的 1.5 倍，认为是切换手势
    if (absDeltaX > 20 && absDeltaX > deltaY * 1.5) {
      this.paletteSwipeState.isSwiping = true;
    }
  }
  
  /**
   * 调色板区域触摸结束
   */
  onPaletteAreaTouchEnd(e: TouchEvent): void {
    if (!this.uiState.isMobile()) return;
    if (!this.paletteSwipeState.isSwiping) return;
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - this.paletteSwipeState.startX;
    const threshold = 50;
    
    if (deltaX > threshold) {
      // 向右滑动 → 切换到文本视图（去左边）
      e.stopPropagation(); // 阻止冒泡到 app.component，避免切换后侧边栏自动打开
      this.swipeToText.emit();
    } else if (deltaX < -threshold) {
      // 向左滑动 → 打开项目栏（从右边滑出）
      e.stopPropagation();
      this.swipeToSidebar.emit();
    }
    
    this.paletteSwipeState.isSwiping = false;
  }
}
