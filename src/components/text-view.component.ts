import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';

@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col h-full bg-canvas"><!-- 1. 待完成区域 -->
      <section 
        class="flex-none mt-2 px-2 pb-1 rounded-xl bg-retro-rust/10 border border-retro-rust/30 transition-all"
        [ngClass]="{'mx-4 mt-4': !isMobile(), 'mx-2': isMobile()}">
        <header 
          (click)="store.isTextUnfinishedOpen.set(!store.isTextUnfinishedOpen())" 
          class="py-2 cursor-pointer flex justify-between items-center group select-none">
          <span class="font-bold text-retro-dark flex items-center gap-2 tracking-tight"
                [ngClass]="{'text-sm': !isMobile(), 'text-xs': isMobile()}">
            <span class="w-1.5 h-1.5 rounded-full bg-retro-rust shadow-[0_0_6px_rgba(193,91,62,0.4)]"></span>
            待办事项
          </span>
          <span class="text-stone-300 text-xs group-hover:text-stone-500 transition-transform" 
                [class.rotate-180]="!store.isTextUnfinishedOpen()">▼</span>
        </header>
        
        @if (store.isTextUnfinishedOpen()) {
          <div class="pb-2 overflow-y-auto grid grid-cols-1 animate-collapse-open"
               [ngClass]="{'max-h-48 gap-2': !isMobile(), 'max-h-36 gap-1': isMobile()}">
            @for (item of store.unfinishedItems(); track trackUnfinished(item)) {
              <div class="p-2 bg-panel/50 backdrop-blur-sm rounded-lg border border-retro-muted/20 hover:border-retro-rust hover:shadow-sm cursor-pointer group flex items-start gap-2 active:scale-[0.98] transition-all">
                <button 
                  (click)="completeItem(item.taskId, item.text, $event)"
                  class="mt-0.5 w-4 h-4 rounded-full border-2 border-retro-muted bg-canvas hover:border-green-500 hover:bg-green-50 active:scale-90 transition-all"
                  title="点击完成"></button>
                <div class="flex-1 min-w-0" (click)="jumpToTask(item.taskId)">
                  <div class="text-[9px] font-bold text-retro-muted mb-0.5 tracking-wider group-hover:text-retro-rust transition-colors">{{item.taskDisplayId}}</div>
                  <div class="text-xs text-stone-600 line-clamp-2 group-hover:text-stone-900 transition-colors leading-relaxed">{{item.text}}</div>
                </div>
              </div>
            } @empty {
              <div class="text-xs text-stone-400 italic py-1 font-light">暂无待办</div>
            }
          </div>
        }
      </section>

      <!-- 2. 待分配区域 -->
      <section 
        class="flex-none mt-1 mb-2 px-2 pb-1 rounded-xl bg-retro-teal/10 border border-retro-teal/30 transition-all"
        [ngClass]="{'mx-4 mt-2 mb-4': !isMobile(), 'mx-2': isMobile()}">
        <header 
          (click)="store.isTextUnassignedOpen.set(!store.isTextUnassignedOpen())" 
          class="py-2 cursor-pointer flex justify-between items-center group select-none">
          <span class="font-bold text-retro-dark flex items-center gap-2 tracking-tight"
                [ngClass]="{'text-sm': !isMobile(), 'text-xs': isMobile()}">
            <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
            待分配
          </span>
          <span class="text-stone-300 text-xs group-hover:text-stone-500 transition-transform" 
                [class.rotate-180]="!store.isTextUnassignedOpen()">▼</span>
        </header>

        @if (store.isTextUnassignedOpen()) {
          <div class="pb-2 animate-collapse-open">
            <div class="flex flex-wrap" [ngClass]="{'gap-2': !isMobile(), 'gap-1.5': isMobile()}">
              @for (task of store.unassignedTasks(); track task.id) {
                @if (editingTaskId() === task.id) {
                  <!-- 编辑模式 -->
                  <div 
                    [attr.data-unassigned-task]="task.id"
                    class="w-full p-3 bg-white border-2 border-retro-teal rounded-lg shadow-md animate-collapse-open"
                    (click)="$event.stopPropagation()">
                    <div class="space-y-2">
                      <input
                        #unassignedTitleInput
                        type="text"
                        [value]="task.title"
                        (input)="onTitleInput(task.id, unassignedTitleInput.value)"
                        (focus)="onInputFocus()"
                        (blur)="onInputBlur()"
                        class="w-full text-sm font-medium text-stone-800 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-retro-teal bg-stone-50"
                        placeholder="任务名称..."
                        autofocus>
                      <textarea
                        #unassignedContentInput
                        [value]="task.content"
                        (input)="onContentInput(task.id, unassignedContentInput.value)"
                        (focus)="onInputFocus()"
                        (blur)="onInputBlur()"
                        class="w-full text-xs text-stone-600 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-retro-teal bg-stone-50 resize-none font-mono h-16"
                        placeholder="任务描述..."></textarea>
                      <div class="flex justify-end gap-2">
                        <button 
                          (click)="editingTaskId.set(null)"
                          class="px-3 py-1 text-xs text-retro-teal hover:bg-retro-teal/10 rounded transition-all">
                          完成
                        </button>
                      </div>
                    </div>
                  </div>
                } @else {
                  <!-- 显示模式 -->
                  <div 
                    [attr.data-unassigned-task]="task.id"
                    draggable="true"
                    (dragstart)="onDragStart($event, task)"
                    (dragend)="onDragEnd()"
                    (touchstart)="onTouchStart($event, task)"
                    (touchmove)="onTouchMove($event)"
                    (touchend)="onTouchEnd($event)"
                    class="px-2 py-1 bg-panel/50 backdrop-blur-sm border border-retro-muted/30 rounded-md text-xs font-medium text-retro-muted hover:border-retro-teal hover:text-retro-teal cursor-grab active:cursor-grabbing touch-none transition-all"
                    [class.opacity-50]="draggingTaskId() === task.id"
                    (click)="editingTaskId.set(task.id)">
                    {{task.title || '点击编辑...'}}
                  </div>
                }
              } @empty {
                <span class="text-xs text-stone-400 italic py-1 font-light">暂无</span>
              }
              <button 
                (click)="createUnassigned()" 
                class="px-2 py-1 bg-panel/30 hover:bg-retro-teal/20 text-retro-muted hover:text-retro-teal rounded-md text-xs font-medium transition-all">
                + 新建
              </button>
            </div>
          </div>
        }
      </section>

      <!-- 3. 阶段区域 -->
      <section 
        class="flex-1 min-h-0 overflow-hidden flex flex-col"
        [ngClass]="{'px-4 pb-6': !isMobile(), 'px-2 pb-4': isMobile()}">
        <div 
          class="rounded-xl bg-panel/40 border border-retro-muted/20 backdrop-blur-md px-2 py-2 shadow-inner w-full h-full flex flex-col overflow-hidden"
          [ngClass]="{'rounded-2xl px-4 py-3': !isMobile()}">
          
          <!-- 筛选栏 -->
          <div class="flex items-center justify-between text-stone-500"
               [ngClass]="{'mb-3': !isMobile(), 'mb-2': isMobile()}">
            <!-- 阶段筛选 -->
            <div class="flex items-center gap-1 relative">
              <span class="font-medium text-retro-muted" 
                    [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">阶段</span>
              <button 
                (click)="toggleFilter('stage', $event)"
                class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
                [ngClass]="{'text-xs px-3 py-1.5': !isMobile(), 'text-[10px] px-2 py-1': isMobile()}">
                <span>{{ currentStageLabel() }}</span>
                <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile(), 'h-2.5 w-2.5': isMobile()}" [class.rotate-180]="isStageFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              @if (isStageFilterOpen()) {
                <div class="fixed inset-0 z-40" (click)="isStageFilterOpen.set(false)"></div>
                <div class="absolute left-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                     [ngClass]="{'w-32': !isMobile(), 'w-auto min-w-[70px]': isMobile()}">
                  <div 
                    (click)="setStageFilter('all')"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                    <span>全部</span>
                    @if (store.stageFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                  <div class="h-px bg-stone-100 my-0.5"></div>
                  @for (stage of store.stages(); track stage.stageNumber) {
                    <div 
                      (click)="setStageFilter(stage.stageNumber)"
                      class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                      [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                      <span>阶段 {{stage.stageNumber}}</span>
                      @if (store.stageFilter() === stage.stageNumber) { <span class="text-indigo-600 font-bold">✓</span> }
                    </div>
                  }
                </div>
              }
            </div>
            
            <!-- 延伸筛选 -->
            <div class="flex items-center gap-1 relative">
              <span class="font-medium text-retro-muted"
                    [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">延伸</span>
              <button 
                (click)="toggleFilter('root', $event)"
                class="flex items-center gap-1 border border-retro-muted/30 rounded-md bg-canvas/70 backdrop-blur text-retro-dark hover:bg-retro-muted/10 transition-colors"
                [ngClass]="{'text-xs px-3 py-1.5': !isMobile(), 'text-[10px] px-2 py-1': isMobile()}">
                <span class="truncate" [ngClass]="{'max-w-[100px]': !isMobile(), 'max-w-[60px]': isMobile()}">{{ currentRootLabel() }}</span>
                <svg class="transition-transform" [ngClass]="{'h-3 w-3': !isMobile(), 'h-2.5 w-2.5': isMobile()}" [class.rotate-180]="isRootFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              @if (isRootFilterOpen()) {
                <div class="fixed inset-0 z-40" (click)="isRootFilterOpen.set(false)"></div>
                <div class="absolute right-0 top-full mt-1 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown"
                     [ngClass]="{'w-48': !isMobile(), 'w-auto min-w-[90px] max-w-[150px]': isMobile()}">
                  <div 
                    (click)="setRootFilter('all')"
                    class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                    [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                    <span>全部任务</span>
                    @if (store.stageViewRootFilter() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                  </div>
                  <div class="h-px bg-stone-100 my-0.5"></div>
                  @for (root of store.allStage1Tasks(); track root.id) {
                    <div 
                      (click)="setRootFilter(root.id)"
                      class="px-3 py-1.5 text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between transition-colors"
                      [ngClass]="{'text-xs px-4 py-2': !isMobile(), 'text-[10px] py-1': isMobile()}">
                      <span class="truncate">{{root.title}}</span>
                      @if (store.stageViewRootFilter() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                    </div>
                  }
                </div>
              }
            </div>
          </div>
          
          <!-- 阶段列表 -->
            <div class="w-full flex-1 min-h-0 overflow-auto"
              [ngClass]="{'grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 content-start items-start': !isMobile(), 'flex flex-col gap-2 flex-1 min-h-0': isMobile()}">
            @for (stage of visibleStages(); track stage.stageNumber) {
              <article 
                [attr.data-stage-number]="stage.stageNumber"
                class="flex flex-col bg-retro-cream/70 backdrop-blur border border-retro-muted/20 rounded-xl shadow-sm overflow-hidden transition-all"
                [ngClass]="{
                  'rounded-2xl': !isMobile(), 
                  'w-full': isMobile(),
                  'border-retro-teal border-2 bg-retro-teal/5': dragOverStage() === stage.stageNumber
                }"
                (dragover)="onStageDragOver($event, stage.stageNumber)"
                (dragleave)="dragOverStage.set(null)"
                (drop)="onStageDrop($event, stage.stageNumber)">
                
                <!-- 阶段标题 -->
                <header 
                  class="px-3 py-2 flex justify-between items-center cursor-pointer hover:bg-retro-cream/90 transition-colors select-none"
                  [ngClass]="{'px-4 py-3': !isMobile()}"
                  (click)="toggleStageCollapse(stage.stageNumber)">
                  <h3 class="font-bold text-retro-olive tracking-tight flex items-center"
                      [ngClass]="{'text-sm gap-2': !isMobile(), 'text-xs gap-1.5': isMobile()}">
                    <span class="rounded-full bg-retro-olive" 
                          [ngClass]="{'w-1 h-4': !isMobile(), 'w-0.5 h-3': isMobile()}"></span>
                    阶段 {{stage.stageNumber}}
                  </h3>
                  <div class="flex items-center" [ngClass]="{'gap-2': !isMobile(), 'gap-1.5': isMobile()}">
                    <span class="text-retro-olive font-mono bg-canvas/60 rounded-full"
                          [ngClass]="{'text-[10px] px-2': !isMobile(), 'text-[9px] px-1.5 py-0.5': isMobile()}">
                      {{stage.tasks.length}}
                    </span>
                    <span class="text-stone-400 text-[10px] transition-transform" 
                          [class.rotate-180]="!isStageExpanded(stage.stageNumber)">▼</span>
                  </div>
                </header>

                <!-- 任务列表 -->
                @if (isStageExpanded(stage.stageNumber)) {
                  <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 task-stack animate-collapse-open"
                       [ngClass]="{'space-y-2 px-3 pb-3': !isMobile(), 'space-y-1.5 max-h-[40vh]': isMobile()}">
                    @for (task of stage.tasks; track task.id) {
                      @if (shouldShowTask(task)) {
                        @if (dropTargetInfo()?.stageNumber === stage.stageNumber && dropTargetInfo()?.beforeTaskId === task.id) {
                          <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
                        }
                        <div 
                          [attr.data-task-id]="task.id"
                          (click)="selectTask(task)"
                          draggable="true"
                          (dragstart)="onDragStart($event, task)"
                          (dragend)="onDragEnd()"
                          (dragover)="onTaskDragOver($event, task, stage.stageNumber)"
                          (touchstart)="onTaskTouchStart($event, task)"
                          (touchmove)="onTouchMove($event)"
                          (touchend)="onTouchEnd($event)"
                          class="relative bg-canvas/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden select-none"
                          [ngClass]="{
                            'p-3': !isMobile(), 
                            'p-2': isMobile(),
                            'shadow-sm border-retro-muted/20': selectedTaskId() !== task.id,
                            'ring-1 ring-retro-gold shadow-md': selectedTaskId() === task.id,
                            'opacity-50': draggingTaskId() === task.id
                          }">
                          
                          <div class="flex justify-between items-start"
                               [ngClass]="{'mb-1': !isMobile(), 'mb-0.5': isMobile()}">
                            <span class="font-mono font-medium text-retro-muted"
                                  [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">{{task.displayId}}</span>
                            <span class="text-retro-muted/60 font-light"
                                  [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">{{task.createdDate | date:'yyyy/MM/dd HH:mm'}}</span>
                          </div>
                          
                          @if (selectedTaskId() !== task.id) {
                            <div class="font-medium text-retro-dark leading-snug line-clamp-2"
                                 [ngClass]="{'text-sm mb-1': !isMobile(), 'text-xs mb-0.5': isMobile()}">{{task.title || '未命名任务'}}</div>
                            <div class="text-stone-500 font-light leading-relaxed line-clamp-1"
                                 [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">{{task.content}}</div>
                          } @else {
                            <div class="animate-collapse-open"
                                 (click)="$event.stopPropagation()"
                                 (touchstart)="$event.stopPropagation()"
                                 [ngClass]="{'mt-2 space-y-2': !isMobile(), 'mt-1.5 space-y-1.5': isMobile()}">
                              <!-- 标题编辑 -->
                              <input
                                #titleInput
                                data-title-input
                                type="text"
                                [value]="task.title"
                                (input)="onTitleInput(task.id, titleInput.value)"
                                (focus)="onInputFocus()"
                                (blur)="onInputBlur()"
                                class="w-full font-medium text-retro-dark border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none bg-stone-50 touch-manipulation"
                                [ngClass]="{'text-sm p-2': !isMobile(), 'text-xs p-1.5': isMobile()}"
                                placeholder="任务名称...">
                              <!-- 内容编辑 -->
                              <textarea 
                                #contentInput
                                [value]="task.content"
                                (input)="onContentInput(task.id, contentInput.value)"
                                (focus)="onInputFocus()"
                                (blur)="onInputBlur()"
                                class="w-full border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-stone-50 resize-none touch-manipulation"
                                [ngClass]="{'h-24 text-xs p-2': !isMobile(), 'h-28 text-[11px] p-2': isMobile()}"
                                placeholder="输入 Markdown 内容..."></textarea>
                              
                              <div class="flex flex-wrap border-t border-stone-100"
                                   [ngClass]="{'gap-2 pt-2': !isMobile(), 'gap-1.5 pt-1.5': isMobile()}">
                                <button 
                                  (click)="addSibling(task, $event)" 
                                  class="flex-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 font-medium rounded-md flex items-center justify-center transition-all"
                                  [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
                                  title="添加同级">
                                  <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                  同级
                                </button>
                                <button 
                                  (click)="addChild(task, $event)" 
                                  class="flex-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 font-medium rounded-md flex items-center justify-center transition-all"
                                  [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
                                  title="添加下级">
                                  <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                                  下级
                                </button>
                                <button 
                                  (click)="deleteTask(task, $event)" 
                                  class="bg-stone-100 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 hover:border-red-500 font-medium rounded-md flex items-center justify-center transition-all"
                                  [ngClass]="{'px-2 py-1 text-xs': !isMobile(), 'px-1.5 py-0.5 text-[10px]': isMobile()}"
                                  title="删除任务">
                                  <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                </button>
                              </div>
                            </div>
                          }
                        </div>
                      }
                    }
                    @if (dropTargetInfo()?.stageNumber === stage.stageNumber && dropTargetInfo()?.beforeTaskId === null) {
                      <div class="h-0.5 bg-retro-teal rounded-full mx-1 animate-pulse"></div>
                    }
                  </div>
                }
              </article>
            }
            
            <!-- 添加阶段按钮 -->
            <div class="flex items-center justify-center rounded-xl border-2 border-dashed border-stone-200 hover:border-stone-300 transition-all cursor-pointer min-h-[60px]"
                 [ngClass]="{'py-6': !isMobile(), 'py-4': isMobile()}"
                 (click)="addNewStage()">
              <span class="text-stone-400 hover:text-stone-600 text-lg font-light">+ 新阶段</span>
            </div>
          </div>
        </div>
      </section>
      
      <!-- 删除确认弹窗 -->
      @if (deleteConfirmTask()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
             (click)="deleteConfirmTask.set(null)">
          <div class="bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden animate-scale-in"
               [ngClass]="{'w-80 mx-4': isMobile(), 'w-96': !isMobile()}"
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
  `,
  styles: [`
    .animate-collapse-open { 
      animation: collapseOpen 0.25s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-8px); max-height: 0; } 
      to { opacity: 1; transform: translateY(0); max-height: 1000px; } 
    }
  `]
})
export class TextViewComponent {
  readonly store = inject(StoreService);
  
  // UI 状态
  readonly selectedTaskId = signal<string | null>(null);
  readonly collapsedStages = signal<Set<number>>(new Set());
  readonly isStageFilterOpen = signal(false);
  readonly isRootFilterOpen = signal(false);
  
  // 待分配任务编辑状态
  readonly editingTaskId = signal<string | null>(null);
  
  // 删除确认状态
  readonly deleteConfirmTask = signal<Task | null>(null);
  
  // 拖拽状态
  readonly draggingTaskId = signal<string | null>(null);
  readonly dragOverStage = signal<number | null>(null);
  readonly dropTargetInfo = signal<{ stageNumber: number; beforeTaskId: string | null } | null>(null);
  
  // 触摸拖拽状态 - 增强版
  private touchState = { 
    task: null as Task | null, 
    startX: 0,
    startY: 0, 
    currentX: 0,
    currentY: 0,
    targetStage: null as number | null,
    targetBeforeId: null as string | null,
    isDragging: false,
    dragGhost: null as HTMLElement | null,
    longPressTimer: null as ReturnType<typeof setTimeout> | null
  };

  // 计算属性
  readonly isMobile = this.store.isMobile;
  
  readonly currentStageLabel = computed(() => {
    const filter = this.store.stageFilter();
    return filter === 'all' ? '全部' : `阶段 ${filter}`;
  });

  readonly currentRootLabel = computed(() => {
    const filter = this.store.stageViewRootFilter();
    if (filter === 'all') return '全部任务';
    return this.store.allStage1Tasks().find(t => t.id === filter)?.title ?? '全部任务';
  });

  readonly visibleStages = computed(() => {
    const filter = this.store.stageFilter();
    const stages = this.store.stages();
    return filter === 'all' ? stages : stages.filter(s => s.stageNumber === filter);
  });

  constructor() {
    queueMicrotask(() => {
      const collapsed = new Set(this.store.stages().map(s => s.stageNumber));
      this.collapsedStages.set(collapsed);
    });
  }

  // 工具方法
  trackUnfinished = (item: { taskId: string; text: string }) => `${item.taskId}-${item.text}`;
  isStageExpanded = (stageNumber: number) => !this.collapsedStages().has(stageNumber);

  shouldShowTask(task: Task): boolean {
    const rootFilter = this.store.stageViewRootFilter();
    if (rootFilter === 'all') return true;
    const root = this.store.allStage1Tasks().find(t => t.id === rootFilter);
    return root ? (task.id === root.id || task.displayId.startsWith(root.displayId + ',')) : true;
  }

  // 筛选操作
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
    this.store.setStageFilter(value);
    this.isStageFilterOpen.set(false);
  }

  setRootFilter(value: string) {
    this.store.stageViewRootFilter.set(value);
    this.isRootFilterOpen.set(false);
  }

  // 阶段折叠
  toggleStageCollapse(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.has(stageNumber) ? newSet.delete(stageNumber) : newSet.add(stageNumber);
      return newSet;
    });
  }

  expandStage(stageNumber: number) {
    this.collapsedStages.update(set => {
      const newSet = new Set(set);
      newSet.delete(stageNumber);
      return newSet;
    });
  }

  // 任务选择
  selectTask(task: Task) {
    this.selectedTaskId.update(id => id === task.id ? null : task.id);
  }

  // 待办项操作
  completeItem(taskId: string, itemText: string, event: Event) {
    event.stopPropagation();
    this.store.completeUnfinishedItem(taskId, itemText);
  }

  jumpToTask(id: string) {
    const task = this.store.tasks().find(t => t.id === id);
    if (!task) return;
    
    if (task.stage) {
      this.expandStage(task.stage);
      if (this.store.stageFilter() !== 'all' && this.store.stageFilter() !== task.stage) {
        this.store.setStageFilter('all');
      }
    }
    
    this.selectedTaskId.set(id);
    requestAnimationFrame(() => {
      document.querySelector(`[data-task-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // 输入状态管理 - 防止输入抖动
  private isInputFocused = false;
  
  onInputFocus() {
    this.isInputFocused = true;
    this.store.markEditing();
  }
  
  onInputBlur() {
    this.isInputFocused = false;
  }
  
  onTitleInput(taskId: string, value: string) {
    this.store.updateTaskTitle(taskId, value);
  }
  
  onContentInput(taskId: string, value: string) {
    this.store.updateTaskContent(taskId, value);
  }

  // 拖拽操作
  onDragStart(e: DragEvent, task: Task) {
    this.draggingTaskId.set(task.id);
    e.dataTransfer?.setData('application/json', JSON.stringify(task));
    e.dataTransfer!.effectAllowed = 'move';
  }

  onDragEnd() {
    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
  }

  onTaskDragOver(e: DragEvent, targetTask: Task, stageNumber: number) {
    e.preventDefault();
    e.stopPropagation();
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    
    if (isAbove) {
      this.dropTargetInfo.set({ stageNumber, beforeTaskId: targetTask.id });
    } else {
      const stage = this.visibleStages().find(s => s.stageNumber === stageNumber);
      const idx = stage?.tasks.findIndex(t => t.id === targetTask.id) ?? -1;
      const nextTask = stage?.tasks[idx + 1];
      this.dropTargetInfo.set({ stageNumber, beforeTaskId: nextTask?.id ?? null });
    }
  }

  onStageDragOver(e: DragEvent, stageNumber: number) {
    e.preventDefault();
    this.dragOverStage.set(stageNumber);
    this.expandStage(stageNumber);
    
    const dropInfo = this.dropTargetInfo();
    if (!dropInfo || dropInfo.stageNumber !== stageNumber) {
      this.dropTargetInfo.set({ stageNumber, beforeTaskId: null });
    }
  }

  onStageDrop(e: DragEvent, stageNumber: number) {
    e.preventDefault();
    const data = e.dataTransfer?.getData('application/json');
    if (data) {
      const task = JSON.parse(data) as Task;
      this.store.moveTaskToStage(task.id, stageNumber, this.dropTargetInfo()?.beforeTaskId);
      this.expandStage(stageNumber);
    }
    this.onDragEnd();
  }

  // 触摸拖拽 - 长按开始拖拽
  onTouchStart(e: TouchEvent, task: Task) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    
    // 清除之前的长按计时器
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      targetStage: null,
      targetBeforeId: null,
      isDragging: false,
      dragGhost: null,
      longPressTimer: null
    };
    
    // 长按 200ms 后开始拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      if (this.touchState.task?.id === task.id) {
        this.touchState.isDragging = true;
        this.draggingTaskId.set(task.id);
        this.createDragGhost(task, touch.clientX, touch.clientY);
        // 触发震动反馈（如果支持）
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }
    }, 200);
  }
  
  // 创建拖拽幽灵元素
  private createDragGhost(task: Task, x: number, y: number) {
    // 移除旧的幽灵元素
    this.removeDragGhost();
    
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-retro-teal/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title;
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    ghost.style.transform = 'scale(1.05)';
    ghost.style.opacity = '0.95';
    document.body.appendChild(ghost);
    this.touchState.dragGhost = ghost;
  }
  
  // 移除拖拽幽灵元素
  private removeDragGhost() {
    if (this.touchState.dragGhost) {
      this.touchState.dragGhost.remove();
      this.touchState.dragGhost = null;
    }
  }

  onTouchMove(e: TouchEvent) {
    if (!this.touchState.task || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.touchState.isDragging && (deltaX > 10 || deltaY > 10)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }
    
    // 如果正在拖拽，阻止默认行为并更新位置
    if (this.touchState.isDragging) {
      e.preventDefault();
      
      this.touchState.currentX = touch.clientX;
      this.touchState.currentY = touch.clientY;
      
      // 更新幽灵元素位置
      if (this.touchState.dragGhost) {
        this.touchState.dragGhost.style.left = `${touch.clientX - 40}px`;
        this.touchState.dragGhost.style.top = `${touch.clientY - 20}px`;
      }
      
      // 查找目标阶段和任务位置
      const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
      let foundStage = false;
      
      for (const el of elements) {
        // 检查是否在阶段块上
        const stageEl = el.closest('[data-stage-number]');
        if (stageEl) {
          const stageNum = parseInt(stageEl.getAttribute('data-stage-number') || '0', 10);
          if (stageNum > 0) {
            this.touchState.targetStage = stageNum;
            this.dragOverStage.set(stageNum);
            this.expandStage(stageNum);
            foundStage = true;
            
            // 检查是否在某个任务上方
            const taskEl = el.closest('[data-task-id]');
            if (taskEl) {
              const taskId = taskEl.getAttribute('data-task-id');
              const rect = taskEl.getBoundingClientRect();
              const isAbove = touch.clientY < rect.top + rect.height / 2;
              
              if (isAbove) {
                this.touchState.targetBeforeId = taskId;
                this.dropTargetInfo.set({ stageNumber: stageNum, beforeTaskId: taskId });
              } else {
                // 找下一个任务
                const stage = this.visibleStages().find(s => s.stageNumber === stageNum);
                const idx = stage?.tasks.findIndex(t => t.id === taskId) ?? -1;
                const nextTask = stage?.tasks[idx + 1];
                this.touchState.targetBeforeId = nextTask?.id ?? null;
                this.dropTargetInfo.set({ stageNumber: stageNum, beforeTaskId: nextTask?.id ?? null });
              }
            } else {
              // 在阶段块上但不在任务上，插入到末尾
              this.touchState.targetBeforeId = null;
              this.dropTargetInfo.set({ stageNumber: stageNum, beforeTaskId: null });
            }
            break;
          }
        }
      }
      
      if (!foundStage) {
        this.touchState.targetStage = null;
        this.touchState.targetBeforeId = null;
        this.dragOverStage.set(null);
        this.dropTargetInfo.set(null);
      }
    }
  }

  onTouchEnd(e: TouchEvent) {
    // 清除长按计时器
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
    
    const { task, isDragging, targetStage, targetBeforeId } = this.touchState;
    
    // 移除幽灵元素
    this.removeDragGhost();
    
    if (!task) {
      this.resetTouchState();
      return;
    }
    
    // 只有在真正拖拽状态下才执行移动
    if (isDragging && targetStage) {
      this.store.moveTaskToStage(task.id, targetStage, targetBeforeId);
      this.expandStage(targetStage);
    }
    
    this.resetTouchState();
    this.onDragEnd();
  }
  
  // 重置触摸状态
  private resetTouchState() {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    this.touchState = {
      task: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      targetStage: null,
      targetBeforeId: null,
      isDragging: false,
      dragGhost: null,
      longPressTimer: null
    };
  }

  // 阶段内任务的触摸拖拽开始 - 用于重新排序
  onTaskTouchStart(e: TouchEvent, task: Task) {
    // 如果任务已选中且正在编辑，不启动拖拽
    if (this.selectedTaskId() === task.id) {
      return;
    }
    
    // 复用待分配任务的触摸逻辑
    this.onTouchStart(e, task);
  }

  // 任务创建
  addSibling(task: Task, e: Event) {
    e.stopPropagation();
    const newTaskId = this.store.addTask('', '', task.stage, task.parentId, true);
    if (newTaskId) {
      this.navigateToNewTask(newTaskId, task.stage);
    }
  }

  addChild(task: Task, e: Event) {
    e.stopPropagation();
    const newStage = (task.stage || 0) + 1;
    const newTaskId = this.store.addTask('', '', newStage, task.id, false);
    if (newTaskId) {
      this.navigateToNewTask(newTaskId, newStage);
    }
  }

  deleteTask(task: Task, e: Event) {
    e.stopPropagation();
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

  createUnassigned() {
    const newTaskId = this.store.addTask('', '', null, null, false);
    if (newTaskId) {
      // 选中新任务并开启编辑模式
      this.editingTaskId.set(newTaskId);
      // 滚动到视图并聚焦到标题输入框
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.querySelector(`[data-unassigned-task="${newTaskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 聚焦到标题输入框
            setTimeout(() => {
              const input = el.querySelector('input') as HTMLInputElement;
              if (input) {
                input.focus();
              }
            }, 100);
          }
        }, 50);
      });
    }
  }
  
  // 导航到新建的任务
  private navigateToNewTask(taskId: string, stage: number | null) {
    // 展开目标阶段
    if (stage) {
      this.expandStage(stage);
      // 如果当前筛选不是全部且不是目标阶段，切换到全部
      if (this.store.stageFilter() !== 'all' && this.store.stageFilter() !== stage) {
        this.store.setStageFilter('all');
      }
    }
    
    // 选中新任务
    this.selectedTaskId.set(taskId);
    
    // 滚动到新任务位置
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.querySelector(`[data-task-id="${taskId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // 聚焦到标题输入框
          setTimeout(() => {
            const titleInput = el.querySelector('input[data-title-input]') as HTMLInputElement;
            if (titleInput) {
              titleInput.focus();
              titleInput.select();
            }
          }, 100);
        }
      }, 100);
    });
  }

  addNewStage() {
    const maxStage = Math.max(...this.store.stages().map(s => s.stageNumber), 0);
    const newTaskId = this.store.addTask('', '', maxStage + 1, null, false);
    if (newTaskId) {
      this.navigateToNewTask(newTaskId, maxStage + 1);
    }
  }
}
