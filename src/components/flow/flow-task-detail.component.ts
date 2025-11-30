import { Component, input, output, signal, computed, inject, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../../services/store.service';
import { Task, Attachment } from '../../models';
import { AttachmentManagerComponent } from '../attachment-manager.component';
import { renderMarkdown } from '../../utils/markdown';

/**
 * 任务详情面板组件
 * 桌面端：可拖动浮动面板
 * 移动端：底部抽屉
 * 
 * 默认为预览模式，点击切换到编辑模式
 */
@Component({
  selector: 'app-flow-task-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, AttachmentManagerComponent],
  template: `
    <!-- 桌面端可拖动浮动面板 -->
    @if (!store.isMobile() && store.isFlowDetailOpen()) {
      <div class="absolute z-20 pointer-events-auto"
           [style.right.px]="position().x < 0 ? 0 : null"
           [style.top.px]="position().y < 0 ? 24 : position().y"
           [style.left.px]="position().x >= 0 ? position().x : null">
         <!-- Content Panel -->
         <div class="w-64 max-h-96 bg-white/95 backdrop-blur-xl border border-stone-200/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
             
             <!-- 可拖动标题栏 -->
             <div class="px-3 py-2 border-b border-stone-100 flex justify-between items-center cursor-move select-none bg-gradient-to-r from-stone-50 to-white"
                  (mousedown)="startDrag($event)"
                  (touchstart)="startDrag($event)">
                 <div class="flex items-center gap-1.5">
                     <span class="text-[8px] text-stone-400">☰</span>
                     <h3 class="font-bold text-stone-700 text-xs">任务详情</h3>
                 </div>
                 <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                   </svg>
                 </button>
             </div>
                 
             <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                 @if (task(); as t) {
                     <ng-container *ngTemplateOutlet="taskContent; context: { $implicit: t }"></ng-container>
                 } @else if (store.activeProject()) {
                     <div class="text-[11px] space-y-1">
                         <div class="font-bold text-stone-800">{{store.activeProject()?.name}}</div>
                         <div class="text-stone-400 font-mono text-[10px]">{{store.activeProject()?.createdDate | date:'yyyy-MM-dd'}}</div>
                         <div class="text-stone-500 mt-1">{{store.activeProject()?.description}}</div>
                     </div>
                 } @else {
                     <div class="py-4 text-center text-stone-400 text-[10px]">
                         双击节点查看详情
                     </div>
                 }
             </div>
         </div>
      </div>
    }
    
    <!-- 桌面端详情开启按钮 -->
    @if (!store.isMobile() && !store.isFlowDetailOpen()) {
      <button (click)="store.isFlowDetailOpen.set(true)" 
              class="absolute top-6 right-2 z-20 bg-white/90 backdrop-blur border border-stone-200 rounded-lg p-2 shadow-sm hover:bg-white text-stone-400 hover:text-stone-600 transition-all flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-[10px] font-medium">详情</span>
      </button>
    }

    <!-- 移动端底部小型标签触发器 -->
    @if (store.isMobile() && !store.isFlowDetailOpen()) {
      <button 
        (click)="store.isFlowDetailOpen.set(true)"
        class="absolute bottom-2 right-2 z-20 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 px-2 py-1 flex items-center gap-1 text-stone-500 hover:text-stone-700">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-[10px] font-medium">详情</span>
      </button>
    }
    
    <!-- 移动端底部抽屉面板 -->
    @if (store.isMobile() && store.isFlowDetailOpen()) {
      <div class="absolute bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur-xl border-t border-stone-200 shadow-[0_-4px_20px_rgba(0,0,0,0.1)] rounded-t-2xl flex flex-col"
           [style.max-height.vh]="drawerHeight()"
           style="transform: translateZ(0); backface-visibility: hidden;">
        <!-- 拖动条 -->
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
        
        <!-- 内容区域 -->
        <div class="flex-1 overflow-y-auto px-3 pb-3 overscroll-contain"
             style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0);">
          @if (task(); as t) {
            <ng-container *ngTemplateOutlet="mobileTaskContent; context: { $implicit: t }"></ng-container>
          } @else {
            <div class="text-center text-stone-400 text-xs py-4">双击节点查看详情</div>
          }
        </div>
      </div>
    }
    
    <!-- 桌面端任务内容模板 -->
    <ng-template #taskContent let-task>
      <div class="space-y-2">
          <!-- 头部信息栏 + 编辑切换 -->
          <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-[10px]">
                  <span class="font-bold text-retro-muted bg-stone-100 px-1.5 py-0.5 rounded">{{store.compressDisplayId(task.displayId)}}</span>
                  <span class="text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
                  <span class="px-1.5 py-0.5 rounded"
                        [class.bg-emerald-100]="task.status === 'completed'"
                        [class.text-emerald-700]="task.status === 'completed'"
                        [class.bg-amber-100]="task.status !== 'completed'"
                        [class.text-amber-700]="task.status !== 'completed'">
                    {{task.status === 'completed' ? '完成' : '进行中'}}
                  </span>
              </div>
              <button 
                  (click)="toggleEditMode()"
                  class="text-[9px] px-1.5 py-0.5 rounded transition-colors"
                  [class.bg-indigo-100]="isEditMode()"
                  [class.text-indigo-600]="isEditMode()"
                  [class.bg-stone-100]="!isEditMode()"
                  [class.text-stone-500]="!isEditMode()"
                  [class.hover:bg-indigo-50]="!isEditMode()">
                  {{ isEditMode() ? '预览' : '编辑' }}
              </button>
          </div>
          
          <!-- 预览模式 -->
          @if (!isEditMode()) {
              <div class="cursor-pointer" (click)="toggleEditMode()">
                  <h4 class="text-xs font-medium text-stone-800 mb-1">{{ task.title || '无标题' }}</h4>
                  @if (task.content) {
                      <div 
                          class="text-[11px] text-stone-600 prose prose-stone prose-xs max-w-none leading-relaxed markdown-preview"
                          [innerHTML]="renderMarkdownContent(task.content)">
                      </div>
                  } @else {
                      <div class="text-[11px] text-stone-400 italic">点击编辑内容...</div>
                  }
              </div>
              
              <!-- 预览模式下的属性显示 -->
              <div class="flex flex-wrap gap-2 text-[10px] pt-1">
                  @if (task.priority) {
                      <span class="px-1.5 py-0.5 rounded"
                            [class.bg-red-100]="task.priority === 'urgent'"
                            [class.text-red-700]="task.priority === 'urgent'"
                            [class.bg-orange-100]="task.priority === 'high'"
                            [class.text-orange-700]="task.priority === 'high'"
                            [class.bg-yellow-100]="task.priority === 'medium'"
                            [class.text-yellow-700]="task.priority === 'medium'"
                            [class.bg-blue-100]="task.priority === 'low'"
                            [class.text-blue-700]="task.priority === 'low'">
                          {{ getPriorityLabel(task.priority) }}
                      </span>
                  }
                  @if (task.dueDate) {
                      <span class="text-stone-500">📅 {{ task.dueDate | date:'MM-dd' }}</span>
                  }
              </div>
              
              <!-- 预览模式下的标签 -->
              @if (task.tags?.length) {
                  <div class="flex flex-wrap gap-1">
                      @for (tag of task.tags; track tag) {
                          <span class="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[9px]">{{ tag }}</span>
                      }
                  </div>
              }
          } @else {
              <!-- 编辑模式 -->
              <input type="text" [ngModel]="task.title" (ngModelChange)="titleChange.emit({ taskId: task.id, title: $event })"
                  class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                  placeholder="任务标题">
              
              <textarea [ngModel]="task.content" (ngModelChange)="contentChange.emit({ taskId: task.id, content: $event })" rows="4"
                  class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono leading-relaxed"
                  placeholder="输入内容（支持 Markdown）..."></textarea>

              <!-- 任务属性：优先级和截止日期 -->
              <div class="flex gap-2">
                  <div class="flex-1">
                      <label class="text-[9px] text-stone-400 block mb-0.5">优先级</label>
                      <select 
                          [ngModel]="task.priority || ''"
                          (ngModelChange)="priorityChange.emit({ taskId: task.id, priority: $event || undefined })"
                          class="w-full text-[10px] border border-stone-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white">
                          <option value="">无</option>
                          <option value="low">低</option>
                          <option value="medium">中</option>
                          <option value="high">高</option>
                          <option value="urgent">紧急</option>
                      </select>
                  </div>
                  <div class="flex-1">
                      <label class="text-[9px] text-stone-400 block mb-0.5">截止日期</label>
                      <input 
                          type="date"
                          [ngModel]="task.dueDate || ''"
                          (ngModelChange)="dueDateChange.emit({ taskId: task.id, dueDate: $event || null })"
                          class="w-full text-[10px] border border-stone-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white">
                  </div>
              </div>

              <!-- 标签 -->
              <div>
                  <label class="text-[9px] text-stone-400 block mb-0.5">标签</label>
                  <div class="flex flex-wrap gap-1 mb-1">
                      @for (tag of task.tags || []; track tag) {
                          <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[9px]">
                              {{ tag }}
                              <button (click)="tagRemove.emit({ taskId: task.id, tag })" class="hover:text-indigo-900">×</button>
                          </span>
                      }
                  </div>
                  <div class="flex gap-1">
                      <input 
                          #tagInput
                          type="text"
                          placeholder="添加标签..."
                          (keydown.enter)="addTag(task.id, tagInput)"
                          class="flex-1 text-[10px] border border-stone-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white">
                      <button 
                          (click)="addTag(task.id, tagInput)"
                          class="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded text-[10px] transition-colors">
                          +
                      </button>
                  </div>
              </div>
          }

          <div class="flex gap-1.5 pt-1">
              <button (click)="addSibling.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                  +同级
              </button>
              <button (click)="addChild.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                  +下级
              </button>
              <button (click)="toggleStatus.emit(task)"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [class.bg-emerald-50]="task.status !== 'completed'"
                  [class.text-emerald-700]="task.status !== 'completed'"
                  [class.border-emerald-200]="task.status !== 'completed'"
                  [class.bg-stone-50]="task.status === 'completed'"
                  [class.text-stone-600]="task.status === 'completed'"
                  [class.border-stone-200]="task.status === 'completed'">
                  {{task.status === 'completed' ? '撤销' : '完成'}}
              </button>
          </div>
          
          <!-- 第二行按钮：归档和删除 -->
          <div class="flex gap-1.5">
              <button (click)="archiveTask.emit(task)"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [class.bg-violet-50]="task.status !== 'archived'"
                  [class.text-violet-600]="task.status !== 'archived'"
                  [class.border-violet-200]="task.status !== 'archived'"
                  [class.bg-stone-50]="task.status === 'archived'"
                  [class.text-stone-600]="task.status === 'archived'"
                  [class.border-stone-200]="task.status === 'archived'"
                  title="归档后任务将从主视图隐藏，可在回收站中恢复">
                  {{task.status === 'archived' ? '取消归档' : '归档'}}
              </button>
              <button (click)="deleteTask.emit(task)"
                  class="px-2 py-1 bg-stone-50 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 text-[10px] font-medium rounded transition-all">
                  删除
              </button>
          </div>
          
          <!-- 附件管理 -->
          @if (store.currentUserId()) {
            <app-attachment-manager
              [userId]="store.currentUserId()!"
              [projectId]="store.activeProjectId()!"
              [taskId]="task.id"
              [currentAttachments]="task.attachments"
              [compact]="true"
              (attachmentAdd)="attachmentAdd.emit({ taskId: task.id, attachment: $event })"
              (attachmentRemove)="attachmentRemove.emit({ taskId: task.id, attachmentId: $event })"
              (attachmentsChange)="attachmentsChange.emit({ taskId: task.id, attachments: $event })"
              (error)="attachmentError.emit($event)">
            </app-attachment-manager>
          }
      </div>
    </ng-template>
    
    <!-- 移动端任务内容模板 -->
    <ng-template #mobileTaskContent let-task>
      <!-- 紧凑的任务信息 -->
      <div class="flex items-center gap-2 mb-2">
        <span class="font-bold text-retro-muted text-[8px] tracking-wider bg-stone-100 px-1.5 rounded">{{store.compressDisplayId(task.displayId)}}</span>
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
      <input type="text" [ngModel]="task.title" (ngModelChange)="titleChange.emit({ taskId: task.id, title: $event })"
        class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
        placeholder="任务标题">
      
      <!-- 内容输入 -->
      <textarea [ngModel]="task.content" (ngModelChange)="contentChange.emit({ taskId: task.id, content: $event })" rows="2"
        class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono"
        placeholder="任务内容..."></textarea>
      
      <!-- 快速待办输入 -->
      <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5 mb-2">
        <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1.5">☐</span>
        <input
          #quickTodoInput
          type="text"
          (keydown.enter)="addQuickTodo(task.id, quickTodoInput)"
          class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[11px] py-1 px-1"
          placeholder="输入待办，回车添加...">
        <button
          (click)="addQuickTodo(task.id, quickTodoInput)"
          class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-1 mr-0.5 transition-all"
          title="添加待办">
          <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      
      <!-- 操作按钮 - 横向紧凑排列 -->
      <div class="flex gap-1.5">
        <button (click)="addSibling.emit(task)"
          class="flex-1 px-2 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
          +同级
        </button>
        <button (click)="addChild.emit(task)"
          class="flex-1 px-2 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
          +下级
        </button>
        <button (click)="toggleStatus.emit(task)"
          class="flex-1 px-2 py-1 text-[10px] font-medium rounded border transition-all"
          [class.bg-emerald-50]="task.status !== 'completed'"
          [class.text-emerald-700]="task.status !== 'completed'"
          [class.border-emerald-200]="task.status !== 'completed'"
          [class.bg-stone-50]="task.status === 'completed'"
          [class.text-stone-600]="task.status === 'completed'"
          [class.border-stone-200]="task.status === 'completed'">
          {{task.status === 'completed' ? '未完成' : '完成'}}
        </button>
      </div>
      
      <!-- 第二行按钮：归档和删除 -->
      <div class="flex gap-1.5 mt-1.5">
        <button (click)="archiveTask.emit(task)"
          class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
          [class.bg-violet-50]="task.status !== 'archived'"
          [class.text-violet-600]="task.status !== 'archived'"
          [class.border-violet-200]="task.status !== 'archived'"
          [class.bg-stone-50]="task.status === 'archived'"
          [class.text-stone-600]="task.status === 'archived'"
          [class.border-stone-200]="task.status === 'archived'">
          {{task.status === 'archived' ? '取消归档' : '归档'}}
        </button>
        <button (click)="deleteTask.emit(task)"
          class="px-2 py-1 bg-stone-50 text-stone-400 border border-stone-200 text-[10px] font-medium rounded transition-all">
          删除
        </button>
      </div>
      
      <!-- 附件管理（手机端） -->
      @if (store.currentUserId()) {
        <app-attachment-manager
          [userId]="store.currentUserId()!"
          [projectId]="store.activeProjectId()!"
          [taskId]="task.id"
          [currentAttachments]="task.attachments"
          [compact]="true"
          (attachmentsChange)="attachmentsChange.emit({ taskId: task.id, attachments: $event })"
          (error)="attachmentError.emit($event)">
        </app-attachment-manager>
      }
    </ng-template>
  `
})
export class FlowTaskDetailComponent {
  readonly store = inject(StoreService);
  
  // 输入
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh 单位
  
  // 编辑模式状态（默认为预览模式）
  readonly isEditMode = signal(false);
  
  // 位置变更输出
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 任务操作输出
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly priorityChange = output<{ taskId: string; priority: string | undefined }>();
  readonly dueDateChange = output<{ taskId: string; dueDate: string | null }>();
  readonly tagAdd = output<{ taskId: string; tag: string }>();
  readonly tagRemove = output<{ taskId: string; tag: string }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly toggleStatus = output<Task>();
  readonly archiveTask = output<Task>();
  readonly deleteTask = output<Task>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  
  // 附件操作输出
  readonly attachmentAdd = output<{ taskId: string; attachment: Attachment }>();
  readonly attachmentRemove = output<{ taskId: string; attachmentId: string }>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  
  // 拖动状态
  private dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  private isResizingDrawer = false;
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  
  /**
   * 切换编辑模式
   */
  toggleEditMode(): void {
    this.isEditMode.update(v => !v);
  }
  
  /**
   * 渲染 Markdown 内容
   */
  renderMarkdownContent(content: string): string {
    return renderMarkdown(content);
  }
  
  /**
   * 获取优先级标签
   */
  getPriorityLabel(priority: string): string {
    const labels: Record<string, string> = {
      'low': '低优先级',
      'medium': '中优先级',
      'high': '高优先级',
      'urgent': '紧急'
    };
    return labels[priority] || priority;
  }
  
  // 桌面端面板拖动
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    // 如果是默认位置，计算当前实际位置
    let currentX = pos.x;
    let currentY = pos.y;
    if (pos.x < 0) {
      currentX = window.innerWidth - 256 - 8; // 256 = panel width, 8 = right margin
      currentY = 24;
    }
    
    this.dragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: currentX,
      offsetY: currentY
    };
    
    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.stopDrag);
    document.addEventListener('touchmove', this.onDrag);
    document.addEventListener('touchend', this.stopDrag);
  }
  
  private onDrag = (event: MouseEvent | TouchEvent) => {
    if (!this.dragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.dragState.startX;
    const deltaY = clientY - this.dragState.startY;
    
    const newX = Math.max(0, this.dragState.offsetX + deltaX);
    const newY = Math.max(0, this.dragState.offsetY + deltaY);
    
    this.positionChange.emit({ x: newX, y: newY });
  };
  
  private stopDrag = () => {
    this.dragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.stopDrag);
    document.removeEventListener('touchmove', this.onDrag);
    document.removeEventListener('touchend', this.stopDrag);
  };
  
  // 移动端抽屉高度调整
  startDrawerResize(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    event.preventDefault();
    this.isResizingDrawer = true;
    this.isResizingChange.emit(true);
    this.drawerStartY = event.touches[0].clientY;
    this.drawerStartHeight = this.drawerHeight();
    
    const onMove = (ev: TouchEvent) => {
      if (!this.isResizingDrawer || ev.touches.length !== 1) return;
      ev.preventDefault();
      const deltaY = this.drawerStartY - ev.touches[0].clientY;
      const deltaVh = (deltaY / window.innerHeight) * 100;
      const newHeight = Math.max(15, Math.min(70, this.drawerStartHeight + deltaVh));
      this.drawerHeightChange.emit(newHeight);
    };
    
    const onEnd = () => {
      this.isResizingDrawer = false;
      this.isResizingChange.emit(false);
      // 如果高度太小，关闭抽屉
      if (this.drawerHeight() < 20) {
        this.store.isFlowDetailOpen.set(false);
        this.drawerHeightChange.emit(35);
      }
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
    
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }
  
  // 标签添加
  addTag(taskId: string, inputEl: HTMLInputElement) {
    const tag = inputEl.value.trim();
    if (tag) {
      this.tagAdd.emit({ taskId, tag });
      inputEl.value = '';
    }
  }
  
  // 快速待办
  addQuickTodo(taskId: string, inputEl: HTMLInputElement) {
    const text = inputEl.value.trim();
    if (text) {
      this.quickTodoAdd.emit({ taskId, text });
      inputEl.value = '';
      inputEl.focus();
    }
  }
}
