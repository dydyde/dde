import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter, ChangeDetectionStrategy, Injector } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../services/store.service';
import { ToastService } from '../services/toast.service';
import { LoggerService } from '../services/logger.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowDragDropService, InsertPositionInfo } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { Task } from '../models';
import { GOJS_CONFIG, UI_CONFIG, FLOW_VIEW_CONFIG } from '../config/constants';
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
    DatePipe,
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
      background-color: #F5F2E9;
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
        (taskTouchEnd)="onUnassignedTouchEnd($event.event)"
        (swipeToText)="goBackToText.emit()"
        (swipeToSidebar)="toggleRightPanel()">
      </app-flow-palette>

      <!-- 流程图区域 -->
      <div class="flex-1 min-h-0 relative overflow-hidden bg-[#F5F2E9] border-t border-[#78716C]/50">
        @if (!diagram.error()) {
          <div #diagramDiv data-testid="flow-diagram" class="absolute inset-0 w-full h-full z-0 flow-canvas-container"></div>
          
          <!-- 小地图/导航器 -->
          @if (isOverviewVisible()) {
            <div 
              class="absolute z-10 bg-white/90 backdrop-blur rounded-lg shadow-md border border-stone-200/60 overflow-hidden select-none"
              [class.opacity-40]="isOverviewCollapsed()"
              [class.hover:opacity-100]="isOverviewCollapsed()"
              [style.right.px]="store.isMobile() ? 8 : 16"
              [style.bottom]="overviewBottomPosition()"
              [style.width.px]="isOverviewCollapsed() ? (store.isMobile() ? 32 : 28) : overviewSize().width"
              [style.height.px]="isOverviewCollapsed() ? (store.isMobile() ? 32 : 28) : overviewSize().height">
              
              <!-- 小地图内容 -->
              @if (!isOverviewCollapsed()) {
                <div #overviewDiv class="w-full h-full"></div>
              }
              
              <!-- 折叠/展开按钮 -->
              <button
                (click)="toggleOverviewCollapse()"
                class="absolute top-0.5 right-0.5 rounded bg-white/80 hover:bg-stone-100 flex items-center justify-center transition-colors"
                [class.w-5]="!store.isMobile()"
                [class.h-5]="!store.isMobile()"
                [class.w-7]="store.isMobile()"
                [class.h-7]="store.isMobile()"
                [title]="isOverviewCollapsed() ? '展开小地图' : '折叠小地图'">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                     [class.w-3]="!store.isMobile()"
                     [class.h-3]="!store.isMobile()"
                     [class.w-4]="store.isMobile()"
                     [class.h-4]="store.isMobile()"
                     class="text-stone-500">
                  @if (isOverviewCollapsed()) {
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  } @else {
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  }
                </svg>
              </button>
            </div>
          }
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
              @if (hasReachedRetryLimit()) {
                <!-- 达到重试上限后显示完全重置按钮 -->
                <button 
                  (click)="resetAndRetryDiagram()"
                  class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-medium flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                  完全重置
                </button>
              } @else {
                <button 
                  (click)="retryInitDiagram()"
                  [disabled]="isRetryingDiagram()"
                  class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  @if (isRetryingDiagram()) {
                    <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>加载中...</span>
                  } @else {
                    重试加载
                  }
                </button>
              }
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
          (goBackToText)="goBackToText.emit()"
          (exportPng)="exportToPng()"
          (exportSvg)="exportToSvg()"
          (saveToCloud)="saveToCloud()">
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
        (confirm)="confirmDelete($event)"
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
      
      <!-- 移动端右侧滑出项目面板 -->
      @if (store.isMobile()) {
        <!-- 背景遮罩 -->
        @if (isRightPanelOpen()) {
          <div 
            class="fixed inset-0 bg-black/30 z-40 animate-fade-in"
            (click)="isRightPanelOpen.set(false)"
            (touchstart)="onRightPanelBackdropTouchStart($event)"
            (touchmove)="onRightPanelBackdropTouchMove($event)"
            (touchend)="onRightPanelBackdropTouchEnd($event)">
          </div>
        }
        
        <!-- 右侧滑出项目面板 - 完全复刻左侧侧边栏样式 -->
        <aside 
          class="fixed top-0 right-0 h-full w-[180px] border-l flex flex-col shrink-0 transition-transform duration-300 ease-out shadow-[-4px_0_24px_rgba(0,0,0,0.08)] z-50 overflow-hidden"
          style="background-color: var(--theme-sidebar-bg); border-color: var(--theme-border);"
          [class.translate-x-full]="!isRightPanelOpen()"
          [class.translate-x-0]="isRightPanelOpen()"
          (touchstart)="onRightPanelTouchStart($event)"
          (touchmove)="onRightPanelTouchMove($event)"
          (touchend)="onRightPanelTouchEnd($event)">
          
          <!-- Panel Header - 复刻侧边栏头部 -->
          <div class="flex justify-between items-center shrink-0 mx-3 mt-4 mb-3">
            <h1 class="font-bold text-stone-800 tracking-tight font-serif text-base">NanoFlow</h1>
            <button 
              (click)="isRightPanelOpen.set(false)"
              class="text-stone-400 hover:text-stone-600 w-6 h-6 flex items-center justify-center rounded-full transition-all active:bg-stone-200"
              title="关闭" aria-label="关闭面板">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          
          <!-- Project List - 完全复刻项目列表样式 -->
          <div class="flex-1 overflow-y-auto space-y-1 px-2">
            @for (proj of store.projects(); track proj.id) {
              <div 
                (click)="onRightPanelProjectClick(proj.id)"
                class="rounded-lg cursor-pointer transition-all duration-200 group hover:bg-stone-100 px-2 py-2"
                [class.bg-indigo-100]="store.activeProjectId() === proj.id"
                [class.text-indigo-900]="store.activeProjectId() === proj.id"
                [class.text-stone-500]="store.activeProjectId() !== proj.id">
                <div class="flex items-center justify-between gap-1 min-w-0">
                  <div class="font-medium transition-colors flex-1 min-w-0 truncate text-xs">
                    {{ proj.name }}
                  </div>
                </div>
                @if (store.activeProjectId() === proj.id) {
                  <div class="text-[10px] text-indigo-400 mt-1 animate-fade-in leading-relaxed font-mono">
                    {{ proj.createdDate | date:'MM/dd' }}
                  </div>
                }
              </div>
            } @empty {
              <div class="text-center py-8 text-stone-400 text-xs italic">
                暂无项目
              </div>
            }
          </div>
          
          <!-- Panel Footer - 复刻侧边栏底部 -->
          <div class="mb-4 shrink-0 space-y-2 mx-2">
            <!-- 同步状态提示 -->
            <div class="text-[10px] text-stone-400 text-center py-2">
              共 {{ store.projects().length }} 个项目
            </div>
          </div>
        </aside>
      }
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @ViewChild('overviewDiv') overviewDiv!: ElementRef;
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
  readonly drawerHeight = signal(25);
  readonly isResizingDrawerSignal = signal(false);
  
  /** 是否正在重试加载图表 */
  readonly isRetryingDiagram = signal(false);
  
  /** 小地图状态 */
  readonly isOverviewVisible = signal(true);
  readonly isOverviewCollapsed = signal(false);
  
  /** 右侧滑出面板状态（移动端） */
  readonly isRightPanelOpen = signal(false);
  
  /** 小地图尺寸（移动端使用更小尺寸） */
  readonly overviewSize = computed(() => {
    if (this.store.isMobile()) {
      return { width: 100, height: 80 };
    }
    return { width: 180, height: 140 };
  });

  /** 小地图底部位置（抽屉在顶部，固定在底部） */
  readonly overviewBottomPosition = computed(() => {
    // 桌面端稍高一点
    if (!this.store.isMobile()) {
      return '16px';
    }
    // 移动端固定在底部（抽屉在顶部，不影响小地图）
    return '8px';
  });

  /** 图表初始化重试次数 */
  private diagramRetryCount = 0;
  
  /** 是否已达到重试上限（用于 UI 显示不同按钮） */
  readonly hasReachedRetryLimit = signal(false);
  
  /** 计算属性: 获取选中的任务对象 */
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.store.tasks().find(t => t.id === id) || null;
  });
  
  // ========== 私有状态 ==========
  private isDestroyed = false;
  
  /** 待清理的定时器（防止内存泄漏） */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  
  /** rAF 调度 ID（用于取消） */
  private pendingRafId: number | null = null;
  
  /** 是否有待处理的图表更新（用于 rAF 合并） */
  private diagramUpdatePending = false;
  
  // ========== 调色板拖动状态 ==========
  private isResizingPalette = false;
  private startY = 0;
  private startHeight = 0;
  
  constructor() {
    // 监听任务数据变化，使用 rAF 对齐渲染帧更新图表
    // 核心原则：眼睛看到的（UI）用 rAF，硬盘存的（Data）用 debounce
    effect(() => {
      const tasks = this.store.tasks();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(tasks, false);
      }
    }, { injector: this.injector });
    
    // 监听搜索查询变化，使用 rAF 更新图表高亮
    effect(() => {
      const query = this.store.searchQuery();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(this.store.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 监听主题变化，使用 rAF 更新图表节点颜色
    effect(() => {
      const theme = this.store.theme();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(this.store.tasks(), true);
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
  
  /**
   * 使用 requestAnimationFrame 调度图表更新
   * 将多个 signal 变化合并到同一帧，避免过度渲染
   * 
   * 注意：rAF 的作用是"对齐"而非"延迟"
   * 它把更新逻辑和浏览器刷新频率（60Hz）对齐，确保不会在一帧里做两次无用渲染
   */
  private scheduleRafDiagramUpdate(tasks: Task[], forceUpdate: boolean): void {
    // 标记需要完整更新
    if (forceUpdate) {
      this.diagramUpdatePending = true;
    }
    
    // 如果已有 rAF 调度，复用它
    if (this.pendingRafId !== null) {
      return;
    }
    
    this.pendingRafId = requestAnimationFrame(() => {
      this.pendingRafId = null;
      
      if (this.isDestroyed || !this.diagram.isInitialized) return;
      
      // 执行图表更新，使用合并后的 forceUpdate 标志
      this.diagram.updateDiagram(this.store.tasks(), this.diagramUpdatePending);
      this.diagramUpdatePending = false;
    });
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.initDiagram();
    
    // 初始化完成后立即加载图表数据
    this.scheduleTimer(() => {
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks());
      }
    }, UI_CONFIG.MEDIUM_DELAY);
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 清理所有待处理的定时器
    this.pendingTimers.forEach(clearTimeout);
    this.pendingTimers = [];
    
    // 清理 rAF
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }
    
    // 清理服务
    this.diagram.dispose();
    this.touch.dispose();
    this.link.dispose();
    this.dragDrop.dispose();
    this.taskOps.dispose();
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
    
    // 初始化小地图
    this.initOverview();
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图
   */
  private initOverview(): void {
    if (!this.isOverviewVisible() || this.isOverviewCollapsed()) return;
    
    this.scheduleTimer(() => {
      if (this.overviewDiv?.nativeElement && this.diagram.isInitialized) {
        this.diagram.initializeOverview(this.overviewDiv.nativeElement);
      }
    }, 100);
  }
  
  /**
   * 折叠/展开小地图
   */
  toggleOverviewCollapse(): void {
    const wasCollapsed = this.isOverviewCollapsed();
    this.isOverviewCollapsed.set(!wasCollapsed);
    
    // 展开时需要重新初始化 Overview
    if (wasCollapsed) {
      this.scheduleTimer(() => {
        if (this.overviewDiv?.nativeElement && this.diagram.isInitialized) {
          this.diagram.initializeOverview(this.overviewDiv.nativeElement);
        }
      }, 50);
    } else {
      // 折叠时销毁 Overview
      this.diagram.disposeOverview();
    }
  }

  retryInitDiagram(): void {
    // 检查是否超过最大重试次数
    if (this.diagramRetryCount >= FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES) {
      this.toast.error(
        '初始化失败', 
        `流程图加载失败已重试 ${FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES} 次，请尝试刷新页面或切换到文本视图`
      );
      this.isRetryingDiagram.set(false);
      this.hasReachedRetryLimit.set(true);
      return;
    }
    
    this.diagramRetryCount++;
    this.isRetryingDiagram.set(true);
    this.hasReachedRetryLimit.set(false);
    
    // 显示重试进度反馈
    const remaining = FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES - this.diagramRetryCount;
    this.toast.info(
      `重试加载中...`,
      `第 ${this.diagramRetryCount} 次尝试（剩余 ${remaining} 次）`,
      { duration: 2000 }
    );
    
    // 使用指数退避：使用集中配置的基础延迟
    const delay = FLOW_VIEW_CONFIG.DIAGRAM_RETRY_BASE_DELAY * Math.pow(2, this.diagramRetryCount - 1);
    
    this.scheduleTimer(() => {
      this.initDiagram();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks());
        // 成功后重置重试计数
        this.diagramRetryCount = 0;
        this.hasReachedRetryLimit.set(false);
        this.toast.success('加载成功', '流程图已就绪');
      }
      this.isRetryingDiagram.set(false);
    }, delay);
  }
  
  /**
   * 完全重置图表状态并重新初始化
   * 用于用户手动触发的"完全重置"操作
   */
  resetAndRetryDiagram(): void {
    // 重置所有状态
    this.diagramRetryCount = 0;
    this.hasReachedRetryLimit.set(false);
    this.diagram.dispose();
    
    // 重新初始化
    this.toast.info('重置中...', '正在完全重置流程图');
    
    this.scheduleTimer(() => {
      this.initDiagram();
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.store.tasks());
        this.toast.success('重置成功', '流程图已就绪');
      } else {
        // 重置后仍然失败，显示错误但允许再次重试
        this.toast.error('重置失败', '流程图初始化失败，请尝试刷新页面');
      }
    }, 200);
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
  
  exportToPng(): void {
    this.diagram.exportToPng();
  }
  
  exportToSvg(): void {
    this.diagram.exportToSvg();
  }
  
  saveToCloud(): void {
    // TODO: 实现云端保存功能
    this.toast.info('功能开发中', '云端保存功能即将推出');
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
    this.scheduleTimer(() => {
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
        this.scheduleTimer(() => {
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
        this.scheduleTimer(() => {
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
        this.scheduleTimer(() => {
          this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        this.store.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        this.scheduleTimer(() => {
          this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else {
      this.store.updateTaskPosition(task.id, docPoint.x, docPoint.y);
    }
  }
  
  // ========== 待分配任务点击 ==========
  
  onUnassignedTaskClick(task: Task): void {
    // 待分配任务也会在流程图中显示，直接定位到该节点
    this.centerOnNode(task.id);
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
  
  confirmDelete(keepChildren: boolean): void {
    const task = this.deleteConfirmTask();
    if (task) {
      this.selectedTaskId.set(null);
      this.taskOps.deleteTask(task.id, keepChildren);
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
  
  /** 切换右侧面板（移动端） */
  toggleRightPanel(): void {
    if (this.store.isMobile()) {
      this.isRightPanelOpen.update(v => !v);
    }
  }
  
  /** 右侧面板任务点击处理 */
  onRightPanelTaskClick(taskId: string): void {
    this.selectedTaskId.set(taskId);
    this.centerOnNode(taskId, true);
    this.isRightPanelOpen.set(false);
  }
  
  /** 右侧面板项目点击处理 */
  onRightPanelProjectClick(projectId: string): void {
    this.store.activeProjectId.set(projectId);
    this.isRightPanelOpen.set(false);
  }
  
  // ========== 右侧面板滑动手势 ==========
  
  private rightPanelSwipeState = {
    startX: 0,
    startY: 0,
    isSwiping: false
  };
  
  onRightPanelTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    this.rightPanelSwipeState = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      isSwiping: false
    };
  }
  
  onRightPanelTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const deltaX = e.touches[0].clientX - this.rightPanelSwipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - this.rightPanelSwipeState.startY);
    
    // 向右滑动（正值）且水平距离大于垂直距离
    if (deltaX > 30 && deltaX > deltaY * 1.5) {
      this.rightPanelSwipeState.isSwiping = true;
    }
  }
  
  onRightPanelTouchEnd(e: TouchEvent): void {
    if (!this.rightPanelSwipeState.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.rightPanelSwipeState.startX;
    if (deltaX > 50) {
      // 向右滑动超过阈值，关闭面板
      this.isRightPanelOpen.set(false);
    }
    this.rightPanelSwipeState.isSwiping = false;
  }
  
  onRightPanelBackdropTouchStart(e: TouchEvent): void {
    this.onRightPanelTouchStart(e);
  }
  
  onRightPanelBackdropTouchMove(e: TouchEvent): void {
    this.onRightPanelTouchMove(e);
  }
  
  onRightPanelBackdropTouchEnd(e: TouchEvent): void {
    if (!this.rightPanelSwipeState.isSwiping) {
      // 如果不是滑动，则是点击背景关闭
      this.isRightPanelOpen.set(false);
    } else {
      this.onRightPanelTouchEnd(e);
    }
    this.rightPanelSwipeState.isSwiping = false;
  }
  
  // ========== 流程图区域滑动手势（用于切换视图/打开任务列表） ==========
  
  private diagramAreaSwipeState = {
    startX: 0,
    startY: 0,
    startTime: 0,
    isSwiping: false,
    isVerticalScroll: false  // 是否为垂直滚动（应由 GoJS 处理）
  };
  
  /**
   * 流程图区域触摸开始
   * 记录起始位置，准备检测滑动手势
   */
  onDiagramAreaTouchStart(e: TouchEvent): void {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.diagramAreaSwipeState = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      isSwiping: false,
      isVerticalScroll: false
    };
  }
  
  /**
   * 流程图区域触摸移动
   * 检测是水平滑动还是垂直滚动
   */
  onDiagramAreaTouchMove(e: TouchEvent): void {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    // 如果已经确定是垂直滚动，让 GoJS 处理
    if (this.diagramAreaSwipeState.isVerticalScroll) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.diagramAreaSwipeState.startX;
    const deltaY = touch.clientY - this.diagramAreaSwipeState.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    
    // 如果还没确定方向
    if (!this.diagramAreaSwipeState.isSwiping && !this.diagramAreaSwipeState.isVerticalScroll) {
      // 移动距离太小，继续等待
      if (absDeltaX < 15 && absDeltaY < 15) return;
      
      // 判断是水平滑动还是垂直滚动
      if (absDeltaX > absDeltaY * 1.5 && absDeltaX > 20) {
        // 水平滑动 - 用于切换视图
        this.diagramAreaSwipeState.isSwiping = true;
      } else if (absDeltaY > absDeltaX) {
        // 垂直滚动 - 让 GoJS 处理
        this.diagramAreaSwipeState.isVerticalScroll = true;
      }
    }
  }
  
  /**
   * 流程图区域触摸结束
   * 根据滑动方向执行相应操作
   */
  onDiagramAreaTouchEnd(e: TouchEvent): void {
    if (!this.store.isMobile()) return;
    
    // 如果是垂直滚动或没有检测到滑动，不处理
    if (this.diagramAreaSwipeState.isVerticalScroll || !this.diagramAreaSwipeState.isSwiping) {
      return;
    }
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - this.diagramAreaSwipeState.startX;
    const deltaTime = Date.now() - this.diagramAreaSwipeState.startTime;
    
    // 快速滑动降低阈值，慢速滑动需要更大距离
    const threshold = deltaTime < 300 ? 40 : 60;
    
    if (deltaX > threshold) {
      // 向右滑动 → 打开任务列表面板
      this.isRightPanelOpen.set(true);
    } else if (deltaX < -threshold) {
      // 向左滑动 → 切换到文本视图
      this.goBackToText.emit();
    }
    
    // 重置状态
    this.diagramAreaSwipeState.isSwiping = false;
    this.diagramAreaSwipeState.isVerticalScroll = false;
  }
  
  // ========== 私有辅助方法 ==========
  
  /**
   * 安全调度定时器，自动追踪并在组件销毁时清理
   * @param callback 回调函数
   * @param delay 延迟毫秒数
   * @returns 定时器 ID
   */
  private scheduleTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timerId = setTimeout(() => {
      // 从列表中移除已执行的定时器
      const index = this.pendingTimers.indexOf(timerId);
      if (index > -1) {
        this.pendingTimers.splice(index, 1);
      }
      // 如果组件已销毁，不执行回调
      if (this.isDestroyed) return;
      callback();
    }, delay);
    
    this.pendingTimers.push(timerId);
    return timerId;
  }
}
