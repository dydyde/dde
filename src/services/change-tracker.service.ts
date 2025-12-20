/**
 * ChangeTrackerService - 变更追踪服务
 * 
 * 【设计目的】
 * 解决全量同步的性能问题，实现真正的增量更新机制。
 * 追踪任务和连接的变更，只同步发生变化的实体。
 * 
 * 【核心概念】
 * - 脏标记（Dirty Flag）：标记哪些实体需要同步
 * - 变更类型：区分创建、更新、删除操作
 * - 项目级聚合：按项目ID分组管理变更
 * 
 * 【使用场景】
 * 1. 用户修改任务标题 → 只同步该任务
 * 2. 用户删除连接 → 只删除该连接
 * 3. 批量拖拽任务 → 聚合位置变更，一次批量同步
 * 
 * 【性能优势】
 * - 修改1个任务：从保存100个任务变为保存1个
 * - 支持变更合并：短时间内多次修改同一任务只产生1次同步
 * - 减少网络传输和数据库操作
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { Task, Connection } from '../models';
import { LoggerService } from './logger.service';

/**
 * 变更类型枚举
 */
export type ChangeType = 'create' | 'update' | 'delete';

/**
 * 实体类型
 */
export type EntityType = 'task' | 'connection';

/**
 * 变更记录
 */
export interface ChangeRecord {
  /** 实体ID */
  entityId: string;
  /** 实体类型 */
  entityType: EntityType;
  /** 变更类型 */
  changeType: ChangeType;
  /** 所属项目ID */
  projectId: string;
  /** 变更时间戳 */
  timestamp: number;
  /** 变更的字段（仅 update 类型有意义） */
  changedFields?: string[];
  /** 实体数据（用于 create/update） */
  data?: Task | Connection;
}

/**
 * 项目变更摘要
 */
export interface ProjectChangeSummary {
  projectId: string;
  /** 需要创建的任务 */
  tasksToCreate: Task[];
  /** 需要更新的任务 */
  tasksToUpdate: Task[];
  /** 需要删除的任务ID */
  taskIdsToDelete: string[];
  /** 需要创建的连接 */
  connectionsToCreate: Connection[];
  /** 需要更新的连接 */
  connectionsToUpdate: Connection[];
  /** 需要删除的连接（source, target 对） */
  connectionsToDelete: { source: string; target: string }[];
  /** 是否有任何变更 */
  hasChanges: boolean;
  /** 总变更数量 */
  totalChanges: number;
}

/**
 * 任务字段变更
 */
export interface TaskFieldChange {
  taskId: string;
  projectId: string;
  field: string;
  oldValue: any;
  newValue: any;
}

@Injectable({
  providedIn: 'root'
})
export class ChangeTrackerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ChangeTracker');
  
  /** 
   * 待同步的变更记录
   * Key: `${projectId}:${entityType}:${entityId}`
   */
  private pendingChanges = new Map<string, ChangeRecord>();
  
  /**
   * 字段级操作锁
   * 当用户正在操作某个任务的特定字段时（如拖拽改变 rank，点击改变 status），
   * 锁定该字段，在操作完成并收到服务器 ACK 之前，忽略来自服务器的该字段推送。
   * 这是基于逻辑状态的防抖，比基于时间阈值更可靠。
   * 
   * Key: `${projectId}:${taskId}:${field}`
   * Value: 锁定时间戳（用于超时自动解锁）
   */
  private fieldLocks = new Map<string, number>();
  
  /** 
   * 字段锁超时时间（毫秒）- 防止死锁
   * 【修复】从 10 秒增加到 30 秒，给弱网环境和移动端更多时间同步
   */
  private static readonly FIELD_LOCK_TIMEOUT_MS = 30000;
  
  /** 
   * 变更计数器（用于监控）
   */
  private changeCount = signal(0);
  
  /** 待同步变更数量 */
  readonly pendingChangeCount = computed(() => this.changeCount());
  
  /**
   * 最后一次变更的时间戳
   */
  private lastChangeAt = signal(0);
  readonly lastChangeTimestamp = computed(() => this.lastChangeAt());
  
  // ========== 任务变更追踪 ==========
  
  /**
   * 标记任务创建
   */
  trackTaskCreate(projectId: string, task: Task): void {
    const key = this.makeKey(projectId, 'task', task.id);
    
    // 如果之前有删除记录，变为更新
    const existing = this.pendingChanges.get(key);
    if (existing?.changeType === 'delete') {
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'update',
        projectId,
        timestamp: Date.now(),
        data: task
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'create',
        projectId,
        timestamp: Date.now(),
        data: task
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务创建', { projectId, taskId: task.id });
  }
  
  /**
   * 标记任务更新
   */
  trackTaskUpdate(projectId: string, task: Task, changedFields?: string[]): void {
    const key = this.makeKey(projectId, 'task', task.id);
    
    const existing = this.pendingChanges.get(key);
    
    // 如果是新创建的任务，保持 create 类型
    if (existing?.changeType === 'create') {
      this.pendingChanges.set(key, {
        ...existing,
        timestamp: Date.now(),
        data: task,
        changedFields: this.mergeFields(existing.changedFields, changedFields)
      });
    } else {
      // 合并已有的变更字段
      const mergedFields = this.mergeFields(existing?.changedFields, changedFields);
      
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'update',
        projectId,
        timestamp: Date.now(),
        changedFields: mergedFields,
        data: task
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务更新', { projectId, taskId: task.id, fields: changedFields });
  }
  
  /**
   * 标记任务删除
   */
  trackTaskDelete(projectId: string, taskId: string): void {
    const key = this.makeKey(projectId, 'task', taskId);
    
    const existing = this.pendingChanges.get(key);
    
    // 如果是新创建后又删除，直接移除记录（等于没发生过）
    if (existing?.changeType === 'create') {
      this.pendingChanges.delete(key);
    } else {
      this.pendingChanges.set(key, {
        entityId: taskId,
        entityType: 'task',
        changeType: 'delete',
        projectId,
        timestamp: Date.now()
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务删除', { projectId, taskId });
  }
  
  /**
   * 批量标记任务更新（用于拖拽等批量位置变更场景）
   */
  trackTasksUpdate(projectId: string, tasks: Task[], changedFields?: string[]): void {
    for (const task of tasks) {
      this.trackTaskUpdate(projectId, task, changedFields);
    }
  }
  
  // ========== 连接变更追踪 ==========
  
  /**
   * 标记连接创建
   */
  trackConnectionCreate(projectId: string, connection: Connection): void {
    const connectionId = this.makeConnectionId(connection.source, connection.target);
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    if (existing?.changeType === 'delete') {
      // 删除后重新创建 = 更新
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'update',
        projectId,
        timestamp: Date.now(),
        data: connection
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'create',
        projectId,
        timestamp: Date.now(),
        data: connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接创建', { projectId, source: connection.source, target: connection.target });
  }
  
  /**
   * 标记连接更新（如描述变更）
   */
  trackConnectionUpdate(projectId: string, connection: Connection): void {
    const connectionId = this.makeConnectionId(connection.source, connection.target);
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    
    if (existing?.changeType === 'create') {
      // 创建后更新，保持 create
      this.pendingChanges.set(key, {
        ...existing,
        timestamp: Date.now(),
        data: connection
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'update',
        projectId,
        timestamp: Date.now(),
        data: connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接更新', { projectId, source: connection.source, target: connection.target });
  }
  
  /**
   * 标记连接删除
   */
  trackConnectionDelete(projectId: string, source: string, target: string): void {
    const connectionId = this.makeConnectionId(source, target);
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    
    if (existing?.changeType === 'create') {
      // 创建后删除 = 没发生过
      this.pendingChanges.delete(key);
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'delete',
        projectId,
        timestamp: Date.now(),
        data: { source, target } as unknown as Connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接删除', { projectId, source, target });
  }
  
  // ========== 查询和消费 ==========
  
  /**
   * 获取项目的变更摘要
   */
  getProjectChanges(projectId: string): ProjectChangeSummary {
    const tasksToCreate: Task[] = [];
    const tasksToUpdate: Task[] = [];
    const taskIdsToDelete: string[] = [];
    const connectionsToCreate: Connection[] = [];
    const connectionsToUpdate: Connection[] = [];
    const connectionsToDelete: { source: string; target: string }[] = [];
    
    for (const [key, record] of this.pendingChanges.entries()) {
      if (record.projectId !== projectId) continue;
      
      if (record.entityType === 'task') {
        switch (record.changeType) {
          case 'create':
            if (record.data) tasksToCreate.push(record.data as Task);
            break;
          case 'update':
            if (record.data) tasksToUpdate.push(record.data as Task);
            break;
          case 'delete':
            taskIdsToDelete.push(record.entityId);
            break;
        }
      } else if (record.entityType === 'connection') {
        switch (record.changeType) {
          case 'create':
            if (record.data) connectionsToCreate.push(record.data as Connection);
            break;
          case 'update':
            if (record.data) connectionsToUpdate.push(record.data as Connection);
            break;
          case 'delete':
            const conn = record.data as { source: string; target: string };
            if (conn) connectionsToDelete.push({ source: conn.source, target: conn.target });
            break;
        }
      }
    }
    
    const totalChanges = 
      tasksToCreate.length + tasksToUpdate.length + taskIdsToDelete.length +
      connectionsToCreate.length + connectionsToUpdate.length + connectionsToDelete.length;
    
    return {
      projectId,
      tasksToCreate,
      tasksToUpdate,
      taskIdsToDelete,
      connectionsToCreate,
      connectionsToUpdate,
      connectionsToDelete,
      hasChanges: totalChanges > 0,
      totalChanges
    };
  }
  
  /**
   * 检查项目是否有待同步的变更
   */
  hasProjectChanges(projectId: string): boolean {
    for (const record of this.pendingChanges.values()) {
      if (record.projectId === projectId) return true;
    }
    return false;
  }
  
  /**
   * 清除项目的所有变更记录（同步成功后调用）
   */
  clearProjectChanges(projectId: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key, record] of this.pendingChanges.entries()) {
      if (record.projectId === projectId) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.pendingChanges.delete(key);
    }
    
    this.updateCounters();
    this.logger.debug('清除项目变更记录', { projectId, clearedCount: keysToDelete.length });
  }
  
  /**
   * 清除特定任务的变更记录
   */
  clearTaskChange(projectId: string, taskId: string): void {
    const key = this.makeKey(projectId, 'task', taskId);
    this.pendingChanges.delete(key);
    this.updateCounters();
  }
  
  /**
   * 清除所有变更记录（全量同步后调用）
   */
  clearAllChanges(): void {
    this.pendingChanges.clear();
    this.updateCounters();
    this.logger.debug('清除所有变更记录');
  }
  
  /**
   * 获取所有有变更的项目ID
   */
  getChangedProjectIds(): string[] {
    const projectIds = new Set<string>();
    for (const record of this.pendingChanges.values()) {
      projectIds.add(record.projectId);
    }
    return Array.from(projectIds);
  }
  
  /**
   * 导出所有待同步变更（用于调试和离线恢复）
   */
  exportPendingChanges(): ChangeRecord[] {
    return Array.from(this.pendingChanges.values());
  }
  
  /**
   * 导入变更记录（用于离线恢复）
   */
  importPendingChanges(changes: ChangeRecord[]): void {
    for (const record of changes) {
      const key = this.makeKey(record.projectId, record.entityType, record.entityId);
      this.pendingChanges.set(key, record);
    }
    this.updateCounters();
    this.logger.info('导入变更记录', { count: changes.length });
  }

  // ========== 数据完整性验证 ==========

  /**
   * 验证增量变更是否会导致数据丢失
   * 
   * 检查策略：
   * 1. 确保所有待删除的任务在当前项目中存在
   * 2. 确保所有待更新的任务在当前项目中存在
   * 3. 确保所有待创建的任务不在当前项目中
   * 4. 检查连接引用的任务是否存在
   * 
   * @param projectId 项目ID
   * @param currentTasks 当前项目的所有任务
   * @param currentConnections 当前项目的所有连接
   * @returns 验证结果和潜在问题列表
   */
  validateChanges(
    projectId: string,
    currentTasks: Task[],
    currentConnections: Connection[]
  ): {
    valid: boolean;
    warnings: string[];
    errors: string[];
    recommendations: string[];
  } {
    const warnings: string[] = [];
    const errors: string[] = [];
    const recommendations: string[] = [];

    const changes = this.getProjectChanges(projectId);
    if (!changes.hasChanges) {
      return { valid: true, warnings, errors, recommendations };
    }

    const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));
    const currentConnectionSet = new Set(
      currentConnections.map(c => `${c.source}|${c.target}`)
    );

    // 1. 验证待删除的任务
    for (const taskId of changes.taskIdsToDelete) {
      if (!currentTaskMap.has(taskId)) {
        warnings.push(
          `待删除的任务 ${taskId} 在当前项目中不存在，可能已被其他操作删除`
        );
      }
    }

    // 2. 验证待更新的任务
    for (const task of changes.tasksToUpdate) {
      if (!currentTaskMap.has(task.id)) {
        errors.push(
          `待更新的任务 ${task.id} 在当前项目中不存在，无法执行更新操作`
        );
      }
    }

    // 3. 验证待创建的任务
    for (const task of changes.tasksToCreate) {
      if (currentTaskMap.has(task.id)) {
        warnings.push(
          `待创建的任务 ${task.id} 已存在，将执行更新操作而非创建`
        );
      }
    }

    // 4. 验证连接引用的任务存在性
    const allTaskIds = new Set(currentTasks.map(t => t.id));
    
    // 添加待创建的任务ID
    for (const task of changes.tasksToCreate) {
      allTaskIds.add(task.id);
    }
    
    // 移除待删除的任务ID
    for (const taskId of changes.taskIdsToDelete) {
      allTaskIds.delete(taskId);
    }

    // 检查待创建的连接
    for (const conn of changes.connectionsToCreate) {
      if (!allTaskIds.has(conn.source)) {
        errors.push(
          `连接 ${conn.source}->${conn.target} 的源任务 ${conn.source} 不存在`
        );
      }
      if (!allTaskIds.has(conn.target)) {
        errors.push(
          `连接 ${conn.source}->${conn.target} 的目标任务 ${conn.target} 不存在`
        );
      }
    }

    // 检查待更新的连接
    for (const conn of changes.connectionsToUpdate) {
      if (!allTaskIds.has(conn.source)) {
        errors.push(
          `待更新连接 ${conn.source}->${conn.target} 的源任务 ${conn.source} 不存在`
        );
      }
      if (!allTaskIds.has(conn.target)) {
        errors.push(
          `待更新连接 ${conn.source}->${conn.target} 的目标任务 ${conn.target} 不存在`
        );
      }
    }

    // 5. 检查孤儿任务（父任务被删除但子任务未被删除）
    const deletedTaskIds = new Set(changes.taskIdsToDelete);
    for (const task of currentTasks) {
      if (task.parentId && deletedTaskIds.has(task.parentId)) {
        if (!deletedTaskIds.has(task.id)) {
          warnings.push(
            `任务 ${task.id} 的父任务 ${task.parentId} 将被删除，子任务将变为孤儿任务`
          );
          recommendations.push(
            `建议将任务 ${task.id} 一并删除，或重新指定父任务`
          );
        }
      }
    }

    // 6. 检查变更量是否异常
    const totalTasks = currentTasks.length;
    const changeRatio = changes.totalChanges / Math.max(totalTasks, 1);
    
    if (changeRatio > 0.8 && totalTasks > 20) {
      recommendations.push(
        `变更比例过高 (${(changeRatio * 100).toFixed(1)}%)，建议考虑使用全量同步以提高可靠性`
      );
    }

    const valid = errors.length === 0;

    if (!valid) {
      this.logger.error('变更验证失败', {
        projectId,
        errors,
        warnings,
        changes: changes.totalChanges
      });
    } else if (warnings.length > 0) {
      this.logger.warn('变更验证通过但有警告', {
        projectId,
        warnings,
        changes: changes.totalChanges
      });
    }

    return { valid, warnings, errors, recommendations };
  }

  /**
   * 生成变更摘要报告（用于日志和调试）
   */
  generateChangeReport(projectId: string): string {
    const changes = this.getProjectChanges(projectId);
    
    if (!changes.hasChanges) {
      return `项目 ${projectId}: 无待同步变更`;
    }

    const lines: string[] = [
      `项目 ${projectId} 变更摘要:`,
      `  总变更数: ${changes.totalChanges}`,
      ``,
      `  任务变更:`,
      `    - 待创建: ${changes.tasksToCreate.length}`,
      `    - 待更新: ${changes.tasksToUpdate.length}`,
      `    - 待删除: ${changes.taskIdsToDelete.length}`,
      ``,
      `  连接变更:`,
      `    - 待创建: ${changes.connectionsToCreate.length}`,
      `    - 待更新: ${changes.connectionsToUpdate.length}`,
      `    - 待删除: ${changes.connectionsToDelete.length}`
    ];

    if (changes.tasksToCreate.length > 0) {
      lines.push(``, `  待创建任务ID: ${changes.tasksToCreate.map(t => t.id).join(', ')}`);
    }

    if (changes.taskIdsToDelete.length > 0) {
      lines.push(``, `  待删除任务ID: ${changes.taskIdsToDelete.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * 检测潜在的数据丢失风险
   */
  detectDataLossRisks(
    projectId: string,
    currentTasks: Task[],
    currentConnections: Connection[]
  ): {
    hasRisk: boolean;
    risks: Array<{
      type: 'task-missing' | 'connection-orphan' | 'parent-child-inconsistency' | 'duplicate-operation';
      severity: 'low' | 'medium' | 'high';
      description: string;
      affectedEntities: string[];
    }>;
  } {
    const risks: Array<{
      type: 'task-missing' | 'connection-orphan' | 'parent-child-inconsistency' | 'duplicate-operation';
      severity: 'low' | 'medium' | 'high';
      description: string;
      affectedEntities: string[];
    }> = [];

    const changes = this.getProjectChanges(projectId);
    const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));

    // 检测1: 更新不存在的任务（高风险）
    const missingTasks = changes.tasksToUpdate.filter(t => !currentTaskMap.has(t.id));
    if (missingTasks.length > 0) {
      risks.push({
        type: 'task-missing',
        severity: 'high',
        description: '尝试更新不存在的任务，可能导致数据丢失',
        affectedEntities: missingTasks.map(t => t.id)
      });
    }

    // 检测2: 连接引用的任务被删除（中风险）
    const deletedTaskIds = new Set(changes.taskIdsToDelete);
    const orphanConnections = currentConnections.filter(
      c => deletedTaskIds.has(c.source) || deletedTaskIds.has(c.target)
    );
    if (orphanConnections.length > 0) {
      risks.push({
        type: 'connection-orphan',
        severity: 'medium',
        description: '任务删除后关联的连接将变为孤儿连接',
        affectedEntities: orphanConnections.map(c => `${c.source}->${c.target}`)
      });
    }

    // 检测3: 父子任务不一致（中风险）
    const childTasksOfDeletedParents: string[] = [];
    for (const task of currentTasks) {
      if (task.parentId && deletedTaskIds.has(task.parentId) && !deletedTaskIds.has(task.id)) {
        childTasksOfDeletedParents.push(task.id);
      }
    }
    if (childTasksOfDeletedParents.length > 0) {
      risks.push({
        type: 'parent-child-inconsistency',
        severity: 'medium',
        description: '父任务被删除但子任务保留，可能破坏层级结构',
        affectedEntities: childTasksOfDeletedParents
      });
    }

    // 检测4: 重复操作（低风险但需要注意）
    const duplicateCreates = changes.tasksToCreate.filter(t => currentTaskMap.has(t.id));
    if (duplicateCreates.length > 0) {
      risks.push({
        type: 'duplicate-operation',
        severity: 'low',
        description: '尝试创建已存在的任务，将自动转为更新操作',
        affectedEntities: duplicateCreates.map(t => t.id)
      });
    }

    const hasRisk = risks.some(r => r.severity === 'high' || r.severity === 'medium');

    if (hasRisk) {
      this.logger.warn('检测到数据丢失风险', {
        projectId,
        riskCount: risks.length,
        highRisks: risks.filter(r => r.severity === 'high').length,
        mediumRisks: risks.filter(r => r.severity === 'medium').length
      });
    }

    return { hasRisk, risks };
  }
  
  // ========== 辅助方法 ==========
  
  // ========== 字段级操作锁 ==========
  
  /**
   * 锁定任务的特定字段
   * 当用户开始操作（如点击状态复选框、开始拖拽）时调用
   * 
   * @param taskId 任务ID
   * @param projectId 项目ID  
   * @param field 要锁定的字段名（如 'status', 'rank', 'stage'）
   */
  lockTaskField(taskId: string, projectId: string, field: string): void {
    const key = this.makeFieldLockKey(projectId, taskId, field);
    this.fieldLocks.set(key, Date.now());
    this.logger.debug('锁定任务字段', { taskId, projectId, field });
  }
  
  /**
   * 解锁任务的特定字段
   * 当操作完成并收到服务器 ACK 时调用
   * 
   * @param taskId 任务ID
   * @param projectId 项目ID
   * @param field 要解锁的字段名
   */
  unlockTaskField(taskId: string, projectId: string, field: string): void {
    const key = this.makeFieldLockKey(projectId, taskId, field);
    this.fieldLocks.delete(key);
    this.logger.debug('解锁任务字段', { taskId, projectId, field });
  }
  
  /**
   * 解锁任务的所有字段
   * 当同步成功后批量清理锁
   * 
   * @param taskId 任务ID
   * @param projectId 项目ID
   */
  unlockAllTaskFields(taskId: string, projectId: string): void {
    const prefix = `${projectId}:${taskId}:`;
    const keysToDelete: string[] = [];
    for (const key of this.fieldLocks.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.fieldLocks.delete(key);
    }
    if (keysToDelete.length > 0) {
      this.logger.debug('解锁任务所有字段', { taskId, projectId, fieldCount: keysToDelete.length });
    }
  }
  
  /**
   * 检查任务的特定字段是否被锁定
   * 远程变更处理器在更新字段前应检查此方法
   * 
   * @param taskId 任务ID
   * @param projectId 项目ID
   * @param field 字段名
   * @returns 是否被锁定（考虑超时自动解锁）
   */
  isTaskFieldLocked(taskId: string, projectId: string, field: string): boolean {
    const key = this.makeFieldLockKey(projectId, taskId, field);
    const lockTime = this.fieldLocks.get(key);
    
    if (!lockTime) {
      return false;
    }
    
    // 检查是否超时（防止死锁）
    const elapsed = Date.now() - lockTime;
    if (elapsed > ChangeTrackerService.FIELD_LOCK_TIMEOUT_MS) {
      this.fieldLocks.delete(key);
      this.logger.warn('字段锁超时自动解锁', { taskId, projectId, field, elapsed });
      return false;
    }
    
    return true;
  }
  
  /**
   * 获取任务被锁定的字段列表
   * 
   * @param taskId 任务ID
   * @param projectId 项目ID
   * @returns 被锁定的字段名列表
   */
  getLockedFields(taskId: string, projectId: string): string[] {
    const prefix = `${projectId}:${taskId}:`;
    const lockedFields: string[] = [];
    const now = Date.now();
    
    for (const [key, lockTime] of this.fieldLocks.entries()) {
      if (key.startsWith(prefix)) {
        // 检查超时
        if (now - lockTime <= ChangeTrackerService.FIELD_LOCK_TIMEOUT_MS) {
          const field = key.substring(prefix.length);
          lockedFields.push(field);
        } else {
          // 清理过期锁
          this.fieldLocks.delete(key);
        }
      }
    }
    
    return lockedFields;
  }
  
  /**
   * 清理所有项目的字段锁（用于同步完成后的清理）
   * 
   * @param projectId 项目ID
   */
  clearProjectFieldLocks(projectId: string): void {
    const prefix = `${projectId}:`;
    const keysToDelete: string[] = [];
    for (const key of this.fieldLocks.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.fieldLocks.delete(key);
    }
    if (keysToDelete.length > 0) {
      this.logger.debug('清理项目字段锁', { projectId, lockCount: keysToDelete.length });
    }
  }
  
  private makeFieldLockKey(projectId: string, taskId: string, field: string): string {
    return `${projectId}:${taskId}:${field}`;
  }
  
  // ========== 其他辅助方法 ==========
  
  private makeKey(projectId: string, entityType: EntityType, entityId: string): string {
    return `${projectId}:${entityType}:${entityId}`;
  }
  
  private makeConnectionId(source: string, target: string): string {
    return `${source}|${target}`;
  }
  
  private parseConnectionId(connectionId: string): { source: string; target: string } {
    const [source, target] = connectionId.split('|');
    return { source, target };
  }
  
  private mergeFields(existing?: string[], added?: string[]): string[] | undefined {
    if (!existing && !added) return undefined;
    const set = new Set<string>([...(existing || []), ...(added || [])]);
    return Array.from(set);
  }
  
  private updateCounters(): void {
    this.changeCount.set(this.pendingChanges.size);
    this.lastChangeAt.set(Date.now());
  }
}
