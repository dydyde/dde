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
   * 立即刷新待处理的持久化
   * 用于页面卸载前确保数据已保存
   * 注意：这是同步方法，只保存到本地缓存
   */
  flushPendingPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    // 同步保存到本地缓存（不等待云端）
    const projects = this.projectState.projects();
    if (projects.length > 0) {
      this.syncService.saveOfflineSnapshot(projects);
      this.logger.info('页面卸载前已保存本地缓存', { projectCount: projects.length });
    }
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
   * 
   * 合并策略：
   * 1. 云端不存在的项目 → 直接上传
   * 2. 离线版本号 > 云端版本号 → 上传离线数据
   * 3. 版本号相同时 → 比较 updatedAt 时间戳和任务内容
   * 4. 版本号相同但内容不同 → 保留本地数据（用户最近编辑的）
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
          // 使用返回的新版本号更新项目
          const syncedProject = { ...offlineProject, version: result.newVersion ?? offlineProject.version };
          mergedProjects.push(syncedProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步:', offlineProject.name);
        }
        continue;
      }
      
      const offlineVersion = offlineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      // 检查是否需要同步离线数据
      let shouldSyncOffline = false;
      let reason = '';
      
      if (offlineVersion > cloudVersion) {
        shouldSyncOffline = true;
        reason = '版本号更高';
      } else if (offlineVersion === cloudVersion) {
        // 版本号相同时，比较内容是否有差异
        const hasContentDiff = this.hasProjectContentDifference(offlineProject, cloudProject);
        
        if (hasContentDiff) {
          // 有内容差异，比较更新时间
          const offlineTime = new Date(offlineProject.updatedAt || 0).getTime();
          const cloudTime = new Date(cloudProject.updatedAt || 0).getTime();
          
          if (offlineTime >= cloudTime) {
            shouldSyncOffline = true;
            reason = '本地有未同步的修改';
          } else {
            // 云端更新时间更新，但我们仍需要记录这个潜在的冲突
            this.logger.info('检测到本地修改可能被覆盖', {
              projectId: offlineProject.id,
              offlineTime: new Date(offlineTime).toISOString(),
              cloudTime: new Date(cloudTime).toISOString()
            });
            // 使用智能合并来保留双方的修改
            const mergedProject = this.conflictService.smartMerge(offlineProject, cloudProject);
            shouldSyncOffline = true;
            reason = '智能合并本地和云端修改';
            // 替换 offlineProject 为合并后的版本
            Object.assign(offlineProject, mergedProject);
          }
        }
      }
      
      if (shouldSyncOffline) {
        const projectToSync = { 
          ...offlineProject, 
          version: Math.max(offlineVersion, cloudVersion) + 1 
        };
        
        this.logger.info('同步离线修改', { 
          projectId: offlineProject.id, 
          reason,
          offlineVersion,
          cloudVersion
        });
        
        const result = await this.syncService.saveProjectToCloud(projectToSync, userId);
        if (result.success) {
          // 使用返回的新版本号更新项目
          const syncedProject = { ...projectToSync, version: result.newVersion ?? projectToSync.version };
          const idx = mergedProjects.findIndex(p => p.id === offlineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = syncedProject;
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
   * 检查两个项目是否有内容差异
   * 比较任务数量、任务内容、连接等
   */
  private hasProjectContentDifference(project1: Project, project2: Project): boolean {
    // 比较任务数量
    if (project1.tasks.length !== project2.tasks.length) {
      return true;
    }
    
    // 比较连接数量
    if ((project1.connections?.length ?? 0) !== (project2.connections?.length ?? 0)) {
      return true;
    }
    
    // 创建任务 ID 到内容的映射
    const tasks1Map = new Map(project1.tasks.map(t => [t.id, t]));
    const tasks2Map = new Map(project2.tasks.map(t => [t.id, t]));
    
    // 检查是否有不同的任务 ID
    for (const id of tasks1Map.keys()) {
      if (!tasks2Map.has(id)) {
        return true;
      }
    }
    
    // 比较每个任务的关键内容
    for (const [id, task1] of tasks1Map) {
      const task2 = tasks2Map.get(id);
      if (!task2) {
        return true;
      }
      
      // 比较标题和内容
      if (task1.title !== task2.title || task1.content !== task2.content) {
        return true;
      }
      
      // 比较结构属性
      if (task1.parentId !== task2.parentId || 
          task1.stage !== task2.stage ||
          task1.deletedAt !== task2.deletedAt) {
        return true;
      }
    }
    
    return false;
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
    // 项目更新处理器
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('project:update 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { project: Project };
      try {
        const result = await this.syncService.saveProjectToCloud(payload.project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        if (result.conflict) {
          this.logger.warn('project:update 冲突，需要用户解决', { projectId: payload.project.id });
          // 冲突不算失败，由冲突解决流程处理
          return true;
        }
        return result.success;
      } catch (error) {
        this.logger.error('project:update 异常', { error, projectId: payload.project.id });
        return false;
      }
    });
    
    // 项目删除处理器
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('project:delete 失败：用户未登录');
        return false;
      }
      
      try {
        return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
      } catch (error) {
        this.logger.error('project:delete 异常', { error, projectId: action.entityId });
        return false;
      }
    });
    
    // 项目创建处理器
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('project:create 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { project: Project };
      try {
        const result = await this.syncService.saveProjectToCloud(payload.project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        return result.success;
      } catch (error) {
        this.logger.error('project:create 异常', { error, projectId: payload.project.id });
        return false;
      }
    });
    
    // 任务创建处理器
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('task:create 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) {
        this.logger.warn('task:create 失败：项目不存在', { projectId: payload.projectId });
        return false;
      }
      
      try {
        const result = await this.syncService.saveProjectToCloud(project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        return result.success;
      } catch (error) {
        this.logger.error('task:create 异常', { error, taskId: payload.task.id });
        return false;
      }
    });
    
    // 任务更新处理器
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('task:update 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) {
        this.logger.warn('task:update 失败：项目不存在', { projectId: payload.projectId });
        return false;
      }
      
      try {
        const result = await this.syncService.saveProjectToCloud(project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        return result.success;
      } catch (error) {
        this.logger.error('task:update 异常', { error, taskId: payload.task.id });
        return false;
      }
    });
    
    // 任务删除处理器
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('task:delete 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { taskId: string; projectId: string };
      const project = this.projectState.projects().find(p => p.id === payload.projectId);
      if (!project) {
        this.logger.warn('task:delete 失败：项目不存在', { projectId: payload.projectId });
        return false;
      }
      
      try {
        const result = await this.syncService.saveProjectToCloud(project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        return result.success;
      } catch (error) {
        this.logger.error('task:delete 异常', { error, taskId: payload.taskId });
        return false;
      }
    });
    
    // 用户偏好更新处理器
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('preference:update 失败：用户未登录');
        return false;
      }
      
      const payload = action.payload as { preferences: Partial<UserPreferences>; userId: string };
      try {
        return await this.syncService.saveUserPreferences(userId, payload.preferences);
      } catch (error) {
        this.logger.error('preference:update 异常', { error });
        return false;
      }
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
    const now = new Date().toISOString();
    
    // 更新活动项目的 updatedAt 时间戳
    const updatedProjects = projects.map(p => 
      p.id === project?.id ? { ...p, updatedAt: now } : p
    );
    
    // 始终先保存到本地离线快照（防止任何情况下的数据丢失）
    // 注意：这里使用更新后的项目列表，确保 updatedAt 被保存
    this.syncService.saveOfflineSnapshot(updatedProjects);
    
    if (!project) {
      return;
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      // 未登录时仅保存到本地，但需要更新本地状态的 updatedAt
      this.projectState.updateProjects(ps => {
        // DEBUG: 检查更新前的任务状态
        const targetProject = ps.find(p => p.id === project.id);
        if (targetProject) {
          const stage1Roots = targetProject.tasks.filter(t => t.stage === 1 && !t.parentId && !t.deletedAt);
          const invalidRoots = stage1Roots.filter(t => t.displayId === '?' || !t.displayId);
          if (invalidRoots.length > 0) {
            console.warn('[doPersistActiveProject offline] BEFORE update - Stage 1 roots with invalid displayId:', 
              invalidRoots.map(t => ({ id: t.id.slice(-4), displayId: t.displayId }))
            );
          }
        }
        return ps.map(p => p.id === project.id ? { ...p, updatedAt: now } : p);
      });
      return;
    }

    try {
      const result = await this.syncService.saveProjectToCloud(
        { ...project, updatedAt: now },
        userId
      );
      
      if (result.success) {
        // 更新本地状态：updatedAt 和 version（如果有返回）
        this.projectState.updateProjects(ps => {
          // DEBUG: 检查更新前的任务状态
          const targetProject = ps.find(p => p.id === project.id);
          if (targetProject) {
            const stage1Roots = targetProject.tasks.filter(t => t.stage === 1 && !t.parentId && !t.deletedAt);
            const invalidRoots = stage1Roots.filter(t => t.displayId === '?' || !t.displayId);
            if (invalidRoots.length > 0) {
              console.warn('[doPersistActiveProject success] BEFORE update - Stage 1 roots with invalid displayId:', 
                invalidRoots.map(t => ({ id: t.id.slice(-4), displayId: t.displayId }))
              );
            }
          }
          return ps.map(p => 
            p.id === project.id 
              ? { ...p, updatedAt: now, version: result.newVersion ?? p.version } 
              : p
          );
        });
        // 同步成功后，再次保存快照以确保版本号同步
        this.syncService.saveOfflineSnapshot(this.projectState.projects());
        console.log('[Sync] 本地版本号已更新', { projectId: project.id, newVersion: result.newVersion });
      } else if (result.conflict && result.remoteData) {
        // 版本冲突处理：发布冲突事件供 UI 层处理
        this.conflict$.next({
          localProject: project,
          remoteProject: result.remoteData,
          projectId: project.id
        });
        this.logger.warn('检测到数据冲突，等待用户解决', { projectId: project.id });
      }
    } catch (error) {
      this.logger.error('持久化项目时发生异常', { error });
      // 乐观UI：静默记录错误，不阻塞用户操作
      // 数据已保存到本地离线快照，网络恢复后会自动重试
      this.logger.warn('自动保存失败，更改已保存到本地', { error });
      
      // 增强：在离线模式下提示用户
      if (!navigator.onLine) {
        this.toastService.info('离线模式', '更改已保存到本地，联网后将自动同步');
      }
    }
  }
}
