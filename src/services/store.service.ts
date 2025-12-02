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
 * 子服务：
 * - UiStateService: UI 状态（搜索查询、面板展开、筛选器等）
 * - ProjectStateService: 项目/任务数据状态
 * - TaskOperationService: 任务 CRUD 操作
 * - SearchService: 搜索逻辑
 * - AuthService: 用户认证
 * - SyncService: 数据同步
 * - UndoService: 撤销/重做
 * 
 * 如需添加新功能，请添加到对应的子服务中，不要修改此门面！
 */
import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { ActionQueueService } from './action-queue.service';
import { MigrationService } from './migration.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { AttachmentService } from './attachment.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationService } from './task-operation.service';
import { SearchService } from './search.service';
import { 
  Task, Project, Connection, UnfinishedItem, ThemeType, Attachment 
} from '../models';
import { 
  LAYOUT_CONFIG, SYNC_CONFIG, CACHE_CONFIG, LETTERS, SUPERSCRIPT_DIGITS, TRASH_CONFIG 
} from '../config/constants';
import { 
  validateProject, sanitizeProject, detectCycles, detectOrphans 
} from '../utils/validation';
import {
  Result, OperationError, ErrorCodes, success, failure, getErrorMessage, isFailure
} from '../utils/result';

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  // ========== 注入子服务 ==========
  private authService = inject(AuthService);
  private syncService = inject(SyncService);
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private actionQueue = inject(ActionQueueService);
  private migrationService = inject(MigrationService);
  private conflictService = inject(ConflictResolutionService);
  private attachmentService = inject(AttachmentService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private taskOps = inject(TaskOperationService);
  private searchService = inject(SearchService);
  private destroyRef = inject(DestroyRef);
  
  // ========== 代理访问其他服务的状态（只读） ==========
  
  /** 当前用户 ID */
  readonly currentUserId = this.authService.currentUserId;
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  
  /** 是否在线 */
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  
  /** 离线模式 */
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  
  /** 会话是否过期 */
  readonly sessionExpired = computed(() => this.syncService.syncState().sessionExpired);
  
  /** 同步错误 */
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncService.syncState().conflictData);
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.syncService.isLoadingRemote;
  
  /** 是否可以撤销 */
  readonly canUndo = this.undoService.canUndo;
  
  /** 是否可以重做 */
  readonly canRedo = this.undoService.canRedo;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== UI 状态透传 → UiStateService ==========
  
  /** 是否为移动端 */
  get isMobile() { return this.uiState.isMobile; }
  
  /** 侧边栏宽度 */
  get sidebarWidth() { return this.uiState.sidebarWidth; }
  
  /** 文本视图分栏比例 */
  get textColumnRatio() { return this.uiState.textColumnRatio; }
  
  /** 布局方向 */
  get layoutDirection() { return this.uiState.layoutDirection; }
  
  /** 浮动窗口偏好 */
  get floatingWindowPref() { return this.uiState.floatingWindowPref; }
  
  /** 主题 */
  readonly theme = signal<ThemeType>('default');
  
  /** 文本视图 - 未完成任务面板展开 */
  get isTextUnfinishedOpen() { return this.uiState.isTextUnfinishedOpen; }
  
  /** 文本视图 - 未分配任务面板展开 */
  get isTextUnassignedOpen() { return this.uiState.isTextUnassignedOpen; }
  
  /** 流程图视图 - 未完成任务面板展开 */
  get isFlowUnfinishedOpen() { return this.uiState.isFlowUnfinishedOpen; }
  
  /** 流程图视图 - 未分配任务面板展开 */
  get isFlowUnassignedOpen() { return this.uiState.isFlowUnassignedOpen; }
  
  /** 流程图视图 - 详情面板展开 */
  get isFlowDetailOpen() { return this.uiState.isFlowDetailOpen; }
  
  /** 统一搜索查询 */
  get searchQuery() { return this.uiState.searchQuery; }
  
  /** 项目列表搜索查询 */
  get projectSearchQuery() { return this.uiState.projectSearchQuery; }
  
  // ========== 核心数据状态透传 → ProjectStateService ==========
  
  /** 项目列表 */
  get projects() { return this.projectState.projects; }
  
  /** 活动项目 ID */
  get activeProjectId() { return this.projectState.activeProjectId; }
  
  /** 当前视图 */
  get activeView() { return this.uiState.activeView; }
  
  /** 筛选模式 */
  get filterMode() { return this.uiState.filterMode; }
  
  /** 阶段视图根筛选 */
  get stageViewRootFilter() { return this.uiState.stageViewRootFilter; }
  
  /** 阶段筛选 */
  get stageFilter() { return this.uiState.stageFilter; }
  
  // ========== 计算属性透传 → ProjectStateService ==========
  
  /** 活动项目 */
  readonly activeProject = this.projectState.activeProject;
  
  /** 当前项目的任务 */
  readonly tasks = this.projectState.tasks;
  
  /** 阶段分组 */
  readonly stages = this.projectState.stages;
  
  /** 未分配任务 */
  readonly unassignedTasks = this.projectState.unassignedTasks;
  
  /** 已删除任务（回收站） */
  readonly deletedTasks = this.projectState.deletedTasks;
  
  /** 未完成项目 */
  readonly unfinishedItems = this.projectState.unfinishedItems;
  
  /** 根任务 */
  readonly rootTasks = this.projectState.rootTasks;
  
  /** 所有阶段1任务 */
  readonly allStage1Tasks = this.projectState.allStage1Tasks;
  
  // ========== 搜索结果透传 → SearchService ==========
  
  /** 搜索结果 */
  readonly searchResults = this.searchService.searchResults;
  
  /** 项目搜索结果 */
  readonly filteredProjects = this.searchService.filteredProjects;
  
  // ========== 私有状态（同步协调相关，未来迁移到 SyncCoordinatorService） ==========
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingLocalChanges = false;
  private lastPersistAt = 0;
  private lastUpdateType: 'content' | 'structure' | 'position' = 'structure';
  
  /** 持久化操作锁 */
  private isPersisting = false;
  /** 持久化操作队列 */
  private persistPending = false;
  
  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // ========== 冲突处理回调 ==========
  
  /** 冲突回调函数，由 AppComponent 设置 */
  onConflict: ((localProject: Project, remoteProject: Project, projectId: string) => void) | null = null;

  constructor() {
    // 设置 TaskOperationService 的回调
    this.taskOps.setCallbacks({
      onProjectUpdate: (mutator) => this.recordAndUpdate(mutator),
      onProjectUpdateDebounced: (mutator) => this.recordAndUpdateDebounced(mutator),
      getActiveProject: () => this.activeProject()
    });
    
    this.loadFromCacheOrSeed();
    this.setupActionQueueProcessors();
    this.startTrashCleanupTimer();
    this.setupAttachmentUrlRefresh();
    this.setupQueueSyncCoordination();
    
    // 设置远程变更回调
    this.syncService.setRemoteChangeCallback(async (payload) => {
      if (this.uiState.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      
      try {
        if (payload?.eventType && payload?.projectId) {
          await this.handleIncrementalUpdate(payload);
        } else {
          await this.loadProjects();
        }
      } catch (e) {
        console.error('处理远程变更失败', e);
      }
    });
    
    // 设置任务级别变更回调
    this.syncService.setTaskChangeCallback((payload) => {
      if (this.uiState.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      
      this.handleTaskLevelUpdate(payload);
    });
    
    // 清理
    this.destroyRef.onDestroy(() => {
      this.undoService.flushPendingAction();
      
      if (this.persistTimer) clearTimeout(this.persistTimer);
      if (this.trashCleanupTimer) clearInterval(this.trashCleanupTimer);
      
      // 清理附件服务回调，防止内存泄漏
      this.attachmentService.clearUrlRefreshCallback();
      this.attachmentService.clearMonitoredAttachments();
      
      this.syncService.destroy();
    });
  }
  
  // ========== 公共方法：委托给子服务 ==========

  /**
   * 压缩 displayId 显示
   * @delegate ProjectStateService
   */
  compressDisplayId(displayId: string): string {
    return this.projectState.compressDisplayId(displayId);
  }

  /**
   * 设置当前用户
   */
  async setCurrentUser(userId: string | null) {
    if (this.currentUserId() === userId) return;
    
    // 清理旧用户的附件监控和回调，防止内存泄漏
    this.attachmentService.clearMonitoredAttachments();
    
    this.authService.currentUserId.set(userId);
    this.projectState.setActiveProjectId(null);
    this.projectState.setProjects([]);
    this.undoService.clearHistory();
    this.syncService.teardownRealtimeSubscription();
    
    if (userId && this.syncService) {
      await this.loadProjects();
      await this.loadUserPreferences();
      await this.syncService.initRealtimeSubscription(userId);
      
      await this.syncService.tryReloadConflictData(userId, (id) => 
        this.projects().find(p => p.id === id)
      );
    } else {
      this.loadFromCacheOrSeed();
      this.loadLocalPreferences();
    }
  }
  
  /**
   * 切换活动项目
   */
  switchActiveProject(projectId: string | null) {
    const previousProjectId = this.activeProjectId();
    
    if (previousProjectId === projectId) return;
    
    // 清理搜索状态
    this.uiState.clearSearch();
    
    // 先 flush 待处理的防抖操作
    this.undoService.flushPendingAction();
    
    // 清空之前项目的撤销历史
    if (previousProjectId) {
      this.undoService.onProjectSwitch(previousProjectId);
    }
    
    // 设置新的活动项目
    this.projectState.setActiveProjectId(projectId);
    
    // 更新附件 URL 监控
    if (projectId) {
      const newProject = this.projects().find(p => p.id === projectId);
      if (newProject) {
        this.monitorProjectAttachments(newProject);
      }
    } else {
      this.attachmentService.clearMonitoredAttachments();
    }
  }

  /**
   * 执行撤销
   * 支持渐进式降级：
   * - 版本匹配：正常撤销
   * - 版本不匹配但可强制：提示用户并提供强制选项
   * - 版本差距过大：拒绝撤销
   */
  undo() {
    const activeProject = this.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);
    
    if (!result) return;
    
    // 版本差距过大，完全拒绝撤销
    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。请查看历史版本或刷新页面。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }
    
    // 版本不匹配但可强制撤销
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      // 显示可恢复错误对话框，让用户选择
      // 简化处理：直接显示警告并执行撤销（单用户场景）
      // 多用户协作场景可以通过 GlobalErrorHandler.showRecoveryDialog 实现用户选择
      this.toastService.warning(
        '撤销注意', 
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      // 单用户场景：继续执行撤销
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before);
      }
      return;
    }
    
    // 正常撤销
    const action = result;
    const project = this.projects().find(p => p.id === action.projectId);
    if (project) {
      const localVersion = project.version ?? 0;
      const snapshotVersion = (action.data.before as any)?.version ?? 0;
      
      if (localVersion > snapshotVersion + 1) {
        console.warn('Undo 可能覆盖远程更新', { localVersion, snapshotVersion });
        this.toastService.warning('注意', '撤销可能会覆盖其他设备的更新');
      }
    }
    
    this.applyProjectSnapshot(action.projectId, action.data.before);
  }

  /**
   * 执行重做
   */
  redo() {
    const activeProject = this.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.redo(currentVersion);
    
    if (!result) return;
    
    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }
    
    // 处理可强制重做的情况
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }
    
    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.after);
  }

  /**
   * 加载项目
   */
  async loadProjects() {
    const userId = this.currentUserId();
    if (!userId) {
      this.loadFromCacheOrSeed();
      return;
    }
    
    const previousActive = this.activeProjectId();
    const offlineProjects = this.syncService.loadOfflineSnapshot();
    const projects = await this.syncService.loadProjectsFromCloud(userId);
    
    if (projects.length > 0) {
      const validatedProjects: Project[] = [];
      const failedProjects: string[] = [];
      
      for (const p of projects) {
        const result = this.validateAndRebalanceWithResult(p);
        if (result.ok) {
          validatedProjects.push(result.value);
        } else if (isFailure(result)) {
          failedProjects.push(p.name || p.id);
          console.error(`项目 "${p.name}" 验证失败，跳过加载:`, result.error.message);
        }
      }
      
      if (failedProjects.length > 0) {
        this.toastService.warning(
          '部分项目加载失败', 
          `以下项目数据损坏已跳过: ${failedProjects.join(', ')}`
        );
      }
      
      let rebalanced = validatedProjects;
      
      if (offlineProjects && offlineProjects.length > 0) {
        const mergeResult = await this.mergeOfflineDataOnReconnect(rebalanced, offlineProjects, userId);
        rebalanced = mergeResult.projects;
        
        if (mergeResult.syncedCount > 0) {
          this.toastService.success('离线数据已同步', `已将 ${mergeResult.syncedCount} 个项目的离线修改同步到云端`);
        }
      }
      
      this.projectState.setProjects(rebalanced);
      
      if (previousActive && rebalanced.some(p => p.id === previousActive)) {
        this.projectState.setActiveProjectId(previousActive);
        const activeProject = rebalanced.find(p => p.id === previousActive);
        if (activeProject) {
          this.monitorProjectAttachments(activeProject);
        }
      } else {
        this.projectState.setActiveProjectId(rebalanced[0]?.id ?? null);
        if (rebalanced[0]) {
          this.monitorProjectAttachments(rebalanced[0]);
        }
      }
      
      this.syncService.saveOfflineSnapshot(rebalanced);
    } else if (this.syncService.syncState().offlineMode) {
      this.loadFromCacheOrSeed();
      this.toastService.warning('离线模式', '网络不可用，数据仅保存在本地');
    }
    
    const syncError = this.syncService.syncState().syncError;
    if (syncError) {
      this.toastService.error('同步失败', syncError);
    }
  }

  /**
   * 清空本地数据
   */
  clearLocalData() {
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.syncService.clearOfflineCache();
  }

  /**
   * 解决数据冲突
   */
  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    const localProject = this.projects().find(p => p.id === projectId);
    if (!localProject) return;
    
    const remoteProject = conflictData.remoteData as Project | undefined;
    
    const result = this.conflictService.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
    
    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return;
    }
    
    const resolvedProject = this.validateAndRebalance(result.value);
    
    this.projectState.updateProjects(ps => ps.map(p => 
      p.id === projectId ? resolvedProject : p
    ));
    
    if (this.activeProjectId() === projectId) {
      // 清除该项目的撤销历史，避免撤销时覆盖已解决的冲突
      this.undoService.clearHistory(projectId);
    }
    
    if (choice !== 'remote') {
      const userId = this.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.syncService.saveProjectToCloud(resolvedProject, userId);
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
        } catch (e) {
          console.error('冲突解决后同步失败', e);
          this.actionQueue.enqueue({
            type: 'update',
            entityType: 'project',
            entityId: projectId,
            payload: { project: resolvedProject }
          });
        }
      }
    }
    
    this.syncService.saveOfflineSnapshot(this.projects());
  }

  // ========== 项目操作 ==========

  /**
   * 添加新项目
   */
  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    const previousProjects = this.projects();
    const previousActiveId = this.activeProjectId();
    
    this.projectState.updateProjects(p => [...p, balanced]);
    this.projectState.setActiveProjectId(balanced.id);
    
    const userId = this.currentUserId();
    if (userId) {
      const result = await this.syncService.saveProjectToCloud(balanced, userId);
      
      if (!result.success && !result.conflict) {
        if (!this.isOnline()) {
          this.actionQueue.enqueue({
            type: 'create',
            entityType: 'project',
            entityId: balanced.id,
            payload: { project: balanced }
          });
          this.toastService.info('离线创建', '项目将在网络恢复后同步到云端');
        } else {
          this.projectState.setProjects(previousProjects);
          this.projectState.setActiveProjectId(previousActiveId);
          this.toastService.error('创建失败', '无法保存项目到云端，请稍后重试');
          return { success: false, error: '同步失败' };
        }
      } else if (result.conflict) {
        this.toastService.warning('数据冲突', '检测到数据冲突，请检查');
      }
    }
    
    this.schedulePersist();
    return { success: true };
  }

  /**
   * 删除项目
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.currentUserId();
    const previousProjects = this.projects();
    const previousActiveId = this.activeProjectId();
    
    this.projectState.updateProjects(p => p.filter(proj => proj.id !== projectId));
    
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      const success = await this.syncService.deleteProjectFromCloud(projectId, userId);
      
      if (!success) {
        if (!this.isOnline()) {
          this.actionQueue.enqueue({
            type: 'delete',
            entityType: 'project',
            entityId: projectId,
            payload: { projectId, userId }
          });
          this.toastService.info('离线删除', '项目将在网络恢复后同步删除');
        } else {
          this.projectState.setProjects(previousProjects);
          this.projectState.setActiveProjectId(previousActiveId);
          this.toastService.error('删除失败', '无法从云端删除项目，请稍后重试');
          return { success: false, error: '同步失败' };
        }
      }
    }
    
    this.syncService.saveOfflineSnapshot(this.projects());
    return { success: true };
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projectState.updateProjects(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.schedulePersist();
    }
  }

  renameProject(projectId: string, newName: string) {
    if (!newName.trim()) return;
    
    this.projectState.updateProjects(projects => projects.map(p => 
      p.id === projectId ? { ...p, name: newName.trim() } : p
    ));
    this.schedulePersist();
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
    this.schedulePersist();
  }

  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    return this.projectState.getViewState();
  }

  // ========== 任务操作：委托给 TaskOperationService ==========

  updateTaskContent(taskId: string, newContent: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskContent(taskId, newContent);
  }
  
  markEditing() {
    this.uiState.markEditing();
    this.hasPendingLocalChanges = true;
  }
  
  get isUserEditing(): boolean {
    return this.uiState.isEditing || this.hasPendingLocalChanges;
  }

  addTodoItem(taskId: string, itemText: string) {
    this.markEditing();
    this.taskOps.addTodoItem(taskId, itemText);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string) {
    this.taskOps.completeUnfinishedItem(taskId, itemText);
  }

  updateTaskTitle(taskId: string, title: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskTitle(taskId, title);
  }

  updateTaskPosition(taskId: string, x: number, y: number) {
    this.lastUpdateType = 'position';
    this.taskOps.updateTaskPosition(taskId, x, y);
  }
  
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number) {
    this.taskOps.updateTaskPositionWithRankSync(taskId, x, y);
  }
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.lastUpdateType;
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.taskOps.updateTaskStatus(taskId, status);
  }
  
  updateTaskAttachments(taskId: string, attachments: Attachment[]) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskAttachments(taskId, attachments);
  }

  addTaskAttachment(taskId: string, attachment: Attachment) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.addTaskAttachment(taskId, attachment);
  }

  removeTaskAttachment(taskId: string, attachmentId: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.removeTaskAttachment(taskId, attachmentId);
  }

  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskPriority(taskId, priority);
  }

  updateTaskDueDate(taskId: string, dueDate: string | null) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskDueDate(taskId, dueDate);
  }

  updateTaskTags(taskId: string, tags: string[]) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskTags(taskId, tags);
  }

  addTaskTag(taskId: string, tag: string) {
    this.taskOps.addTaskTag(taskId, tag);
  }

  removeTaskTag(taskId: string, tag: string) {
    this.taskOps.removeTaskTag(taskId, tag);
  }

  deleteTask(taskId: string) {
    this.taskOps.deleteTask(taskId);
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
    return this.taskOps.addTask({ title, content, targetStage, parentId, isSibling });
  }

  addCrossTreeConnection(sourceId: string, targetId: string) {
    this.taskOps.addCrossTreeConnection(sourceId, targetId);
  }

  removeConnection(sourceId: string, targetId: string) {
    this.taskOps.removeConnection(sourceId, targetId);
  }

  updateConnectionDescription(sourceId: string, targetId: string, description: string) {
    this.markEditing();
    this.taskOps.updateConnectionDescription(sourceId, targetId, description);
  }

  getTaskConnections(taskId: string) {
    return this.projectState.getTaskConnections(taskId);
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
    return this.taskOps.moveTaskToStage({ taskId, newStage, beforeTaskId, newParentId });
  }

  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    return this.taskOps.insertTaskBetween({ taskId, sourceId, targetId });
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.taskOps.reorderStage(stage, orderedIds);
  }

  detachTask(taskId: string) {
    this.taskOps.detachTask(taskId);
  }
  
  deleteTaskKeepChildren(taskId: string) {
    this.taskOps.deleteTaskKeepChildren(taskId);
  }

  isStageRebalancing(stage: number): boolean {
    return this.taskOps.isStageRebalancing(stage);
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

  // ========== 主题设置 ==========
  
  async setTheme(theme: ThemeType) {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    const userId = this.currentUserId();
    if (userId) {
      await this.syncService.saveUserPreferences(userId, { theme });
    }
  }

  private applyThemeToDOM(theme: string) {
    if (typeof document === 'undefined') return;
    
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  private async loadUserPreferences() {
    const userId = this.currentUserId();
    if (!userId) return;
    
    const prefs = await this.syncService.loadUserPreferences(userId);
    if (prefs?.theme) {
      this.theme.set(prefs.theme);
      this.applyThemeToDOM(prefs.theme);
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
  }
  
  private loadLocalPreferences() {
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }

  // ========== 搜索辅助方法：委托给 SearchService ==========
  
  setSearchQueryDebounced(query: string, delay: number = 300): void {
    this.uiState.setSearchQueryDebounced(query, delay);
  }
  
  clearSearch(): void {
    this.uiState.clearSearch();
  }

  // ========== 私有辅助方法 ==========

  private handleTaskLevelUpdate(payload: { eventType: string; taskId: string; projectId: string; data?: Record<string, unknown> }) {
    const { eventType, taskId, projectId } = payload;
    
    if (projectId !== this.activeProjectId()) {
      return;
    }
    
    switch (eventType) {
      case 'DELETE':
        this.projectState.updateProjects(projects => 
          projects.map(p => {
            if (p.id !== projectId) return p;
            return {
              ...p,
              tasks: p.tasks.filter(t => t.id !== taskId)
            };
          })
        );
        break;
        
      case 'INSERT':
      case 'UPDATE':
        this.syncService.loadSingleProject(projectId, this.currentUserId()!)
          .then(remoteProject => {
            if (!remoteProject) return;
            
            const remoteTask = remoteProject.tasks.find(t => t.id === taskId);
            if (!remoteTask) return;
            
            this.projectState.updateProjects(projects =>
              projects.map(p => {
                if (p.id !== projectId) return p;
                
                const existingTaskIndex = p.tasks.findIndex(t => t.id === taskId);
                if (existingTaskIndex >= 0) {
                  const updatedTasks = [...p.tasks];
                  updatedTasks[existingTaskIndex] = remoteTask;
                  return { ...p, tasks: updatedTasks };
                } else {
                  return { ...p, tasks: [...p.tasks, remoteTask] };
                }
              })
            );
          })
          .catch(error => {
            console.error('处理远程任务更新失败', error);
          });
        break;
        
      default:
        // 未知事件类型，记录警告但不中断处理
        console.warn(`未处理的任务事件类型: ${eventType}`, { taskId, projectId });
        break;
    }
  }

  private setupQueueSyncCoordination() {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.syncService.pauseRealtimeUpdates(),
      () => this.syncService.resumeRealtimeUpdates()
    );
  }

  private setupActionQueueProcessors() {
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
    });
    
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { taskId: string; projectId: string };
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { preferences: Partial<import('../models').UserPreferences>; userId: string };
      return await this.syncService.saveUserPreferences(userId, payload.preferences);
    });
  }

  private startTrashCleanupTimer() {
    const cleanedCount = this.taskOps.cleanupOldTrashItems();
    if (cleanedCount > 0) {
      console.log(`启动时清理了 ${cleanedCount} 个超期回收站任务`);
    }
    
    this.trashCleanupTimer = setInterval(() => {
      const count = this.taskOps.cleanupOldTrashItems();
      if (count > 0) {
        console.log(`定期清理了 ${count} 个超期回收站任务`);
        this.schedulePersist();
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

  private monitorProjectAttachments(project: Project) {
    const userId = this.currentUserId();
    if (!userId) return;
    
    this.attachmentService.clearMonitoredAttachments();
    
    for (const task of project.tasks) {
      if (task.attachments && task.attachments.length > 0) {
        for (const attachment of task.attachments) {
          this.attachmentService.monitorAttachment(userId, project.id, task.id, attachment);
        }
      }
    }
  }

  private async handleIncrementalUpdate(payload: { eventType: string; projectId: string }) {
    const { eventType, projectId } = payload;
    
    if (eventType === 'DELETE') {
      this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);
      
      this.projectState.updateProjects(ps => ps.filter(p => p.id !== projectId));
      if (this.activeProjectId() === projectId) {
        const remaining = this.projects();
        this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
      }
      return;
    }
    
    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const userId = this.currentUserId();
      if (!userId) return;
      
      const remoteProject = await this.syncService.loadSingleProject(projectId, userId);
      if (!remoteProject) return;
      
      const localProject = this.projects().find(p => p.id === projectId);
      
      if (!localProject) {
        const validated = this.validateAndRebalance(remoteProject);
        this.projectState.updateProjects(ps => [...ps, validated]);
      } else {
        const localVersion = localProject.version ?? 0;
        const remoteVersion = remoteProject.version ?? 0;
        
        if (remoteVersion > localVersion) {
          const versionDiff = remoteVersion - localVersion;
          
          const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
          if (clearedCount > 0) {
            console.log(`清理了 ${clearedCount} 条过时的撤销历史 (项目: ${projectId})`);
          }
          
          if (this.uiState.isEditing && versionDiff > 1) {
            this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
          }
          
          const mergeResult = this.conflictService.smartMerge(localProject, remoteProject);
          
          if (mergeResult.conflictCount > 0 && this.uiState.isEditing) {
            this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
          }
          
          const validated = this.validateAndRebalance(mergeResult.project);
          this.projectState.updateProjects(ps => ps.map(p => p.id === projectId ? validated : p));
        }
      }
    }
  }

  private async mergeOfflineDataOnReconnect(
    cloudProjects: Project[], 
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      const cloudProject = cloudMap.get(offlineProject.id);
      
      if (!cloudProject) {
        const result = await this.syncService.saveProjectToCloud(offlineProject, userId);
        if (result.success) {
          mergedProjects.push(offlineProject);
          syncedCount++;
          console.log('离线新建项目已同步:', offlineProject.name);
        }
        continue;
      }
      
      const offlineVersion = offlineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        const projectToSync = { 
          ...offlineProject, 
          version: Math.max(offlineVersion, cloudVersion) + 1 
        };
        
        const result = await this.syncService.saveProjectToCloud(projectToSync, userId);
        if (result.success) {
          const idx = mergedProjects.findIndex(p => p.id === offlineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = projectToSync;
          }
          syncedCount++;
          console.log('离线修改已同步:', offlineProject.name);
        } else if (result.conflict) {
          console.warn('离线数据存在冲突:', offlineProject.name);
          this.onConflict?.(offlineProject, result.remoteData!, offlineProject.id);
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount };
  }

  private validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    const validation = validateProject(project);
    
    const fatalErrors = validation.errors.filter(e => 
      e.includes('ID 无效') || e.includes('必须是数组') || e.includes('项目 ID')
    );
    
    if (fatalErrors.length > 0) {
      console.error('项目数据致命错误，无法恢复', { 
        projectId: project.id, 
        fatalErrors 
      });
      return failure(
        ErrorCodes.VALIDATION_ERROR,
        `项目数据损坏无法修复: ${fatalErrors.join('; ')}`,
        { projectId: project.id, errors: fatalErrors }
      );
    }
    
    if (!validation.valid) {
      console.warn('项目数据验证失败，尝试清理修复', { 
        projectId: project.id, 
        errors: validation.errors 
      });
      project = sanitizeProject(project);
      
      const revalidation = validateProject(project);
      if (!revalidation.valid) {
        console.error('清理后数据仍然无效', { errors: revalidation.errors });
        return failure(
          ErrorCodes.VALIDATION_ERROR,
          `项目数据清理后仍然无效: ${revalidation.errors.join('; ')}`,
          { projectId: project.id, errors: revalidation.errors }
        );
      }
    }
    
    if (validation.warnings.length > 0) {
      console.warn('项目数据警告', { projectId: project.id, warnings: validation.warnings });
    }
    
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      console.log('已修复数据问题', { projectId: project.id, issues });
    }
    
    return success(this.layoutService.rebalance(fixedProject));
  }

  private validateAndRebalance(project: Project): Project {
    const result = this.validateAndRebalanceWithResult(project);
    if (isFailure(result)) {
      const errorMsg = result.error.message;
      console.error('validateAndRebalance 失败:', errorMsg);
      this.toastService.error('数据验证失败', errorMsg);
      return sanitizeProject(project);
    }
    return result.value;
  }

  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    return [
      this.layoutService.rebalance({
        id: 'proj-seed-1',
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        tasks: [
          {
            id: 't1',
            title: '阶段 1: 环境搭建',
            content: '初始化项目环境。\n- [ ] 初始化 git 仓库\n- [ ] 安装 Node.js 依赖',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: 't2',
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: 't1',
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { id: 'conn-seed-1', source: 't1', target: 't2' }
        ]
      })
    ];
  }

  private loadFromCacheOrSeed() {
    const cached = this.syncService.loadOfflineSnapshot();
    let projects: Project[] = [];
    
    if (cached && cached.length > 0) {
      projects = cached.map(p => this.migrateProject(p));
    } else {
      projects = this.seedProjects();
    }
    
    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(projects[0]?.id ?? null);
    this.syncService.syncState.update(s => ({ ...s, offlineMode: true }));
  }
  
  private migrateProject(project: Project): Project {
    let migrated = { ...project };
    
    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;
    
    migrated.tasks = migrated.tasks.map(t => ({
      ...t,
      status: t.status || 'active',
      rank: t.rank ?? 10000,
      displayId: t.displayId || '?',
      hasIncompleteTask: t.hasIncompleteTask ?? false
    }));
    
    migrated.connections = migrated.connections || [];
    
    return this.layoutService.rebalance(migrated);
  }

  private updateActiveProject(mutator: (project: Project) => Project) {
    let updated = false;
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        updated = true;
        return mutator(p);
      }
      return p;
    }));
    if (updated) {
      this.hasPendingLocalChanges = true;
      this.schedulePersist();
    }
  }

  private recordAndUpdate(mutator: (project: Project) => Project) {
    const project = this.activeProject();
    if (!project) return;
    
    this.lastUpdateType = 'structure';
    
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    let afterProject: Project | null = null;
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    if (afterProject && !this.undoService.isProcessing) {
      const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
      this.undoService.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      }, currentVersion);
    }
    
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  private recordAndUpdateDebounced(mutator: (project: Project) => Project) {
    const project = this.activeProject();
    if (!project) return;
    
    this.lastUpdateType = 'content';
    
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    let afterProject: Project | null = null;
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    if (afterProject && !this.undoService.isProcessing) {
      const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
      this.undoService.recordActionDebounced({
        type: 'task-update',
        projectId: project.id,
        projectVersion: currentVersion,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
    }
    
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

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
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  private schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
  }

  private async persistActiveProject() {
    if (this.isPersisting) {
      this.persistPending = true;
      return;
    }
    
    this.isPersisting = true;
    
    try {
      await this.doPersistActiveProject();
    } finally {
      this.isPersisting = false;
      
      if (this.persistPending) {
        this.persistPending = false;
        this.schedulePersist();
      }
    }
  }
  
  private async doPersistActiveProject() {
    const project = this.activeProject();
    const projects = this.projects();
    
    this.syncService.saveOfflineSnapshot(projects);
    
    if (!project) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const userId = this.currentUserId();
    if (!userId) {
      this.migrationService.saveGuestData(projects);
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
      return;
    }

    const now = new Date().toISOString();
    try {
      const result = await this.syncService.saveProjectToCloud(
        { ...project, updatedAt: now },
        userId
      );
      
      if (result.success) {
        this.projectState.updateProjects(ps => ps.map(p => 
          p.id === project.id ? { ...p, updatedAt: now } : p
        ));
      }
      // 注意：即使同步失败，也要重置 hasPendingLocalChanges
      // 因为数据已保存到离线快照，会通过 ActionQueue 重试
    } catch (error) {
      // 同步异常时记录错误，但不阻塞状态重置
      console.error('持久化项目时发生异常:', error);
    } finally {
      // 确保状态始终被重置，避免永久卡在 pending 状态
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
    }
  }
}
