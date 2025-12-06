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
  private readonly logger = inject(LoggerService).category('RemoteChangeHandler');
  private syncCoordinator = inject(SyncCoordinatorService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private destroyRef = inject(DestroyRef);

  /** 用于防止在编辑期间处理远程变更的时间阈值 */
  private static readonly EDIT_GUARD_THRESHOLD_MS = 800;
  
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
        if (this.shouldSkipRemoteUpdate()) {
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
        if (this.shouldSkipRemoteUpdate()) {
          return;
        }
        this.handleTaskLevelUpdate(payload as RemoteTaskChangePayload);
      }
    );
  }

  // ========== 私有方法 ==========

  /**
   * 检查是否应跳过远程更新
   * 当用户正在编辑或有待同步的本地变更时，跳过远程更新
   */
  private shouldSkipRemoteUpdate(): boolean {
    return (
      this.uiState.isEditing ||
      this.syncCoordinator.hasPendingLocalChanges() ||
      Date.now() - this.syncCoordinator.getLastPersistAt() < RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS
    );
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
   */
  private handleTaskLevelUpdate(payload: RemoteTaskChangePayload): void {
    const { eventType, taskId, projectId } = payload;

    if (projectId !== this.projectState.activeProjectId()) {
      return;
    }

    switch (eventType) {
      case 'DELETE':
        // 清理被删除任务相关的撤销历史，防止撤销操作引用已删除任务
        this.undoService.clearTaskHistory(taskId, projectId);
        
        this.projectState.updateProjects(projects =>
          projects.map(p => {
            if (p.id !== projectId) return p;
            const updatedProject = {
              ...p,
              tasks: p.tasks.filter(t => t.id !== taskId)
            };
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
        
        this.syncCoordinator.loadSingleProject(projectId, userId)
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
            
            if (!remoteProject) return;

            const remoteTask = remoteProject.tasks.find(t => t.id === taskId);
            if (!remoteTask) return;

            this.projectState.updateProjects(projects =>
              projects.map(p => {
                if (p.id !== projectId) return p;

                const existingTaskIndex = p.tasks.findIndex(t => t.id === taskId);
                let updatedProject: Project;
                if (existingTaskIndex >= 0) {
                  const updatedTasks = [...p.tasks];
                  updatedTasks[existingTaskIndex] = remoteTask;
                  updatedProject = { ...p, tasks: updatedTasks };
                } else {
                  updatedProject = { ...p, tasks: [...p.tasks, remoteTask] };
                }
                
                // 重新计算 displayId 等派生属性
                // 单任务更新时也需要 rebalance，因为 displayId 依赖树结构
                return this.syncCoordinator.validateAndRebalance(updatedProject);
              })
            );
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
