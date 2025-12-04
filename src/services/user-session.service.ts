/**
 * UserSessionService - 用户会话管理服务
 * 
 * 【职责边界】
 * ✓ 用户登录/登出时的状态清理
 * ✓ 切换活动项目
 * ✓ 清空本地数据
 * ✓ 初始化/清理实时订阅
 * ✓ 附件监控的生命周期管理
 * ✗ 认证逻辑 → AuthService
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ UI 状态 → UiStateService
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { AttachmentService } from './attachment.service';
import { MigrationService } from './migration.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import { CACHE_CONFIG, AUTH_CONFIG } from '../config/constants';
import { isFailure } from '../utils/result';
import { ToastService } from './toast.service';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService {
  private readonly logger = inject(LoggerService).category('UserSession');
  private authService = inject(AuthService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private attachmentService = inject(AttachmentService);
  private migrationService = inject(MigrationService);
  private layoutService = inject(LayoutService);
  private toastService = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  /** 当前用户 ID (代理 AuthService) */
  readonly currentUserId = this.authService.currentUserId;

  constructor() {
    this.destroyRef.onDestroy(() => {
      // 清理附件服务回调，防止内存泄漏
      this.attachmentService.clearUrlRefreshCallback();
      this.attachmentService.clearMonitoredAttachments();
    });
  }

  /**
   * 设置当前用户
   * 用户登录/登出时调用
   * 
   * 注意：此方法总是会加载项目数据，即使 userId 相同
   * 这是因为 AuthService.checkSession() 可能已经设置了 userId，
   * 但项目数据还未加载
   */
  async setCurrentUser(userId: string | null): Promise<void> {
    const previousUserId = this.currentUserId();
    const isUserChange = previousUserId !== userId;
    
    // 清理旧用户的附件监控和回调，防止内存泄漏
    if (isUserChange) {
      this.attachmentService.clearMonitoredAttachments();
      this.projectState.setActiveProjectId(null);
      this.projectState.setProjects([]);
      this.undoService.clearHistory();
      this.syncCoordinator.teardownRealtimeSubscription();
    }

    this.authService.currentUserId.set(userId);

    if (userId) {
      // 检查是否已经有项目数据（避免重复加载）
      const hasProjects = this.projectState.projects().length > 0;
      if (!hasProjects || isUserChange) {
        await this.loadUserData(userId);
      }
    } else {
      this.loadFromCacheOrSeed();
    }
  }

  /**
   * 切换活动项目
   */
  switchActiveProject(projectId: string | null): void {
    const previousProjectId = this.projectState.activeProjectId();

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
      const newProject = this.projectState.projects().find(p => p.id === projectId);
      if (newProject) {
        this.monitorProjectAttachments(newProject);
      }
    } else {
      this.attachmentService.clearMonitoredAttachments();
    }
  }

  /**
   * 清空本地数据
   */
  clearLocalData(): void {
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.syncCoordinator.clearOfflineCache();
  }

  /**
   * 加载项目列表
   * 支持离线模式和在线模式
   * 即使云端加载失败，也会尝试从本地缓存恢复
   * 
   * 【超时保护】云端加载有 15 秒超时，超时后自动降级到本地缓存
   */
  async loadProjects(): Promise<void> {
    const userId = this.currentUserId();
    console.log('[Session] loadProjects 开始, userId:', userId);
    
    if (!userId) {
      console.log('[Session] 无 userId，从缓存或种子加载');
      this.loadFromCacheOrSeed();
      return;
    }
    
    // 如果是本地模式用户，直接从缓存加载，不尝试云端同步
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      console.log('[Session] 本地模式，从缓存或种子加载');
      this.loadFromCacheOrSeed();
      return;
    }

    const previousActive = this.projectState.activeProjectId();
    const offlineProjects = this.syncCoordinator.loadOfflineSnapshot();
    console.log('[Session] 离线缓存项目数量:', offlineProjects?.length ?? 0);
    
    let projects: Project[] = [];
    try {
      // 添加超时保护：15 秒后自动降级到本地缓存
      const LOAD_TIMEOUT = 15000;
      const loadPromise = this.syncCoordinator.loadProjectsFromCloud(userId);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('云端数据加载超时')), LOAD_TIMEOUT);
      });
      
      projects = await Promise.race([loadPromise, timeoutPromise]);
      console.log('[Session] 云端加载项目数量:', projects.length);
    } catch (e) {
      console.error('[Session] 云端数据加载失败:', e);
      // 加载失败时使用本地缓存
      this.loadFromCacheOrSeed();
      const errorMsg = e instanceof Error ? e.message : '未知错误';
      this.toastService.warning('网络问题', `${errorMsg}，已加载本地缓存数据`);
      return;
    }

    if (projects.length > 0) {
      const validatedProjects: Project[] = [];
      const failedProjects: string[] = [];

      for (const p of projects) {
        console.log('[Session] 云端项目详情:', {
          id: p.id,
          name: p.name,
          taskCount: p.tasks?.length ?? 0,
          version: p.version,
          updatedAt: p.updatedAt
        });
        const result = this.syncCoordinator.validateAndRebalanceWithResult(p);
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
        // 记录离线缓存的详细信息
        for (const op of offlineProjects) {
          console.log('[Session] 离线缓存项目详情:', {
            id: op.id,
            name: op.name,
            taskCount: op.tasks?.length ?? 0,
            version: op.version,
            updatedAt: op.updatedAt
          });
        }
        
        const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
          rebalanced,
          offlineProjects,
          userId
        );
        rebalanced = mergeResult.projects;
        
        // 记录合并后的结果
        console.log('[Session] 合并后项目数量:', rebalanced.length);
        for (const rp of rebalanced) {
          console.log('[Session] 合并后项目详情:', {
            id: rp.id,
            name: rp.name,
            taskCount: rp.tasks?.length ?? 0,
            version: rp.version
          });
        }

        if (mergeResult.syncedCount > 0) {
          this.toastService.success(
            '离线数据已同步',
            `已将 ${mergeResult.syncedCount} 个项目的离线修改同步到云端`
          );
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

      this.syncCoordinator.saveOfflineSnapshot(rebalanced);
    } else if (this.syncCoordinator.offlineMode()) {
      console.log('[Session] 离线模式，从缓存加载');
      this.loadFromCacheOrSeed();
      this.toastService.warning('离线模式', '网络不可用，数据仅保存在本地');
    } else {
      // 云端没有数据但有离线缓存 - 首次登录时迁移本地数据
      console.log('[Session] 云端无数据，检查离线缓存');
      
      if (offlineProjects && offlineProjects.length > 0) {
        console.log('[Session] 发现离线缓存，尝试迁移到云端');
        this.logger.info('首次登录，迁移本地离线数据到云端');
        
        let syncedCount = 0;
        const projectsToSync: Project[] = [];
        const failedProjects: string[] = [];
        
        for (const offlineProject of offlineProjects) {
          console.log('[Session] 迁移项目:', offlineProject.id, offlineProject.name);
          const rebalanced = this.layoutService.rebalance(offlineProject);
          const result = await this.syncCoordinator.saveProjectToCloud(rebalanced, userId);
          if (result.success) {
            projectsToSync.push(rebalanced);
            syncedCount++;
            console.log('[Session] 项目迁移成功:', offlineProject.name);
          } else {
            failedProjects.push(offlineProject.name || offlineProject.id);
            console.error('[Session] 项目迁移失败:', offlineProject.name, result);
          }
        }
        
        if (projectsToSync.length > 0) {
          this.projectState.setProjects(projectsToSync);
          this.projectState.setActiveProjectId(projectsToSync[0]?.id ?? null);
          this.syncCoordinator.saveOfflineSnapshot(projectsToSync);
          
          if (syncedCount > 0) {
            this.toastService.success(
              '本地数据已同步',
              `已将 ${syncedCount} 个项目同步到云端`
            );
          }
          
          if (failedProjects.length > 0) {
            this.toastService.warning(
              '部分项目同步失败',
              `以下项目无法同步: ${failedProjects.join(', ')}`
            );
          }
        } else {
          // 离线数据同步失败，回退到种子数据
          console.error('[Session] 所有离线项目迁移失败，使用种子数据');
          this.logger.warn('离线数据同步失败，使用种子数据');
          this.loadFromCacheOrSeed();
          
          // 告知用户同步失败的原因
          this.toastService.error(
            '数据同步失败',
            '无法将本地数据同步到云端，请检查网络连接后重试'
          );
        }
      } else {
        // 云端和本地都没有数据，使用种子数据
        console.log('[Session] 云端和本地都无数据，使用种子数据');
        this.logger.info('首次登录且无本地数据，初始化种子数据');
        this.loadFromCacheOrSeed();
      }
    }

    const syncError = this.syncCoordinator.syncError();
    if (syncError) {
      this.toastService.error('同步失败', syncError);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 加载用户数据
   * 
   * 关键设计：loadProjects 是同步阻塞的（等待完成），
   * 但 initRealtimeSubscription 和 tryReloadConflictData 是后台执行的。
   * 这确保用户能尽快看到数据，而实时订阅在后台建立。
   */
  private async loadUserData(userId: string): Promise<void> {
    // 先加载项目数据（这个需要等待）
    try {
      await this.loadProjects();
    } catch (error) {
      // loadProjects 内部已有错误处理，这里是最后的防线
      console.error('[Session] loadProjects 未捕获异常:', error);
      this.loadFromCacheOrSeed();
      this.toastService.error('数据加载失败', '已加载本地缓存数据');
    }
    
    // 实时订阅和冲突数据重载在后台执行，不阻塞 UI
    // 使用 Promise 而非 await，让它们在后台运行
    this.syncCoordinator.initRealtimeSubscription(userId).catch(e => {
      console.warn('实时订阅初始化失败（后台）:', e);
      // 实时订阅失败不影响核心功能，静默处理
    });

    this.syncCoordinator.tryReloadConflictData(userId, (id) =>
      this.projectState.projects().find(p => p.id === id)
    ).catch(e => {
      console.warn('冲突数据重载失败（后台）:', e);
      // 冲突数据重载失败不影响核心功能，静默处理
    });
  }

  /**
   * 从缓存或种子数据加载
   * 包含数据完整性检查
   */
  private loadFromCacheOrSeed(): void {
    const cached = this.syncCoordinator.loadOfflineSnapshot();
    let projects: Project[] = [];

    if (cached && cached.length > 0) {
      // 验证并迁移每个缓存的项目
      const validProjects: Project[] = [];
      const corruptedProjects: string[] = [];
      
      for (const p of cached) {
        try {
          const migrated = this.migrateProject(p);
          // 基本完整性检查
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          } else {
            corruptedProjects.push(p.name || p.id || '未知项目');
          }
        } catch (error) {
          console.error('[Session] 项目迁移失败:', p.id, error);
          corruptedProjects.push(p.name || p.id || '未知项目');
        }
      }
      
      if (corruptedProjects.length > 0) {
        console.warn('[Session] 跳过损坏的项目:', corruptedProjects);
        this.toastService.warning(
          '部分数据已跳过',
          `以下项目数据损坏已跳过: ${corruptedProjects.join(', ')}`
        );
      }
      
      projects = validProjects.length > 0 ? validProjects : this.seedProjects();
    } else {
      projects = this.seedProjects();
    }

    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(projects[0]?.id ?? null);
  }

  /**
   * 迁移项目数据格式
   */
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

  /**
   * 生成种子项目数据
   */
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

  /**
   * 监控项目附件 URL
   */
  private monitorProjectAttachments(project: Project): void {
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
}
