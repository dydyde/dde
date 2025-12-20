/**
 * RemoteChangeHandlerService - 远程变更处理服务
 * 
 * 【职责边界】
 * ✓ 处理实时订阅推送的远程项目变更
 * ✓ 处理实时订阅推送的远程任务变更
 * ✓ 增量更新与智能合并
 * ✓ 版本冲突检测
 * ✗ 实时订阅建立/断开 → SyncCoordinatorService
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ 用户会话管理 → UserSessionService
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { Project } from '../models';

/**
 * 远程项目变更载荷
 */
export interface RemoteProjectChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  projectId: string;
}

/**
 * 远程任务变更载荷
 * 
 * 注：移除了未使用的 data 字段。
 * 增量更新的复杂度（JSON Patch、数组乱序等）远超其带来的带宽节省。
 * Simple is better than complex.
 */
export interface RemoteTaskChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string;
}

@Injectable({
  providedIn: 'root'
})
export class RemoteChangeHandlerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RemoteChangeHandler');
  private syncCoordinator = inject(SyncCoordinatorService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private changeTracker = inject(ChangeTrackerService);
  private destroyRef = inject(DestroyRef);

  /** 
   * 用于防止在编辑期间处理远程变更的时间阈值（毫秒）
   * 【修复】从 300ms 增加到 2000ms，给弱网环境更多保护时间
   */
  private static readonly EDIT_GUARD_THRESHOLD_MS = 2000;
  
  /** 回调是否已设置（防止重复调用） */
  private callbacksInitialized = false;
  
  /** 服务是否已销毁（用于取消进行中的异步操作） */
  private isDestroyed = false;
  
  /** 
   * 当前任务更新请求 ID
   * 使用单调递增的 ID 替代 AbortController，确保只处理最新请求结果
   * 注：Supabase JS 客户端不原生支持 AbortSignal，此设计更可靠
   */
  private taskUpdateRequestId = 0;
  
  constructor() {
    // 注册 HMR/测试清理
    this.destroyRef.onDestroy(() => {
      this.isDestroyed = true;
      this.callbacksInitialized = false;
      // 递增请求 ID，使所有进行中的请求结果被忽略
      this.taskUpdateRequestId++;
    });
  }

  /**
   * 设置远程变更回调
   * 应在应用启动时调用一次
   * @throws 如果重复调用会记录警告
   */
  setupCallbacks(onLoadProjects: () => Promise<void>): void {
    if (this.callbacksInitialized) {
      this.logger.warn('setupCallbacks 已被调用过，跳过重复初始化');
      return;
    }
    
    this.callbacksInitialized = true;
    this.logger.info('远程变更回调已初始化');
    
    this.syncCoordinator.setupRemoteChangeCallbacks(
      async (payload) => {
        // 项目级更新：如果用户正在编辑，跳过以防止冲突
        if (this.shouldSkipRemoteUpdate()) {
          this.logger.debug('跳过项目级远程更新');
          return;
        }

        try {
          if (payload?.eventType && payload?.projectId) {
            await this.handleIncrementalUpdate(payload as RemoteProjectChangePayload);
          } else {
            await onLoadProjects();
          }
        } catch (e) {
          this.logger.error('处理远程变更失败', e);
        }
      },
      (payload) => {
        const taskPayload = payload as RemoteTaskChangePayload;

        // 任务级更新：默认更宽松（允许不同任务并发编辑），但仍需避免在本机有未同步修改时被远程覆盖。
        // - 用户正在编辑/有待同步本地变更：跳过 UPDATE/INSERT，避免覆盖本地状态
        // - 刚刚持久化：短暂跳过，避免“自己的回声”覆盖
        if (this.shouldSkipTaskUpdate(taskPayload)) {
          this.logger.debug('跳过任务级远程更新', { eventType: taskPayload.eventType, taskId: taskPayload.taskId });
          return;
        }
        this.handleTaskLevelUpdate(taskPayload);
      }
    );
  }

  // ========== 私有方法 ==========

  /**
   * 检查是否应跳过远程项目级更新
   * 当用户正在编辑或有待同步的本地变更时，跳过项目级更新
   */
  private shouldSkipRemoteUpdate(): boolean {
    const isEditing = this.uiState.isEditing;
    const hasPending = this.syncCoordinator.hasPendingLocalChanges();
    const timeSinceLastPersist = Date.now() - this.syncCoordinator.getLastPersistAt();
    const inEditGuard = timeSinceLastPersist < RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS;
    
    const shouldSkip = isEditing || hasPending || inEditGuard;
    
    // 添加调试日志
    if (shouldSkip) {
      this.logger.debug('跳过远程项目更新', {
        isEditing,
        hasPendingLocalChanges: hasPending,
        timeSinceLastPersist,
        inEditGuard,
        threshold: RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS
      });
    }
    
    return shouldSkip;
  }
  
  /**
   * 检查是否应跳过远程任务级更新
   * 更宽松的策略：只在刚刚有持久化操作时跳过，允许不同任务的并发更新
   * 【修复】增加回声保护时间从 200ms 到 1000ms，防止移动端弱网环境下的回声问题
   */
  private shouldSkipTaskUpdate(payload: RemoteTaskChangePayload): boolean {
    const timeSinceLastPersist = Date.now() - this.syncCoordinator.getLastPersistAt();
    const inEchoGuard = timeSinceLastPersist < 1000;

    // DELETE 事件不需要加载远程项目，且对一致性很关键；仅应用回声保护。
    if (payload.eventType === 'DELETE') {
      return inEchoGuard;
    }

    // UPDATE/INSERT 需要尽量及时处理（尤其是软删除 tombstone 通过 UPDATE 传播）。
    // 这里不再因“编辑中/有待同步变更”而整体跳过；改由后续合并逻辑按字段保护本地脏数据。
    return inEchoGuard;
  }

  /**
   * 处理项目级别的增量更新
   */
  private async handleIncrementalUpdate(payload: RemoteProjectChangePayload): Promise<void> {
    const { eventType, projectId } = payload;

    if (eventType === 'DELETE') {
      this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);

      this.projectState.updateProjects(ps => ps.filter(p => p.id !== projectId));
      if (this.projectState.activeProjectId() === projectId) {
        const remaining = this.projectState.projects();
        this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
      }
      return;
    }

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const userId = this.authService.currentUserId();
      if (!userId) return;

      const remoteProject = await this.syncCoordinator.loadSingleProject(projectId, userId);
      if (!remoteProject) return;

      const localProject = this.projectState.projects().find(p => p.id === projectId);

      if (!localProject) {
        const validated = this.syncCoordinator.validateAndRebalance(remoteProject);
        this.projectState.updateProjects(ps => [...ps, validated]);
      } else {
        const localVersion = localProject.version ?? 0;
        const remoteVersion = remoteProject.version ?? 0;

        if (remoteVersion > localVersion) {
          const versionDiff = remoteVersion - localVersion;

          const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
          if (clearedCount > 0) {
            this.logger.debug(`清理了 ${clearedCount} 条过时的撤销历史`, { projectId });
          }

          if (this.uiState.isEditing && versionDiff > 1) {
            this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
          }

          const mergeResult = this.syncCoordinator.smartMerge(localProject, remoteProject);

          if (mergeResult.conflictCount > 0 && this.uiState.isEditing) {
            this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
          }

          const validated = this.syncCoordinator.validateAndRebalance(mergeResult.project);
          this.projectState.updateProjects(ps => ps.map(p => p.id === projectId ? validated : p));
        }
      }
    }
  }

  /**
   * 处理任务级别的实时更新
   * 
   * 🔧 关键修复点：
   * 1. 任务删除需要正确处理 projectId 缺失的情况
   * 2. 任务更新需要智能合并本地编辑和远程变更
   * 3. 需要正确处理位置、状态、stage 等所有字段的同步
   */
  private handleTaskLevelUpdate(payload: RemoteTaskChangePayload): void {
    const { eventType, taskId, projectId } = payload;
    
    // 添加调试日志
    this.logger.info('[TaskSync] 收到任务变更事件', { eventType, taskId, projectId });

    // 🔧 修复：如果缺少 projectId（REPLICA IDENTITY 未配置），尝试从所有项目中查找
    let targetProjectId = projectId;
    
    if (!targetProjectId && eventType === 'DELETE') {
      this.logger.warn('DELETE 事件缺少 projectId，在所有项目中查找任务', { taskId });
      
      // 在所有项目中查找该任务
      for (const project of this.projectState.projects()) {
        if (project.tasks.some(t => t.id === taskId)) {
          targetProjectId = project.id;
          this.logger.info('在项目中找到待删除任务', { taskId, projectId: targetProjectId });
          break;
        }
      }
      
      if (!targetProjectId) {
        this.logger.error('无法找到待删除任务所属项目', { taskId });
        return;
      }
    }
    
    if (!targetProjectId) {
      this.logger.warn('跳过任务更新（无 projectId）', { eventType, taskId });
      return;
    }

    // 只处理当前活动项目的任务（对于非活动项目，等待切换项目时重新加载）
    if (targetProjectId !== this.projectState.activeProjectId()) {
      this.logger.debug('跳过非当前项目的任务更新', { eventType, taskId, projectId: targetProjectId, activeProjectId: this.projectState.activeProjectId() });
      return;
    }

    switch (eventType) {
      case 'DELETE':
        this.logger.info('处理远程任务删除', { taskId, projectId: targetProjectId });
        
        // 清理被删除任务相关的撤销历史，防止撤销操作引用已删除任务
        this.undoService.clearTaskHistory(taskId, targetProjectId);
        
        this.projectState.updateProjects(projects =>
          projects.map(p => {
            if (p.id !== targetProjectId) return p;
            
            const taskExists = p.tasks.some(t => t.id === taskId);
            if (!taskExists) {
              this.logger.debug('任务已不存在，跳过删除', { taskId });
              return p;
            }
            
            const updatedProject = {
              ...p,
              tasks: p.tasks.filter(t => t.id !== taskId)
            };
            
            this.logger.debug('任务已从本地删除', { taskId, remainingTasks: updatedProject.tasks.length });
            
            // 删除任务后需要重新计算 displayId，因为其他任务的编号可能会变化
            return this.syncCoordinator.validateAndRebalance(updatedProject);
          })
        );
        break;

      case 'INSERT':
      case 'UPDATE':
        const userId = this.authService.currentUserId();
        if (!userId) return;

        // 捕获当前状态，用于异步完成后检查
        const currentProjectId = this.projectState.activeProjectId();
        
        // 使用递增的请求 ID 机制确保只处理最新请求
        // 每次新请求都会使之前的请求结果被忽略
        const requestId = ++this.taskUpdateRequestId;
        
        this.logger.info('开始加载远程任务更新', { eventType, taskId, projectId: targetProjectId, requestId });
        
        this.syncCoordinator.loadSingleProject(targetProjectId, userId)
          .then(remoteProject => {
            // 检查是否已有更新的请求（当前请求已过时）
            if (requestId !== this.taskUpdateRequestId) {
              this.logger.debug('远程任务更新已被更新请求取代', { requestId, currentId: this.taskUpdateRequestId });
              return;
            }
            // 检查服务是否已销毁或项目已切换
            if (this.isDestroyed) {
              this.logger.debug('服务已销毁，忽略远程任务更新');
              return;
            }
            if (this.projectState.activeProjectId() !== currentProjectId) {
              this.logger.debug('项目已切换，忽略远程任务更新');
              return;
            }
            
            if (!remoteProject) {
              this.logger.warn('无法加载远程项目', { projectId: targetProjectId });
              return;
            }

            const remoteTask = remoteProject.tasks.find(t => t.id === taskId);
            if (!remoteTask) {
              this.logger.warn('远程项目中未找到任务', { taskId, totalTasks: remoteProject.tasks.length });
              return;
            }
            
            // 调试：记录远程任务的关键字段
            this.logger.info('[TaskSync] 成功加载远程任务完整数据', {
              taskId,
              title: remoteTask.title,
              status: remoteTask.status,
              stage: remoteTask.stage,
              parentId: remoteTask.parentId,
              rank: remoteTask.rank,
              x: remoteTask.x,
              y: remoteTask.y,
              updatedAt: remoteTask.updatedAt,
              deletedAt: remoteTask.deletedAt
            });

            this.projectState.updateProjects(projects =>
              projects.map(p => {
                if (p.id !== targetProjectId) return p;

                const existingTaskIndex = p.tasks.findIndex(t => t.id === taskId);
                const pending = this.changeTracker
                  .exportPendingChanges()
                  .find(r => r.entityType === 'task' && r.projectId === targetProjectId && r.entityId === taskId);

                let updatedProject: Project;
                if (existingTaskIndex >= 0) {
                  // 调试：对比本地和远程数据
                  const localTask = p.tasks[existingTaskIndex];
                  this.logger.debug('任务更新对比', {
                    taskId,
                    local: { 
                      status: localTask.status, 
                      stage: localTask.stage, 
                      x: localTask.x, 
                      y: localTask.y,
                      updatedAt: localTask.updatedAt 
                    },
                    remote: { 
                      status: remoteTask.status, 
                      stage: remoteTask.stage, 
                      x: remoteTask.x, 
                      y: remoteTask.y,
                      updatedAt: remoteTask.updatedAt 
                    }
                  });
                  
                  // 更精细的合并：
                  // - 默认采用远程任务（避免丢失另一端的结构/状态更新）
                  // - 若本机对该任务存在待同步脏字段，则对这些字段采用本地值（避免“回滚”）
                  // - 软删除 tombstone（deletedAt 非空）优先，避免任务复活
                  // - 【新增】如果本地 updatedAt >= 远程 updatedAt，保护关键本地字段
                  let mergedTask = remoteTask;

                  if (pending?.changeType === 'delete') {
                    // 本机认为该任务已删除：保持本机状态，避免被远程"复活"。
                    mergedTask = localTask;
                  } else {
                    const dirtyFields = new Set(pending?.changedFields ?? []);
                    
                    // 【关键改进】检查字段级操作锁
                    // 如果用户正在操作某个字段（如刚点击了状态复选框），保护该字段不被远程覆盖
                    const lockedFields = this.changeTracker.getLockedFields(taskId, targetProjectId);
                    for (const field of lockedFields) {
                      dirtyFields.add(field);
                      this.logger.debug('字段被操作锁保护', { taskId, field });
                    }
                    
                    // 【关键修复】LWW 时间戳保护
                    // 如果本地任务的 updatedAt >= 远程任务的 updatedAt，说明本地更新更晚（或同时），
                    // 应该保护本地的关键字段（status, stage, parentId, rank）避免被旧数据覆盖
                    const localTime = localTask.updatedAt ? new Date(localTask.updatedAt).getTime() : 0;
                    const remoteTime = remoteTask.updatedAt ? new Date(remoteTask.updatedAt).getTime() : 0;
                    
                    if (localTime >= remoteTime) {
                      // 本地更新不早于远程，保护关键字段
                      const lwwProtectedFields = ['status', 'stage', 'parentId', 'rank', 'order', 'title', 'content'];
                      for (const field of lwwProtectedFields) {
                        dirtyFields.add(field);
                      }
                      this.logger.info('LWW 保护本地字段（本地时间 >= 远程时间）', { 
                        taskId, 
                        localTime: localTask.updatedAt, 
                        remoteTime: remoteTask.updatedAt 
                      });
                    }

                    // 若用户正处于编辑态（全局），依旧保护内容字段。
                    if (this.uiState.isEditing) {
                      dirtyFields.add('title');
                      dirtyFields.add('content');
                    }

                    if (dirtyFields.size > 0) {
                      const merged: any = { ...remoteTask };
                      for (const field of dirtyFields) {
                        if (field in localTask) {
                          merged[field] = (localTask as any)[field];
                          this.logger.debug('保护本地字段值', { taskId, field, localValue: (localTask as any)[field] });
                        }
                      }
                      // tombstone wins
                      if (remoteTask.deletedAt) {
                        merged.deletedAt = remoteTask.deletedAt;
                      }
                      mergedTask = merged as any;
                    }
                  }
                  
                  const updatedTasks = [...p.tasks];
                  updatedTasks[existingTaskIndex] = mergedTask;
                  updatedProject = { ...p, tasks: updatedTasks };
                } else {
                  // 本地不存在该任务：
                  // - 若本机对该任务存在 pending delete，说明用户刚删掉（或离线删除待同步），不要被远端实时更新“复活”。
                  if (pending?.changeType === 'delete') {
                    this.logger.debug('忽略远端任务更新（本机 pending delete）', { taskId });
                    return p;
                  }

                  // 新任务，直接添加
                  this.logger.info('添加新任务', { taskId });
                  updatedProject = { ...p, tasks: [...p.tasks, remoteTask] };
                }
                
                // 重新计算 displayId 等派生属性
                // 单任务更新时也需要 rebalance，因为 displayId 依赖树结构
                return this.syncCoordinator.validateAndRebalance(updatedProject);
              })
            );
            
            this.logger.info('远程任务更新已应用', { taskId, eventType });
          })
          .catch(error => {
            // 如果请求已过时或服务已销毁，静默忽略错误
            if (requestId !== this.taskUpdateRequestId || this.isDestroyed) return;
            
            this.logger.error('处理远程任务更新失败', error);
            // 通知用户远程任务同步失败，提供刷新 action
            this.toastService.warning('同步提示', '远程任务更新失败，点击刷新页面', {
              duration: 8000,
              action: {
                label: '刷新页面',
                onClick: () => window.location.reload()
              }
            });
          });
        break;

      default:
        // 未知事件类型，记录警告但不中断处理
        this.logger.warn(`未处理的任务事件类型: ${eventType}`, { taskId, projectId });
        break;
    }
  }
  
  // ========== 测试/HMR 支持 ==========
  
  /**
   * 重置服务状态（用于测试和 HMR）
   */
  reset(): void {
    // 重置请求 ID，使所有进行中的请求结果被忽略
    this.taskUpdateRequestId++;
    
    this.callbacksInitialized = false;
    this.isDestroyed = false;
  }
}
