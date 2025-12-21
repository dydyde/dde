import { Component, input, output, signal, computed, inject, OnDestroy, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../../services/store.service';
import { Task, Attachment } from '../../models';
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
  imports: [CommonModule, FormsModule],
  template: `
    <!-- 桌面端可拖动浮动面板 -->
    @if (!store.isMobile() && store.isFlowDetailOpen()) {
      <div class="absolute z-20 pointer-events-auto"
           [style.right.px]="position().x < 0 ? 0 : null"
           [style.top.px]="position().y < 0 ? 24 : position().y"
           [style.left.px]="position().x >= 0 ? position().x : null">
         <!-- Content Panel -->
         <div class="w-64 max-h-96 bg-white/95 backdrop-blur-xl border border-stone-200/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
             
             <!-- 可拖动标题栏 - 双击重置位置 -->
             <div class="px-3 py-2 border-b border-stone-100 flex justify-between items-center cursor-move select-none bg-gradient-to-r from-stone-50 to-white"
                  (mousedown)="startDrag($event)"
                  (touchstart)="startDrag($event)"
                  (dblclick)="resetPosition()"
                  title="拖动移动面板，双击重置位置">
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

    <!-- 移动端顶部小型标签触发器 -->
    @if (store.isMobile() && !store.isFlowDetailOpen()) {
      <button 
        (click)="store.isFlowDetailOpen.set(true)"
        class="absolute top-2 right-2 z-25 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 px-2 py-1 flex items-center gap-1 text-stone-500 hover:text-stone-700">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-[10px] font-medium">详情</span>
      </button>
    }
    
    <!-- 移动端顶部下拉抽屉面板 -->
    @if (store.isMobile() && store.isFlowDetailOpen()) {
      <div class="absolute left-0 right-0 z-30 bg-white/95 backdrop-blur-xl border-b border-stone-200 shadow-[0_4px_20px_rgba(0,0,0,0.1)] rounded-b-2xl flex flex-col transition-all duration-100"
           [style.top.px]="0"
           [style.height.vh]="drawerHeight()"
           style="transform: translateZ(0); backface-visibility: hidden;">
        <!-- 标题栏 - 左边留出空间避开导航按钮，紧凑布局 -->
        <div class="pr-3 transition-all duration-200 flex justify-between items-center flex-shrink-0"
             [class.pl-28]="drawerHeight() >= 20"
             [class.pl-3]="drawerHeight() < 20"
             [class.pt-1.5]="drawerHeight() >= 20"
             [class.pt-0.5]="drawerHeight() < 20"
             [class.pb-0.5]="drawerHeight() >= 20"
             [class.pb-0]="drawerHeight() < 20">
          @if (drawerHeight() >= 20) {
            <h3 class="font-bold text-stone-700 text-xs">任务详情</h3>
          }
          <button (click)="store.isFlowDetailOpen.set(false)" 
                  class="text-stone-400 hover:text-stone-600 transition-all"
                  [class.p-0.5]="drawerHeight() >= 20"
                  [class.p-0]="drawerHeight() < 20"
                  [class.ml-auto]="drawerHeight() < 20">
            <svg xmlns="http://www.w3.org/2000/svg" 
                 class="transition-all"
                 [class.h-4]="drawerHeight() >= 20"
                 [class.w-4]="drawerHeight() >= 20"
                 [class.h-3]="drawerHeight() < 20"
                 [class.w-3]="drawerHeight() < 20"
                 fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <!-- 内容区域 - 更紧凑 -->
        <div class="flex-1 overflow-y-auto px-3 pb-1 overscroll-contain"
             (touchstart)="onContentTouchStart($event)"
             (touchmove)="onContentTouchMove($event)"
             style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0);">
          @if (task(); as t) {
            <ng-container *ngTemplateOutlet="mobileTaskContent; context: { $implicit: t }"></ng-container>
          } @else {
            <div class="text-center text-stone-400 text-xs py-1">双击节点查看详情</div>
          }
        </div>
        
        <!-- 拖动条 - 紧凑 -->
        <div class="flex justify-center py-1 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
             (touchstart)="startDrawerResize($event)"
             (mousedown)="startDrawerResize($event)">
          <div class="w-10 h-1 bg-stone-300 rounded-full"></div>
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
                <span data-testid="flow-task-status-badge" class="px-1.5 py-0.5 rounded"
                        [class.bg-emerald-100]="task.status === 'completed'"
                        [class.text-emerald-700]="task.status === 'completed'"
                        [class.bg-amber-100]="task.status !== 'completed'"
                        [class.text-amber-700]="task.status !== 'completed'">
                    {{task.status === 'completed' ? '完成' : '进行中'}}
                  </span>
              </div>
              <button 
                  (click)="toggleEditMode()"
                data-testid="flow-edit-toggle-btn"
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
              <div class="cursor-pointer" (click)="toggleEditMode(); $event.stopPropagation()">
                <h4 data-testid="flow-task-title" class="text-xs font-medium text-stone-800 mb-1">{{ task.title || '无标题' }}</h4>
                  @if (task.content) {
                      <div 
                          class="text-[11px] text-stone-600 leading-relaxed markdown-preview bg-retro-muted/5 border border-retro-muted/20 rounded-lg p-2 max-h-32 overflow-y-auto"
                          [innerHTML]="renderMarkdownContent(task.content)">
                      </div>
                  } @else {
                      <div class="text-[11px] text-stone-400 italic">点击编辑内容...</div>
                  }
              </div>
          } @else {
              <!-- 编辑模式 -->
              <input data-testid="flow-task-title-input" type="text" [ngModel]="task.title" (ngModelChange)="titleChange.emit({ taskId: task.id, title: $event })"
                  (mousedown)="isSelecting = true"
                  (mouseup)="isSelecting = false"
                  class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                  placeholder="任务标题">
              
              <textarea [ngModel]="task.content" (ngModelChange)="contentChange.emit({ taskId: task.id, content: $event })" rows="4"
                  (mousedown)="isSelecting = true"
                  (mouseup)="isSelecting = false"
                  class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono leading-relaxed"
                  placeholder="输入内容（支持 Markdown）..."></textarea>
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
                  data-testid="toggle-task-status-btn"
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
                <button data-testid="delete-task-btn" (click)="deleteTask.emit(task)"
                  class="px-2 py-1 bg-stone-50 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 text-[10px] font-medium rounded transition-all">
                  删除
              </button>
          </div>
          
          <!-- 附件管理 - 暂时隐藏 -->
          <!-- @if (store.currentUserId()) {
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
          } -->
      </div>
    </ng-template>
    
    <!-- 移动端任务内容模板 -->
    <ng-template #mobileTaskContent let-task>
      <!-- 紧凑的任务信息头 - 单行布局 -->
      <div class="flex items-center gap-1.5 mb-1 flex-wrap">
        <span class="font-bold text-retro-muted text-[8px] tracking-wider bg-stone-100 px-1.5 py-0.5 rounded">{{store.compressDisplayId(task.displayId)}}</span>
        <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
        <span class="text-[9px] px-1 py-0.5 rounded"
              [class.bg-emerald-100]="task.status === 'completed'"
              [class.text-emerald-700]="task.status === 'completed'"
              [class.bg-amber-100]="task.status !== 'completed'"
              [class.text-amber-700]="task.status !== 'completed'">
          {{task.status === 'completed' ? '完成' : '进行'}}
        </span>
        <!-- 预览/编辑切换按钮 -->
        <button 
          (click)="toggleEditMode()"
          class="ml-auto text-[9px] px-1.5 py-0.5 rounded transition-colors"
          [class.bg-indigo-100]="!isEditMode()"
          [class.text-indigo-600]="!isEditMode()"
          [class.bg-stone-100]="isEditMode()"
          [class.text-stone-500]="isEditMode()">
          {{ isEditMode() ? '预览' : '编辑' }}
        </button>
      </div>
      
      <!-- 预览模式 -->
      @if (!isEditMode()) {
        <div class="cursor-pointer space-y-1" (click)="toggleEditMode(); $event.stopPropagation()">
          <!-- 标题 -->
          <h4 class="text-xs font-medium text-stone-800 leading-tight" [class.line-clamp-1]="isCompactMode()">{{ task.title || '无标题' }}</h4>
          
          <!-- Markdown 预览内容 -->
          @if (task.content) {
            <div class="text-[11px] text-stone-600 leading-relaxed markdown-preview overflow-hidden max-h-28" [innerHTML]="renderMarkdownContent(task.content)"></div>
          }
        </div>
      } @else {
        <!-- 编辑模式 -->
        <div class="space-y-1.5">
          <!-- 标题输入 -->
          <input type="text" [ngModel]="task.title" (ngModelChange)="titleChange.emit({ taskId: task.id, title: $event })"
            (mousedown)="isSelecting = true"
            (mouseup)="isSelecting = false"
            class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
            placeholder="任务标题">
          
          <!-- 内容输入 -->
          <textarea [ngModel]="task.content" (ngModelChange)="contentChange.emit({ taskId: task.id, content: $event })" rows="3"
            (mousedown)="isSelecting = true"
            (mouseup)="isSelecting = false"
            class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono"
            placeholder="任务内容（支持 Markdown）..."></textarea>
          
          <!-- 快速待办输入 -->
          <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5">
            <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1">☐</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(task.id, quickTodoInput)"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[10px] py-0.5 px-1"
              placeholder="待办，回车添加...">
            <button
              (click)="addQuickTodo(task.id, quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-0.5 mr-0.5 transition-all">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      }
      
      <!-- 操作按钮 - 紧凑模式下隐藏 -->
      @if (!isCompactMode()) {
        <div class="flex gap-1 mt-2">
          <button (click)="addSibling.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[9px] font-medium rounded transition-all">
            +同级
          </button>
          <button (click)="addChild.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[9px] font-medium rounded transition-all">
            +下级
          </button>
          <button (click)="toggleStatus.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded border transition-all"
            [class.bg-emerald-50]="task.status !== 'completed'"
            [class.text-emerald-700]="task.status !== 'completed'"
            [class.border-emerald-200]="task.status !== 'completed'"
            [class.bg-stone-50]="task.status === 'completed'"
            [class.text-stone-600]="task.status === 'completed'"
            [class.border-stone-200]="task.status === 'completed'">
            {{task.status === 'completed' ? '撤销' : '完成'}}
          </button>
        </div>
        
        <!-- 第二行：归档和删除 -->
        <div class="flex gap-1 mt-1">
          <button (click)="archiveTask.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded transition-all border"
            [class.bg-violet-50]="task.status !== 'archived'"
            [class.text-violet-600]="task.status !== 'archived'"
            [class.border-violet-200]="task.status !== 'archived'"
            [class.bg-stone-50]="task.status === 'archived'"
            [class.text-stone-600]="task.status === 'archived'"
            [class.border-stone-200]="task.status === 'archived'">
            {{task.status === 'archived' ? '取消归档' : '归档'}}
          </button>
          <button (click)="deleteTask.emit(task)"
            class="px-1.5 py-1 bg-stone-50 text-stone-400 border border-stone-200 text-[9px] font-medium rounded transition-all">
            删除
          </button>
        </div>
      }
      
      <!-- 附件管理（手机端） - 暂时隐藏 -->
      <!-- @if (store.currentUserId()) {
        <app-attachment-manager
          [userId]="store.currentUserId()!"
          [projectId]="store.activeProjectId()!"
          [taskId]="task.id"
          [currentAttachments]="task.attachments"
          [compact]="true"
          (attachmentsChange)="attachmentsChange.emit({ taskId: task.id, attachments: $event })"
          (error)="attachmentError.emit($event)">
        </app-attachment-manager>
      } -->
    </ng-template>
  `
})
export class FlowTaskDetailComponent implements OnDestroy {
  readonly store = inject(StoreService);
  private readonly elementRef = inject(ElementRef);
  
  // 输入
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh 单位
  
  // 编辑模式状态（默认为预览模式）
  readonly isEditMode = signal(false);
  
  // 标记是否正在进行文本选择
  private isSelecting = false;
  
  // 紧凑模式：只有当抽屉高度非常小（< 12vh）时才启用，隐藏操作按钮
  // 日期和状态应该一直显示，除非抽屉几乎完全收起
  readonly isCompactMode = computed(() => this.drawerHeight() < 12);
  
  // 内容预览最大高度：根据抽屉高度动态计算
  readonly contentMaxHeight = computed(() => {
    const height = this.drawerHeight();
    if (height < 15) return 'max-h-8'; // 非常紧凑：只显示一行
    if (height < 25) return 'max-h-16'; // 较小：显示约2行
    if (height < 35) return 'max-h-24'; // 中等：显示约3行
    return 'max-h-28'; // 正常：显示更多
  });
  
  // 位置变更输出
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 任务操作输出
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
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
    const newMode = !this.isEditMode();
    console.log('[FlowTaskDetail] toggleEditMode: 当前模式 =', this.isEditMode(), '→ 新模式 =', newMode);
    this.isEditMode.update(v => !v);
  }
  
  /**
   * 监听 document 点击事件
   * 编辑模式下，点击详情面板内的空白区域（非输入框、非按钮）或面板外部，切换回预览模式
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    // 如果已经是预览模式，无需处理
    if (!this.isEditMode()) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中（用户可能刚完成选择操作）
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    const target = event.target as HTMLElement;
    
    // 检查是否点击了可交互元素（输入框、文本框、任何按钮、SVG图标）
    const isInteractiveElement = target.tagName === 'INPUT' || 
                                  target.tagName === 'TEXTAREA' ||
                                  target.tagName === 'BUTTON' ||
                                  target.tagName === 'svg' ||
                                  target.tagName === 'path' ||
                                  target.closest('input, textarea, button, svg') !== null;
    
    // 如果点击的是可交互元素，不切换模式（让元素正常工作）
    if (isInteractiveElement) {
      console.log('[FlowTaskDetail] 点击可交互元素，保持编辑模式');
      return;
    }
    
    // 检查点击是否在任务详情面板内部
    const clickedInside = this.elementRef.nativeElement.contains(target);
    
    if (clickedInside) {
      // 点击在面板内部但不是可交互元素（例如：标题栏、空白区域），切换到预览模式
      console.log('[FlowTaskDetail] 点击详情面板空白区域，切换到预览模式');
      this.isEditMode.set(false);
    } else {
      // 点击在面板外部，也切换到预览模式
      console.log('[FlowTaskDetail] 点击面板外部，切换到预览模式');
      this.isEditMode.set(false);
    }
  }
  
  /**
   * 监听 document 触摸事件（移动端）
   * 编辑模式下，触摸详情面板内的空白区域（非输入框、非按钮）或面板外部，切换回预览模式
   */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    // 如果已经是预览模式，无需处理
    if (!this.isEditMode()) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    // 检查是否有输入框或文本框正在获得焦点（用户正在输入）
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      console.log('[FlowTaskDetail] 输入框正在使用，保持编辑模式');
      return;
    }
    
    const target = event.target as HTMLElement;
    
    // 检查是否触摸了可交互元素（输入框、文本框、任何按钮、SVG图标）
    const isInteractiveElement = target.tagName === 'INPUT' || 
                                  target.tagName === 'TEXTAREA' ||
                                  target.tagName === 'BUTTON' ||
                                  target.tagName === 'svg' ||
                                  target.tagName === 'path' ||
                                  target.closest('input, textarea, button, svg') !== null;
    
    // 如果触摸的是可交互元素，不切换模式
    if (isInteractiveElement) {
      console.log('[FlowTaskDetail] 触摸可交互元素，保持编辑模式');
      return;
    }
    
    // 检查触摸是否在任务详情面板内部
    const clickedInside = this.elementRef.nativeElement.contains(target);
    
    if (clickedInside) {
      // 触摸在面板内部但不是可交互元素，切换到预览模式
      console.log('[FlowTaskDetail] 触摸详情面板空白区域，切换到预览模式');
      this.isEditMode.set(false);
    } else {
      // 触摸在面板外部，也切换到预览模式
      console.log('[FlowTaskDetail] 触摸面板外部，切换到预览模式');
      this.isEditMode.set(false);
    }
  }
  
  /**
   * 渲染 Markdown 内容
   */
  renderMarkdownContent(content: string): string {
    return renderMarkdown(content);
  }
  
  // 桌面端面板拖动
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const _pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    // 获取面板的实际位置（相对于父容器）
    const target = event.target as HTMLElement;
    const panelEl = target.closest('.absolute') as HTMLElement;
    if (!panelEl) return;
    
    const parentEl = panelEl.parentElement;
    if (!parentEl) return;
    
    const parentRect = parentEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    
    // 计算面板相对于父容器的当前位置
    const currentX = panelRect.left - parentRect.left;
    const currentY = panelRect.top - parentRect.top;
    
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
    
    // 限制面板不能被拖出可视区域
    // 面板宽度 256px，高度最大 384px (max-h-96)
    const panelWidth = 256;
    const panelHeight = 384;
    const maxX = Math.max(0, window.innerWidth - panelWidth - 20); // 留 20px 边距
    const maxY = Math.max(0, window.innerHeight - panelHeight - 20);
    
    const newX = Math.max(0, Math.min(maxX, this.dragState.offsetX + deltaX));
    const newY = Math.max(0, Math.min(maxY, this.dragState.offsetY + deltaY));
    
    this.positionChange.emit({ x: newX, y: newY });
  };
  
  private stopDrag = () => {
    this.dragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.stopDrag);
    document.removeEventListener('touchmove', this.onDrag);
    document.removeEventListener('touchend', this.stopDrag);
  };

  /**
   * 重置面板位置到默认位置（右上角）
   */
  resetPosition() {
    this.positionChange.emit({ x: -1, y: -1 });
  }
  
  // 移动端抽屉高度调整（顶部下拉：向下拖增大，向上拖减小）
  startDrawerResize(event: TouchEvent | MouseEvent) {
    event.preventDefault();
    
    // 获取起始位置
    let startY: number;
    if (event instanceof TouchEvent) {
      if (event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
    } else {
      startY = event.clientY;
    }
    
    this.isResizingDrawer = true;
    this.isResizingChange.emit(true);
    this.drawerStartY = startY;
    this.drawerStartHeight = this.drawerHeight();
    
    const onMove = (ev: TouchEvent | MouseEvent) => {
      if (!this.isResizingDrawer) return;
      ev.preventDefault();
      
      // 获取当前位置
      let currentY: number;
      if (ev instanceof TouchEvent) {
        if (ev.touches.length !== 1) return;
        currentY = ev.touches[0].clientY;
      } else {
        currentY = ev.clientY;
      }
      
      // 顶部抽屉：向下拖（正 deltaY）增大高度
      const deltaY = currentY - this.drawerStartY;
      const deltaVh = (deltaY / window.innerHeight) * 100;
      const newHeight = Math.max(10, Math.min(70, this.drawerStartHeight + deltaVh));
      this.drawerHeightChange.emit(newHeight);
    };
    
    const onEnd = () => {
      this.isResizingDrawer = false;
      this.isResizingChange.emit(false);
      // 移除自动关闭逻辑，允许用户自由调整到最小高度
      // 最小高度由 Math.max(10, ...) 控制
      window.removeEventListener('touchmove', onMove as EventListener);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('mousemove', onMove as EventListener);
      window.removeEventListener('mouseup', onEnd);
    };
    
    window.addEventListener('touchmove', onMove as EventListener, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    window.addEventListener('mousemove', onMove as EventListener);
    window.addEventListener('mouseup', onEnd);
  }
  
  // 内容区域触摸处理 - 防止无限下拉
  onContentTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    // 检查是否是内容区域本身或可滚动的子元素
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    if (scrollableParent) {
      // 记录初始滚动位置
      (scrollableParent as any)._touchStartScrollTop = scrollableParent.scrollTop;
    }
  }

  onContentTouchMove(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    
    if (scrollableParent && !this.isResizingDrawer) {
      const scrollTop = scrollableParent.scrollTop;
      const scrollHeight = scrollableParent.scrollHeight;
      const clientHeight = scrollableParent.clientHeight;
      
      // 获取触摸移动的方向
      const touchStartScrollTop = (scrollableParent as any)._touchStartScrollTop || 0;
      const _touch = event.touches[0];
      
      // 阻止在顶部继续向下拉或在底部继续向上拉
      if ((scrollTop === 0 && scrollTop >= touchStartScrollTop) || 
          (scrollTop + clientHeight >= scrollHeight && scrollTop <= touchStartScrollTop)) {
        // 允许内部滚动，不阻止事件
        return;
      }
      
      // 更新滚动位置记录
      (scrollableParent as any)._touchStartScrollTop = scrollTop;
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
  
  // ========== 生命周期管理 ==========
  
  ngOnDestroy(): void {
    // 确保移除所有拖动相关的事件监听器
    this.stopDrag();
    
    // 重置拖动状态
    this.dragState.isDragging = false;
    this.isResizingDrawer = false;
  }
}
