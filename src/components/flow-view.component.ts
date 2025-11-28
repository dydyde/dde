import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter } from '@angular/core';
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
                                   (touchstart)="onUnassignedTouchStart($event, task)"
                                   (touchmove)="onUnassignedTouchMove($event)"
                                   (touchend)="onUnassignedTouchEnd($event)"
                                   (click)="onUnassignedTaskClick(task)"
                                   class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium hover:border-teal-300 hover:text-teal-700 cursor-pointer shadow-sm transition-all active:scale-95 text-stone-500"
                                   [class.bg-teal-100]="unassignedDraggingId() === task.id"
                                   [class.border-teal-400]="unassignedDraggingId() === task.id">
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

           <!-- 手机端返回文本视图按钮 -->
           @if (store.isMobile()) {
             <button 
               (click)="goBackToText.emit()"
               class="absolute top-2 left-2 z-10 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center gap-1">
               <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
               </svg>
               <span class="text-[10px] font-medium">文本</span>
             </button>
           }

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
               <!-- 自动布局按钮 -->
               <button 
                 (click)="applyAutoLayout()" 
                 class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                 [class.p-2]="!store.isMobile()"
                 [class.p-1.5]="store.isMobile()"
                 title="自动整理布局">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
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

           <!-- 4. 详情区域 - 桌面端右侧面板 -->
           @if (!store.isMobile()) {
             <div class="absolute top-6 right-0 bottom-6 z-20 flex pointer-events-none">
                <div class="relative flex h-full pointer-events-auto">
                    <!-- Toggle Button -->
                    <button (click)="store.isFlowDetailOpen.set(!store.isFlowDetailOpen())" 
                            class="absolute left-0 top-8 -translate-x-full bg-white/90 backdrop-blur border border-stone-200 border-r-0 rounded-l-lg p-2 shadow-sm hover:bg-white text-stone-400 hover:text-stone-600 transition-all z-30 flex items-center justify-center w-8 h-10 pl-2">
                        <span class="text-[10px] transition-transform duration-300" [class.rotate-180]="store.isFlowDetailOpen()">◀</span>
                    </button>

                    <!-- Content Panel - 桌面端 -->
                    <div class="h-full bg-white/95 backdrop-blur-xl border-l border-stone-200/50 shadow-xl transition-all duration-500 ease-out overflow-hidden flex flex-col"
                         [class.w-0]="!store.isFlowDetailOpen()"
                         [class.w-80]="store.isFlowDetailOpen()"
                         [class.opacity-0]="!store.isFlowDetailOpen()"
                         [class.opacity-100]="store.isFlowDetailOpen()">
                        
                        <div class="p-4 border-b border-stone-100 flex justify-between items-center bg-transparent">
                            <h3 class="font-bold text-stone-700 tracking-tight text-sm">任务详情</h3>
                            <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                        </div>
                        
                        <div class="flex-1 overflow-y-auto p-4 space-y-4">
                            @if (selectedTask(); as task) {
                                <div class="space-y-3">
                                    <div class="flex items-center gap-2">
                                        <span class="font-bold text-retro-muted text-[9px] tracking-wider bg-stone-100 px-2 py-0.5 rounded">{{task.displayId}}</span>
                                        <span class="text-[10px] text-stone-400">{{task.createdDate | date:'MM-dd HH:mm'}}</span>
                                    </div>
                                    
                                    <div class="space-y-1">
                                        <label class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide">标题</label>
                                        <input type="text" [ngModel]="task.title" (ngModelChange)="updateTaskTitle(task.id, $event)"
                                            class="w-full text-sm font-medium text-stone-800 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                            placeholder="任务标题">
                                    </div>
                                    
                                    <div class="space-y-1">
                                        <label class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide">内容</label>
                                        <textarea [ngModel]="task.content" (ngModelChange)="updateTaskContent(task.id, $event)" rows="6"
                                            class="w-full text-xs text-stone-600 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono leading-relaxed"
                                            placeholder="输入 Markdown 内容..."></textarea>
                                    </div>
                                    
                                    <div class="flex items-center gap-4 text-xs text-stone-500">
                                        <span>阶段: <strong class="text-stone-700">{{task.stage || '未分配'}}</strong></span>
                                        <span>状态: <strong class="text-stone-700">{{task.status === 'completed' ? '已完成' : '进行中'}}</strong></span>
                                    </div>

                                    <div class="flex flex-col gap-2 pt-2 border-t border-stone-100">
                                        <div class="flex gap-2">
                                            <button (click)="addChildTask(task)"
                                                class="flex-1 px-3 py-1.5 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-xs font-medium rounded-md transition-all">
                                                添加子任务
                                            </button>
                                            <button (click)="toggleTaskStatus(task)"
                                                class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all border"
                                                [class.bg-emerald-50]="task.status !== 'completed'"
                                                [class.text-emerald-700]="task.status !== 'completed'"
                                                [class.border-emerald-200]="task.status !== 'completed'"
                                                [class.bg-stone-50]="task.status === 'completed'"
                                                [class.text-stone-600]="task.status === 'completed'"
                                                [class.border-stone-200]="task.status === 'completed'">
                                                {{task.status === 'completed' ? '标记未完成' : '标记完成'}}
                                            </button>
                                        </div>
                                        <button (click)="deleteTask(task)"
                                            class="w-full px-3 py-1.5 bg-stone-50 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 hover:border-red-500 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1">
                                            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                            删除任务
                                        </button>
                                    </div>
                                </div>
                            } @else if (store.activeProject(); as proj) {
                                <div class="space-y-2">
                                    <div class="text-[10px] font-bold text-stone-400 uppercase tracking-widest">项目信息</div>
                                    <div class="font-bold text-stone-800 mb-1 text-base">{{proj.name}}</div>
                                    <div class="text-xs text-stone-400 mb-2 font-mono">{{proj.createdDate | date:'yyyy-MM-dd'}}</div>
                                    <div class="text-sm text-stone-600 leading-relaxed font-light">{{proj.description}}</div>
                                </div>
                            } @else {
                                <div class="p-4 border border-dashed border-stone-200 rounded-lg text-center text-stone-400 text-xs font-light">
                                    双击节点查看详情
                                </div>
                            }
                        </div>
                    </div>
                </div>
             </div>
           }

           <!-- 4. 详情区域 - 手机端底部抽屉 -->
           @if (store.isMobile()) {
             <!-- 底部小型标签触发器 -->
             @if (!store.isFlowDetailOpen()) {
               <button 
                 (click)="store.isFlowDetailOpen.set(true)"
                 class="absolute bottom-2 right-2 z-20 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 px-2 py-1 flex items-center gap-1 text-stone-500 hover:text-stone-700">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                 </svg>
                 <span class="text-[10px] font-medium">详情</span>
               </button>
             }
             
             <!-- 底部抽屉面板 -->
             @if (store.isFlowDetailOpen()) {
               <div class="absolute bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur-xl border-t border-stone-200 shadow-[0_-4px_20px_rgba(0,0,0,0.1)] rounded-t-2xl transition-all duration-150 flex flex-col"
                    [style.max-height.vh]="drawerHeight()">
                 <!-- 拖动条 - 可拖动调整高度 -->
                 <div class="flex justify-center py-2 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
                      (touchstart)="startDrawerResize($event)">
                   <div class="w-12 h-1.5 bg-stone-300 rounded-full"></div>
                 </div>
                 
                 <!-- 标题栏 -->
                 <div class="px-3 pb-2 flex justify-between items-center flex-shrink-0">
                   <h3 class="font-bold text-stone-700 text-xs">任务详情</h3>
                   <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                     </svg>
                   </button>
                 </div>
                 
                 <!-- 内容区域 - 简化触摸处理，让系统自然滚动 -->
                 <div class="flex-1 overflow-y-auto px-3 pb-3 overscroll-contain touch-pan-y" 
                      style="-webkit-overflow-scrolling: touch; will-change: scroll-position;">
                   @if (selectedTask(); as task) {
                     <!-- 紧凑的任务信息 -->
                     <div class="flex items-center gap-2 mb-2">
                       <span class="font-bold text-retro-muted text-[8px] tracking-wider bg-stone-100 px-1.5 rounded">{{task.displayId}}</span>
                       <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd HH:mm'}}</span>
                       <span class="text-[9px] px-1.5 py-0.5 rounded"
                             [class.bg-emerald-100]="task.status === 'completed'"
                             [class.text-emerald-700]="task.status === 'completed'"
                             [class.bg-amber-100]="task.status !== 'completed'"
                             [class.text-amber-700]="task.status !== 'completed'">
                         {{task.status === 'completed' ? '已完成' : '进行中'}}
                       </span>
                     </div>
                     
                     <!-- 标题输入 -->
                     <input type="text" [ngModel]="task.title" (ngModelChange)="updateTaskTitle(task.id, $event)"
                       class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                       placeholder="任务标题">
                     
                     <!-- 内容输入 -->
                     <textarea [ngModel]="task.content" (ngModelChange)="updateTaskContent(task.id, $event)" rows="2"
                       class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono"
                       placeholder="任务内容..."></textarea>
                     
                     <!-- 快速待办输入 -->
                     <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5 mb-2">
                       <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1.5">☐</span>
                       <input
                         #flowQuickTodoInput
                         type="text"
                         (keydown.enter)="addQuickTodo(task.id, flowQuickTodoInput)"
                         class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[11px] py-1 px-1"
                         placeholder="输入待办，回车添加...">
                       <button
                         (click)="addQuickTodo(task.id, flowQuickTodoInput)"
                         class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-1 mr-0.5 transition-all"
                         title="添加待办">
                         <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                       </button>
                     </div>
                     
                     <!-- 操作按钮 - 横向紧凑排列 -->
                     <div class="flex gap-1.5">
                       <button (click)="addChildTask(task)"
                         class="flex-1 px-2 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                         +子任务
                       </button>
                       <button (click)="toggleTaskStatus(task)"
                         class="flex-1 px-2 py-1 text-[10px] font-medium rounded border transition-all"
                         [class.bg-emerald-50]="task.status !== 'completed'"
                         [class.text-emerald-700]="task.status !== 'completed'"
                         [class.border-emerald-200]="task.status !== 'completed'"
                         [class.bg-stone-50]="task.status === 'completed'"
                         [class.text-stone-600]="task.status === 'completed'"
                         [class.border-stone-200]="task.status === 'completed'">
                         {{task.status === 'completed' ? '未完成' : '完成'}}
                       </button>
                       <button (click)="deleteTask(task)"
                         class="px-2 py-1 bg-stone-50 text-stone-400 border border-stone-200 text-[10px] font-medium rounded transition-all">
                         删除
                       </button>
                     </div>
                   } @else {
                     <div class="text-center text-stone-400 text-xs py-4">双击节点查看详情</div>
                   }
                 </div>
               </div>
             }
           }
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
       
       <!-- 移动端连接线删除提示 -->
       @if (store.isMobile() && linkDeleteHint(); as hint) {
         <div class="fixed z-50 animate-scale-in"
              [style.left.px]="hint.x - 60"
              [style.top.px]="hint.y - 50">
           <div class="bg-white rounded-lg shadow-xl border border-stone-200 p-2 flex gap-2">
             <button 
               (click)="confirmLinkDelete()"
               class="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-all">
               删除连接
             </button>
             <button 
               (click)="cancelLinkDelete()"
               class="px-3 py-1.5 bg-stone-100 text-stone-600 text-xs font-medium rounded hover:bg-stone-200 transition-all">
               取消
             </button>
           </div>
         </div>
       }
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @Output() goBackToText = new EventEmitter<void>();
  
  store = inject(StoreService);
    private readonly zone = inject(NgZone);
  
  private diagram: any;
  private resizeObserver: ResizeObserver | null = null;
  
  // 选中的任务ID
  selectedTaskId = signal<string | null>(null);
  
  // 删除确认状态
  deleteConfirmTask = signal<Task | null>(null);
  
  // 连接模式状态
  isLinkMode = signal(false);
  linkSourceTask = signal<Task | null>(null);
  
  // 移动端连接线删除提示
  linkDeleteHint = signal<{ link: any; x: number; y: number } | null>(null);
  
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
  
  // 底部抽屉拖动状态
  drawerHeight = signal(35); // 以 vh 为单位的高度
  private isResizingDrawer = false;
  
  // 抽屉内容滚动状态 - 用于区分滚动和拖动
  private isDrawerScrolling = false;
  private drawerScrollStartY = 0;
  
  // 移动端待分配块拖动状态
  unassignedDraggingId = signal<string | null>(null);
  private unassignedTouchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as any,
    ghost: null as HTMLElement | null
  };
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  
  // 性能优化：位置保存防抖定时器
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

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
  
  // 应用自动布局（一次性整理）
  applyAutoLayout() {
      if (!this.diagram) return;
      
      const $ = go.GraphObject.make;
      // 临时应用有序布局
      this.diagram.startTransaction('auto-layout');
      this.diagram.layout = $(go.LayeredDigraphLayout, {
          direction: 0,
          layerSpacing: 100,
          columnSpacing: 40,
          setsPortSpots: false
      });
      this.diagram.layoutDiagram(true);
      
      // 布局完成后保存所有位置并恢复为无操作布局
      setTimeout(() => {
          this.saveAllNodePositions();
          this.diagram.layout = $(go.Layout); // 恢复无操作布局
          this.diagram.commitTransaction('auto-layout');
      }, 50);
  }
  
  // 保存所有节点位置到 store
  saveAllNodePositions() {
      if (!this.diagram) return;
      
      this.diagram.nodes.each((node: any) => {
          const loc = node.location;
          if (node.data && node.data.key && loc.isReal()) {
              this.store.updateTaskPosition(node.data.key, loc.x, loc.y);
          }
      });
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

  // 快速添加待办
  addQuickTodo(taskId: string, inputElement: HTMLInputElement) {
      const text = inputElement.value.trim();
      if (!text) return;
      
      this.store.addTodoItem(taskId, text);
      inputElement.value = '';
      inputElement.focus();
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

  // 底部抽屉拖动开始
  startDrawerResize(event: TouchEvent) {
      if (event.touches.length !== 1) return;
      event.preventDefault();
      this.isResizingDrawer = true;
      this.drawerStartY = event.touches[0].clientY;
      this.drawerStartHeight = this.drawerHeight();
      
      const onMove = (ev: TouchEvent) => {
          if (!this.isResizingDrawer || ev.touches.length !== 1) return;
          ev.preventDefault();
          // 向上拖动增加高度，向下拖动减少高度
          const deltaY = this.drawerStartY - ev.touches[0].clientY;
          const deltaVh = (deltaY / window.innerHeight) * 100;
          const newHeight = Math.max(15, Math.min(70, this.drawerStartHeight + deltaVh));
          this.drawerHeight.set(newHeight);
      };
      
      const onEnd = () => {
          this.isResizingDrawer = false;
          // 如果高度太小，关闭抽屉
          if (this.drawerHeight() < 20) {
              this.store.isFlowDetailOpen.set(false);
              this.drawerHeight.set(35); // 重置高度
          }
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          window.removeEventListener('touchcancel', onEnd);
      };
      
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
  }

  // 抽屉内容区域触摸事件 - 允许内容滚动
  onDrawerTouchStart(e: TouchEvent) {
    // 如果是在拖动条上开始的触摸，不处理
    if ((e.target as HTMLElement).closest('.touch-none')) return;
    this.drawerScrollStartY = e.touches[0].clientY;
    this.isDrawerScrolling = false;
  }
  
  onDrawerTouchMove(e: TouchEvent) {
    // 如果正在调整高度，不处理
    if (this.isResizingDrawer) return;
    
    const deltaY = e.touches[0].clientY - this.drawerScrollStartY;
    // 检查内容区域是否可以滚动
    const contentEl = (e.currentTarget as HTMLElement).querySelector('.overflow-y-auto');
    if (contentEl) {
      const canScrollUp = contentEl.scrollTop > 0;
      const canScrollDown = contentEl.scrollTop < contentEl.scrollHeight - contentEl.clientHeight;
      
      // 如果内容可以滚动，让它正常滚动
      if ((deltaY > 0 && canScrollUp) || (deltaY < 0 && canScrollDown)) {
        this.isDrawerScrolling = true;
        return; // 允许默认滚动行为
      }
    }
  }
  
  onDrawerTouchEnd(e: TouchEvent) {
    this.isDrawerScrolling = false;
  }

  // 移动端待分配块触摸拖动
  onUnassignedTouchStart(e: TouchEvent, task: Task) {
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.unassignedTouchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
    
    // 长按 200ms 后开始拖拽
    this.unassignedTouchState.longPressTimer = setTimeout(() => {
      this.unassignedTouchState.isDragging = true;
      this.unassignedDraggingId.set(task.id);
      this.createUnassignedGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 200);
  }
  
  onUnassignedTouchMove(e: TouchEvent) {
    if (!this.unassignedTouchState.task || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - this.unassignedTouchState.startX);
    const deltaY = Math.abs(touch.clientY - this.unassignedTouchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.unassignedTouchState.isDragging && (deltaX > 10 || deltaY > 10)) {
      if (this.unassignedTouchState.longPressTimer) {
        clearTimeout(this.unassignedTouchState.longPressTimer);
        this.unassignedTouchState.longPressTimer = null;
      }
      return;
    }
    
    if (this.unassignedTouchState.isDragging) {
      e.preventDefault();
      // 更新幽灵元素位置
      if (this.unassignedTouchState.ghost) {
        this.unassignedTouchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.unassignedTouchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }
  }
  
  onUnassignedTouchEnd(e: TouchEvent) {
    if (this.unassignedTouchState.longPressTimer) {
      clearTimeout(this.unassignedTouchState.longPressTimer);
    }
    
    const { task, isDragging } = this.unassignedTouchState;
    
    // 移除幽灵元素
    if (this.unassignedTouchState.ghost) {
      this.unassignedTouchState.ghost.remove();
    }
    
    if (task && isDragging && this.diagram) {
      // 获取触摸结束位置
      const touch = e.changedTouches[0];
      const diagramRect = this.diagramDiv.nativeElement.getBoundingClientRect();
      
      // 检查是否在流程图区域内
      if (touch.clientX >= diagramRect.left && touch.clientX <= diagramRect.right &&
          touch.clientY >= diagramRect.top && touch.clientY <= diagramRect.bottom) {
        // 转换为流程图坐标
        const x = touch.clientX - diagramRect.left;
        const y = touch.clientY - diagramRect.top;
        const pt = new go.Point(x, y);
        const loc = this.diagram.transformViewToDoc(pt);
        
        // 查找插入位置
        const insertInfo = this.findInsertPosition(loc);
        
        if (insertInfo.parentId) {
          const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
          if (parentTask) {
            const newStage = (parentTask.stage || 1) + 1;
            this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), 100);
          }
        } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
          const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
          if (refTask?.stage) {
            this.store.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), 100);
          }
        } else {
          // 没有靠近任何节点，只更新位置
          this.store.updateTaskPosition(task.id, loc.x, loc.y);
        }
      }
    }
    
    this.unassignedDraggingId.set(null);
    this.unassignedTouchState = {
      task: null, startX: 0, startY: 0, isDragging: false, longPressTimer: null, ghost: null
    };
  }
  
  private createUnassignedGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.unassignedTouchState.ghost = ghost;
  }

  ngAfterViewInit() {
      this.initDiagram();
      // 初始化完成后立即加载图表数据
      setTimeout(() => {
          if (this.diagram) {
              this.updateDiagram(this.store.tasks());
          }
      }, 100);
      
      // 监听容器大小变化（侧边栏拖动时触发）
      this.setupResizeObserver();
  }
  
  ngOnDestroy() {
      // 清理 ResizeObserver
      if (this.resizeObserver) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
      }
      // 清理定时器
      if (this.positionSaveTimer) {
          clearTimeout(this.positionSaveTimer);
          this.positionSaveTimer = null;
      }
      if (this.resizeDebounceTimer) {
          clearTimeout(this.resizeDebounceTimer);
          this.resizeDebounceTimer = null;
      }
      // 清理待分配块长按定时器
      if (this.unassignedTouchState.longPressTimer) {
          clearTimeout(this.unassignedTouchState.longPressTimer);
      }
      // 清理幽灵元素
      if (this.unassignedTouchState.ghost) {
          this.unassignedTouchState.ghost.remove();
      }
  }
  
  private setupResizeObserver() {
      if (!this.diagramDiv?.nativeElement) return;
      
      this.resizeObserver = new ResizeObserver((entries) => {
          // 防抖动处理
          if (this.resizeDebounceTimer) {
              clearTimeout(this.resizeDebounceTimer);
          }
          this.resizeDebounceTimer = setTimeout(() => {
              if (this.diagram) {
                  // 获取新的容器尺寸
                  const div = this.diagramDiv.nativeElement;
                  const width = div.clientWidth;
                  const height = div.clientHeight;
                  
                  // 如果尺寸有效，重新设置 diagram 的 div 并请求更新
                  if (width > 0 && height > 0) {
                      // 强制 GoJS 重新计算画布大小
                      this.diagram.div = null;
                      this.diagram.div = div;
                      this.diagram.requestUpdate();
                  }
              }
          }, 100);
      });
      
      this.resizeObserver.observe(this.diagramDiv.nativeElement);
  }
  
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  initDiagram() {
      if (typeof go === 'undefined') {
          console.warn('❌ GoJS not loaded');
          return;
      }
      
      const $ = go.GraphObject.make;

      this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          "undoManager.isEnabled": true,
          "animationManager.isEnabled": false, // 禁用动画提升性能
          "allowDrop": true,
          // 默认不使用自动布局，保持用户手动调整的位置
          layout: $(go.Layout),
          
          // === 性能优化配置 ===
          "autoScale": go.Diagram.None,
          "initialAutoScale": go.Diagram.None,
          "scrollMargin": 100,
          "draggingTool.isGridSnapEnabled": false
      });
      
      // 监听节点移动完成（拖动结束时才保存，而非实时保存）
      this.diagram.addDiagramListener('SelectionMoved', (e: any) => {
          // 使用防抖，避免多选拖动时频繁保存
          if (this.positionSaveTimer) {
              clearTimeout(this.positionSaveTimer);
          }
          this.positionSaveTimer = setTimeout(() => {
              e.subject.each((part: any) => {
                  if (part instanceof go.Node) {
                      const loc = part.location;
                      this.zone.run(() => {
                          this.store.updateTaskPosition(part.data.key, loc.x, loc.y);
                      });
                  }
              });
          }, 300);
      });
      
      // 监听节点拖拽结束
      this.diagram.addDiagramListener('PartResized', (e: any) => {
          // 保存所有节点位置
          this.saveAllNodePositions();
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
            
            // Main Content - 待分配任务节点更小更紧凑，已分配任务节点正常大小
            $(go.Panel, "Auto",
                new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 140 : 200),
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
                  // 待分配任务使用深青色边框和背景，已分配任务使用默认边框
                  new go.Binding("stroke", "", (data: any, obj: any) => {
                      if (obj.part.isSelected) return "#0d9488"; // teal-600
                      return data.isUnassigned ? "#14b8a6" : "#e7e5e4"; // teal-500 vs stone-200
                  }).ofObject(),
                  new go.Binding("strokeWidth", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 2 : 1)
                ),
                $(go.Panel, "Vertical",
                    new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
                    $(go.TextBlock, { font: "bold 9px sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
                        new go.Binding("text", "displayId"),
                        new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
                    $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px sans-serif", stroke: "#57534e" },
                        new go.Binding("text", "title"),
                        new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? "500 11px sans-serif" : "400 12px sans-serif"),
                        new go.Binding("stroke", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? "#0f766e" : "#57534e"), // teal-700 vs stone-600
                        new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
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
                // 点击连接线 - 移动端长按删除
                click: (e: any, link: any) => {
                    // 选中连接线
                    e.diagram.select(link);
                },
                // 右键菜单删除连接
                contextMenu: $(go.Adornment, "Vertical",
                  $("ContextMenuButton",
                    $(go.TextBlock, "删除连接", { margin: 5 }),
                    { click: (e: any, obj: any) => this.deleteLinkFromContext(obj.part) }
                  )
                )
            },
            // Transparent fat line for easier selection - 移动端加粗方便点击
            $(go.Shape, { isPanelMain: true, strokeWidth: this.store.isMobile() ? 16 : 8, stroke: "transparent" }),
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
      
      // 移动端: 连接线长按删除
      if (this.store.isMobile()) {
        let linkLongPressTimer: any = null;
        let longPressedLink: any = null;
        
        this.diagram.addDiagramListener('ObjectSingleClicked', (e: any) => {
          const part = e.subject.part;
          if (part instanceof go.Link) {
            // 选中连接线时显示删除提示
            this.zone.run(() => {
              this.showLinkDeleteHint(part);
            });
          }
        });
      }

      // Initialize model with linkKeyProperty for proper merging
      this.diagram.model = new go.GraphLinksModel([], [], { 
          linkKeyProperty: 'key',
          nodeKeyProperty: 'key'
      });

      // Handle External Drops - 支持拖放到两个节点之间插入
      this.diagram.div.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'move';
          }
      });

      this.diagram.div.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          // 尝试两种数据格式
          let data = e.dataTransfer?.getData("application/json") || e.dataTransfer?.getData("text");
          if (!data) return;
          
          try {
              const task = JSON.parse(data);
              const pt = this.diagram.lastInput.viewPoint;
              const loc = this.diagram.transformViewToDoc(pt);
              
              // 查找拖放位置附近的节点，判断是否插入到两个节点之间
              const insertInfo = this.findInsertPosition(loc);
              
              if (insertInfo.parentId) {
                  // 插入为某个节点的子节点
                  const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
                  if (parentTask) {
                      const newStage = (parentTask.stage || 1) + 1;
                      this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else if (insertInfo.beforeTaskId) {
                  // 插入到某个节点之前（同级）
                  const beforeTask = this.store.tasks().find(t => t.id === insertInfo.beforeTaskId);
                  if (beforeTask && beforeTask.stage) {
                      this.store.moveTaskToStage(task.id, beforeTask.stage, insertInfo.beforeTaskId, beforeTask.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else if (insertInfo.afterTaskId) {
                  // 插入到某个节点之后（同级）
                  const afterTask = this.store.tasks().find(t => t.id === insertInfo.afterTaskId);
                  if (afterTask && afterTask.stage) {
                      // 找到 afterTask 的下一个同级节点
                      const siblings = this.store.tasks()
                          .filter(t => t.stage === afterTask.stage && t.parentId === afterTask.parentId)
                          .sort((a, b) => a.rank - b.rank);
                      const afterIndex = siblings.findIndex(t => t.id === afterTask.id);
                      const nextSibling = siblings[afterIndex + 1];
                      this.store.moveTaskToStage(task.id, afterTask.stage, nextSibling?.id || null, afterTask.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else {
                  // 如果没有靠近任何节点，保持待分配状态，只更新位置让它显示在流程图中
                  this.store.updateTaskPosition(task.id, loc.x, loc.y);
              }
          } catch (err) {
              console.error('Drop error:', err);
          }
      });

      this.diagram.addDiagramListener('LinkDrawn', (e: any) => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', (e: any) => this.handleLinkGesture(e));
  }
  
  // 根据拖放位置查找插入点
  private findInsertPosition(loc: any): { parentId?: string; beforeTaskId?: string; afterTaskId?: string } {
      if (!this.diagram) return {};
      
      const threshold = 120; // 检测范围（像素）- 增大以便更容易捕获
      let closestNode: any = null;
      let closestDistance = Infinity;
      let insertPosition: string = 'after';
      
      // 遍历所有节点找最近的（只查找已分配的节点，跳过待分配节点）
      this.diagram.nodes.each((node: any) => {
          // 跳过待分配节点（isUnassigned 为 true 或 stage 为 null）
          if (node.data?.isUnassigned || node.data?.stage === null) {
              return;
          }
          
          const nodeLoc = node.location;
          const dx = loc.x - nodeLoc.x;
          const dy = loc.y - nodeLoc.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < threshold && distance < closestDistance) {
              closestDistance = distance;
              closestNode = node;
              
              // 根据相对位置判断插入方式
              // 如果在节点右侧较远，可能是子节点
              // 如果在节点上方，插入到前面
              // 如果在节点下方，插入到后面
              if (dx > 100) {
                  insertPosition = 'child';
              } else if (dy < -30) {
                  insertPosition = 'before';
              } else {
                  insertPosition = 'after';
              }
          }
      });
      
      if (!closestNode) return {};
      
      const nodeId = closestNode.data.key;
      
      if (insertPosition === 'child') {
          return { parentId: nodeId };
      } else if (insertPosition === 'before') {
          return { beforeTaskId: nodeId };
      } else {
          return { afterTaskId: nodeId };
      }
  }

  updateDiagram(tasks: Task[]) {
      if (!this.diagram) {
          console.warn('❌ updateDiagram: diagram not initialized');
          return;
      }
      
      const model = this.diagram.model;
      if (!model) {
          console.warn('❌ updateDiagram: model not found');
          return;
      }
      
      const project = this.store.activeProject();
      if (!project) {
          console.warn('❌ updateDiagram: no active project');
          return;
      }
      
      // 获取所有任务（包括待分配的），只要任务有位置信息或 stage 就显示
      // 待分配任务如果被拖入流程图（有位置信息）也会显示
      const tasksToShow = tasks.filter(t => t.stage !== null || (t.x !== 0 || t.y !== 0));
      
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
      tasksToShow.filter(t => t.parentId).forEach(t => {
          parentChildPairs.add(`${t.parentId}->${t.id}`);
      });
      
      // 用于新节点的位置计算
      let newNodeIndex = 0;

      tasksToShow.forEach(t => {
          // 优先使用内存中的位置，其次使用 store 中保存的位置
          const existingLoc = existingLocations.get(t.id);
          let loc: string;
          
          if (existingLoc) {
              // 使用当前内存中的位置
              loc = existingLoc;
          } else if (t.x !== 0 || t.y !== 0) {
              // 使用 store 中保存的位置
              loc = `${t.x} ${t.y}`;
          } else {
              // 新节点：根据阶段和顺序计算初始位置
              const stageX = ((t.stage || 1) - 1) * 150;
              const indexY = newNodeIndex * 100;
              loc = `${stageX} ${indexY}`;
              newNodeIndex++;
          }
          
          // 待分配任务使用较深的青色背景，已分配任务使用白色/绿色背景
          const nodeColor = t.stage === null ? '#ccfbf1' : (t.status === 'completed' ? '#f0fdf4' : 'white'); // teal-100 vs white
          const borderColor = t.stage === null ? '#14b8a6' : '#e7e5e4'; // teal-500 vs stone-200
          
          nodeDataArray.push({
              key: t.id,
              title: t.title || '未命名任务',
              displayId: t.displayId,
              stage: t.stage, // Add stage info for drag computation
              loc: loc,
              color: nodeColor,
              borderColor: borderColor,
              isUnassigned: t.stage === null,
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
              const sourceExists = tasksToShow.some(t => t.id === conn.source);
              const targetExists = tasksToShow.some(t => t.id === conn.target);
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

  // 点击待分配任务块，在流程图中定位到该任务节点
  onUnassignedTaskClick(task: Task) {
      // 如果任务有位置信息（已被拖入过流程图），则定位到它
      if (task.x !== 0 || task.y !== 0) {
          this.centerOnNode(task.id);
      } else {
          // 没有位置信息，只选中任务显示详情
          this.selectedTaskId.set(task.id);
          this.store.isFlowDetailOpen.set(true);
      }
  }

  centerOnNode(taskId: string, openDetail: boolean = true) {
      if (!this.diagram) return;
      const node = this.diagram.findNodeForKey(taskId);
      if (node) {
          this.diagram.centerRect(node.actualBounds);
          this.diagram.select(node);
          // 选中任务
          this.selectedTaskId.set(taskId);
          if (openDetail) {
              this.store.isFlowDetailOpen.set(true);
          }
      } else {
          // 任务可能未分配阶段，仍然选中
          this.selectedTaskId.set(taskId);
          if (openDetail) {
              this.store.isFlowDetailOpen.set(true);
          }
      }
  }

  // 窗口大小变化时重新调整图表（ResizeObserver 会处理容器大小变化，这里主要处理全屏等场景）
  @HostListener('window:resize')
  onWindowResize() {
      // ResizeObserver 已经在监听容器变化，这里不需要重复处理
      // 但保留作为后备
      if (this.diagram && !this.resizeObserver) {
          setTimeout(() => {
              this.diagram.requestUpdate();
          }, 100);
      }
  }

  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent) {
      if (!this.diagram) return;
      if (!event.altKey) return;
      
      const key = event.key.toLowerCase();
      
      // Alt+Z: 解除父子关系
      if (key === 'z') {
          const targets: string[] = [];
          const it = this.diagram.selection?.iterator;
          if (it) {
              while (it.next()) {
                  const part = it.value;
                  const nodeKey = part?.data?.key;
                  const isNode = typeof go !== 'undefined' ? part instanceof go.Node : !part?.category;
                  if (isNode && nodeKey) {
                      targets.push(nodeKey);
                  }
              }
          }

          if (!targets.length) return;
          event.preventDefault();
          event.stopPropagation();

          this.zone.run(() => {
              targets.forEach(id => this.store.detachTask(id));
          });
          return;
      }
      
      // Alt+X: 删除选中的连接线（跨树连接）
      if (key === 'x') {
          const linksToDelete: any[] = [];
          const it = this.diagram.selection?.iterator;
          if (it) {
              while (it.next()) {
                  const part = it.value;
                  // 判断是否是连接线：有 fromNode 和 toNode 属性，或者是 go.Link 实例
                  const isLink = part && (part.fromNode !== undefined || part instanceof go.Link);
                  if (isLink && part?.data?.isCrossTree) {
                      linksToDelete.push(part);
                  }
              }
          }
          
          if (!linksToDelete.length) return;
          event.preventDefault();
          event.stopPropagation();
          
          this.zone.run(() => {
              linksToDelete.forEach(link => {
                  const fromKey = link.data?.from;
                  const toKey = link.data?.to;
                  if (fromKey && toKey) {
                      this.store.removeConnection(fromKey, toKey);
                  }
              });
              setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
          });
          return;
      }
  }

    private handleLinkGesture(e: any) {
            if (!this.diagram) return;
            const link = e.subject;
            const fromNode = link?.fromNode;
            const toNode = link?.toNode;
            const parentId = fromNode?.data?.key;
            const childId = toNode?.data?.key;
            if (!parentId || !childId || parentId === childId) return;

            // 检查目标节点是否已有父节点
            const childTask = this.store.tasks().find(t => t.id === childId);
            if (childTask?.parentId) {
                // 如果已有父节点，创建跨树连接（虚线）而不是父子关系
                this.diagram.remove(link);
                this.zone.run(() => {
                    this.store.addCrossTreeConnection(parentId, childId);
                    setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
                });
                return;
            }

            const parentStage = typeof fromNode.data?.stage === 'number' ? fromNode.data.stage : null;
            const childStage = typeof toNode.data?.stage === 'number' ? toNode.data.stage : null;
            const nextStage = parentStage !== null ? parentStage + 1 : (childStage ?? 1);

            this.diagram.remove(link);
            this.zone.run(() => {
                    this.store.moveTaskToStage(childId, nextStage, undefined, parentId);
            });
    }
    
    // 移动端显示连接线删除提示
    showLinkDeleteHint(link: any) {
        if (!link || !this.diagram) return;
        
        // 获取连接线中点位置
        const midPoint = link.midPoint;
        if (!midPoint) return;
        
        // 转换为视口坐标
        const viewPt = this.diagram.transformDocToView(midPoint);
        const diagramRect = this.diagramDiv.nativeElement.getBoundingClientRect();
        
        this.linkDeleteHint.set({
            link,
            x: diagramRect.left + viewPt.x,
            y: diagramRect.top + viewPt.y
        });
        
        // 3秒后自动隐藏
        setTimeout(() => {
            if (this.linkDeleteHint()?.link === link) {
                this.linkDeleteHint.set(null);
            }
        }, 3000);
    }
    
    // 确认删除连接线
    confirmLinkDelete() {
        const hint = this.linkDeleteHint();
        if (!hint?.link) return;
        
        this.deleteLinkFromContext(hint.link);
        this.linkDeleteHint.set(null);
    }
    
    // 取消删除提示
    cancelLinkDelete() {
        this.linkDeleteHint.set(null);
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
