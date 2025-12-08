/**
 * ThreeWayMergeService - 三路合并服务
 * 
 * 实现基于 Base（共同祖先）的智能合并算法。
 * 通过对比 Base、Local、Remote 三方数据，精确判断每个字段的变更来源，
 * 从而实现真正的"自动合并"，大幅减少需要用户介入的冲突。
 * 
 * 核心逻辑：
 * - Diff_Local = Local - Base  (本地相对于基准的变更)
 * - Diff_Remote = Remote - Base (远程相对于基准的变更)
 * - MergedState = Base + Diff_Remote + Diff_Local (合并后的状态)
 * 
 * 合并策略：
 * 1. 如果只有一方修改了某字段，采用修改方的值
 * 2. 如果双方都修改了，且值相同，采用该值（无冲突）
 * 3. 如果双方都修改了，且值不同，这才是真正的冲突（需要策略决定）
 * 
 * 对于真正的冲突，默认策略是保留 Local（因为是用户刚刚编辑的内容）。
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';

/** 合并结果 */
export interface ThreeWayMergeResult {
  /** 合并后的项目 */
  project: Project;
  /** 是否有真正的冲突（双方都修改了同一字段且值不同） */
  hasRealConflicts: boolean;
  /** 冲突详情 */
  conflicts: MergeConflict[];
  /** 自动解决的变更数量 */
  autoResolvedCount: number;
  /** 合并统计 */
  stats: MergeStats;
}

/** 合并冲突详情 */
export interface MergeConflict {
  /** 冲突类型 */
  type: 'field' | 'task' | 'connection';
  /** 实体 ID（任务 ID 或连接 ID） */
  entityId?: string;
  /** 字段名 */
  field?: string;
  /** Base 值 */
  baseValue: unknown;
  /** Local 值 */
  localValue: unknown;
  /** Remote 值 */
  remoteValue: unknown;
  /** 最终采用的值 */
  resolvedValue: unknown;
  /** 解决策略 */
  resolution: 'kept-local' | 'kept-remote' | 'auto-merged';
}

/** 合并统计 */
export interface MergeStats {
  /** 本地新增的任务数 */
  localAddedTasks: number;
  /** 远程新增的任务数 */
  remoteAddedTasks: number;
  /** 本地删除的任务数 */
  localDeletedTasks: number;
  /** 远程删除的任务数 */
  remoteDeletedTasks: number;
  /** 双方都修改的任务数 */
  bothModifiedTasks: number;
  /** 只有本地修改的任务数 */
  localOnlyModifiedTasks: number;
  /** 只有远程修改的任务数 */
  remoteOnlyModifiedTasks: number;
  /** 字段级自动合并数 */
  fieldAutoMerged: number;
  /** 字段级冲突数 */
  fieldConflicts: number;
}

/** 变更类型 */
type ChangeType = 'unchanged' | 'local-only' | 'remote-only' | 'both-same' | 'both-different';

@Injectable({
  providedIn: 'root'
})
export class ThreeWayMergeService {
  private readonly logger = inject(LoggerService).category('ThreeWayMerge');
  
  /**
   * 执行三路合并
   * 
   * @param base 基准版本（上次成功同步时的快照）
   * @param local 本地版本（用户当前编辑的状态）
   * @param remote 远程版本（服务器上的最新状态）
   * @returns 合并结果
   */
  merge(base: Project, local: Project, remote: Project): ThreeWayMergeResult {
    this.logger.info('开始三路合并', {
      projectId: local.id,
      baseVersion: base.version,
      localVersion: local.version,
      remoteVersion: remote.version,
      baseTasks: base.tasks.length,
      localTasks: local.tasks.length,
      remoteTasks: remote.tasks.length
    });
    
    const conflicts: MergeConflict[] = [];
    const stats: MergeStats = {
      localAddedTasks: 0,
      remoteAddedTasks: 0,
      localDeletedTasks: 0,
      remoteDeletedTasks: 0,
      bothModifiedTasks: 0,
      localOnlyModifiedTasks: 0,
      remoteOnlyModifiedTasks: 0,
      fieldAutoMerged: 0,
      fieldConflicts: 0
    };
    
    // 1. 合并项目属性
    const { mergedProps, propsConflicts } = this.mergeProjectProps(base, local, remote);
    conflicts.push(...propsConflicts);
    stats.fieldAutoMerged += propsConflicts.filter(c => c.resolution === 'auto-merged').length;
    stats.fieldConflicts += propsConflicts.filter(c => c.resolution === 'kept-local').length;
    
    // 2. 合并任务列表
    const { mergedTasks, taskConflicts, taskStats } = this.mergeTasks(
      base.tasks,
      local.tasks,
      remote.tasks
    );
    conflicts.push(...taskConflicts);
    Object.assign(stats, taskStats);
    
    // 3. 合并连接列表
    const { mergedConnections, connectionConflicts } = this.mergeConnections(
      base.connections,
      local.connections,
      remote.connections
    );
    conflicts.push(...connectionConflicts);
    
    // 构建合并后的项目
    const mergedProject: Project = {
      ...local, // 保留本地的其他元数据
      ...mergedProps,
      tasks: mergedTasks,
      connections: mergedConnections,
      // 版本号设为远程版本（因为我们是在远程基础上合并）
      version: remote.version,
      updatedAt: new Date().toISOString()
    };
    
    const hasRealConflicts = conflicts.some(c => c.resolution === 'kept-local');
    const autoResolvedCount = conflicts.filter(c => 
      c.resolution === 'auto-merged' || c.resolution === 'kept-remote'
    ).length;
    
    this.logger.info('三路合并完成', {
      projectId: local.id,
      hasRealConflicts,
      autoResolvedCount,
      totalConflicts: conflicts.length,
      mergedTaskCount: mergedTasks.length,
      stats
    });
    
    return {
      project: mergedProject,
      hasRealConflicts,
      conflicts,
      autoResolvedCount,
      stats
    };
  }
  
  /**
   * 合并项目属性（字段级合并）
   */
  private mergeProjectProps(
    base: Project,
    local: Project,
    remote: Project
  ): { mergedProps: Partial<Project>; propsConflicts: MergeConflict[] } {
    const conflicts: MergeConflict[] = [];
    const mergedProps: Partial<Project> = {};
    
    // 需要合并的项目属性
    const propsToMerge: (keyof Project)[] = ['name', 'description'];
    
    for (const key of propsToMerge) {
      const baseVal = base[key];
      const localVal = local[key];
      const remoteVal = remote[key];
      
      const { value, changeType } = this.mergeField(baseVal, localVal, remoteVal);
      (mergedProps as Record<string, unknown>)[key] = value;
      
      if (changeType === 'both-different') {
        conflicts.push({
          type: 'field',
          field: key,
          baseValue: baseVal,
          localValue: localVal,
          remoteValue: remoteVal,
          resolvedValue: value,
          resolution: 'kept-local' // 双方都改且不同，保留本地
        });
      } else if (changeType === 'remote-only' || changeType === 'both-same') {
        // 自动合并成功的情况
        if (localVal !== remoteVal) {
          conflicts.push({
            type: 'field',
            field: key,
            baseValue: baseVal,
            localValue: localVal,
            remoteValue: remoteVal,
            resolvedValue: value,
            resolution: changeType === 'remote-only' ? 'kept-remote' : 'auto-merged'
          });
        }
      }
    }
    
    return { mergedProps, propsConflicts: conflicts };
  }
  
  /**
   * 合并单个字段
   */
  private mergeField<T>(baseVal: T, localVal: T, remoteVal: T): { value: T; changeType: ChangeType } {
    const localChanged = !this.deepEqual(localVal, baseVal);
    const remoteChanged = !this.deepEqual(remoteVal, baseVal);
    
    if (!localChanged && !remoteChanged) {
      // 双方都没改
      return { value: baseVal, changeType: 'unchanged' };
    }
    
    if (localChanged && !remoteChanged) {
      // 只有本地改了
      return { value: localVal, changeType: 'local-only' };
    }
    
    if (!localChanged && remoteChanged) {
      // 只有远程改了
      return { value: remoteVal, changeType: 'remote-only' };
    }
    
    // 双方都改了
    if (this.deepEqual(localVal, remoteVal)) {
      // 改得一样
      return { value: localVal, changeType: 'both-same' };
    }
    
    // 真正的冲突：双方都改了且不同，优先保留本地
    return { value: localVal, changeType: 'both-different' };
  }
  
  /**
   * 合并任务列表
   */
  private mergeTasks(
    baseTasks: Task[],
    localTasks: Task[],
    remoteTasks: Task[]
  ): {
    mergedTasks: Task[];
    taskConflicts: MergeConflict[];
    taskStats: Partial<MergeStats>;
  } {
    const conflicts: MergeConflict[] = [];
    const stats: Partial<MergeStats> = {
      localAddedTasks: 0,
      remoteAddedTasks: 0,
      localDeletedTasks: 0,
      remoteDeletedTasks: 0,
      bothModifiedTasks: 0,
      localOnlyModifiedTasks: 0,
      remoteOnlyModifiedTasks: 0,
      fieldAutoMerged: 0,
      fieldConflicts: 0
    };
    
    // 转换为 Map 方便查找
    const baseMap = new Map(baseTasks.map(t => [t.id, t]));
    const localMap = new Map(localTasks.map(t => [t.id, t]));
    const remoteMap = new Map(remoteTasks.map(t => [t.id, t]));
    
    // 收集所有任务 ID
    const allTaskIds = new Set([
      ...baseMap.keys(),
      ...localMap.keys(),
      ...remoteMap.keys()
    ]);
    
    const mergedTasks: Task[] = [];
    
    for (const taskId of allTaskIds) {
      const baseTask = baseMap.get(taskId);
      const localTask = localMap.get(taskId);
      const remoteTask = remoteMap.get(taskId);
      
      const inBase = !!baseTask;
      const inLocal = !!localTask;
      const inRemote = !!remoteTask;
      
      // 场景1：只在本地存在（本地新增）
      if (inLocal && !inBase && !inRemote) {
        mergedTasks.push(localTask);
        stats.localAddedTasks!++;
        continue;
      }
      
      // 场景2：只在远程存在（远程新增）
      if (inRemote && !inBase && !inLocal) {
        mergedTasks.push(remoteTask);
        stats.remoteAddedTasks!++;
        continue;
      }
      
      // 场景3：在 Base 和远程存在，但本地不存在（本地删除）
      if (inBase && inRemote && !inLocal) {
        // 检查远程是否修改过
        if (this.taskModified(baseTask, remoteTask)) {
          // 远程修改了，但本地删除了 - 删除优先（更保守的做法）
          this.logger.debug('本地删除与远程修改冲突，删除优先', { taskId });
          conflicts.push({
            type: 'task',
            entityId: taskId,
            baseValue: baseTask,
            localValue: null,
            remoteValue: remoteTask,
            resolvedValue: null,
            resolution: 'kept-local'
          });
        }
        stats.localDeletedTasks!++;
        // 不添加到合并结果（已删除）
        continue;
      }
      
      // 场景4：在 Base 和本地存在，但远程不存在（远程删除）
      if (inBase && inLocal && !inRemote) {
        // 检查本地是否修改过
        if (this.taskModified(baseTask, localTask)) {
          // 本地修改了，但远程删除了 - 保留本地修改
          this.logger.debug('远程删除与本地修改冲突，保留本地', { taskId });
          mergedTasks.push(localTask);
          conflicts.push({
            type: 'task',
            entityId: taskId,
            baseValue: baseTask,
            localValue: localTask,
            remoteValue: null,
            resolvedValue: localTask,
            resolution: 'kept-local'
          });
        } else {
          // 本地没修改，接受远程删除
          stats.remoteDeletedTasks!++;
        }
        continue;
      }
      
      // 场景5：三方都存在（可能有修改）
      if (inBase && inLocal && inRemote) {
        const { mergedTask, taskConflicts: tConflicts } = this.mergeTask(
          baseTask,
          localTask,
          remoteTask
        );
        mergedTasks.push(mergedTask);
        conflicts.push(...tConflicts);
        
        const localMod = this.taskModified(baseTask, localTask);
        const remoteMod = this.taskModified(baseTask, remoteTask);
        
        if (localMod && remoteMod) {
          stats.bothModifiedTasks!++;
        } else if (localMod) {
          stats.localOnlyModifiedTasks!++;
        } else if (remoteMod) {
          stats.remoteOnlyModifiedTasks!++;
        }
        
        stats.fieldAutoMerged! += tConflicts.filter(c => c.resolution !== 'kept-local').length;
        stats.fieldConflicts! += tConflicts.filter(c => c.resolution === 'kept-local').length;
        continue;
      }
      
      // 场景6：本地和远程都新增了同一个 ID（几乎不可能，但要处理）
      if (inLocal && inRemote && !inBase) {
        // 合并两个版本
        const { mergedTask } = this.mergeTask(
          localTask, // 用 local 作为伪 base
          localTask,
          remoteTask
        );
        mergedTasks.push(mergedTask);
        this.logger.warn('本地和远程同时新增相同ID的任务', { taskId });
        continue;
      }
    }
    
    return { mergedTasks, taskConflicts: conflicts, taskStats: stats };
  }
  
  /**
   * 合并单个任务（字段级合并）
   */
  private mergeTask(
    base: Task,
    local: Task,
    remote: Task
  ): { mergedTask: Task; taskConflicts: MergeConflict[] } {
    const conflicts: MergeConflict[] = [];
    
    // 需要合并的任务属性
    const fieldsToMerge: (keyof Task)[] = [
      'title', 'content', 'stage', 'parentId', 'order', 'rank',
      'status', 'x', 'y', 'priority', 'dueDate'
    ];
    
    const mergedTask: Task = { ...base };
    
    for (const key of fieldsToMerge) {
      const baseVal = base[key];
      const localVal = local[key];
      const remoteVal = remote[key];
      
      const { value, changeType } = this.mergeField(baseVal, localVal, remoteVal);
      (mergedTask as unknown as Record<string, unknown>)[key] = value;
      
      if (changeType === 'both-different') {
        conflicts.push({
          type: 'task',
          entityId: base.id,
          field: key,
          baseValue: baseVal,
          localValue: localVal,
          remoteValue: remoteVal,
          resolvedValue: value,
          resolution: 'kept-local'
        });
      }
    }
    
    // 特殊处理：标签数组
    mergedTask.tags = this.mergeTags(base.tags, local.tags, remote.tags);
    
    // 特殊处理：附件数组
    mergedTask.attachments = this.mergeAttachments(
      base.attachments,
      local.attachments,
      remote.attachments
    );
    
    // 更新时间戳
    mergedTask.updatedAt = new Date().toISOString();
    
    // 保留本地的 displayId 和 shortId
    mergedTask.displayId = local.displayId;
    mergedTask.shortId = local.shortId || remote.shortId || base.shortId;
    
    return { mergedTask, taskConflicts: conflicts };
  }
  
  /**
   * 合并标签数组
   */
  private mergeTags(
    baseTags: string[] | undefined,
    localTags: string[] | undefined,
    remoteTags: string[] | undefined
  ): string[] | undefined {
    const base = new Set(baseTags || []);
    const local = new Set(localTags || []);
    const remote = new Set(remoteTags || []);
    
    const result = new Set<string>();
    
    // 合并所有标签
    const allTags = new Set([...base, ...local, ...remote]);
    
    for (const tag of allTags) {
      const inBase = base.has(tag);
      const inLocal = local.has(tag);
      const inRemote = remote.has(tag);
      
      // 在 Base 中没有，在 Local 或 Remote 中有 -> 新增
      if (!inBase && (inLocal || inRemote)) {
        result.add(tag);
        continue;
      }
      
      // 在 Base 中有
      if (inBase) {
        // 两边都保留 -> 保留
        if (inLocal && inRemote) {
          result.add(tag);
        }
        // 只有一边删除 -> 删除
        // 如果 local 删除了，说明用户主动删除
        // 如果 remote 删除了，说明其他地方删除了
        // 这里我们采用"任一方删除则删除"的策略
      }
    }
    
    return result.size > 0 ? Array.from(result) : undefined;
  }
  
  /**
   * 合并附件数组
   */
  private mergeAttachments(
    baseAttachments: Task['attachments'],
    localAttachments: Task['attachments'],
    remoteAttachments: Task['attachments']
  ): Task['attachments'] {
    const baseMap = new Map((baseAttachments || []).map(a => [a.id, a]));
    const localMap = new Map((localAttachments || []).map(a => [a.id, a]));
    const remoteMap = new Map((remoteAttachments || []).map(a => [a.id, a]));
    
    const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    const result: NonNullable<Task['attachments']> = [];
    
    for (const id of allIds) {
      const baseAtt = baseMap.get(id);
      const localAtt = localMap.get(id);
      const remoteAtt = remoteMap.get(id);
      
      // 本地新增
      if (localAtt && !baseAtt && !remoteAtt) {
        result.push(localAtt);
        continue;
      }
      
      // 远程新增
      if (remoteAtt && !baseAtt && !localAtt) {
        result.push(remoteAtt);
        continue;
      }
      
      // 本地删除（包括软删除）
      if (baseAtt && !localAtt) {
        // 不添加到结果
        continue;
      }
      
      // 远程删除
      if (baseAtt && !remoteAtt && localAtt) {
        // 如果本地没有修改，接受远程删除
        if (this.deepEqual(baseAtt, localAtt)) {
          continue;
        }
        // 本地有修改，保留本地
        result.push(localAtt);
        continue;
      }
      
      // 三方都有，使用最新的
      if (localAtt && remoteAtt) {
        // 检查软删除状态
        if (localAtt.deletedAt || remoteAtt.deletedAt) {
          // 任一方软删除，视为删除
          continue;
        }
        // 使用较新的（基于 createdAt 或其他时间戳）
        result.push(localAtt); // 优先本地
      }
    }
    
    return result.length > 0 ? result : undefined;
  }
  
  /**
   * 合并连接列表
   */
  private mergeConnections(
    baseConns: Connection[],
    localConns: Connection[],
    remoteConns: Connection[]
  ): { mergedConnections: Connection[]; connectionConflicts: MergeConflict[] } {
    const conflicts: MergeConflict[] = [];
    
    // 使用 source->target 作为连接的唯一标识
    const getKey = (c: Connection) => `${c.source}->${c.target}`;
    
    const baseMap = new Map(baseConns.map(c => [getKey(c), c]));
    const localMap = new Map(localConns.map(c => [getKey(c), c]));
    const remoteMap = new Map(remoteConns.map(c => [getKey(c), c]));
    
    const allKeys = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    const result: Connection[] = [];
    
    for (const key of allKeys) {
      const baseConn = baseMap.get(key);
      const localConn = localMap.get(key);
      const remoteConn = remoteMap.get(key);
      
      // 本地新增
      if (localConn && !baseConn && !remoteConn) {
        if (!localConn.deletedAt) {
          result.push(localConn);
        }
        continue;
      }
      
      // 远程新增
      if (remoteConn && !baseConn && !localConn) {
        if (!remoteConn.deletedAt) {
          result.push(remoteConn);
        }
        continue;
      }
      
      // 本地删除
      if (baseConn && !localConn) {
        // 不添加到结果
        continue;
      }
      
      // 远程删除
      if (baseConn && !remoteConn && localConn) {
        // 如果本地没有修改，接受远程删除
        if (!localConn.deletedAt && this.deepEqual(baseConn.description, localConn.description)) {
          continue;
        }
        // 本地有修改，保留本地
        if (!localConn.deletedAt) {
          result.push(localConn);
        }
        continue;
      }
      
      // 三方都有
      if (localConn && remoteConn) {
        // 检查软删除
        if (localConn.deletedAt && remoteConn.deletedAt) {
          continue; // 双方都删除
        }
        if (localConn.deletedAt) {
          continue; // 本地删除优先
        }
        if (remoteConn.deletedAt) {
          result.push(localConn); // 远程删除但本地保留
          continue;
        }
        
        // 合并描述
        const { value: mergedDesc } = this.mergeField(
          baseConn?.description,
          localConn.description,
          remoteConn.description
        );
        
        result.push({
          ...localConn,
          description: mergedDesc
        });
      }
    }
    
    return { mergedConnections: result, connectionConflicts: conflicts };
  }
  
  /**
   * 检查任务是否被修改
   */
  private taskModified(base: Task, current: Task): boolean {
    if (!base || !current) return true;
    
    const fieldsToCheck: (keyof Task)[] = [
      'title', 'content', 'stage', 'parentId', 'order', 'status', 'priority', 'dueDate'
    ];
    
    for (const field of fieldsToCheck) {
      if (!this.deepEqual(base[field], current[field])) {
        return true;
      }
    }
    
    // 检查标签
    if (!this.arraysEqual(base.tags, current.tags)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * 深度比较两个值
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    
    if (typeof a !== typeof b) return false;
    
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => this.deepEqual(item, b[i]));
    }
    
    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a as object);
      const keysB = Object.keys(b as object);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(key => 
        this.deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      );
    }
    
    return false;
  }
  
  /**
   * 数组相等比较
   */
  private arraysEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    
    return sortedA.every((item, i) => this.deepEqual(item, sortedB[i]));
  }
  
  /**
   * 判断是否可以自动合并（不需要用户介入）
   */
  canAutoMerge(base: Project, local: Project, remote: Project): boolean {
    const result = this.merge(base, local, remote);
    return !result.hasRealConflicts;
  }
  
  /**
   * 快速预检：检查是否有可能需要合并
   * 用于优化性能，避免不必要的完整合并计算
   */
  needsMerge(base: Project, local: Project, remote: Project): boolean {
    // 如果版本号相同，不需要合并
    if (local.version === remote.version) {
      return false;
    }
    
    // 如果任务数量不同，可能需要合并
    if (base.tasks.length !== local.tasks.length || 
        base.tasks.length !== remote.tasks.length) {
      return true;
    }
    
    // 如果连接数量不同，可能需要合并
    if (base.connections.length !== local.connections.length ||
        base.connections.length !== remote.connections.length) {
      return true;
    }
    
    return true; // 保守起见，默认需要合并
  }
}
