
import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col h-full bg-[#F9F8F6]">
      
      <!-- 1. 待完成区域 (To-Do Area) -->
      <div class="flex-none mx-4 mt-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-orange-50/60 border border-orange-100/50">
        <div (click)="store.isTextUnfinishedOpen.set(!store.isTextUnfinishedOpen())" 
             class="py-3 cursor-pointer flex justify-between items-center group select-none">
          <span class="font-bold text-stone-800 text-sm flex items-center gap-3 tracking-tight">
            <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
            待办事项
          </span>
          <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isTextUnfinishedOpen()">
            ▼
          </span>
        </div>
        
        @if (store.isTextUnfinishedOpen()) {
          <div class="pb-4 max-h-48 overflow-y-auto grid grid-cols-1 gap-2 animate-slide-down">
            @for (item of store.unfinishedItems(); track item.taskId + item.text) {
              <div (dblclick)="jumpToTask(item.taskId)" class="p-3 bg-white/80 backdrop-blur-sm rounded-lg border border-stone-100/50 hover:border-orange-200 hover:shadow-sm cursor-pointer group transition-all flex items-start gap-3">
                 <div class="mt-1 w-3 h-3 rounded-full border border-stone-200 flex items-center justify-center bg-stone-50 group-hover:border-orange-300 transition-colors"></div>
                 <div class="flex-1">
                    <div class="text-[10px] font-bold text-stone-300 mb-0.5 tracking-wider group-hover:text-orange-300 transition-colors">{{item.taskDisplayId}}</div>
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
      <div class="flex-none mx-4 mt-2 mb-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-teal-50/60 border border-teal-100/50">
         <div (click)="store.isTextUnassignedOpen.set(!store.isTextUnassignedOpen())" 
              class="py-3 cursor-pointer flex justify-between items-center group select-none">
            <span class="font-bold text-stone-800 text-sm flex items-center gap-3 tracking-tight">
                <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
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
                      class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium text-stone-500 hover:border-teal-300 hover:text-teal-700 cursor-pointer transition-all"
                      (click)="selectTask(task)">
                       {{task.title}}
                    </div>
                  }
                  @if (store.unassignedTasks().length === 0) {
                      <div class="text-xs text-stone-400 italic py-1 font-light">暂无</div>
                  }
                  <button (click)="createUnassigned()" class="px-3 py-1.5 bg-white/50 hover:bg-teal-50 text-stone-400 hover:text-teal-600 rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
               </div>
            </div>
         }
      </div>

      <!-- 3. 阶段区域 (Stage Area) -->
      <div class="flex-1 overflow-x-auto overflow-y-hidden px-4 pb-6">
        <div class="h-full min-w-full w-fit rounded-3xl bg-indigo-50/60 border border-indigo-100/60 backdrop-blur-md px-6 py-6 shadow-inner">
          <div class="flex h-full gap-8">
            @for (stage of store.stages(); track stage.stageNumber) {
              <div class="w-80 flex-shrink-0 flex flex-col h-full bg-white/85 backdrop-blur border border-white/40 rounded-2xl px-4 py-5 shadow-sm">
                <!-- Stage Header -->
                <div class="mb-4 flex justify-between items-center px-1">
                  <h3 class="font-bold text-indigo-900 text-sm tracking-tight flex items-center gap-2">
                    <span class="inline-block w-1 h-4 rounded-full bg-indigo-300"></span>
                    阶段 {{stage.stageNumber}}
                  </h3>
                  <span class="text-indigo-300 text-[10px] font-mono bg-white/60 px-2 py-0.5 rounded-full">{{stage.tasks.length}}</span>
                </div>

                <!-- Tasks List -->
                <div class="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-1">
                @for (task of stage.tasks; track task.id) {
                  @if (shouldShow(task)) {
                    <div 
                      (click)="selectTask(task)"
                      class="relative bg-white/90 backdrop-blur-sm border border-transparent rounded-lg p-4 cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 group"
                      [class.shadow-sm]="selectedTaskId() !== task.id"
                      [class.border-stone-100]="selectedTaskId() !== task.id"
                      [class.ring-1]="selectedTaskId() === task.id"
                      [class.ring-stone-300]="selectedTaskId() === task.id"
                      [class.shadow-md]="selectedTaskId() === task.id">
                      
                      <!-- Header -->
                      <div class="flex justify-between items-start mb-2">
                         <span class="font-mono text-[10px] font-medium text-stone-400">{{task.displayId}}</span>
                         <div class="text-[10px] text-stone-300 font-light">{{task.createdDate | date:'HH:mm'}}</div>
                      </div>
                      
                      <div class="font-medium text-sm text-stone-800 mb-1 line-clamp-2 leading-relaxed">{{task.title}}</div>
                      
                      <!-- Collapsed Content Preview -->
                      @if (selectedTaskId() !== task.id) {
                          <div class="text-xs text-stone-400 line-clamp-2 font-light leading-relaxed" [innerHTML]="renderMarkdown(task.content)"></div>
                      }

                      <!-- Expanded Editing Area -->
                      @if (selectedTaskId() === task.id) {
                        <div class="mt-3 space-y-3 animate-fade-in">
                           <textarea 
                              #contentInput
                              [value]="task.content"
                              (input)="updateContent(task.id, contentInput.value)"
                              class="w-full h-32 text-sm p-2 border border-stone-200 rounded-lg focus:ring-1 focus:ring-stone-400 focus:border-stone-400 outline-none font-mono text-stone-600 bg-stone-50"
                              placeholder="输入 Markdown 内容..."></textarea>
                           
                           <!-- Actions -->
                           <div class="flex flex-wrap gap-2 pt-2 border-t border-stone-100">
                              <button (click)="addSibling(task, $event)" class="flex-1 px-2 py-1.5 bg-stone-50 hover:bg-stone-100 text-stone-600 text-xs font-medium rounded-md flex items-center justify-center gap-1 transition-colors" title="添加同级">
                                <span class="text-lg leading-none">+</span> 同级
                              </button>
                              <button (click)="addChild(task, $event)" class="flex-1 px-2 py-1.5 bg-stone-50 hover:bg-stone-100 text-stone-600 text-xs font-medium rounded-md flex items-center justify-center gap-1 transition-colors" title="添加下级">
                                <span class="text-lg leading-none">→</span> 下级
                              </button>
                              <button (click)="askAI(task, $event)" class="px-2 py-1.5 bg-stone-50 hover:bg-stone-100 text-stone-600 text-xs font-medium rounded-md transition-colors" title="AI 助手">
                                AI
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
  sanitizer = inject(DomSanitizer);
  // isUnfinishedOpen removed as it is now in store
  selectedTaskId = computed(() => this.store.activeTextTaskId());

  // toggleUnfinished removed

  selectTask(task: Task) {
      const next = this.selectedTaskId() === task.id ? null : task.id;
      this.store.setActiveTask(next, { openFlowDetail: true });
  }
  
  jumpToTask(id: string) {
      this.store.setActiveTask(id, { openFlowDetail: true });
      // logic to scroll to element would go here
  }

  shouldShow(task: Task) {
      const filter = this.store.filterMode();
      if (filter === 'all') return true;
      // Filter logic: Show if task.id == filter OR task.parentId == filter OR recursive check
      // Simplified: check if displayId starts with the filter root's displayId
      const root = this.store.rootTasks().find(r => r.id === filter);
      if (!root) return true;
      return task.displayId.startsWith(root.displayId);
  }
  
  updateContent(id: string, content: string) {
      this.store.updateTaskContent(id, content);
  }
  
  addSibling(task: Task, e: Event) {
      e.stopPropagation();
      this.store.addTask("新同级任务", "详情...", task.stage, task.parentId, true, undefined, task.id);
  }
  
  addChild(task: Task, e: Event) {
      e.stopPropagation();
      const nextStage = (task.stage || 0) + 1;
      this.store.addTask("新子任务", "详情...", nextStage, task.id, false, undefined, undefined);
  }
  
  createUnassigned() {
      this.store.addTask("新未分配任务", "...", null, null, false);
  }
  
  addNewStage() {
      // Adds a task to a new max stage + 1
      const maxStage = Math.max(...this.store.stages().map(s => s.stageNumber), 0);
      this.store.addTask("新阶段任务", "开始...", maxStage + 1, null, false);
  }

  renderMarkdown(content: string): SafeHtml {
      const escaped = content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

      const html = escaped
          .replace(/^###\s(.+)$/gm, '<h3 class="font-semibold text-sm mb-1">$1</h3>')
          .replace(/^##\s(.+)$/gm, '<h2 class="font-semibold text-base mb-1">$1</h2>')
          .replace(/^#\s(.+)$/gm, '<h1 class="font-bold text-lg mb-1">$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/`([^`]+)`/g, '<code class="bg-stone-100 px-1 rounded">$1</code>')
          .replace(/^- \[ \]\s(.+)$/gm, '<div class="flex items-start gap-2 text-xs"><span class="inline-block w-3 h-3 rounded border border-stone-200"></span><span>$1</span></div>')
          .replace(/^- \[x\]\s(.+)$/gim, '<div class="flex items-start gap-2 text-xs"><span class="inline-block w-3 h-3 rounded border border-stone-200 bg-emerald-200"></span><span>$1</span></div>')
          .replace(/\n/g, '<br>');

      return this.sanitizer.bypassSecurityTrustHtml(html);
  }
  
  async askAI(task: Task, e: Event) {
      e.stopPropagation();
      const res = await this.store.think(`为任务 "${task.title}" 建议一个详细的检查清单。`);
      this.store.updateTaskContent(task.id, task.content + '\n\n**AI 建议:**\n' + res);
  }
}
