import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../services/store.service';
import { ToastService } from '../services/toast.service';
import { LoggerService } from '../services/logger.service';
import { Task, Attachment, ThemeType } from '../models';
import { getErrorMessage, isFailure } from '../utils/result';
import { environment } from '../environments/environment';
import { getFlowStyles, FlowStyleConfig } from '../config/flow-styles';
import { 
  FlowToolbarComponent, 
  FlowPaletteComponent, 
  FlowTaskDetailComponent,
  FlowDeleteConfirmComponent,
  FlowLinkTypeDialogComponent,
  FlowConnectionEditorComponent,
  FlowLinkDeleteHintComponent,
  type LinkTypeDialogData,
  type ConnectionEditorData,
  type ConnectionTasks
} from './flow';
import { GOJS_CONFIG, UI_CONFIG } from '../config/constants';
import * as go from 'gojs';

@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule, 
    FlowToolbarComponent, 
    FlowPaletteComponent, 
    FlowTaskDetailComponent,
    FlowDeleteConfirmComponent,
    FlowLinkTypeDialogComponent,
    FlowConnectionEditorComponent,
    FlowLinkDeleteHintComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col h-full bg-[#F9F8F6] relative">
       
       <!-- 顶部调色板区域 -->
       <app-flow-palette
         [height]="paletteHeight()"
         [isDropTargetActive]="isDropTargetActive()"
         (heightChange)="paletteHeight.set($event)"
         (centerOnNode)="centerOnNode($event)"
         (createUnassigned)="createUnassigned()"
         (taskClick)="onUnassignedTaskClick($event)"
         (taskDragStart)="onDragStart($event.event, $event.task)"
         (taskDrop)="onUnassignedDrop($event.event)"
         (taskTouchStart)="onUnassignedTouchStart($event.event, $event.task)"
         (taskTouchMove)="onUnassignedTouchMove($event.event)"
         (taskTouchEnd)="onUnassignedTouchEnd($event.event)">
       </app-flow-palette>

       <!-- 3. 流程图区域 -->
       <div class="flex-1 relative overflow-hidden bg-[#F9F8F6] mt-0 mx-0 border-t border-stone-200/50">
           <!-- GoJS Diagram Div - flow-canvas-container 类用于禁用浏览器默认触摸手势 -->
           <div #diagramDiv class="absolute inset-0 w-full h-full z-0 flow-canvas-container"></div>

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

           <!-- 工具栏 -->
           <app-flow-toolbar
             [isLinkMode]="isLinkMode()"
             [linkSourceTask]="linkSourceTask()"
             [isResizingDrawer]="isResizingDrawerSignal()"
             [drawerHeightVh]="drawerHeight()"
             (zoomIn)="zoomIn()"
             (zoomOut)="zoomOut()"
             (autoLayout)="applyAutoLayout()"
             (toggleLinkMode)="toggleLinkMode()"
             (cancelLinkMode)="cancelLinkMode()">
           </app-flow-toolbar>

           <!-- 任务详情面板 -->
           <app-flow-task-detail
             [task]="selectedTask()"
             [position]="taskDetailPos()"
             [drawerHeight]="drawerHeight()"
             (positionChange)="taskDetailPos.set($event)"
             (drawerHeightChange)="drawerHeight.set($event)"
             (isResizingChange)="isResizingDrawerSignal.set($event)"
             (titleChange)="updateTaskTitle($event.taskId, $event.title)"
             (contentChange)="updateTaskContent($event.taskId, $event.content)"
             (priorityChange)="updateTaskPriority($event.taskId, $event.priority)"
             (dueDateChange)="updateTaskDueDate($event.taskId, $event.dueDate)"
             (tagAdd)="addTaskTag($event.taskId, $event.tag)"
             (tagRemove)="removeTaskTag($event.taskId, $event.tag)"
             (addSibling)="addSiblingTask($event)"
             (addChild)="addChildTask($event)"
             (toggleStatus)="toggleTaskStatus($event)"
             (archiveTask)="archiveTask($event)"
             (deleteTask)="deleteTask($event)"
             (quickTodoAdd)="addQuickTodo($event.taskId, $event.text)"
             (attachmentAdd)="onAttachmentAdd($event.taskId, $event.attachment)"
             (attachmentRemove)="onAttachmentRemove($event.taskId, $event.attachmentId)"
             (attachmentsChange)="onAttachmentsChange($event.taskId, $event.attachments)"
             (attachmentError)="onAttachmentError($event)">
           </app-flow-task-detail>
       </div>
       
       <!-- 删除确认弹窗 -->
       <app-flow-delete-confirm
         [task]="deleteConfirmTask()"
         [keepChildren]="deleteKeepChildren()"
         [hasChildren]="deleteConfirmTask() ? hasChildren(deleteConfirmTask()!) : false"
         [isMobile]="store.isMobile()"
         (cancel)="deleteConfirmTask.set(null); deleteKeepChildren.set(false)"
         (confirm)="confirmDelete()"
         (keepChildrenChange)="deleteKeepChildren.set($event)">
       </app-flow-delete-confirm>
       
       <!-- 移动端连接线删除提示 -->
       @if (store.isMobile()) {
         <app-flow-link-delete-hint
           [hint]="linkDeleteHint()"
           (confirm)="confirmLinkDelete()"
           (cancel)="cancelLinkDelete()">
         </app-flow-link-delete-hint>
       }
       
       <!-- 联系块内联编辑器 - 浮动在连接线附近，可拖动 -->
       <app-flow-connection-editor
         [data]="connectionEditorData()"
         [position]="connectionEditorPos()"
         [connectionTasks]="getConnectionTasks()"
         (close)="closeConnectionEditor()"
         (save)="saveConnectionDescription($event)"
         (dragStart)="startDragConnEditor($event)">
       </app-flow-connection-editor>
       
       <!-- 连接类型选择对话框 -->
       <app-flow-link-type-dialog
         [data]="linkTypeDialog()"
         (cancel)="cancelLinkCreate()"
         (parentChildLink)="confirmParentChildLink()"
         (crossTreeLink)="confirmCrossTreeLink()">
       </app-flow-link-type-dialog>
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @Output() goBackToText = new EventEmitter<void>();
  
  store = inject(StoreService);
  private toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  
  // 暴露 window 给模板使用
  readonly window = typeof window !== 'undefined' ? window : { innerHeight: GOJS_CONFIG.SSR_DEFAULT_HEIGHT };
  
  private diagram: any;
  private resizeObserver: ResizeObserver | null = null;
  
  // 选中的任务ID
  selectedTaskId = signal<string | null>(null);
  
  // 删除确认状态
  deleteConfirmTask = signal<Task | null>(null);
  deleteKeepChildren = signal(false); // 是否保留子任务
  
  // 连接模式状态
  isLinkMode = signal(false);
  linkSourceTask = signal<Task | null>(null);
  
  // 移动端连接线删除提示
  linkDeleteHint = signal<{ link: any; x: number; y: number } | null>(null);
  
  // 联系块编辑器状态 - 包含位置信息用于内联显示
  connectionEditorData = signal<{ sourceId: string; targetId: string; description: string; x: number; y: number } | null>(null);
  // 联系块编辑器拖动位置（独立 signal 以便拖动时实时更新）
  connectionEditorPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private connEditorDragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  
  // 任务详情面板拖动位置（桐端）
  taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 }); // -1 表示使用默认位置
  private taskDetailDragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  
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
  isResizingDrawerSignal = signal(false); // 用于模板绑定，拖动时禁用按钮过渡动画
  
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
  
  // 从流程图拖回待分配区域的状态
  isDropTargetActive = signal(false);
  private draggingFromDiagram = signal<string | null>(null);
  
  // 性能优化：位置保存防抖定时器
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // 连接类型选择对话框状态
  linkTypeDialog = signal<{
    show: boolean;
    sourceId: string;
    targetId: string;
    sourceTask: Task | null;
    targetTask: Task | null;
    x: number;
    y: number;
  } | null>(null);

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
  
  // 打开联系块编辑器 - 在点击位置附近显示
  openConnectionEditor(sourceId: string, targetId: string, description: string, x: number, y: number) {
    // 调整位置，稍微向左和上偏移以便编辑框出现在点击位置旁边
    const adjustedX = Math.max(10, x - 100);
    const adjustedY = Math.max(10, y - 20);
    this.connectionEditorData.set({ sourceId, targetId, description, x: adjustedX, y: adjustedY });
    this.connectionEditorPos.set({ x: adjustedX, y: adjustedY });
    
    // 编辑器打开后自动调整 textarea 高度
    setTimeout(() => {
      const textarea = document.querySelector('#connectionDescTextarea') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
      }
    }, UI_CONFIG.SHORT_DELAY);
  }
  
  // 开始拖动联系块编辑器
  startDragConnEditor(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = this.connectionEditorPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    this.connEditorDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: pos.x,
      offsetY: pos.y
    };
    
    // 添加全局事件监听
    document.addEventListener('mousemove', this.onDragConnEditor);
    document.addEventListener('mouseup', this.stopDragConnEditor);
    document.addEventListener('touchmove', this.onDragConnEditor);
    document.addEventListener('touchend', this.stopDragConnEditor);
  }
  
  // 拖动中
  private onDragConnEditor = (event: MouseEvent | TouchEvent) => {
    if (!this.connEditorDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.connEditorDragState.startX;
    const deltaY = clientY - this.connEditorDragState.startY;
    
    const newX = Math.max(0, this.connEditorDragState.offsetX + deltaX);
    const newY = Math.max(0, this.connEditorDragState.offsetY + deltaY);
    
    this.zone.run(() => {
      this.connectionEditorPos.set({ x: newX, y: newY });
    });
  };
  
  // 停止拖动
  private stopDragConnEditor = () => {
    this.connEditorDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  };
  
  // 开始拖动任务详情面板
  startDragTaskDetail(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = this.taskDetailPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    // 如果是默认位置，计算当前实际位置
    const diagramDiv = this.diagram?.div;
    let currentX = pos.x;
    let currentY = pos.y;
    if (pos.x < 0 && diagramDiv) {
      const rect = diagramDiv.getBoundingClientRect();
      currentX = rect.width - GOJS_CONFIG.DETAIL_PANEL_WIDTH - GOJS_CONFIG.DETAIL_PANEL_RIGHT_MARGIN;
      currentY = 24;
    }
    
    this.taskDetailDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: currentX,
      offsetY: currentY
    };
    
    document.addEventListener('mousemove', this.onDragTaskDetail);
    document.addEventListener('mouseup', this.stopDragTaskDetail);
    document.addEventListener('touchmove', this.onDragTaskDetail);
    document.addEventListener('touchend', this.stopDragTaskDetail);
  }
  
  // 拖动任务详情面板中
  private onDragTaskDetail = (event: MouseEvent | TouchEvent) => {
    if (!this.taskDetailDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.taskDetailDragState.startX;
    const deltaY = clientY - this.taskDetailDragState.startY;
    
    const newX = Math.max(0, this.taskDetailDragState.offsetX + deltaX);
    const newY = Math.max(0, this.taskDetailDragState.offsetY + deltaY);
    
    this.zone.run(() => {
      this.taskDetailPos.set({ x: newX, y: newY });
    });
  };
  
  // 停止拖动任务详情面板
  private stopDragTaskDetail = () => {
    this.taskDetailDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragTaskDetail);
    document.removeEventListener('mouseup', this.stopDragTaskDetail);
    document.removeEventListener('touchmove', this.onDragTaskDetail);
    document.removeEventListener('touchend', this.stopDragTaskDetail);
  };
  
  // 关闭联系块编辑器
  closeConnectionEditor() {
    this.connectionEditorData.set(null);
  }
  
  // 保存联系块描述
  saveConnectionDescription(description: string) {
    const data = this.connectionEditorData();
    if (data) {
      this.store.updateConnectionDescription(data.sourceId, data.targetId, description);
      this.closeConnectionEditor();
      // 刷新图表以显示新描述
      setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
  }
  
  // 自动调整 textarea 高度
  autoResizeTextarea(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
  }
  
  // 获取连接的源任务和目标任务
  getConnectionTasks(): { source: Task | null; target: Task | null } {
    const data = this.connectionEditorData();
    if (!data) return { source: null, target: null };
    const tasks = this.store.tasks();
    return {
      source: tasks.find(t => t.id === data.sourceId) || null,
      target: tasks.find(t => t.id === data.targetId) || null
    };
  }

  constructor() {
      // 监听任务数据变化，更新图表
      effect(() => {
          const tasks = this.store.tasks();
          if (this.diagram) {
              this.updateDiagram(tasks);
          }
      });
      
      // 监听搜索查询变化，更新图表高亮
      effect(() => {
          const query = this.store.searchQuery();
          // 当搜索词变化时强制刷新图表以更新高亮状态
          if (this.diagram) {
              this.updateDiagram(this.store.tasks(), true);
          }
      });
      
      // 监听主题变化，更新图表节点颜色
      effect(() => {
          const theme = this.store.theme();
          // 当主题变化时强制刷新图表以更新节点颜色
          if (this.diagram) {
              this.updateDiagram(this.store.tasks(), true);
          }
      });
      
      // 跨视图选中状态同步：监听外部选中任务的变化
      effect(() => {
          const selectedId = this.selectedTaskId();
          if (selectedId && this.diagram) {
              const node = this.diagram.findNodeForKey(selectedId);
              if (node && !node.isSelected) {
                  // 自动定位到选中的节点（不打开详情面板）
                  this.diagram.select(node);
                  // 如果节点不在视图中，滚动到节点位置
                  if (!this.diagram.viewportBounds.containsRect(node.actualBounds)) {
                      this.diagram.centerRect(node.actualBounds);
                  }
              }
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
          layerSpacing: GOJS_CONFIG.LAYER_SPACING,
          columnSpacing: GOJS_CONFIG.COLUMN_SPACING,
          setsPortSpots: false
      });
      this.diagram.layoutDiagram(true);
      
      // 布局完成后保存所有位置并恢复为无操作布局
      setTimeout(() => {
          this.saveAllNodePositions();
          this.diagram.layout = $(go.Layout); // 恢复无操作布局
          this.diagram.commitTransaction('auto-layout');
      }, UI_CONFIG.SHORT_DELAY);
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
  addQuickTodo(taskId: string, text: string) {
      if (!text?.trim()) return;
      this.store.addTodoItem(taskId, text.trim());
  }

  // 添加同级任务
  addSiblingTask(task: Task) {
      const result = this.store.addTask('', '', task.stage, task.parentId, true);
      if (isFailure(result)) {
          this.toast.error('添加任务失败', getErrorMessage(result.error));
      } else {
          this.selectedTaskId.set(result.value);
          // 延迟聚焦到标题输入框
          setTimeout(() => {
              this.focusTitleInput();
          }, UI_CONFIG.INPUT_FOCUS_DELAY);
      }
  }

  // 添加子任务
  addChildTask(task: Task) {
      const nextStage = (task.stage || 0) + 1;
      const result = this.store.addTask('', '', nextStage, task.id, false);
      if (isFailure(result)) {
          this.toast.error('添加任务失败', getErrorMessage(result.error));
      } else {
          this.selectedTaskId.set(result.value);
          // 延迟聚焦到标题输入框
          setTimeout(() => {
              this.focusTitleInput();
          }, UI_CONFIG.INPUT_FOCUS_DELAY);
      }
  }
  
  // 聚焦到当前选中任务的标题输入框
  private focusTitleInput() {
      const panel = this.elementRef.nativeElement.querySelector('.detail-panel-content, .mobile-drawer-content');
      if (panel) {
          const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
          if (input) {
              input.focus();
              input.select();
          }
      }
  }

  // 切换任务状态
  toggleTaskStatus(task: Task) {
      const newStatus = task.status === 'completed' ? 'active' : 'completed';
      this.store.updateTaskStatus(task.id, newStatus);
  }

  // 归档/取消归档任务
  archiveTask(task: Task) {
      const newStatus = task.status === 'archived' ? 'active' : 'archived';
      this.store.updateTaskStatus(task.id, newStatus);
      // 归档后从视图中隐藏，取消选中
      if (newStatus === 'archived') {
          this.selectedTaskId.set(null);
      }
  }

  // 删除任务
  deleteTask(task: Task) {
      this.deleteConfirmTask.set(task);
  }

  confirmDelete() {
      const task = this.deleteConfirmTask();
      if (task) {
          this.selectedTaskId.set(null);
          
          // 根据选项决定是否保留子任务
          if (this.deleteKeepChildren()) {
              this.store.deleteTaskKeepChildren(task.id);
          } else {
              this.store.deleteTask(task.id);
          }
          
          this.deleteConfirmTask.set(null);
          this.deleteKeepChildren.set(false);
      }
  }
  
  // 检查任务是否有子任务
  hasChildren(task: Task): boolean {
      return this.store.tasks().some(t => t.parentId === task.id);
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
      this.isResizingDrawerSignal.set(true); // 开始拖动，禁用按钮过渡
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
          this.isResizingDrawerSignal.set(false); // 结束拖动，恢复按钮过渡
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
  // 改进：使用 passive: false 确保可以阻止默认行为，避免与 GoJS 画布滚动冲突
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
    
    // 长按 250ms 后开始拖拽（增加延迟避免误触）
    this.unassignedTouchState.longPressTimer = setTimeout(() => {
      this.unassignedTouchState.isDragging = true;
      this.unassignedDraggingId.set(task.id);
      this.createUnassignedGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, UI_CONFIG.MOBILE_LONG_PRESS_DELAY);
  }
  
  onUnassignedTouchMove(e: TouchEvent) {
    if (!this.unassignedTouchState.task || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - this.unassignedTouchState.startX);
    const deltaY = Math.abs(touch.clientY - this.unassignedTouchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按（允许页面滚动）
    if (!this.unassignedTouchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.unassignedTouchState.longPressTimer) {
        clearTimeout(this.unassignedTouchState.longPressTimer);
        this.unassignedTouchState.longPressTimer = null;
      }
      // 不阻止事件，让页面正常滚动
      return;
    }
    
    if (this.unassignedTouchState.isDragging) {
      // 只有在拖拽状态才阻止默认行为
      e.preventDefault();
      e.stopPropagation();
      
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
        
        // 查找插入位置（包括连接线上的插入）
        const insertInfo = this.findInsertPosition(loc);
        
        // 新增：处理拖放到连接线上的情况
        if (insertInfo.insertOnLink) {
          const { sourceId, targetId } = insertInfo.insertOnLink;
          this.insertTaskBetweenNodes(task.id, sourceId, targetId, loc);
        } else if (insertInfo.parentId) {
          const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
          if (parentTask) {
            const newStage = (parentTask.stage || 1) + 1;
            this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), UI_CONFIG.MEDIUM_DELAY);
          }
        } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
          const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
          if (refTask?.stage) {
            this.store.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), UI_CONFIG.MEDIUM_DELAY);
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
      }, UI_CONFIG.MEDIUM_DELAY);
      
      // 监听容器大小变化（侧边栏拖动时触发）
      this.setupResizeObserver();
  }
  
  ngOnDestroy() {
      // === 清理顺序很重要 ===
      // 1. 首先清理定时器，防止在组件销毁后执行回调
      // 2. 然后清理事件监听器，防止内存泄漏
      // 3. 最后清理 diagram 实例
      
      // 1. 清理所有定时器
      if (this.positionSaveTimer) {
          clearTimeout(this.positionSaveTimer);
          this.positionSaveTimer = null;
      }
      if (this.resizeDebounceTimer) {
          clearTimeout(this.resizeDebounceTimer);
          this.resizeDebounceTimer = null;
      }
      if (this.viewStateSaveTimer) {
          clearTimeout(this.viewStateSaveTimer);
          this.viewStateSaveTimer = null;
      }
      if (this.unassignedTouchState.longPressTimer) {
          clearTimeout(this.unassignedTouchState.longPressTimer);
      }
      
      // 2. 清理全局事件监听器
      document.removeEventListener('mousemove', this.onDragConnEditor);
      document.removeEventListener('mouseup', this.stopDragConnEditor);
      document.removeEventListener('touchmove', this.onDragConnEditor);
      document.removeEventListener('touchend', this.stopDragConnEditor);
      document.removeEventListener('mousemove', this.onDragTaskDetail);
      document.removeEventListener('mouseup', this.stopDragTaskDetail);
      document.removeEventListener('touchmove', this.onDragTaskDetail);
      document.removeEventListener('touchend', this.stopDragTaskDetail);
      
      // 3. 清理 ResizeObserver
      if (this.resizeObserver) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
      }
      
      // 4. 清理幽灵元素
      if (this.unassignedTouchState.ghost) {
          this.unassignedTouchState.ghost.remove();
      }
      
      // 5. 最后清理 GoJS diagram 实例
      if (this.diagram) {
          this.diagram.div = null;
          this.diagram.clear();
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
          }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
      });
      
      this.resizeObserver.observe(this.diagramDiv.nativeElement);
  }
  
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // 流程图初始化错误状态
  readonly diagramError = signal<string | null>(null);
  
  initDiagram() {
      if (typeof go === 'undefined') {
          this.handleDiagramError('GoJS 库未加载', 'GoJS library not loaded');
          return;
      }
      
      try {
          // 注入 GoJS License Key（如果配置了）
          if (environment.gojsLicenseKey) {
              (go.Diagram as any).licenseKey = environment.gojsLicenseKey;
          }
          
          const $ = go.GraphObject.make;

          this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          // 禁用 GoJS 内置的 UndoManager，避免与 Store 状态分裂
          // 撤销/重做应通过全局状态管理实现
          "undoManager.isEnabled": false,
          "animationManager.isEnabled": false, // 禁用动画提升性能
          "allowDrop": true,
          // 默认不使用自动布局，保持用户手动调整的位置
          layout: $(go.Layout),
          
          // === 性能优化配置 ===
          "autoScale": go.Diagram.None,
          "initialAutoScale": go.Diagram.None,
          "scrollMargin": GOJS_CONFIG.SCROLL_MARGIN,
          "draggingTool.isGridSnapEnabled": false
      });
      
      // 监听节点移动完成（拖动结束时才保存，而非实时保存）
      this.diagram.addDiagramListener('SelectionMoved', (e: any) => {
          // 捕获当前项目 ID，用于验证防抖回调执行时项目是否已切换
          const projectIdAtMove = this.store.activeProjectId();
          
          // 使用防抖，避免多选拖动时频繁保存
          if (this.positionSaveTimer) {
              clearTimeout(this.positionSaveTimer);
          }
          this.positionSaveTimer = setTimeout(() => {
              // 验证项目是否已切换，避免将旧项目的位置保存到新项目
              if (this.store.activeProjectId() !== projectIdAtMove) {
                  return;
              }
              
              e.subject.each((part: any) => {
                  if (part instanceof go.Node) {
                      const loc = part.location;
                      const nodeData = part.data;
                      
                      this.zone.run(() => {
                          // === 新增：检测待分配节点是否拖到了连接线上 ===
                          if (nodeData?.isUnassigned || nodeData?.stage === null) {
                              const insertInfo = this.findInsertPosition(loc);
                              
                              if (insertInfo.insertOnLink) {
                                  // 拖到了连接线上，执行插入操作
                                  const { sourceId, targetId } = insertInfo.insertOnLink;
                                  this.logger.info('待分配节点拖到连接线上', { 
                                      taskId: nodeData.key, 
                                      sourceId, 
                                      targetId 
                                  });
                                  this.insertTaskBetweenNodes(nodeData.key, sourceId, targetId, loc);
                                  return; // 插入操作会更新位置，不需要再单独保存
                              }
                          }
                          
                          // 使用带 Rank 同步的位置更新，保持文本视图和流程图排序一致
                          this.store.updateTaskPositionWithRankSync(part.data.key, loc.x, loc.y);
                      });
                  }
              });
          }, GOJS_CONFIG.POSITION_SAVE_DEBOUNCE);
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
                new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
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
                  // 使用节点数据中传递的颜色
                  new go.Binding("stroke", "", (data: any, obj: any) => {
                      if (obj.part.isSelected) return data.selectedBorderColor || "#0d9488";
                      return data.borderColor || "#e7e5e4";
                  }).ofObject(),
                  new go.Binding("strokeWidth", "borderWidth")
                ),
                $(go.Panel, "Vertical",
                    new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
                    $(go.TextBlock, { font: "bold 9px sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
                        new go.Binding("text", "displayId"),
                        new go.Binding("stroke", "displayIdColor"),
                        new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
                    $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px sans-serif", stroke: "#57534e" },
                        new go.Binding("text", "title"),
                        new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? "500 11px sans-serif" : "400 12px sans-serif"),
                        new go.Binding("stroke", "titleColor"),
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
            ),
            // 联系块 - 只在跨树连接（虚线）上显示，紧凑设计
            $(go.Panel, "Auto",
              { 
                segmentIndex: NaN,  // 自动居中于连接线
                segmentFraction: 0.5,
                cursor: "pointer",
                click: (e: any, panel: any) => {
                  // 阻止事件冒泡，避免选中连接线
                  e.handled = true;
                  const linkData = panel.part?.data;
                  if (linkData?.isCrossTree) {
                    // 获取点击位置相对于流程图容器
                    const diagramDiv = this.diagram?.div;
                    if (diagramDiv) {
                      const rect = diagramDiv.getBoundingClientRect();
                      const clickX = e.event.pageX - rect.left;
                      const clickY = e.event.pageY - rect.top;
                      this.zone.run(() => {
                        this.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', clickX, clickY);
                      });
                    }
                  }
                }
              },
              new go.Binding("visible", "isCrossTree", (isCross: boolean) => isCross),
              // 联系块背景 - 更小更紧凑
              $(go.Shape, "RoundedRectangle", 
                { 
                  fill: "#f5f3ff", // violet-50
                  stroke: "#8b5cf6", // violet-500
                  strokeWidth: 1,
                  parameter1: 4
                }
              ),
              // 联系块内容 - 紧凑布局
              $(go.Panel, "Horizontal",
                { margin: 3, defaultAlignment: go.Spot.Center },
                // 联系图标
                $(go.TextBlock, "🔗", { font: "8px sans-serif" }),
                // 描述文本（如果有）- 只显示简短文本
                $(go.TextBlock, 
                  { 
                    font: "500 8px sans-serif", 
                    stroke: "#6d28d9", // violet-700
                    maxSize: new go.Size(50, 14),
                    overflow: go.TextBlock.OverflowEllipsis,
                    margin: new go.Margin(0, 0, 0, 2)
                  },
                  new go.Binding("text", "description", (desc: string) => desc ? desc.substring(0, 6) : "...")
                )
              )
            )
          );
      
      // 移动端: 连接线长按删除
      if (this.store.isMobile()) {
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
              
              // 查找拖放位置附近的节点或连接线，判断是否插入到两个节点之间
              const insertInfo = this.findInsertPosition(loc);
              
              // 新增：处理拖放到连接线上的情况（插入到两个节点之间）
              if (insertInfo.insertOnLink) {
                  const { sourceId, targetId } = insertInfo.insertOnLink;
                  this.insertTaskBetweenNodes(task.id, sourceId, targetId, loc);
              } else if (insertInfo.parentId) {
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
              this.logger.error('Drop error:', err);
          }
      });

      this.diagram.addDiagramListener('LinkDrawn', (e: any) => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', (e: any) => this.handleLinkGesture(e));
      
      // 点击背景时关闭联系块编辑器
      this.diagram.addDiagramListener('BackgroundSingleClicked', () => {
        this.zone.run(() => {
          this.closeConnectionEditor();
        });
      });
      
      // 监听视口变化，保存视图状态
      this.diagram.addDiagramListener('ViewportBoundsChanged', (e: any) => {
        this.saveViewState();
      });
      
      // 恢复之前保存的视图状态
      this.restoreViewState();
          
          // 清除错误状态
          this.diagramError.set(null);
      } catch (error) {
          this.handleDiagramError('流程图初始化失败', error);
      }
  }
  
  /**
   * 处理流程图错误
   * 提供降级方案和用户提示
   */
  private handleDiagramError(userMessage: string, error: unknown): void {
      const errorStr = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
      this.diagramError.set(userMessage);
      this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }
  
  /**
   * 保存视图状态（防抖）
   */
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  private saveViewState() {
    if (!this.diagram) return;
    
    // 防抖，避免频繁保存
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }
    
    this.viewStateSaveTimer = setTimeout(() => {
      const projectId = this.store.activeProjectId();
      if (!projectId) return;
      
      const scale = this.diagram.scale;
      const pos = this.diagram.position;
      
      this.store.updateViewState(projectId, {
        scale,
        positionX: pos.x,
        positionY: pos.y
      });
      
      this.viewStateSaveTimer = null;
    }, 1000); // 1 秒防抖
  }
  
  /**
   * 恢复视图状态
   */
  private restoreViewState() {
    if (!this.diagram) return;
    
    const viewState = this.store.getViewState();
    if (!viewState) return;
    
    // 延迟恢复，确保图表已完全加载
    setTimeout(() => {
      if (this.diagram) {
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      }
    }, 200);
  }
  
  // 根据拖放位置查找插入点
  // 支持插入到连接线上（两个节点之间）
  private findInsertPosition(loc: any): { 
    parentId?: string; 
    beforeTaskId?: string; 
    afterTaskId?: string;
    // 新增：插入到连接线上的信息
    insertOnLink?: {
      sourceId: string;  // 原父节点
      targetId: string;  // 原子节点
    };
  } {
      if (!this.diagram) return {};
      
      const threshold = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD; // 检测范围（像素）
      
      // === 新增：优先检测是否拖放到连接线上 ===
      const linkInsertInfo = this.findLinkAtPosition(loc);
      if (linkInsertInfo) {
        this.logger.info('拖放位置匹配连接线', linkInsertInfo);
        return { insertOnLink: linkInsertInfo };
      }
      
      // === 原有逻辑：检测节点附近 ===
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

  /**
   * 检测指定位置是否靠近某条父子连接线
   * 如果是，返回该连接线的源（父）和目标（子）节点ID
   */
  private findLinkAtPosition(loc: any): { sourceId: string; targetId: string } | null {
    if (!this.diagram) return null;
    
    const linkThreshold = 50; // 连接线捕获距离（像素）- 增大以提高易用性
    let closestLink: any = null;
    let closestDistance = Infinity;
    
    // 统计连接线数量用于调试
    let linkCount = 0;
    let parentChildLinkCount = 0;
    
    // 遍历所有连接线
    this.diagram.links.each((link: any) => {
      linkCount++;
      
      // 只处理父子连接线（非跨树连接）
      if (link.data?.isCrossTree) return;
      
      parentChildLinkCount++;
      
      // 确保连接线有有效数据
      if (!link.data?.from || !link.data?.to) return;
      
      // 计算点到连接线的距离
      const distance = this.pointToLinkDistance(loc, link);
      
      if (distance < linkThreshold && distance < closestDistance) {
        closestDistance = distance;
        closestLink = link;
      }
    });
    
    // 调试日志
    if (parentChildLinkCount > 0) {
      this.logger.debug('连接线检测', { 
        总连接线数: linkCount,
        父子连接线数: parentChildLinkCount,
        最近距离: closestDistance,
        阈值: linkThreshold,
        是否找到: !!closestLink
      });
    }
    
    if (closestLink && closestLink.data) {
      this.logger.info('检测到靠近连接线', { 
        from: closestLink.data.from, 
        to: closestLink.data.to,
        distance: closestDistance 
      });
      return {
        sourceId: closestLink.data.from,
        targetId: closestLink.data.to
      };
    }
    
    return null;
  }

  /**
   * 计算点到连接线的最近距离
   * 使用连接线的多个采样点进行计算，提高精确度
   */
  private pointToLinkDistance(point: any, link: go.Link): number {
    // 尝试使用连接线的实际路径几何
    const geo = link.path?.geometry;
    if (geo) {
      // 获取连接线路径的边界
      const bounds = geo.bounds;
      if (bounds) {
        // 检查点是否在边界附近
        const expandedBounds = bounds.copy().inflate(30, 30);
        if (!expandedBounds.containsPoint(new go.Point(point.x - (link.location?.x || 0), point.y - (link.location?.y || 0)))) {
          return Infinity; // 点不在连接线附近，直接返回无穷大
        }
      }
    }
    
    // 获取连接线的起点和终点
    const fromNode = link.fromNode;
    const toNode = link.toNode;
    if (!fromNode || !toNode) return Infinity;
    
    const startPoint = fromNode.location;
    const endPoint = toNode.location;
    
    if (!startPoint || !endPoint) return Infinity;
    
    // 使用点到线段的距离公式
    const distance = this.pointToSegmentDistance(
      point.x, point.y,
      startPoint.x, startPoint.y,
      endPoint.x, endPoint.y
    );
    
    return distance;
  }

  /**
   * 计算点到线段的最短距离
   */
  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    
    if (lengthSquared === 0) {
      // 线段长度为0，返回点到点的距离
      return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    }
    
    // 计算投影点在线段上的位置参数 t
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    
    // 限制 t 在 [0, 1] 范围内（投影点在线段上）
    t = Math.max(0, Math.min(1, t));
    
    // 计算投影点坐标
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    
    // 返回点到投影点的距离
    return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
  }

  /**
   * 将任务插入到两个节点之间（连接线上）
   * 
   * 操作步骤：
   * 1. 将原子节点(target)的父级改为新任务
   * 2. 将新任务的父级设为原父节点(source)
   * 3. 阶段(stage)和 displayId 会由 layoutService 自动级联更新
   * 
   * @param taskId 要插入的任务ID（待分配任务）
   * @param sourceId 原父节点ID
   * @param targetId 原子节点ID
   * @param loc 拖放位置
   */
  private insertTaskBetweenNodes(taskId: string, sourceId: string, targetId: string, loc: any): void {
    const sourceTask = this.store.tasks().find(t => t.id === sourceId);
    const targetTask = this.store.tasks().find(t => t.id === targetId);
    
    if (!sourceTask || !targetTask) {
      this.logger.warn('insertTaskBetweenNodes: 找不到源或目标任务', { sourceId, targetId });
      return;
    }
    
    // 确保 source 是 target 的直接父节点（父子关系）
    if (targetTask.parentId !== sourceId) {
      this.logger.warn('insertTaskBetweenNodes: 目标任务的父节点不是源节点', { 
        targetParentId: targetTask.parentId, 
        sourceId 
      });
      return;
    }
    
    // 计算新任务的阶段：应该在 source 和 target 之间
    // 如果 source.stage = N, target.stage = N+1, 新任务也应该是 N+1
    // 然后 target 及其子树的 stage 都需要 +1
    const newTaskStage = (sourceTask.stage || 1) + 1;
    
    this.logger.info('插入任务到连接线', { 
      taskId, 
      sourceId, 
      targetId, 
      newTaskStage 
    });
    
    // 使用 store 的方法完成插入
    // 这是一个复合操作，需要调用专门的方法
    this.store.insertTaskBetween(taskId, sourceId, targetId);
    
    // 更新拖放位置
    setTimeout(() => {
      this.store.updateTaskPosition(taskId, loc.x, loc.y);
    }, 100);
    
    this.toast.success('任务已插入', '任务已插入到两个节点之间');
  }

  updateDiagram(tasks: Task[], forceRefresh: boolean = false) {
      // 如果有错误状态，不执行更新
      if (this.diagramError()) {
          return;
      }
      
      if (!this.diagram) {
          // 不是错误，可能是初始化中
          return;
      }
      
      const model = this.diagram.model;
      if (!model) {
          return;
      }
      
      const project = this.store.activeProject();
      if (!project) {
          return;
      }
      
      try {
      
      // 检查更新类型：如果是仅位置更新，跳过重建（除非强制刷新）
      const lastUpdateType = this.store.getLastUpdateType();
      if (lastUpdateType === 'position' && !forceRefresh) {
          // 位置更新已由 SelectionMoved 监听器处理，不需要重建
          return;
      }
      
      // 获取所有任务（包括待分配的），只要任务有位置信息或 stage 就显示
      // 待分配任务如果被拖入流程图（有位置信息）也会显示
      // stage 可能是 null 或 undefined，都要处理
      // 排除已归档的任务（archived 状态的任务不显示在主视图中）
      const tasksToShow = tasks.filter(t => 
        t.status !== 'archived' && (t.stage != null || (t.x !== 0 || t.y !== 0))
      );
      
      // 保存当前选中状态
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: any) => {
          if (part.data?.key) {
              selectedKeys.add(part.data.key);
          }
      });
      
      // Build a map of existing node data to detect actual changes
      const existingNodeMap = new Map<string, any>();
      (model as any).nodeDataArray.forEach((n: any) => {
          if (n.key) {
              existingNodeMap.set(n.key, n);
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
          const existingNode = existingNodeMap.get(t.id);
          let loc: string;
          
          if (existingNode?.loc) {
              // 优先保持现有位置（用户拖动后的位置）
              loc = existingNode.loc;
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
          
          // 检查是否匹配搜索
          const searchQuery = this.store.searchQuery().toLowerCase().trim();
          const isSearchMatch = searchQuery && (
            t.title.toLowerCase().includes(searchQuery) ||
            t.content.toLowerCase().includes(searchQuery) ||
            t.displayId.toLowerCase().includes(searchQuery) ||
            // 搜索附件名称
            (t.attachments?.some(a => a.name.toLowerCase().includes(searchQuery)) ?? false) ||
            // 搜索标签
            (t.tags?.some(tag => tag.toLowerCase().includes(searchQuery)) ?? false)
          );
          
          // 使用主题配置获取颜色
          const styles = getFlowStyles(this.store.theme() as any);
          let nodeColor: string;
          let borderColor: string;
          let borderWidth: number;
          let titleColor: string;
          
          if (isSearchMatch) {
              // 搜索匹配：使用黄色高亮
              nodeColor = styles.node.searchHighlightBackground;
              borderColor = styles.node.searchHighlightBorder;
              borderWidth = 2;
              titleColor = styles.text.titleColor;
          } else if (t.stage === null) {
              // 待分配任务
              nodeColor = styles.node.unassignedBackground;
              borderColor = styles.node.unassignedBorder;
              borderWidth = 2;
              titleColor = styles.text.unassignedTitleColor;
          } else if (t.status === 'completed') {
              // 已完成任务
              nodeColor = styles.node.completedBackground;
              borderColor = styles.node.defaultBorder;
              borderWidth = 1;
              titleColor = styles.text.titleColor;
          } else {
              // 普通任务
              nodeColor = styles.node.background;
              borderColor = styles.node.defaultBorder;
              borderWidth = 1;
              titleColor = styles.text.titleColor;
          }
          
          nodeDataArray.push({
              key: t.id,
              title: t.title || '未命名任务',
              displayId: this.store.compressDisplayId(t.displayId),
              stage: t.stage, // Add stage info for drag computation
              loc: loc,
              color: nodeColor,
              borderColor: borderColor,
              borderWidth: borderWidth,
              titleColor: titleColor,
              displayIdColor: styles.text.displayIdColor,
              selectedBorderColor: styles.node.selectedBorder,
              isUnassigned: t.stage === null,
              isSearchMatch: isSearchMatch, // 标记搜索匹配
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
                      isCrossTree: true,
                      description: conn.description || '' // 联系块描述
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
      
      // 先收集要删除的节点，再统一删除（避免遍历时修改数组）
      const nodesToRemove = (model as any).nodeDataArray
        .filter((n: any) => !nodeKeys.has(n.key));
      nodesToRemove.forEach((n: any) => (model as any).removeNodeData(n));
      
      const linksToRemove = (model as any).linkDataArray
        .filter((l: any) => !linkKeys.has(l.key));
      linksToRemove.forEach((l: any) => (model as any).removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      // 恢复选中状态
      if (selectedKeys.size > 0) {
          this.diagram.nodes.each((node: any) => {
              if (selectedKeys.has(node.data?.key)) {
                  node.isSelected = true;
              }
          });
      }
      } catch (error) {
          this.handleDiagramError('更新流程图失败', error);
      }
  }

  createUnassigned() {
      const result = this.store.addTask('新任务', '', null, null, false);
      if (isFailure(result)) {
          this.toast.error('创建任务失败', getErrorMessage(result.error));
      }
  }

  onDragStart(event: DragEvent, task: Task) {
      if (event.dataTransfer) {
          event.dataTransfer.setData("text", JSON.stringify(task));
          event.dataTransfer.setData("application/json", JSON.stringify(task));
          event.dataTransfer.effectAllowed = "move";
      }
  }
  
  // ========== 从流程图拖回待分配区域 ==========
  
  /**
   * 待分配区域 dragover 事件处理
   */
  onUnassignedDragOver(event: DragEvent) {
      event.preventDefault();
      if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
      }
      // 显示拖放提示
      this.isDropTargetActive.set(true);
  }
  
  /**
   * 待分配区域 drop 事件处理
   * 将任务从流程图解除分配
   */
  onUnassignedDrop(event: DragEvent) {
      event.preventDefault();
      this.isDropTargetActive.set(false);
      
      // 尝试获取拖动的任务数据
      let data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
      if (!data) return;
      
      try {
          const task = JSON.parse(data);
          if (task?.id && task.stage !== null) {
              // 解除任务分配（移回待分配区域）
              this.store.detachTask(task.id);
              this.toast.success('已移至待分配', `任务 "${task.title}" 已解除分配`);
              
              // 刷新图表
              setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
          }
      } catch (err) {
          this.logger.error('Drop to unassigned error:', err);
      }
  }
  
  /**
   * 开始从流程图拖动节点（用于拖回待分配区域）
   */
  startDragFromDiagram(taskId: string) {
      this.draggingFromDiagram.set(taskId);
      this.isDropTargetActive.set(true);
  }
  
  /**
   * 结束从流程图拖动
   */
  endDragFromDiagram() {
      this.draggingFromDiagram.set(null);
      this.isDropTargetActive.set(false);
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

  // 窗口大小变化已由 ResizeObserver 处理，不再需要重复监听
  // 移除冗余的 @HostListener('window:resize')

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

            // 获取连接终点位置用于对话框定位
            const midPoint = link.midPoint || toNode.location;
            const viewPt = this.diagram.transformDocToView(midPoint);
            const diagramRect = this.diagramDiv.nativeElement.getBoundingClientRect();
            const dialogX = diagramRect.left + viewPt.x;
            const dialogY = diagramRect.top + viewPt.y;

            // 检查目标节点是否已有父节点
            const childTask = this.store.tasks().find(t => t.id === childId);
            const parentTask = this.store.tasks().find(t => t.id === parentId);
            
            // 先移除临时连接线
            this.diagram.remove(link);
            
            if (childTask?.parentId) {
                // 目标已有父节点，只能创建跨树连接（关联）
                this.zone.run(() => {
                    this.store.addCrossTreeConnection(parentId, childId);
                    this.toast.success('已创建关联', '目标任务已有父级，已创建关联连接');
                    setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
                });
                return;
            }
            
            // 目标没有父节点，显示选择对话框让用户决定连接类型
            this.zone.run(() => {
                this.linkTypeDialog.set({
                    show: true,
                    sourceId: parentId,
                    targetId: childId,
                    sourceTask: parentTask || null,
                    targetTask: childTask || null,
                    x: dialogX,
                    y: dialogY
                });
            });
    }
    
    /**
     * 确认创建父子关系连接
     */
    confirmParentChildLink() {
        const dialog = this.linkTypeDialog();
        if (!dialog) return;
        
        const parentTask = dialog.sourceTask;
        const parentStage = parentTask?.stage ?? null;
        const nextStage = parentStage !== null ? parentStage + 1 : 1;
        
        this.store.moveTaskToStage(dialog.targetId, nextStage, undefined, dialog.sourceId);
        this.linkTypeDialog.set(null);
        setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
    
    /**
     * 确认创建关联连接（跨树）
     */
    confirmCrossTreeLink() {
        const dialog = this.linkTypeDialog();
        if (!dialog) return;
        
        this.store.addCrossTreeConnection(dialog.sourceId, dialog.targetId);
        this.linkTypeDialog.set(null);
        setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
    
    /**
     * 取消连接创建
     */
    cancelLinkCreate() {
        this.linkTypeDialog.set(null);
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
    
    // ========== 附件管理 ==========
    
    /**
     * 附件变更处理（全量替换，向后兼容）
     */
    onAttachmentsChange(taskId: string, attachments: Attachment[]) {
        this.store.updateTaskAttachments(taskId, attachments);
    }
    
    /**
     * 添加单个附件（原子操作）
     */
    onAttachmentAdd(taskId: string, attachment: Attachment) {
        this.store.addTaskAttachment(taskId, attachment);
    }
    
    /**
     * 移除单个附件（原子操作）
     */
    onAttachmentRemove(taskId: string, attachmentId: string) {
        this.store.removeTaskAttachment(taskId, attachmentId);
    }
    
    /**
     * 附件错误处理
     */
    onAttachmentError(error: string) {
        this.toast.error('附件操作失败', error);
    }
    
    // ========== 任务属性管理 ==========
    
    /**
     * 更新任务优先级
     */
    updateTaskPriority(taskId: string, priority: string | undefined) {
        const validPriority = priority as 'low' | 'medium' | 'high' | 'urgent' | undefined;
        this.store.updateTaskPriority(taskId, validPriority);
    }
    
    /**
     * 更新任务截止日期
     */
    updateTaskDueDate(taskId: string, dueDate: string | null) {
        this.store.updateTaskDueDate(taskId, dueDate);
    }
    
    /**
     * 移除任务标签
     */
    removeTaskTag(taskId: string, tag: string) {
        this.store.removeTaskTag(taskId, tag);
    }
    
    /**
     * 添加标签
     */
    addTaskTag(taskId: string, tag: string) {
        if (tag?.trim()) {
            this.store.addTaskTag(taskId, tag.trim());
        }
    }
}
