import { Injectable, inject, computed } from '@angular/core';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 冲突解决策略（LWW 简化版）
 * - local: 使用本地版本（用户刚编辑的内容）
 * - remote: 使用远程版本（其他设备的内容）
 * - merge: 智能合并（保留双方新增的任务，冲突时本地优先）
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
 * 冲突解决服务（LWW 简化版）
 * 
 * 采用 Last-Write-Wins 策略：
 * - 默认使用本地版本（用户刚刚编辑的内容）
 * - 用户可选择使用远程版本
 * - 支持简单的智能合并（保留双方新增的任务）
 * 
 * 职责：
 * - 冲突检测
 * - LWW 策略执行
 * - 离线数据重连合并
 */
@Injectable({
  providedIn: 'root'
})
export class ConflictResolutionService {
  private syncService = inject(SimpleSyncService);
  private layoutService = inject(LayoutService);
  private toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('ConflictResolution');

  // ========== 冲突状态 ==========
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncService.syncState().conflictData);

  // ========== 公共方法 ==========

  /**
   * 解决冲突（LWW 简化版）
   * @param projectId 项目 ID
   * @param strategy 解决策略: local（本地优先）, remote（远程优先）, merge（智能合并）
   * @param localProject 本地项目
   * @param remoteProject 远程项目
   * @returns 解决后的项目
   */
  async resolveConflict(
    projectId: string,
    strategy: ConflictResolutionStrategy,
    localProject: Project,
    remoteProject?: Project
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[LWW] 解决冲突', { projectId, strategy });
    
    let resolvedProject: Project;
    
    switch (strategy) {
      case 'local':
        // LWW：使用本地版本（用户刚编辑的内容），递增版本号
        resolvedProject = {
          ...localProject,
          version: Math.max(localProject.version ?? 0, remoteProject?.version ?? 0) + 1
        };
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        this.toast.success('已使用本地版本', '您的编辑已保留');
        break;
        
      case 'remote':
        // 使用远程版本
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        resolvedProject = this.validateAndRebalance(remoteProject);
        this.syncService.resolveConflict(projectId, resolvedProject, 'remote');
        this.toast.success('已使用远程版本', '已同步其他设备的内容');
        break;
        
      case 'merge':
        // 智能合并：保留双方新增的任务，冲突时本地优先
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        // 【关键修复】获取 tombstoneIds 防止已删除任务在合并时复活
        // 注意：这里使用同步方法会阻塞，但 resolveConflict 通常在用户交互后调用
        // 如果性能有问题，可以考虑将整个 resolveConflict 改为 async
        const tombstoneIds = await this.syncService.getTombstoneIds(projectId);
        const mergeResult = this.smartMerge(localProject, remoteProject, tombstoneIds);
        resolvedProject = mergeResult.project;
        
        if (mergeResult.issues.length > 0) {
          this.toast.info('智能合并完成', `已自动修复 ${mergeResult.issues.length} 个数据问题`);
        }
        if (mergeResult.conflictCount > 0) {
          this.toast.warning('合并提示', `${mergeResult.conflictCount} 个任务存在修改冲突，已使用本地版本`);
        }
        
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        break;
      
      default:
        // 未知策略，默认使用本地
        this.logger.warn('[LWW] 未知策略，默认使用本地', { strategy });
        resolvedProject = {
          ...localProject,
          version: Math.max(localProject.version ?? 0, remoteProject?.version ?? 0) + 1
        };
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
    }
    
    return success(resolvedProject);
  }

  /**
   * 智能合并两个项目（LWW 二路合并）
   * 策略：
   * 1. 新增任务：双方都保留
   * 2. 删除任务：双方都执行
   * 3. 修改冲突：字段级合并 - 选择每个字段较新的版本
   * 4. 合并后执行完整性检查
   * 
   * 【关键修复】正确处理已删除任务：
   * - 本地存在但远程不存在 + 在 tombstones 中 = 远程已删除，不保留
   * - 本地存在但远程不存在 + 不在 tombstones 中 = 本地新增，保留
   * 
   * @param local 本地项目
   * @param remote 远程项目
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数，用于防止已删除任务复活）
   */
  smartMerge(local: Project, remote: Project, tombstoneIds: Set<string>): MergeResult {
    const issues: string[] = [];
    let conflictCount = 0;
    
    // 防御性检查：确保 tasks 数组存在
    const localTasks = Array.isArray(local.tasks) ? local.tasks : [];
    const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
    const localConnections = Array.isArray(local.connections) ? local.connections : [];
    const remoteConnections = Array.isArray(remote.connections) ? remote.connections : [];
    
    if (!Array.isArray(local.tasks)) {
      this.logger.warn('smartMerge: local.tasks 不是数组，使用空数组', { projectId: local.id });
      issues.push('本地项目 tasks 数据异常，已使用空数组');
    }
    if (!Array.isArray(remote.tasks)) {
      this.logger.warn('smartMerge: remote.tasks 不是数组，使用空数组', { projectId: remote.id });
      issues.push('远程项目 tasks 数据异常，已使用空数组');
    }
    
    // 创建任务映射
    const _localTaskMap = new Map(localTasks.map(t => [t.id, t]));
    const remoteTaskMap = new Map(remoteTasks.map(t => [t.id, t]));
    
    const mergedTasks: Task[] = [];
    const processedIds = new Set<string>();
    let skippedTombstoneCount = 0;
    
    // 处理本地任务
    for (const localTask of localTasks) {
      processedIds.add(localTask.id);
      
      // 【关键修复】检查是否已被永久删除（在 tombstones 中）
      if (tombstoneIds.has(localTask.id)) {
        this.logger.info('smartMerge: 跳过 tombstone 任务', { taskId: localTask.id });
        skippedTombstoneCount++;
        continue; // 不保留已永久删除的任务
      }
      
      // 检查是否已软删除
      if (localTask.deletedAt) {
        this.logger.debug('smartMerge: 跳过软删除任务', { taskId: localTask.id });
        continue;
      }
      
      const remoteTask = remoteTaskMap.get(localTask.id);
      
      if (!remoteTask) {
        // 本地存在但远程不存在
        // 由于已经过滤了 tombstones，这里是真正的本地新增任务
        mergedTasks.push(localTask);
        continue;
      }
      
      // 双方都有的任务，执行字段级合并
      const { mergedTask, hasConflict } = this.mergeTaskFields(localTask, remoteTask);
      
      if (hasConflict) {
        conflictCount++;
        this.logger.debug('任务存在字段冲突，已合并', { taskId: localTask.id });
      }
      
      mergedTasks.push(mergedTask);
    }
    
    // 处理远程新增的任务
    for (const remoteTask of remoteTasks) {
      if (!processedIds.has(remoteTask.id)) {
        // 远程任务不在 tombstones 中才添加（loadFullProject 已经过滤了）
        // 但本地也可能有软删除状态
        if (!remoteTask.deletedAt) {
          mergedTasks.push(remoteTask);
        }
      }
    }
    
    if (skippedTombstoneCount > 0) {
      this.logger.info('smartMerge: 已过滤 tombstone 任务', { 
        count: skippedTombstoneCount, 
        projectId: local.id 
      });
      issues.push(`已过滤 ${skippedTombstoneCount} 个已删除的任务`);
    }
    
    // 合并 connections
    const mergedConnections = this.mergeConnections(localConnections, remoteConnections);
    
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
   * 字段级任务合并
   * 对每个字段单独判断，使用更新时间更晚的版本
   * 如果两个版本的更新时间相同，优先使用本地版本
   */
  private mergeTaskFields(local: Task, remote: Task): { mergedTask: Task; hasConflict: boolean } {
    const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    
    // 确定基础版本（使用更新时间较新的）
    const baseTask = remoteTime > localTime ? remote : local;
    const _otherTask = remoteTime > localTime ? local : remote;
    
    let hasConflict = false;
    
    // 字段级合并：检查每个可编辑字段
    const mergedTask: Task = { ...baseTask };
    
    // 标题：如果不同，检测是否是有意义的编辑
    if (local.title !== remote.title) {
      hasConflict = true;
      // 使用较长的标题（更可能是编辑后的）或更新时间较新的
      mergedTask.title = remoteTime > localTime ? remote.title : local.title;
    }
    
    // 内容：如果不同，尝试合并或使用较新版本
    if (local.content !== remote.content) {
      hasConflict = true;
      // 对于内容，尝试智能合并（如果两边都有添加）
      const mergedContent = this.mergeTextContent(local.content, remote.content, localTime, remoteTime);
      mergedTask.content = mergedContent;
    }
    
    // 状态：如果不同，使用更新时间较新的
    if (local.status !== remote.status) {
      hasConflict = true;
      mergedTask.status = remoteTime > localTime ? remote.status : local.status;
    }
    
    // 优先级：如果不同，使用更新时间较新的
    if (local.priority !== remote.priority) {
      hasConflict = true;
      mergedTask.priority = remoteTime > localTime ? remote.priority : local.priority;
    }
    
    // 截止日期：如果不同，使用更新时间较新的
    if (local.dueDate !== remote.dueDate) {
      hasConflict = true;
      mergedTask.dueDate = remoteTime > localTime ? remote.dueDate : local.dueDate;
    }
    
    // 标签：智能合并两边的标签
    if (local.tags || remote.tags) {
      const localTags = local.tags || [];
      const remoteTags = remote.tags || [];
      const mergedTags = this.mergeTagsWithIntent(localTags, remoteTags, localTime, remoteTime);
      mergedTask.tags = mergedTags.length > 0 ? mergedTags : undefined;
      // 标签变化也算冲突
      if (local.tags?.length !== remote.tags?.length || 
          !localTags.every(t => remoteTags.includes(t))) {
        hasConflict = true;
      }
    }
    
    // 附件：合并两边的附件（按 ID 去重）
    if (local.attachments || remote.attachments) {
      const localAttachments = local.attachments || [];
      const remoteAttachments = remote.attachments || [];
      const attachmentMap = new Map<string, typeof localAttachments[0]>();
      
      // 先添加本地附件
      localAttachments.forEach(a => attachmentMap.set(a.id, a));
      // 远程附件覆盖（如果存在）
      remoteAttachments.forEach(a => {
        if (!attachmentMap.has(a.id) || remoteTime > localTime) {
          attachmentMap.set(a.id, a);
        }
      });
      
      mergedTask.attachments = Array.from(attachmentMap.values());
    }
    
    // 位置信息：保留本地位置（避免拖拽位置被覆盖）
    mergedTask.x = local.x;
    mergedTask.y = local.y;
    
    // 阶段、父级、排序：使用较新版本的结构信息
    if (local.stage !== remote.stage || local.parentId !== remote.parentId || local.order !== remote.order) {
      if (remoteTime > localTime) {
        mergedTask.stage = remote.stage;
        mergedTask.parentId = remote.parentId;
        mergedTask.order = remote.order;
        mergedTask.rank = remote.rank;
      }
    }
    
    // 删除标记：任一方删除则删除（删除优先）
    // 这样确保在任何一个标签页删除的任务，在合并时都会保持删除状态
    if (local.deletedAt || remote.deletedAt) {
      hasConflict = true;
      // 使用最早的删除时间，或者如果只有一方删除，使用那个删除时间
      if (local.deletedAt && remote.deletedAt) {
        const localDeleteTime = new Date(local.deletedAt).getTime();
        const remoteDeleteTime = new Date(remote.deletedAt).getTime();
        mergedTask.deletedAt = localDeleteTime < remoteDeleteTime ? local.deletedAt : remote.deletedAt;
      } else {
        mergedTask.deletedAt = local.deletedAt || remote.deletedAt;
      }
    }
    
    // 更新合并时间戳
    mergedTask.updatedAt = new Date().toISOString();
    
    return { mergedTask, hasConflict };
  }

  /**
   * 智能合并文本内容
   * 尝试保留双方的添加
   */
  private mergeTextContent(localContent: string, remoteContent: string, localTime: number, remoteTime: number): string {
    // 简单策略：如果一方的内容是另一方的前缀/后缀，则合并
    // 否则使用更新时间较新的版本
    
    // 检查是否一方是另一方的扩展
    if (remoteContent.startsWith(localContent)) {
      // 远程内容是本地内容的扩展，使用远程
      return remoteContent;
    }
    if (localContent.startsWith(remoteContent)) {
      // 本地内容是远程内容的扩展，使用本地
      return localContent;
    }
    if (remoteContent.endsWith(localContent)) {
      // 远程内容以本地内容结尾
      return remoteContent;
    }
    if (localContent.endsWith(remoteContent)) {
      // 本地内容以远程内容结尾
      return localContent;
    }
    
    // 尝试行级合并（适用于待办列表场景）
    const localLines = localContent.split('\n');
    const remoteLines = remoteContent.split('\n');
    
    // 如果行数差异不大，尝试合并
    if (Math.abs(localLines.length - remoteLines.length) <= 5) {
      const mergedLines = this.mergeLines(localLines, remoteLines);
      if (mergedLines) {
        return mergedLines.join('\n');
      }
    }
    
    // 默认：使用更新时间较新的版本
    return remoteTime > localTime ? remoteContent : localContent;
  }

  /**
   * 行级合并
   * 尝试保留双方新增的行
   */
  private mergeLines(localLines: string[], remoteLines: string[]): string[] | null {
    const localSet = new Set(localLines);
    const remoteSet = new Set(remoteLines);
    
    // 找出双方共有的行
    const commonLines = localLines.filter(line => remoteSet.has(line));
    
    // 如果共有行太少，说明内容差异太大，无法行级合并
    if (commonLines.length < Math.min(localLines.length, remoteLines.length) * 0.5) {
      return null;
    }
    
    // 找出各自新增的行
    const localOnlyLines = localLines.filter(line => !remoteSet.has(line));
    const remoteOnlyLines = remoteLines.filter(line => !localSet.has(line));
    
    // 合并：保留所有共有行 + 本地新增 + 远程新增
    // 保持原有顺序：以较长的版本为基础，在合适位置插入新增行
    const baselines = localLines.length >= remoteLines.length ? localLines : remoteLines;
    const additionalLines = localLines.length >= remoteLines.length ? remoteOnlyLines : localOnlyLines;
    
    // 简单策略：将新增行追加到末尾
    return [...baselines, ...additionalLines.filter(line => !new Set(baselines).has(line))];
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
      // 【关键修复】在处理离线项目前，过滤已删除的任务
      // 防止已删除任务通过离线数据同步复活
      const cleanedOfflineProject = {
        ...offlineProject,
        tasks: (offlineProject.tasks || []).filter(t => !t.deletedAt)
      };
      
      const cloudProject = cloudMap.get(cleanedOfflineProject.id);
      
      if (!cloudProject) {
        // 离线创建的新项目，需要上传到云端
        const result = await this.syncService.saveProjectToCloud(cleanedOfflineProject, userId);
        if (result.success) {
          mergedProjects.push(cleanedOfflineProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步', { projectName: cleanedOfflineProject.name });
        }
        continue;
      }
      
      // 比较版本号
      const offlineVersion = cleanedOfflineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        // 离线版本更新，需要同步到云端
        const projectToSync = {
          ...cleanedOfflineProject,
          version: Math.max(offlineVersion, cloudVersion) + 1
        };
        
        const result = await this.syncService.saveProjectToCloud(projectToSync, userId);
        if (result.success) {
          const idx = mergedProjects.findIndex(p => p.id === cleanedOfflineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = projectToSync;
          }
          syncedCount++;
          this.logger.info('离线修改已同步', { projectName: cleanedOfflineProject.name });
        } else if (result.conflict) {
          // 存在冲突
          conflictProjects.push(cleanedOfflineProject);
          this.logger.warn('离线数据存在冲突', { projectName: cleanedOfflineProject.name });
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  // ========== 私有方法 ==========

  /**
   * 合并连接
   * 
   * 软删除策略：删除优先 (Tombstone Wins)
   * - 如果任一方软删除了连接，最终结果保持软删除状态
   * - 这确保删除操作可以正确同步到所有设备
   * - 恢复操作需要显式清除 deletedAt 字段
   */
  private mergeConnections(
    local: Project['connections'],
    remote: Project['connections']
  ): Project['connections'] {
    const connMap = new Map<string, typeof local[0]>();
    
    // 先添加本地连接
    for (const conn of local) {
      const key = `${conn.source}->${conn.target}`;
      connMap.set(key, conn);
    }
    
    // 合并远程连接
    for (const conn of remote) {
      const key = `${conn.source}->${conn.target}`;
      const existing = connMap.get(key);
      
      if (!existing) {
        // 远程新增的连接（或本地没有）
        connMap.set(key, conn);
      } else {
        // 两边都有同一连接，处理软删除状态
        // 策略：删除优先 (Tombstone Wins)
        
        if (existing.deletedAt && conn.deletedAt) {
          // 两边都删除了，使用更早的删除时间（保留删除状态）
          const existingTime = new Date(existing.deletedAt).getTime();
          const remoteTime = new Date(conn.deletedAt).getTime();
          connMap.set(key, existingTime < remoteTime ? existing : conn);
        } else if (existing.deletedAt) {
          // 本地删除了，远程没删除 —— 保持删除状态
          // 这确保本地删除可以同步到其他设备
          // 不做任何操作，保持 existing（已删除）
        } else if (conn.deletedAt) {
          // 远程删除了，本地没删除 —— 采用远程删除状态
          connMap.set(key, conn);
        } else {
          // 两边都未删除，合并描述
          if (conn.description !== existing.description) {
            // 使用较长的描述，或远程描述（如果本地为空）
            const mergedDesc = !existing.description ? conn.description
              : !conn.description ? existing.description
              : (conn.description.length > existing.description.length ? conn.description : existing.description);
            connMap.set(key, { ...existing, description: mergedDesc });
          }
        }
      }
    }
    
    return Array.from(connMap.values());
  }

  /**
   * 验证并重平衡项目
   */
  private validateAndRebalance(project: Project): Project {
    const { project: validatedProject } = this.layoutService.validateAndFixTree(project);
    return this.layoutService.rebalance(validatedProject);
  }

  /**
   * 智能合并标签，考虑用户意图
   * 
   * 策略：
   * 1. 两边都有的标签：保留
   * 2. 只在一边新增的标签：保留（用户添加了新标签）
   * 3. 标签在一边被删除：
   *    - 如果删除方的更新时间更新，则删除该标签
   *    - 否则保留该标签
   * 
   * 这样可以正确处理：
   * - 用户 A 添加标签 X，用户 B 添加标签 Y → 结果：X, Y
   * - 用户 A 删除标签 X（最后操作），用户 B 未改动 → 结果：无 X
   * - 用户 A 保留标签 X，用户 B 删除标签 X（最后操作） → 结果：无 X
   */
  private mergeTagsWithIntent(
    localTags: string[],
    remoteTags: string[],
    localTime: number,
    remoteTime: number
  ): string[] {
    const localSet = new Set(localTags);
    const remoteSet = new Set(remoteTags);
    const resultSet = new Set<string>();
    
    // 两边都有的标签：保留
    for (const tag of localTags) {
      if (remoteSet.has(tag)) {
        resultSet.add(tag);
      }
    }
    
    // 只在本地有的标签：
    // - 如果本地更新时间 >= 远程，说明是本地新增或保留的，保留
    // - 如果远程更新时间更新，说明远程可能删除了这个标签，不保留
    for (const tag of localTags) {
      if (!remoteSet.has(tag)) {
        if (localTime >= remoteTime) {
          // 本地较新，保留本地新增的标签
          resultSet.add(tag);
        }
        // 否则：远程较新，远程可能是有意删除了这个标签，不保留
      }
    }
    
    // 只在远程有的标签：
    // - 如果远程更新时间 >= 本地，说明是远程新增的，保留
    // - 如果本地更新时间更新，说明本地可能删除了这个标签，不保留
    for (const tag of remoteTags) {
      if (!localSet.has(tag)) {
        if (remoteTime >= localTime) {
          // 远程较新，保留远程新增的标签
          resultSet.add(tag);
        }
        // 否则：本地较新，本地可能是有意删除了这个标签，不保留
      }
    }
    
    return Array.from(resultSet);
  }
}
