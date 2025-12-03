/**
 * OptimisticStateService - 乐观更新状态管理服务
 * 
 * 【设计理念】
 * 实现"快照恢复（Snapshot Revert）"策略，而非针对每个操作的"反向逻辑"。
 * 
 * 乐观更新（Optimistic UI）本质上是在"欺骗"用户："放心，已经搞定了。"
 * 如果后台随后报错，而 UI 没有回滚，这种欺骗就变成了背叛。
 * 
 * 快照恢复策略优势：
 * - 不需要编写每个操作的"反向逻辑"（如：添加失败就删除）
 * - 一旦失败，整体替换回旧快照，不在乎是改了标题还是加了标签
 * - 比"逻辑回退"健壮得多，易于维护
 * 
 * 【使用方式】
 * ```typescript
 * // 1. 执行乐观操作前创建快照
 * const snapshot = this.optimisticState.createSnapshot('task-update', '更新任务');
 * 
 * // 2. 立即应用乐观更新
 * this.projectState.updateProjects(mutator);
 * 
 * // 3. 异步操作
 * try {
 *   await this.syncService.saveToCloud(data);
 *   // 成功：丢弃快照
 *   this.optimisticState.commitSnapshot(snapshot.id);
 * } catch (error) {
 *   // 失败：回滚到快照
 *   this.optimisticState.rollbackSnapshot(snapshot.id);
 *   this.toastService.error('操作失败', error.message);
 * }
 * ```
 * 
 * 【ID 漂移（ID Swapping）处理】
 * 当离线或乐观状态下创建新任务时，会生成临时 ID（temp-xxx）。
 * 服务器返回正式 ID 后，需要级联更新所有引用该临时 ID 的位置：
 * - 任务本身的 id
 * - 子任务的 parentId
 * - 连接线的 sourceId/targetId
 * - 附件的 taskId
 * 
 * ```typescript
 * // 创建任务时注册临时 ID
 * const tempId = this.optimisticState.generateTempId();
 * 
 * // 服务器返回后替换
 * this.optimisticState.swapId(tempId, serverAssignedId);
 * ```
 * 
 * 【职责边界】
 * ✓ 创建操作前的状态快照
 * ✓ 操作成功后提交（丢弃快照）
 * ✓ 操作失败后回滚（恢复快照）
 * ✓ 快照超时自动清理（防止内存泄漏）
 * ✓ 临时 ID 生成与漂移处理
 * ✗ 实际的状态更新 → ProjectStateService
 * ✗ 数据同步 → SyncCoordinatorService
 */
import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { OPTIMISTIC_CONFIG } from '../config/constants';

/**
 * 快照类型
 */
export type SnapshotType = 
  | 'project-create' 
  | 'project-delete' 
  | 'project-update'
  | 'task-create'
  | 'task-update'
  | 'task-delete'
  | 'task-move'
  | 'connection-create'
  | 'connection-delete';

/**
 * 快照数据结构
 */
export interface OptimisticSnapshot {
  /** 快照唯一 ID */
  id: string;
  /** 快照类型 */
  type: SnapshotType;
  /** 创建时间戳 */
  createdAt: number;
  /** 项目快照（深拷贝） */
  projectsSnapshot: Project[];
  /** 当前活动项目 ID */
  activeProjectId: string | null;
  /** 操作描述（用于 toast 显示） */
  operationLabel?: string;
  /** 关联的临时 ID（用于 ID 漂移追踪） */
  tempId?: string;
}

/**
 * ID 映射记录 - 用于追踪临时 ID 到正式 ID 的映射
 */
export interface IdMapping {
  /** 临时 ID */
  tempId: string;
  /** 正式 ID（服务器分配） */
  permanentId: string | null;
  /** 创建时间 */
  createdAt: number;
  /** 实体类型 */
  entityType: 'task' | 'project' | 'connection';
}

/**
 * 乐观操作配置选项
 */
export interface OptimisticActionOptions {
  /** 快照类型 */
  type: SnapshotType;
  /** 操作描述（用于失败时的 toast） */
  label?: string;
  /** 关联的临时 ID（用于创建操作） */
  tempId?: string;
  /** 失败时是否显示 toast（默认 true） */
  showToastOnError?: boolean;
}

/**
 * 乐观操作结果类型
 */
export type OptimisticActionResult<T> = 
  | { success: true; value: T; rolledBack: false }
  | { success: false; error: Error; rolledBack: boolean };

/**
 * 临时 ID 前缀
 */
const TEMP_ID_PREFIX = OPTIMISTIC_CONFIG.TEMP_ID_PREFIX;

/**
 * 快照配置 - 使用集中化常量
 */
const SNAPSHOT_CONFIG = {
  /** 快照最大保留时间（毫秒） - 5 分钟 */
  MAX_AGE_MS: OPTIMISTIC_CONFIG.SNAPSHOT_MAX_AGE_MS,
  /** 最大快照数量 */
  MAX_SNAPSHOTS: OPTIMISTIC_CONFIG.MAX_SNAPSHOTS,
  /** 清理检查间隔（毫秒） */
  CLEANUP_INTERVAL_MS: OPTIMISTIC_CONFIG.CLEANUP_INTERVAL_MS,
  /** ID 映射最大保留时间（毫秒） - 1 小时 */
  ID_MAPPING_MAX_AGE_MS: OPTIMISTIC_CONFIG.ID_MAPPING_MAX_AGE_MS
};

@Injectable({
  providedIn: 'root'
})
export class OptimisticStateService {
  private readonly logger = inject(LoggerService).category('OptimisticState');
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  
  /** 快照存储 */
  private snapshots = new Map<string, OptimisticSnapshot>();
  
  /** ID 映射存储 - 临时 ID -> 正式 ID */
  private idMappings = new Map<string, IdMapping>();
  
  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 活跃快照数量（用于调试） */
  readonly activeSnapshotCount = signal(0);
  
  /** 待处理的 ID 映射数量（用于调试） */
  readonly pendingIdMappingCount = signal(0);
  
  constructor() {
    // 启动定期清理
    this.startCleanupTimer();
    
    // 销毁时清理
    this.destroyRef.onDestroy(() => {
      this.stopCleanupTimer();
      this.snapshots.clear();
      this.idMappings.clear();
    });
  }
  
  // ========== 临时 ID 管理 ==========
  
  /**
   * 生成临时 ID
   * 用于乐观创建任务时立即分配一个本地 ID
   * 
   * @param entityType 实体类型
   * @returns 临时 ID（格式：temp-{uuid}）
   */
  generateTempId(entityType: 'task' | 'project' | 'connection' = 'task'): string {
    const tempId = `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
    
    // 注册到 ID 映射表
    this.idMappings.set(tempId, {
      tempId,
      permanentId: null,
      createdAt: Date.now(),
      entityType
    });
    
    this.updateIdMappingCount();
    this.logger.debug('生成临时 ID', { tempId, entityType });
    
    return tempId;
  }
  
  /**
   * 检查是否为临时 ID
   */
  isTempId(id: string): boolean {
    return id.startsWith(TEMP_ID_PREFIX);
  }
  
  /**
   * ID 漂移：将临时 ID 替换为正式 ID
   * 级联更新所有引用该临时 ID 的位置
   * 
   * @param tempId 临时 ID
   * @param permanentId 服务器分配的正式 ID
   * @returns 是否成功替换
   */
  swapId(tempId: string, permanentId: string): boolean {
    const mapping = this.idMappings.get(tempId);
    if (!mapping) {
      this.logger.warn('尝试替换未注册的临时 ID', { tempId, permanentId });
      return false;
    }
    
    // 更新映射
    mapping.permanentId = permanentId;
    
    // 级联更新项目状态中的所有引用
    this.cascadeIdSwap(tempId, permanentId, mapping.entityType);
    
    this.logger.info('ID 漂移完成', { tempId, permanentId, entityType: mapping.entityType });
    
    return true;
  }
  
  /**
   * 获取正式 ID（如果已映射）
   * 用于在发送请求时将临时 ID 转换为正式 ID
   */
  resolveTempId(id: string): string {
    if (!this.isTempId(id)) return id;
    
    const mapping = this.idMappings.get(id);
    return mapping?.permanentId ?? id;
  }
  
  /**
   * 批量解析临时 ID
   */
  resolveTempIds(ids: string[]): string[] {
    return ids.map(id => this.resolveTempId(id));
  }
  
  /**
   * 级联更新所有引用临时 ID 的位置
   */
  private cascadeIdSwap(tempId: string, permanentId: string, entityType: 'task' | 'project' | 'connection'): void {
    this.projectState.updateProjects(projects => 
      projects.map(project => this.swapIdInProject(project, tempId, permanentId, entityType))
    );
  }
  
  /**
   * 在项目中替换 ID
   */
  private swapIdInProject(project: Project, tempId: string, permanentId: string, entityType: string): Project {
    let modified = false;
    
    // 替换任务中的 ID
    const newTasks = project.tasks.map(task => {
      let taskModified = false;
      const newTask = { ...task };
      
      // 任务本身的 ID
      if (entityType === 'task' && task.id === tempId) {
        newTask.id = permanentId;
        taskModified = true;
      }
      
      // 父任务 ID
      if (task.parentId === tempId) {
        newTask.parentId = permanentId;
        taskModified = true;
      }
      
      return taskModified ? newTask : task;
    });
    
    if (newTasks.some((t, i) => t !== project.tasks[i])) {
      modified = true;
    }
    
    // 替换连接中的 ID
    const newConnections = project.connections?.map(conn => {
      if (conn.source === tempId || conn.target === tempId) {
        modified = true;
        return {
          ...conn,
          source: conn.source === tempId ? permanentId : conn.source,
          target: conn.target === tempId ? permanentId : conn.target
        };
      }
      return conn;
    });
    
    if (modified) {
      return {
        ...project,
        tasks: newTasks,
        connections: newConnections ?? project.connections
      };
    }
    
    return project;
  }
  
  /**
   * 清理已完成的 ID 映射
   */
  cleanupCompletedIdMappings(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    
    for (const [tempId, mapping] of this.idMappings) {
      // 已映射的 ID 保留一段时间后清理
      if (mapping.permanentId && (now - mapping.createdAt > SNAPSHOT_CONFIG.ID_MAPPING_MAX_AGE_MS)) {
        toDelete.push(tempId);
      }
    }
    
    for (const id of toDelete) {
      this.idMappings.delete(id);
    }
    
    if (toDelete.length > 0) {
      this.updateIdMappingCount();
      this.logger.debug('清理已完成的 ID 映射', { count: toDelete.length });
    }
  }
  
  /**
   * 创建操作前的状态快照
   * 在执行乐观更新之前调用
   * 
   * @param type 快照类型
   * @param operationLabel 操作描述（用于失败时的 toast）
   * @param tempId 关联的临时 ID（可选，用于创建操作）
   * @returns 快照对象
   */
  createSnapshot(type: SnapshotType, operationLabel?: string, tempId?: string): OptimisticSnapshot {
    const id = crypto.randomUUID();
    const now = Date.now();
    
    // 深拷贝当前项目状态
    const projectsSnapshot = this.deepCloneProjects(this.projectState.projects());
    const activeProjectId = this.projectState.activeProjectId();
    
    const snapshot: OptimisticSnapshot = {
      id,
      type,
      createdAt: now,
      projectsSnapshot,
      activeProjectId,
      operationLabel,
      tempId
    };
    
    // 存储快照
    this.snapshots.set(id, snapshot);
    this.updateSnapshotCount();
    
    // 检查是否超过最大数量
    if (this.snapshots.size > SNAPSHOT_CONFIG.MAX_SNAPSHOTS) {
      this.evictOldestSnapshot();
    }
    
    this.logger.debug('创建快照', { id, type, operationLabel, tempId });
    
    return snapshot;
  }
  
  /**
   * 为任务操作创建快照的便捷方法
   * 
   * @param taskId 任务 ID
   * @param operationType 操作类型描述
   * @returns 快照对象
   */
  createTaskSnapshot(taskId: string, operationType: '创建' | '更新' | '删除' | '移动'): OptimisticSnapshot {
    const typeMap: Record<string, SnapshotType> = {
      '创建': 'task-create',
      '更新': 'task-update',
      '删除': 'task-delete',
      '移动': 'task-move'
    };
    
    return this.createSnapshot(
      typeMap[operationType] || 'task-update',
      `${operationType}任务`,
      this.isTempId(taskId) ? taskId : undefined
    );
  }
  
  /**
   * 提交快照（操作成功，丢弃快照）
   * 
   * @param snapshotId 快照 ID
   */
  commitSnapshot(snapshotId: string): void {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot) {
      this.snapshots.delete(snapshotId);
      this.updateSnapshotCount();
      this.logger.debug('提交快照（成功）', { id: snapshotId, type: snapshot.type });
    }
  }
  
  /**
   * 回滚到快照（操作失败，恢复状态）
   * 
   * @param snapshotId 快照 ID
   * @param showToast 是否显示 toast 提示（默认 true）
   * @returns 是否成功回滚
   */
  rollbackSnapshot(snapshotId: string, showToast = true): boolean {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      this.logger.warn('快照不存在，无法回滚', { snapshotId });
      return false;
    }
    
    // 恢复项目状态
    this.projectState.setProjects(snapshot.projectsSnapshot);
    
    // 恢复活动项目
    if (snapshot.activeProjectId) {
      this.projectState.setActiveProjectId(snapshot.activeProjectId);
    }
    
    // 清理关联的临时 ID 映射
    if (snapshot.tempId) {
      this.idMappings.delete(snapshot.tempId);
      this.updateIdMappingCount();
    }
    
    // 删除快照
    this.snapshots.delete(snapshotId);
    this.updateSnapshotCount();
    
    this.logger.info('回滚快照', { id: snapshotId, type: snapshot.type });
    
    // 显示 toast
    if (showToast && snapshot.operationLabel) {
      this.toastService.error('操作失败', `${snapshot.operationLabel}失败，已恢复到之前的状态`);
    }
    
    return true;
  }
  
  /**
   * 检查快照是否存在
   */
  hasSnapshot(snapshotId: string): boolean {
    return this.snapshots.has(snapshotId);
  }
  
  /**
   * 手动丢弃快照（不做任何操作）
   */
  discardSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    this.updateSnapshotCount();
  }
  
  /**
   * 清除所有快照（用于登出或测试）
   */
  clearAllSnapshots(): void {
    this.snapshots.clear();
    this.updateSnapshotCount();
    this.logger.debug('清除所有快照');
  }
  
  /**
   * 用户登出时调用
   */
  onUserLogout(): void {
    this.clearAllSnapshots();
    this.idMappings.clear();
    this.updateIdMappingCount();
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 深拷贝项目数组
   * 使用 structuredClone 进行深拷贝，确保快照完全独立
   */
  private deepCloneProjects(projects: Project[]): Project[] {
    try {
      return structuredClone(projects);
    } catch (e) {
      // fallback：JSON 序列化方式
      this.logger.warn('structuredClone 失败，使用 JSON 方式', e);
      return JSON.parse(JSON.stringify(projects));
    }
  }
  
  /**
   * 更新活跃快照计数
   */
  private updateSnapshotCount(): void {
    this.activeSnapshotCount.set(this.snapshots.size);
  }
  
  /**
   * 更新 ID 映射计数
   */
  private updateIdMappingCount(): void {
    this.pendingIdMappingCount.set(this.idMappings.size);
  }
  
  /**
   * 驱逐最旧的快照
   */
  private evictOldestSnapshot(): void {
    let oldest: { id: string; createdAt: number } | null = null;
    
    for (const [id, snapshot] of this.snapshots) {
      if (!oldest || snapshot.createdAt < oldest.createdAt) {
        oldest = { id, createdAt: snapshot.createdAt };
      }
    }
    
    if (oldest) {
      this.snapshots.delete(oldest.id);
      this.logger.debug('驱逐最旧快照', { id: oldest.id });
    }
  }
  
  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSnapshots();
    }, SNAPSHOT_CONFIG.CLEANUP_INTERVAL_MS);
  }
  
  /**
   * 停止清理定时器
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
  
  /**
   * 清理过期的快照
   */
  private cleanupExpiredSnapshots(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    
    for (const [id, snapshot] of this.snapshots) {
      if (now - snapshot.createdAt > SNAPSHOT_CONFIG.MAX_AGE_MS) {
        expiredIds.push(id);
      }
    }
    
    for (const id of expiredIds) {
      this.snapshots.delete(id);
      this.logger.debug('清理过期快照', { id });
    }
    
    if (expiredIds.length > 0) {
      this.updateSnapshotCount();
    }
    
    // 同时清理过期的 ID 映射
    this.cleanupCompletedIdMappings();
  }
  
  // ========== 测试/HMR 支持 ==========
  
  /**
   * 重置服务状态
   */
  reset(): void {
    this.clearAllSnapshots();
    this.idMappings.clear();
    this.updateIdMappingCount();
    this.stopCleanupTimer();
    this.startCleanupTimer();
  }
  
/**
   * 获取当前所有待处理的临时 ID（用于调试）
   */
  getPendingTempIds(): string[] {
    const pending: string[] = [];
    for (const [tempId, mapping] of this.idMappings) {
      if (!mapping.permanentId) {
        pending.push(tempId);
      }
    }
    return pending;
  }
  
  // ========== 乐观操作高阶函数 ==========
  
  /**
   * 运行乐观操作 - 防呆设计的高阶函数
   * 
   * 【设计理念】
   * 这是一个"机制保证配对"的函数，使用 try-finally 强制执行：
   * 1. 操作前自动创建快照
   * 2. 执行乐观更新
   * 3. 执行异步操作
   * 4. 成功时自动 commit，失败时自动 rollback
   * 
   * 业务代码只需关注"做什么"，不再需要关心"怎么保护现场"。
   * 
   * 【使用示例】
   * ```typescript
   * // 旧写法（容易遗漏 commit/rollback）：
   * const snapshot = this.optimisticState.createSnapshot('task-update', '更新任务');
   * this.projectState.updateProjects(mutator);
   * try {
   *   await this.syncService.saveToCloud(data);
   *   this.optimisticState.commitSnapshot(snapshot.id);  // 容易忘记！
   * } catch (error) {
   *   this.optimisticState.rollbackSnapshot(snapshot.id); // 容易忘记！
   *   throw error;
   * }
   * 
   * // 新写法（机制保证配对）：
   * await this.optimisticState.runOptimisticAction(
   *   { type: 'task-update', label: '更新任务' },
   *   () => this.projectState.updateProjects(mutator),
   *   () => this.syncService.saveToCloud(data)
   * );
   * ```
   * 
   * @param options 配置选项
   * @param optimisticUpdate 同步的乐观更新函数
   * @param asyncAction 异步操作函数（网络请求等）
   * @returns 包含成功/失败状态和结果的对象
   */
  async runOptimisticAction<T>(
    options: OptimisticActionOptions,
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<{ success: true; value: T; rolledBack: false } | { success: false; error: Error; rolledBack: boolean }> {
    const { type, label, tempId, showToastOnError = true } = options;
    
    // 1. 创建快照（操作前）
    const snapshot = this.createSnapshot(type, label, tempId);
    
    // 2. 执行乐观更新（同步）
    try {
      optimisticUpdate();
    } catch (updateError) {
      // 乐观更新本身失败，丢弃快照（因为状态未改变）
      this.discardSnapshot(snapshot.id);
      const error = updateError instanceof Error ? updateError : new Error(String(updateError));
      this.logger.error('乐观更新执行失败', { type, error: error.message });
      return { success: false, error, rolledBack: false };
    }
    
    // 3. 执行异步操作，使用 try-finally 保证配对
    try {
      const result = await asyncAction();
      // 成功：提交快照（丢弃）
      this.commitSnapshot(snapshot.id);
      this.logger.debug('乐观操作成功', { type, label });
      return { success: true, value: result, rolledBack: false };
    } catch (asyncError) {
      // 失败：回滚快照
      const rolledBack = this.rollbackSnapshot(snapshot.id, showToastOnError);
      const error = asyncError instanceof Error ? asyncError : new Error(String(asyncError));
      this.logger.warn('乐观操作失败，已回滚', { type, label, error: error.message, rolledBack });
      return { success: false, error, rolledBack };
    }
  }
  
  /**
   * 运行乐观任务操作 - 针对任务操作的便捷包装
   * 
   * @param taskId 任务 ID
   * @param operationType 操作类型
   * @param optimisticUpdate 同步的乐观更新函数
   * @param asyncAction 异步操作函数
   */
  async runOptimisticTaskAction<T>(
    taskId: string,
    operationType: '创建' | '更新' | '删除' | '移动',
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<{ success: true; value: T; rolledBack: false } | { success: false; error: Error; rolledBack: boolean }> {
    const typeMap: Record<string, SnapshotType> = {
      '创建': 'task-create',
      '更新': 'task-update',
      '删除': 'task-delete',
      '移动': 'task-move'
    };
    
    return this.runOptimisticAction(
      {
        type: typeMap[operationType] || 'task-update',
        label: `${operationType}任务`,
        tempId: this.isTempId(taskId) ? taskId : undefined
      },
      optimisticUpdate,
      asyncAction
    );
  }
  
  /**
   * 运行乐观项目操作 - 针对项目操作的便捷包装
   * 
   * @param projectId 项目 ID
   * @param operationType 操作类型
   * @param optimisticUpdate 同步的乐观更新函数
   * @param asyncAction 异步操作函数
   */
  async runOptimisticProjectAction<T>(
    projectId: string,
    operationType: '创建' | '更新' | '删除',
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<{ success: true; value: T; rolledBack: false } | { success: false; error: Error; rolledBack: boolean }> {
    const typeMap: Record<string, SnapshotType> = {
      '创建': 'project-create',
      '更新': 'project-update',
      '删除': 'project-delete'
    };
    
    return this.runOptimisticAction(
      {
        type: typeMap[operationType] || 'project-update',
        label: `${operationType}项目`,
        tempId: this.isTempId(projectId) ? projectId : undefined
      },
      optimisticUpdate,
      asyncAction
    );
  }
}