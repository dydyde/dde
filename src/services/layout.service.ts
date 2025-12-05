import { Injectable, inject } from '@angular/core';
import { Task, Project, Connection } from '../models';
import { LAYOUT_CONFIG, LETTERS } from '../config/constants';
import { ToastService } from './toast.service';

/**
 * 布局算法配置
 */
const ALGORITHM_CONFIG = {
  /** 最大树深度限制（防止栈溢出） */
  MAX_TREE_DEPTH: 500,
  /** 基础最大迭代次数 */
  BASE_MAX_ITERATIONS: 10000,
  /** 每个任务增加的迭代次数 */
  ITERATIONS_PER_TASK: 100,
} as const;

/**
 * 计算动态迭代限制
 * 根据任务数量动态调整，确保大型项目能正常处理
 */
function calculateMaxIterations(taskCount: number): number {
  return Math.max(
    ALGORITHM_CONFIG.BASE_MAX_ITERATIONS,
    taskCount * ALGORITHM_CONFIG.ITERATIONS_PER_TASK
  );
}

/**
 * 布局服务
 * 负责任务排序、层级计算、重平衡等纯算法逻辑
 * 从 StoreService 中抽离，实现关注点分离
 * 
 * 改进：
 * - 所有递归算法改为基于栈的迭代算法
 * - 添加最大深度限制防止栈溢出
 * - 添加迭代次数限制防止死循环
 */
@Injectable({
  providedIn: 'root'
})
export class LayoutService {
  private toast = inject(ToastService);
  
  /** 是否已显示过迭代超限警告（避免重复提示） */
  private hasShownIterationWarning = false;

  // ========== 公共方法 ==========

  /**
   * 重平衡项目中所有任务的层级和排序
   * 这是核心的布局算法，确保任务树的一致性
   */
  rebalance(project: Project): Project {
    const tasks = project.tasks.map(t => ({ ...t }));
    
    // DEBUG: 追踪传入的任务
    const stage1Count = tasks.filter(t => t.stage === 1).length;
    const stage1RootCount = tasks.filter(t => t.stage === 1 && !t.parentId).length;
    
    // 如果没有 stage 1 根任务但有其他任务，打印警告和调用栈
    if (stage1RootCount === 0 && tasks.length > 0) {
      console.warn('[rebalance] WARNING: No stage 1 roots found!', {
        totalTasks: tasks.length,
        stage1Tasks: stage1Count,
        projectId: project.id?.slice(-4),
        taskSample: tasks.slice(0, 3).map(t => `${t.title || 'untitled'}(stage=${t.stage})`)
      });
      console.trace('[rebalance] Call stack');
    }
    
    const byId = new Map<string, Task>();
    tasks.forEach(t => byId.set(t.id, t));

    // 为没有 shortId 的任务生成短 ID
    tasks.forEach(t => {
      if (!t.shortId) {
        t.shortId = this.generateShortId(tasks);
      }
    });

    tasks.forEach(t => {
      if (t.rank === undefined || t.rank === null) {
        const base = t.stage ? this.stageBase(t.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
        t.rank = base + (t.order || 0) * LAYOUT_CONFIG.RANK_STEP;
      }
      t.hasIncompleteTask = this.detectIncomplete(t.content);
    });

    tasks.forEach(t => {
      if (t.parentId) {
        const parent = byId.get(t.parentId);
        if (parent && parent.stage !== null) {
          if (t.stage === null || t.stage <= parent.stage) {
            t.stage = parent.stage + 1;
          }
          if (t.rank <= parent.rank) {
            t.rank = parent.rank + LAYOUT_CONFIG.RANK_STEP;
          }
        }
      }
    });

    const grouped = new Map<number, Task[]>();
    tasks.forEach(t => {
      if (t.stage !== null) {
        if (!grouped.has(t.stage)) grouped.set(t.stage, []);
        grouped.get(t.stage)!.push(t);
      }
    });

    grouped.forEach((list, stage) => {
      list.sort((a, b) => a.rank - b.rank || a.order - b.order);
      list.forEach((t, idx) => {
        t.order = idx + 1;
        if (t.x === undefined || t.y === undefined) {
          const pos = this.gridPosition(stage, idx);
          t.x = pos.x;
          t.y = pos.y;
        }
      });
    });

    const unassigned = tasks.filter(t => t.stage === null).sort((a, b) => a.rank - b.rank || a.order - b.order);
    unassigned.forEach((t, idx) => {
      t.order = idx + 1;
      t.displayId = '?';
    });

    tasks.forEach(t => byId.set(t.id, t));

    const stage1Roots = tasks
      .filter(t => t.stage === 1 && !t.parentId)
      .sort((a, b) => a.rank - b.rank);

    stage1Roots.forEach((t, idx) => {
      t.displayId = `${idx + 1}`;
    });

    const children = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!children.has(t.parentId)) children.set(t.parentId, []);
        children.get(t.parentId)!.push(t);
      }
    });

    // 使用迭代算法分配 displayId（替代递归）
    const assignChildrenIterative = (rootId: string) => {
      const stack: { parentId: string; depth: number }[] = [{ parentId: rootId, depth: 0 }];
      let iterations = 0;
      const maxIterations = calculateMaxIterations(tasks.length);
      
      while (stack.length > 0 && iterations < maxIterations) {
        iterations++;
        const { parentId, depth } = stack.pop()!;
        
        if (depth > ALGORITHM_CONFIG.MAX_TREE_DEPTH) {
          console.warn('树深度超过限制，可能存在数据问题', { parentId, depth });
          continue;
        }
        
        const parent = byId.get(parentId);
        if (!parent) continue;
        
        const childList = (children.get(parentId) || []).sort((a, b) => a.rank - b.rank);
        
        childList.forEach((child, idx) => {
          if (parent.stage !== null && (child.stage === null || child.stage <= parent.stage)) {
            child.stage = parent.stage + 1;
          }
          const letter = LETTERS[idx % LETTERS.length];
          child.displayId = `${parent.displayId},${letter}`;
          
          // 将子节点加入栈中继续处理
          stack.push({ parentId: child.id, depth: depth + 1 });
        });
      }
      
      if (iterations >= maxIterations) {
        console.error('displayId 分配迭代次数超限，可能存在循环依赖');
        this.notifyIterationLimit('displayId 分配');
      }
    };

    stage1Roots.forEach(t => assignChildrenIterative(t.id));

    tasks.forEach(t => {
      if (!t.displayId) t.displayId = '?';
      if (t.stage === null) {
        t.parentId = null;
        t.displayId = '?';
      }
    });

    const childrenMap = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId)!.push(t);
      }
    });

    // 使用迭代算法级联更新 rank（替代递归）
    const cascadeIterative = (rootId: string) => {
      // 使用队列进行广度优先遍历
      const queue: { nodeId: string; floor: number; depth: number }[] = [];
      const rootTask = tasks.find(t => t.id === rootId);
      if (!rootTask) return;
      
      queue.push({ nodeId: rootId, floor: rootTask.rank, depth: 0 });
      let iterations = 0;
      const maxIterations = calculateMaxIterations(tasks.length);
      
      while (queue.length > 0 && iterations < maxIterations) {
        iterations++;
        const { nodeId, floor: parentFloor, depth } = queue.shift()!;
        
        if (depth > ALGORITHM_CONFIG.MAX_TREE_DEPTH) {
          console.warn('级联更新深度超过限制', { nodeId, depth });
          continue;
        }
        
        const kids = (childrenMap.get(nodeId) || []).sort((a, b) => a.rank - b.rank);
        let currentFloor = parentFloor;
        
        kids.forEach(child => {
          if (child.rank <= currentFloor) {
            child.rank = currentFloor + LAYOUT_CONFIG.RANK_STEP;
          }
          currentFloor = child.rank;
          queue.push({ nodeId: child.id, floor: child.rank, depth: depth + 1 });
        });
      }
      
      if (iterations >= maxIterations) {
        console.error('级联更新迭代次数超限');
        this.notifyIterationLimit('级联更新');
      }
    };

    stage1Roots.forEach(root => cascadeIterative(root.id));

    tasks
      .filter(t => t.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || a.rank - b.rank)
      .forEach((t, idx, arr) => {
        const sameStage = arr.filter(s => s.stage === t.stage);
        const position = sameStage.findIndex(s => s.id === t.id);
        t.order = position + 1;
      });

    // DEBUG: 验证返回的任务是否都有正确的 displayId
    const finalStage1Roots = tasks.filter(t => t.stage === 1 && !t.parentId);
    const invalidFinalRoots = finalStage1Roots.filter(t => t.displayId === '?' || !t.displayId);
    if (invalidFinalRoots.length > 0) {
      console.error('[rebalance] RETURN - Stage 1 roots STILL have invalid displayId:', 
        invalidFinalRoots.map(t => ({ id: t.id.slice(-4), displayId: t.displayId, title: t.title || 'untitled' }))
      );
    }

    return { ...project, tasks };
  }

  /**
   * 计算网格位置
   */
  gridPosition(stage: number, index: number) {
    return {
      x: (stage - 1) * LAYOUT_CONFIG.STAGE_SPACING + 120,
      y: 100 + index * LAYOUT_CONFIG.ROW_SPACING
    };
  }

  /**
   * 计算未分配任务的位置
   * 使用网格布局而非随机位置，便于管理
   */
  getUnassignedPosition(existingCount: number): { x: number; y: number } {
    const cols = 3; // 每行3个
    const row = Math.floor(existingCount / cols);
    const col = existingCount % cols;
    
    return {
      x: 80 + col * 180,
      y: 80 + row * 120
    };
  }

  /**
   * 计算阶段的基础 rank 值
   */
  stageBase(stage: number) {
    return LAYOUT_CONFIG.RANK_ROOT_BASE + (stage - 1) * LAYOUT_CONFIG.RANK_ROOT_BASE;
  }

  /**
   * 计算插入位置的 rank 值
   */
  computeInsertRank(
    stage: number, 
    siblings: Task[], 
    beforeId?: string | null, 
    parentRank?: number | null
  ): { rank: number; needsRebalance: boolean } {
    const sorted = siblings.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
    const base = parentRank !== null && parentRank !== undefined 
      ? parentRank + LAYOUT_CONFIG.RANK_STEP 
      : this.stageBase(stage);
    
    let prev: Task | null = null;
    let next: Task | null = null;
    
    if (beforeId) {
      const idx = sorted.findIndex(t => t.id === beforeId);
      if (idx >= 0) {
        next = sorted[idx];
        prev = idx > 0 ? sorted[idx - 1] : null;
      }
    }
    if (!beforeId || !next) {
      prev = sorted[sorted.length - 1] || null;
      next = null;
    }

    let rank: number;
    let needsRebalance = false;
    
    if (prev && next) {
      rank = (prev.rank + next.rank) / 2;
      // 检测间隔是否过小
      const gap = next.rank - prev.rank;
      if (gap < LAYOUT_CONFIG.RANK_MIN_GAP) {
        needsRebalance = true;
      }
    } else if (prev && !next) {
      rank = prev.rank + LAYOUT_CONFIG.RANK_STEP;
    } else if (!prev && next) {
      rank = next.rank - LAYOUT_CONFIG.RANK_STEP;
    } else {
      rank = base;
    }

    return { rank, needsRebalance };
  }

  /**
   * 获取父节点的最大 rank
   */
  maxParentRank(task: Task | null, tasks: Task[]): number | null {
    if (!task?.parentId) return null;
    const parent = tasks.find(t => t.id === task.parentId);
    return parent ? parent.rank : null;
  }

  /**
   * 获取子节点的最小 rank
   */
  minChildRank(taskId: string, tasks: Task[]): number {
    const children = tasks.filter(t => t.parentId === taskId);
    if (children.length === 0) return Infinity;
    return Math.min(...children.map(c => c.rank));
  }

  /**
   * 应用拒绝策略（确保 rank 不违反父子约束）
   */
  applyRefusalStrategy(
    target: Task, 
    candidateRank: number, 
    parentRank: number | null, 
    minChildRank: number
  ): { ok: boolean; rank: number } {
    let nextRank = candidateRank;
    
    if (parentRank !== null && nextRank <= parentRank) {
      nextRank = parentRank + LAYOUT_CONFIG.RANK_STEP;
    }
    if (Number.isFinite(minChildRank) && nextRank >= minChildRank) {
      nextRank = minChildRank - LAYOUT_CONFIG.RANK_STEP;
    }
    
    const violatesParent = parentRank !== null && nextRank <= parentRank;
    const violatesChild = Number.isFinite(minChildRank) && nextRank >= minChildRank;
    
    if (violatesParent || violatesChild) {
      console.warn('Refused ordering: violates parent/child constraints', {
        taskId: target.id,
        parentRank,
        minChildRank,
        requested: candidateRank
      });
      return { ok: false, rank: candidateRank };
    }
    return { ok: true, rank: nextRank };
  }

  /**
   * 检测循环依赖（使用迭代算法）
   */
  detectCycle(taskId: string, newParentId: string | null, tasks: Task[]): boolean {
    if (!newParentId) return false;
    if (taskId === newParentId) return true;
    
    const visited = new Set<string>();
    let current: string | null = newParentId;
    let iterations = 0;
    const maxIterations = calculateMaxIterations(tasks.length);
    
    while (current && iterations < maxIterations) {
      iterations++;
      
      if (visited.has(current)) return true;
      if (current === taskId) return true;
      visited.add(current);
      
      const parentTask = tasks.find(t => t.id === current);
      current = parentTask?.parentId || null;
    }
    
    if (iterations >= maxIterations) {
      console.error('循环检测迭代次数超限，假定存在循环');
      this.notifyIterationLimit('循环检测');
      return true;
    }
    
    return false;
  }

  /**
   * 检测内容中是否有未完成的待办项
   */
  detectIncomplete(content: string): boolean {
    return /- \[ \]/.test(content || '');
  }
  
  /**
   * 通知用户迭代超限
   * 使用防抖避免多次弹窗
   */
  private notifyIterationLimit(operation: string): void {
    if (this.hasShownIterationWarning) return;
    
    this.hasShownIterationWarning = true;
    this.toast.warning(
      '数据结构异常',
      `${operation}过程中检测到异常，可能存在循环依赖。建议检查任务的父子关系。`
    );
    
    // 5秒后重置，允许再次显示
    setTimeout(() => {
      this.hasShownIterationWarning = false;
    }, 5000);
  }

  /**
   * 生成永久短 ID
   * 格式: NF-XXXX (X 为大写字母或数字)
   */
  generateShortId(existingTasks: Task[]): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const existingIds = new Set(existingTasks.map(t => t.shortId).filter(Boolean));
    
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      let id = 'NF-';
      for (let i = 0; i < 4; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      if (!existingIds.has(id)) {
        return id;
      }
      attempts++;
    }
    
    return `NF-${Date.now().toString(36).toUpperCase().slice(-4)}`;
  }

  /**
   * 重新平衡指定阶段的 rank 值
   * 将阶段内的任务 rank 重新均匀分布
   */
  rebalanceStageRanks(tasks: Task[], stages: number[]): Task[] {
    const result = tasks.map(t => ({ ...t }));
    
    for (const stage of stages) {
      const stageTasks = result.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
      if (stageTasks.length < 2) continue;
      
      const base = this.stageBase(stage);
      stageTasks.forEach((t, idx) => {
        const taskInResult = result.find(task => task.id === t.id);
        if (taskInResult) {
          taskInResult.rank = base + (idx + 1) * LAYOUT_CONFIG.RANK_STEP;
        }
      });
    }
    
    return result;
  }

  // ========== 数据完整性检查 ==========

  /**
   * 修复孤儿节点
   * 检查并修复 parentId 指向不存在任务的情况
   */
  fixOrphanedTasks(tasks: Task[]): { tasks: Task[]; fixed: number } {
    const taskIds = new Set(tasks.map(t => t.id));
    let fixedCount = 0;
    
    const fixedTasks = tasks.map(t => {
      if (t.parentId && !taskIds.has(t.parentId)) {
        console.warn('Found orphaned task, resetting parent', { taskId: t.id, invalidParentId: t.parentId });
        fixedCount++;
        return {
          ...t,
          parentId: null,
          stage: 1, // 将孤儿节点移动到第一阶段
          displayId: '?'
        };
      }
      return t;
    });
    
    return { tasks: fixedTasks, fixed: fixedCount };
  }

  /**
   * 完整的树结构健康检查
   * 包括循环检测、孤儿修复、rank 验证
   */
  validateAndFixTree(project: Project): { project: Project; issues: string[] } {
    const issues: string[] = [];
    let tasks = [...project.tasks];
    
    // 1. 修复孤儿节点
    const orphanResult = this.fixOrphanedTasks(tasks);
    tasks = orphanResult.tasks;
    if (orphanResult.fixed > 0) {
      issues.push(`修复了 ${orphanResult.fixed} 个孤儿任务`);
    }
    
    // 2. 检测并修复循环依赖
    const cycleResult = this.detectAndFixCycles(tasks);
    tasks = cycleResult.tasks;
    if (cycleResult.fixed > 0) {
      issues.push(`修复了 ${cycleResult.fixed} 个循环依赖`);
    }
    
    // 3. 验证并修复 rank 值
    const rankResult = this.validateRanks(tasks);
    tasks = rankResult.tasks;
    if (rankResult.fixed > 0) {
      issues.push(`修复了 ${rankResult.fixed} 个无效 rank 值`);
    }
    
    // 4. 验证连接的有效性
    const connections = this.validateConnections(project.connections, tasks);
    if (connections.removed > 0) {
      issues.push(`移除了 ${connections.removed} 个无效连接`);
    }
    
    return {
      project: {
        ...project,
        tasks,
        connections: connections.valid
      },
      issues
    };
  }

  /**
   * 检测并修复循环依赖
   */
  private detectAndFixCycles(tasks: Task[]): { tasks: Task[]; fixed: number } {
    const result = tasks.map(t => ({ ...t }));
    let fixedCount = 0;
    
    // 使用 DFS 检测循环
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycle = (taskId: string): boolean => {
      if (recursionStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      
      visited.add(taskId);
      recursionStack.add(taskId);
      
      const task = result.find(t => t.id === taskId);
      if (task?.parentId && hasCycle(task.parentId)) {
        return true;
      }
      
      recursionStack.delete(taskId);
      return false;
    };
    
    // 检查每个任务
    for (const task of result) {
      visited.clear();
      recursionStack.clear();
      
      if (task.parentId && hasCycle(task.id)) {
        console.warn('Detected cycle, breaking at', { taskId: task.id, parentId: task.parentId });
        task.parentId = null;
        task.stage = 1;
        task.displayId = '?';
        fixedCount++;
      }
    }
    
    return { tasks: result, fixed: fixedCount };
  }

  /**
   * 验证并修复 rank 值
   */
  private validateRanks(tasks: Task[]): { tasks: Task[]; fixed: number } {
    const result = tasks.map(t => ({ ...t }));
    let fixedCount = 0;
    
    for (const task of result) {
      // 检查 NaN 或 Infinity
      if (!Number.isFinite(task.rank)) {
        const base = task.stage ? this.stageBase(task.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
        task.rank = base + (task.order || 0) * LAYOUT_CONFIG.RANK_STEP;
        fixedCount++;
        console.warn('Fixed invalid rank', { taskId: task.id, newRank: task.rank });
      }
      
      // 检查 rank 是否在合理范围内
      if (task.rank < 0 || task.rank > 1000000000) {
        const base = task.stage ? this.stageBase(task.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
        task.rank = base + (task.order || 0) * LAYOUT_CONFIG.RANK_STEP;
        fixedCount++;
      }
    }
    
    return { tasks: result, fixed: fixedCount };
  }

  /**
   * 验证连接的有效性
   */
  private validateConnections(
    connections: Connection[], 
    tasks: Task[]
  ): { valid: Connection[]; removed: number } {
    const taskIds = new Set(tasks.map(t => t.id));
    const valid: Connection[] = [];
    let removed = 0;
    
    for (const conn of connections) {
      if (taskIds.has(conn.source) && taskIds.has(conn.target)) {
        // 检查是否为自引用
        if (conn.source !== conn.target) {
          valid.push(conn);
        } else {
          removed++;
        }
      } else {
        removed++;
      }
    }
    
    return { valid, removed };
  }
}
