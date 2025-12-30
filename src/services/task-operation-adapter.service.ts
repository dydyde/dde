/**
 * TaskOperationAdapterService - 任务操作适配器
 * 
 * 【设计目的】
 * 隔离 TaskOperationService 的回调模式，为未来迁移到纯状态驱动架构提供过渡层。
 * 
 * 旧模式（回调）:
 *   TaskOperationService.setCallbacks({
 *     onProjectUpdate: (mutator) => this.recordAndUpdate(mutator),
 *     ...
 *   })
 * 
 * 新模式（状态驱动）:
 *   - 通过本适配器调用 TaskOperationService
 *   - 适配器内部处理撤销记录和持久化调度
 *   - 新代码不需要知道回调的存在
 * 
 * 【乐观更新策略】
 * 为任务操作提供快照恢复机制：
 * - 结构性操作（创建/删除/移动）：立即创建快照，同步失败时回滚
 * - 内容操作（更新标题/内容）：防抖合并后创建快照
 * 
 * 【职责边界】
 * ✓ 桥接 TaskOperationService 和 SyncCoordinatorService
 * ✓ 处理撤销/重做记录（与 UndoService 协调）
 * ✓ 触发持久化调度（通知 SyncCoordinatorService）
 * ✓ 维护编辑状态（通知 UiStateService）
 * ✓ 乐观更新快照管理（通过 OptimisticStateService）
 * ✗ 任务 CRUD 逻辑 → TaskOperationService
 * ✗ 数据持久化 → SyncCoordinatorService
 */
import { Injectable, inject, Injector, Type } from '@angular/core';
import { TaskOperationService } from './task-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task, Attachment, Connection } from '../models';
import { Result, OperationError } from '../utils/result';

@Injectable({
  providedIn: 'root'
})
export class TaskOperationAdapterService {
  private taskOps = inject(TaskOperationService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private changeTracker = inject(ChangeTrackerService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private layoutService = inject(LayoutService);
  private optimisticState = inject(OptimisticStateService);
  private toastService = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskOpsAdapter');
  private readonly injector = inject(Injector);
  
  /** 上次更新类型 */
  private lastUpdateType: 'content' | 'structure' | 'position' = 'structure';
  
  /** 当前活跃的结构操作快照（用于跟踪异步同步结果） */
  private activeStructureSnapshot: string | null = null;
  
  constructor() {
    // 设置 TaskOperationService 的回调 - 这是唯一与回调模式交互的地方
    this.taskOps.setCallbacks({
      onProjectUpdate: (mutator) => this.recordAndUpdate(mutator),
      onProjectUpdateDebounced: (mutator) => this.recordAndUpdateDebounced(mutator),
      getActiveProject: () => this.projectState.activeProject()
    });
  }
  
  // ========== 公共方法：对外暴露干净的 API ==========
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.lastUpdateType;
  }
  
  /**
   * 标记正在编辑
   */
  markEditing(): void {
    this.uiState.markEditing();
    this.syncCoordinator.markLocalChanges(this.lastUpdateType);
  }
  
  /**
   * 检查是否正在编辑
   */
  get isUserEditing(): boolean {
    return this.uiState.isEditing || this.syncCoordinator.hasPendingLocalChanges();
  }
  
  // ========== 任务内容操作 ==========
  
  updateTaskContent(taskId: string, newContent: string): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskContent(taskId, newContent);
  }
  
  updateTaskTitle(taskId: string, title: string): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskTitle(taskId, title);
  }
  
  addTodoItem(taskId: string, itemText: string): void {
    this.markEditing();
    this.taskOps.addTodoItem(taskId, itemText);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string): void {
    this.taskOps.completeUnfinishedItem(taskId, itemText);
  }
  
  // ========== 任务位置操作 ==========
  
  updateTaskPosition(taskId: string, x: number, y: number): void {
    this.lastUpdateType = 'position';
    this.taskOps.updateTaskPosition(taskId, x, y);
  }
  
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number): void {
    this.taskOps.updateTaskPositionWithRankSync(taskId, x, y);
  }
  
  /**
   * 开始位置拖拽批次
   * 在拖拽开始时调用，记录初始状态用于撤销
   */
  beginPositionBatch(): void {
    const project = this.projectState.activeProject();
    if (project) {
      this.undoService.beginBatch(project);
    }
  }
  
  /**
   * 结束位置拖拽批次
   * 在拖拽结束时调用，将所有位置变更作为单个撤销单元记录
   */
  endPositionBatch(): void {
    const project = this.projectState.activeProject();
    if (project) {
      this.undoService.endBatch(project);
      // 触发同步
      this.syncCoordinator.markLocalChanges('position');
      this.syncCoordinator.schedulePersist();
    }
  }
  
  /**
   * 取消位置拖拽批次（不记录撤销）
   */
  cancelPositionBatch(): void {
    this.undoService.cancelBatch();
  }
  
  /**
   * 更新任务位置（带撤销支持）
   * 用于单个节点拖拽完成后的位置更新
   */
  updateTaskPositionWithUndo(taskId: string, x: number, y: number): void {
    this.lastUpdateType = 'position';
    
    // 使用 recordAndUpdate 模式记录撤销
    const project = this.projectState.activeProject();
    if (!project) return;
    
    const task = project.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    // 只有位置真正改变时才记录
    if (Math.abs(task.x - x) < 1 && Math.abs(task.y - y) < 1) return;
    
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => 
        t.id === taskId ? { ...t, x, y, updatedAt: now } : t
      )
    }));
  }
  
  // ========== 任务状态操作 ==========
  
  /**
   * 更新任务状态
   * 
   * 【关键修复】确保状态变更被正确追踪：
   * 1. markEditing() - 通知 UiState 和 SyncCoordinator
   * 2. lastUpdateType = 'content' - 触发内容同步
   * 3. trackTaskStatusChange() - 通知 ChangeTracker 追踪变更字段
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    
    // 通知 ChangeTracker 追踪状态字段变更
    const project = this.projectState.activeProject();
    if (project) {
      const task = project.tasks.find(t => t.id === taskId);
      if (task) {
        // 先设置操作锁，防止远程推送覆盖正在进行的操作
        this.changeTracker.lockTaskField(taskId, project.id, 'status');
      }
    }
    
    this.taskOps.updateTaskStatus(taskId, status);
  }
  
  // ========== 任务扩展属性 ==========
  
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskAttachments(taskId, attachments);
  }
  
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.addTaskAttachment(taskId, attachment);
  }
  
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.removeTaskAttachment(taskId, attachmentId);
  }
  
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskPriority(taskId, priority);
  }
  
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskDueDate(taskId, dueDate);
  }
  
  updateTaskTags(taskId: string, tags: string[]): void {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.taskOps.updateTaskTags(taskId, tags);
  }
  
  addTaskTag(taskId: string, tag: string): void {
    this.taskOps.addTaskTag(taskId, tag);
  }
  
  removeTaskTag(taskId: string, tag: string): void {
    this.taskOps.removeTaskTag(taskId, tag);
  }
  
  // ========== 任务 CRUD ==========
  
  /**
   * 添加任务（带乐观更新）
   */
  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): Result<string, OperationError> {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    
    const result = this.taskOps.addTask({ title, content, targetStage, parentId, isSibling });
    
    // 操作成功，提交快照（同步失败时会通过 syncCoordinator 回滚）
    if (result.ok) {
      this.activeStructureSnapshot = snapshot.id;
      this.setupSyncResultHandler(snapshot.id);
      
      // 显示带撤回按钮的 Toast
      this.toastService.success(
        `已创建 "${title || '新任务'}"`,
        undefined,
        {
          duration: 5000,
          action: {
            label: '撤销',
            onClick: () => {
              this.logger.info('用户撤回创建任务操作', { title });
              this.performUndo();
            }
          }
        }
      );
    } else {
      // 操作本身失败，立即回滚
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    
    return result;
  }
  
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    
    this.taskOps.addFloatingTask(title, content, x, y);
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      `已创建 "${title || '新任务'}"`,
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回创建浮动任务操作', { title });
            this.performUndo();
          }
        }
      }
    );
  }
  
  deleteTask(taskId: string): void {
    // 获取任务信息用于 Toast 显示
    const project = this.projectState.activeProject();
    const task = project?.tasks.find(t => t.id === taskId);
    const taskTitle = task?.title || '任务';
    
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    
    this.taskOps.deleteTask(taskId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      `已删除 "${taskTitle}"`,
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回删除操作', { taskId });
            this.performUndo();
          }
        }
      }
    );
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
  }
  
  permanentlyDeleteTask(taskId: string): void {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    
    this.taskOps.permanentlyDeleteTask(taskId);
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
  }
  
  /**
   * 批量删除任务（原子操作）
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns 实际删除的任务数量（含级联子任务）
   */
  deleteTasksBatch(explicitIds: string[]): number {
    if (explicitIds.length === 0) return 0;
    
    // 创建乐观更新快照（使用第一个任务 ID，标记为删除操作）
    const snapshot = this.optimisticState.createTaskSnapshot(explicitIds[0], '删除');
    
    const deletedCount = this.taskOps.deleteTasksBatch(explicitIds);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      `已删除 ${deletedCount} 个任务`,
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回批量删除操作', { deletedCount });
            this.performUndo();
          }
        }
      }
    );
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
    
    return deletedCount;
  }
  
  /**
   * 计算批量删除将影响的任务数量（含级联子任务）
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.taskOps.calculateBatchDeleteImpact(explicitIds);
  }
  
  restoreTask(taskId: string): void {
    this.taskOps.restoreTask(taskId);
  }
  
  emptyTrash(): void {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot('', '删除');
    
    this.taskOps.emptyTrash();
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
  }
  
  // ========== 任务结构操作 ==========
  
  moveTaskToStage(
    taskId: string, 
    newStage: number | null, 
    beforeTaskId?: string | null, 
    newParentId?: string | null
  ): Result<void, OperationError> {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    
    const result = this.taskOps.moveTaskToStage({ taskId, newStage, beforeTaskId, newParentId });
    
    if (result.ok) {
      // 显示带撤回按钮的 Toast
      const stageName = newStage === null ? '待分配区' : `阶段 ${newStage}`;
      this.toastService.success(
        `已移动到${stageName}`,
        undefined,
        {
          duration: 5000,
          action: {
            label: '撤销',
            onClick: () => {
              this.logger.info('用户撤回移动操作', { taskId, newStage });
              this.performUndo();
            }
          }
        }
      );
      
      this.activeStructureSnapshot = snapshot.id;
      this.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    
    return result;
  }
  
  insertTaskBetween(taskId: string, sourceId: string, targetId: string): Result<void, OperationError> {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    
    const result = this.taskOps.insertTaskBetween({ taskId, sourceId, targetId });
    
    if (result.ok) {
      this.activeStructureSnapshot = snapshot.id;
      this.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    
    return result;
  }
  
  /**
   * 将整个子任务树迁移到新的父任务下
   * @param taskId 要迁移的子树根节点 ID
   * @param newParentId 新父任务 ID（null 表示迁移到 stage 1 根节点）
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '移动');
    
    const result = this.taskOps.moveSubtreeToNewParent(taskId, newParentId);
    
    if (result.ok) {
      // 显示带撤回按钮的 Toast
      this.toastService.success(
        '已移动子树',
        undefined,
        {
          duration: 5000,
          action: {
            label: '撤销',
            onClick: () => {
              this.logger.info('用户撤回子树移动操作', { taskId, newParentId });
              this.performUndo();
            }
          }
        }
      );
      
      this.activeStructureSnapshot = snapshot.id;
      this.setupSyncResultHandler(snapshot.id);
    } else {
      this.optimisticState.rollbackSnapshot(snapshot.id);
    }
    
    return result;
  }
  
  reorderStage(stage: number, orderedIds: string[]): void {
    this.taskOps.reorderStage(stage, orderedIds);
  }
  
  detachTask(taskId: string): void {
    this.taskOps.detachTask(taskId);
  }
  
  /**
   * 分离任务及其整个子树（移回待分配区）
   * 
   * 【浮动任务树方法】
   */
  detachTaskWithSubtree(taskId: string) {
    const result = this.taskOps.detachTaskWithSubtree(taskId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      '已移动到待分配区',
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回分离子树操作', { taskId });
            this.performUndo();
          }
        }
      }
    );
    
    return result;
  }
  
  deleteTaskKeepChildren(taskId: string): void {
    // 获取任务信息用于 Toast 显示
    const project = this.projectState.activeProject();
    const task = project?.tasks.find(t => t.id === taskId);
    const taskTitle = task?.title || '任务';
    
    // 创建乐观更新快照
    const snapshot = this.optimisticState.createTaskSnapshot(taskId, '删除');
    
    this.taskOps.deleteTaskKeepChildren(taskId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      `已删除 "${taskTitle}"（保留子任务）`,
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回保留子任务删除操作', { taskId });
            this.performUndo();
          }
        }
      }
    );
    
    this.activeStructureSnapshot = snapshot.id;
    this.setupSyncResultHandler(snapshot.id);
  }
  
  /**
   * 设置同步结果处理器
   * 监听 syncCoordinator 的持久化结果，成功则提交快照，失败则回滚
   */
  private setupSyncResultHandler(snapshotId: string): void {
    // 监听下次持久化完成
    const checkSync = () => {
      // 如果快照已被处理（提交或回滚），退出
      if (!this.optimisticState.hasSnapshot(snapshotId)) {
        return;
      }
      
      // 检查是否有同步错误
      const syncError = this.syncCoordinator.syncError();
      if (syncError) {
        this.logger.warn('同步失败，回滚快照', { snapshotId, error: syncError });
        this.optimisticState.rollbackSnapshot(snapshotId);
        return;
      }
      
      // 如果没有待处理的变更且没有错误，提交快照
      if (!this.syncCoordinator.hasPendingLocalChanges()) {
        this.logger.debug('同步成功，提交快照', { snapshotId });
        this.optimisticState.commitSnapshot(snapshotId);
        return;
      }
      
      // 继续等待（最多 30 秒）
      const snapshot = this.optimisticState['snapshots'].get(snapshotId);
      if (snapshot && Date.now() - snapshot.createdAt < 30000) {
        setTimeout(checkSync, 500);
      } else {
        // 超时，假定成功（数据已保存到本地）
        this.logger.debug('同步超时，假定成功', { snapshotId });
        this.optimisticState.commitSnapshot(snapshotId);
      }
    };
    
    // 延迟检查，给 syncCoordinator 时间处理
    setTimeout(checkSync, 200);
  }
  
  // ========== 连接操作 ==========
  
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    this.taskOps.addCrossTreeConnection(sourceId, targetId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      '已添加关联',
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回添加连接操作', { sourceId, targetId });
            this.performUndo();
          }
        }
      }
    );
  }
  
  removeConnection(sourceId: string, targetId: string): void {
    this.taskOps.removeConnection(sourceId, targetId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      '已删除关联',
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回删除连接操作', { sourceId, targetId });
            this.performUndo();
          }
        }
      }
    );
  }
  
  /**
   * 重连跨树连接（原子操作）
   * 在一个撤销单元内删除旧连接并创建新连接
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): void {
    this.taskOps.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
    
    // 显示带撤回按钮的 Toast
    this.toastService.success(
      '已重连关联',
      undefined,
      {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回重连操作', { oldSourceId, oldTargetId, newSourceId, newTargetId });
            this.performUndo();
          }
        }
      }
    );
  }
  
  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.markEditing();
    this.taskOps.updateConnectionContent(sourceId, targetId, title, description);
  }
  
  /**
   * 更新连接描述（兼容旧 API）
   * @deprecated 使用 updateConnectionContent 代替
   */
  updateConnectionDescription(sourceId: string, targetId: string, description: string): void {
    this.markEditing();
    this.taskOps.updateConnectionContent(sourceId, targetId, '', description);
  }
  
  // ========== 查询方法 ==========
  
  isStageRebalancing(stage: number): boolean {
    return this.taskOps.isStageRebalancing(stage);
  }
  
  /**
   * 清理超期回收站项目
   */
  cleanupOldTrashItems(): number {
    return this.taskOps.cleanupOldTrashItems();
  }
  
  // ========== 私有方法：回调实现 ==========
  
  /** 更新锁：防止快照和更新之间的竞态条件 */
  private isUpdating = false;
  
  /**
   * 获取 StoreService 实例（延迟注入避免循环依赖）
   * 使用 injector 动态获取
   */
  private getStoreService(): { undo: () => void } | null {
    try {
      // 使用 Angular Injector 动态获取 StoreService
      // 延迟导入避免循环依赖（StoreService -> TaskOperationAdapterService -> StoreService）
      const StoreService = this.injector.get('StoreService' as unknown as Type<{ undo: () => void }>);
      return StoreService;
    } catch (e) {
      this.logger.warn('无法获取 StoreService（可能存在循环依赖）', e);
      return null;
    }
  }
  
  /**
   * 执行撤销操作（内部方法，用于 Toast 回调）
   * 复制自 StoreService.undo()，避免循环依赖
   */
  performUndo(): void {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);
    
    if (!result) {
      this.logger.warn('没有可撤销的操作');
      return;
    }
    
    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }
    
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意', 
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before);
      }
      return;
    }
    
    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.before);
    this.logger.info('撤销操作成功', { projectId: action.projectId, type: action.type });
  }
  
  /**
   * 应用项目快照（内部方法）
   */
  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>): void {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
  }
  
  /**
   * 记录操作并更新项目（立即记录撤销历史）
   * 
   * 竞态条件保护：通过 isUpdating 锁确保快照和更新的原子性
   * 如果在更新过程中有新请求，会等待当前操作完成
   */
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    // 防止竞态条件：如果正在更新，跳过（因为是同步操作，理论上不会发生）
    if (this.isUpdating) {
      console.warn('[TaskOperationAdapter] 检测到并发更新，跳过本次操作');
      return;
    }
    
    this.isUpdating = true;
    
    try {
      const project = this.projectState.activeProject();
      if (!project) return;
      
      // 锁定当前项目ID，防止中途切换
      const targetProjectId = project.id;
      
      this.lastUpdateType = 'structure';
      
      // 创建快照时立即深拷贝关键数据，确保快照不受后续修改影响
      const beforeSnapshot = this.undoService.createProjectSnapshot(project);
      const currentVersion = project.version ?? 0;
      
      // 保存更新前的状态用于变更追踪
      const beforeTaskMap = new Map(project.tasks.map(t => [t.id, t]));
      const beforeConnectionMap = new Map(project.connections.map(c => [`${c.source}|${c.target}`, c]));
      
      let afterProject: Project | null = null;
      this.projectState.updateProjects(projects => projects.map(p => {
        // 使用锁定的项目ID进行匹配
        if (p.id === targetProjectId) {
          afterProject = mutator(p);
          return afterProject;
        }
        return p;
      }));
      
      if (afterProject && !this.undoService.isProcessing) {
        const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
        this.undoService.recordAction({
          type: 'task-update',
          projectId: targetProjectId,
          data: { before: beforeSnapshot, after: afterSnapshot }
        }, currentVersion);
        
        // 追踪变更
        this.trackChanges(targetProjectId, beforeTaskMap, beforeConnectionMap, afterProject);
      }
      
      this.syncCoordinator.markLocalChanges('structure');
      this.syncCoordinator.schedulePersist();
    } finally {
      this.isUpdating = false;
    }
  }
  
  /**
   * 记录操作并更新项目（防抖记录撤销历史）
   * 
   * 竞态条件保护：与 recordAndUpdate 相同的锁机制
   */
  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    if (this.isUpdating) {
      console.warn('[TaskOperationAdapter] 检测到并发更新，跳过本次操作');
      return;
    }
    
    this.isUpdating = true;
    
    try {
      const project = this.projectState.activeProject();
      if (!project) return;
      
      const targetProjectId = project.id;
      
      this.lastUpdateType = 'content';
      
      const beforeSnapshot = this.undoService.createProjectSnapshot(project);
      const currentVersion = project.version ?? 0;
      
      // 保存更新前的状态用于变更追踪
      const beforeTaskMap = new Map(project.tasks.map(t => [t.id, t]));
      const beforeConnectionMap = new Map(project.connections.map(c => [`${c.source}|${c.target}`, c]));
      
      let afterProject: Project | null = null;
      this.projectState.updateProjects(projects => projects.map(p => {
        if (p.id === targetProjectId) {
          afterProject = mutator(p);
          return afterProject;
        }
        return p;
      }));
      
      if (afterProject && !this.undoService.isProcessing) {
        const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
        this.undoService.recordActionDebounced({
          type: 'task-update',
          projectId: targetProjectId,
          projectVersion: currentVersion,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
        
        // 追踪变更
        this.trackChanges(targetProjectId, beforeTaskMap, beforeConnectionMap, afterProject);
      }
      
      this.syncCoordinator.markLocalChanges('content');
      this.syncCoordinator.schedulePersist();
    } finally {
      this.isUpdating = false;
    }
  }
  
  /**
   * 追踪项目变更，记录到 ChangeTrackerService
   * 
   * 通过对比更新前后的状态，自动识别：
   * - 新增的任务/连接
   * - 修改的任务/连接
   * - 删除的任务/连接（包括软删除）
   */
  private trackChanges(
    projectId: string,
    beforeTaskMap: Map<string, Task>,
    beforeConnectionMap: Map<string, Connection>,
    afterProject: Project
  ): void {
    // 追踪任务变更
    const afterTaskIds = new Set<string>();
    
    for (const task of afterProject.tasks) {
      afterTaskIds.add(task.id);
      
      const beforeTask = beforeTaskMap.get(task.id);
      
      if (!beforeTask) {
        // 新增任务
        this.changeTracker.trackTaskCreate(projectId, task);
      } else {
        // 检查是否有变更
        const changedFields = this.getChangedTaskFields(beforeTask, task);
        if (changedFields.length > 0) {
          this.changeTracker.trackTaskUpdate(projectId, task, changedFields);
        }
      }
    }
    
    // 检查删除的任务
    for (const [taskId, _] of beforeTaskMap) {
      if (!afterTaskIds.has(taskId)) {
        this.changeTracker.trackTaskDelete(projectId, taskId);
      }
    }
    
    // 追踪连接变更（支持软删除检测）
    const afterConnectionMap = new Map<string, Connection>();
    
    for (const conn of afterProject.connections) {
      const key = `${conn.source}|${conn.target}`;
      afterConnectionMap.set(key, conn);
      
      const beforeConn = beforeConnectionMap.get(key);
      
      if (!beforeConn) {
        // 新增连接
        this.changeTracker.trackConnectionCreate(projectId, conn);
      } else {
        // 检查 deletedAt 或 description 是否变化
        const deletedAtChanged = beforeConn.deletedAt !== conn.deletedAt;
        const descriptionChanged = beforeConn.description !== conn.description;
        
        if (deletedAtChanged || descriptionChanged) {
          // 使用更新来追踪软删除状态变化
          this.changeTracker.trackConnectionUpdate(projectId, conn);
        }
      }
    }
    
    // 检查从数组中完全移除的连接（硬删除场景，虽然现在不用，但保留兼容性）
    for (const [key, _] of beforeConnectionMap) {
      if (!afterConnectionMap.has(key)) {
        const [source, target] = key.split('|');
        this.changeTracker.trackConnectionDelete(projectId, source, target);
      }
    }
  }
  
  /**
   * 比较任务字段变更
   */
  private getChangedTaskFields(before: Task, after: Task): string[] {
    const fields: string[] = [];
    
    // 比较关键字段
    if (before.title !== after.title) fields.push('title');
    if (before.content !== after.content) fields.push('content');
    if (before.status !== after.status) fields.push('status');
    if (before.stage !== after.stage) fields.push('stage');
    if (before.parentId !== after.parentId) fields.push('parentId');
    if (before.order !== after.order) fields.push('order');
    if (before.rank !== after.rank) fields.push('rank');
    if (before.x !== after.x) fields.push('x');
    if (before.y !== after.y) fields.push('y');
    if (before.priority !== after.priority) fields.push('priority');
    if (before.dueDate !== after.dueDate) fields.push('dueDate');
    if (before.deletedAt !== after.deletedAt) fields.push('deletedAt');
    
    // 比较数组字段（简化比较）
    if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) fields.push('tags');
    if (JSON.stringify(before.attachments) !== JSON.stringify(after.attachments)) fields.push('attachments');
    
    return fields;
  }
}
