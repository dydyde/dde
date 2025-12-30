/**
 * StoreService - 门面服务 (Facade)
 * 
 * 【重要】此服务是一个纯门面（Pure Facade），严禁添加任何新业务逻辑！
 * 
 * ============================================================================
 * 【迁移指南 - P2-1 渐进式迁移计划】
 * ============================================================================
 * 
 * ⚠️ 新代码禁止使用 inject(StoreService)！
 * ✅ 新代码应直接注入所需子服务：
 * 
 * ```typescript
 * // ❌ 禁止
 * private readonly store = inject(StoreService);
 * this.store.addTask(...);
 * 
 * // ✅ 推荐
 * private readonly taskOps = inject(TaskOperationAdapterService);
 * private readonly projectState = inject(ProjectStateService);
 * this.taskOps.addTask(...);
 * ```
 * 
 * 可用子服务及职责：
 * - UiStateService: UI 状态（视图切换、过滤器、侧边栏）
 * - ProjectStateService: 项目/任务状态读取、项目元数据修改
 * - SyncCoordinatorService: 同步调度、在线状态、冲突检测
 * - UserSessionService: 用户登录/登出、项目切换
 * - PreferenceService: 主题、用户偏好
 * - TaskOperationAdapterService: 任务 CRUD、撤销/重做
 * 
 * 此门面将逐步精简，最终仅保留跨服务协调的复杂方法。
 * ============================================================================
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
import { ChangeTrackerService } from './change-tracker.service';
import { 
  Task, Project, ThemeType, Attachment 
} from '../models';
import { 
  Result, OperationError, isFailure
} from '../utils/result';
import { TRASH_CONFIG } from '../config';

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  // ========== 注入子服务 ==========
  // 【重构优化】将常用子服务暴露为 readonly，调用方可直接访问
  // 减少透传方法，降低维护成本
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Store');
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
  private actionQueue = inject(ActionQueueService);
  
  /** UI 状态服务 - 可直接访问以减少透传 */
  readonly ui = inject(UiStateService);
  
  /** 项目状态服务 - 可直接访问以减少透传 */
  readonly project = inject(ProjectStateService);
  
  private searchService = inject(SearchService);
  
  /** 同步协调服务 - 可直接访问以减少透传 */
  readonly sync = inject(SyncCoordinatorService);
  
  /** 用户会话服务 - 可直接访问以减少透传 */
  readonly session = inject(UserSessionService);
  
  /** 偏好设置服务 - 可直接访问以减少透传 */
  readonly pref = inject(PreferenceService);
  
  /** 任务操作服务 - 可直接访问以减少透传 */
  readonly taskOps = inject(TaskOperationAdapterService);
  
  private remoteChangeHandler = inject(RemoteChangeHandlerService);
  private attachmentService = inject(AttachmentService);
  private layoutService = inject(LayoutService);
  private optimisticState = inject(OptimisticStateService);
  private changeTracker = inject(ChangeTrackerService);
  private destroyRef = inject(DestroyRef);
  
  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // ========== 代理访问其他服务的状态（只读） ==========
  
  /** 当前用户 ID */
  readonly currentUserId = this.session.currentUserId;
  
  /** 是否正在同步 */
  readonly isSyncing = this.sync.isSyncing;
  
  /** 是否在线 */
  readonly isOnline = this.sync.isOnline;
  
  /** 离线模式 */
  readonly offlineMode = this.sync.offlineMode;
  
  /** 会话是否过期 */
  readonly sessionExpired = this.sync.sessionExpired;
  
  /** 同步错误 */
  readonly syncError = this.sync.syncError;
  
  /** 是否有冲突 */
  readonly hasConflict = this.sync.hasConflict;
  
  /** 冲突数据 */
  readonly conflictData = this.sync.conflictData;
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.sync.isLoadingRemote;
  
  /** 是否可以撤销 */
  readonly canUndo = this.undoService.canUndo;
  
  /** 是否可以重做 */
  readonly canRedo = this.undoService.canRedo;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.sync.pendingActionsCount;
  
  // ========== UI 状态透传 → UiStateService ==========
  
  get isMobile() { return this.ui.isMobile; }
  get sidebarWidth() { return this.ui.sidebarWidth; }
  get textColumnRatio() { return this.ui.textColumnRatio; }
  get layoutDirection() { return this.ui.layoutDirection; }
  get floatingWindowPref() { return this.ui.floatingWindowPref; }
  get isTextUnfinishedOpen() { return this.ui.isTextUnfinishedOpen; }
  get isTextUnassignedOpen() { return this.ui.isTextUnassignedOpen; }
  get isFlowUnfinishedOpen() { return this.ui.isFlowUnfinishedOpen; }
  get isFlowUnassignedOpen() { return this.ui.isFlowUnassignedOpen; }
  get isFlowDetailOpen() { return this.ui.isFlowDetailOpen; }
  get searchQuery() { return this.ui.searchQuery; }
  get projectSearchQuery() { return this.ui.projectSearchQuery; }
  get activeView() { return this.ui.activeView; }
  get filterMode() { return this.ui.filterMode; }
  get stageViewRootFilter() { return this.ui.stageViewRootFilter; }
  get stageFilter() { return this.ui.stageFilter; }
  
  // ========== 主题透传 → PreferenceService ==========
  
  readonly theme = this.pref.theme;
  
  // ========== 核心数据状态透传 → ProjectStateService ==========
  
  get projects() { return this.project.projects; }
  get activeProjectId() { return this.project.activeProjectId; }
  
  readonly activeProject = this.project.activeProject;
  readonly tasks = this.project.tasks;
  readonly stages = this.project.stages;
  readonly unassignedTasks = this.project.unassignedTasks;
  readonly deletedTasks = this.project.deletedTasks;
  readonly unfinishedItems = this.project.unfinishedItems;
  readonly rootTasks = this.project.rootTasks;
  readonly allStage1Tasks = this.project.allStage1Tasks;
  
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
  readonly onConflict$ = this.sync.onConflict$;

  constructor() {
    // 初始化远程变更处理
    this.remoteChangeHandler.setupCallbacks(() => this.session.loadProjects());
    
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
      this.sync.destroy();
    });
  }
  
  // ========== 用户会话：委托给 UserSessionService ==========

  async setCurrentUser(userId: string | null) {
    await this.session.setCurrentUser(userId);
    if (userId) {
      await this.pref.loadUserPreferences();
    } else {
      this.pref.loadLocalPreferences();
    }
  }
  
  switchActiveProject(projectId: string | null) {
    this.session.switchActiveProject(projectId);
  }

  async loadProjects() {
    await this.session.loadProjects();
  }

  clearLocalData() {
    this.session.clearLocalData();
  }
  
  // ========== 主题设置：委托给 PreferenceService ==========
  
  async setTheme(theme: ThemeType) {
    await this.pref.setTheme(theme);
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
      const snapshotVersion = (action.data.before as { version?: number })?.version ?? 0;
      
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
    
    const result = await this.sync.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
    
    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return;
    }
    
    const resolvedProject = this.sync.validateAndRebalance(result.value);
    
    this.project.updateProjects(ps => ps.map(p => 
      p.id === projectId ? resolvedProject : p
    ));
    
    if (this.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }
    
    if (choice !== 'remote') {
      const userId = this.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.sync.saveProjectToCloud(resolvedProject, userId);
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
    
    this.sync.saveOfflineSnapshot(this.projects());
  }

  // ========== 项目操作 ==========

  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-create', '创建项目');
    
    // 乐观更新：立即显示新项目
    this.project.updateProjects(p => [...p, balanced]);
    this.project.setActiveProjectId(balanced.id);
    
    const userId = this.currentUserId();
    if (userId) {
      try {
        const result = await this.sync.saveProjectToCloud(balanced, userId);
        
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
    
    this.sync.schedulePersist();
    return { success: true };
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.currentUserId();
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    
    // 乐观更新：立即从列表中移除
    this.project.updateProjects(p => p.filter(proj => proj.id !== projectId));
    
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.project.setActiveProjectId(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      try {
        const success = await this.sync.deleteProjectFromCloud(projectId, userId);
        
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
    
    this.sync.saveOfflineSnapshot(this.projects());
    return { success: true };
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.project.updateProjects(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.sync.schedulePersist();
    }
  }

  renameProject(projectId: string, newName: string): boolean {
    const success = this.project.renameProject(projectId, newName);
    if (success) {
      this.sync.schedulePersist();
    }
    return success;
  }

  /**
   * @deprecated 请直接注入 ProjectStateService 并调用 projectState.updateViewState()
   */
  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }) {
    this.project.updateViewState(projectId, viewState);
    this.sync.schedulePersist();
  }

  /**
   * 更新项目的流程图缩略图 URL
   * @param projectId 项目 ID
   * @param flowchartUrl 流程图完整图片 URL
   * @param thumbnailUrl 流程图缩略图 URL（可选）
   */
  updateProjectFlowchartUrl(projectId: string, flowchartUrl: string, thumbnailUrl?: string) {
    this.project.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          flowchartUrl,
          flowchartThumbnailUrl: thumbnailUrl
        };
      }
      return p;
    }));
    this.sync.schedulePersist();
  }

  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    return this.project.getViewState();
  }

  // ========== 任务操作：委托给 TaskOperationAdapterService ==========

  compressDisplayId(displayId: string): string {
    return this.project.compressDisplayId(displayId);
  }

  markEditing() {
    this.taskOps.markEditing();
  }
  
  get isUserEditing(): boolean {
    return this.taskOps.isUserEditing;
  }

  // ========== 字段锁操作（Split-Brain 模式支持）==========
  
  /**
   * 锁定任务的指定字段（用于 Split-Brain 输入模式）
   * 当用户聚焦输入框时调用，防止远程更新覆盖正在输入的内容
   * 
   * @param taskId 任务 ID
   * @param fields 要锁定的字段列表（如 ['title', 'content']）
   * @param durationMs 锁定时长，默认 1 小时（文本输入场景）
   */
  lockTaskFields(taskId: string, fields: string[], durationMs?: number): void {
    const projectId = this.project.activeProjectId();
    if (!projectId) return;
    
    const duration = durationMs ?? ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS;
    for (const field of fields) {
      this.changeTracker.lockTaskField(taskId, projectId, field, duration);
    }
  }
  
  /**
   * 解锁任务的指定字段
   * 当用户完成输入（blur 事件）后延迟调用，等待同步完成
   * 
   * @param taskId 任务 ID
   * @param fields 要解锁的字段列表
   */
  unlockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.project.activeProjectId();
    if (!projectId) return;
    
    for (const field of fields) {
      this.changeTracker.unlockTaskField(taskId, projectId, field);
    }
  }

  /**
   * @deprecated 请直接注入 TaskOperationAdapterService 并调用 taskOps.updateTaskContent()
   */
  updateTaskContent(taskId: string, newContent: string) {
    this.taskOps.updateTaskContent(taskId, newContent);
  }

  addTodoItem(taskId: string, itemText: string) {
    this.taskOps.addTodoItem(taskId, itemText);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string) {
    this.taskOps.completeUnfinishedItem(taskId, itemText);
  }

  /**
   * @deprecated 请直接注入 TaskOperationAdapterService 并调用 taskOps.updateTaskTitle()
   */
  updateTaskTitle(taskId: string, title: string) {
    this.taskOps.updateTaskTitle(taskId, title);
  }

  /**
   * @deprecated 请直接注入 TaskOperationAdapterService 并调用 taskOps.updateTaskPosition()
   */
  updateTaskPosition(taskId: string, x: number, y: number) {
    this.taskOps.updateTaskPosition(taskId, x, y);
  }
  
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number) {
    this.taskOps.updateTaskPositionWithRankSync(taskId, x, y);
  }
  
  /**
   * 更新任务位置（带撤销支持）
   * 用于单个节点拖拽完成后的位置更新
   */
  updateTaskPositionWithUndo(taskId: string, x: number, y: number) {
    this.taskOps.updateTaskPositionWithUndo(taskId, x, y);
  }
  
  /**
   * 开始位置拖拽批次
   * 在拖拽开始时调用，记录初始状态用于撤销
   */
  beginPositionBatch() {
    this.taskOps.beginPositionBatch();
  }
  
  /**
   * 结束位置拖拽批次
   * 在拖拽结束时调用，将所有位置变更作为单个撤销单元记录
   */
  endPositionBatch() {
    this.taskOps.endPositionBatch();
  }
  
  /**
   * 取消位置拖拽批次（不记录撤销）
   */
  cancelPositionBatch() {
    this.taskOps.cancelPositionBatch();
  }
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.taskOps.getLastUpdateType();
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.taskOps.updateTaskStatus(taskId, status);
  }
  
  updateTaskAttachments(taskId: string, attachments: Attachment[]) {
    this.taskOps.updateTaskAttachments(taskId, attachments);
  }

  addTaskAttachment(taskId: string, attachment: Attachment) {
    this.taskOps.addTaskAttachment(taskId, attachment);
  }

  removeTaskAttachment(taskId: string, attachmentId: string) {
    this.taskOps.removeTaskAttachment(taskId, attachmentId);
  }

  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined) {
    this.taskOps.updateTaskPriority(taskId, priority);
  }

  updateTaskDueDate(taskId: string, dueDate: string | null) {
    this.taskOps.updateTaskDueDate(taskId, dueDate);
  }

  updateTaskTags(taskId: string, tags: string[]) {
    this.taskOps.updateTaskTags(taskId, tags);
  }

  addTaskTag(taskId: string, tag: string) {
    this.taskOps.addTaskTag(taskId, tag);
  }

  removeTaskTag(taskId: string, tag: string) {
    this.taskOps.removeTaskTag(taskId, tag);
  }

  /**
   * @deprecated 请直接注入 TaskOperationAdapterService 并调用 taskOps.deleteTask()
   */
  deleteTask(taskId: string) {
    this.taskOps.deleteTask(taskId);
  }

  /**
   * 批量删除任务（原子操作）
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns 实际删除的任务数量（含级联子任务）
   */
  deleteTasksBatch(explicitIds: string[]): number {
    return this.taskOps.deleteTasksBatch(explicitIds);
  }

  /**
   * 计算批量删除将影响的任务数量（含级联子任务）
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.taskOps.calculateBatchDeleteImpact(explicitIds);
  }

  permanentlyDeleteTask(taskId: string) {
    this.taskOps.permanentlyDeleteTask(taskId);
  }

  restoreTask(taskId: string) {
    this.taskOps.restoreTask(taskId);
  }

  emptyTrash() {
    this.taskOps.emptyTrash();
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): Result<string, OperationError> {
    return this.taskOps.addTask(title, content, targetStage, parentId, isSibling);
  }

  addCrossTreeConnection(sourceId: string, targetId: string) {
    this.taskOps.addCrossTreeConnection(sourceId, targetId);
  }

  removeConnection(sourceId: string, targetId: string) {
    this.taskOps.removeConnection(sourceId, targetId);
  }

  /**
   * 重连跨树连接（原子操作）
   * 在一个撤销单元内删除旧连接并创建新连接
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ) {
    this.taskOps.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
  }

  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string) {
    this.taskOps.updateConnectionContent(sourceId, targetId, title, description);
  }

  getTaskConnections(taskId: string) {
    return this.project.getTaskConnections(taskId);
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    this.taskOps.addFloatingTask(title, content, x, y);
  }
  
  moveTaskToStage(
    taskId: string, 
    newStage: number | null, 
    beforeTaskId?: string | null, 
    newParentId?: string | null
  ): Result<void, OperationError> {
    return this.taskOps.moveTaskToStage(taskId, newStage, beforeTaskId, newParentId);
  }

  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    return this.taskOps.insertTaskBetween(taskId, sourceId, targetId);
  }

  /**
   * 将整个子任务树迁移到新的父任务下
   * @param taskId 要迁移的子树根节点 ID
   * @param newParentId 新父任务 ID（null 表示迁移到 stage 1 根节点）
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    return this.taskOps.moveSubtreeToNewParent(taskId, newParentId);
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.taskOps.reorderStage(stage, orderedIds);
  }

  detachTask(taskId: string) {
    this.taskOps.detachTask(taskId);
  }
  
  /**
   * 分离任务及其整个子树（移回待分配区）
   * 
   * 【浮动任务树方法】
   * 保留子树内部父子关系，仅断开根节点与外部的连接
   */
  detachTaskWithSubtree(taskId: string) {
    return this.taskOps.detachTaskWithSubtree(taskId);
  }
  
  deleteTaskKeepChildren(taskId: string) {
    this.taskOps.deleteTaskKeepChildren(taskId);
  }

  isStageRebalancing(stage: number): boolean {
    return this.taskOps.isStageRebalancing(stage);
  }

  // ========== 视图控制：委托给 UiStateService ==========

  /**
   * @deprecated 请直接注入 UiStateService 并调用 ui.toggleView()
   */
  toggleView(view: 'text' | 'flow') {
    this.ui.toggleView(view);
  }

  ensureView(view: 'text' | 'flow') {
    this.ui.ensureView(view);
  }

  setStageFilter(stage: number | 'all') {
    this.ui.setStageFilter(stage);
  }

  // ========== 搜索辅助方法：委托给 UiStateService ==========
  
  setSearchQueryDebounced(query: string, delay: number = 300): void {
    this.ui.setSearchQueryDebounced(query, delay);
  }
  
  clearSearch(): void {
    this.ui.clearSearch();
  }

  // ========== 私有辅助方法 ==========

  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>) {
    this.project.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.sync.markLocalChanges('structure');
    this.sync.schedulePersist();
  }

  private startTrashCleanupTimer() {
    const cleanedCount = this.taskOps.cleanupOldTrashItems();
    if (cleanedCount > 0) {
      this.logger.info(`启动时清理了 ${cleanedCount} 个超期回收站任务`);
    }
    
    this.trashCleanupTimer = setInterval(() => {
      const count = this.taskOps.cleanupOldTrashItems();
      if (count > 0) {
        this.logger.info(`定期清理了 ${count} 个超期回收站任务`);
        this.sync.schedulePersist();
      }
    }, TRASH_CONFIG.CLEANUP_INTERVAL);
  }

  private setupAttachmentUrlRefresh() {
    this.attachmentService.setUrlRefreshCallback((refreshedUrls) => {
      if (refreshedUrls.size === 0) return;
      
      this.project.updateProjects(projects => projects.map(project => {
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
