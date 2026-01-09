import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter, ChangeDetectionStrategy, Injector, untracked } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { PreferenceService } from '../../../../services/preference.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowCommandService } from '../../../../services/flow-command.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowEventService } from '../services/flow-event.service';
import { FlowZoomService } from '../services/flow-zoom.service';
import { FlowSelectionService } from '../services/flow-selection.service';
import { FlowLayoutService } from '../services/flow-layout.service';
import { FlowDragDropService, InsertPositionInfo } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { Task } from '../../../../models';
import { UI_CONFIG, FLOW_VIEW_CONFIG } from '../../../../config';
import { FlowToolbarComponent } from './flow-toolbar.component';
import { FlowPaletteComponent } from './flow-palette.component';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';
import { FlowLinkTypeDialogComponent } from './flow-link-type-dialog.component';
import { FlowConnectionEditorComponent } from './flow-connection-editor.component';
import { FlowLinkDeleteHintComponent } from './flow-link-delete-hint.component';
import { FlowCascadeAssignDialogComponent, CascadeAssignDialogData } from './flow-cascade-assign-dialog.component';
import { FlowBatchDeleteDialogComponent, BatchDeleteDialogData } from './flow-batch-delete-dialog.component';
import { flowTemplateEventHandlers } from '../services/flow-template-events';
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
    FlowLinkDeleteHintComponent,
    FlowCascadeAssignDialogComponent,
    FlowBatchDeleteDialogComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      position: relative;
      background-color: var(--theme-bg, #F5F2E9);
    }
    
    @keyframes slide-up {
      from {
        opacity: 0;
        transform: translate(-50%, 20px);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }
    
    .animate-slide-up {
      animation: slide-up 0.2s ease-out;
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
      <div class="flex-1 min-h-0 relative overflow-hidden dark:bg-stone-950 md:border-t md:border-[#78716C]/50" [style.backgroundColor]="'var(--theme-bg, #F5F2E9)'">
        @if (!diagram.error()) {
          <div #diagramDiv data-testid="flow-diagram" class="absolute inset-0 w-full h-full z-0 flow-canvas-container"></div>
          
          <!-- 批量操作浮动工具栏（放在流程图画布内部） -->
          @if (selectionService.hasMultipleSelection()) {
            @if (uiState.isMobile()) {
              <!-- 移动端：左下角，工具栏上方（不遮挡工具框） -->
              <div class="absolute left-2 z-40 animate-slide-up" style="bottom: 56px;">
                <div class="bg-white/95 dark:bg-stone-800/95 backdrop-blur rounded-lg shadow-lg border border-stone-200 dark:border-stone-600 px-2.5 py-1.5 flex items-center gap-1.5">
                  <span class="text-xs text-stone-600 dark:text-stone-300">
                    已选 <span class="font-semibold text-stone-800 dark:text-stone-100">{{ selectionService.selectionCount() }}</span>
                  </span>
                  <div class="w-px h-3 bg-stone-200 dark:bg-stone-600"></div>
                  <button 
                    (click)="requestBatchDelete()"
                    class="flex items-center gap-1 px-1.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    删除
                  </button>
                  <button 
                    (click)="selectionService.clearSelection()"
                    class="px-1.5 py-1 text-xs font-medium text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded transition-colors">
                    取消
                  </button>
                </div>
              </div>
            } @else {
              <!-- 桌面端：流程图画布左上角 -->
              <div class="absolute left-4 top-4 z-40 animate-slide-up">
                <div class="bg-white/95 dark:bg-stone-800/95 backdrop-blur rounded-xl shadow-lg border border-stone-200 dark:border-stone-600 px-4 py-2.5 flex items-center gap-3">
                  <span class="text-sm text-stone-600 dark:text-stone-300">
                    已选择 <span class="font-semibold text-stone-800 dark:text-stone-100">{{ selectionService.selectionCount() }}</span> 个任务
                  </span>
                  <div class="w-px h-4 bg-stone-200 dark:bg-stone-600"></div>
                  <button 
                    (click)="requestBatchDelete()"
                    class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    删除
                  </button>
                  <button 
                    (click)="selectionService.clearSelection()"
                    class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-lg transition-colors">
                    取消选择
                  </button>
                </div>
              </div>
            }
          }
          
          <!-- 小地图/导航器 -->
          @if (isOverviewVisible()) {
            <div 
              class="absolute z-50 pointer-events-auto bg-white/90 dark:bg-stone-800/90 backdrop-blur rounded-lg shadow-md border border-stone-200/60 dark:border-stone-700/60 select-none"
              style="overflow: hidden;"
              [ngClass]="{
                'opacity-40 hover:opacity-100': isOverviewCollapsed()
              }"
              [style.right.px]="uiState.isMobile() ? 8 : 16"
              [style.bottom]="overviewBottomPosition()"
              [style.width.px]="isOverviewCollapsed() ? (uiState.isMobile() ? 24 : 28) : overviewSize().width"
              [style.height.px]="isOverviewCollapsed() ? (uiState.isMobile() ? 24 : 28) : overviewSize().height">
              
              <!-- 小地图内容 -->
              @if (!isOverviewCollapsed()) {
                <!-- 让 Overview 画布在更低层级渲染，避免覆盖右上角折叠按钮的点击区域 -->
                <!-- 添加明确的尺寸和 overflow 设置，确保 Canvas 正确渲染 -->
                <div #overviewDiv 
                  class="w-full h-full relative z-0"
                  style="overflow: hidden; position: relative;"></div>
              }
              
              <!-- 折叠/展开按钮 -->
              <button
                (pointerdown)="onOverviewTogglePointerDown($event)"
                type="button"
                class="absolute top-0.5 right-0.5 z-50 pointer-events-auto rounded bg-white/80 dark:bg-stone-700/80 hover:bg-stone-100 dark:hover:bg-stone-600 flex items-center justify-center transition-colors"
                [class.w-5]="!uiState.isMobile()"
                [class.h-5]="!uiState.isMobile()"
                 [class.w-6]="uiState.isMobile()"
                 [class.h-6]="uiState.isMobile()"
                [title]="isOverviewCollapsed() ? '展开小地图' : '折叠小地图'">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                     [class.w-3]="!uiState.isMobile()"
                     [class.h-3]="!uiState.isMobile()"
                   [class.w-3]="uiState.isMobile()"
                   [class.h-3]="uiState.isMobile()"
                     class="text-stone-500 dark:text-stone-400">
                  @if (isOverviewCollapsed()) {
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  } @else {
                    <!-- 折叠图标：用“最小化”横线替代叉叉，避免误解为关闭按钮 -->
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 12h12" />
                  }
                </svg>
              </button>
            </div>
          }
        } @else {
          <!-- 流程图加载失败时的降级 UI -->
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-stone-50 dark:bg-stone-900 p-6">
            <div class="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 class="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">流程图加载失败</h3>
            <p class="text-sm text-stone-500 dark:text-stone-400 text-center mb-4">{{ diagram.error() }}</p>
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
                class="px-4 py-2 bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-200 rounded-lg hover:bg-stone-300 dark:hover:bg-stone-600 transition-colors text-sm font-medium">
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
          [isSelectMode]="isSelectMode()"
          (zoomIn)="zoomIn()"
          (zoomOut)="zoomOut()"
          (autoLayout)="applyAutoLayout()"
          (toggleLinkMode)="link.toggleLinkMode()"
          (cancelLinkMode)="link.cancelLinkMode()"
          (toggleSidebar)="emitToggleSidebar()"
          (goBackToText)="goBackToText.emit()"
          (exportPng)="exportToPng()"
          (exportSvg)="exportToSvg()"
          (saveToCloud)="saveToCloud()"
          (toggleSelectMode)="toggleSelectMode()">
        </app-flow-toolbar>

        <!-- 任务详情面板 -->
        <app-flow-task-detail
          [task]="selectedTask()"
          [position]="taskDetailPos()"
          [drawerHeight]="drawerHeight()"
          [autoHeightEnabled]="!drawerManualOverride()"
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
        [isMobile]="uiState.isMobile()"
        (cancel)="deleteConfirmTask.set(null); deleteKeepChildren.set(false)"
        (confirm)="confirmDelete($event)"
        (keepChildrenChange)="deleteKeepChildren.set($event)">
      </app-flow-delete-confirm>
      
      <!-- 批量删除确认弹窗 -->
      <app-flow-batch-delete-dialog
        [data]="batchDeleteDialog()"
        [isMobile]="uiState.isMobile()"
        (cancel)="batchDeleteDialog.set(null)"
        (confirm)="confirmBatchDelete()">
      </app-flow-batch-delete-dialog>
      
      <!-- 移动端连接线删除提示 -->
      @if (uiState.isMobile()) {
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
        (delete)="deleteConnection()"
        (dragStart)="link.startDragConnEditor($event)">
      </app-flow-connection-editor>
      
      <!-- 连接类型选择对话框 -->
      <app-flow-link-type-dialog
        [data]="link.linkTypeDialog()"
        (cancel)="link.cancelLinkCreate()"
        (parentChildLink)="confirmParentChildLink()"
        (crossTreeLink)="confirmCrossTreeLink()">
      </app-flow-link-type-dialog>
      
      <!-- 级联分配确认对话框 -->
      <app-flow-cascade-assign-dialog
        [data]="cascadeAssignDialog()"
        (confirm)="confirmCascadeAssign()"
        (cancel)="cancelCascadeAssign()">
      </app-flow-cascade-assign-dialog>
      
      <!-- 移动端右侧滑出项目面板 -->
      @if (uiState.isMobile()) {
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
            <h1 class="font-bold text-stone-800 dark:text-stone-100 tracking-tight font-serif text-base">NanoFlow</h1>
            <button 
              (click)="isRightPanelOpen.set(false)"
              class="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 w-6 h-6 flex items-center justify-center rounded-full transition-all active:bg-stone-200 dark:active:bg-stone-700"
              title="关闭" aria-label="关闭面板">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          
          <!-- Project List - 完全复刻项目列表样式 -->
          <div class="flex-1 overflow-y-auto space-y-1 px-2">
            @for (proj of projectState.projects(); track proj.id) {
              <div 
                (click)="onRightPanelProjectClick(proj.id)"
                class="rounded-lg cursor-pointer transition-all duration-200 group hover:bg-stone-100 dark:hover:bg-stone-700 px-2 py-2"
                [ngClass]="{
                  'bg-indigo-100': projectState.activeProjectId() === proj.id,
                  'dark:bg-indigo-900/30': projectState.activeProjectId() === proj.id,
                  'text-indigo-900': projectState.activeProjectId() === proj.id,
                  'dark:text-indigo-200': projectState.activeProjectId() === proj.id,
                  'text-stone-500': projectState.activeProjectId() !== proj.id,
                  'dark:text-stone-400': projectState.activeProjectId() !== proj.id
                }">
                <div class="flex items-center justify-between gap-1 min-w-0">
                  <div class="font-medium transition-colors flex-1 min-w-0 truncate text-xs">
                    {{ proj.name }}
                  </div>
                </div>
                @if (projectState.activeProjectId() === proj.id) {
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
              共 {{ projectState.projects().length }} 个项目
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
  
  // ========== P2-1 迁移：直接注入子服务 ==========
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly preference = inject(PreferenceService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  
  // 命令服务（解耦与 ProjectShellComponent 的通信）
  private readonly flowCommand = inject(FlowCommandService);
  
  // 核心服务
  readonly diagram = inject(FlowDiagramService);
  private readonly eventService = inject(FlowEventService);
  private readonly zoomService = inject(FlowZoomService);
  readonly selectionService = inject(FlowSelectionService);
  private readonly layoutService = inject(FlowLayoutService);
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
  
  /** 批量删除确认状态 */
  readonly batchDeleteDialog = signal<BatchDeleteDialogData | null>(null);
  
  /** 级联分配确认对话框状态 */
  readonly cascadeAssignDialog = signal<CascadeAssignDialogData | null>(null);
  
  /** 任务详情面板位置 */
  readonly taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 });
  
  /** 调色板高度 - 移动端默认更小 */
  readonly paletteHeight = signal(this.uiState.isMobile() ? 80 : 180);
  
  /** 底部抽屉高度（vh） - 移动端顶部抽屉 */
  // 默认给一个安全值，真正的“最佳高度”由下面的 effect 在移动端动态校准。
  readonly drawerHeight = signal(this.uiState.isMobile() ? 8.62 : 25);
  /** 用户手动拖拽后，阻止预设高度覆盖，直到详情关闭 */
  readonly drawerManualOverride = signal(false);
  readonly isResizingDrawerSignal = signal(false);
  
  /** 是否正在重试加载图表 */
  readonly isRetryingDiagram = signal(false);
  
  /** 小地图状态 */
  readonly isOverviewVisible = signal(true);
  readonly isOverviewCollapsed = signal(false);
  
  /** 右侧滑出面板状态（移动端） */
  readonly isRightPanelOpen = signal(false);
  
  /** 移动端：框选模式（区分平移和框选） */
  readonly isSelectMode = signal(false);
  
  /** 小地图尺寸（移动端使用更小尺寸） */
  readonly overviewSize = computed(() => {
    if (this.uiState.isMobile()) {
      return { width: 100, height: 80 };
    }
    return { width: 180, height: 140 };
  });

  /** 小地图底部位置（抽屉在顶部，固定在底部） */
  readonly overviewBottomPosition = computed(() => {
    // 桌面端稍高一点
    if (!this.uiState.isMobile()) {
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
    return this.projectState.tasks().find(t => t.id === id) || null;
  });
  
  // ========== 私有状态 ==========
  private isDestroyed = false;

  /** GoJS 拖拽结束时用于移动端幽灵清理的监听器引用（便于销毁/重建时移除） */
  private diagramSelectionMovedListener: ((e: go.DiagramEvent) => void) | null = null;
  
  /** 待清理的定时器（防止内存泄漏） */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  
  /** 移动端框选模式：保存的原始 standardMouseSelect 方法 */
  private originalStandardMouseSelect: (() => void) | undefined;
  
  /** rAF 调度 ID（用于取消） */
  private pendingRafId: number | null = null;
  
  /** 是否有待处理的图表更新（用于 rAF 合并） */
  private diagramUpdatePending = false;
  
  /** Overview 刷新定时器（防抖） */
  private overviewResizeTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 调色板拖动状态 ==========
  private isResizingPalette = false;
  private startY = 0;
  private startHeight = 0;
  
  /**
   * 监听窗口大小改变（处理屏幕旋转等情况）
   */
  @HostListener('window:resize')
  onWindowResize(): void {
    // 防抖处理，避免频繁刷新
    if (this.overviewResizeTimer) {
      clearTimeout(this.overviewResizeTimer);
    }
    
    this.overviewResizeTimer = setTimeout(() => {
      if (!this.isDestroyed && !this.isOverviewCollapsed()) {
        this.diagram.refreshOverview();
      }
    }, 300);
  }
  
  /**
   * 监听屏幕方向改变（移动端）
   */
  @HostListener('window:orientationchange')
  onOrientationChange(): void {
    // 屏幕旋转后延迟刷新，确保布局完成
    this.scheduleTimer(() => {
      if (!this.isDestroyed && !this.isOverviewCollapsed()) {
        this.diagram.refreshOverview();
      }
    }, 500);
  }
  
  constructor() {
    // 监听任务数据变化，使用 rAF 对齐渲染帧更新图表
    // 核心原则：眼睛看到的（UI）用 rAF，硬盘存的（Data）用 debounce
    effect(() => {
      const tasks = this.projectState.tasks();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(tasks, false);
      }
    }, { injector: this.injector });
    
    // 监听跨树连接变化（connections 是在 project 中而非 tasks 中）
    // 必须单独监听，否则添加/删除跨树连接不会触发图表更新
    // 注意：使用连接的"有效签名"而非数组长度，以检测软删除和恢复操作
    effect(() => {
      const project = this.projectState.activeProject();
      // 构建有效连接的签名（过滤掉 deletedAt，只统计活跃连接）
      const activeConnections = project?.connections?.filter(c => !c.deletedAt) ?? [];
      // 使用连接的 source-target 对作为签名，检测任何变化
      const connectionSignature = activeConnections
        .map(c => `${c.source}->${c.target}`)
        .sort()
        .join('|');
      // 读取 connectionSignature 来建立依赖关系
      if (connectionSignature !== undefined && this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 监听搜索查询变化，使用 rAF 更新图表高亮
    effect(() => {
      const _query = this.uiState.searchQuery();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 监听主题变化，使用 rAF 更新图表节点颜色
    effect(() => {
      const _theme = this.preference.theme();
      if (this.diagram.isInitialized) {
        this.scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector: this.injector });
    
    // 跨视图选中状态同步
    effect(() => {
      const selectedId = this.selectedTaskId();
      if (selectedId && this.diagram.isInitialized) {
        this.diagram.selectNode(selectedId);
      }
    }, { injector: this.injector });
    
    // ========== 命令服务订阅 ==========
    // 订阅居中到节点命令（来自 ProjectShellComponent）
    effect(() => {
      const cmd = this.flowCommand.centerNodeCommand();
      if (cmd) {
        // untracked 防止在此处读取其他信号时建立不必要的依赖
        untracked(() => {
          // 如果图表已就绪，立即执行
          if (this.diagram.isInitialized) {
            this.executeCenterOnNode(cmd.taskId, cmd.openDetail);
            this.flowCommand.clearCenterCommand();
          }
          // 如果未就绪，命令已被 flowCommand 缓存，将在 ngAfterViewInit 后执行
        });
      }
    }, { injector: this.injector });
    
    // 订阅重试初始化命令
    effect(() => {
      const count = this.flowCommand.retryDiagramCommand();
      if (count > 0) {
        untracked(() => {
          this.retryInitDiagram();
        });
      }
    }, { injector: this.injector });
    
    // 🎯 移动端：基于“调色板高度”为参考系，设置详情抽屉的最佳高度（vh）
    // 基准屏幕：高度 667px；调色板：80px。
    // - 场景一：在流程图内从“关闭 -> 打开”（直接点任务块自动展开） => 抽屉 24.88vh
    // - 场景二：从文本视图切回流程图时，详情本来就是打开状态         => 抽屉 8.62vh
    // 注意：移动端切换视图会销毁/重建 FlowView，因此“初次挂载且已打开”视为场景二。
    let isInitialized = false;
    let previousIsOpen = false;
    let lastDrawerPreset: 'none' | 'direct' | 'reenter' = 'none';
    effect(() => {
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      const justOpened = isDetailOpen && !previousIsOpen;
      const openedOnMount = !isInitialized && isDetailOpen;

      if (this.uiState.isMobile() && activeView === 'flow' && (justOpened || openedOnMount)) {
        untracked(() => {
          // 用户手动拖拽过则尊重手动高度，直到面板关闭
          if (this.drawerManualOverride()) return;
          if (typeof window === 'undefined' || window.innerHeight <= 0) return;

          const REFERENCE_SCREEN_HEIGHT = 667;
          const REFERENCE_PALETTE_HEIGHT_PX = 80;
          const DRAWER_VH_DIRECT_CLICK = 24.88; // 场景一：直接点击（基准屏幕）
          const DRAWER_VH_REENTER = 8.62;       // 场景二：切回 flow 且已打开（基准屏幕）

          // 把“基准 vh”转为基准像素，再换算成“抽屉像素 / 调色板像素”的比例
          const refDrawerPxDirect = (REFERENCE_SCREEN_HEIGHT * DRAWER_VH_DIRECT_CLICK) / 100;
          const refDrawerPxReenter = (REFERENCE_SCREEN_HEIGHT * DRAWER_VH_REENTER) / 100;
          const ratioDirect = refDrawerPxDirect / REFERENCE_PALETTE_HEIGHT_PX;   // ≈ 2.074
          const ratioReenter = refDrawerPxReenter / REFERENCE_PALETTE_HEIGHT_PX; // ≈ 0.719

          // 场景判定：
          // - 组件首次挂载且详情已开：属于“从文本切回来的复现场景”（场景二）
          // - 运行中从关到开：属于“直接点击任务块展开”（场景一）
          const isScenarioTwo = openedOnMount;
          const targetRatio = isScenarioTwo ? ratioReenter : ratioDirect;

          const palettePx = this.paletteHeight();
          const targetDrawerPx = palettePx * targetRatio;
          const targetVh = (targetDrawerPx / window.innerHeight) * 100;

          // 合理范围保护：避免极端屏幕把抽屉顶满
          const clampedVh = Math.max(5, Math.min(targetVh, 70));

          // 只有在差异明显时才更新，避免信号抖动
          if (Math.abs(this.drawerHeight() - clampedVh) > 0.2) {
            this.drawerHeight.set(clampedVh);
          }

          lastDrawerPreset = isScenarioTwo ? 'reenter' : 'direct';
        });
      }

      // 更新追踪状态
      previousIsOpen = isDetailOpen;
      isInitialized = true;

      // 详情关闭后，释放手动覆盖与预设标记
      if (!isDetailOpen) {
        lastDrawerPreset = 'none';
        this.drawerManualOverride.set(false);
      }
    }, { injector: this.injector });

    // 🎯 场景二之后：当详情已开且点击任务块时，自动切回“场景一”最佳高度
    effect(() => {
      const selectedId = this.selectedTaskId();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile() || activeView !== 'flow' || !isDetailOpen || !selectedId) return;
      if (this.drawerManualOverride()) return; // 手动拖拽时不覆盖
      if (lastDrawerPreset === 'direct') return; // 已经在场景一高度，无需重复
      if (typeof window === 'undefined' || window.innerHeight <= 0) return;

      const REFERENCE_SCREEN_HEIGHT = 667;
      const REFERENCE_PALETTE_HEIGHT_PX = 80;
      const DRAWER_VH_DIRECT_CLICK = 24.88;

      const refDrawerPxDirect = (REFERENCE_SCREEN_HEIGHT * DRAWER_VH_DIRECT_CLICK) / 100;
      const ratioDirect = refDrawerPxDirect / REFERENCE_PALETTE_HEIGHT_PX;

      const palettePx = this.paletteHeight();
      const targetDrawerPx = palettePx * ratioDirect;
      const targetVh = (targetDrawerPx / window.innerHeight) * 100;
      const clampedVh = Math.max(5, Math.min(targetVh, 70));

      if (Math.abs(this.drawerHeight() - clampedVh) > 0.2) {
        this.drawerHeight.set(clampedVh);
      }
      lastDrawerPreset = 'direct';
    }, { injector: this.injector });

    // 监听拖拽标记，用户一旦开始拖拽则启用手动覆盖
    effect(() => {
      if (this.isResizingDrawerSignal()) {
        this.drawerManualOverride.set(true);
      }
    }, { injector: this.injector });
    
    // 🎯 移动端：场景2（小抽屉）后，点击任务块应自动扩展到场景1的最佳位置
    effect(() => {
      const activeView = this.uiState.activeView();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const selectedTaskId = this.selectedTaskId();
      const isResizing = this.isResizingDrawerSignal();

      if (!this.uiState.isMobile()) return;
      if (activeView !== 'flow') return;
      if (!isDetailOpen) return;
      if (!selectedTaskId) return;
      if (isResizing) return;
      // 用户手动拖拽过则尊重手动高度，直到详情关闭
      if (this.drawerManualOverride()) return;

      if (typeof window === 'undefined' || window.innerHeight <= 0) return;

      const REFERENCE_SCREEN_HEIGHT = 667;
      const REFERENCE_PALETTE_HEIGHT_PX = 80;
      const DRAWER_VH_DIRECT_CLICK = 24.88;
      const refDrawerPxDirect = (REFERENCE_SCREEN_HEIGHT * DRAWER_VH_DIRECT_CLICK) / 100;
      const ratioDirect = refDrawerPxDirect / REFERENCE_PALETTE_HEIGHT_PX; // ≈ 2.074

      const palettePx = this.paletteHeight();
      const targetDrawerPx = palettePx * ratioDirect;
      const targetVh = (targetDrawerPx / window.innerHeight) * 100;
      const clampedVh = Math.max(5, Math.min(targetVh, 70));

      // 仅在“明显偏小”（典型为 8.62 场景）时提升，避免覆盖用户手动调大的高度
      // 注意：这里不要把 drawerHeight 作为依赖（否则用户拖拽到小高度会触发回弹）
      const currentVh = untracked(() => this.drawerHeight());
      const SMALL_DRAWER_THRESHOLD_VH = 12;
      if (currentVh < SMALL_DRAWER_THRESHOLD_VH && clampedVh - currentVh > 0.2) {
        this.drawerHeight.set(clampedVh);
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
      this.diagram.updateDiagram(this.projectState.tasks(), this.diagramUpdatePending);
      this.diagramUpdatePending = false;
    });
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.initDiagram();
    
    // 初始化完成后立即加载图表数据
    this.scheduleTimer(() => {
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.projectState.tasks());
        
        // 标记 View 已就绪
        this.flowCommand.markViewReady();
        
        // 检查并执行待处理的命令
        const pendingCmd = this.flowCommand.consumePendingCenterCommand();
        if (pendingCmd) {
          // 延迟执行，确保图表完全渲染
          this.scheduleTimer(() => {
            this.executeCenterOnNode(pendingCmd.taskId, pendingCmd.openDetail);
          }, 100);
        }
      }
    }, UI_CONFIG.MEDIUM_DELAY);
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 标记 View 已销毁
    this.flowCommand.markViewDestroyed();

    // 优先卸载 GoJS 监听 + 清理幽灵，避免残留 DOM/引用
    this.uninstallMobileDiagramDragGhostListeners();
    this.touch.endDiagramNodeDragGhost();
    
    // 清理所有待处理的定时器
    this.pendingTimers.forEach(clearTimeout);
    this.pendingTimers = [];
    
    // 清理 rAF
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }
    
    // 清理 Overview 刷新定时器
    if (this.overviewResizeTimer) {
      clearTimeout(this.overviewResizeTimer);
      this.overviewResizeTimer = null;
    }
    
    // 清理服务
    this.diagram.dispose();
    this.touch.dispose();
    this.link.dispose();
    this.dragDrop.dispose();
    this.taskOps.dispose();
    
    // 清理 Delete 键事件处理器
    flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
  }
  
  // ========== 图表初始化 ==========
  
  private initDiagram(): void {
    // 防御性检查：确保 DOM 元素已准备好
    if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
      this.logger.warn('[FlowView] diagramDiv 未准备好，跳过初始化');
      return;
    }

    // 若重复初始化（重试/重置），先移除旧监听并清理幽灵
    this.uninstallMobileDiagramDragGhostListeners();
    this.touch.endDiagramNodeDragGhost();

    const success = this.diagram.initialize(this.diagramDiv.nativeElement);
    if (!success) return;
    
    // 注册回调（通过 EventService）
    // 注：eventService.setDiagram() 已由 diagram.initialize() 内部调用
    this.eventService.onNodeClick((taskId, isDoubleClick) => {
      if (this.link.isLinkMode()) {
        const created = this.link.handleLinkModeClick(taskId);
        if (created) {
          this.refreshDiagram();
        }
      } else if (this.isSelectMode()) {
        // 移动端框选模式：点击切换选中状态
        this.selectionService.toggleNodeSelection(taskId);
      } else {
        this.selectedTaskId.set(taskId);
        if (isDoubleClick) {
          this.uiState.isFlowDetailOpen.set(true);
        }
      }
    });
    
    this.eventService.onLinkClick((linkData, x, y, isDoubleClick = false) => {
      console.log('[FlowView] onLinkClick 回调触发', { 
        linkData, 
        isCrossTree: linkData?.isCrossTree,
        x, 
        y,
        isMobile: this.uiState.isMobile(),
        isDoubleClick
      });
      
      // 移动端：单击打开编辑器（仅跨树连接），双击/长按显示删除提示
      if (this.uiState.isMobile()) {
        if (isDoubleClick) {
          console.log('[FlowView] 移动端长按/双击：显示删除提示');
          this.link.showLinkDeleteHint(linkData, x, y);
        } else if (linkData?.isCrossTree) {
          console.log('[FlowView] 移动端单击：打开跨树连接编辑器');
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '');
        }
        // 普通父子连接单击不做处理
      } else {
        // 桌面端：跨树连接线打开编辑器，普通连接线不处理（由右键菜单处理）
        if (linkData?.isCrossTree) {
          console.log('[FlowView] 桌面端：打开跨树连接编辑器', { from: linkData.from, to: linkData.to });
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '');
        }
      }
    });
    
    // 注册连接线删除回调（右键菜单）
    this.eventService.onLinkDelete((linkData) => {
      console.log('[FlowView] onLinkDelete 回调触发（右键菜单）', { linkData });
      const result = this.link.deleteLink(linkData);
      if (result) {
        console.log('[FlowView] 右键菜单删除成功', result);
        this.refreshDiagram();
      }
    });
    
    this.eventService.onLinkGesture((sourceId, targetId, x, y, gojsLink) => {
      // 移除临时连接线
      this.diagram.removeLink(gojsLink);
      
      const action = this.link.handleLinkGesture(sourceId, targetId, x, y);
      if (action === 'create-cross-tree' || action === 'create-parent-child' || action === 'replace-subtree') {
        this.refreshDiagram();
      }
    });
    
    // 注册连接线重连回调（子树迁移/跨树连接重连）
    this.eventService.onLinkRelink((linkType, relinkInfo, _x, _y, gojsLink) => {
      console.log('[FlowView] onLinkRelink 回调触发', { linkType, relinkInfo });
      
      // 移除 GoJS 中的临时连接线（实际数据由 store 管理）
      this.diagram.removeLink(gojsLink);
      
      const { changedEnd, oldFromId, oldToId, newFromId, newToId } = relinkInfo;
      
      if (linkType === 'parent-child') {
        // 父子连接重连
        if (changedEnd === 'from') {
          // from 端（父端）被改变：将子任务树迁移到新父任务下
          const result = this.link.handleParentChildRelink(newToId, oldFromId, newFromId);
          if (result === 'success') {
            this.refreshDiagram();
          }
        } else {
          // to 端（子端/下游端点）被改变：
          // 这是核心功能 - 用户将连接线下游端点拖到新的目标节点
          // 常见场景：将父子连接的下游端点拖到待分配块，触发子树替换
          console.log('[FlowView] 父子连接 to 端重连', { 
            parentId: newFromId, 
            oldChildId: oldToId, 
            newTargetId: newToId 
          });
          const result = this.link.handleParentChildRelinkToEnd(newFromId, oldToId, newToId);
          if (result === 'success' || result === 'replace-subtree') {
            this.refreshDiagram();
          }
        }
      } else if (linkType === 'cross-tree') {
        // 跨树连接重连：删除旧连接，创建新连接
        const result = this.link.handleCrossTreeRelink(
          oldFromId,
          oldToId,
          newFromId,
          newToId,
          changedEnd
        );
        if (result === 'success') {
          this.refreshDiagram();
        }
      }
    });
    
    this.eventService.onSelectionMoved((movedNodes) => {
      // 多节点移动时使用批处理模式，合并为单个撤销单元
      const needsBatch = movedNodes.length > 1;
      
      if (needsBatch) {
        this.taskOpsAdapter.beginPositionBatch();
      }
      
      try {
        movedNodes.forEach(node => {
          if (node.isUnassigned) {
            // 检测是否拖到连接线上
            const diagramInstance = this.diagram.diagramInstance;
            if (diagramInstance) {
              const loc = new go.Point(node.x, node.y);
              this.dragDrop.handleNodeMoved(node.key, loc, true, diagramInstance);
            }
          } else {
            // 单节点：带撤销的位置更新；批量：普通更新（由 endBatch 统一记录）
            if (needsBatch) {
              this.taskOpsAdapter.updateTaskPositionWithRankSync(node.key, node.x, node.y);
            } else {
              // 单节点拖拽完成，带撤销记录
              this.taskOpsAdapter.updateTaskPositionWithUndo(node.key, node.x, node.y);
            }
          }
        });
      } finally {
        if (needsBatch) {
          this.taskOpsAdapter.endPositionBatch();
        }
      }
    });
    
    this.eventService.onBackgroundClick(() => {
      console.log('[FlowView] backgroundClick 触发，关闭编辑器和删除提示');
      this.link.closeConnectionEditor();
      // 移动端：同时关闭删除提示
      if (this.uiState.isMobile()) {
        this.link.cancelLinkDelete();
      }
    });

    // 移动端：节点拖拽幽灵反馈（避免触摸时节点被手指遮挡导致“像没拖动”）
    // 注册 Delete 键事件处理（由 GoJS commandHandler 拦截后触发）
    // 通过事件总线解耦，确保单向数据流：Store -> Signal -> Diagram
    flowTemplateEventHandlers.onDeleteKeyPressed = () => {
      this.zone.run(() => {
        this.handleDeleteKeyPressed();
      });
    };

    this.installMobileDiagramDragGhostListeners();
    
    // 设置拖放处理
    this.diagram.setupDropHandler((taskData, docPoint) => {
      this.handleDiagramDrop(taskData, docPoint);
    });
    
    // 初始化小地图
    this.initOverview();
  }

  private installMobileDiagramDragGhostListeners(): void {
    if (!this.uiState.isMobile()) return;
    if (this.diagramSelectionMovedListener) return;

    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    // 注意：GoJS 没有 'SelectionMoving' 事件（会导致运行时错误）
    // 只使用 'SelectionMoved' 在拖拽结束时清理幽灵元素
    // 如果需要实时跟踪，应该监听 ToolManager 或使用 doMouseMove
    this.diagramSelectionMovedListener = () => {
      if (!this.uiState.isMobile()) return;
      this.touch.endDiagramNodeDragGhost();
    };

    diagramInstance.addDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
  }

  private uninstallMobileDiagramDragGhostListeners(): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    if (this.diagramSelectionMovedListener) {
      try {
        diagramInstance.removeDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
      } catch (error) {
        // 忽略移除监听器时的错误（图表可能已经被销毁）
        console.warn('[FlowView] 移除 SelectionMoved 监听器失败', error);
      }
      this.diagramSelectionMovedListener = null;
    }
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
      // 使用 requestAnimationFrame + setTimeout 确保 DOM 完全渲染后再初始化
      // 修复移动端展开小地图时只显示一半的问题
      requestAnimationFrame(() => {
        this.scheduleTimer(() => {
          if (this.overviewDiv?.nativeElement && this.diagram.isInitialized) {
            this.diagram.initializeOverview(this.overviewDiv.nativeElement);
          }
        }, 100); // 增加延迟时间，确保容器尺寸已确定
      });
    } else {
      // 折叠时销毁 Overview
      this.diagram.disposeOverview();
    }
  }

  onOverviewTogglePointerDown(e: PointerEvent): void {
    // 重要：GoJS 会在 canvas 上处理指针事件；这里提前截断，避免事件被 Overview 抢走导致按钮无响应。
    e.preventDefault();
    e.stopPropagation();
    this.toggleOverviewCollapse();
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
      // 在 Angular zone 内运行以确保变更检测
      this.zone.run(() => {
        // 再次检查 DOM 是否准备好
        if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
          this.logger.warn('[FlowView] 重试时 diagramDiv 仍未准备好，将再次重试');
          this.isRetryingDiagram.set(false);
          // 如果 DOM 未准备好，递归重试（会增加重试计数）
          this.scheduleTimer(() => this.retryInitDiagram(), 500);
          return;
        }

        this.initDiagram();
        if (this.diagram.isInitialized) {
          this.diagram.updateDiagram(this.projectState.tasks());
          // 成功后重置重试计数
          this.diagramRetryCount = 0;
          this.hasReachedRetryLimit.set(false);
          this.toast.success('加载成功', '流程图已就绪');
        }
        this.isRetryingDiagram.set(false);
      });
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
      this.zone.run(() => {
        // 检查 DOM 是否准备好
        if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
          this.logger.error('[FlowView] 重置时 diagramDiv 不可用');
          this.toast.error('重置失败', '视图未准备好，请稍后重试');
          return;
        }

        this.initDiagram();
        if (this.diagram.isInitialized) {
          this.diagram.updateDiagram(this.projectState.tasks());
          this.toast.success('重置成功', '流程图已就绪');
        } else {
          // 重置后仍然失败，显示错误但允许再次重试
          this.toast.error('重置失败', '流程图初始化失败，请尝试刷新页面');
        }
      });
    }, 200);
  }
  
  // ========== 图表操作 ==========
  
  zoomIn(): void {
    this.zoomService.zoomIn();
  }
  
  zoomOut(): void {
    this.zoomService.zoomOut();
  }
  
  applyAutoLayout(): void {
    this.layoutService.applyAutoLayout();
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

  /**
   * 居中到指定节点（公共 API，向后兼容）
   * 可被模板或外部直接调用
   */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    this.executeCenterOnNode(taskId, openDetail);
  }
  
  /**
   * 执行居中到节点（内部实现）
   * 供命令服务 effect 和公共方法调用
   */
  private executeCenterOnNode(taskId: string, openDetail: boolean): void {
    if (!this.diagram.isInitialized) {
      this.logger.warn('图表未初始化，无法居中到节点', { taskId });
      return;
    }
    this.zoomService.centerOnNode(taskId);
    this.selectedTaskId.set(taskId);
    if (openDetail) {
      this.uiState.isFlowDetailOpen.set(true);
    }
  }
  
  refreshLayout(): void {
    // 视图切换到 flow 后，触发一次“延后 auto-fit”的落地（若有）。
    this.diagram.onFlowActivated();
    this.zoomService.requestUpdate();
  }
  
  private refreshDiagram(): void {
    this.scheduleTimer(() => {
      this.diagram.updateDiagram(this.projectState.tasks());
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
  
  private handleDiagramDrop(taskData: Task, docPoint: go.Point): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    // 场景二：从待分配区域拖放到画布时，不应立刻"任务化"。
    // 仅更新位置，待后续"拉线"时再根据连接关系赋予阶段/序号。
    if (taskData?.stage === null) {
      // 同时更新 Store 和 GoJS 中的节点位置
      // Store 更新确保数据持久化，GoJS 更新确保视觉即时反馈
      this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
      this.layoutService.setNodePosition(taskData.id, docPoint.x, docPoint.y);
      return;
    }
    
    const insertInfo = this.dragDrop.findInsertPosition(docPoint, diagramInstance);
    
    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(taskData.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.projectState.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.taskOpsAdapter.moveTaskToStage(taskData.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.projectState.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        if (insertInfo.afterTaskId) {
          const siblings = this.projectState.tasks()
            .filter(t => t.stage === refTask.stage && t.parentId === refTask.parentId)
            .sort((a, b) => a.rank - b.rank);
          const afterIndex = siblings.findIndex(t => t.id === refTask.id);
          const nextSibling = siblings[afterIndex + 1];
          this.taskOpsAdapter.moveTaskToStage(taskData.id, refTask.stage, nextSibling?.id || null, refTask.parentId);
        } else {
          this.taskOpsAdapter.moveTaskToStage(taskData.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        }
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else {
      this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
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
    // 场景二（移动端）：待分配块拖入画布仅更新位置，不立刻任务化
    if (task.stage === null) {
      // 同时更新 Store 和 GoJS 中的节点位置
      // Store 更新确保数据持久化，GoJS 更新确保视觉即时反馈
      this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
      this.layoutService.setNodePosition(task.id, docPoint.x, docPoint.y);
      return;
    }

    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(task.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.projectState.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.taskOpsAdapter.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.projectState.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        this.taskOpsAdapter.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else {
      this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
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
  
  // ========== 级联分配对话框 ==========
  
  /**
   * 显示级联分配确认对话框
   * 当用户将待分配任务树拖拽到阶段区域时调用
   */
  showCascadeAssignDialog(
    taskId: string,
    targetStage: number,
    targetParentId: string | null
  ): void {
    const tasks = this.projectState.tasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    // 计算子树信息
    const subtreeCount = this.countSubtree(taskId, tasks);
    const subtreeDepth = this.getSubtreeDepth(taskId, tasks);
    
    const targetParent = targetParentId ? tasks.find(t => t.id === targetParentId) : null;
    
    this.cascadeAssignDialog.set({
      show: true,
      taskId,
      taskTitle: task.title || '未命名任务',
      targetStage,
      subtreeCount,
      targetParentId,
      targetParentTitle: targetParent?.title || null,
      subtreeDepth
    });
  }
  
  /**
   * 确认级联分配
   */
  confirmCascadeAssign(): void {
    const dialog = this.cascadeAssignDialog();
    if (!dialog) return;
    
    this.taskOpsAdapter.moveTaskToStage(
      dialog.taskId,
      dialog.targetStage,
      undefined,
      dialog.targetParentId
    );
    
    this.cascadeAssignDialog.set(null);
    this.refreshDiagram();
    this.toast.success('分配成功', `已将 ${dialog.subtreeCount} 个任务分配到阶段 ${dialog.targetStage}`);
  }
  
  /**
   * 取消级联分配
   */
  cancelCascadeAssign(): void {
    this.cascadeAssignDialog.set(null);
  }
  
  /**
   * 计算子树任务数量
   */
  private countSubtree(taskId: string, tasks: Task[]): number {
    const visited = new Set<string>();
    const stack = [taskId];
    
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      
      tasks.filter(t => t.parentId === id && !t.deletedAt)
        .forEach(child => stack.push(child.id));
    }
    
    return visited.size;
  }
  
  /**
   * 计算子树深度
   */
  private getSubtreeDepth(taskId: string, tasks: Task[]): number {
    let maxDepth = 0;
    const stack: { id: string; depth: number }[] = [{ id: taskId, depth: 0 }];
    
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      maxDepth = Math.max(maxDepth, depth);
      
      tasks.filter(t => t.parentId === id && !t.deletedAt)
        .forEach(child => stack.push({ id: child.id, depth: depth + 1 }));
    }
    
    return maxDepth;
  }
  
  /** 保存联系块的标题和描述 */
  saveConnectionDescription(data: { title: string; description: string }): void {
    this.link.saveConnectionContent(data.title, data.description);
    this.refreshDiagram();
  }
  
  deleteConnection(): void {
    console.log('[FlowView] deleteConnection 被调用');
    const result = this.link.deleteCurrentConnection();
    console.log('[FlowView] 删除结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  confirmLinkDelete(): void {
    console.log('[FlowView] confirmLinkDelete 被调用');
    const result = this.link.confirmLinkDelete();
    console.log('[FlowView] 删除连接线结果:', result);
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
        this.diagram.updateDiagram(this.projectState.tasks(), true);
      }
    }
  }
  
  // ========== 批量删除操作 ==========
  
  /**
   * 请求批量删除（由 Delete 键或工具栏按钮触发）
   * 计算删除影响并显示确认弹窗
   */
  requestBatchDelete(): void {
    const selectedIds = Array.from(this.selectionService.selectedTaskIds());
    if (selectedIds.length === 0) return;
    
    // 单选时走单任务删除流程
    if (selectedIds.length === 1) {
      const task = this.projectState.tasks().find(t => t.id === selectedIds[0]);
      if (task) {
        this.deleteTask(task);
      }
      return;
    }
    
    // 多选时计算删除影响并显示批量确认弹窗
    const impact = this.taskOps.calculateBatchDeleteImpact(selectedIds);
    
    this.batchDeleteDialog.set({
      selectedIds,
      impact
    });
  }
  
  /**
   * 确认批量删除
   */
  confirmBatchDelete(): void {
    const dialogData = this.batchDeleteDialog();
    if (!dialogData) return;
    
    // 清空选择和详情面板
    this.selectedTaskId.set(null);
    this.selectionService.clearSelection();
    
    // 执行批量删除
    const deletedCount = this.taskOps.deleteTasksBatch(dialogData.selectedIds);
    
    // 关闭弹窗
    this.batchDeleteDialog.set(null);
    
    // 显示成功提示
    if (deletedCount > 0) {
      this.toast.success('操作成功', `已删除 ${deletedCount} 个任务`);
    }
    
    // 强制刷新图表
    if (this.diagram.isInitialized) {
      this.diagram.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  /**
   * 处理 Delete 键删除事件（由 GoJS commandHandler 拦截后触发）
   */
  private handleDeleteKeyPressed(): void {
    const selectedIds = Array.from(this.selectionService.selectedTaskIds());
    if (selectedIds.length === 0) return;
    
    this.logger.debug(`Delete 键删除: ${selectedIds.length} 个选中任务`);
    this.requestBatchDelete();
  }
  
  /**
   * 切换移动端框选模式（框选 vs 平移）
   * - 框选模式：dragSelectingTool 启用，panningTool 禁用，点击节点切换选择状态
   * - 平移模式：panningTool 启用，dragSelectingTool 禁用，点击节点单选并显示详情
   */
  toggleSelectMode(): void {
    if (!this.uiState.isMobile()) {
      this.logger.debug('跳过桌面端框选模式切换');
      return;
    }

    const newMode = !this.isSelectMode();
    this.isSelectMode.set(newMode);
    
    console.log('[FlowView] 切换框选模式', { newMode, isMobile: this.uiState.isMobile() });
    
    const diagramInstance = this.diagram.diagramInstance;
    if (diagramInstance) {
      // 切换工具启用状态
      diagramInstance.toolManager.dragSelectingTool.isEnabled = newMode;
      diagramInstance.toolManager.panningTool.isEnabled = !newMode;

      console.log('[FlowView] 工具状态更新', {
        dragSelectingToolEnabled: diagramInstance.toolManager.dragSelectingTool.isEnabled,
        panningToolEnabled: diagramInstance.toolManager.panningTool.isEnabled
      });

      // 关键修改：保持 ClickSelectingTool 启用，但拦截其默认选择行为
      // 这样可以确保 click 事件被触发，从而让 FlowTemplateService 中的多选逻辑生效
      const clickTool = diagramInstance.toolManager.clickSelectingTool;
      clickTool.isEnabled = true;

      if (newMode) {
        // 进入框选模式：拦截 standardMouseSelect
        // 保存原始方法（如果还没保存）
        if (!this.originalStandardMouseSelect) {
          this.originalStandardMouseSelect = clickTool.standardMouseSelect.bind(clickTool);
        }
        // 覆盖为无操作，交由节点 click 事件处理多选
        clickTool.standardMouseSelect = function() {
          // Do nothing
        };
        
        this.logger.debug('移动端切换到框选模式：可拖拽框选或点击节点多选');
        this.toast.info('框选模式', '拖拽框选或点击节点多选');
      } else {
        // 退出框选模式：恢复 standardMouseSelect
        if (this.originalStandardMouseSelect) {
          clickTool.standardMouseSelect = this.originalStandardMouseSelect;
          this.originalStandardMouseSelect = undefined;
        }
        
        this.selectionService.clearSelection();
        this.logger.debug('移动端切换到平移模式：点击节点查看详情');
        this.toast.info('平移模式', '可拖拽移动画布');
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
      const selectedKeys = this.selectionService.getSelectedNodeKeys();
      if (!selectedKeys.length) return;
      
      event.preventDefault();
      event.stopPropagation();
      
      this.zone.run(() => {
        selectedKeys.forEach(id => this.taskOpsAdapter.detachTask(id));
      });
      return;
    }
    
    // Alt+X: 删除选中的连接线（跨树连接）
    if (key === 'x') {
      const selectedLinks: go.ObjectData[] = [];
      diagramInstance.selection.each((part: go.Part) => {
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
    if (this.uiState.isMobile()) {
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
    this.projectState.activeProjectId.set(projectId);
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
    if (!this.uiState.isMobile()) return;
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
    if (!this.uiState.isMobile()) return;
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
    if (!this.uiState.isMobile()) return;
    
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
      console.log('[FlowView] 滑动触发 goBackToText', { deltaX, threshold, deltaTime });
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
