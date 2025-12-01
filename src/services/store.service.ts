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
  private authService = inject(AuthService);
  private syncService = inject(SyncService);
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private actionQueue = inject(ActionQueueService);
  private migrationService = inject(MigrationService);
  private conflictService = inject(ConflictResolutionService);
  private attachmentService = inject(AttachmentService);
  private destroyRef = inject(DestroyRef);
  
  // ========== 代理访问其他服务的状态 ==========
  
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
  
  // ========== UI 状态 ==========
  
  readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth < 768);
  readonly sidebarWidth = signal(280);
  readonly textColumnRatio = signal(50);
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');
  readonly theme = signal<ThemeType>('default');
  readonly isTextUnfinishedOpen = signal(true);
  readonly isTextUnassignedOpen = signal(true);
  readonly isFlowUnfinishedOpen = signal(true);
  readonly isFlowUnassignedOpen = signal(true);
  readonly isFlowDetailOpen = signal(false);
  
  /** 统一搜索查询 - 同时搜索项目和任务 */
  readonly searchQuery = signal<string>('');
  
  /** 项目列表搜索查询 (为了向后兼容保留) */
  readonly projectSearchQuery = signal<string>('');
  
  /** 统一搜索查询防抖定时器 */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 防抖后的搜索查询 */
  private debouncedSearchQuery = signal<string>('');

  // ========== 核心数据状态 ==========
  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all');
  readonly stageViewRootFilter = signal<'all' | string>('all');
  readonly stageFilter = signal<'all' | number>('all');
  
  // ========== 私有状态 ==========
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingLocalChanges = false;
  private lastPersistAt = 0;
  private isEditing = false;
  private editingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateType: 'content' | 'structure' | 'position' = 'structure';
  
  /** 持久化操作锁 - 防止并发写入导致数据损坏 */
  private isPersisting = false;
  /** 持久化操作队列 - 记录锁定期间是否有新的持久化请求 */
  private persistPending = false;
  
  /** 重平衡锁定的阶段 */
  private rebalancingStages = new Set<number>();
  
  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // ========== 冲突处理回调 ==========
  
  /** 冲突回调函数，由 AppComponent 设置 */
  onConflict: ((localProject: Project, remoteProject: Project, projectId: string) => void) | null = null;

  // ========== 计算属性 ==========

  readonly activeProject = computed(() => 
    this.projects().find(p => p.id === this.activeProjectId()) || null
  );

  readonly tasks = computed(() => this.activeProject()?.tasks || []);

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null);
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    for (const [, val] of stagesMap.entries()) {
      val.sort((a, b) => a.order - b.order);
    }
    
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null && !t.deletedAt);
  });

  /** 已删除（回收站）中的任务 */
  readonly deletedTasks = computed(() => {
    return this.tasks().filter(t => t.deletedAt);
  });

  readonly unfinishedItems = computed<UnfinishedItem[]>(() => {
    const items: UnfinishedItem[] = [];
    const tasks = this.tasks();
    const filter = this.filterMode();
    
    let rootDisplayId = '';
    if (filter !== 'all') {
      const root = tasks.find(r => r.id === filter);
      if (root) rootDisplayId = root.displayId;
    }

    // 支持 - 和 * 作为列表标记
    const todoRegex = /[-*]\s*\[ \]\s*(.+)/g;
    // 用于移除代码块的正则
    const codeBlockRegex = /```[\s\S]*?```/g;

    tasks.forEach(t => {
      if (rootDisplayId) {
        const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
        if (!isDescendant) return;
      }

      // 先移除代码块内容，避免误判
      const contentWithoutCodeBlocks = t.content.replace(codeBlockRegex, '');
      
      let match;
      while ((match = todoRegex.exec(contentWithoutCodeBlocks)) !== null) {
        items.push({
          taskId: t.id,
          taskDisplayId: t.displayId,
          text: match[1].trim()
        });
      }
    });
    return items;
  });
  
  readonly searchResults = computed(() => {
    const query = this.normalizeSearchQuery(this.searchQuery());
    if (!query) return [];
    
    return this.tasks().filter(t => 
      this.fuzzyMatch(t.title, query) ||
      this.fuzzyMatch(t.content, query) ||
      this.fuzzyMatch(t.displayId, query) ||
      // 搜索短 ID
      (t.shortId && this.fuzzyMatch(t.shortId, query)) ||
      // 搜索附件名称
      (t.attachments?.some(a => this.fuzzyMatch(a.name, query)) ?? false) ||
      // 搜索标签
      (t.tags?.some(tag => this.fuzzyMatch(tag, query)) ?? false)
    );
  });

  /** 项目列表搜索结果（模糊搜索）*/
  readonly filteredProjects = computed(() => {
    const query = this.normalizeSearchQuery(this.projectSearchQuery());
    const projects = this.projects();
    
    if (!query) return projects;
    
    // 模糊搜索：支持项目名称、描述的部分匹配
    return projects.filter(p => {
      const nameMatch = this.fuzzyMatch(p.name, query);
      const descMatch = p.description ? this.fuzzyMatch(p.description, query) : false;
      return nameMatch || descMatch;
    });
  });

  readonly rootTasks = computed(() => {
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => regex.test(t.content || ''));
    
    return tasks.filter(t => t.stage === 1).filter(root => {
      if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
      return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    return this.tasks().filter(t => t.stage === 1).sort((a, b) => a.rank - b.rank);
  });

  constructor() {
    this.loadFromCacheOrSeed();
    this.setupActionQueueProcessors();
    this.startTrashCleanupTimer();
    this.setupAttachmentUrlRefresh();
    this.setupQueueSyncCoordination();
    
    // 设置远程变更回调 - 使用增量更新而非全量重载
    this.syncService.setRemoteChangeCallback(async (payload) => {
      if (this.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      
      try {
        // 尝试增量更新
        if (payload?.eventType && payload?.projectId) {
          await this.handleIncrementalUpdate(payload);
        } else {
          // 回退到全量加载
          await this.loadProjects();
        }
      } catch (e) {
        console.error('处理远程变更失败', e);
        // 静默失败，不影响用户操作
      }
    });
    
    // 设置任务级别变更回调 - 支持实时同步单个任务
    this.syncService.setTaskChangeCallback((payload) => {
      if (this.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      
      this.handleTaskLevelUpdate(payload);
    });
    
    // 清理
    this.destroyRef.onDestroy(() => {
      // 确保待处理的防抖操作被保存
      this.undoService.flushPendingAction();
      
      if (this.persistTimer) clearTimeout(this.persistTimer);
      if (this.editingTimer) clearTimeout(this.editingTimer);
      if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
      if (this.trashCleanupTimer) clearInterval(this.trashCleanupTimer);
      this.syncService.destroy();
    });
  }
  
  /**
   * 处理任务级别的远程更新
   * 支持实时同步单个任务的增删改
   */
  private handleTaskLevelUpdate(payload: { eventType: string; taskId: string; projectId: string; data?: Record<string, unknown> }) {
    const { eventType, taskId, projectId, data } = payload;
    
    // 仅处理当前活动项目的任务变更
    if (projectId !== this.activeProjectId()) {
      return;
    }
    
    switch (eventType) {
      case 'DELETE':
        // 远程删除任务
        this.projects.update(projects => 
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
        // 插入或更新任务 - 需要从服务器获取完整数据
        // 因为 Realtime 的 payload 可能不包含完整任务数据
        this.syncService.loadSingleProject(projectId, this.currentUserId()!)
          .then(remoteProject => {
            if (!remoteProject) return;
            
            const remoteTask = remoteProject.tasks.find(t => t.id === taskId);
            if (!remoteTask) return;
            
            this.projects.update(projects =>
              projects.map(p => {
                if (p.id !== projectId) return p;
                
                const existingTaskIndex = p.tasks.findIndex(t => t.id === taskId);
                if (existingTaskIndex >= 0) {
                  // 更新现有任务
                  const updatedTasks = [...p.tasks];
                  updatedTasks[existingTaskIndex] = remoteTask;
                  return { ...p, tasks: updatedTasks };
                } else {
                  // 插入新任务
                  return { ...p, tasks: [...p.tasks, remoteTask] };
                }
              })
            );
          })
          .catch(error => {
            console.error('处理远程任务更新失败', error);
          });
        break;
    }
  }

  /**
   * 设置队列同步与 Realtime 的协调
   * 在队列处理期间暂停 Realtime 更新，避免竞态条件
   */
  private setupQueueSyncCoordination() {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.syncService.pauseRealtimeUpdates(),
      () => this.syncService.resumeRealtimeUpdates()
    );
  }

  /**
   * 设置离线操作队列处理器
   */
  private setupActionQueueProcessors() {
    // 项目更新处理器
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      // 类型安全的 payload 访问
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    // 项目删除处理器
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
    });
    
    // 项目创建处理器（复用更新逻辑）
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { project: Project };
      const result = await this.syncService.saveProjectToCloud(payload.project, userId);
      return result.success;
    });
    
    // 任务创建处理器
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      // 任务操作通过项目级别的同步来处理
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    // 任务更新处理器
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { task: Task; projectId: string };
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    // 任务删除处理器
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { taskId: string; projectId: string };
      const project = this.projects().find(p => p.id === payload.projectId);
      if (!project) return false;
      
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    // 用户偏好更新处理器
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const payload = action.payload as { preferences: Partial<import('../models').UserPreferences>; userId: string };
      return await this.syncService.saveUserPreferences(userId, payload.preferences);
    });
  }

  /**
   * 启动回收站自动清理定时器
   */
  private startTrashCleanupTimer() {
    // 启动时立即执行一次清理
    this.cleanupOldTrashItems();
    
    // 定期检查
    this.trashCleanupTimer = setInterval(() => {
      this.cleanupOldTrashItems();
    }, TRASH_CONFIG.CLEANUP_INTERVAL);
  }

  /**
   * 设置附件 URL 刷新回调
   * 当签名 URL 即将过期时，自动刷新并更新任务中的 URL
   */
  private setupAttachmentUrlRefresh() {
    this.attachmentService.setUrlRefreshCallback((refreshedUrls) => {
      if (refreshedUrls.size === 0) return;
      
      // 更新任务中的附件 URL
      this.projects.update(projects => projects.map(project => {
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

  /**
   * 监控当前项目所有附件的 URL（在加载项目时调用）
   */
  private monitorProjectAttachments(project: Project) {
    const userId = this.currentUserId();
    if (!userId) return;
    
    // 清除之前的监控
    this.attachmentService.clearMonitoredAttachments();
    
    // 添加所有附件到监控列表
    for (const task of project.tasks) {
      if (task.attachments && task.attachments.length > 0) {
        for (const attachment of task.attachments) {
          this.attachmentService.monitorAttachment(userId, project.id, task.id, attachment);
        }
      }
    }
  }

  /**
   * 清理超过保留期限的回收站项目
   */
  private cleanupOldTrashItems() {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TRASH_CONFIG.AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    
    this.projects.update(projects => projects.map(project => {
      const tasksToKeep = project.tasks.filter(task => {
        if (!task.deletedAt) return true;
        
        const deletedDate = new Date(task.deletedAt);
        if (deletedDate < cutoffDate) {
          cleanedCount++;
          return false; // 移除超期的已删除任务
        }
        return true;
      });
      
      if (tasksToKeep.length !== project.tasks.length) {
        return { ...project, tasks: tasksToKeep };
      }
      return project;
    }));
    
    if (cleanedCount > 0) {
      console.log(`自动清理了 ${cleanedCount} 个超过 ${TRASH_CONFIG.AUTO_CLEANUP_DAYS} 天的回收站任务`);
      this.schedulePersist();
    }
  }

  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.rebalancingStages.has(stage);
  }

  /**
   * 处理增量更新（而非全量重载）
   */
  private async handleIncrementalUpdate(payload: { eventType: string; projectId: string }) {
    const { eventType, projectId } = payload;
    
    if (eventType === 'DELETE') {
      // 项目被删除，清理相关的撤销历史
      this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);
      
      // 项目被删除
      this.projects.update(ps => ps.filter(p => p.id !== projectId));
      if (this.activeProjectId() === projectId) {
        const remaining = this.projects();
        this.activeProjectId.set(remaining[0]?.id ?? null);
      }
      return;
    }
    
    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const userId = this.currentUserId();
      if (!userId) return;
      
      // 只加载变更的单个项目
      const remoteProject = await this.syncService.loadSingleProject(projectId, userId);
      if (!remoteProject) return;
      
      const localProject = this.projects().find(p => p.id === projectId);
      
      if (!localProject) {
        // 新项目，直接添加
        const validated = this.validateAndRebalance(remoteProject);
        this.projects.update(ps => [...ps, validated]);
      } else {
        // 更新现有项目 - 检查版本号（乐观锁）
        const localVersion = localProject.version ?? 0;
        const remoteVersion = remoteProject.version ?? 0;
        
        if (remoteVersion > localVersion) {
          // 远程版本更新
          const versionDiff = remoteVersion - localVersion;
          
          // 清理过时的撤销历史
          const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
          if (clearedCount > 0) {
            console.log(`清理了 ${clearedCount} 条过时的撤销历史 (项目: ${projectId})`);
          }
          
          // 如果用户正在编辑且版本差距较大，提示用户
          if (this.isEditing && versionDiff > 1) {
            this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
          }
          
          // 智能合并本地和远程更改
          const mergeResult = this.conflictService.smartMerge(localProject, remoteProject);
          
          // 如果有冲突且用户正在编辑，提示用户
          if (mergeResult.conflictCount > 0 && this.isEditing) {
            this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
          }
          
          const validated = this.validateAndRebalance(mergeResult.project);
          this.projects.update(ps => ps.map(p => p.id === projectId ? validated : p));
        }
      }
    }
  }

  // ========== 公共方法 ==========

  /**
   * 压缩 displayId 显示
   */
  compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;
    
    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;
    
    while (i < parts.length) {
      const current = parts[i];
      let count = 1;
      
      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }
      
      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d]).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }
      
      i += count;
    }
    
    return result.join(',');
  }

  /**
   * 设置当前用户（登录/登出时调用）
   */
  async setCurrentUser(userId: string | null) {
    if (this.currentUserId() === userId) return;
    
    this.authService.currentUserId.set(userId);
    this.activeProjectId.set(null);
    this.projects.set([]);
    this.undoService.clearHistory();
    this.syncService.teardownRealtimeSubscription();
    
    if (userId && this.syncService) {
      await this.loadProjects();
      await this.loadUserPreferences();
      await this.syncService.initRealtimeSubscription(userId);
      
      // 尝试恢复持久化的冲突数据
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
   * 切换时会清空之前项目的撤销历史（全局撤销栈 + 切换时清空策略）
   */
  switchActiveProject(projectId: string | null) {
    const previousProjectId = this.activeProjectId();
    
    // 如果切换到同一个项目，无需操作
    if (previousProjectId === projectId) return;
    
    // 清理搜索状态
    this.searchQuery.set('');
    
    // 先 flush 待处理的防抖操作，确保数据不丢失
    this.undoService.flushPendingAction();
    
    // 清空之前项目的撤销历史
    if (previousProjectId) {
      this.undoService.onProjectSwitch(previousProjectId);
    }
    
    // 设置新的活动项目
    this.activeProjectId.set(projectId);
    
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
   * 在撤销前检查版本号，处理远程更新冲突
   */
  undo() {
    const activeProject = this.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);
    
    if (!result) return;
    
    // 版本不匹配，提示用户
    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新，无法撤销');
      // 清理过时的撤销历史
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }
    
    const action = result;
    const project = this.projects().find(p => p.id === action.projectId);
    if (project) {
      const localVersion = project.version ?? 0;
      const snapshotVersion = (action.data.before as any)?.version ?? 0;
      
      // 如果当前版本已超过快照版本太多，可能已有远程更新
      // 仍然执行撤销，但记录日志
      if (localVersion > snapshotVersion + 1) {
        console.warn('Undo 可能覆盖远程更新', { localVersion, snapshotVersion });
        this.toastService.warning('注意', '撤销可能会覆盖其他设备的更新');
      }
    }
    
    // 应用撤销前的状态
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
    
    // 版本不匹配，提示用户
    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }
    
    const action = result;
    
    // 应用重做后的状态
    this.applyProjectSnapshot(action.projectId, action.data.after);
  }

  /**
   * 加载项目
   * 支持离线数据重连同步：当离线期间有数据修改时，重新连接后自动合并
   */
  async loadProjects() {
    const userId = this.currentUserId();
    if (!userId) {
      this.loadFromCacheOrSeed();
      return;
    }
    
    const previousActive = this.activeProjectId();
    
    // 先加载离线缓存，用于后续的离线数据合并检查
    const offlineProjects = this.syncService.loadOfflineSnapshot();
    
    // 从云端加载
    const projects = await this.syncService.loadProjectsFromCloud(userId);
    
    if (projects.length > 0) {
      // 验证并重平衡每个项目，过滤掉验证失败的
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
      
      // 检查是否有离线数据需要合并（离线期间做的修改）
      if (offlineProjects && offlineProjects.length > 0) {
        const mergeResult = await this.mergeOfflineDataOnReconnect(rebalanced, offlineProjects, userId);
        rebalanced = mergeResult.projects;
        
        if (mergeResult.syncedCount > 0) {
          this.toastService.success('离线数据已同步', `已将 ${mergeResult.syncedCount} 个项目的离线修改同步到云端`);
        }
      }
      
      this.projects.set(rebalanced);
      
      if (previousActive && rebalanced.some(p => p.id === previousActive)) {
        this.activeProjectId.set(previousActive);
        // 监控当前活动项目的附件 URL
        const activeProject = rebalanced.find(p => p.id === previousActive);
        if (activeProject) {
          this.monitorProjectAttachments(activeProject);
        }
      } else {
        this.activeProjectId.set(rebalanced[0]?.id ?? null);
        // 监控当前活动项目的附件 URL
        if (rebalanced[0]) {
          this.monitorProjectAttachments(rebalanced[0]);
        }
      }
      
      this.syncService.saveOfflineSnapshot(rebalanced);
    } else if (this.syncService.syncState().offlineMode) {
      this.loadFromCacheOrSeed();
      // 显示离线模式提示
      this.toastService.warning('离线模式', '网络不可用，数据仅保存在本地');
    }
    
    // 检查同步错误
    const syncError = this.syncService.syncState().syncError;
    if (syncError) {
      this.toastService.error('同步失败', syncError);
    }
  }
  
  /**
   * 在重新连接时合并离线数据
   * 比较离线缓存和云端数据，将离线期间的修改同步到云端
   */
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
        // 离线创建的新项目，需要上传到云端
        const result = await this.syncService.saveProjectToCloud(offlineProject, userId);
        if (result.success) {
          mergedProjects.push(offlineProject);
          syncedCount++;
          console.log('离线新建项目已同步:', offlineProject.name);
        }
        continue;
      }
      
      // 比较版本号，如果离线版本更高，说明离线期间有修改
      const offlineVersion = offlineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        // 离线版本更新，需要同步到云端
        // 递增版本号以覆盖
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
          // 存在冲突，触发冲突解决流程
          console.warn('离线数据存在冲突:', offlineProject.name);
          this.onConflict?.(offlineProject, result.remoteData!, offlineProject.id);
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount };
  }

  /**
   * 验证并重平衡项目数据
   * 包括数据完整性检查、循环检测、孤儿修复
   */
  /**
   * 验证并重平衡项目数据
   * 包括数据完整性检查、循环检测、孤儿修复
   * @returns Result 包含处理后的项目或错误信息
   */
  private validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    // 1. 数据验证
    const validation = validateProject(project);
    
    // 区分致命错误和可修复错误
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
    
    // 可修复的验证错误 - 尝试清理数据
    if (!validation.valid) {
      console.warn('项目数据验证失败，尝试清理修复', { 
        projectId: project.id, 
        errors: validation.errors 
      });
      project = sanitizeProject(project);
      
      // 再次验证清理后的数据
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
    
    // 2. 使用 LayoutService 进行完整性检查和修复
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      console.log('已修复数据问题', { projectId: project.id, issues });
    }
    
    // 3. 重平衡
    return success(this.layoutService.rebalance(fixedProject));
  }

  /**
   * 验证并重平衡项目数据 (兼容旧代码)
   * 在严重错误时抛出异常而不是静默继续
   */
  private validateAndRebalance(project: Project): Project {
    const result = this.validateAndRebalanceWithResult(project);
    if (isFailure(result)) {
      // 记录错误并使用原始数据的清理版本作为后备
      const errorMsg = result.error.message;
      console.error('validateAndRebalance 失败:', errorMsg);
      this.toastService.error('数据验证失败', errorMsg);
      // 返回清理后的版本，即使不完美也比完全失败好
      return sanitizeProject(project);
    }
    return result.value;
  }

  /**
   * 清空本地数据
   */
  clearLocalData() {
    this.projects.set([]);
    this.activeProjectId.set(null);
    this.searchQuery.set('');
    this.filterMode.set('all');
    this.stageViewRootFilter.set('all');
    this.stageFilter.set('all');
    this.undoService.clearHistory();
    this.syncService.clearOfflineCache();
  }

  /**
   * 解决数据冲突
   * 解决后自动触发强制同步，确保数据一致性
   */
  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    const localProject = this.projects().find(p => p.id === projectId);
    if (!localProject) return;
    
    const remoteProject = conflictData.remoteData as Project | undefined;
    
    // 委托给 ConflictResolutionService 处理冲突解决逻辑
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
    
    // 重新平衡并验证解决后的项目数据
    const resolvedProject = this.validateAndRebalance(result.value);
    
    // 更新本地项目状态
    this.projects.update(ps => ps.map(p => 
      p.id === projectId ? resolvedProject : p
    ));
    
    // 如果解决冲突的项目是当前活动项目，清空撤销历史并同步新的基准版本号
    // 这样后续的操作才会使用正确的版本号进行版本检测
    if (this.activeProjectId() === projectId) {
      const newVersion = resolvedProject.version ?? 0;
      this.undoService.clearHistory(projectId, newVersion);
    }
    
    // 强制同步解决后的数据（除了选择远程版本的情况）
    if (choice !== 'remote') {
      const userId = this.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.syncService.saveProjectToCloud(resolvedProject, userId);
          if (!syncResult.success && !syncResult.conflict) {
            // 同步失败，加入重试队列
            this.actionQueue.enqueue({
              type: 'update',
              entityType: 'project',
              entityId: projectId,
              payload: { project: resolvedProject }
            });
            this.toastService.warning('同步待重试', '冲突已解决，但同步失败，稍后将自动重试');
          } else if (syncResult.conflict) {
            // 又发生冲突，提示用户
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
    
    // 更新本地缓存
    this.syncService.saveOfflineSnapshot(this.projects());
  }

  // ========== 项目操作 ==========

  /**
   * 添加新项目（乐观更新 + 失败回滚）
   */
  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    const previousProjects = this.projects();
    const previousActiveId = this.activeProjectId();
    
    // 乐观更新：先更新本地状态
    this.projects.update(p => [...p, balanced]);
    this.activeProjectId.set(balanced.id);
    
    // 如果用户已登录，尝试同步到云端
    const userId = this.currentUserId();
    if (userId) {
      const result = await this.syncService.saveProjectToCloud(balanced, userId);
      
      if (!result.success && !result.conflict) {
        // 同步失败，加入重试队列（不回滚，因为离线操作应该保留）
        if (!this.isOnline()) {
          this.actionQueue.enqueue({
            type: 'create',
            entityType: 'project',
            entityId: balanced.id,
            payload: { project: balanced }
          });
          this.toastService.info('离线创建', '项目将在网络恢复后同步到云端');
        } else {
          // 在线但同步失败，回滚本地状态
          this.projects.set(previousProjects);
          this.activeProjectId.set(previousActiveId);
          this.toastService.error('创建失败', '无法保存项目到云端，请稍后重试');
          return { success: false, error: '同步失败' };
        }
      } else if (result.conflict) {
        // 发生冲突（理论上新建不应该冲突，但以防万一）
        this.toastService.warning('数据冲突', '检测到数据冲突，请检查');
      }
    }
    
    this.schedulePersist();
    return { success: true };
  }

  /**
   * 删除项目（乐观更新 + 失败回滚）
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.currentUserId();
    const previousProjects = this.projects();
    const previousActiveId = this.activeProjectId();
    const deletedProject = previousProjects.find(p => p.id === projectId);
    
    // 乐观更新：先删除本地状态
    this.projects.update(p => p.filter(proj => proj.id !== projectId));
    
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.activeProjectId.set(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      const success = await this.syncService.deleteProjectFromCloud(projectId, userId);
      
      if (!success) {
        if (!this.isOnline()) {
          // 离线删除，加入重试队列
          this.actionQueue.enqueue({
            type: 'delete',
            entityType: 'project',
            entityId: projectId,
            payload: { projectId, userId }
          });
          this.toastService.info('离线删除', '项目将在网络恢复后同步删除');
        } else {
          // 在线但删除失败，回滚本地状态
          this.projects.set(previousProjects);
          this.activeProjectId.set(previousActiveId);
          this.toastService.error('删除失败', '无法从云端删除项目，请稍后重试');
          return { success: false, error: '同步失败' };
        }
      }
    }
    
    this.syncService.saveOfflineSnapshot(this.projects());
    return { success: true };
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projects.update(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.schedulePersist();
    }
  }

  /**
   * 重命名项目
   */
  renameProject(projectId: string, newName: string) {
    if (!newName.trim()) return;
    
    this.projects.update(projects => projects.map(p => 
      p.id === projectId ? { ...p, name: newName.trim() } : p
    ));
    this.schedulePersist();
  }

  /**
   * 更新项目的流程图视图状态（缩放、位置）
   */
  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }) {
    this.projects.update(projects => projects.map(p => {
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
    // 视图状态更新不需要立即同步，使用延迟
    this.schedulePersist();
  }

  /**
   * 获取当前项目的视图状态
   */
  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    const project = this.activeProject();
    if (!project?.viewState) return null;
    return project.viewState;
  }

  // ========== 任务操作 ==========

  updateTaskContent(taskId: string, newContent: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    // 使用防抖记录，避免每个字符都产生撤销记录
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent, updatedAt: now } : t)
    }));
  }
  
  markEditing() {
    this.isEditing = true;
    this.hasPendingLocalChanges = true;
    
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
    }
    
    this.editingTimer = setTimeout(() => {
      this.isEditing = false;
      this.editingTimer = null;
    }, SYNC_CONFIG.EDITING_TIMEOUT);
  }
  
  get isUserEditing(): boolean {
    return this.isEditing || this.hasPendingLocalChanges;
  }

  addTodoItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const trimmedText = itemText.trim();
    if (!trimmedText) return;
    
    const todoLine = `- [ ] ${trimmedText}`;
    let newContent = task.content || '';
    
    if (newContent && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    newContent += todoLine;
    
    this.markEditing();
    this.updateTaskContent(taskId, newContent);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const escapedText = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`- \\[ \\]\\s*${escapedText}`);
    const newContent = task.content.replace(regex, `- [x] ${itemText}`);
    
    if (newContent !== task.content) {
      this.updateTaskContent(taskId, newContent);
    }
  }

  updateTaskTitle(taskId: string, title: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    // 使用防抖记录，避免每个字符都产生撤销记录
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, title, updatedAt: now } : t)
    }));
  }

  updateTaskPosition(taskId: string, x: number, y: number) {
    this.lastUpdateType = 'position';
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
    }));
  }
  
  /**
   * 更新任务位置并同步 Rank
   * 当用户在流程图中拖动节点时，根据 Y 坐标重新计算任务的 rank
   * 以保持文本视图和流程图的排序一致性
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number) {
    const project = this.activeProject();
    if (!project) return;
    
    const task = project.tasks.find(t => t.id === taskId);
    if (!task || task.stage === null) {
      // 未分配阶段的任务不需要 rank 同步
      this.updateTaskPosition(taskId, x, y);
      return;
    }
    
    // 获取同一阶段的所有任务（排除自身）
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // 根据新的 Y 坐标计算新的 rank
    let newRank: number;
    const RANK_STEP = 500; // LAYOUT_CONFIG.RANK_STEP
    
    if (stageTasks.length === 0) {
      // 该阶段只有这一个任务
      newRank = task.rank;
    } else {
      // 找到应该插入的位置
      const insertIndex = stageTasks.findIndex(t => (t.y ?? 0) > y);
      
      if (insertIndex === -1) {
        // 在所有任务下方
        const lastTask = stageTasks[stageTasks.length - 1];
        newRank = lastTask.rank + RANK_STEP;
      } else if (insertIndex === 0) {
        // 在所有任务上方
        const firstTask = stageTasks[0];
        newRank = firstTask.rank - RANK_STEP;
      } else {
        // 在两个任务之间
        const prevTask = stageTasks[insertIndex - 1];
        const nextTask = stageTasks[insertIndex];
        newRank = (prevTask.rank + nextTask.rank) / 2;
        
        // 如果间隔太小，触发重平衡
        if (Math.abs(prevTask.rank - newRank) < 50) {
          this.lastUpdateType = 'structure';
          this.recordAndUpdate(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
          }));
          return;
        }
      }
    }
    
    // 只更新位置和 rank，不触发完整的 rebalance
    this.lastUpdateType = 'position';
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
    }));
  }
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.lastUpdateType;
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status, updatedAt: now } : t)
    }));
  }
  
  /**
   * 更新任务附件
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, attachments, updatedAt: now } : t)
    }));
  }

  /**
   * 添加单个附件（原子操作，避免竞态条件）
   */
  addTaskAttachment(taskId: string, attachment: Attachment) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          const currentAttachments = t.attachments || [];
          // 检查是否已存在（避免重复添加）
          if (currentAttachments.some(a => a.id === attachment.id)) {
            return t;
          }
          return { ...t, attachments: [...currentAttachments, attachment], updatedAt: now };
        }
        return t;
      })
    }));
  }

  /**
   * 移除单个附件（原子操作，避免竞态条件）
   */
  removeTaskAttachment(taskId: string, attachmentId: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          const currentAttachments = t.attachments || [];
          return { 
            ...t, 
            attachments: currentAttachments.filter(a => a.id !== attachmentId),
            updatedAt: now
          };
        }
        return t;
      })
    }));
  }

  /**
   * 更新任务优先级
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, priority, updatedAt: now } : t)
    }));
  }

  /**
   * 更新任务截止日期
   */
  updateTaskDueDate(taskId: string, dueDate: string | null) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, dueDate, updatedAt: now } : t)
    }));
  }

  /**
   * 更新任务标签
   */
  updateTaskTags(taskId: string, tags: string[]) {
    this.markEditing();
    this.lastUpdateType = 'content';
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, tags, updatedAt: now } : t)
    }));
  }

  /**
   * 添加单个标签
   */
  addTaskTag(taskId: string, tag: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const currentTags = task.tags || [];
    if (currentTags.includes(tag)) return; // 避免重复
    
    this.updateTaskTags(taskId, [...currentTags, tag]);
  }

  /**
   * 移除单个标签
   */
  removeTaskTag(taskId: string, tag: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const currentTags = task.tags || [];
    this.updateTaskTags(taskId, currentTags.filter(t => t !== tag));
  }

  /**
   * 软删除任务（移动到回收站）
   * 任务及其子任务都会被标记为已删除
   * 同时保存涉及这些任务的连接以便恢复时还原
   */
  deleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    // 使用迭代而非递归收集所有后代
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    const now = new Date().toISOString();
    
    // 找出所有涉及被删除任务的连接，保存到主任务上以便恢复
    const deletedConnections = activeP.connections.filter(
      c => idsToDelete.has(c.source) || idsToDelete.has(c.target)
    );
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          // 在主任务上保存被删除的连接
          return { ...t, deletedAt: now, stage: null, deletedConnections };
        } else if (idsToDelete.has(t.id)) {
          return { ...t, deletedAt: now, stage: null };
        }
        return t;
      }),
      // 暂时移除涉及被删除任务的连接
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  /**
   * 永久删除任务（从回收站中删除）
   * 同时清理所有指向这些任务或从这些任务发出的连接
   */
  permanentlyDeleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    // 使用迭代而非递归收集所有后代
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      // 清理所有涉及被删除任务的连接
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  /**
   * 从回收站恢复任务
   * 同时恢复所有子任务和之前保存的连接
   */
  restoreTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    // 获取主任务上保存的被删除连接
    const mainTask = activeP.tasks.find(t => t.id === taskId);
    const savedConnections = mainTask?.deletedConnections || [];
    
    // 收集所有需要恢复的任务（包括子任务）
    const idsToRestore = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToRestore.has(id)) continue;
      idsToRestore.add(id);
      // 查找所有子任务
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => {
      // 恢复任务并清除 deletedConnections 属性
      const restoredTasks = p.tasks.map(t => {
        if (idsToRestore.has(t.id)) {
          const { deletedConnections, ...rest } = t;
          return { ...rest, deletedAt: null };
        }
        return t;
      });
      
      // 合并恢复的连接（避免重复）
      const existingConnKeys = new Set(
        p.connections.map(c => `${c.source}->${c.target}`)
      );
      const connectionsToRestore = savedConnections.filter(
        c => !existingConnKeys.has(`${c.source}->${c.target}`)
      );
      
      return this.layoutService.rebalance({
        ...p,
        tasks: restoredTasks,
        connections: [...p.connections, ...connectionsToRestore]
      });
    });
  }

  /**
   * 清空回收站
   */
  emptyTrash() {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const deletedIds = new Set(activeP.tasks.filter(t => t.deletedAt).map(t => t.id));
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !t.deletedAt),
      connections: p.connections.filter(c => !deletedIds.has(c.source) && !deletedIds.has(c.target))
    }));
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): Result<string, OperationError> {
    const activeP = this.activeProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }
    
    // 检查目标阶段是否正在重平衡
    if (targetStage !== null && this.isStageRebalancing(targetStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null 
      ? this.gridPosition(targetStage, newOrder - 1) 
      : this.layoutService.getUnassignedPosition(activeP.tasks.filter(t => t.stage === null).length);
    const parent = parentId ? activeP.tasks.find(t => t.id === parentId) : null;
    const candidateRank = targetStage === null
      ? LAYOUT_CONFIG.RANK_ROOT_BASE + activeP.tasks.filter(t => t.stage === null).length * LAYOUT_CONFIG.RANK_STEP
      : this.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title,
      content,
      stage: targetStage,
      parentId: targetStage === null ? null : parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x, 
      y: pos.y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      shortId: this.generateShortId(activeP.tasks), // 生成永久短 ID
      hasIncompleteTask: this.detectIncomplete(content)
    };

    const placed = this.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) {
      return failure(
        ErrorCodes.LAYOUT_NO_SPACE, 
        '无法在该位置放置任务，区域可能已满或存在冲突',
        { stage: targetStage, parentId }
      );
    }
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.layoutService.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { id: crypto.randomUUID(), source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
    
    return success(newTaskId);
  }

  addCrossTreeConnection(sourceId: string, targetId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const exists = activeP.connections.some(
      c => c.source === sourceId && c.target === targetId
    );
    if (exists) return;
    
    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    if (!sourceTask || !targetTask) return;
    
    if (sourceId === targetId) return;
    
    this.recordAndUpdate(p => ({
      ...p,
      connections: [...p.connections, { 
        id: crypto.randomUUID(),
        source: sourceId, 
        target: targetId 
      }]
    }));
  }

  removeConnection(sourceId: string, targetId: string) {
    this.recordAndUpdate(p => ({
      ...p,
      connections: p.connections.filter(
        c => !(c.source === sourceId && c.target === targetId)
      )
    }));
  }

  updateConnectionDescription(sourceId: string, targetId: string, description: string) {
    this.markEditing();
    this.updateActiveProject(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId) 
          ? { ...c, description } 
          : c
      )
    }));
  }

  getTaskConnections(taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    const project = this.activeProject();
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: tasks.find(t => t.id === c.target),
        description: c.description
      }));
    
    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: tasks.find(t => t.id === c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    const activeP = this.activeProject();
    if (!activeP) return;
    const count = activeP.tasks.filter(t => t.stage === null).length;
    const rank = LAYOUT_CONFIG.RANK_ROOT_BASE + count * LAYOUT_CONFIG.RANK_STEP;
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: count + 1,
      rank,
      status: 'active',
      x,
      y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    this.recordAndUpdate(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }
  
  moveTaskToStage(
    taskId: string, 
    newStage: number | null, 
    beforeTaskId?: string | null, 
    newParentId?: string | null
  ): Result<void, OperationError> {
    // 检查目标阶段是否正在重平衡
    if (newStage !== null && this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }
      
      if (newParentId && this.detectCycle(taskId, newParentId, tasks)) {
        console.warn('检测到循环依赖，操作已阻止', { taskId, newParentId });
        operationResult = failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
        return p;
      }

      target.stage = newStage;
      target.parentId = newStage === null ? null : (newParentId !== undefined ? newParentId : target.parentId);

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
      const parentRank = this.maxParentRank(target, tasks);
      const minChildRank = this.minChildRank(target.id, tasks);
      if (newStage !== null) {
        const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) {
          operationResult = failure(
            ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT, 
            '无法移动：会破坏父子关系约束'
          );
          return p;
        }
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) {
          operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法移动到未分配区域');
          return p;
        }
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }

  /**
   * 将任务插入到两个已有节点之间（连接线上）
   * 
   * 操作逻辑：
   * 1. 新任务成为原父节点(sourceId)的子节点
   * 2. 原子节点(targetId)及其子树成为新任务的子节点
   * 3. 原子节点及其子树的 stage 全部 +1（级联更新）
   * 4. displayId 由 layoutService.rebalance 自动重新计算
   * 
   * @param taskId 要插入的任务ID（通常是待分配任务）
   * @param sourceId 原父节点ID
   * @param targetId 原子节点ID（将成为新任务的子节点）
   */
  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    const activeP = this.activeProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    const insertTask = activeP.tasks.find(t => t.id === taskId);

    if (!sourceTask || !targetTask || !insertTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '找不到相关任务');
    }

    // 确保 target 当前是 source 的直接子节点
    if (targetTask.parentId !== sourceId) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标任务不是源任务的直接子节点');
    }

    // 检查循环依赖
    if (this.wouldCreateCycle(taskId, sourceId, targetId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '操作会产生循环依赖');
    }

    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      
      const source = tasks.find(t => t.id === sourceId)!;
      const target = tasks.find(t => t.id === targetId)!;
      const newTask = tasks.find(t => t.id === taskId)!;
      
      // 1. 收集 target 及其所有后代的 ID
      const targetSubtreeIds = this.collectSubtreeIds(targetId, tasks);
      
      // 2. 设置新任务的父级和阶段
      const newTaskStage = (source.stage || 1) + 1;
      newTask.parentId = sourceId;
      newTask.stage = newTaskStage;
      
      // 3. 将 target 的父级改为新任务
      target.parentId = taskId;
      
      // 4. target 及其子树的 stage 全部 +1
      targetSubtreeIds.forEach(id => {
        const t = tasks.find(task => task.id === id);
        if (t && t.stage !== null) {
          t.stage = t.stage + 1;
        }
      });
      
      // 5. 计算新任务的 rank（应该在 source 的子任务中合适的位置）
      const sourceChildren = tasks
        .filter(t => t.parentId === sourceId && t.id !== taskId)
        .sort((a, b) => a.rank - b.rank);
      
      // 找到 target 原来在兄弟中的位置，新任务插入到同一位置
      const targetOriginalRank = target.rank;
      newTask.rank = targetOriginalRank;
      
      // target 的 rank 需要调整到新任务之后
      target.rank = newTask.rank + LAYOUT_CONFIG.RANK_STEP / 2;
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }

  /**
   * 收集指定任务及其所有后代的 ID
   */
  private collectSubtreeIds(taskId: string, tasks: Task[]): Set<string> {
    const result = new Set<string>();
    const stack = [taskId];
    
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      result.add(currentId);
      
      // 找到所有以 currentId 为父级的任务
      tasks.filter(t => t.parentId === currentId).forEach(child => {
        stack.push(child.id);
      });
    }
    
    return result;
  }

  /**
   * 检查插入操作是否会产生循环依赖
   */
  private wouldCreateCycle(taskId: string, sourceId: string, targetId: string, tasks: Task[]): boolean {
    // 检查 taskId 是否是 sourceId 的祖先
    let current = tasks.find(t => t.id === sourceId);
    while (current && current.parentId) {
      if (current.parentId === taskId) {
        return true;
      }
      current = tasks.find(t => t.id === current!.parentId);
    }
    
    // 检查 taskId 是否已经在 target 子树中（不太可能，但保险起见）
    const targetSubtree = this.collectSubtreeIds(targetId, tasks);
    if (targetSubtree.has(taskId)) {
      return true;
    }
    
    return false;
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank ?? this.layoutService.stageBase(stage);
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        const parentRank = this.maxParentRank(task, tasks);
        const minChildRank = this.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
      });
      return this.layoutService.rebalance({ ...p, tasks });
    });
  }

  detachTask(taskId: string) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = tasks.find(t => t.id === parentId);

      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent!.stage + 1;
          }
        }
      });

      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
      target.displayId = '?';

      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  deleteTaskKeepChildren(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const target = activeP.tasks.find(t => t.id === taskId);
    if (!target) return;
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const targetTask = tasks.find(t => t.id === taskId);
      if (!targetTask) return p;
      
      const parentId = targetTask.parentId;
      const parentTask = parentId ? tasks.find(t => t.id === parentId) : null;
      
      tasks.forEach(child => {
        if (child.parentId === taskId) {
          child.parentId = parentId;
          if (parentTask?.stage !== null && parentTask?.stage !== undefined) {
            child.stage = parentTask.stage + 1;
          } else if (parentId === null) {
            child.stage = 1;
          }
        }
      });
      
      const filteredTasks = tasks.filter(t => t.id !== taskId);
      
      const filteredConnections = p.connections.filter(
        c => c.source !== taskId && c.target !== taskId
      );
      
      return this.layoutService.rebalance({ ...p, tasks: filteredTasks, connections: filteredConnections });
    });
  }

  // ========== 视图控制 ==========

  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }

  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }

  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
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

  // ========== 私有辅助方法 ==========

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
    
    this.projects.set(projects);
    this.activeProjectId.set(projects[0]?.id ?? null);
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
    this.projects.update(projects => projects.map(p => {
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
    
    // 标记为结构性更新
    this.lastUpdateType = 'structure';
    
    // 记录操作前的快照
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    // 执行更新
    let afterProject: Project | null = null;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    // 记录操作后的快照，包含版本号
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

  /**
   * 带防抖的记录和更新
   * 用于高频输入场景（标题、内容编辑），避免每个字符都产生撤销记录
   */
  private recordAndUpdateDebounced(mutator: (project: Project) => Project) {
    const project = this.activeProject();
    if (!project) return;
    
    // 标记为内容更新
    this.lastUpdateType = 'content';
    
    // 记录操作前的快照（仅在没有待处理的防抖操作时）
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    // 执行更新
    let afterProject: Project | null = null;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    // 使用防抖记录，包含版本号
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
    this.projects.update(projects => projects.map(p => {
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

  /**
   * 持久化活动项目到本地和云端
   * 使用锁机制防止并发写入导致数据损坏
   */
  private async persistActiveProject() {
    // 如果正在持久化，标记有待处理的请求
    if (this.isPersisting) {
      this.persistPending = true;
      return;
    }
    
    this.isPersisting = true;
    
    try {
      await this.doPersistActiveProject();
    } finally {
      this.isPersisting = false;
      
      // 如果锁定期间有新的持久化请求，重新调度
      if (this.persistPending) {
        this.persistPending = false;
        // 短延迟后再次执行，避免过于频繁
        this.schedulePersist();
      }
    }
  }
  
  /**
   * 实际执行持久化（内部方法）
   */
  private async doPersistActiveProject() {
    const project = this.activeProject();
    const projects = this.projects();
    
    // 保存离线快照（无论是否登录都保存）
    this.syncService.saveOfflineSnapshot(projects);
    
    if (!project) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const userId = this.currentUserId();
    if (!userId) {
      // 未登录时，额外保存到访客数据存储
      // 确保登录时迁移服务能正确获取数据
      this.migrationService.saveGuestData(projects);
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
      return;
    }

    const now = new Date().toISOString();
    const result = await this.syncService.saveProjectToCloud(
      { ...project, updatedAt: now },
      userId
    );
    
    if (result.success) {
      this.projects.update(ps => ps.map(p => 
        p.id === project.id ? { ...p, updatedAt: now } : p
      ));
    }
    
    this.hasPendingLocalChanges = false;
    this.lastPersistAt = Date.now();
  }

  private gridPosition(stage: number, index: number) {
    return this.layoutService.gridPosition(stage, index);
  }

  private detectIncomplete(content: string) {
    return this.layoutService.detectIncomplete(content);
  }

  /**
   * 生成永久短 ID - 委托给 LayoutService
   */
  private generateShortId(existingTasks: Task[]): string {
    return this.layoutService.generateShortId(existingTasks);
  }

  /**
   * 计算插入位置的 rank 值
   * 当检测到 rank 间隔过小时，返回需要重平衡的标记
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    if (result.needsRebalance) {
      this.markStageForRebalance(stage);
    }
    return result.rank;
  }

  /**
   * 标记某阶段需要重平衡
   */
  private stagesNeedingRebalance = new Set<number>();
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
  
  private markStageForRebalance(stage: number) {
    this.stagesNeedingRebalance.add(stage);
    // 防抖执行重平衡
    if (this.rebalanceTimer) {
      clearTimeout(this.rebalanceTimer);
    }
    this.rebalanceTimer = setTimeout(() => {
      this.performStageRebalance();
      this.rebalanceTimer = null;
    }, 100);
  }
  
  /**
   * 执行阶段内的 rank 重平衡
   * 将阶段内的任务 rank 重新均匀分布
   * 在重平衡期间锁定相关阶段的拖拽操作
   */
  private performStageRebalance() {
    const activeP = this.activeProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = [...this.stagesNeedingRebalance];
    this.stagesNeedingRebalance.clear();
    
    // 锁定这些阶段
    stages.forEach(s => this.rebalancingStages.add(s));
    
    console.log('执行 rank 重平衡，阶段:', stages);
    
    try {
      // 使用 LayoutService 进行重平衡
      const rebalancedTasks = this.layoutService.rebalanceStageRanks(activeP.tasks, stages);
      
      if (rebalancedTasks !== activeP.tasks) {
        // 应用变更但不记录撤销历史（这是维护性更新）
        const updated = this.layoutService.rebalance({ ...activeP, tasks: rebalancedTasks });
        this.projects.update(ps => ps.map(p => p.id === updated.id ? updated : p));
      }
    } finally {
      // 解锁阶段
      stages.forEach(s => this.rebalancingStages.delete(s));
    }
  }

  private maxParentRank(task: Task | null, tasks: Task[]) {
    return this.layoutService.maxParentRank(task, tasks);
  }

  private minChildRank(taskId: string, tasks: Task[]) {
    return this.layoutService.minChildRank(taskId, tasks);
  }

  private applyRefusalStrategy(target: Task, candidateRank: number, parentRank: number | null, minChildRank: number) {
    return this.layoutService.applyRefusalStrategy(target, candidateRank, parentRank, minChildRank);
  }

  private detectCycle(taskId: string, newParentId: string | null, tasks: Task[]): boolean {
    return this.layoutService.detectCycle(taskId, newParentId, tasks);
  }
  
  // ========== 搜索辅助方法 ==========
  
  /**
   * 规范化搜索查询
   * 移除标点符号，转换为小写，用于模糊匹配
   */
  private normalizeSearchQuery(query: string): string {
    return query
      .toLowerCase()
      .trim()
      // 移除常见标点符号
      .replace(/[.,!?;:'"()[\]{}<>@#$%^&*+=~`|\\/-]/g, '')
      // 合并多个空格
      .replace(/\s+/g, ' ');
  }
  
  /**
   * 模糊匹配
   * 支持字符序列匹配 (例如 "abc" 匹配 "axbycz")
   */
  private fuzzyMatch(text: string, query: string): boolean {
    if (!text || !query) return false;
    
    const normalizedText = text.toLowerCase();
    
    // 1. 包含匹配 (最快)
    if (normalizedText.includes(query)) {
      return true;
    }
    
    // 2. 字符序列匹配 (Fuzzy Sequence Matching)
    let queryIndex = 0;
    let textIndex = 0;
    
    while (queryIndex < query.length && textIndex < normalizedText.length) {
      if (query[queryIndex] === normalizedText[textIndex]) {
        queryIndex++;
      }
      textIndex++;
    }
    
    return queryIndex === query.length;
  }
  
  /**
   * 设置搜索查询（带防抖）
   * 用于高频输入场景
   */
  setSearchQueryDebounced(query: string, delay: number = 300): void {
    // 立即更新原始查询（用于 UI 显示）
    this.searchQuery.set(query);
    
    // 防抖更新实际搜索
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    
    this.searchDebounceTimer = setTimeout(() => {
      this.debouncedSearchQuery.set(query);
      this.searchDebounceTimer = null;
    }, delay);
  }
  
  /**
   * 清除搜索查询
   */
  clearSearch(): void {
    this.searchQuery.set('');
    this.projectSearchQuery.set('');
    this.debouncedSearchQuery.set('');
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }
}
