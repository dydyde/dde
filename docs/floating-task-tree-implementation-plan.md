# 浮动任务树（Floating Task Tree）工程实施计划书

> **版本**: v2.0 - 完整闭环方案  
> **日期**: 2024-12-23  
> **状态**: 待实施

---

## 一、项目概述

### 1.1 核心目标

将待分配区从扁平的"停机坪"升级为能容纳复杂结构的"苗圃"，支持：

1. **待分配区内构建任务树** - 在分配到阶段前预先组织结构
2. **整树级联分配** - 父任务分配时，子树整体迁移
3. **子树拆分分配** - 可单独分配子树的任意分支
4. **整树级联回收** - 移回待分配时保留完整树结构

### 1.2 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| MAX_STAGE 策略 | 动态计算（当前最大 stage + N） | 灵活适应不同项目规模，N=10 作为缓冲 |
| 跨边界操作 UX | B: 弹窗确认级联分配 | 明确用户意图，避免误操作 |
| 并发控制 | LWW (Last-Write-Wins) | 单用户场景风险低，实现简单 |

---

## 二、核心不变性约束（Invariants）

### 2.1 同源不变性（Homogeneous Tree Invariant）

```
规则：如果 Parent.stage === null，则所有 Children.stage 必须 === null
规则：如果 Parent.stage === N (N >= 1)，则 Children.stage 必须 === N+1
```

**违反此规则的操作必须被拒绝或触发级联更新。**

### 2.2 阶段边界不变性（Stage Boundary Invariant）

```
规则：任何任务的 stage 不得超过 MAX_STAGE_INDEX
规则：MAX_STAGE_INDEX = max(当前所有任务.stage) + STAGE_BUFFER
常量：STAGE_BUFFER = 10
```

### 2.3 无循环不变性（Acyclic Invariant）

```
规则：parentId 链不得形成闭环
实现：复用现有 detectCycle() 方法
```

---

## 三、实施阶段

### Phase 1: 基础设施（预计 2h）

#### 1.1 新增错误码和常量

**文件**: `src/utils/result.ts`

```typescript
export const ErrorCodes = {
  // ...existing codes...
  
  // 新增：浮动任务树相关
  STAGE_OVERFLOW: 'STAGE_OVERFLOW',           // 阶段溢出
  CROSS_BOUNDARY_VIOLATION: 'CROSS_BOUNDARY_VIOLATION',  // 跨边界违规
} as const;

export const ErrorMessages: Record<ErrorCode, string> = {
  // ...existing messages...
  [ErrorCodes.STAGE_OVERFLOW]: '操作被拦截：子任务将超出最大阶段限制',
  [ErrorCodes.CROSS_BOUNDARY_VIOLATION]: '非法操作：不能跨越待分配/已分配边界建立父子关系',
};
```

**文件**: `src/config/constants.ts`

```typescript
/**
 * 浮动任务树配置
 */
export const FLOATING_TREE_CONFIG = {
  /** 阶段缓冲区大小：允许的最大阶段 = 当前最大阶段 + STAGE_BUFFER */
  STAGE_BUFFER: 10,
  /** 子树最大深度（防止无限递归） */
  MAX_SUBTREE_DEPTH: 100,
} as const;
```

#### 1.2 新增辅助方法

**文件**: `src/services/task-operation.service.ts`

```typescript
/**
 * 计算子树深度
 */
private getSubtreeDepth(taskId: string, tasks: Task[]): number {
  let maxDepth = 0;
  const stack: { id: string; depth: number }[] = [{ id: taskId, depth: 0 }];
  
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    maxDepth = Math.max(maxDepth, depth);
    
    tasks.filter(t => t.parentId === id && !t.deletedAt)
      .forEach(child => stack.push({ id: child.id, depth: depth + 1 }));
  }
  
  return maxDepth;
}

/**
 * 获取动态最大阶段索引
 */
private getMaxStageIndex(tasks: Task[]): number {
  const currentMax = Math.max(
    ...tasks.filter(t => t.stage !== null && !t.deletedAt).map(t => t.stage!),
    0
  );
  return currentMax + FLOATING_TREE_CONFIG.STAGE_BUFFER;
}

/**
 * 验证阶段容量（阶段溢出预检查）
 */
private validateStageCapacity(
  taskId: string,
  targetStage: number,
  tasks: Task[]
): Result<void, OperationError> {
  const subtreeDepth = this.getSubtreeDepth(taskId, tasks);
  const maxStageIndex = this.getMaxStageIndex(tasks);
  
  if (targetStage + subtreeDepth > maxStageIndex) {
    return failure(
      ErrorCodes.STAGE_OVERFLOW,
      `操作被拦截：子任务将超出最大阶段限制（需要 ${targetStage + subtreeDepth}，最大 ${maxStageIndex}）`,
      { requiredStage: targetStage + subtreeDepth, maxStage: maxStageIndex }
    );
  }
  
  return success(undefined);
}

/**
 * 验证父子阶段一致性（同源不变性）
 */
private validateParentChildStageConsistency(
  parentId: string | null,
  childStage: number | null,
  tasks: Task[]
): Result<void, OperationError> {
  if (!parentId) return success(undefined);
  
  const parent = tasks.find(t => t.id === parentId);
  if (!parent) return success(undefined);
  
  const parentIsUnassigned = parent.stage === null;
  const childIsUnassigned = childStage === null;
  
  // 同源检查：父子必须同为已分配或同为未分配
  if (parentIsUnassigned !== childIsUnassigned) {
    return failure(
      ErrorCodes.CROSS_BOUNDARY_VIOLATION,
      '非法操作：父任务和子任务必须同时在待分配区或同时在阶段中',
      { parentStage: parent.stage, childStage }
    );
  }
  
  // 如果都已分配，检查阶段关系
  if (!parentIsUnassigned && !childIsUnassigned) {
    if (childStage !== parent.stage! + 1) {
      return failure(
        ErrorCodes.CROSS_BOUNDARY_VIOLATION,
        '非法操作：子任务必须在父任务的下一阶段',
        { parentStage: parent.stage, childStage, expectedChildStage: parent.stage! + 1 }
      );
    }
  }
  
  return success(undefined);
}
```

---

### Phase 2: 核心逻辑修改（预计 4h）

#### 2.1 修改 `addTask` - 允许待分配任务有父子关系

**文件**: `src/services/task-operation.service.ts`  
**位置**: `addTask` 方法，约 L150-220

**变更点**:
- 移除 `parentId: targetStage === null ? null : parentId` 的强制清空逻辑
- 增加同源不变性验证

```typescript
addTask(params: CreateTaskParams): Result<string, OperationError> {
  const { title, content, targetStage, parentId, isSibling: _isSibling } = params;
  
  const activeP = this.getActiveProject();
  if (!activeP) {
    return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
  }
  
  // 🔴 新增：同源不变性验证
  const consistencyCheck = this.validateParentChildStageConsistency(
    parentId, 
    targetStage, 
    activeP.tasks
  );
  if (!consistencyCheck.ok) {
    return consistencyCheck;
  }
  
  // ...existing validation...
  
  const newTask: Task = {
    id: newTaskId,
    title,
    content,
    stage: targetStage,
    // 🔴 关键变更：不再因为 stage=null 而强制清空 parentId
    parentId: parentId ?? null,
    // ...rest of properties...
  };
  
  // ...rest of method...
}
```

#### 2.2 修改 `moveTaskToStage` - 完整闭环逻辑

**文件**: `src/services/task-operation.service.ts`  
**位置**: `moveTaskToStage` 方法，约 L700-800

**逻辑分支**:

```
┌─────────────────────────────────────────────────────────┐
│                    moveTaskToStage                       │
├─────────────────────────────────────────────────────────┤
│ 输入: taskId, newStage, beforeTaskId, newParentId       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─ isFromUnassigned && isToUnassigned ─┐               │
│  │   待分配区内部重组                      │               │
│  │   - 仅更新 parentId                   │               │
│  │   - 循环依赖检测                       │               │
│  │   - 跳过阶段级联                       │               │
│  └────────────────────────────────────────┘               │
│                                                         │
│  ┌─ isFromUnassigned && isToStage ──────┐               │
│  │   浮动树整体分配                       │               │
│  │   - 阶段溢出预检查                     │               │
│  │   - 调用 assignUnassignedSubtree()    │               │
│  │   - 级联更新所有后代 stage             │               │
│  └────────────────────────────────────────┘               │
│                                                         │
│  ┌─ isFromStage && isToUnassigned ──────┐               │
│  │   已分配树整体回收                     │               │
│  │   - 调用 detachSubtreeToUnassigned()  │               │
│  │   - 整棵子树 stage 设为 null          │               │
│  └────────────────────────────────────────┘               │
│                                                         │
│  ┌─ isFromStage && isToStage ───────────┐               │
│  │   已分配任务阶段变更（原有逻辑）        │               │
│  │   - 阶段溢出预检查                     │               │
│  │   - 调用 cascadeUpdateChildrenStage() │               │
│  └────────────────────────────────────────┘               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**完整实现**:

```typescript
moveTaskToStage(params: MoveTaskParams): Result<void, OperationError> {
  const { taskId, newStage, beforeTaskId, newParentId } = params;
  
  const activeP = this.getActiveProject();
  if (!activeP) {
    return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
  }
  
  const target = activeP.tasks.find(t => t.id === taskId);
  if (!target) {
    return failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
  }
  
  const isFromUnassigned = target.stage === null;
  const isToUnassigned = newStage === null;
  const isToStage = newStage !== null;
  
  // ========== 分支1: 待分配区内部重组 ==========
  if (isFromUnassigned && isToUnassigned) {
    return this.reparentWithinUnassigned(taskId, newParentId, activeP.tasks);
  }
  
  // ========== 分支2: 浮动树整体分配 ==========
  if (isFromUnassigned && isToStage) {
    // 阶段溢出预检查
    const capacityCheck = this.validateStageCapacity(taskId, newStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck;
    }
    
    // 如果指定了新父任务，验证同源性
    if (newParentId) {
      const consistencyCheck = this.validateParentChildStageConsistency(
        newParentId, 
        newStage, 
        activeP.tasks
      );
      if (!consistencyCheck.ok) {
        return consistencyCheck;
      }
    }
    
    return this.assignUnassignedSubtree(taskId, newStage, newParentId, beforeTaskId);
  }
  
  // ========== 分支3: 已分配树整体回收 ==========
  if (!isFromUnassigned && isToUnassigned) {
    return this.detachSubtreeToUnassigned(taskId);
  }
  
  // ========== 分支4: 已分配任务阶段变更（原有逻辑增强） ==========
  if (!isFromUnassigned && isToStage) {
    // 阶段溢出预检查
    const capacityCheck = this.validateStageCapacity(taskId, newStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck;
    }
    
    // 原有逻辑...
    return this.moveAssignedTaskToStage(taskId, newStage, beforeTaskId, newParentId);
  }
  
  return success(undefined);
}
```

#### 2.3 新增 `reparentWithinUnassigned` - 待分配区内部重组

```typescript
/**
 * 待分配区内部重组（仅更新 parentId，不触发阶段级联）
 */
private reparentWithinUnassigned(
  taskId: string,
  newParentId: string | null | undefined,
  tasks: Task[]
): Result<void, OperationError> {
  // 如果 newParentId 有值，检查目标父任务也必须在待分配区
  if (newParentId) {
    const newParent = tasks.find(t => t.id === newParentId);
    if (!newParent) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '目标父任务不存在');
    }
    if (newParent.stage !== null) {
      return failure(
        ErrorCodes.CROSS_BOUNDARY_VIOLATION,
        '非法操作：不能将待分配任务挂载到已分配任务下而不分配阶段'
      );
    }
    
    // 循环依赖检测
    if (this.layoutService.detectCycle(taskId, newParentId, tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
    }
  }
  
  this.recordAndUpdate(p => {
    const updatedTasks = p.tasks.map(t => {
      if (t.id === taskId) {
        return { ...t, parentId: newParentId ?? null, updatedAt: new Date().toISOString() };
      }
      return t;
    });
    return { ...p, tasks: updatedTasks };
  });
  
  return success(undefined);
}
```

#### 2.4 新增 `assignUnassignedSubtree` - 浮动树整体分配

```typescript
/**
 * 将待分配子树整体分配到指定阶段
 * 遍历整个子树，按层级设置 stage
 */
private assignUnassignedSubtree(
  taskId: string,
  targetStage: number,
  newParentId: string | null | undefined,
  beforeTaskId: string | null | undefined
): Result<void, OperationError> {
  let operationResult: Result<void, OperationError> = success(undefined);
  
  this.recordAndUpdate(p => {
    const tasks = p.tasks.map(t => ({ ...t }));
    const root = tasks.find(t => t.id === taskId);
    if (!root) {
      operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
      return p;
    }
    
    const now = new Date().toISOString();
    const queue: { task: Task; depth: number }[] = [{ task: root, depth: 0 }];
    const visited = new Set<string>();
    
    while (queue.length > 0) {
      const { task, depth } = queue.shift()!;
      if (visited.has(task.id)) continue;
      visited.add(task.id);
      
      // 设置阶段：根节点为 targetStage，子节点递增
      task.stage = targetStage + depth;
      task.updatedAt = now;
      
      // 根节点设置新的 parentId
      if (depth === 0) {
        task.parentId = newParentId ?? null;
      }
      
      // 收集子节点
      const children = tasks.filter(t => t.parentId === task.id && !t.deletedAt);
      children.forEach(child => {
        queue.push({ task: child, depth: depth + 1 });
      });
    }
    
    // 计算根节点的 rank
    const stageTasks = tasks.filter(t => t.stage === targetStage && t.id !== taskId);
    const parent = newParentId ? tasks.find(t => t.id === newParentId) : null;
    const candidateRank = this.computeInsertRank(targetStage, stageTasks, beforeTaskId ?? null, parent?.rank ?? null);
    
    const placed = this.applyRefusalStrategy(root, candidateRank, parent?.rank ?? null, Infinity, tasks);
    if (!placed.ok) {
      operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务');
      return p;
    }
    root.rank = placed.rank;
    
    // 修复子树 rank 约束
    this.fixSubtreeRanks(taskId, tasks);
    
    return this.layoutService.rebalance({ ...p, tasks });
  });
  
  return operationResult;
}
```

#### 2.5 新增 `detachSubtreeToUnassigned` - 已分配树整体回收

```typescript
/**
 * 将已分配子树整体移回待分配区
 * 保留子树内部父子关系，仅断开与外部的连接
 */
private detachSubtreeToUnassigned(taskId: string): Result<void, OperationError> {
  let operationResult: Result<void, OperationError> = success(undefined);
  
  this.recordAndUpdate(p => {
    const tasks = p.tasks.map(t => ({ ...t }));
    const root = tasks.find(t => t.id === taskId);
    if (!root) {
      operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
      return p;
    }
    
    // 收集整个子树
    const subtreeIds = this.collectSubtreeIds(taskId, tasks);
    const now = new Date().toISOString();
    
    // 将整个子树移回待分配区
    subtreeIds.forEach(id => {
      const t = tasks.find(task => task.id === id);
      if (t) {
        t.stage = null;
        t.updatedAt = now;
        // 保留内部父子关系，不修改 parentId
      }
    });
    
    // 只断开 root 与原父任务的连接
    root.parentId = null;
    
    // 计算待分配区的位置
    const unassignedCount = tasks.filter(t => t.stage === null && !subtreeIds.has(t.id)).length;
    root.order = unassignedCount + 1;
    
    // 重新计算待分配区位置
    const pos = this.layoutService.getUnassignedPosition(unassignedCount);
    root.x = pos.x;
    root.y = pos.y;
    
    return this.layoutService.rebalance({ ...p, tasks });
  });
  
  return operationResult;
}
```

---

### Phase 3: UI 层适配（预计 3h）

#### 3.1 新增跨边界确认对话框组件

**文件**: `src/components/flow/flow-cascade-assign-dialog.component.ts`（新建）

用于当用户将待分配任务拖拽到已分配任务附近时，弹出确认对话框：

- 显示源任务和目标任务信息
- 显示将要级联分配的子任务数量
- 显示目标阶段范围（如 "阶段 2 → 阶段 5"）
- 确认/取消按钮

#### 3.2 修改拖拽处理逻辑

**文件**: `src/services/flow-drag-drop.service.ts`

在 `handleDrop` 中增加跨边界检测：

```typescript
handleDrop(taskId: string, dropTarget: DropTarget): void {
  const task = this.store.tasks().find(t => t.id === taskId);
  if (!task) return;
  
  const isFromUnassigned = task.stage === null;
  const isToStage = dropTarget.stage !== null;
  
  // 检测跨边界操作
  if (isFromUnassigned && isToStage) {
    const subtreeCount = this.countSubtree(taskId);
    if (subtreeCount > 1) {
      // 弹出确认对话框
      this.showCascadeAssignDialog({
        taskId,
        targetStage: dropTarget.stage,
        subtreeCount,
        targetParentId: dropTarget.parentId
      });
      return;
    }
  }
  
  // 正常处理
  this.store.moveTaskToStage(taskId, dropTarget.stage, dropTarget.beforeTaskId, dropTarget.parentId);
}
```

#### 3.3 修改待分配区组件

**文件**: `src/components/text-view/text-unassigned.component.ts`

增强显示，支持树形结构预览：

- 子任务缩进显示
- 展开/折叠控制
- 拖拽时显示整棵子树高亮

#### 3.4 流程图位置计算优化

**文件**: `src/services/layout.service.ts`

修改 `getUnassignedPosition`：

```typescript
getUnassignedPosition(
  existingCount: number, 
  parentId?: string | null, 
  tasks?: Task[]
): { x: number; y: number } {
  // 如果有父节点且父节点也在待分配区，放在父节点附近
  if (parentId && tasks) {
    const parent = tasks.find(t => t.id === parentId);
    if (parent && parent.stage === null) {
      return {
        x: parent.x + 180,  // 父节点右侧
        y: parent.y + 60    // 稍微向下偏移
      };
    }
  }
  
  // 原有网格逻辑
  const cols = 3;
  const row = Math.floor(existingCount / cols);
  const col = existingCount % cols;
  
  return {
    x: 80 + col * 180,
    y: 80 + row * 120
  };
}
```

---

### Phase 4: 测试与验证（预计 2h）

#### 4.1 单元测试用例

**文件**: `src/services/task-operation.service.spec.ts`（扩展）

```typescript
describe('浮动任务树', () => {
  describe('待分配区内创建树结构', () => {
    it('应允许在待分配任务下创建子任务', () => { ... });
    it('应允许在待分配任务旁创建同级任务', () => { ... });
    it('待分配树应正确显示父子连接', () => { ... });
  });
  
  describe('阶段溢出检测', () => {
    it('应拒绝会导致阶段溢出的分配操作', () => { ... });
    it('应返回正确的错误信息包含所需阶段和最大阶段', () => { ... });
  });
  
  describe('同源不变性', () => {
    it('应拒绝将待分配任务直接挂载到已分配任务下', () => { ... });
    it('应拒绝将已分配任务直接挂载到待分配任务下', () => { ... });
  });
  
  describe('浮动树整体分配', () => {
    it('分配父任务应级联分配所有后代', () => { ... });
    it('子任务阶段应按层级递增', () => { ... });
    it('应保留子树内部父子关系', () => { ... });
  });
  
  describe('子树拆分分配', () => {
    it('可单独分配某个子任务及其后代', () => { ... });
    it('原父任务应保留在待分配区', () => { ... });
  });
  
  describe('整树回收', () => {
    it('解除分配应将整棵子树移回待分配区', () => { ... });
    it('应保留子树内部父子关系', () => { ... });
    it('应断开与外部的连接', () => { ... });
  });
  
  describe('待分配区内部重组', () => {
    it('可在待分配区内重新组织父子关系', () => { ... });
    it('应检测循环依赖', () => { ... });
  });
});
```

#### 4.2 E2E 测试场景

**文件**: `e2e/floating-task-tree.spec.ts`（新建）

```typescript
test('待分配区创建任务树并整体分配', async () => {
  // 1. 在待分配区创建父任务
  // 2. 在父任务下创建子任务
  // 3. 在子任务下创建孙任务
  // 4. 将父任务拖拽到阶段1
  // 5. 验证所有任务都已分配，阶段正确
});

test('阶段溢出时显示错误提示', async () => {
  // 1. 创建一棵深度为 5 的待分配树
  // 2. 尝试将其分配到接近最大阶段的位置
  // 3. 验证显示错误提示
});

test('子树拆分分配', async () => {
  // 1. 创建待分配树: A -> B -> C
  // 2. 只将 B 分配到阶段
  // 3. 验证 A 仍在待分配区，B 和 C 已分配
});
```

---

## 四、风险与缓解

### 4.1 数据一致性风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 级联更新中断 | 低 | 高 | 使用 `recordAndUpdate` 原子操作，失败时完整回滚 |
| 并发冲突 | 低 | 中 | LWW 策略 + `updatedAt` 时间戳 |
| 循环依赖 | 中 | 高 | 所有 parentId 变更前调用 `detectCycle()` |

### 4.2 性能风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 大树遍历慢 | 中 | 中 | `MAX_SUBTREE_DEPTH = 100` 限制 + 迭代算法 |
| 频繁 rebalance | 高 | 中 | 使用现有防抖机制 |

---

## 五、实施时间线

| 阶段 | 预计时长 | 产出 |
|------|----------|------|
| Phase 1: 基础设施 | 2h | 新增错误码、常量、辅助方法 |
| Phase 2: 核心逻辑 | 4h | `addTask`、`moveTaskToStage` 完整重构 |
| Phase 3: UI 适配 | 3h | 确认对话框、拖拽处理、视图优化 |
| Phase 4: 测试验证 | 2h | 单元测试 + E2E 测试 |
| **总计** | **11h** | 完整功能上线 |

---

## 六、验收标准

1. ✅ 可在待分配区创建具有父子关系的任务树
2. ✅ 流程图正确显示待分配任务间的连接线
3. ✅ 分配父任务时，所有后代任务自动分配到正确阶段
4. ✅ 阶段溢出时显示友好错误提示
5. ✅ 可单独分配子树的任意分支
6. ✅ 解除分配时保留子树结构
7. ✅ 所有现有测试继续通过
8. ✅ 新增测试覆盖所有边界情况

---

## 七、回滚计划

如发现严重问题，可通过以下步骤回滚：

1. 恢复 `addTask` 中的 `parentId: targetStage === null ? null : parentId` 逻辑
2. 移除 `moveTaskToStage` 中的新分支判断
3. 隐藏 UI 层的级联确认对话框

数据层无需迁移，因为只是放开了 `parentId` 的约束，不影响现有数据结构。
