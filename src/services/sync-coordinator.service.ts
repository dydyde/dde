/**
 * SyncCoordinatorService - 同步协调服务
 * 
 * 职责：
 * - 管理同步状态（网络连通性、队列长度、最后同步时间）
 * - 协调离线数据与云端数据的合并
 * - 处理同步冲突
 * - 管理持久化调度
 * 
 * 这是「应用状态」（Application State），与「领域数据」（Domain Data）分离：
 * - 领域数据：Project、Task（由 ProjectStateService 管理）
 * - 应用状态：网络状态、同步状态、冲突状态（由本服务管理）
 * 
 * 分离的好处：
 * - 网络波动更新同步状态时，不会触发任务列表的变更检测
 * - 数据流像电路板上的走线一样清晰，互不干扰
 */
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { SyncService } from './sync.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { Project, Task, UserPreferences } from '../models';
import { SYNC_CONFIG } from '../config/constants';
import { validateProject, sanitizeProject } from '../utils/validation';
import { Result, success, failure, ErrorCodes, OperationError, isFailure } from '../utils/result';

/**
 * 冲突事件数据
 * 用于发布-订阅模式的冲突通知
 */
export interface ConflictEvent {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
}

/**
 * 持久化状态
 */
interface PersistState {
  /** 是否正在持久化 */
  isPersisting: boolean;
  /** 是否有待处理的持久化请求 */
  hasPending: boolean;
  /** 上次持久化时间 */
  lastPersistAt: number;
  /** 是否有本地未同步的变更 */
  hasPendingLocalChanges: boolean;
  /** 上次更新类型 */
  lastUpdateType: 'content' | 'structure' | 'position';
}

@Injectable({
  providedIn: 'root'
})
export class SyncCoordinatorService {
  private readonly logger = inject(LoggerService).category('SyncCoordinator');
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  private conflictService = inject(ConflictResolutionService);
  private projectState = inject(ProjectStateService);
  private authService = inject(AuthService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private destroyRef = inject(DestroyRef);
  
  // ========== 同步状态 ==========
  
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
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== 持久化状态 ==========
  
  private persistState = signal<PersistState>({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure'
  });
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 
   * 冲突事件 Subject - 使用发布-订阅模式替代回调
   * 
   * 优势：
   * 1. 解耦：SyncCoordinatorService 不需要知道谁在消费冲突事件
   * 2. 多订阅者：UI、日志、自动解决器可以同时订阅
   * 3. 类型安全：ConflictEvent 接口明确定义事件结构
   * 4. 可测试：Subject 比回调更容易 mock 和验证
   */
  private readonly conflict$ = new Subject<ConflictEvent>();
  
  /** 
   * 冲突事件流（只读）
   * 订阅者应使用此 Observable 而非直接访问 Subject
   */
  readonly onConflict$ = this.conflict$.asObservable();
  
  constructor() {
    this.setupQueueSyncCoordination();
    this.setupActionQueueProcessors();
    this.validateRequiredProcessors();
    
    this.destroyRef.onDestroy(() => {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
      }
    });
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 验证必需的处理器是否已注册
   * 在构造函数中调用，确保启动时就能发现配置问题
   */
  private validateRequiredProcessors(): void {
    const requiredProcessors = [
      'project:create',
      'project:update',
      'project:delete',
      'task:create',
      'task:update',
      'task:delete',
      'preference:update'
    ];
    
    const missing = this.actionQueue.validateProcessors(requiredProcessors);
    if (missing.length > 0) {
      // 开发环境下抛出错误，便于早期发现问题
      if (typeof ngDevMode !== 'undefined' && ngDevMode) {
        console.error(
          `[SyncCoordinator] 缺少必需的 ActionQueue 处理器: ${missing.join(', ')}`,
          '\n已注册的处理器:', this.actionQueue.getRegisteredProcessorTypes()
        );
      }
    }
  }
  
  /**
   * 标记有本地变更待同步
   */
  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure') {
    this.persistState.update(s => ({
      ...s,
      hasPendingLocalChanges: true,
      lastUpdateType: updateType
    }));
  }
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.persistState().lastUpdateType;
  }
  
  /**
   * 检查是否有待处理的本地变更
   */
  hasPendingLocalChanges(): boolean {
    return this.persistState().hasPendingLocalChanges;
  }
  
  /**
   * 获取上次持久化时间
   */
  getLastPersistAt(): number {
    return this.persistState().lastPersistAt;
  }
  
  /**
   * 调度持久化
   */
  schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
  }
  
  /**
   * 设置远程变更回调
   */
  setupRemoteChangeCallbacks(
    onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>,
    onTaskChange: (payload: { eventType: string; taskId: string; projectId: string }) => void
  ) {
    this.syncService.setRemoteChangeCallback(onRemoteChange);
    this.syncService.setTaskChangeCallback(onTaskChange);
  }
  
  /**
   * 初始化实时订阅
   */
  async initRealtimeSubscription(userId: string) {
    await this.syncService.initRealtimeSubscription(userId);
  }
  
  /**
   * 清理实时订阅
   */
  teardownRealtimeSubscription() {
    this.syncService.teardownRealtimeSubscription();
  }
  
  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]) {
    this.syncService.saveOfflineSnapshot(projects);
  }
  
  /**
   * 加载离线快照
   */
  loadOfflineSnapshot(): Project[] | null {
    return this.syncService.loadOfflineSnapshot();
  }
  
  /**
   * 清除离线缓存
   */
  clearOfflineCache() {
    this.syncService.clearOfflineCache();
  }
  
  /**
   * 从云端加载项目
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    return this.syncService.loadProjectsFromCloud(userId);
  }
  
  /**
   * 保存项目到云端
   */
  async saveProjectToCloud(project: Project, userId: string) {
    return this.syncService.saveProjectToCloud(project, userId);
  }
  
  /**
   * 从云端删除项目
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    return this.syncService.deleteProjectFromCloud(projectId, userId);
  }
  
  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.syncService.loadSingleProject(projectId, userId);
  }
  
  /**
   * 尝试重新加载冲突数据
   */
  async tryReloadConflictData(
    userId: string, 
    findProject: (id: string) => Project | undefined
  ) {
    return this.syncService.tryReloadConflictData(userId, findProject);
  }
  
  /**
   * 解决数据冲突
   */
  resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    localProject: Project,
    remoteProject: Project | undefined
  ): Result<Project, OperationError> {
    return this.conflictService.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
  }
  
  /**
   * 智能合并项目
   */
  smartMerge(localProject: Project, remoteProject: Project) {
    return this.conflictService.smartMerge(localProject, remoteProject);
  }
  
  /**
   * 合并离线数据
   * 返回冲突项目列表供调用者处理
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[], 
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    const conflictProjects: Project[] = [];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      const cloudProject = cloudMap.get(offlineProject.id);
      
      if (!cloudProject) {
        const result = await this.syncService.saveProjectToCloud(offlineProject, userId);
        if (result.success) {
          mergedProjects.push(offlineProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步:', offlineProject.name);
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
          this.logger.info('离线修改已同步:', offlineProject.name);
        } else if (result.conflict) {
          this.logger.warn('离线数据存在冲突', { projectName: offlineProject.name });
          // 记录冲突项目供调用者处理
          conflictProjects.push(offlineProject);
          // 发布冲突事件（替代回调）
          this.conflict$.next({
            localProject: offlineProject,
            remoteProject: result.remoteData!,
            projectId: offlineProject.id
          });
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }
  
  /**
   * 验证并重新平衡项目
   */
  validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    const validation = validateProject(project);
    
    const fatalErrors = validation.errors.filter(e => 
      e.includes('ID 无效') || e.includes('必须是数组') || e.includes('项目 ID')
    );
    
    if (fatalErrors.length > 0) {
      this.logger.error('项目数据致命错误，无法恢复', { 
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
      this.logger.warn('项目数据验证失败，尝试清理修复', { 
        projectId: project.id, 
        errors: validation.errors 
      });
      project = sanitizeProject(project);
      
      const revalidation = validateProject(project);
      if (!revalidation.valid) {
        this.logger.error('清理后数据仍然无效', { errors: revalidation.errors });
        return failure(
          ErrorCodes.VALIDATION_ERROR,
          `项目数据清理后仍然无效: ${revalidation.errors.join('; ')}`,
          { projectId: project.id, errors: revalidation.errors }
        );
      }
    }
    
    if (validation.warnings.length > 0) {
      this.logger.warn('项目数据警告', { projectId: project.id, warnings: validation.warnings });
    }
    
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      this.logger.info('已修复数据问题', { projectId: project.id, issues });
    }
    
    return success(this.layoutService.rebalance(fixedProject));
  }
  
  /**
   * 验证并重新平衡项目（简化版，出错时返回清理后的项目）
   */
  validateAndRebalance(project: Project): Project {
    const result = this.validateAndRebalanceWithResult(project);
    if (isFailure(result)) {
      const errorMsg = result.error.message;
      this.logger.error('validateAndRebalance 失败', { error: errorMsg });
      this.toastService.error('数据验证失败', errorMsg);
      return sanitizeProject(project);
    }
    return result.value;
  }
  
  /**
   * 销毁服务
   */
  destroy() {
    // 完成冲突事件 Subject
    this.conflict$.complete();
    this.syncService.destroy();
  }
  
  // ========== 私有方法 ==========
  
  private setupQueueSyncCoordination() {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.syncService.pauseRealtimeUpdates(),
      () => this.syncService.resumeRealtimeUpdates()
    );
  }
  
  private setupActionQueueProcessors() {
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
    });
    
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { taskId: string; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { preferences: Partial<UserPreferences>; userId: string };
      return await this.syncService.saveUserPreferences(userId, payload.preferences);
    });
  }
  
  private async persistActiveProject() {
    const state = this.persistState();
    if (state.isPersisting) {
      this.persistState.update(s => ({ ...s, hasPending: true }));
      return;
    }
    
    this.persistState.update(s => ({ ...s, isPersisting: true }));
    
    try {
      await this.doPersistActiveProject();
    } finally {
      const currentState = this.persistState();
      this.persistState.update(s => ({ 
        ...s, 
        isPersisting: false,
        lastPersistAt: Date.now(),
        hasPendingLocalChanges: false
      }));
      
      if (currentState.hasPending) {
        this.persistState.update(s => ({ ...s, hasPending: false }));
        this.schedulePersist();
      }
    }
  }
  
  private async doPersistActiveProject() {
    const project = this.projectState.activeProject();
    const projects = this.projectState.projects();
    
    this.syncService.saveOfflineSnapshot(projects);
    
    if (!project) {
      return;
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      // 未登录时仅保存到本地
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
    } catch (error) {
      this.logger.error('持久化项目时发生异常', { error });
      // 乐观UI：静默记录错误，不阻塞用户操作
      // 数据已保存到本地离线快照，网络恢复后会自动重试
      this.logger.warn('自动保存失败，更改已保存到本地', { error });
    }
  }
}
