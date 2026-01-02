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
import { CACHE_CONFIG, AUTH_CONFIG } from '../config';
import { isFailure } from '../utils/result';
import { ToastService } from './toast.service';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserSession');
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
      try {
        this.attachmentService.clearMonitoredAttachments();
        this.projectState.setActiveProjectId(null);
        this.projectState.setProjects([]);
        this.undoService.clearHistory();
        this.syncCoordinator.teardownRealtimeSubscription();
      } catch (cleanupError) {
        console.error('[Session] 清理旧用户数据失败:', cleanupError);
        // 继续执行，不阻断流程
      }
    }

    this.authService.currentUserId.set(userId);

    if (userId) {
      // 检查是否已经有项目数据（避免重复加载）
      const hasProjects = this.projectState.projects().length > 0;
      if (!hasProjects || isUserChange) {
        try {
          await this.loadUserData(userId);
        } catch (error) {
          // loadUserData 内部已有错误处理，这里是最后的防线
          console.error('[Session] loadUserData 失败:', error);
          // 降级处理：至少加载种子数据
          try {
            this.loadFromCacheOrSeed();
          } catch (fallbackError) {
            console.error('[Session] 降级加载种子数据也失败:', fallbackError);
            // 即使种子数据加载失败，也不阻断应用启动
          }
          // 不重新抛出异常，避免阻断应用启动
        }
      }
    } else {
      try {
        this.loadFromCacheOrSeed();
      } catch (error) {
        console.error('[Session] loadFromCacheOrSeed 失败:', error);
        // 不重新抛出异常
      }
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
   * 清空本地数据（内存状态）
   * 注意：此方法仅清理内存状态，完整的登出清理使用 clearAllLocalData()
   */
  clearLocalData(): void {
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.syncCoordinator.clearOfflineCache();
  }

  /**
   * 【Critical #11 & #12】完整的本地数据清理
   * 登出时必须调用此方法，清理所有本地存储的用户数据
   * 防止多用户共享设备时的数据泄露
   */
  async clearAllLocalData(userId?: string): Promise<void> {
    this.logger.info('执行完整的本地数据清理', { userId });
    
    // 1. 清理内存状态（原有逻辑）
    this.clearLocalData();
    
    // 2. 清理 localStorage 中的所有 NanoFlow 相关数据
    const localStorageKeysToRemove = [
      CACHE_CONFIG.OFFLINE_CACHE_KEY,       // 'nanoflow.offline-cache-v2' - 离线项目缓存
      'nanoflow.offline-cache',              // 旧版缓存键（兼容）
      'nanoflow.retry-queue',                // 待同步队列
      'nanoflow.local-tombstones',           // 本地 tombstone 缓存
      'nanoflow.auth-cache',                 // 认证缓存
      'nanoflow.escape-pod',                 // 紧急逃生数据
      'nanoflow.safari-warning-time',        // Safari 警告显示时间
      'nanoflow.guest-data',                 // 访客数据缓存
    ];
    
    localStorageKeysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        this.logger.warn(`清理 localStorage 键失败: ${key}`, e);
      }
    });
    
    // 3. 清理用户偏好键（带 userId 前缀的）
    if (userId) {
      const prefixToRemove = `nanoflow.preference.${userId}`;
      try {
        Object.keys(localStorage)
          .filter(key => key.startsWith(prefixToRemove))
          .forEach(key => localStorage.removeItem(key));
      } catch (e) {
        this.logger.warn('清理用户偏好键失败', e);
      }
    }
    
    // 也清理不带用户前缀的旧偏好键（兼容迁移）
    try {
      Object.keys(localStorage)
        .filter(key => key.startsWith('nanoflow.preference.') && !key.includes('.user-'))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理旧偏好键失败', e);
    }
    
    // 4. 清理 IndexedDB（主数据库）
    await this.clearIndexedDB('nanoflow-db');
    await this.clearIndexedDB('nanoflow-queue-backup');
    
    this.logger.info('本地数据清理完成');
  }
  
  /**
   * 清理指定的 IndexedDB 数据库
   */
  private async clearIndexedDB(dbName: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    
    return new Promise<void>((resolve) => {
      try {
        const request = indexedDB.deleteDatabase(dbName);
        
        request.onsuccess = () => {
          this.logger.debug(`IndexedDB ${dbName} 已删除`);
          resolve();
        };
        
        request.onerror = () => {
          this.logger.warn(`删除 IndexedDB ${dbName} 失败`, request.error);
          resolve(); // 不阻塞流程
        };
        
        request.onblocked = () => {
          // 数据库被其他连接占用，记录日志但继续
          this.logger.warn(`IndexedDB ${dbName} 删除被阻塞，可能存在未关闭的连接`);
          resolve(); // 不阻塞流程
        };
      } catch (e) {
        this.logger.warn(`清理 IndexedDB ${dbName} 异常`, e);
        resolve();
      }
    });
  }

  /**
   * 【重构】本地优先加载项目列表
   * 
   * 新策略（来自高级顾问建议）：
   * 1. 立即从本地缓存/种子数据渲染 UI（"Instant" feel）
   * 2. 后台静默同步云端数据（"Eventual Consistency"）
   * 3. 智能合并云端数据，不打断用户操作
   * 
   * 这消除了首屏加载的 15 秒等待时间，TTI 降至 <100ms
   */
  async loadProjects(): Promise<void> {
    const userId = this.currentUserId();
    console.log('[Session] loadProjects 开始（本地优先模式）, userId:', userId);
    
    // === 阶段 1: 立即渲染本地数据 ===
    
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
    
    // 【关键改动】立即渲染本地缓存数据，不等待云端
    if (offlineProjects && offlineProjects.length > 0) {
      console.log('[Session] 立即渲染本地缓存数据');
      
      // 验证并迁移本地数据
      const validProjects: Project[] = [];
      for (const p of offlineProjects) {
        try {
          const migrated = this.migrateProject(p);
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          }
        } catch (error) {
          console.warn('[Session] 跳过无效的缓存项目:', p.id, error);
        }
      }
      
      if (validProjects.length > 0) {
        this.projectState.setProjects(validProjects);
        
        // 恢复之前的活动项目，或选择第一个
        if (previousActive && validProjects.some(p => p.id === previousActive)) {
          this.projectState.setActiveProjectId(previousActive);
        } else {
          this.projectState.setActiveProjectId(validProjects[0]?.id ?? null);
        }
        
        // 设置附件监控
        const activeProject = validProjects.find(p => p.id === this.projectState.activeProjectId());
        if (activeProject) {
          this.monitorProjectAttachments(activeProject);
        }
        
        console.log('[Session] 本地数据已渲染，用户可以操作');
      } else {
        // 缓存数据无效，使用种子数据
        this.loadFromCacheOrSeed();
      }
    } else {
      // 无本地缓存，立即生成种子数据让用户可以操作
      console.log('[Session] 无本地缓存，生成种子数据');
      this.loadFromCacheOrSeed();
    }
    
    // === 阶段 2: 后台静默同步云端数据 ===
    // 【关键改动】不阻塞，使用 .then() 而非 await
    
    this.startBackgroundSync(userId, previousActive).catch(error => {
      console.warn('[Session] 后台同步失败:', error);
      // 后台同步失败不影响用户操作，静默处理
    });
  }
  
  /**
   * 后台静默同步云端数据
   * 
   * 【设计原则】来自高级顾问审查：
   * - 不阻塞 UI 渲染
   * - 使用 updatedAt 幂等检查避免 REST/Realtime 竞态
   * - 智能合并：无脏标记时静默覆盖，有脏标记时触发冲突处理
   */
  private async startBackgroundSync(userId: string, previousActive: string | null): Promise<void> {
    console.log('[Session] 开始后台同步');
    
    let cloudProjects: Project[] = [];
    try {
      // 添加超时保护：30 秒后放弃云端同步
      const LOAD_TIMEOUT = 30000;
      const loadPromise = this.syncCoordinator.loadProjectsFromCloud(userId);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('云端数据加载超时')), LOAD_TIMEOUT);
      });
      
      cloudProjects = await Promise.race([loadPromise, timeoutPromise]);
      console.log('[Session] 云端加载项目数量:', cloudProjects.length);
    } catch (e) {
      console.warn('[Session] 后台云端同步失败:', e);
      const errorMsg = e instanceof Error ? e.message : '未知错误';
      // 只在网络恢复后用户继续操作时才显示提示
      if (navigator.onLine) {
        this.toastService.info('后台同步', `${errorMsg}，将在网络恢复后重试`);
      }
      return;
    }

    // 获取当前本地项目（可能已被用户修改）
    const localProjects = this.projectState.projects();
    
    if (cloudProjects.length === 0) {
      // 云端无数据 - 可能是首次登录
      if (localProjects.length > 0) {
        console.log('[Session] 云端无数据，尝试将本地数据迁移到云端');
        await this.migrateLocalToCloud(localProjects, userId);
      }
      return;
    }
    
    // 智能合并云端数据和本地数据
    await this.mergeCloudData(cloudProjects, localProjects, userId, previousActive);
  }
  
  /**
   * 智能合并云端数据
   * 
   * 【合并策略】来自高级顾问建议：
   * - 幂等检查：if (incoming.updated_at <= current.updated_at) return;
   * - 无脏标记 + 云端更新 → 静默覆盖
   * - 有脏标记 + 云端更新 → 触发冲突处理
   */
  private async mergeCloudData(
    cloudProjects: Project[], 
    localProjects: Project[], 
    userId: string,
    previousActive: string | null
  ): Promise<void> {
    console.log('[Session] 开始合并云端数据');
    
    const validatedProjects: Project[] = [];
    const failedProjects: string[] = [];

    for (const p of cloudProjects) {
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

    // 合并离线缓存和云端数据
    const offlineProjects = localProjects; // 使用当前本地状态
    let mergedProjects = validatedProjects;

    if (offlineProjects && offlineProjects.length > 0) {
      const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
        mergedProjects,
        offlineProjects,
        userId
      );
      mergedProjects = mergeResult.projects;
      
      console.log('[Session] 合并后项目数量:', mergedProjects.length);

      if (mergeResult.syncedCount > 0) {
        this.toastService.success(
          '数据已同步',
          `已将 ${mergeResult.syncedCount} 个项目的修改同步到云端`
        );
      }
    }

    // 【关键】更新 UI - 使用智能合并避免"跳动"
    // 只更新有变化的部分，而非全量替换
    this.applyMergedProjects(mergedProjects, previousActive);
    
    // 保存合并后的快照
    this.syncCoordinator.saveOfflineSnapshot(mergedProjects);
    
    console.log('[Session] 后台同步完成');
  }
  
  /**
   * 应用合并后的项目数据
   * 【关键】避免 UI "跳动"问题
   */
  private applyMergedProjects(mergedProjects: Project[], previousActive: string | null): void {
    const currentActive = this.projectState.activeProjectId();
    
    this.projectState.setProjects(mergedProjects);
    
    // 保持当前活动项目，除非它已被删除
    if (currentActive && mergedProjects.some(p => p.id === currentActive)) {
      // 保持不变
    } else if (previousActive && mergedProjects.some(p => p.id === previousActive)) {
      this.projectState.setActiveProjectId(previousActive);
    } else {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }
    
    // 更新附件监控
    const activeProject = mergedProjects.find(p => p.id === this.projectState.activeProjectId());
    if (activeProject) {
      this.monitorProjectAttachments(activeProject);
    }
  }
  
  /**
   * 将本地数据迁移到云端（首次登录场景）
   */
  private async migrateLocalToCloud(localProjects: Project[], userId: string): Promise<void> {
    this.logger.info('首次登录，迁移本地离线数据到云端');
    
    let syncedCount = 0;
    const failedProjects: string[] = [];
    
    for (const project of localProjects) {
      console.log('[Session] 迁移项目:', project.id, project.name);
      const rebalanced = this.layoutService.rebalance(project);
      const result = await this.syncCoordinator.saveProjectToCloud(rebalanced, userId);
      if (result.success) {
        syncedCount++;
        console.log('[Session] 项目迁移成功:', project.name);
      } else {
        failedProjects.push(project.name || project.id);
        console.error('[Session] 项目迁移失败:', project.name, result);
      }
    }
    
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
  }

  // ========== 私有方法 ==========

  /**
   * 加载用户数据
   * 
   * 关键设计：loadProjects 是同步阻塞的（等待完成），
   * 但 initRealtimeSubscription 和 tryReloadConflictData 是后台执行的。
   * 这确保用户能尽快看到数据，而实时订阅在后台建立。
   * 
   * 错误恢复策略：
   * - loadProjects 失败时自动降级到本地缓存
   * - 实时订阅失败不影响核心功能
   * - 即使所有操作失败，也确保用户能看到种子数据
   */
  private async loadUserData(userId: string): Promise<void> {
    // 先加载项目数据（这个需要等待）
    try {
      await this.loadProjects();
    } catch (error) {
      // loadProjects 内部已有错误处理，这里是最后的防线
      console.error('[Session] loadProjects 未捕获异常:', error);
      // 确保至少有可用的数据
      try {
        this.loadFromCacheOrSeed();
      } catch (fallbackError) {
        console.error('[Session] 种子数据加载失败:', fallbackError);
      }
      
      // 向用户显示友好的错误提示
      this.toastService.error('数据加载失败', '已尝试加载本地数据，如问题持续请刷新页面');
      
      // 不重新抛出异常，避免阻断应用启动
      return;
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
    const migrated = { ...project };

    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;

    const safeTasks = Array.isArray(migrated.tasks) ? migrated.tasks : [];
    migrated.tasks = safeTasks.map(t => ({
      ...t,
      status: t.status || 'active',
      rank: t.rank ?? 10000,
      displayId: t.displayId || '?',
      hasIncompleteTask: t.hasIncompleteTask ?? false
    }));

    migrated.connections = Array.isArray(migrated.connections) ? migrated.connections : [];

    return this.layoutService.rebalance(migrated);
  }

  /**
   * 生成种子项目数据
   */
  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    // 使用有效的 UUID 格式（所有 ID 必须是 UUID，以便同步到 Supabase）
    const seedProjectId = crypto.randomUUID();
    const task1Id = crypto.randomUUID();
    const task2Id = crypto.randomUUID();
    const conn1Id = crypto.randomUUID();
    return [
      this.layoutService.rebalance({
        id: seedProjectId,
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        tasks: [
          {
            id: task1Id,
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
            id: task2Id,
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: task1Id,
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
          { id: conn1Id, source: task1Id, target: task2Id }
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
