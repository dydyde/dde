/**
 * StoreService - 门面服务 (Facade)
 * 
 * 【重要】此服务是一个纯门面（Pure Facade），严禁添加任何新业务逻辑！
 * 
 * 职责：
 * - 作为统一入口，协调各子服务
 * - 透传属性和方法到子服务
 * - 保持向后兼容的公共 API
 * 
 * 子服务架构：
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        StoreService (门面)                       │
 * └─────────────────────────────────────────────────────────────────┘
 *                                  │
 *          ┌───────────────────────┼───────────────────────┐
 *          ▼                       ▼                       ▼
 * ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
 * │ UserSessionService│   │TaskOperationAdapter│  │ PreferenceService│
 * │ - 用户登录/登出   │   │ - 任务 CRUD       │  │ - 主题管理      │
 * │ - 项目切换       │   │ - 撤销/重做协调    │  │ - 用户偏好      │
 * └─────────────────┘   └─────────────────┘   └─────────────────┘
 *          │                       │
 *          ▼                       ▼
 * ┌─────────────────┐   ┌─────────────────┐
 * │SyncCoordinatorService│  │RemoteChangeHandler│
 * │ - 持久化调度      │   │ - 实时更新处理   │
 * │ - 离线队列       │   └─────────────────┘
 * └─────────────────┘
 *          │
 *          ▼
 * ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
 * │ ProjectStateService│  │  UiStateService   │  │  SearchService   │
 * │ - 项目/任务状态   │  │ - UI 状态         │  │ - 搜索逻辑       │
 * └─────────────────┘   └─────────────────┘   └─────────────────┘
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { ActionQueueService } from './action-queue.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { SearchService } from './search.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { PreferenceService } from './preference.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { RemoteChangeHandlerService } from './remote-change-handler.service';
import { AttachmentService } from './attachment.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { 
  Task, Project, ThemeType, Attachment 
} from '../models';
import { 
  Result, OperationError, isFailure
} from '../utils/result';
import { TRASH_CONFIG } from '../config/constants';

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  // ========== 注入子服务 ==========
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Store');
  private authService = inject(AuthService);
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
  private actionQueue = inject(ActionQueueService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private searchService = inject(SearchService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private userSession = inject(UserSessionService);
  private preference = inject(PreferenceService);
  private taskAdapter = inject(TaskOperationAdapterService);
  private remoteChangeHandler = inject(RemoteChangeHandlerService);
  private attachmentService = inject(AttachmentService);
  private layoutService = inject(LayoutService);
  private optimisticState = inject(OptimisticStateService);
  private destroyRef = inject(DestroyRef);
  
  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // ========== 代理访问其他服务的状态（只读） ==========
  
  /** 当前用户 ID */
  readonly currentUserId = this.userSession.currentUserId;
  
  /** 是否正在同步 */
  readonly isSyncing = this.syncCoordinator.isSyncing;
  
  /** 是否在线 */
  readonly isOnline = this.syncCoordinator.isOnline;
  
  /** 离线模式 */
  readonly offlineMode = this.syncCoordinator.offlineMode;
  
  /** 会话是否过期 */
  readonly sessionExpired = this.syncCoordinator.sessionExpired;
  
  /** 同步错误 */
  readonly syncError = this.syncCoordinator.syncError;
  
  /** 是否有冲突 */
  readonly hasConflict = this.syncCoordinator.hasConflict;
  
  /** 冲突数据 */
  readonly conflictData = this.syncCoordinator.conflictData;
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.syncCoordinator.isLoadingRemote;
  
  /** 是否可以撤销 */
  readonly canUndo = this.undoService.canUndo;
  
  /** 是否可以重做 */
  readonly canRedo = this.undoService.canRedo;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.syncCoordinator.pendingActionsCount;
  
  // ========== UI 状态透传 → UiStateService ==========
  
  get isMobile() { return this.uiState.isMobile; }
  get sidebarWidth() { return this.uiState.sidebarWidth; }
  get textColumnRatio() { return this.uiState.textColumnRatio; }
  get layoutDirection() { return this.uiState.layoutDirection; }
  get floatingWindowPref() { return this.uiState.floatingWindowPref; }
  get isTextUnfinishedOpen() { return this.uiState.isTextUnfinishedOpen; }
  get isTextUnassignedOpen() { return this.uiState.isTextUnassignedOpen; }
  get isFlowUnfinishedOpen() { return this.uiState.isFlowUnfinishedOpen; }
  get isFlowUnassignedOpen() { return this.uiState.isFlowUnassignedOpen; }
  get isFlowDetailOpen() { return this.uiState.isFlowDetailOpen; }
  get searchQuery() { return this.uiState.searchQuery; }
  get projectSearchQuery() { return this.uiState.projectSearchQuery; }
  get activeView() { return this.uiState.activeView; }
  get filterMode() { return this.uiState.filterMode; }
  get stageViewRootFilter() { return this.uiState.stageViewRootFilter; }
  get stageFilter() { return this.uiState.stageFilter; }
  
  // ========== 主题透传 → PreferenceService ==========
  
  readonly theme = this.preference.theme;
  
  // ========== 核心数据状态透传 → ProjectStateService ==========
  
  get projects() { return this.projectState.projects; }
  get activeProjectId() { return this.projectState.activeProjectId; }
  
  readonly activeProject = this.projectState.activeProject;
  readonly tasks = this.projectState.tasks;
  readonly stages = this.projectState.stages;
  readonly unassignedTasks = this.projectState.unassignedTasks;
  readonly deletedTasks = this.projectState.deletedTasks;
  readonly unfinishedItems = this.projectState.unfinishedItems;
  readonly rootTasks = this.projectState.rootTasks;
  readonly allStage1Tasks = this.projectState.allStage1Tasks;
  
  // ========== 搜索结果透传 → SearchService ==========
  
  readonly searchResults = this.searchService.searchResults;
  readonly filteredProjects = this.searchService.filteredProjects;
  
  // ========== 冲突事件流（只读）==========
  
  /** 
   * 冲突事件流 - 从 SyncCoordinatorService 透传
   * 
   * 订阅者可以使用此 Observable 监听冲突事件：
   * - UI 组件可以弹出冲突解决模态框
   * - 日志服务可以记录冲突事件
   * - 自动解决器可以尝试智能合并
   * 
   * 示例：
   * ```typescript
   * store.onConflict$.subscribe(({ localProject, remoteProject, projectId }) => {
   *   modal.show('conflict', { localProject, remoteProject, projectId });
   * });
   * ```
   */
  readonly onConflict$ = this.syncCoordinator.onConflict$;

  constructor() {
    // 初始化远程变更处理
    this.remoteChangeHandler.setupCallbacks(() => this.userSession.loadProjects());
    
    // 设置附件 URL 刷新回调
    this.setupAttachmentUrlRefresh();
    
    // 启动回收站清理定时器
    this.startTrashCleanupTimer();
    
    // 清理
    this.destroyRef.onDestroy(() => {
      this.undoService.flushPendingAction();
      if (this.trashCleanupTimer) clearInterval(this.trashCleanupTimer);
      this.attachmentService.clearUrlRefreshCallback();
      this.attachmentService.clearMonitoredAttachments();
      this.syncCoordinator.destroy();
    });
  }
  
  // ========== 用户会话：委托给 UserSessionService ==========

  async setCurrentUser(userId: string | null) {
    await this.userSession.setCurrentUser(userId);
    if (userId) {
      await this.preference.loadUserPreferences();
    } else {
      this.preference.loadLocalPreferences();
    }
  }
  
  switchActiveProject(projectId: string | null) {
    this.userSession.switchActiveProject(projectId);
  }

  async loadProjects() {
    await this.userSession.loadProjects();
  }

  clearLocalData() {
    this.userSession.clearLocalData();
  }
  
  // ========== 主题设置：委托给 PreferenceService ==========
  
  async setTheme(theme: ThemeType) {
    await this.preference.setTheme(theme);
  }
  
  // ========== 撤销/重做：包装 UndoService ==========

  undo() {
    const activeProject = this.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);
    
    if (!result) return;
    
    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。请查看历史版本或刷新页面。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }
    
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意', 
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before);
      }
      return;
    }
    
    const action = result;
    const project = this.projects().find(p => p.id === action.projectId);
    if (project) {
      const localVersion = project.version ?? 0;
      const snapshotVersion = (action.data.before as any)?.version ?? 0;
      
      if (localVersion > snapshotVersion + 1) {
        this.toastService.warning('注意', '撤销可能会覆盖其他设备的更新');
      }
    }
    
    this.applyProjectSnapshot(action.projectId, action.data.before);
  }

  redo() {
    const activeProject = this.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.redo(currentVersion);
    
    if (!result) return;
    
    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }
    
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }
    
    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.after);
  }

  // ========== 冲突解决：委托给 SyncCoordinatorService ==========

  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    const localProject = this.projects().find(p => p.id === projectId);
    if (!localProject) return;
    
    const remoteProject = conflictData.remoteData as Project | undefined;
    
    const result = await this.syncCoordinator.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
    
    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return;
    }
    
    const resolvedProject = this.syncCoordinator.validateAndRebalance(result.value);
    
    this.projectState.updateProjects(ps => ps.map(p => 
      p.id === projectId ? resolvedProject : p
    ));
    
    if (this.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }
    
    if (choice !== 'remote') {
      const userId = this.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.syncCoordinator.saveProjectToCloud(resolvedProject, userId);
          if (!syncResult.success && !syncResult.conflict) {
            this.actionQueue.enqueue({
              type: 'update',
              entityType: 'project',
              entityId: projectId,
              payload: { project: resolvedProject }
            });
            this.toastService.warning('同步待重试', '冲突已解决，但同步失败，稍后将自动重试');
          } else if (syncResult.conflict) {
            this.toastService.error('同步冲突', '解决冲突后又发生新冲突，请稍后重试');
          }
        } catch (_e) {
          this.actionQueue.enqueue({
            type: 'update',
            entityType: 'project',
            entityId: projectId,
            payload: { project: resolvedProject }
          });
        }
      }
    }
    
    this.syncCoordinator.saveOfflineSnapshot(this.projects());
  }

  // ========== 项目操作 ==========

  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-create', '创建项目');
    
    // 乐观更新：立即显示新项目
    this.projectState.updateProjects(p => [...p, balanced]);
    this.projectState.setActiveProjectId(balanced.id);
    
    const userId = this.currentUserId();
    if (userId) {
      try {
        const result = await this.syncCoordinator.saveProjectToCloud(balanced, userId);
        
        if (!result.success && !result.conflict) {
          if (!this.isOnline()) {
            // 离线模式：加入队列，保留乐观更新
            this.actionQueue.enqueue({
              type: 'create',
              entityType: 'project',
              entityId: balanced.id,
              payload: { project: balanced }
            });
            this.toastService.info('离线创建', '项目将在网络恢复后同步到云端');
            // 提交快照（稍后同步）
            this.optimisticState.commitSnapshot(snapshot.id);
          } else {
            // 在线但同步失败：回滚
            this.optimisticState.rollbackSnapshot(snapshot.id, false);
            this.toastService.error('创建失败', '无法保存项目到云端，请稍后重试');
            return { success: false, error: '同步失败' };
          }
        } else if (result.conflict) {
          this.toastService.warning('数据冲突', '检测到数据冲突，请检查');
          // 冲突时提交快照，交给冲突解决流程处理
          this.optimisticState.commitSnapshot(snapshot.id);
        } else {
          // 成功：提交快照
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        // 异常：回滚
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('创建失败', '发生未知错误，请稍后重试');
        return { success: false, error: '未知错误' };
      }
    } else {
      // 未登录：提交快照（本地保存）
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.schedulePersist();
    return { success: true };
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.currentUserId();
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    
    // 乐观更新：立即从列表中移除
    this.projectState.updateProjects(p => p.filter(proj => proj.id !== projectId));
    
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      try {
        const success = await this.syncCoordinator.deleteProjectFromCloud(projectId, userId);
        
        if (!success) {
          if (!this.isOnline()) {
            // 离线模式：加入队列，保留乐观更新
            this.actionQueue.enqueue({
              type: 'delete',
              entityType: 'project',
              entityId: projectId,
              payload: { projectId, userId }
            });
            this.toastService.info('离线删除', '项目将在网络恢复后同步删除');
            // 提交快照（稍后同步）
            this.optimisticState.commitSnapshot(snapshot.id);
          } else {
            // 在线但同步失败：回滚
            this.optimisticState.rollbackSnapshot(snapshot.id, false);
            this.toastService.error('删除失败', '无法从云端删除项目，请稍后重试');
            return { success: false, error: '同步失败' };
          }
        } else {
          // 成功：提交快照
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        // 异常：回滚
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('删除失败', '发生未知错误，请稍后重试');
        return { success: false, error: '未知错误' };
      }
    } else {
      // 未登录：提交快照（本地保存）
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.saveOfflineSnapshot(this.projects());
    return { success: true };
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projectState.updateProjects(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.syncCoordinator.schedulePersist();
    }
  }

  renameProject(projectId: string, newName: string) {
    if (!newName.trim()) return;
    this.projectState.updateProjects(projects => projects.map(p => 
      p.id === projectId ? { ...p, name: newName.trim() } : p
    ));
    this.syncCoordinator.schedulePersist();
  }

  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }) {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          viewState: {
            scale: viewState.scale ?? p.viewState?.scale ?? 1,
            positionX: viewState.positionX ?? p.viewState?.positionX ?? 0,
            positionY: viewState.positionY ?? p.viewState?.positionY ?? 0
          }
        };
      }
      return p;
    }));
    this.syncCoordinator.schedulePersist();
  }

  /**
   * 更新项目的流程图缩略图 URL
   * @param projectId 项目 ID
   * @param flowchartUrl 流程图完整图片 URL
   * @param thumbnailUrl 流程图缩略图 URL（可选）
   */
  updateProjectFlowchartUrl(projectId: string, flowchartUrl: string, thumbnailUrl?: string) {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          flowchartUrl,
          flowchartThumbnailUrl: thumbnailUrl
        };
      }
      return p;
    }));
    this.syncCoordinator.schedulePersist();
  }

  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    return this.projectState.getViewState();
  }

  // ========== 任务操作：委托给 TaskOperationAdapterService ==========

  compressDisplayId(displayId: string): string {
    return this.projectState.compressDisplayId(displayId);
  }

  markEditing() {
    this.taskAdapter.markEditing();
  }
  
  get isUserEditing(): boolean {
    return this.taskAdapter.isUserEditing;
  }

  updateTaskContent(taskId: string, newContent: string) {
    this.taskAdapter.updateTaskContent(taskId, newContent);
  }

  addTodoItem(taskId: string, itemText: string) {
    this.taskAdapter.addTodoItem(taskId, itemText);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string) {
    this.taskAdapter.completeUnfinishedItem(taskId, itemText);
  }

  updateTaskTitle(taskId: string, title: string) {
    this.taskAdapter.updateTaskTitle(taskId, title);
  }

  updateTaskPosition(taskId: string, x: number, y: number) {
    this.taskAdapter.updateTaskPosition(taskId, x, y);
  }
  
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number) {
    this.taskAdapter.updateTaskPositionWithRankSync(taskId, x, y);
  }
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.taskAdapter.getLastUpdateType();
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.taskAdapter.updateTaskStatus(taskId, status);
  }
  
  updateTaskAttachments(taskId: string, attachments: Attachment[]) {
    this.taskAdapter.updateTaskAttachments(taskId, attachments);
  }

  addTaskAttachment(taskId: string, attachment: Attachment) {
    this.taskAdapter.addTaskAttachment(taskId, attachment);
  }

  removeTaskAttachment(taskId: string, attachmentId: string) {
    this.taskAdapter.removeTaskAttachment(taskId, attachmentId);
  }

  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined) {
    this.taskAdapter.updateTaskPriority(taskId, priority);
  }

  updateTaskDueDate(taskId: string, dueDate: string | null) {
    this.taskAdapter.updateTaskDueDate(taskId, dueDate);
  }

  updateTaskTags(taskId: string, tags: string[]) {
    this.taskAdapter.updateTaskTags(taskId, tags);
  }

  addTaskTag(taskId: string, tag: string) {
    this.taskAdapter.addTaskTag(taskId, tag);
  }

  removeTaskTag(taskId: string, tag: string) {
    this.taskAdapter.removeTaskTag(taskId, tag);
  }

  deleteTask(taskId: string) {
    this.taskAdapter.deleteTask(taskId);
  }

  permanentlyDeleteTask(taskId: string) {
    this.taskAdapter.permanentlyDeleteTask(taskId);
  }

  restoreTask(taskId: string) {
    this.taskAdapter.restoreTask(taskId);
  }

  emptyTrash() {
    this.taskAdapter.emptyTrash();
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): Result<string, OperationError> {
    return this.taskAdapter.addTask(title, content, targetStage, parentId, isSibling);
  }

  addCrossTreeConnection(sourceId: string, targetId: string) {
    this.taskAdapter.addCrossTreeConnection(sourceId, targetId);
  }

  removeConnection(sourceId: string, targetId: string) {
    this.taskAdapter.removeConnection(sourceId, targetId);
  }

  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string) {
    this.taskAdapter.updateConnectionContent(sourceId, targetId, title, description);
  }

  /**
   * 更新连接描述（兼容旧 API）
   * @deprecated 使用 updateConnectionContent 代替
   */
  updateConnectionDescription(sourceId: string, targetId: string, description: string) {
    this.taskAdapter.updateConnectionContent(sourceId, targetId, '', description);
  }

  getTaskConnections(taskId: string) {
    return this.projectState.getTaskConnections(taskId);
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    this.taskAdapter.addFloatingTask(title, content, x, y);
  }
  
  moveTaskToStage(
    taskId: string, 
    newStage: number | null, 
    beforeTaskId?: string | null, 
    newParentId?: string | null
  ): Result<void, OperationError> {
    return this.taskAdapter.moveTaskToStage(taskId, newStage, beforeTaskId, newParentId);
  }

  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    return this.taskAdapter.insertTaskBetween(taskId, sourceId, targetId);
  }

  /**
   * 将整个子任务树迁移到新的父任务下
   * @param taskId 要迁移的子树根节点 ID
   * @param newParentId 新父任务 ID（null 表示迁移到 stage 1 根节点）
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    return this.taskAdapter.moveSubtreeToNewParent(taskId, newParentId);
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.taskAdapter.reorderStage(stage, orderedIds);
  }

  detachTask(taskId: string) {
    this.taskAdapter.detachTask(taskId);
  }
  
  /**
   * 分离任务及其整个子树（移回待分配区）
   * 
   * 【浮动任务树方法】
   * 保留子树内部父子关系，仅断开根节点与外部的连接
   */
  detachTaskWithSubtree(taskId: string) {
    return this.taskAdapter.detachTaskWithSubtree(taskId);
  }
  
  deleteTaskKeepChildren(taskId: string) {
    this.taskAdapter.deleteTaskKeepChildren(taskId);
  }

  isStageRebalancing(stage: number): boolean {
    return this.taskAdapter.isStageRebalancing(stage);
  }

  // ========== 视图控制：委托给 UiStateService ==========

  toggleView(view: 'text' | 'flow') {
    this.uiState.toggleView(view);
  }

  ensureView(view: 'text' | 'flow') {
    this.uiState.ensureView(view);
  }

  setStageFilter(stage: number | 'all') {
    this.uiState.setStageFilter(stage);
  }

  // ========== 搜索辅助方法：委托给 UiStateService ==========
  
  setSearchQueryDebounced(query: string, delay: number = 300): void {
    this.uiState.setSearchQueryDebounced(query, delay);
  }
  
  clearSearch(): void {
    this.uiState.clearSearch();
  }

  // ========== 私有辅助方法 ==========

  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>) {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
  }

  private startTrashCleanupTimer() {
    const cleanedCount = this.taskAdapter.cleanupOldTrashItems();
    if (cleanedCount > 0) {
      this.logger.info(`启动时清理了 ${cleanedCount} 个超期回收站任务`);
    }
    
    this.trashCleanupTimer = setInterval(() => {
      const count = this.taskAdapter.cleanupOldTrashItems();
      if (count > 0) {
        this.logger.info(`定期清理了 ${count} 个超期回收站任务`);
        this.syncCoordinator.schedulePersist();
      }
    }, TRASH_CONFIG.CLEANUP_INTERVAL);
  }

  private setupAttachmentUrlRefresh() {
    this.attachmentService.setUrlRefreshCallback((refreshedUrls) => {
      if (refreshedUrls.size === 0) return;
      
      this.projectState.updateProjects(projects => projects.map(project => {
        let hasChanges = false;
        const updatedTasks = project.tasks.map(task => {
          if (!task.attachments || task.attachments.length === 0) return task;
          
          const updatedAttachments = task.attachments.map(attachment => {
            const refreshed = refreshedUrls.get(attachment.id);
            if (refreshed) {
              hasChanges = true;
              return {
                ...attachment,
                url: refreshed.url,
                thumbnailUrl: refreshed.thumbnailUrl ?? attachment.thumbnailUrl
              };
            }
            return attachment;
          });
          
          return hasChanges ? { ...task, attachments: updatedAttachments } : task;
        });
        
        return hasChanges ? { ...project, tasks: updatedTasks } : project;
      }));
    });
  }
}
