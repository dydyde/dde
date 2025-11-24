
import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';

@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col h-full bg-canvas">
      
      <!-- 1. 待完成区域 (To-Do Area) -->
      <div class="flex-none mx-4 mt-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-retro-rust/10 border border-retro-rust/30">
        <div (click)="store.isTextUnfinishedOpen.set(!store.isTextUnfinishedOpen())" 
             class="py-3 cursor-pointer flex justify-between items-center group select-none">
          <span class="font-bold text-retro-dark text-sm flex items-center gap-3 tracking-tight">
            <span class="w-1.5 h-1.5 rounded-full bg-retro-rust shadow-[0_0_6px_rgba(193,91,62,0.4)]"></span>
            待办事项
          </span>
          <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isTextUnfinishedOpen()">
            ▼
          </span>
        </div>
        
        @if (store.isTextUnfinishedOpen()) {
          <div class="pb-4 max-h-48 overflow-y-auto grid grid-cols-1 gap-2 animate-slide-down">
            @for (item of store.unfinishedItems(); track item.taskId + item.text) {
              <div (dblclick)="jumpToTask(item.taskId)" class="p-3 bg-panel/50 backdrop-blur-sm rounded-lg border border-retro-muted/20 hover:border-retro-rust hover:shadow-sm cursor-pointer group transition-all flex items-start gap-3">
                 <div class="mt-1 w-3 h-3 rounded-full border border-retro-muted flex items-center justify-center bg-canvas group-hover:border-retro-rust transition-colors"></div>
                 <div class="flex-1">
                    <div class="text-[10px] font-bold text-retro-muted mb-0.5 tracking-wider group-hover:text-retro-rust transition-colors">{{item.taskDisplayId}}</div>
                    <div class="text-sm text-stone-600 line-clamp-2 group-hover:text-stone-900 transition-colors leading-relaxed">{{item.text}}</div>
                 </div>
              </div>
            }
            @if (store.unfinishedItems().length === 0) {
                <div class="text-xs text-stone-400 italic py-2 font-light">暂无待办</div>
            }
          </div>
        }
      </div>

      <!-- 2. 待分配区域 (To-Assign Area) -->
      <div class="flex-none mx-4 mt-2 mb-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-retro-teal/10 border border-retro-teal/30">
         <div (click)="store.isTextUnassignedOpen.set(!store.isTextUnassignedOpen())" 
              class="py-3 cursor-pointer flex justify-between items-center group select-none">
            <span class="font-bold text-retro-dark text-sm flex items-center gap-3 tracking-tight">
                <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
                待分配
            </span>
            <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isTextUnassignedOpen()">
                ▼
            </span>
         </div>

         @if (store.isTextUnassignedOpen()) {
            <div class="pb-4 animate-slide-down">
               <div class="flex flex-wrap gap-2">
                  @for (task of store.unassignedTasks(); track task.id) {
                    <div 
                      class="px-3 py-1.5 bg-panel/50 backdrop-blur-sm border border-retro-muted/30 rounded-md text-xs font-medium text-retro-muted hover:border-retro-teal hover:text-retro-teal cursor-pointer transition-all"
                      (click)="selectTask(task)">
                       {{task.title}}
                    </div>
                  }
                  @if (store.unassignedTasks().length === 0) {
                      <div class="text-xs text-stone-400 italic py-1 font-light">暂无</div>
                  }
                  <button (click)="createUnassigned()" class="px-3 py-1.5 bg-panel/30 hover:bg-retro-teal/20 text-retro-muted hover:text-retro-teal rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
               </div>
            </div>
         }
      </div>

      <!-- 3. 阶段区域 (Stage Area) -->
      <div class="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-4 pb-6">
        <div class="h-full min-h-0 min-w-full w-fit rounded-3xl bg-panel/40 border border-retro-muted/20 backdrop-blur-md px-6 py-6 shadow-inner">
          <div class="flex flex-col h-full min-h-0">
            <div class="flex items-center justify-between mb-4 text-xs text-stone-500">
              <div class="flex items-center gap-2">
                <span class="font-medium text-retro-muted">阶段筛选</span>
                <select class="border border-retro-muted/30 rounded-md px-2 py-1 bg-canvas/70 backdrop-blur text-retro-dark"
                        [value]="store.stageFilter()"
                        (change)="onStageFilterChange($event)">
                  <option value="all">全部</option>
                  @for (stage of store.stages(); track stage.stageNumber) {
                    <option [value]="stage.stageNumber">阶段 {{stage.stageNumber}}</option>
                  }
                </select>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-medium text-retro-muted">延伸筛选</span>
                <select class="border border-retro-muted/30 rounded-md px-2 py-1 bg-canvas/70 backdrop-blur text-retro-dark"
                        [value]="store.filterMode()"
                        (change)="updateRootFilter($event)">
                  <option value="all">全部任务</option>
                  @for (root of store.rootTasks(); track root.id) {
                    <option [value]="root.id">{{root.title}}</option>
                  }
                </select>
              </div>
            </div>
            <div class="flex h-full min-h-0 gap-8">
              @for (stage of visibleStages(); track stage.stageNumber) {
                <div class="w-80 max-w-[20rem] min-w-0 flex-shrink-0 flex flex-col h-full min-h-0 bg-retro-cream/70 backdrop-blur border border-retro-muted/20 rounded-2xl px-4 py-5 shadow-sm overflow-hidden">
                  <!-- Stage Header -->
                  <div class="mb-4 flex justify-between items-center px-1">
                    <h3 class="font-bold text-retro-olive text-sm tracking-tight flex items-center gap-2">
                      <span class="inline-block w-1 h-4 rounded-full bg-retro-olive"></span>
                      阶段 {{stage.stageNumber}}
                    </h3>
                    <span class="text-retro-olive text-[10px] font-mono bg-canvas/60 px-2 py-0.5 rounded-full">{{stage.tasks.length}}</span>
                  </div>

                  <!-- Tasks List -->
                  <div class="flex-1 min-h-0 overflow-y-auto space-y-3 custom-scrollbar pr-1 task-stack">
                  @for (task of stage.tasks; track task.id; let i = $index) {
                    @if (shouldShow(task, stage.stageNumber, i)) {
                      <div 
                        (click)="selectTask(task)"
                        class="relative bg-canvas/80 backdrop-blur-sm border border-transparent rounded-lg p-4 cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 group stack-card max-w-full min-w-0 overflow-hidden"
                        [class.shadow-sm]="selectedTaskId() !== task.id"
                        [class.border-retro-muted/20]="selectedTaskId() !== task.id"
                        [class.ring-1]="selectedTaskId() === task.id"
                        [class.ring-retro-gold]="selectedTaskId() === task.id"
                        [class.shadow-md]="selectedTaskId() === task.id">
                        
                        <!-- Header -->
                        <div class="flex justify-between items-start mb-2">
                           <span class="font-mono text-[10px] font-medium text-retro-muted">{{task.displayId}}</span>
                           <div class="text-[10px] text-retro-muted/60 font-light">{{task.createdDate | date:'HH:mm'}}</div>
                        </div>
                        
                        <div class="font-medium text-sm text-retro-dark mb-1 leading-relaxed">{{task.title}}</div>
                        
                        <!-- Collapsed Content Preview -->
                        @if (selectedTaskId() !== task.id) {
                            <div class="text-xs text-stone-500 font-light leading-relaxed markdown-preview"
                                 [class.line-clamp-2]="previewMode(stage.stageNumber, i, task.id) !== 'full'"
                                 [class.opacity-40]="previewMode(stage.stageNumber, i, task.id) === 'minimal'">
                                 {{task.content}}
                            </div>
                        }

                        <!-- Expanded Editing Area -->
                        @if (selectedTaskId() === task.id) {
                          <div class="mt-3 space-y-3 animate-fade-in max-w-full">
                            <textarea 
                               #contentInput
                               [value]="task.content"
                               (input)="updateContent(task.id, contentInput.value)"
                                (click)="$event.stopPropagation()"
                                class="w-full h-32 text-sm p-2 border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-stone-50 resize-none"
                                placeholder="输入 Markdown 内容..."></textarea>
                            
                            <!-- Actions -->
                            <div class="flex flex-wrap gap-2 pt-2 border-t border-stone-100">
                                <button (click)="addSibling(task, $event)" class="flex-1 px-2 py-1.5 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-all duration-200" title="添加同级">
                                  <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                  同级
                                </button>
                                <button (click)="addChild(task, $event)" class="flex-1 px-2 py-1.5 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-all duration-200" title="添加下级">
                                  <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"></polyline><path d="M4 4v7a4 4 0 0 0 4 4h12"></path></svg>
                                  下级
                                </button>
                             </div>
                          </div>
                        }
                      </div>
                    }
                  }
                  </div>
                </div>
              }
              
              <!-- Add Stage Placeholder -->
              <div class="w-12 flex-shrink-0 flex items-start pt-10 justify-center opacity-0 hover:opacity-100 transition-opacity">
                 <button (click)="addNewStage()" class="w-8 h-8 rounded-full bg-transparent border border-dashed border-stone-300 text-stone-400 hover:border-stone-400 hover:text-stone-600 flex items-center justify-center">
                    <span class="text-xl font-light">+</span>
                 </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .animate-slide-down { animation: slideDown 0.3s ease-out; }
    .animate-fade-in { animation: fadeIn 0.3s ease-out; }
    @keyframes slideDown { from { opacity:0; transform: translateY(-10px); } to { opacity:1; transform: translateY(0); } }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  `]
})
export class TextViewComponent {
  store = inject(StoreService);
  // isUnfinishedOpen removed as it is now in store
  selectedTaskId = signal<string | null>(null);

  // toggleUnfinished removed

  hoveredTask = signal<{ id: string; stage: number; index: number } | null>(null);
  draggingTaskId = signal<string | null>(null);

  selectTask(task: Task) {
      if (this.selectedTaskId() === task.id) {
          this.selectedTaskId.set(null);
      } else {
          this.selectedTaskId.set(task.id);
      }
  }

  onTaskDragStart(e: DragEvent, task: Task) {
      this.draggingTaskId.set(task.id);
      e.dataTransfer?.setData('text/plain', JSON.stringify(task));
  }

  onTaskDragOver(e: DragEvent, task: Task) {
      e.preventDefault();
  }

  onTaskDrop(e: DragEvent, targetTask: Task) {
      e.preventDefault();
      const draggingId = this.draggingTaskId();
      if (draggingId && draggingId !== targetTask.id) {
          // Reorder logic would go here
      }
      this.draggingTaskId.set(null);
  }

  onTaskHover(task: Task, stage: number, index: number) {
      this.hoveredTask.set({ id: task.id, stage, index });
  }

  onStageDragOver(e: DragEvent) {
      e.preventDefault();
  }

  onStageDrop(e: DragEvent, stageNumber: number) {
      e.preventDefault();
      const data = e.dataTransfer?.getData('text/plain');
      if (data) {
          const task = JSON.parse(data);
          if (task.stage !== stageNumber) {
              this.store.moveTaskToStage(task.id, stageNumber);
          }
      }
  }

  onCanvasDragOver(e: DragEvent) {
      e.preventDefault();
  }

  onUnassignDrop(e: DragEvent) {
      e.preventDefault();
      const data = e.dataTransfer?.getData('text/plain');
      if (data) {
          const task = JSON.parse(data);
          this.store.moveTaskToStage(task.id, null);
      }
  }
  
  jumpToTask(id: string) {
      this.selectedTaskId.set(id);
      // logic to scroll to element would go here
  }

  visibleStages() {
      const filter = this.store.stageFilter();
      const stages = this.store.stages();
      if (filter === 'all') return stages;
      return stages.filter(s => s.stageNumber === filter);
  }

  updateRootFilter(e: Event) {
      const val = (e.target as HTMLSelectElement).value;
      this.store.filterMode.set(val);
  }

  onStageFilterChange(e: Event) {
      const val = (e.target as HTMLSelectElement).value;
      this.store.setStageFilter(val === 'all' ? 'all' : +val);
  }

  shouldShow(task: Task, stageNumber?: number, index?: number) {
      if (this.store.stageFilter() !== 'all' && task.stage !== this.store.stageFilter()) {
          return false;
      }
      return true;
  }
  
  previewMode(stage: number, index: number, taskId: string): 'full' | 'minimal' | 'hidden' {
      return 'full';
  }
  
  updateContent(id: string, content: string) {
      this.store.updateTaskContent(id, content);
  }
  
  addSibling(task: Task, e: Event) {
      e.stopPropagation();
      this.store.addTask("新同级任务", "详情...", task.stage, task.parentId, true);
  }
  
  addChild(task: Task, e: Event) {
      e.stopPropagation();
      const nextStage = (task.stage || 0) + 1;
      this.store.addTask("新子任务", "详情...", nextStage, task.id, false);
  }
  
  createUnassigned() {
      this.store.addTask("新未分配任务", "...", null, null, false);
  }
  
  addNewStage() {
      // Adds a task to a new max stage + 1
      const maxStage = Math.max(...this.store.stages().map(s => s.stageNumber), 0);
      this.store.addTask("新阶段任务", "开始...", maxStage + 1, null, false);
  }
  
  async askAI(task: Task, e: Event) {
      e.stopPropagation();
      const res = await this.store.think(`为任务 "${task.title}" 建议一个详细的检查清单。`);
      this.store.updateTaskContent(task.id, task.content + '\n\n**AI 建议:**\n' + res);
  }
}
