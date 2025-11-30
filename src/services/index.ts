/**
 * 服务模块统一导出
 * 从这里导入所有服务，保持导入路径整洁
 */

// 核心数据服务
export { StoreService } from './store.service';
export { ProjectStateService } from './project-state.service';
export { TaskRepositoryService } from './task-repository.service';

// 同步相关服务
export { SyncService, type RemoteProjectChangePayload, type RemoteTaskChangePayload } from './sync.service';
export { SyncCoordinatorService } from './sync-coordinator.service';
export { ConflictResolutionService } from './conflict-resolution.service';
export { ActionQueueService, type QueuedAction, type DeadLetterItem, type EnqueueParams } from './action-queue.service';

// 认证服务
export { AuthService } from './auth.service';
export { SupabaseClientService } from './supabase-client.service';

// UI 相关服务
export { ToastService, type ToastMessage } from './toast.service';
export { LayoutService } from './layout.service';
export { ModalService, type ModalType, type ModalState, type ModalData } from './modal.service';

// 功能服务
export { UndoService } from './undo.service';
export { GlobalErrorHandler, ErrorSeverity, CatchError } from './global-error-handler.service';
export { AttachmentService } from './attachment.service';
export { MigrationService } from './migration.service';
export { LoggerService } from './logger.service';
export { GoJSDiagramService, type DiagramCallbacks, type InsertPosition } from './gojs-diagram.service';

// Guards
export { authGuard, saveAuthCache, getDataIsolationId } from './guards/auth.guard';
export { projectExistsGuard, projectAccessGuard } from './guards/project.guard';
