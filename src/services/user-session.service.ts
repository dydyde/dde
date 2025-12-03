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
import { Project } from '../models';
import { CACHE_CONFIG } from '../config/constants';
import { isFailure } from '../utils/result';
import { ToastService } from './toast.service';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService {
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
   */
  async setCurrentUser(userId: string | null): Promise<void> {
    if (this.currentUserId() === userId) return;

    // 清理旧用户的附件监控和回调，防止内存泄漏
    this.attachmentService.clearMonitoredAttachments();

    this.authService.currentUserId.set(userId);
    this.projectState.setActiveProjectId(null);
    this.projectState.setProjects([]);
    this.undoService.clearHistory();
    this.syncCoordinator.teardownRealtimeSubscription();

    if (userId) {
      await this.loadUserData(userId);
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
   */
  async loadProjects(): Promise<void> {
    const userId = this.currentUserId();
    if (!userId) {
      this.loadFromCacheOrSeed();
      return;
    }

    const previousActive = this.projectState.activeProjectId();
    const offlineProjects = this.syncCoordinator.loadOfflineSnapshot();
    const projects = await this.syncCoordinator.loadProjectsFromCloud(userId);

    if (projects.length > 0) {
      const validatedProjects: Project[] = [];
      const failedProjects: string[] = [];

      for (const p of projects) {
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
        const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
          rebalanced,
          offlineProjects,
          userId
        );
        rebalanced = mergeResult.projects;

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
      this.loadFromCacheOrSeed();
      this.toastService.warning('离线模式', '网络不可用，数据仅保存在本地');
    }

    const syncError = this.syncCoordinator.syncError();
    if (syncError) {
      this.toastService.error('同步失败', syncError);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 加载用户数据
   */
  private async loadUserData(userId: string): Promise<void> {
    await this.loadProjects();
    await this.syncCoordinator.initRealtimeSubscription(userId);

    await this.syncCoordinator.tryReloadConflictData(userId, (id) =>
      this.projectState.projects().find(p => p.id === id)
    );
  }

  /**
   * 从缓存或种子数据加载
   */
  private loadFromCacheOrSeed(): void {
    const cached = this.syncCoordinator.loadOfflineSnapshot();
    let projects: Project[] = [];

    if (cached && cached.length > 0) {
      projects = cached.map(p => this.migrateProject(p));
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
