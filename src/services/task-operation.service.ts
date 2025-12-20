import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { Task, Project, Connection, Attachment } from '../models';
import { LayoutService } from './layout.service';
import { LAYOUT_CONFIG, TRASH_CONFIG } from '../config/constants';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 任务操作参数
 */
export interface CreateTaskParams {
  title: string;
  content: string;
  targetStage: number | null;
  parentId: string | null;
  isSibling?: boolean;
}

/**
 * 任务移动参数
 */
export interface MoveTaskParams {
  taskId: string;
  newStage: number | null;
  beforeTaskId?: string | null;
  newParentId?: string | null;
}

/**
 * 任务插入参数
 */
export interface InsertBetweenParams {
  taskId: string;
  sourceId: string;
  targetId: string;
}

/**
 * 任务操作服务
 * 从 StoreService 拆分出来，专注于任务的 CRUD 操作
 * 
 * 【职责边界】
 * ✓ 任务创建、更新、删除
 * ✓ 任务移动、排序
 * ✓ 任务属性更新（标题、内容、优先级、标签等）
 * ✓ 回收站管理（软删除、恢复、永久删除）
 * ✓ 父子关系管理
 * ✓ Rank 计算和重平衡
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ 撤销/重做 → UndoService（通过回调通知）
 */
@Injectable({
  providedIn: 'root'
})
export class TaskOperationService {
  private layoutService = inject(LayoutService);
  private destroyRef = inject(DestroyRef);
  
  /** 重平衡锁定的阶段 */
  private rebalancingStages = new Set<number>();
  
  /** 需要重平衡的阶段 */
  private stagesNeedingRebalance = new Set<number>();
  
  /** 重平衡定时器 */
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 操作回调 - 用于通知 StoreService 进行持久化和撤销记录 */
  private onProjectUpdateCallback: ((mutator: (project: Project) => Project) => void) | null = null;
  private onProjectUpdateDebouncedCallback: ((mutator: (project: Project) => Project) => void) | null = null;
  private getActiveProjectCallback: (() => Project | null) | null = null;
  
  constructor() {
    // 注册清理逻辑，防止定时器内存泄漏
    this.destroyRef.onDestroy(() => {
      if (this.rebalanceTimer) {
        clearTimeout(this.rebalanceTimer);
        this.rebalanceTimer = null;
      }
    });
  }
  
  /**
   * 设置操作回调
   * @param callbacks 回调函数集合
   */
  setCallbacks(callbacks: {
    onProjectUpdate: (mutator: (project: Project) => Project) => void;
    onProjectUpdateDebounced: (mutator: (project: Project) => Project) => void;
    getActiveProject: () => Project | null;
  }) {
    this.onProjectUpdateCallback = callbacks.onProjectUpdate;
    this.onProjectUpdateDebouncedCallback = callbacks.onProjectUpdateDebounced;
    this.getActiveProjectCallback = callbacks.getActiveProject;
  }
  
  // ========== 查询方法 ==========
  
  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.rebalancingStages.has(stage);
  }
  
  /**
   * 获取任务的关联连接
   */
  getTaskConnections(project: Project | null, taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    // 排除父子关系的连接
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: tasks.find(t => t.id === c.target),
        description: c.description
      }));
    
    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: tasks.find(t => t.id === c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }
  
  // ========== 任务创建 ==========
  
  /**
   * 添加新任务
   * @returns Result 包含新任务 ID 或错误信息
   */
  addTask(params: CreateTaskParams): Result<string, OperationError> {
    const { title, content, targetStage, parentId, isSibling } = params;
    
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }
    
    // 检查目标阶段是否正在重平衡
    if (targetStage !== null && this.isStageRebalancing(targetStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null 
      ? this.layoutService.gridPosition(targetStage, newOrder - 1)
      : this.layoutService.getUnassignedPosition(activeP.tasks.filter(t => t.stage === null).length);
    const parent = parentId ? activeP.tasks.find(t => t.id === parentId) : null;
    const candidateRank = targetStage === null
      ? LAYOUT_CONFIG.RANK_ROOT_BASE + activeP.tasks.filter(t => t.stage === null).length * LAYOUT_CONFIG.RANK_STEP
      : this.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title,
      content,
      stage: targetStage,
      parentId: targetStage === null ? null : parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x, 
      y: pos.y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      shortId: this.layoutService.generateShortId(activeP.tasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(content)
    };

    const placed = this.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity, activeP.tasks);
    if (!placed.ok) {
      return failure(
        ErrorCodes.LAYOUT_NO_SPACE, 
        '无法在该位置放置任务，区域可能已满或存在冲突',
        { stage: targetStage, parentId }
      );
    }
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.layoutService.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { id: crypto.randomUUID(), source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
    
    return success(newTaskId);
  }
  
  /**
   * 添加浮动任务（未分配阶段的任务）
   */
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const count = activeP.tasks.filter(t => t.stage === null).length;
    const rank = LAYOUT_CONFIG.RANK_ROOT_BASE + count * LAYOUT_CONFIG.RANK_STEP;
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: count + 1,
      rank,
      status: 'active',
      x,
      y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.layoutService.detectIncomplete(content)
    };

    this.recordAndUpdate(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }
  
  // ========== 任务内容更新 ==========
  
  /**
   * 更新任务内容
   */
  updateTaskContent(taskId: string, newContent: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent, updatedAt: now } : t)
    }));
  }
  
  /**
   * 更新任务标题
   */
  updateTaskTitle(taskId: string, title: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, title, updatedAt: now } : t)
    }));
  }
  
  /**
   * 更新任务位置
   */
  updateTaskPosition(taskId: string, x: number, y: number): void {
    this.updateActiveProjectRaw(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
    }));
  }
  
  /**
   * 更新任务位置并同步 Rank
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number): void {
    const project = this.getActiveProject();
    if (!project) return;
    
    const task = project.tasks.find(t => t.id === taskId);
    if (!task || task.stage === null) {
      this.updateTaskPosition(taskId, x, y);
      return;
    }
    
    // 获取同一阶段的所有任务（排除自身）
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // 根据新的 Y 坐标计算新的 rank
    let newRank: number;
    const RANK_STEP = LAYOUT_CONFIG.RANK_STEP;
    
    if (stageTasks.length === 0) {
      newRank = task.rank;
    } else {
      const insertIndex = stageTasks.findIndex(t => (t.y ?? 0) > y);
      
      if (insertIndex === -1) {
        const lastTask = stageTasks[stageTasks.length - 1];
        newRank = lastTask.rank + RANK_STEP;
      } else if (insertIndex === 0) {
        const firstTask = stageTasks[0];
        newRank = firstTask.rank - RANK_STEP;
      } else {
        const prevTask = stageTasks[insertIndex - 1];
        const nextTask = stageTasks[insertIndex];
        newRank = (prevTask.rank + nextTask.rank) / 2;
        
        if (Math.abs(prevTask.rank - newRank) < 50) {
          this.recordAndUpdate(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
          }));
          return;
        }
      }
    }
    
    this.updateActiveProjectRaw(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
    }));
  }
  
  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status, updatedAt: now } : t)
    }));
  }
  
  // ========== 任务扩展属性 ==========
  
  /**
   * 更新任务附件
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, attachments, updatedAt: now } : t)
    }));
  }
  
  /**
   * 添加单个附件
   */
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          const currentAttachments = t.attachments || [];
          if (currentAttachments.some(a => a.id === attachment.id)) {
            return t;
          }
          return { ...t, attachments: [...currentAttachments, attachment], updatedAt: now };
        }
        return t;
      })
    }));
  }
  
  /**
   * 移除单个附件
   */
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          const currentAttachments = t.attachments || [];
          return { 
            ...t, 
            attachments: currentAttachments.filter(a => a.id !== attachmentId),
            updatedAt: now
          };
        }
        return t;
      })
    }));
  }
  
  /**
   * 更新任务优先级
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, priority, updatedAt: now } : t)
    }));
  }
  
  /**
   * 更新任务截止日期
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, dueDate, updatedAt: now } : t)
    }));
  }
  
  /**
   * 更新任务标签
   */
  updateTaskTags(taskId: string, tags: string[]): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, tags, updatedAt: now } : t)
    }));
  }
  
  /**
   * 添加单个标签
   */
  addTaskTag(taskId: string, tag: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const task = activeP.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const currentTags = task.tags || [];
    if (currentTags.includes(tag)) return;
    
    this.updateTaskTags(taskId, [...currentTags, tag]);
  }
  
  /**
   * 移除单个标签
   */
  removeTaskTag(taskId: string, tag: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const task = activeP.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const currentTags = task.tags || [];
    this.updateTaskTags(taskId, currentTags.filter(t => t !== tag));
  }
  
  // ========== 待办项操作 ==========
  
  /**
   * 添加待办项
   */
  addTodoItem(taskId: string, itemText: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const task = activeP.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const trimmedText = itemText.trim();
    if (!trimmedText) return;
    
    const todoLine = `- [ ] ${trimmedText}`;
    let newContent = task.content || '';
    
    if (newContent && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    newContent += todoLine;
    
    this.updateTaskContent(taskId, newContent);
  }
  
  /**
   * 完成待办项
   */
  completeUnfinishedItem(taskId: string, itemText: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const task = activeP.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const escapedText = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`- \\[ \\]\\s*${escapedText}`);
    const newContent = task.content.replace(regex, `- [x] ${itemText}`);
    
    if (newContent !== task.content) {
      this.updateTaskContent(taskId, newContent);
    }
  }
  
  // ========== 任务删除与恢复 ==========
  
  /**
   * 软删除任务（移动到回收站）
   */
  deleteTask(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    const now = new Date().toISOString();
    
    // 找出所有涉及被删除任务的连接
    const deletedConnections = activeP.connections.filter(
      c => idsToDelete.has(c.source) || idsToDelete.has(c.target)
    );
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id === taskId) {
          return {
            ...t,
            deletedAt: now,
            deletedMeta: {
              parentId: t.parentId,
              stage: t.stage,
              order: t.order,
              rank: t.rank,
              x: t.x,
              y: t.y,
            },
            stage: null,
            deletedConnections
          };
        } else if (idsToDelete.has(t.id)) {
          return {
            ...t,
            deletedAt: now,
            deletedMeta: {
              parentId: t.parentId,
              stage: t.stage,
              order: t.order,
              rank: t.rank,
              x: t.x,
              y: t.y,
            },
            stage: null
          };
        }
        return t;
      }),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }
  
  /**
   * 永久删除任务
   */
  permanentlyDeleteTask(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }
  
  /**
   * 从回收站恢复任务
   */
  restoreTask(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const mainTask = activeP.tasks.find(t => t.id === taskId);
    const savedConnections = mainTask?.deletedConnections || [];
    
    const idsToRestore = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToRestore.has(id)) continue;
      idsToRestore.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => {
      const restoredTasks = p.tasks.map(t => {
        if (idsToRestore.has(t.id)) {
          const meta = t.deletedMeta;
          const { deletedConnections, deletedMeta, ...rest } = t;
          if (meta) {
            return {
              ...rest,
              deletedAt: null,
              parentId: meta.parentId,
              stage: meta.stage,
              order: meta.order,
              rank: meta.rank,
              x: meta.x,
              y: meta.y,
            };
          }
          return { ...rest, deletedAt: null };
        }
        return t;
      });
      
      const existingConnKeys = new Set(
        p.connections.map(c => `${c.source}->${c.target}`)
      );
      const connectionsToRestore = savedConnections.filter(
        c => !existingConnKeys.has(`${c.source}->${c.target}`)
      );
      
      return this.layoutService.rebalance({
        ...p,
        tasks: restoredTasks,
        connections: [...p.connections, ...connectionsToRestore]
      });
    });
  }
  
  /**
   * 清空回收站
   */
  emptyTrash(): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const deletedIds = new Set(activeP.tasks.filter(t => t.deletedAt).map(t => t.id));
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !t.deletedAt),
      connections: p.connections.filter(c => !deletedIds.has(c.source) && !deletedIds.has(c.target))
    }));
  }
  
  /**
   * 清理超过保留期限的回收站项目
   */
  cleanupOldTrashItems(): number {
    const activeP = this.getActiveProject();
    if (!activeP) return 0;
    
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TRASH_CONFIG.AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    
    this.recordAndUpdate(p => {
      const tasksToKeep = p.tasks.filter(task => {
        if (!task.deletedAt) return true;
        
        const deletedDate = new Date(task.deletedAt);
        if (deletedDate < cutoffDate) {
          cleanedCount++;
          return false;
        }
        return true;
      });
      
      if (tasksToKeep.length !== p.tasks.length) {
        return this.layoutService.rebalance({ ...p, tasks: tasksToKeep });
      }
      return p;
    });
    
    return cleanedCount;
  }
  
  // ========== 任务移动 ==========
  
  /**
   * 移动任务到指定阶段
   */
  moveTaskToStage(params: MoveTaskParams): Result<void, OperationError> {
    const { taskId, newStage, beforeTaskId, newParentId } = params;
    
    if (newStage !== null && this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }
      
      if (newParentId && this.layoutService.detectCycle(taskId, newParentId, tasks)) {
        operationResult = failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
        return p;
      }

      const oldStage = target.stage;
      target.stage = newStage;
      
      // parentId 验证与清理逻辑：
      // 1. 移动到未分配区域（stage=null）时，清除 parentId
      // 2. 显式提供了 newParentId 时，使用新值
      // 3. 未提供 newParentId 时，验证原 parentId 是否仍然有效
      if (newStage === null) {
        target.parentId = null;
      } else if (newParentId !== undefined) {
        target.parentId = newParentId;
      } else if (target.parentId) {
        // 验证原 parentId：父任务必须存在且在 newStage - 1 阶段
        const parent = tasks.find(t => t.id === target.parentId);
        if (!parent || parent.stage !== newStage - 1) {
          // 父任务不存在或不在正确的阶段，清除 parentId
          console.log('[MoveTask] 清除无效 parentId:', {
            taskId: taskId.slice(-4),
            oldParentId: target.parentId?.slice(-4),
            newStage,
            parentStage: parent?.stage ?? 'not found'
          });
          target.parentId = null;
        }
      }
      
      // 级联更新子任务的 stage：当父任务移动到新阶段时，
      // 所有直接子任务的 stage 需要同步更新为 newStage + 1
      if (newStage !== null && oldStage !== newStage) {
        this.cascadeUpdateChildrenStage(target.id, newStage, tasks);
      }

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
      const parentRank = this.layoutService.maxParentRank(target, tasks);
      const minChildRank = this.layoutService.minChildRank(target.id, tasks);
      
      if (newStage !== null) {
        const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank, tasks);
        if (!placed.ok) {
          operationResult = failure(ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT, '无法移动：会破坏父子关系约束');
          return p;
        }
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank, tasks);
        if (!placed.ok) {
          operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法移动到未分配区域');
          return p;
        }
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }
  
  /**
   * 将任务插入到两个已有节点之间
   */
  insertTaskBetween(params: InsertBetweenParams): Result<void, OperationError> {
    const { taskId, sourceId, targetId } = params;
    
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    const insertTask = activeP.tasks.find(t => t.id === taskId);

    if (!sourceTask || !targetTask || !insertTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '找不到相关任务');
    }

    if (targetTask.parentId !== sourceId) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标任务不是源任务的直接子节点');
    }

    if (this.wouldCreateCycle(taskId, sourceId, targetId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '操作会产生循环依赖');
    }
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      
      const source = tasks.find(t => t.id === sourceId)!;
      const target = tasks.find(t => t.id === targetId)!;
      const newTask = tasks.find(t => t.id === taskId)!;
      
      const targetSubtreeIds = this.collectSubtreeIds(targetId, tasks);
      
      const newTaskStage = (source.stage || 1) + 1;
      newTask.parentId = sourceId;
      newTask.stage = newTaskStage;
      
      target.parentId = taskId;
      
      targetSubtreeIds.forEach(id => {
        const t = tasks.find(task => task.id === id);
        if (t && t.stage !== null) {
          t.stage = t.stage + 1;
        }
      });
      
      const targetOriginalRank = target.rank;
      newTask.rank = targetOriginalRank;
      target.rank = newTask.rank + LAYOUT_CONFIG.RANK_STEP / 2;
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return success(undefined);
  }
  
  /**
   * 重新排序阶段内的任务
   */
  reorderStage(stage: number, orderedIds: string[]): void {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank 
        ?? this.layoutService.stageBase(stage);
      
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        
        const parentRank = this.layoutService.maxParentRank(task, tasks);
        const minChildRank = this.layoutService.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank, tasks);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
      });
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  /**
   * 分离任务（从树中移除但保留子节点）
   */
  detachTask(taskId: string): void {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = tasks.find(t => t.id === parentId);

      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent!.stage + 1;
          }
        }
      });

      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
      target.displayId = '?';

      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  /**
   * 删除任务但保留子节点
   */
  deleteTaskKeepChildren(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const target = activeP.tasks.find(t => t.id === taskId);
    if (!target) return;
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const targetTask = tasks.find(t => t.id === taskId);
      if (!targetTask) return p;
      
      const parentId = targetTask.parentId;
      const parentTask = parentId ? tasks.find(t => t.id === parentId) : null;
      
      tasks.forEach(child => {
        if (child.parentId === taskId) {
          child.parentId = parentId;
          if (parentTask?.stage !== null && parentTask?.stage !== undefined) {
            child.stage = parentTask.stage + 1;
          } else if (parentId === null) {
            child.stage = 1;
          }
        }
      });
      
      const filteredTasks = tasks.filter(t => t.id !== taskId);
      const filteredConnections = p.connections.filter(
        c => c.source !== taskId && c.target !== taskId
      );
      
      return this.layoutService.rebalance({ ...p, tasks: filteredTasks, connections: filteredConnections });
    });
  }
  
  // ========== 子树迁移操作 ==========
  
  /**
   * 将整个子任务树迁移到新的父任务下
   * 
   * 功能说明：
   * - 将指定任务及其所有后代迁移到新父任务下
   * - 自动计算 stage 偏移量并批量更新所有后代的 stage
   * - 为迁移的根任务计算新的 rank（放在新父任务的子节点末尾）
   * - 更新 connections 以反映新的父子关系
   * - 触发 rebalance 重算所有 displayId
   * 
   * @param taskId 要迁移的子树根节点 ID
   * @param newParentId 新父任务 ID（null 表示迁移到 stage 1 根节点）
   * @returns Result 包含成功或错误信息
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }
    
    const targetTask = activeP.tasks.find(t => t.id === taskId);
    if (!targetTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '要迁移的任务不存在');
    }
    
    const oldParentId = targetTask.parentId;
    
    // 如果新旧父节点相同，无需操作
    if (oldParentId === newParentId) {
      return success(undefined);
    }
    
    // 检查循环依赖：新父节点不能是目标任务的后代
    if (newParentId && this.layoutService.detectCycle(taskId, newParentId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法迁移：目标父任务是当前任务的后代，会产生循环依赖');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }
      
      const newParent = newParentId ? tasks.find(t => t.id === newParentId) : null;
      
      // 计算 stage 偏移量
      const oldStage = target.stage ?? 1;
      let newStage: number;
      
      if (newParentId === null) {
        // 迁移到根节点（stage 1）
        newStage = 1;
      } else if (newParent) {
        // 新父节点的下一级
        newStage = (newParent.stage ?? 0) + 1;
      } else {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '新父任务不存在');
        return p;
      }
      
      const stageOffset = newStage - oldStage;
      
      // 收集子树所有任务 ID
      const subtreeIds = this.collectSubtreeIds(taskId, tasks);
      
      // 更新子树中所有任务的 stage
      const now = new Date().toISOString();
      subtreeIds.forEach(id => {
        const t = tasks.find(task => task.id === id);
        if (t && t.stage !== null) {
          t.stage = t.stage + stageOffset;
          t.updatedAt = now;
        }
      });
      
      // 更新目标任务的 parentId
      target.parentId = newParentId;
      target.updatedAt = now;
      
      // 计算新的 rank：放在新父任务的子节点末尾
      const siblings = tasks.filter(t => 
        t.parentId === newParentId && 
        t.id !== taskId && 
        !t.deletedAt
      );
      
      if (newParentId === null) {
        // 根节点：找 stage 1 的根任务
        const stage1Roots = tasks.filter(t => 
          t.stage === 1 && 
          !t.parentId && 
          t.id !== taskId && 
          !t.deletedAt
        ).sort((a, b) => a.rank - b.rank);
        
        if (stage1Roots.length > 0) {
          const lastRoot = stage1Roots[stage1Roots.length - 1];
          target.rank = lastRoot.rank + LAYOUT_CONFIG.RANK_STEP;
        } else {
          target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE;
        }
      } else if (newParent) {
        // 有父节点：rank 必须大于父节点，且放在兄弟节点末尾
        const siblingsSorted = siblings.sort((a, b) => a.rank - b.rank);
        const parentRank = newParent.rank;
        
        if (siblingsSorted.length > 0) {
          const lastSibling = siblingsSorted[siblingsSorted.length - 1];
          target.rank = Math.max(parentRank + LAYOUT_CONFIG.RANK_STEP, lastSibling.rank + LAYOUT_CONFIG.RANK_STEP);
        } else {
          target.rank = parentRank + LAYOUT_CONFIG.RANK_STEP;
        }
      }
      
      // 确保子树中所有任务的 rank 约束正确（子节点 rank > 父节点 rank）
      this.fixSubtreeRanks(taskId, tasks);
      
      // 更新 connections：移除旧的父子连接，添加新的父子连接
      let connections = [...p.connections];
      
      // 移除旧的父子连接（如果存在）
      if (oldParentId) {
        connections = connections.filter(c => 
          !(c.source === oldParentId && c.target === taskId)
        );
      }
      
      // 添加新的父子连接（如果新父节点存在）
      if (newParentId) {
        const existingConn = connections.find(c => 
          c.source === newParentId && c.target === taskId
        );
        if (!existingConn) {
          connections.push({
            id: crypto.randomUUID(),
            source: newParentId,
            target: taskId
          });
        }
      }
      
      return this.layoutService.rebalance({ ...p, tasks, connections });
    });
    
    return operationResult;
  }
  
  /**
   * 级联更新子任务的 stage
   * 当父任务移动到新阶段时，所有子任务的 stage 需要同步更新为 parentStage + 1
   * 使用迭代算法避免栈溢出（符合 AGENTS.md 中的 MAX_TREE_DEPTH 限制要求）
   */
  private cascadeUpdateChildrenStage(parentId: string, parentNewStage: number, tasks: Task[]): void {
    const MAX_DEPTH = 500; // 与 LayoutService 保持一致
    const queue: { taskId: string; parentStage: number; depth: number }[] = [];
    
    // 获取父任务的直接子节点
    const directChildren = tasks.filter(t => t.parentId === parentId && !t.deletedAt);
    directChildren.forEach(child => {
      queue.push({ taskId: child.id, parentStage: parentNewStage, depth: 1 });
    });
    
    let iterations = 0;
    const maxIterations = tasks.length * 10;
    
    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const { taskId, parentStage, depth } = queue.shift()!;
      
      if (depth > MAX_DEPTH) {
        console.warn('[CascadeStage] 树深度超过限制，可能存在数据问题', { taskId, depth });
        continue;
      }
      
      const child = tasks.find(t => t.id === taskId);
      if (!child) continue;
      
      const expectedStage = parentStage + 1;
      if (child.stage !== expectedStage) {
        console.log('[CascadeStage] 更新子任务 stage:', {
          taskId: taskId.slice(-4),
          oldStage: child.stage,
          newStage: expectedStage
        });
        child.stage = expectedStage;
      }
      
      // 继续处理孙子节点
      const grandChildren = tasks.filter(t => t.parentId === taskId && !t.deletedAt);
      grandChildren.forEach(gc => {
        queue.push({ taskId: gc.id, parentStage: expectedStage, depth: depth + 1 });
      });
    }
    
    if (iterations >= maxIterations) {
      console.error('[CascadeStage] 迭代次数超限，可能存在循环依赖');
    }
  }
  
  /**
   * 修复子树中所有任务的 rank 约束
   * 确保子节点的 rank 始终大于父节点的 rank
   */
  private fixSubtreeRanks(rootId: string, tasks: Task[]): void {
    const stack: { taskId: string; parentRank: number }[] = [];
    const rootTask = tasks.find(t => t.id === rootId);
    if (!rootTask) return;
    
    // 获取根任务的直接子节点
    const rootChildren = tasks.filter(t => t.parentId === rootId && !t.deletedAt);
    rootChildren.forEach(child => {
      stack.push({ taskId: child.id, parentRank: rootTask.rank });
    });
    
    let iterations = 0;
    const maxIterations = tasks.length * 10;
    
    while (stack.length > 0 && iterations < maxIterations) {
      iterations++;
      const { taskId, parentRank } = stack.pop()!;
      const task = tasks.find(t => t.id === taskId);
      if (!task) continue;
      
      // 确保子节点 rank > 父节点 rank
      if (task.rank <= parentRank) {
        task.rank = parentRank + LAYOUT_CONFIG.RANK_STEP;
      }
      
      // 将子节点加入栈中继续处理
      const children = tasks.filter(t => t.parentId === taskId && !t.deletedAt);
      children.forEach(child => {
        stack.push({ taskId: child.id, parentRank: task.rank });
      });
    }
  }
  
  // ========== 连接操作 ==========
  
  /**
   * 添加跨树连接
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const exists = activeP.connections.some(
      c => c.source === sourceId && c.target === targetId
    );
    if (exists) return;
    
    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    if (!sourceTask || !targetTask) return;
    
    if (sourceId === targetId) return;
    
    this.recordAndUpdate(p => ({
      ...p,
      connections: [...p.connections, { 
        id: crypto.randomUUID(),
        source: sourceId, 
        target: targetId 
      }]
    }));
  }
  
  /**
   * 移除连接（使用软删除策略）
   * 设置 deletedAt 时间戳，让同步服务可以正确同步删除状态到其他设备
   */
  removeConnection(sourceId: string, targetId: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId)
          ? { ...c, deletedAt: now }
          : c
      )
    }));
  }
  
  /**
   * 更新连接描述
   */
  updateConnectionDescription(sourceId: string, targetId: string, description: string): void {
    this.recordAndUpdateDebounced(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId) 
          ? { ...c, description } 
          : c
      )
    }));
  }
  
  // ========== 私有辅助方法 ==========
  
  private getActiveProject(): Project | null {
    return this.getActiveProjectCallback?.() ?? null;
  }
  
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.onProjectUpdateCallback?.(mutator);
  }
  
  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.onProjectUpdateDebouncedCallback?.(mutator);
  }
  
  /**
   * 直接更新项目（不记录撤销历史）
   */
  private updateActiveProjectRaw(mutator: (project: Project) => Project): void {
    // 通过 debounced 回调但不触发撤销记录
    this.onProjectUpdateCallback?.(mutator);
  }
  
  /**
   * 计算插入位置的 rank 值
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    if (result.needsRebalance) {
      this.markStageForRebalance(stage);
    }
    return result.rank;
  }
  
  /**
   * 标记某阶段需要重平衡
   */
  private markStageForRebalance(stage: number): void {
    this.stagesNeedingRebalance.add(stage);
    if (this.rebalanceTimer) {
      clearTimeout(this.rebalanceTimer);
    }
    this.rebalanceTimer = setTimeout(() => {
      this.performStageRebalance();
      this.rebalanceTimer = null;
    }, 100);
  }
  
  /**
   * 执行阶段内的 rank 重平衡
   */
  private performStageRebalance(): void {
    const activeP = this.getActiveProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = [...this.stagesNeedingRebalance];
    this.stagesNeedingRebalance.clear();
    
    stages.forEach(s => this.rebalancingStages.add(s));
    
    try {
      const rebalancedTasks = this.layoutService.rebalanceStageRanks(activeP.tasks, stages);
      
      if (rebalancedTasks !== activeP.tasks) {
        this.recordAndUpdate(p => this.layoutService.rebalance({ ...p, tasks: rebalancedTasks }));
      }
    } finally {
      stages.forEach(s => this.rebalancingStages.delete(s));
    }
  }
  
  /**
   * 应用拒绝策略
   */
  private applyRefusalStrategy(
    target: Task, 
    candidateRank: number, 
    parentRank: number | null, 
    minChildRank: number,
    allTasks: Task[]
  ): { ok: boolean; rank: number } {
    return this.layoutService.applyRefusalStrategy(target, candidateRank, parentRank, minChildRank);
  }
  
  /**
   * 收集指定任务及其所有后代的 ID
   */
  private collectSubtreeIds(taskId: string, tasks: Task[]): Set<string> {
    const result = new Set<string>();
    const stack = [taskId];
    
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      result.add(currentId);
      tasks.filter(t => t.parentId === currentId).forEach(child => {
        stack.push(child.id);
      });
    }
    
    return result;
  }
  
  /**
   * 检查插入操作是否会产生循环依赖
   */
  private wouldCreateCycle(taskId: string, sourceId: string, targetId: string, tasks: Task[]): boolean {
    let current = tasks.find(t => t.id === sourceId);
    while (current && current.parentId) {
      if (current.parentId === taskId) {
        return true;
      }
      current = tasks.find(t => t.id === current!.parentId);
    }
    
    const targetSubtree = this.collectSubtreeIds(targetId, tasks);
    if (targetSubtree.has(taskId)) {
      return true;
    }
    
    return false;
  }
}
