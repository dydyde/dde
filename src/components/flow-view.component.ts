import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter, ChangeDetectionStrategy, Injector } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../services/store.service';
import { ToastService } from '../services/toast.service';
import { LoggerService } from '../services/logger.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowDragDropService, InsertPositionInfo } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { Task, Attachment } from '../models';
import { GOJS_CONFIG, UI_CONFIG } from '../config/constants';
import { 
  FlowToolbarComponent, 
  FlowPaletteComponent, 
  FlowTaskDetailComponent,
  FlowDeleteConfirmComponent,
  FlowLinkTypeDialogComponent,
  FlowConnectionEditorComponent,
  FlowLinkDeleteHintComponent
} from './flow';
import * as go from 'gojs';

/**
 * FlowViewComponent - 流程图视图组件
 * 
 * 重构后的职责：
 * - 模板渲染
 * - 子组件通信
 * - 服务协调
 * - 生命周期管理
 * 
 * 核心逻辑已拆分到以下服务：
 * - FlowDiagramService: GoJS 图表管理
 * - FlowDragDropService: 拖放处理
 * - FlowTouchService: 触摸处理
 * - FlowLinkService: 连接线管理
 * - FlowTaskOperationsService: 任务操作
 */
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
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background-color: #F9F8F6;
    }
  `],
  template: `
    <div class="flex flex-col flex-1 min-h-0 relative">
      <!-- 顶部调色板区域 -->
      <app-flow-palette
        [height]="paletteHeight()"
        [isDropTargetActive]="dragDrop.isDropTargetActive()"
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

      <!-- 流程图区域 -->
      <div class="flex-1 min-h-0 relative overflow-hidden bg-[#F9F8F6] border-t border-stone-200/50">
        @if (!diagram.error()) {
          <div #diagramDiv data-testid="flow-diagram" class="absolute inset-0 w-full h-full z-0 flow-canvas-container"></div>
        } @else {
          <!-- 流程图加载失败时的降级 UI -->
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-stone-50 p-6">
            <div class="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 class="text-lg font-semibold text-stone-800 mb-2">流程图加载失败</h3>
            <p class="text-sm text-stone-500 text-center mb-4">{{ diagram.error() }}</p>
            <div class="flex gap-3">
              <button 
                (click)="retryInitDiagram()"
                class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium">
                重试加载
              </button>
              <button 
                (click)="goBackToText.emit()"
                class="px-4 py-2 bg-stone-200 text-stone-700 rounded-lg hover:bg-stone-300 transition-colors text-sm font-medium">
                切换到文本视图
              </button>
            </div>
            <p class="text-xs text-stone-400 mt-4">
              提示：您仍可以在文本视图中管理任务
            </p>
          </div>
        }

        <!-- 工具栏 -->
        <app-flow-toolbar
          [isLinkMode]="link.isLinkMode()"
          [linkSourceTask]="link.linkSourceTask()"
          [isResizingDrawer]="isResizingDrawerSignal()"
          [drawerHeightVh]="drawerHeight()"
          (zoomIn)="zoomIn()"
          (zoomOut)="zoomOut()"
          (autoLayout)="applyAutoLayout()"
          (toggleLinkMode)="link.toggleLinkMode()"
          (cancelLinkMode)="link.cancelLinkMode()"
          (toggleSidebar)="emitToggleSidebar()"
          (goBackToText)="goBackToText.emit()">
        </app-flow-toolbar>

        <!-- 任务详情面板 -->
        <app-flow-task-detail
          [task]="selectedTask()"
          [position]="taskDetailPos()"
          [drawerHeight]="drawerHeight()"
          (positionChange)="taskDetailPos.set($event)"
          (drawerHeightChange)="drawerHeight.set($event)"
          (isResizingChange)="isResizingDrawerSignal.set($event)"
          (titleChange)="taskOps.updateTaskTitle($event.taskId, $event.title)"
          (contentChange)="taskOps.updateTaskContent($event.taskId, $event.content)"
          (priorityChange)="taskOps.updateTaskPriority($event.taskId, $event.priority)"
          (dueDateChange)="taskOps.updateTaskDueDate($event.taskId, $event.dueDate)"
          (tagAdd)="taskOps.addTaskTag($event.taskId, $event.tag)"
          (tagRemove)="taskOps.removeTaskTag($event.taskId, $event.tag)"
          (addSibling)="addSiblingTask($event)"
          (addChild)="addChildTask($event)"
          (toggleStatus)="taskOps.toggleTaskStatus($event)"
          (archiveTask)="archiveTask($event)"
          (deleteTask)="deleteTask($event)"
          (quickTodoAdd)="taskOps.addQuickTodo($event.taskId, $event.text)"
          (attachmentAdd)="taskOps.addTaskAttachment($event.taskId, $event.attachment)"
          (attachmentRemove)="taskOps.removeTaskAttachment($event.taskId, $event.attachmentId)"
          (attachmentsChange)="taskOps.updateTaskAttachments($event.taskId, $event.attachments)"
          (attachmentError)="taskOps.handleAttachmentError($event)">
        </app-flow-task-detail>
      </div>
      
      <!-- 删除确认弹窗 -->
      <app-flow-delete-confirm
        [task]="deleteConfirmTask()"
        [keepChildren]="deleteKeepChildren()"
        [hasChildren]="deleteConfirmTask() ? taskOps.hasChildren(deleteConfirmTask()!) : false"
        [isMobile]="store.isMobile()"
        (cancel)="deleteConfirmTask.set(null); deleteKeepChildren.set(false)"
        (confirm)="confirmDelete()"
        (keepChildrenChange)="deleteKeepChildren.set($event)">
      </app-flow-delete-confirm>
      
      <!-- 移动端连接线删除提示 -->
      @if (store.isMobile()) {
        <app-flow-link-delete-hint
          [hint]="link.linkDeleteHint()"
          (confirm)="confirmLinkDelete()"
          (cancel)="link.cancelLinkDelete()">
        </app-flow-link-delete-hint>
      }
      
      <!-- 联系块内联编辑器 -->
      <app-flow-connection-editor
        [data]="link.connectionEditorData()"
        [position]="link.connectionEditorPos()"
        [connectionTasks]="link.getConnectionTasks()"
        (close)="link.closeConnectionEditor()"
        (save)="saveConnectionDescription($event)"
        (dragStart)="link.startDragConnEditor($event)">
      </app-flow-connection-editor>
      
      <!-- 连接类型选择对话框 -->
      <app-flow-link-type-dialog
        [data]="link.linkTypeDialog()"
        (cancel)="link.cancelLinkCreate()"
        (parentChildLink)="confirmParentChildLink()"
        (crossTreeLink)="confirmCrossTreeLink()">
      </app-flow-link-type-dialog>
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @Output() goBackToText = new EventEmitter<void>();
  
  // ========== 依赖注入 ==========
  readonly store = inject(StoreService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  
  // 核心服务
  readonly diagram = inject(FlowDiagramService);
  readonly dragDrop = inject(FlowDragDropService);
  readonly touch = inject(FlowTouchService);
  readonly link = inject(FlowLinkService);
  readonly taskOps = inject(FlowTaskOperationsService);
  
  // ========== 组件状态 ==========
  
  /** 选中的任务ID */
  readonly selectedTaskId = signal<string | null>(null);
  
  /** 删除确认状态 */
  readonly deleteConfirmTask = signal<Task | null>(null);
  readonly deleteKeepChildren = signal(false);
  
  /** 任务详情面板位置 */
  readonly taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 });
  
  /** 调色板高度 - 移动端默认更小 */
  readonly paletteHeight = signal(this.store.isMobile() ? 120 : 180);
  
  /** 底部抽屉高度（vh） */
  readonly drawerHeight = signal(35);
  readonly isResizingDrawerSignal = signal(false);
  
  /** 计算属性: 获取选中的任务对象 */
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.store.tasks().find(t => t.id === id) || null;
  });
  
  // ========== 私有状态 ==========
  private isDestroyed = false;
  
  // ========== 调色板拖动状态 ==========
  private isResizingPalette = false;
  private startY = 0;
  private startHeight = 0;
  
  constructor() {
    // 监听任务数据变化，更新图表
    effect(() => {
      const tasks = this.store.tasks();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(tasks);
      }
    }, { injector: this.injector });
    
    // 监听搜索查询变化，更新图表高亮
    effect(() => {
      const query = this.store.searchQuery();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 监听主题变化，更新图表节点颜色
    effect(() => {
      const theme = this.store.theme();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 跨视图选中状态同步
    effect(() => {
      const selectedId = this.selectedTaskId();
      if (selectedId && this.diagram.isInitialized) {
        this.diagram.selectNode(selectedId);
      }
    }, { injector: this.injector });
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.initDiagram();
    
    // 初始化完成后立即加载图表数据
    setTimeout(() => {
      if (this.isDestroyed) return;
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks());
      }
    }, UI_CONFIG.MEDIUM_DELAY);
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 清理服务
    this.diagram.dispose();
    this.touch.dispose();
    this.link.dispose();
  }
  
  // ========== 图表初始化 ==========
  
  private initDiagram(): void {
    const success = this.diagram.initialize(this.diagramDiv.nativeElement);
    if (!success) return;
    
    // 注册回调
    this.diagram.onNodeClick((taskId, isDoubleClick) => {
      if (this.link.isLinkMode()) {
        const created = this.link.handleLinkModeClick(taskId);
        if (created) {
          this.refreshDiagram();
        }
      } else {
        this.selectedTaskId.set(taskId);
        if (isDoubleClick) {
          this.store.isFlowDetailOpen.set(true);
        }
      }
    });
    
    this.diagram.onLinkClick((linkData, x, y) => {
      if (linkData?.isCrossTree) {
        this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y);
      } else if (this.store.isMobile()) {
        this.link.showLinkDeleteHint(linkData, x, y);
      }
    });
    
    this.diagram.onLinkGesture((sourceId, targetId, x, y, gojsLink) => {
      // 移除临时连接线
      this.diagram.removeLink(gojsLink);
      
      const action = this.link.handleLinkGesture(sourceId, targetId, x, y);
      if (action === 'create-cross-tree') {
        this.refreshDiagram();
      }
    });
    
    this.diagram.onSelectionMoved((movedNodes) => {
      movedNodes.forEach(node => {
        if (node.isUnassigned) {
          // 检测是否拖到连接线上
          const diagramInstance = this.diagram.diagramInstance;
          if (diagramInstance) {
            const loc = new go.Point(node.x, node.y);
            this.dragDrop.handleNodeMoved(node.key, loc, true, diagramInstance);
          }
        } else {
          this.store.updateTaskPositionWithRankSync(node.key, node.x, node.y);
        }
      });
    });
    
    this.diagram.onBackgroundClick(() => {
      this.link.closeConnectionEditor();
    });
    
    // 设置拖放处理
    this.diagram.setupDropHandler((taskData, docPoint) => {
      this.handleDiagramDrop(taskData, docPoint);
    });
  }
  
  retryInitDiagram(): void {
    setTimeout(() => {
      if (this.isDestroyed) return;
      this.initDiagram();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks());
      }
    }, 100);
  }
  
  // ========== 图表操作 ==========
  
  zoomIn(): void {
    this.diagram.zoomIn();
  }
  
  zoomOut(): void {
    this.diagram.zoomOut();
  }
  
  applyAutoLayout(): void {
    this.diagram.applyAutoLayout();
  }
  
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    this.diagram.centerOnNode(taskId);
    this.selectedTaskId.set(taskId);
    if (openDetail) {
      this.store.isFlowDetailOpen.set(true);
    }
  }
  
  refreshLayout(): void {
    this.diagram.requestUpdate();
  }
  
  private refreshDiagram(): void {
    setTimeout(() => {
      if (this.isDestroyed) return;
      this.diagram.updateDiagram(this.store.tasks());
    }, 50);
  }
  
  // ========== 拖放处理 ==========
  
  onDragStart(event: DragEvent, task: Task): void {
    this.dragDrop.startDrag(event, task);
  }
  
  onUnassignedDrop(event: DragEvent): void {
    const success = this.dragDrop.handleDropToUnassigned(event);
    if (success) {
      this.refreshDiagram();
    }
  }
  
  private handleDiagramDrop(taskData: any, docPoint: go.Point): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;
    
    const insertInfo = this.dragDrop.findInsertPosition(docPoint, diagramInstance);
    
    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(taskData.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.store.moveTaskToStage(taskData.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        setTimeout(() => {
          if (this.isDestroyed) return;
          this.store.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        if (insertInfo.afterTaskId) {
          const siblings = this.store.tasks()
            .filter(t => t.stage === refTask.stage && t.parentId === refTask.parentId)
            .sort((a, b) => a.rank - b.rank);
          const afterIndex = siblings.findIndex(t => t.id === refTask.id);
          const nextSibling = siblings[afterIndex + 1];
          this.store.moveTaskToStage(taskData.id, refTask.stage, nextSibling?.id || null, refTask.parentId);
        } else {
          this.store.moveTaskToStage(taskData.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        }
        setTimeout(() => {
          if (this.isDestroyed) return;
          this.store.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else {
      this.store.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
    }
  }
  
  // ========== 触摸处理 ==========
  
  onUnassignedTouchStart(event: TouchEvent, task: Task): void {
    this.touch.startTouch(event, task);
  }
  
  onUnassignedTouchMove(event: TouchEvent): void {
    const shouldPrevent = this.touch.handleTouchMove(event);
    if (shouldPrevent) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  
  onUnassignedTouchEnd(event: TouchEvent): void {
    this.touch.endTouch(
      event,
      this.diagramDiv?.nativeElement,
      this.diagram.diagramInstance,
      (task, insertInfo, docPoint) => {
        this.handleTouchDrop(task, insertInfo, docPoint);
      }
    );
  }
  
  private handleTouchDrop(task: Task, insertInfo: InsertPositionInfo, docPoint: go.Point): void {
    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(task.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        setTimeout(() => {
          if (this.isDestroyed) return;
          this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        this.store.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        setTimeout(() => {
          if (this.isDestroyed) return;
          this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else {
      this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
    }
  }
  
  // ========== 待分配任务点击 ==========
  
  onUnassignedTaskClick(task: Task): void {
    if (task.x !== 0 || task.y !== 0) {
      this.centerOnNode(task.id);
    } else {
      this.selectedTaskId.set(task.id);
      this.store.isFlowDetailOpen.set(true);
    }
  }
  
  // ========== 连接线操作 ==========
  
  confirmParentChildLink(): void {
    this.link.confirmParentChildLink();
    this.refreshDiagram();
  }
  
  confirmCrossTreeLink(): void {
    this.link.confirmCrossTreeLink();
    this.refreshDiagram();
  }
  
  saveConnectionDescription(description: string): void {
    this.link.saveConnectionDescription(description);
    this.refreshDiagram();
  }
  
  confirmLinkDelete(): void {
    const result = this.link.confirmLinkDelete();
    if (result) {
      this.refreshDiagram();
    }
  }
  
  // ========== 任务操作 ==========
  
  createUnassigned(): void {
    this.taskOps.createUnassignedTask('新任务');
  }
  
  addSiblingTask(task: Task): void {
    const newTaskId = this.taskOps.addSiblingTask(task);
    if (newTaskId) {
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  addChildTask(task: Task): void {
    const newTaskId = this.taskOps.addChildTask(task);
    if (newTaskId) {
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  archiveTask(task: Task): void {
    const newStatus = this.taskOps.archiveTask(task);
    if (newStatus === 'archived') {
      this.selectedTaskId.set(null);
    }
  }
  
  deleteTask(task: Task): void {
    this.deleteConfirmTask.set(task);
  }
  
  confirmDelete(): void {
    const task = this.deleteConfirmTask();
    if (task) {
      this.selectedTaskId.set(null);
      this.taskOps.deleteTask(task.id, this.deleteKeepChildren());
      this.deleteConfirmTask.set(null);
      this.deleteKeepChildren.set(false);
      
      // 强制刷新图表
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks(), true);
      }
    }
  }
  
  // ========== 调色板拖动 ==========
  
  startPaletteResize(e: MouseEvent): void {
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
  
  startPaletteResizeTouch(e: TouchEvent): void {
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
  
  // ========== 快捷键处理 ==========
  
  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent): void {
    if (!this.diagram.isInitialized) return;
    if (!event.altKey) return;
    
    const key = event.key.toLowerCase();
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;
    
    // Alt+Z: 解除父子关系
    if (key === 'z') {
      const selectedKeys = this.diagram.getSelectedNodeKeys();
      if (!selectedKeys.length) return;
      
      event.preventDefault();
      event.stopPropagation();
      
      this.zone.run(() => {
        selectedKeys.forEach(id => this.store.detachTask(id));
      });
      return;
    }
    
    // Alt+X: 删除选中的连接线（跨树连接）
    if (key === 'x') {
      const selectedLinks: any[] = [];
      diagramInstance.selection.each((part: any) => {
        if (part instanceof go.Link && part?.data?.isCrossTree) {
          selectedLinks.push(part.data);
        }
      });
      
      if (!selectedLinks.length) return;
      
      event.preventDefault();
      event.stopPropagation();
      
      this.zone.run(() => {
        this.link.handleDeleteCrossTreeLinks(selectedLinks);
        this.refreshDiagram();
      });
      return;
    }
  }
  
  // ========== 其他 ==========
  
  emitToggleSidebar(): void {
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }
}
