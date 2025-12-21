/**
 * 服务模块统一导出
 * 从这里导入所有服务，保持导入路径整洁
 */

// 核心数据服务
export { StoreService } from './store.service';
export { ProjectStateService } from './project-state.service';
export { TaskRepositoryService } from './task-repository.service';
export { TaskOperationService, type CreateTaskParams, type MoveTaskParams, type InsertBetweenParams } from './task-operation.service';

// 新拆分服务（从 StoreService 提取）
export { UserSessionService } from './user-session.service';
export { PreferenceService } from './preference.service';
export { TaskOperationAdapterService } from './task-operation-adapter.service';
export { RemoteChangeHandlerService, type RemoteProjectChangePayload as RemoteProjectPayload, type RemoteTaskChangePayload as RemoteTaskPayload } from './remote-change-handler.service';

// 同步相关服务
// SyncService 已被 SimpleSyncService 替代，请从 '@app/core' 导入
export { SyncCoordinatorService } from './sync-coordinator.service';
export { ConflictResolutionService } from './conflict-resolution.service';
export { ActionQueueService, type QueuedAction, type DeadLetterItem, type EnqueueParams } from './action-queue.service';
export { ChangeTrackerService, type ChangeRecord, type ChangeType, type EntityType, type ProjectChangeSummary } from './change-tracker.service';

// 新增：借鉴思源笔记的同步增强服务
export { SyncModeService, type SyncMode, type SyncDirection, type SyncModeConfig } from './sync-mode.service';
export { ConflictStorageService, type ConflictRecord } from './conflict-storage.service';

// 认证服务
export { AuthService, type AuthResult, type AuthState } from './auth.service';
export { SupabaseClientService } from './supabase-client.service';

// 存储服务
export { 
  StorageAdapterService, 
  type StorageAdapter, 
  LocalStorageAdapter, 
  IndexedDBAdapter, 
  MemoryStorageAdapter,
  StorageQuotaError,
  STORAGE_ADAPTER,
  type StorageState 
} from './storage-adapter.service';

// UI 相关服务
export { ToastService, type ToastMessage, type ToastOptions, type ToastAction } from './toast.service';
export { LayoutService } from './layout.service';
export { ModalService, type ModalType, type ModalState, type ModalData } from './modal.service';
export { 
  DynamicModalService, 
  MODAL_DATA, 
  MODAL_REF,
  type ModalConfig, 
  type ModalRef 
} from './dynamic-modal.service';
export { BaseModalComponent, ConfirmModalComponent } from './base-modal.component';
export { UiStateService } from './ui-state.service';

// 功能服务
export { UndoService } from './undo.service';
export { GlobalErrorHandler, ErrorSeverity, CatchError } from './global-error-handler.service';
export { AttachmentService } from './attachment.service';
export { MigrationService } from './migration.service';
export { LoggerService } from './logger.service';
export { GoJSDiagramService, type DiagramCallbacks, type InsertPosition } from './gojs-diagram.service';
export { SearchService, type SearchResult, type ProjectSearchResult } from './search.service';
export { FlowDiagramConfigService, type GoJSNodeData, type GoJSLinkData, type GoJSDiagramData } from './flow-diagram-config.service';

// 流程图相关服务
export { FlowDiagramService, type NodeClickCallback, type LinkClickCallback, type LinkDeleteCallback, type LinkGestureCallback, type LinkRelinkCallback, type SelectionMovedCallback } from './flow-diagram.service';
export { FlowDragDropService, type InsertPositionInfo, type DropResultCallback } from './flow-drag-drop.service';
export { FlowTouchService, type TouchDropCallback } from './flow-touch.service';
export { FlowLinkService, type LinkType } from './flow-link.service';
export { FlowTaskOperationsService } from './flow-task-operations.service';
export { FlowSelectionService, type SelectedNodeInfo } from './flow-selection.service';
export { FlowZoomService, type ViewState } from './flow-zoom.service';
export { FlowLayoutService, type NodePosition, type LayoutOptions } from './flow-layout.service';
export { MinimapMathService, type WorldPoint, type MinimapPoint, type WorldBounds, type MinimapState, type DragSession, type RealTimeScaleResult, type VirtualBoundsResult } from './minimap-math.service';
export { ReactiveMinimapService, type MinimapElements, type NodePosition as MinimapNodePosition, type MainCanvasViewport, type ReactiveDragSession, type MinimapTransform } from './reactive-minimap.service';
export { LineageColorService, type LineageData, type LineageNodeData, type LineageLinkData } from './lineage-color.service';

// Guards
export { authGuard, saveAuthCache, getDataIsolationId } from './guards/auth.guard';
export { projectExistsGuard } from './guards/project.guard';
