import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, effect, NgZone, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService, Task } from '../services/store.service';

declare var go: any;

@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="flex flex-col h-full bg-[#F9F8F6] relative">
       
       <!-- Top Palette Area (Resizable) -->
       <div class="flex-none flex flex-col overflow-hidden transition-none" [style.height.px]="paletteHeight()">
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
                               <li class="text-xs text-stone-600 flex items-center gap-3 bg-white/80 backdrop-blur-sm border border-stone-100/50 p-2 rounded-lg hover:border-orange-200 cursor-pointer group shadow-sm transition-all" (click)="centerOnNode(item.taskId)">
                                   <span class="w-1 h-1 rounded-full bg-stone-200 group-hover:bg-orange-400 transition-colors ml-1"></span>
                                   <span class="font-bold text-retro-muted text-[9px] tracking-wider">{{item.taskDisplayId}}</span>
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
                       <div class="flex flex-wrap gap-2" id="unassignedPalette">
                           @for (task of store.unassignedTasks(); track task.id) {
                               <div 
                                   draggable="true" 
                                   (dragstart)="onDragStart($event, task)"
                                   class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium hover:border-teal-300 hover:text-teal-700 cursor-grab shadow-sm transition-all active:scale-95 text-stone-500">
                                   {{task.title}}
                               </div>
                           }
                           <button (click)="createUnassigned()" class="px-3 py-1.5 bg-white/50 hover:bg-teal-50 text-stone-400 hover:text-teal-600 rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
                       </div>
                   </div>
               }
           </div>
       </div>

       <!-- Resizer Handle -->
       <div class="h-3 bg-transparent hover:bg-stone-200 cursor-row-resize z-20 flex-shrink-0 relative group transition-all flex items-center justify-center touch-none"
            [class.h-4]="store.isMobile()"
            [class.bg-stone-100]="store.isMobile()"
            (mousedown)="startPaletteResize($event)"
            (touchstart)="startPaletteResizeTouch($event)">
            <div class="w-12 h-1 rounded-full bg-stone-300 group-hover:bg-stone-400 transition-colors"
                 [class.w-16]="store.isMobile()"
                 [class.h-1.5]="store.isMobile()"></div>
       </div>

       <!-- 3. 流程图区域 -->
       <div class="flex-1 relative overflow-hidden bg-[#F9F8F6] mt-0 mx-0 border-t border-stone-200/50">
           <!-- GoJS Diagram Div -->
           <div #diagramDiv class="absolute inset-0 w-full h-full z-0"></div>

           <!-- Zoom Controls -->
           <div class="absolute bottom-4 left-4 z-10 flex gap-2"
                [class.flex-col]="!store.isMobile()"
                [class.flex-row]="store.isMobile()"
                [class.bottom-2]="store.isMobile()"
                [class.left-2]="store.isMobile()">
               <button (click)="zoomIn()" 
                       class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                       [class.p-2]="!store.isMobile()"
                       [class.p-1.5]="store.isMobile()"
                       title="放大">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                   </svg>
               </button>
               <button (click)="zoomOut()" 
                       class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                       [class.p-2]="!store.isMobile()"
                       [class.p-1.5]="store.isMobile()"
                       title="缩小">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
                   </svg>
               </button>
               <!-- 连接模式按钮 -->
               <button 
                 (click)="toggleLinkMode()" 
                 class="backdrop-blur rounded-lg shadow-sm border transition-all"
                 [class.p-2]="!store.isMobile()"
                 [class.p-1.5]="store.isMobile()"
                 [class.bg-indigo-500]="isLinkMode()"
                 [class.text-white]="isLinkMode()"
                 [class.border-indigo-500]="isLinkMode()"
                 [class.bg-white/90]="!isLinkMode()"
                 [class.text-stone-600]="!isLinkMode()"
                 [class.border-stone-200]="!isLinkMode()"
                 [class.hover:bg-stone-50]="!isLinkMode()"
                 title="连接模式：点击两个节点创建跨树连接">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                   </svg>
               </button>
           </div>
           
           <!-- 连接模式提示 - 移动端优化 -->
           @if (isLinkMode()) {
             <div class="absolute z-10 bg-indigo-500 text-white font-medium rounded-lg shadow-lg animate-fade-in flex items-center"
                  [class.top-4]="!store.isMobile()"
                  [class.left-4]="!store.isMobile()"
                  [class.px-3]="!store.isMobile()"
                  [class.py-2]="!store.isMobile()"
                  [class.text-xs]="!store.isMobile()"
                  [class.top-2]="store.isMobile()"
                  [class.left-1/2]="store.isMobile()"
                  [class.-translate-x-1/2]="store.isMobile()"
                  [class.px-2]="store.isMobile()"
                  [class.py-1.5]="store.isMobile()"
                  [class.text-[10px]]="store.isMobile()"
                  [class.max-w-[90vw]]="store.isMobile()">
               @if (linkSourceTask()) {
                 <span class="truncate">已选: <span class="font-bold">{{ linkSourceTask()?.title }}</span></span>
                 <span class="mx-1">→</span>
                 <span>点击目标</span>
               } @else {
                 点击源节点
               }
               <button (click)="cancelLinkMode()" class="ml-2 px-1.5 py-0.5 bg-white/20 rounded hover:bg-white/30 transition-colors">取消</button>
             </div>
           }

           <!-- 4. 详情区域 (Floating Right) - 手机端优化 -->
           <div class="absolute top-6 right-0 bottom-6 z-20 flex pointer-events-none"
                [class.top-2]="store.isMobile()"
                [class.bottom-2]="store.isMobile()"
                [class.left-2]="store.isMobile() && store.isFlowDetailOpen()">
                <!-- Container for positioning -->
                <div class="relative flex h-full pointer-events-auto">
                    <!-- Toggle Button (Triangle) -->
                    <button (click)="store.isFlowDetailOpen.set(!store.isFlowDetailOpen())" 
                            class="absolute left-0 top-8 -translate-x-full bg-white/90 backdrop-blur border border-stone-200 border-r-0 rounded-l-lg p-2 shadow-sm hover:bg-white text-stone-400 hover:text-stone-600 transition-all z-30 flex items-center justify-center w-8 h-10 pl-2"
                            [class.top-2]="store.isMobile()">
                        <span class="text-[10px] transition-transform duration-300" [class.rotate-180]="store.isFlowDetailOpen()">◀</span>
                    </button>

                    <!-- Content Panel - 手机端优化 -->
                    <div class="h-full bg-white/95 backdrop-blur-xl border-l border-stone-200/50 shadow-xl transition-all duration-500 ease-out overflow-hidden flex flex-col"
                         [class.w-0]="!store.isFlowDetailOpen()"
                         [class.w-80]="store.isFlowDetailOpen() && !store.isMobile()"
                         [class.w-64]="store.isFlowDetailOpen() && store.isMobile()"
                         [class.max-w-[70vw]]="store.isMobile()"
                         [class.opacity-0]="!store.isFlowDetailOpen()"
                         [class.opacity-100]="store.isFlowDetailOpen()">
                        
                        <div class="p-4 border-b border-stone-100 flex justify-between items-center bg-transparent"
                             [class.p-3]="store.isMobile()">
                            <h3 class="font-bold text-stone-700 tracking-tight text-sm">任务详情</h3>
                            <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                        </div>
                        
                        <div class="flex-1 overflow-y-auto p-4 space-y-4"
                             [class.p-3]="store.isMobile()">
                            @if (selectedTask(); as task) {
                                <!-- 选中的任务详情 - 可编辑 -->
                                <div class="space-y-3">
                                    <div class="flex items-center gap-2">
                                        <span class="font-bold text-retro-muted text-[9px] tracking-wider bg-stone-100 px-2 py-0.5 rounded">{{task.displayId}}</span>
                                        <span class="text-[10px] text-stone-400">{{task.createdDate | date:'yyyy-MM-dd HH:mm'}}</span>
                                    </div>
                                    
                                    <!-- 标题编辑 -->
                                    <div class="space-y-1">
                                        <label class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide">标题</label>
                                        <input 
                                            type="text"
                                            [ngModel]="task.title"
                                            (ngModelChange)="updateTaskTitle(task.id, $event)"
                                            class="w-full text-sm font-medium text-stone-800 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                            placeholder="任务标题">
                                    </div>
                                    
                                    <!-- 内容编辑 -->
                                    <div class="space-y-1">
                                        <label class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide">内容</label>
                                        <textarea 
                                            [ngModel]="task.content"
                                            (ngModelChange)="updateTaskContent(task.id, $event)"
                                            rows="6"
                                            class="w-full text-xs text-stone-600 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono leading-relaxed"
                                            placeholder="输入 Markdown 内容..."
                                            [class.rows-4]="store.isMobile()"></textarea>
                                    </div>
                                    
                                    <!-- 阶段信息 -->
                                    <div class="flex items-center gap-4 text-xs text-stone-500">
                                        <span>阶段: <strong class="text-stone-700">{{task.stage || '未分配'}}</strong></span>
                                        <span>状态: <strong class="text-stone-700">{{task.status === 'completed' ? '已完成' : '进行中'}}</strong></span>
                                    </div>

                                    <!-- 操作按钮 -->
                                    <div class="flex flex-col gap-2 pt-2 border-t border-stone-100">
                                        <div class="flex gap-2">
                                            <button 
                                                (click)="addChildTask(task)"
                                                class="flex-1 px-3 py-1.5 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-xs font-medium rounded-md transition-all">
                                                添加子任务
                                            </button>
                                            <button 
                                                (click)="toggleTaskStatus(task)"
                                                class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all"
                                                [class.bg-emerald-50]="task.status !== 'completed'"
                                                [class.text-emerald-700]="task.status !== 'completed'"
                                                [class.border-emerald-200]="task.status !== 'completed'"
                                                [class.bg-stone-50]="task.status === 'completed'"
                                                [class.text-stone-600]="task.status === 'completed'"
                                                [class.border-stone-200]="task.status === 'completed'"
                                                [class.border]="true">
                                                {{task.status === 'completed' ? '标记未完成' : '标记完成'}}
                                            </button>
                                        </div>
                                        <button 
                                            (click)="deleteTask(task)"
                                            class="w-full px-3 py-1.5 bg-stone-50 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 hover:border-red-500 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1">
                                            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                            删除任务
                                        </button>
                                    </div>
                                </div>
                            } @else if (store.activeProject(); as proj) {
                                <!-- 项目信息 -->
                                <div class="space-y-2">
                                    <div class="text-[10px] font-bold text-stone-400 uppercase tracking-widest">项目信息</div>
                                    <div class="bg-transparent p-0">
                                        <div class="font-bold text-stone-800 mb-1 text-base">{{proj.name}}</div>
                                        <div class="text-xs text-stone-400 mb-2 font-mono">{{proj.createdDate | date:'yyyy-MM-dd'}}</div>
                                        <div class="text-sm text-stone-600 leading-relaxed font-light">{{proj.description}}</div>
                                    </div>
                                </div>
                            } @else {
                                <!-- 提示信息 -->
                                <div class="p-4 border border-dashed border-stone-200 rounded-lg text-center text-stone-400 text-xs font-light">
                                    双击节点查看详情
                                </div>
                            }
                        </div>
                    </div>
                </div>
           </div>
       </div>
       
       <!-- 删除确认弹窗 -->
       @if (deleteConfirmTask()) {
         <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
              (click)="deleteConfirmTask.set(null)">
           <div class="bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden animate-scale-in mx-4"
                [ngClass]="{'w-80': store.isMobile(), 'w-96': !store.isMobile()}"
                (click)="$event.stopPropagation()">
             <div class="px-5 pt-5 pb-4">
               <div class="flex items-center gap-3 mb-3">
                 <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                   <svg class="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                     <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                   </svg>
                 </div>
                 <div>
                   <h3 class="text-lg font-bold text-stone-800">删除任务</h3>
                   <p class="text-xs text-stone-500">此操作不可撤销</p>
                 </div>
               </div>
               <p class="text-sm text-stone-600 leading-relaxed">
                 确定删除任务 <span class="font-semibold text-stone-800">"{{ deleteConfirmTask()?.title }}"</span> 吗？
               </p>
               <p class="text-xs text-stone-400 mt-1">这将同时删除其所有子任务。</p>
             </div>
             <div class="flex border-t border-stone-100">
               <button 
                 (click)="deleteConfirmTask.set(null)"
                 class="flex-1 px-4 py-3 text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors">
                 取消
               </button>
               <button 
                 (click)="confirmDelete()"
                 class="flex-1 px-4 py-3 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors">
                 删除
               </button>
             </div>
           </div>
         </div>
       }
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  store = inject(StoreService);
    private readonly zone = inject(NgZone);
  
  private diagram: any;
  
  // 选中的任务ID
  selectedTaskId = signal<string | null>(null);
  
  // 删除确认状态
  deleteConfirmTask = signal<Task | null>(null);
  
  // 连接模式状态
  isLinkMode = signal(false);
  linkSourceTask = signal<Task | null>(null);
  
  // 计算属性: 获取选中的任务对象
  selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.store.tasks().find(t => t.id === id) || null;
  });

  // Resizing State
  isResizingPalette = false;
  paletteHeight = signal(200); // Initial height for the top palette area
  private startY = 0;
  private startHeight = 0;

  // 连接模式方法
  toggleLinkMode() {
    this.isLinkMode.update(v => !v);
    this.linkSourceTask.set(null);
  }
  
  cancelLinkMode() {
    this.isLinkMode.set(false);
    this.linkSourceTask.set(null);
  }
  
  // 处理连接模式下的节点点击
  handleLinkModeClick(taskId: string) {
    const task = this.store.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const source = this.linkSourceTask();
    if (!source) {
      // 选择源节点
      this.linkSourceTask.set(task);
    } else if (source.id !== taskId) {
      // 选择目标节点，创建连接
      this.store.addCrossTreeConnection(source.id, taskId);
      this.linkSourceTask.set(null);
      this.isLinkMode.set(false);
      // 刷新图表以显示新连接
      setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
  }

  constructor() {
      effect(() => {
          const tasks = this.store.tasks();
          if (this.diagram) {
              this.updateDiagram(tasks);
          }
      });
  }

  public refreshLayout() {
      if (this.diagram) {
          this.diagram.requestUpdate();
      }
  }

  zoomIn() {
      if (this.diagram) {
          this.diagram.commandHandler.increaseZoom();
      }
  }

  zoomOut() {
      if (this.diagram) {
          this.diagram.commandHandler.decreaseZoom();
      }
  }

  // 更新任务标题
  updateTaskTitle(taskId: string, title: string) {
      this.store.updateTaskTitle(taskId, title);
  }

  // 更新任务内容
  updateTaskContent(taskId: string, content: string) {
      this.store.updateTaskContent(taskId, content);
  }

  // 添加子任务
  addChildTask(task: Task) {
      const nextStage = (task.stage || 0) + 1;
      this.store.addTask("新子任务", "详情...", nextStage, task.id, false);
  }

  // 切换任务状态
  toggleTaskStatus(task: Task) {
      const newStatus = task.status === 'completed' ? 'active' : 'completed';
      this.store.updateTaskStatus(task.id, newStatus);
  }

  // 删除任务
  deleteTask(task: Task) {
      this.deleteConfirmTask.set(task);
  }

  confirmDelete() {
      const task = this.deleteConfirmTask();
      if (task) {
          this.selectedTaskId.set(null);
          this.store.deleteTask(task.id);
          this.deleteConfirmTask.set(null);
      }
  }

  startPaletteResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingPalette = true;
      this.startY = e.clientY;
      this.startHeight = this.paletteHeight();
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      
      const onMove = (ev: MouseEvent) => {
          if (!this.isResizingPalette) return;
          const delta = ev.clientY - this.startY;
          const newHeight = Math.max(100, Math.min(600, this.startHeight + delta));
          this.paletteHeight.set(newHeight);
      };
      
      const onUp = () => {
          this.isResizingPalette = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  }

  startPaletteResizeTouch(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      this.isResizingPalette = true;
      this.startY = e.touches[0].clientY;
      this.startHeight = this.paletteHeight();
      
      const onMove = (ev: TouchEvent) => {
          if (!this.isResizingPalette || ev.touches.length !== 1) return;
          ev.preventDefault();
          const delta = ev.touches[0].clientY - this.startY;
          const newHeight = Math.max(80, Math.min(500, this.startHeight + delta));
          this.paletteHeight.set(newHeight);
      };
      
      const onEnd = () => {
          this.isResizingPalette = false;
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          window.removeEventListener('touchcancel', onEnd);
      };
      
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
  }

  ngAfterViewInit() {
      this.initDiagram();
  }

  initDiagram() {
      if (typeof go === 'undefined') {
          console.warn('GoJS not loaded');
          return;
      }
      const $ = go.GraphObject.make;

      this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          "undoManager.isEnabled": true,
          "animationManager.isEnabled": true,
          "allowDrop": true, // accept drops from HTML
          layout: $(go.LayeredDigraphLayout, { 
              direction: 0, 
              layerSpacing: 100, 
              columnSpacing: 40,
              setsPortSpots: false 
          })
      });

      // Helper to create ports
      function makePort(name: string, spot: any, output: boolean, input: boolean) {
        return $(go.Shape, "Circle",
          {
            fill: "transparent",
            stroke: null,
            desiredSize: new go.Size(10, 10),
            alignment: spot,
            alignmentFocus: spot,
            portId: name,
            fromLinkable: output,
            toLinkable: input,
            cursor: "pointer",
            fromSpot: spot,
            toSpot: spot,
            mouseEnter: (e: any, port: any) => { if (!e.diagram.isReadOnly) port.fill = "#a8a29e"; },
            mouseLeave: (e: any, port: any) => port.fill = "transparent"
          });
      }

      // Node Template
      this.diagram.nodeTemplate =
          $(go.Node, "Spot",
            { 
                locationSpot: go.Spot.Center,
                selectionAdorned: true,
                click: (e: any, node: any) => {
                    if (e.diagram.lastInput.dragging) return;
                    this.zone.run(() => {
                        // 检查是否在连接模式
                        if (this.isLinkMode()) {
                            this.handleLinkModeClick(node.data.key);
                        } else {
                            // 单击选中节点
                            this.selectedTaskId.set(node.data.key);
                        }
                    });
                },
                doubleClick: (e: any, node: any) => {
                    // 双击打开详情面板并选中节点
                    this.zone.run(() => {
                        this.selectedTaskId.set(node.data.key);
                        this.store.isFlowDetailOpen.set(true);
                    });
                }
            },
            new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
            
            // Main Content
            $(go.Panel, "Auto",
                { width: 200 }, // Fixed width
                $(go.Shape, "RoundedRectangle", 
                  { 
                      fill: "white", 
                      stroke: "#e7e5e4", 
                      strokeWidth: 1, 
                      parameter1: 10,
                      // Make the body NOT linkable, so it's draggable
                      portId: "", 
                      fromLinkable: false, 
                      toLinkable: false, 
                      cursor: "move" 
                  },
                  new go.Binding("fill", "color"),
                  new go.Binding("stroke", "isSelected", (s: boolean) => s ? "#a8a29e" : "#e7e5e4").ofObject()
                ),
                $(go.Panel, "Vertical", { margin: 16 },
                    $(go.TextBlock, { font: "bold 9px sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
                        new go.Binding("text", "displayId")),
                    $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px sans-serif", stroke: "#57534e", maxSize: new go.Size(160, NaN) },
                        new go.Binding("text", "title"))
                )
            ),

            // Ports
            makePort("T", go.Spot.Top, true, true),
            makePort("L", go.Spot.Left, true, true),
            makePort("R", go.Spot.Right, true, true),
            makePort("B", go.Spot.Bottom, true, true)
          );

      // Link Template - 支持父子连接和跨树连接的不同样式
      this.diagram.linkTemplate =
          $(go.Link, 
            { 
                routing: go.Link.AvoidsNodes, 
                curve: go.Link.JumpOver, 
                corner: 12,
                toShortLength: 4,
                relinkableFrom: true,
                relinkableTo: true,
                reshapable: true,
                resegmentable: true,
                // 右键菜单删除连接
                contextMenu: $(go.Adornment, "Vertical",
                  $("ContextMenuButton",
                    $(go.TextBlock, "删除连接", { margin: 5 }),
                    { click: (e: any, obj: any) => this.deleteLinkFromContext(obj.part) }
                  )
                )
            },
            // Transparent fat line for easier selection
            $(go.Shape, { isPanelMain: true, strokeWidth: 8, stroke: "transparent" }),
            // Visible line - 根据连接类型显示不同样式
            $(go.Shape, { isPanelMain: true, strokeWidth: 2 },
              new go.Binding("stroke", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8"),
              new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 3] : null)
            ),
            // Arrowhead
            $(go.Shape, { toArrow: "Standard", stroke: null, scale: 1.2 },
              new go.Binding("fill", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8")
            )
          );

      // Initialize model with linkKeyProperty for proper merging
      this.diagram.model = new go.GraphLinksModel([], [], { 
          linkKeyProperty: 'key',
          nodeKeyProperty: 'key'
      });

      // Handle External Drops
      this.diagram.div.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          // Highlight logic could go here
      });

      this.diagram.div.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          const data = e.dataTransfer?.getData("text");
          if (data) {
             const task = JSON.parse(data);
             // Logic to add task to stage?
             // Prompt says: "Dragging to a node (stage) renders them in flow".
             // Here we drop onto canvas.
             // Let's assign it a stage based on drop, or just make it active (Stage 1 default if dropped on blank?)
             // We'll verify if dropped on existing node?
             
             const pt = this.diagram.lastInput.viewPoint;
             const loc = this.diagram.transformViewToDoc(pt);
             
             // Update task in store
             // We assume dropping on canvas assigns it to stage 1 for now to show it.
             this.store.moveTaskToStage(task.id, 1);
          }
      });

      this.diagram.addDiagramListener('LinkDrawn', (e: any) => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', (e: any) => this.handleLinkGesture(e));
  }

  updateDiagram(tasks: Task[]) {
      if (!this.diagram) return;
      
      const model = this.diagram.model;
      if (!model) return;
      
      const project = this.store.activeProject();
      if (!project) return;
      
      // Build a map of existing node locations to preserve user's manual positioning
      const existingLocations = new Map<string, string>();
      (model as any).nodeDataArray.forEach((n: any) => {
          if (n.key && n.loc) {
              existingLocations.set(n.key, n.loc);
          }
      });
      
      const nodeDataArray: any[] = [];
      const linkDataArray: any[] = [];
      
      // 构建父子关系集合
      const parentChildPairs = new Set<string>();
      tasks.filter(t => t.stage !== null && t.parentId).forEach(t => {
          parentChildPairs.add(`${t.parentId}->${t.id}`);
      });

      tasks.filter(t => t.stage !== null).forEach(t => {
          // Preserve existing location if node was already rendered, otherwise use store coordinates
          const existingLoc = existingLocations.get(t.id);
          nodeDataArray.push({
              key: t.id,
              title: t.title || '未命名任务',
              displayId: t.displayId,
              stage: t.stage, // Add stage info for drag computation
              loc: existingLoc || `${t.x} ${t.y}`,
              color: t.status === 'completed' ? '#f0fdf4' : 'white',
              isSelected: false // handled by diagram selection
          });
          
          // 添加父子连接（实线）
          if (t.parentId) {
              linkDataArray.push({ 
                  key: `${t.parentId}-${t.id}`,
                  from: t.parentId, 
                  to: t.id,
                  isCrossTree: false
              });
          }
      });
      
      // 添加跨树连接（虚线）- 从 project.connections 中获取非父子关系的连接
      project.connections.forEach(conn => {
          const pairKey = `${conn.source}->${conn.target}`;
          // 如果不是父子关系，则是跨树连接
          if (!parentChildPairs.has(pairKey)) {
              // 确保两个节点都在当前显示的任务中
              const sourceExists = tasks.some(t => t.id === conn.source && t.stage !== null);
              const targetExists = tasks.some(t => t.id === conn.target && t.stage !== null);
              if (sourceExists && targetExists) {
                  linkDataArray.push({
                      key: `cross-${conn.source}-${conn.target}`,
                      from: conn.source,
                      to: conn.target,
                      isCrossTree: true
                  });
              }
          }
      });

      this.diagram.startTransaction('update');
      
      // Skip layout temporarily to prevent view reset
      this.diagram.skipsUndoManager = true;
      
      // Use merge methods to preserve diagram state (zoom, pan, etc.)
      (model as any).mergeNodeDataArray(nodeDataArray);
      (model as any).mergeLinkDataArray(linkDataArray);
      
      // Remove stale nodes/links not present anymore
      const nodeKeys = new Set(nodeDataArray.map(n => n.key));
      const linkKeys = new Set(linkDataArray.map(l => l.key));
      
      (model as any).nodeDataArray
        .filter((n: any) => !nodeKeys.has(n.key))
        .forEach((n: any) => (model as any).removeNodeData(n));
      
      (model as any).linkDataArray
        .filter((l: any) => !linkKeys.has(l.key))
        .forEach((l: any) => (model as any).removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
  }

  createUnassigned() {
      this.store.addTask('新任务', '', null, null, false);
  }

  onDragStart(event: DragEvent, task: Task) {
      if (event.dataTransfer) {
          event.dataTransfer.setData("text", JSON.stringify(task));
          event.dataTransfer.effectAllowed = "move";
      }
  }

  centerOnNode(taskId: string) {
      if (!this.diagram) return;
      const node = this.diagram.findNodeForKey(taskId);
      if (node) {
          this.diagram.centerRect(node.actualBounds);
          this.diagram.select(node);
          // 选中任务并打开详情面板
          this.selectedTaskId.set(taskId);
          this.store.isFlowDetailOpen.set(true);
      } else {
          // 任务可能未分配阶段，仍然选中并打开详情
          this.selectedTaskId.set(taskId);
          this.store.isFlowDetailOpen.set(true);
      }
  }

  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent) {
      if (!this.diagram) return;
      if (!event.altKey || event.key.toLowerCase() !== 'z') return;

      const targets: string[] = [];
      const it = this.diagram.selection?.iterator;
      if (it) {
          while (it.next()) {
              const part = it.value;
              const key = part?.data?.key;
              const isNode = typeof go !== 'undefined' ? part instanceof go.Node : !part?.category;
              if (isNode && key) {
                  targets.push(key);
              }
          }
      }

      if (!targets.length) return;
      event.preventDefault();
      event.stopPropagation();

      this.zone.run(() => {
          targets.forEach(id => this.store.detachTask(id));
      });
  }

    private handleLinkGesture(e: any) {
            if (!this.diagram) return;
            const link = e.subject;
            const fromNode = link?.fromNode;
            const toNode = link?.toNode;
            const parentId = fromNode?.data?.key;
            const childId = toNode?.data?.key;
            if (!parentId || !childId || parentId === childId) return;

            const parentStage = typeof fromNode.data?.stage === 'number' ? fromNode.data.stage : null;
            const childStage = typeof toNode.data?.stage === 'number' ? toNode.data.stage : null;
            const nextStage = parentStage !== null ? parentStage + 1 : (childStage ?? 1);

            this.diagram.remove(link);
            this.zone.run(() => {
                    this.store.moveTaskToStage(childId, nextStage, undefined, parentId);
            });
    }
    
    // 从右键菜单删除连接
    private deleteLinkFromContext(link: any) {
        if (!link) return;
        const fromKey = link.data?.from;
        const toKey = link.data?.to;
        const isCrossTree = link.data?.isCrossTree;
        
        if (fromKey && toKey) {
            this.zone.run(() => {
                if (isCrossTree) {
                    // 删除跨树连接
                    this.store.removeConnection(fromKey, toKey);
                } else {
                    // 删除父子连接 - 将子任务解除父子关系
                    this.store.detachTask(toKey);
                }
                // 刷新图表
                setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
            });
        }
    }
}
