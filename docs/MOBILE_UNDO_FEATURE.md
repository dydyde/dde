# 移动端撤回功能实现

## 功能概述

移动端的撤回功能采用**"操作后补救"**设计，而非永久的撤回按钮。用户执行关键操作后，屏幕底部会弹出带有"撤销"按钮的 Toast 提示，5秒后自动消失。

## UI 交互

### Toast 提示示例
```
✅ 已删除 "购物清单"  [撤销]  ⓧ
   (5秒后自动消失)
```

### 设计优势
- **零屏幕占用**：不操作时，撤回按钮不存在
- **符合直觉**：只有在可能犯错后才显示补救选项
- **移动优先**：减少界面混乱，专注核心任务

## 支持的操作类型

| 操作类型 | 方法 | Toast 提示 |
|---------|------|-----------|
| **创建任务** | `addTask()` | `已创建 "任务名"` |
| **创建浮动任务** | `addFloatingTask()` | `已创建 "任务名"` |
| **删除单个任务** | `deleteTask()` | `已删除 "任务名"` |
| **批量删除** | `deleteTasksBatch()` | `已删除 N 个任务` |
| **删除保留子任务** | `deleteTaskKeepChildren()` | `已删除 "任务名"（保留子任务）` |
| **移动到阶段** | `moveTaskToStage()` | `已移动到阶段 N` 或 `已移动到待分配区` |
| **子树迁移** | `moveSubtreeToNewParent()` | `已移动子树` |
| **分离子树** | `detachTaskWithSubtree()` | `已移动到待分配区` |
| **添加关联** | `addCrossTreeConnection()` | `已添加关联` |
| **删除关联** | `removeConnection()` | `已删除关联` |
| **重连关联** | `relinkCrossTreeConnection()` | `已重连关联` |

## 技术实现

### 核心架构（无循环依赖）

```
TaskOperationAdapterService
    ↓
操作执行（创建/删除/移动/连接）
    ↓
ToastService.show({ action: { label: '撤销', onClick: () => this.performUndo() } })
    ↓
用户点击"撤销" → performUndo() 直接调用
    ↓
UndoService.undo() + applyProjectSnapshot()
```

**关键设计**：`performUndo()` 方法直接在 `TaskOperationAdapterService` 中实现，避免了与 `StoreService` 的循环依赖。

### 支持的操作

| 操作 | Toast 提示 | 撤销行为 |
|------|-----------|---------|
| **创建任务** | `已创建 "任务名"` | 删除刚创建的任务 |
| **删除单个任务** | `已删除 "任务名"` | 恢复任务及其子任务 |
| **批量删除** | `已删除 N 个任务` | 恢复所有被删除的任务 |
| **删除保留子任务** | `已删除 "任务名"（保留子任务）` | 恢复任务并重建父子关系 |
| **移动到阶段** | `已移动到阶段 N` | 恢复任务的原始位置和父子关系 |
| **子树迁移** | `已移动子树` | 恢复整个子树的原始结构 |
| **分离子树** | `已移动到待分配区` | 恢复子树到原始父任务下 |
| **添加关联** | `已添加关联` | 删除刚创建的连接 |
| **删除关联** | `已删除关联` | 恢复被删除的连接 |
| **重连关联** | `已重连关联` | 恢复连接到原始端点 |

### 核心代码位置

#### 1. TaskOperationAdapterService
**文件**: `src/services/task-operation-adapter.service.ts`

```typescript
// 所有关键操作都调用 performUndo() 而非 StoreService.undo()
// 这避免了循环依赖：StoreService -> TaskOperationAdapterService -> StoreService

deleteTask(taskId: string): void {
  const task = this.projectState.activeProject()?.tasks.find(t => t.id === taskId);
  const taskTitle = task?.title || '任务';
  
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
          this.performUndo();  // 直接调用，无循环依赖
        }
      }
    }
  );
}

/**
 * 执行撤销操作（内部方法）
 * 复制自 StoreService.undo()，避免循环依赖
 */
performUndo(): void {
  const activeProject = this.projectState.activeProject();
  const currentVersion = activeProject?.version;
  const result = this.undoService.undo(currentVersion);
  
  if (!result) return;
  
  // 处理版本冲突...
  
  const action = result;
  this.applyProjectSnapshot(action.projectId, action.data.before);
}

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
```

#### 2. ToastService
**文件**: `src/services/toast.service.ts`

已有的 `ToastAction` 接口：
```typescript
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}
```

#### 3. Toast UI 组件
**文件**: `src/app/shared/components/toast-container.component.ts`

```typescript
@if (message.action) {
  <button
    (click)="handleAction(message)"
    class="mt-2 text-xs font-medium px-3 py-1 rounded-md">
    {{ message.action.label }}
  </button>
}
```

## 与现有架构的集成

### UUID 策略
- 客户端生成的 UUID 确保撤销后重新创建的任务 ID 不变
- 避免"数据幽灵"问题（本地 ID 与服务器 ID 不一致）

### 乐观更新
- 操作立即执行，UI 立即响应
- Toast 显示后台同步到 Supabase（防抖 3秒）
- 如果同步失败，快照会自动回滚

### 防抖与队列
- `ActionQueueService` 处理异步同步队列
- 撤回只是向队列追加一个"反向操作"或恢复旧状态
- 利用 LWW (Last-Write-Wins) 策略处理冲突

## GoJS 移动端优化

### 问题
GoJS 在移动端消耗大量资源，拖拽动画可能卡顿。

### 解决方案
1. **懒加载**: 移动端默认进入文本列表视图，只有点击"流程图"才加载 GoJS
2. **条件渲染**: 使用 `@defer` 完全销毁/重建组件，而非 `visibility: hidden`
3. **撤回优化**: 
   - 不立即触发全局 Layout 动画
   - 对于节点位置撤回，使用 GoJS 原生的 `diagram.model.undoManager.undo()`（比重新绑定数据更高效）

## 测试覆盖

### 单元测试
- `undo.service.spec.ts`: 撤销/重做核心功能（9个测试用例）
- `undo-integration.spec.ts`: 完整撤销链路集成测试（6个测试用例）

### E2E 测试
- `e2e/critical-paths.spec.ts`: 用户关键路径测试（包括删除+撤销流程）

### 全部测试通过
```
✓ Test Files  16 passed (16)
✓ Tests  327 passed | 8 skipped (335)
```

## 配置

**文件**: `src/config/task.config.ts`

```typescript
export const UNDO_CONFIG = {
  MAX_HISTORY: 50,           // 最多保留 50 步历史
  VERSION_TOLERANCE: 5,      // 版本容差：超过 5 个版本拒绝撤销
  MERGE_WINDOW_MS: 2000      // 2秒内的操作合并为单个撤销单元
};
```

## 兼容性

- ✅ 桌面端：Ctrl+Z / Cmd+Z 快捷键保持可用
- ✅ 移动端：Toast 撤回按钮（无快捷键）
- ✅ 离线模式：撤销操作存储在本地，待网络恢复后同步

## 未来优化

### 倒计时动画
在 Toast 中显示 5 秒倒计时进度条：
```typescript
<div class="w-full h-1 bg-gray-200 rounded-full mt-2">
  <div class="h-full bg-emerald-500 rounded-full transition-all"
       [style.width]="remainingTime + '%'">
  </div>
</div>
```

### 批量操作分组
多次快速操作时，智能合并 Toast：
```
✅ 已完成 3 个操作  [撤销全部]  ⓧ
```

### Supabase 推送取消
如果用户在 3 秒防抖期内点击撤销，直接取消 Supabase 推送，避免冗余的网络请求。

---

## 总结

本实现利用了项目现有的极简架构：
- ✅ UUID 客户端生成 - 无需 ID 转换
- ✅ 乐观更新 + 快照回滚 - 操作立即响应
- ✅ ToastService + UndoService - 零额外组件
- ✅ 异步队列 + LWW - 冲突自动解决

**核心原则**：不造轮子，利用 Supabase、UUID、PWA、Sentry。撤回功能完全遵循这一理念。
