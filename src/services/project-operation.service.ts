/**
 * ProjectOperationService - 项目操作服务
 * 
 * 【职责边界】
 * ✓ 项目 CRUD 操作（创建、删除、重命名、更新元数据）
 * ✓ 项目操作的乐观更新 + 离线队列
 * ✓ 数据冲突解决
 * ✗ 项目数据读取 → ProjectStateService
 * ✗ 任务操作 → TaskOperationAdapterService
 * ✗ 同步调度 → SyncCoordinatorService
 * 
 * 从 StoreService 中拆分，减少门面膨胀
 */
import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LayoutService } from './layout.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import { isFailure } from '../utils/result';

@Injectable({
  providedIn: 'root'
})
export class ProjectOperationService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  
  private readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly userSession = inject(UserSessionService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly layoutService = inject(LayoutService);
  private readonly undoService = inject(UndoService);
  private readonly toastService = inject(ToastService);

  // ========== 项目 CRUD 操作 ==========

  /**
   * 创建新项目
   * 
   * 实现乐观更新：
   * 1. 立即更新本地状态
   * 2. 后台同步到云端
   * 3. 失败时回滚或加入离线队列
   */
  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-create', '创建项目');
    
    // 乐观更新：立即显示新项目
    this.projectState.updateProjects(p => [...p, balanced]);
    this.projectState.setActiveProjectId(balanced.id);
    
    const userId = this.userSession.currentUserId();
    if (userId) {
      try {
        const result = await this.syncCoordinator.saveProjectToCloud(balanced, userId);
        
        if (!result.success && !result.conflict) {
          if (!this.syncCoordinator.isOnline()) {
            // 离线模式：加入队列，保留乐观更新
            this.actionQueue.enqueue({
              type: 'create',
              entityType: 'project',
              entityId: balanced.id,
              payload: { project: balanced }
            });
            this.toastService.info('离线创建', '项目将在网络恢复后同步到云端');
            this.optimisticState.commitSnapshot(snapshot.id);
          } else {
            // 在线但同步失败：回滚
            this.optimisticState.rollbackSnapshot(snapshot.id, false);
            this.toastService.error('创建失败', '无法保存项目到云端，请稍后重试');
            return { success: false, error: '同步失败' };
          }
        } else if (result.conflict) {
          this.toastService.warning('数据冲突', '检测到数据冲突，请检查');
          this.optimisticState.commitSnapshot(snapshot.id);
        } else {
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('创建失败', '发生未知错误，请稍后重试');
        return { success: false, error: '未知错误' };
      }
    } else {
      // 未登录：提交快照（本地保存）
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.schedulePersist();
    return { success: true };
  }

  /**
   * 删除项目
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.userSession.currentUserId();
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    
    // 乐观更新：立即从列表中移除
    this.projectState.updateProjects(p => p.filter(proj => proj.id !== projectId));
    
    if (this.projectState.activeProjectId() === projectId) {
      const remaining = this.projectState.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      try {
        const success = await this.syncCoordinator.deleteProjectFromCloud(projectId, userId);
        
        if (!success) {
          if (!this.syncCoordinator.isOnline()) {
            // 离线模式：加入队列，保留乐观更新
            this.actionQueue.enqueue({
              type: 'delete',
              entityType: 'project',
              entityId: projectId,
              payload: { projectId, userId }
            });
            this.toastService.info('离线删除', '项目将在网络恢复后同步删除');
            this.optimisticState.commitSnapshot(snapshot.id);
          } else {
            // 在线但同步失败：回滚
            this.optimisticState.rollbackSnapshot(snapshot.id, false);
            this.toastService.error('删除失败', '无法从云端删除项目，请稍后重试');
            return { success: false, error: '同步失败' };
          }
        } else {
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('删除失败', '发生未知错误，请稍后重试');
        return { success: false, error: '未知错误' };
      }
    } else {
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.saveOfflineSnapshot(this.projectState.projects());
    return { success: true };
  }

  /**
   * 更新项目元数据（描述、创建日期）
   */
  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }): void {
    this.projectState.updateProjects(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    
    if (this.projectState.activeProjectId() === projectId) {
      this.syncCoordinator.schedulePersist();
    }
  }

  /**
   * 重命名项目
   */
  renameProject(projectId: string, newName: string): boolean {
    const success = this.projectState.renameProject(projectId, newName);
    if (success) {
      this.syncCoordinator.schedulePersist();
    }
    return success;
  }

  /**
   * 更新项目的流程图缩略图 URL
   */
  updateProjectFlowchartUrl(projectId: string, flowchartUrl: string, thumbnailUrl?: string): void {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          flowchartUrl,
          flowchartThumbnailUrl: thumbnailUrl
        };
      }
      return p;
    }));
    this.syncCoordinator.schedulePersist();
  }

  // ========== 冲突解决 ==========

  /**
   * 解决数据冲突
   * 
   * @param projectId 项目 ID
   * @param choice 解决方式：local（保留本地）、remote（使用远程）、merge（合并）
   */
  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge'): Promise<void> {
    const conflictData = this.syncCoordinator.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    const localProject = this.projectState.projects().find(p => p.id === projectId);
    if (!localProject) return;
    
    const remoteProject = conflictData.remoteData as Project | undefined;
    
    const result = await this.syncCoordinator.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
    
    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return;
    }
    
    const resolvedProject = this.syncCoordinator.validateAndRebalance(result.value);
    
    this.projectState.updateProjects(ps => ps.map(p => 
      p.id === projectId ? resolvedProject : p
    ));
    
    if (this.projectState.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }
    
    if (choice !== 'remote') {
      const userId = this.userSession.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.syncCoordinator.saveProjectToCloud(resolvedProject, userId);
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
    
    this.syncCoordinator.saveOfflineSnapshot(this.projectState.projects());
  }
}
