import { Injectable, inject } from '@angular/core';
import { Task, Project, Connection } from '../models';
import { ToastService } from './toast.service';
import { LAYOUT_CONFIG, LETTERS } from '../config/constants';

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
    // 空项目直接返回
    if (!project.tasks || project.tasks.length === 0) {
      return project;
    }
    
    const tasks = project.tasks.map(t => ({ ...t }));

    // displayId/树结构相关计算应以“可见任务”为准：
    // - deletedAt（回收站）任务不应占用编号
    // - archived（归档）任务在主视图中也不应占用编号
    const isVisibleTask = (t: Task) => !t.deletedAt && t.status !== 'archived';
    
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

    // 🔴 修复：收集所有阶段的根任务（没有 parentId 的已分配任务）
    // 按阶段分组，确保每个阶段的根任务都能被遍历到
    const allRoots = tasks
      .filter(t => t.stage !== null && !t.parentId && isVisibleTask(t))
      .sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0) || a.rank - b.rank);
    
    // 为 stage 1 的根任务分配主编号
    const stage1Roots = allRoots.filter(t => t.stage === 1);
    stage1Roots.forEach((t, idx) => {
      t.displayId = `${idx + 1}`;
    });
    
    // 为其他阶段的根任务（孤儿任务）分配特殊编号
    // 这些任务没有父节点但不在 stage 1，可能是被分配到中间阶段的浮动树根
    const orphanRoots = allRoots.filter(t => t.stage !== 1);
    orphanRoots.forEach((t, idx) => {
      // 使用 "O" 前缀表示孤儿任务（Orphan）
      t.displayId = `O${idx + 1}`;
    });

    const children = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId && isVisibleTask(t)) {
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
          // 强制子任务 stage = parent.stage + 1
          // 修复原逻辑只处理 child.stage <= parent.stage 的情况，
          // 现在无论子任务在什么阶段，都强制修正为正确的阶段
          if (parent.stage !== null && child.stage !== parent.stage + 1) {
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

    // 🔴 遍历所有根任务（包括所有阶段的孤儿任务）
    allRoots.forEach(t => assignChildrenIterative(t.id));

    tasks.forEach(t => {
      if (!t.displayId) t.displayId = '?';
      if (t.stage === null) {
        // 🔴 浮动任务树：保留待分配区的父子关系
        // 不再强制清除 parentId，待分配区可以构建完整的任务树
        t.displayId = '?';
      }
    });

    const childrenMap = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId && isVisibleTask(t)) {
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
   * 
   * 【浮动任务树增强】
   * - 如果有父节点且父节点也在待分配区，放在父节点附近
   * - 否则使用网格布局
   * 
   * @param existingCount 已存在的未分配任务数量
   * @param parentId 父节点ID（可选）
   * @param tasks 所有任务（可选，用于查找父节点位置）
   */
  getUnassignedPosition(
    existingCount: number, 
    parentId?: string | null, 
    tasks?: Task[]
  ): { x: number; y: number } {
    // 如果有父节点且父节点也在待分配区，放在父节点附近
    if (parentId && tasks) {
      const parent = tasks.find(t => t.id === parentId);
      if (parent && parent.stage === null && parent.x !== undefined && parent.y !== undefined) {
        // 计算该父节点已有多少个子节点（用于垂直偏移）
        const siblingCount = tasks.filter(t => t.parentId === parentId && t.stage === null).length;
        return {
          x: parent.x + 180,  // 父节点右侧
          y: parent.y + siblingCount * 60  // 每个子节点垂直间隔 60px
        };
      }
    }
    
    // 默认网格布局
    const cols = 3; // 每行3个
    const row = Math.floor(existingCount / cols);
    const col = existingCount % cols;
    
    return {
      x: 80 + col * 180,
      y: 80 + row * 120
    };
  }

  /**
   * 智能计算新节点位置
   * 考虑同一阶段现有节点的实际位置，使新节点出现在附近
   * 
   * @param stage 目标阶段
   * @param index 节点在该阶段的索引
   * @param existingTasks 所有已存在的任务
   * @param parentId 父节点ID（如果有）
   * @returns 新节点的坐标
   */
  getSmartPosition(
    stage: number | null,
    index: number,
    existingTasks: Task[],
    parentId?: string | null
  ): { x: number; y: number } {
    // 未分配任务，使用增强的位置计算（支持父子关系）
    if (stage === null) {
      return this.getUnassignedPosition(
        existingTasks.filter(t => t.stage === null).length,
        parentId,
        existingTasks
      );
    }


    // 获取同一阶段的所有可见任务（排除已删除和归档的）
    const sameStageTasks = existingTasks.filter(
      t => t.stage === stage && !t.deletedAt && t.status !== 'archived'
    );

    // 如果有父节点，优先考虑父节点的位置
    if (parentId) {
      const parent = existingTasks.find(t => t.id === parentId);
      if (parent && parent.x !== undefined && parent.y !== undefined) {
        // 在父节点右侧偏下方创建
        return {
          x: parent.x + LAYOUT_CONFIG.STAGE_SPACING,
          y: parent.y + (index * 60) // 每个子节点垂直间隔60
        };
      }
    }

    // 如果该阶段已有节点，找到最后一个节点的位置
    if (sameStageTasks.length > 0) {
      // 按 y 坐标排序，找到最下方的节点
      const sortedTasks = sameStageTasks
        .filter(t => t.x !== undefined && t.y !== undefined)
        .sort((a, b) => (a.y || 0) - (b.y || 0));
      
      if (sortedTasks.length > 0) {
        const lastTask = sortedTasks[sortedTasks.length - 1];
        // 在最后一个节点下方创建
        return {
          x: lastTask.x || this.gridPosition(stage, index).x,
          y: (lastTask.y || 0) + LAYOUT_CONFIG.ROW_SPACING
        };
      }
    }

    // 如果该阶段没有节点，查找相邻阶段的节点位置作为参考
    const prevStageTasks = existingTasks.filter(
      t => t.stage === stage - 1 && !t.deletedAt && t.status !== 'archived' &&
           t.x !== undefined && t.y !== undefined
    );
    
    if (prevStageTasks.length > 0) {
      // 计算前一阶段节点的平均 Y 坐标
      const avgY = prevStageTasks.reduce((sum, t) => sum + (t.y || 0), 0) / prevStageTasks.length;
      return {
        x: (stage - 1) * LAYOUT_CONFIG.STAGE_SPACING + 120,
        y: avgY + (index * 60) // 使用前一阶段的平均高度，每个新节点偏移60
      };
    }

    // 兜底：使用固定网格位置
    return this.gridPosition(stage, index);
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
          stage: t.stage ?? 1,
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
