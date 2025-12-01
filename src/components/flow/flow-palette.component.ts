import { Component, input, output, signal, inject, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';

/**
 * 流程图顶部调色板组件
 * 包含待办事项和待分配任务区域
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- Top Palette Area (Resizable) -->
    <div class="flex-none flex flex-col overflow-hidden transition-none" [style.height.px]="height()">
        <!-- 1. 待完成区域 (To-Do) -->
        <div class="flex-none mx-4 mt-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-orange-50/60 border border-orange-100/50 backdrop-blur-sm z-10 relative">
            <div (click)="store.isFlowUnfinishedOpen.set(!store.isFlowUnfinishedOpen())" 
                 class="py-3 cursor-pointer flex justify-between items-center group select-none">
                <span class="font-bold text-stone-700 text-sm flex items-center gap-2 tracking-tight">
                    <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
                    待办事项
                </span>
                <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnfinishedOpen()">▼</span>
            </div>
            
            @if (store.isFlowUnfinishedOpen()) {
                <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                    <ul class="space-y-2">
                        @for (item of store.unfinishedItems(); track item.taskId + item.text) {
                            <li class="text-xs text-stone-600 flex items-center gap-3 bg-white/80 backdrop-blur-sm border border-stone-100/50 p-2 rounded-lg hover:border-orange-200 cursor-pointer group shadow-sm transition-all" (click)="centerOnNode.emit(item.taskId)">
                                <span class="w-1 h-1 rounded-full bg-stone-200 group-hover:bg-orange-400 transition-colors ml-1"></span>
                                <span class="font-bold text-retro-muted text-[9px] tracking-wider">{{store.compressDisplayId(item.taskDisplayId)}}</span>
                                <span class="truncate flex-1 group-hover:text-stone-900 transition-colors">{{item.text}}</span>
                            </li>
                        }
                        @if (store.unfinishedItems().length === 0) {
                            <li class="text-xs text-stone-400 italic px-2 font-light">暂无待办</li>
                        }
                    </ul>
                </div>
            }
        </div>

        <!-- 2. 待分配区域 (To-Assign) - 可拖动到流程图 -->
        <div class="flex-none mx-4 mt-2 mb-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-teal-50/60 border border-teal-100/50 backdrop-blur-sm z-10 relative">
            <div (click)="store.isFlowUnassignedOpen.set(!store.isFlowUnassignedOpen())" 
                 class="py-3 cursor-pointer flex justify-between items-center group select-none">
                <span class="font-bold text-stone-700 text-sm flex items-center gap-2 tracking-tight">
                    <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
                    待分配
                </span>
                <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnassignedOpen()">▼</span>
            </div>

            @if (store.isFlowUnassignedOpen()) {
                <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                    <div class="flex flex-wrap gap-2 unassigned-drag-area" 
                         id="unassignedPalette"
                         (dragover)="onDragOver($event)"
                         (drop)="onDrop($event)">
                        @for (task of store.unassignedTasks(); track task.id) {
                            <div 
                                draggable="true" 
                                (dragstart)="onDragStart($event, task)"
                                (touchstart)="onTouchStart($event, task)"
                                (touchmove)="onTouchMove($event)"
                                (touchend)="onTouchEnd($event)"
                                (click)="taskClick.emit(task)"
                                class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium hover:border-teal-300 hover:text-teal-700 cursor-pointer shadow-sm transition-all active:scale-95 text-stone-500"
                                [class.bg-teal-100]="draggingId() === task.id"
                                [class.border-teal-400]="draggingId() === task.id">
                                {{task.title}}
                            </div>
                        }
                        <button data-testid="create-unassigned-btn" (click)="createUnassigned.emit()" class="px-3 py-1.5 bg-white/50 hover:bg-teal-50 text-stone-400 hover:text-teal-600 rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
                    </div>
                    <!-- 拖回待分配区域的提示 -->
                    @if (isDropTargetActive()) {
                      <div class="mt-2 p-2 border-2 border-dashed border-teal-300 rounded-lg bg-teal-50/50 text-center text-xs text-teal-600 animate-pulse">
                        拖放到此处解除分配
                      </div>
                    }
                </div>
            }
        </div>
    </div>

    <!-- Resizer Handle -->
    <div class="h-3 bg-transparent hover:bg-stone-200 cursor-row-resize z-20 flex-shrink-0 relative group transition-all flex items-center justify-center touch-none"
         [class.h-4]="store.isMobile()"
         [class.bg-stone-100]="store.isMobile()"
         (mousedown)="startResize($event)"
         (touchstart)="startResizeTouch($event)">
         <div class="w-12 h-1 rounded-full bg-stone-300 group-hover:bg-stone-400 transition-colors"
              [class.w-16]="store.isMobile()"
              [class.h-1.5]="store.isMobile()"></div>
    </div>
  `
})
export class FlowPaletteComponent {
  readonly store = inject(StoreService);
  
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
  
  // 内部状态
  readonly draggingId = signal<string | null>(null);
  
  // 拖动状态
  private isResizing = false;
  private startY = 0;
  private startHeight = 0;
  
  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as any,
    ghost: null as HTMLElement | null
  };
  
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
    
    const onMove = (ev: MouseEvent) => {
      if (!this.isResizing) return;
      const delta = ev.clientY - this.startY;
      const newHeight = Math.max(100, Math.min(600, this.startHeight + delta));
      this.heightChange.emit(newHeight);
    };
    
    const onUp = () => {
      this.isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  
  startResizeTouch(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    this.isResizing = true;
    this.startY = e.touches[0].clientY;
    this.startHeight = this.height();
    
    const onMove = (ev: TouchEvent) => {
      if (!this.isResizing || ev.touches.length !== 1) return;
      ev.preventDefault();
      const delta = ev.touches[0].clientY - this.startY;
      const newHeight = Math.max(80, Math.min(500, this.startHeight + delta));
      this.heightChange.emit(newHeight);
    };
    
    const onEnd = () => {
      this.isResizing = false;
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
    
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }
}
