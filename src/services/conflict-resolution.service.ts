import { Injectable, inject, signal, computed } from '@angular/core';
import { SyncService } from './sync.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 冲突解决策略
 */
export type ConflictResolutionStrategy = 'local' | 'remote' | 'merge';

/**
 * 冲突数据
 */
export interface ConflictData {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
}

/**
 * 合并结果
 */
export interface MergeResult {
  project: Project;
  issues: string[];
  conflictCount: number;
}

/**
 * 冲突解决服务
 * 从 StoreService 拆分出来，专注于数据冲突解决
 * 职责：
 * - 冲突检测
 * - 智能合并算法
 * - 冲突解决策略执行
 * - 离线数据重连合并
 */
@Injectable({
  providedIn: 'root'
})
export class ConflictResolutionService {
  private syncService = inject(SyncService);
  private layoutService = inject(LayoutService);
  private toast = inject(ToastService);
  private logger = inject(LoggerService).category('ConflictResolution');

  // ========== 冲突状态 ==========
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncService.syncState().conflictData);

  // ========== 公共方法 ==========

  /**
   * 解决冲突
   * @param projectId 项目 ID
   * @param strategy 解决策略
   * @param localProject 本地项目（用于 merge）
   * @param remoteProject 远程项目（用于 merge）
   * @returns 解决后的项目
   */
  resolveConflict(
    projectId: string,
    strategy: ConflictResolutionStrategy,
    localProject: Project,
    remoteProject?: Project
  ): Result<Project, OperationError> {
    this.logger.info('解决冲突', { projectId, strategy });
    
    let resolvedProject: Project;
    
    switch (strategy) {
      case 'local':
        // 使用本地版本，递增版本号
        resolvedProject = {
          ...localProject,
          version: (localProject.version ?? 0) + 1
        };
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        break;
        
      case 'remote':
        // 使用远程版本
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        resolvedProject = this.validateAndRebalance(remoteProject);
        this.syncService.resolveConflict(projectId, resolvedProject, 'remote');
        break;
        
      case 'merge':
        // 智能合并
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        const mergeResult = this.smartMerge(localProject, remoteProject);
        resolvedProject = mergeResult.project;
        
        if (mergeResult.issues.length > 0) {
          this.toast.info('智能合并完成', `已自动修复 ${mergeResult.issues.length} 个数据问题`);
        }
        if (mergeResult.conflictCount > 0) {
          this.toast.warning('合并提示', `${mergeResult.conflictCount} 个任务存在修改冲突，已使用本地版本`);
        }
        
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        break;
    }
    
    return success(resolvedProject);
  }

  /**
   * 智能合并两个项目
   * 策略：
   * 1. 新增任务：双方都保留
   * 2. 删除任务：双方都执行
   * 3. 修改冲突：使用 updatedAt 较新的版本，如果相同则使用本地
   * 4. 合并后执行完整性检查
   */
  smartMerge(local: Project, remote: Project): MergeResult {
    const issues: string[] = [];
    let conflictCount = 0;
    
    // 创建任务映射
    const localTaskMap = new Map(local.tasks.map(t => [t.id, t]));
    const remoteTaskMap = new Map(remote.tasks.map(t => [t.id, t]));
    
    const mergedTasks: Task[] = [];
    const processedIds = new Set<string>();
    
    // 处理本地任务
    for (const localTask of local.tasks) {
      processedIds.add(localTask.id);
      const remoteTask = remoteTaskMap.get(localTask.id);
      
      if (!remoteTask) {
        // 本地新增的任务，保留
        mergedTasks.push(localTask);
        continue;
      }
      
      // 双方都有的任务，检查是否有修改冲突
      const hasContentDiff = this.hasTaskContentDiff(localTask, remoteTask);
      
      if (hasContentDiff) {
        conflictCount++;
        // 比较更新时间，选择较新的版本
        const localTime = localTask.updatedAt ? new Date(localTask.updatedAt).getTime() : 0;
        const remoteTime = remoteTask.updatedAt ? new Date(remoteTask.updatedAt).getTime() : 0;
        
        if (remoteTime > localTime) {
          // 远程版本更新，使用远程版本
          mergedTasks.push(remoteTask);
          this.logger.debug('任务修改冲突，使用远程版本（更新）', { taskId: localTask.id, localTime, remoteTime });
        } else {
          // 本地版本更新或时间相同，使用本地版本
          mergedTasks.push(localTask);
          this.logger.debug('任务修改冲突，使用本地版本', { taskId: localTask.id, localTime, remoteTime });
        }
      } else {
        // 无内容差异，合并位置等其他属性（使用更新时间较新的版本）
        const localTime = localTask.updatedAt ? new Date(localTask.updatedAt).getTime() : 0;
        const remoteTime = remoteTask.updatedAt ? new Date(remoteTask.updatedAt).getTime() : 0;
        
        mergedTasks.push({
          ...(remoteTime > localTime ? remoteTask : localTask),
          // 保留位置信息（位置不作为冲突判定）
          x: localTask.x,
          y: localTask.y
        });
      }
    }
    
    // 处理远程新增的任务
    for (const remoteTask of remote.tasks) {
      if (!processedIds.has(remoteTask.id)) {
        mergedTasks.push(remoteTask);
      }
    }
    
    // 合并 connections
    const mergedConnections = this.mergeConnections(local.connections, remote.connections);
    
    // 构建合并后的项目
    let mergedProject: Project = {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      // 使用较大的版本号 + 1
      version: Math.max(local.version ?? 0, remote.version ?? 0) + 1
    };
    
    // 合并后执行完整性检查
    const { project: validatedProject, issues: validationIssues } = 
      this.layoutService.validateAndFixTree(mergedProject);
    
    issues.push(...validationIssues);
    mergedProject = validatedProject;
    
    return {
      project: mergedProject,
      issues,
      conflictCount
    };
  }

  /**
   * 在重新连接时合并离线数据
   * 比较离线缓存和云端数据，将离线期间的修改同步到云端
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
        // 离线创建的新项目，需要上传到云端
        const result = await this.syncService.saveProjectToCloud(offlineProject, userId);
        if (result.success) {
          mergedProjects.push(offlineProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步', { projectName: offlineProject.name });
        }
        continue;
      }
      
      // 比较版本号
      const offlineVersion = offlineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        // 离线版本更新，需要同步到云端
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
          this.logger.info('离线修改已同步', { projectName: offlineProject.name });
        } else if (result.conflict) {
          // 存在冲突
          conflictProjects.push(offlineProject);
          this.logger.warn('离线数据存在冲突', { projectName: offlineProject.name });
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  // ========== 私有方法 ==========

  /**
   * 检查两个任务是否有内容差异
   */
  private hasTaskContentDiff(local: Task, remote: Task): boolean {
    return local.title !== remote.title ||
           local.content !== remote.content ||
           local.status !== remote.status ||
           local.priority !== remote.priority ||
           local.dueDate !== remote.dueDate;
  }

  /**
   * 合并连接
   */
  private mergeConnections(
    local: Project['connections'],
    remote: Project['connections']
  ): Project['connections'] {
    const localConnSet = new Set(local.map(c => `${c.source}->${c.target}`));
    const merged = [...local];
    
    for (const conn of remote) {
      const key = `${conn.source}->${conn.target}`;
      if (!localConnSet.has(key)) {
        merged.push(conn);
      }
    }
    
    return merged;
  }

  /**
   * 验证并重平衡项目
   */
  private validateAndRebalance(project: Project): Project {
    const { project: validatedProject } = this.layoutService.validateAndFixTree(project);
    return this.layoutService.rebalance(validatedProject);
  }
}
