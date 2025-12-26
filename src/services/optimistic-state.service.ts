/**
 * OptimisticStateService - 乐观更新状态管理服务（简化版）
 * 
 * 【设计理念】
 * 实现"快照恢复（Snapshot Revert）"策略。
 * 
 * 乐观更新（Optimistic UI）本质上是在"欺骗"用户："放心，已经搞定了。"
 * 如果后台随后报错，而 UI 没有回滚，这种欺骗就变成了背叛。
 * 
 * 快照恢复策略优势：
 * - 不需要编写每个操作的"反向逻辑"
 * - 一旦失败，整体替换回旧快照
 * - 比"逻辑回退"健壮得多，易于维护
 * 
 * 【重构说明】
 * 已移除临时 ID（temp-）机制。
 * 新策略：所有实体在客户端创建时直接使用 crypto.randomUUID() 生成永久 ID。
 * 好处：离线创建的数据可以直接关联，同步时无需 ID 转换。
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
 *   this.optimisticState.commitSnapshot(snapshot.id);
 * } catch (error) {
 *   this.optimisticState.rollbackSnapshot(snapshot.id);
 * }
 * ```
 * 
 * 【职责边界】
 * ✓ 创建操作前的状态快照
 * ✓ 操作成功后提交（丢弃快照）
 * ✓ 操作失败后回滚（恢复快照）
 * ✓ 快照超时自动清理（防止内存泄漏）
 * ✗ 实际的状态更新 → ProjectStateService
 * ✗ 数据同步 → SyncCoordinatorService
 */
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { OPTIMISTIC_CONFIG } from '../config';
import { Project } from '../models';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';

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
}

/**
 * 乐观操作配置选项
 */
export interface OptimisticActionOptions {
  /** 快照类型 */
  type: SnapshotType;
  /** 操作描述（用于失败时的 toast） */
  label?: string;
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
 * 快照配置 - 使用集中化常量
 */
const SNAPSHOT_CONFIG = {
  MAX_AGE_MS: OPTIMISTIC_CONFIG.SNAPSHOT_MAX_AGE_MS,
  MAX_SNAPSHOTS: OPTIMISTIC_CONFIG.MAX_SNAPSHOTS,
  CLEANUP_INTERVAL_MS: OPTIMISTIC_CONFIG.CLEANUP_INTERVAL_MS,
};

@Injectable({
  providedIn: 'root'
})
export class OptimisticStateService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('OptimisticState');
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  
  /** 快照存储 */
  private snapshots = new Map<string, OptimisticSnapshot>();
  
  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 活跃快照数量（用于调试） */
  readonly activeSnapshotCount = signal(0);
  
  constructor() {
    this.startCleanupTimer();
    
    this.destroyRef.onDestroy(() => {
      this.stopCleanupTimer();
      this.snapshots.clear();
    });
  }
  
  // ========== 快照管理 ==========
  
  /**
   * 创建操作前的状态快照
   */
  createSnapshot(type: SnapshotType, operationLabel?: string): OptimisticSnapshot {
    const id = crypto.randomUUID();
    const now = Date.now();
    
    const projectsSnapshot = this.deepCloneProjects(this.projectState.projects());
    const activeProjectId = this.projectState.activeProjectId();
    
    const snapshot: OptimisticSnapshot = {
      id,
      type,
      createdAt: now,
      projectsSnapshot,
      activeProjectId,
      operationLabel
    };
    
    this.snapshots.set(id, snapshot);
    this.updateSnapshotCount();
    
    if (this.snapshots.size > SNAPSHOT_CONFIG.MAX_SNAPSHOTS) {
      this.evictOldestSnapshot();
    }
    
    this.logger.debug('创建快照', { id, type, operationLabel });
    
    return snapshot;
  }
  
  /**
   * 为任务操作创建快照的便捷方法
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
      `${operationType}任务`
    );
  }
  
  /**
   * 提交快照（操作成功，丢弃快照）
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
   */
  rollbackSnapshot(snapshotId: string, showToast = true): boolean {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      this.logger.warn('快照不存在，无法回滚', { snapshotId });
      return false;
    }
    
    this.projectState.setProjects(snapshot.projectsSnapshot);
    
    if (snapshot.activeProjectId) {
      this.projectState.setActiveProjectId(snapshot.activeProjectId);
    }
    
    this.snapshots.delete(snapshotId);
    this.updateSnapshotCount();
    
    this.logger.info('回滚快照', { id: snapshotId, type: snapshot.type });
    
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
  }
  
  // ========== 乐观操作高阶函数 ==========
  
  /**
   * 运行乐观操作 - 防呆设计的高阶函数
   * 
   * 使用 try-finally 强制执行快照的 commit/rollback。
   * 业务代码只需关注"做什么"，不再需要关心"怎么保护现场"。
   */
  async runOptimisticAction<T>(
    options: OptimisticActionOptions,
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<OptimisticActionResult<T>> {
    const { type, label, showToastOnError = true } = options;
    
    const snapshot = this.createSnapshot(type, label);
    
    try {
      optimisticUpdate();
    } catch (updateError) {
      this.discardSnapshot(snapshot.id);
      const error = updateError instanceof Error ? updateError : new Error(String(updateError));
      this.logger.error('乐观更新执行失败', { type, error: error.message });
      return { success: false, error, rolledBack: false };
    }
    
    try {
      const result = await asyncAction();
      this.commitSnapshot(snapshot.id);
      this.logger.debug('乐观操作成功', { type, label });
      return { success: true, value: result, rolledBack: false };
    } catch (asyncError) {
      const rolledBack = this.rollbackSnapshot(snapshot.id, showToastOnError);
      const error = asyncError instanceof Error ? asyncError : new Error(String(asyncError));
      this.logger.warn('乐观操作失败，已回滚', { type, label, error: error.message, rolledBack });
      return { success: false, error, rolledBack };
    }
  }
  
  /**
   * 运行乐观任务操作
   */
  async runOptimisticTaskAction<T>(
    taskId: string,
    operationType: '创建' | '更新' | '删除' | '移动',
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<OptimisticActionResult<T>> {
    const typeMap: Record<string, SnapshotType> = {
      '创建': 'task-create',
      '更新': 'task-update',
      '删除': 'task-delete',
      '移动': 'task-move'
    };
    
    return this.runOptimisticAction(
      { type: typeMap[operationType] || 'task-update', label: `${operationType}任务` },
      optimisticUpdate,
      asyncAction
    );
  }
  
  /**
   * 运行乐观项目操作
   */
  async runOptimisticProjectAction<T>(
    projectId: string,
    operationType: '创建' | '更新' | '删除',
    optimisticUpdate: () => void,
    asyncAction: () => Promise<T>
  ): Promise<OptimisticActionResult<T>> {
    const typeMap: Record<string, SnapshotType> = {
      '创建': 'project-create',
      '更新': 'project-update',
      '删除': 'project-delete'
    };
    
    return this.runOptimisticAction(
      { type: typeMap[operationType] || 'project-update', label: `${operationType}项目` },
      optimisticUpdate,
      asyncAction
    );
  }
  
  // ========== 私有方法 ==========
  
  private deepCloneProjects(projects: Project[]): Project[] {
    try {
      return structuredClone(projects);
    } catch {
      this.logger.warn('structuredClone 失败，使用 JSON 方式');
      return JSON.parse(JSON.stringify(projects));
    }
  }
  
  private updateSnapshotCount(): void {
    this.activeSnapshotCount.set(this.snapshots.size);
  }
  
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
  
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSnapshots();
    }, SNAPSHOT_CONFIG.CLEANUP_INTERVAL_MS);
  }
  
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
  
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
  }
  
  // ========== 测试/调试支持 ==========
  
  reset(): void {
    this.clearAllSnapshots();
    this.stopCleanupTimer();
    this.startCleanupTimer();
  }
}
