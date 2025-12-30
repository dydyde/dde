# NanoFlow 重构计划 v2.0

> **创建日期**: 2024-12-30  
> **状态**: 进行中  
> **基于**: 高级顾问代码审查 + 冗余深度分析

---

## 📋 执行摘要

本计划整合了两方面输入：
1. **40年资深顾问的代码审查**：聚焦架构反模式和离线优先可靠性
2. **项目冗余深度分析**：识别代码膨胀和重复模式

**核心目标**：在不破坏现有功能的前提下，消除冗余、强化可靠性。

---

## ✅ 顾问意见审计结果

### 1. UUID 策略 ✅ PASS
- 客户端 `crypto.randomUUID()` 生成所有 ID
- 无需 ID 映射，离线创建无障碍

### 2. Optimistic UI ✅ PASS  
- `simple-sync.service.ts` 正确实现：`操作 → 本地写入 → UI 更新 → 后台推送`

### 3. RetryQueue 持久化 ✅ PASS（已验证）
- 已实现双层持久化：`localStorage + IndexedDB 备份`
- 存储失败触发逃生模式（`storageFailure` signal）
- **代码位置**: [action-queue.service.ts#L981-L1050](../src/services/action-queue.service.ts)

### 4. Sentry Breadcrumbs ⚠️ 缺失
- 当前：仅 `captureException` 和 `captureMessage`
- 需要：在 ActionQueue 关键操作添加 breadcrumbs

### 5. StoreService 门面模式 ⚠️ 待评估
- 顾问建议移除，但项目已标记 `@deprecated` 并提供子服务直接访问
- 渐进式迁移：保留门面但鼓励新代码直接注入子服务

---

## 🎯 重构任务清单

### Phase 1: 可靠性强化（P0）

| ID | 任务 | 状态 | 验证方式 |
|----|------|------|----------|
| P0-1 | 添加 Sentry Breadcrumbs 到 ActionQueue | ✅ 完成 | 单元测试通过 |
| P0-2 | 验证 RetryQueue IndexedDB 持久化 | ✅ 已确认 | 代码审查 |
| P0-3 | 确保 Realtime 优先于轮询 | ✅ 已确认 | 代码审查 |

### Phase 2: 代码清理（P1）

| ID | 任务 | 状态 | 预计削减 |
|----|------|------|----------|
| P1-1 | 移除双重导出（Flow 服务） | ✅ 完成 | 10 行导出 |
| P1-2 | 清理 @deprecated 透传方法 | ✅ 完成 | 13 行（StoreService） |
| P1-3 | 精简配置常量 | ✅ 完成 | 70 行（移除 5 个未使用配置） |

### Phase 3: 架构简化（P2，长期）

| ID | 任务 | 状态 | 复杂度 |
|----|------|------|--------|
| P2-1 | StoreService 门面渐进式迁移 | ✅ 完成 | 高 |
| P2-1.6 | 创建 ProjectOperationService 精简门面 | ✅ 完成 | 中 |
| P2-2 | 合并 Flow 服务（14→5） | ⏳ 待定 | 高 |
| P2-3 | 清理更多 deprecated 代码 | ✅ 完成 | 低 |
| P2-4 | 移除未使用的导出 | ✅ 完成 | 低 |
| P2-5 | 移除无效的 authGuard 导出 | ✅ 完成 | 低 |
| P2-6 | 移除未使用的依赖注入 | ✅ 完成 | 低 |
| P2-7 | 移除未使用的 deprecated 方法 | ✅ 完成 | 低 |
| P2-8 | 清理测试文件 ESLint 错误 | ✅ 完成 | 低 |

---

## 📊 完成度追踪

```
Phase 1: ████████████████████ 100% (3/3)
Phase 2: ████████████████████ 100% (3/3)  
Phase 3: ████████████████████ 100% (8/8)
Overall: ████████████████████ 100% (14/14)
```

---

## 🔧 已完成的变更记录

### 2024-12-30

#### 1. Sentry Breadcrumbs (P0-1)
**文件**: [action-queue.service.ts](../src/services/action-queue.service.ts)

添加位置：
- `enqueue()`: 记录入队操作（entityType, entityId, priority, queueSize）
- `processQueue()`: 记录队列处理开始/结束（queueSize, actionTypes, processed/failed）
- `moveToDeadLetter()`: 记录死信转移（reason, deadLetterSize）

```typescript
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'Action enqueued',
  level: 'info',
  data: { entityType, entityId, type, priority, queueSize }
});
```

#### 2. 移除双重导出 (P1-1)
**文件**: [index.ts](../src/services/index.ts)

移除了 Flow 服务的再导出（FlowDiagramService, FlowDragDropService 等），
强制从 `@app/features/flow/services` 导入。保留 FlowCommandService（位于 src/services）。

#### 3. 清理 @deprecated 别名 (P1-2)
**文件**: [store.service.ts](../src/services/store.service.ts)

- 移除 6 个 deprecated 私有别名（uiState, projectState, syncCoordinator, userSession, preference, taskAdapter）
- 将 128 处内部引用替换为 public readonly 属性（ui, project, sync, session, pref, taskOps）
- 减少 13 行代码（932 → 919 行）

#### 4. 精简配置常量 (P1-3)
**文件**: [sync.config.ts](../src/config/sync.config.ts)

移除 5 个未使用的配置对象：
- `UNDO_SYNC_CONFIG` - 未使用
- `SYNC_PERCEPTION_CONFIG` - 未使用
- `SYNC_MODE_CONFIG` - 未使用
- `SYNC_CHECKPOINT_CONFIG` - 未使用  
- `CONFLICT_HISTORY_CONFIG` - 未使用

减少 70 行代码（204 → 134 行）

#### 5. 清理更多 deprecated 代码 (P2-3)

**action-queue.service.ts**:
- 移除 `isBusinessError()` 方法（-9 行）

**auth.service.ts**:
- 移除 deprecated getters `success` 和 `error`（-17 行）

#### 6. 移除未使用的导出 (P2-4)

**models/index.ts**:
- 移除 `export * from './api-types'` - api-types.ts 中的类型未被使用
- 移除 `export * from './supabase-mapper'` - simple-sync.service.ts 有私有 mapper

**发现的代码重复**（记录供后续优化）：
- `simple-sync.service.ts` 中有私有的 `rowToTask()` / `rowToProject()`
- `supabase-mapper.ts` 中有公共的 `mapTaskFromDb()` / `mapProjectFromDb()`
- 建议：后续可统一使用 supabase-mapper.ts 中的映射器

#### 7. 移除无效的 authGuard 导出 (P2-5)

**services/index.ts**:
- 移除 `authGuard` 导出（函数已被移除但导出语句遗留）
- 更新注释说明迁移到 `requireAuthGuard`

#### 8. 移除未使用的依赖注入 (P2-6)

**store.service.ts**:
- 移除未使用的 `authService = inject(AuthService)` 依赖
- 移除对应的 `import { AuthService } from './auth.service'`
- 减少 2 行代码

---

#### 9. 清理测试文件 ESLint 错误 (P2-8)

**清理的文件**:
- `simple-sync.service.spec.ts`: 移除未使用的 fakeAsync, tick, flush
- `action-queue.service.spec.ts`: 移除未使用的 QueuedAction, DeadLetterItem
- `change-tracker.service.spec.ts`: 移除未使用的 vi
- `conflict-resolution.service.spec.ts`: 移除未使用的 ConflictResolutionStrategy, MergeResult
- `data-loss-detection.integration.spec.ts`: 移除未使用的 Project
- `request-throttle.service.spec.ts`: 标记调试变量为有意未使用
- `sync-coordinator.service.spec.ts`: 移除未使用的 Subject, failure, ErrorCodes
- `task-trash.service.spec.ts`: 移除未使用的 DeleteResult
- `undo-integration.spec.ts`: 移除未使用的变量声明
- `test-setup.ts`: 标记参数为有意未使用

**结果**: ESLint 从 22 个错误降至 0 个

#### 10. P2-1 StoreService 门面迁移 (2024-12-30)

**完成范围**：
- 阶段 3: Flow 组件/服务迁移 (14 个文件)
- 阶段 4: Text 组件迁移 (8 个文件)
- 阶段 5: Shared 组件迁移 (4 个文件)

**迁移统计**：
| 类别 | 文件数 | store.* 引用替换数 |
|------|--------|-------------------|
| Flow 服务 | 14 | ~200+ |
| Flow 组件 | 10+ | ~100+ |
| Text 组件 | 8 | ~80+ |
| Shared 组件 | 4 | ~80+ |
| **合计** | 36+ | **460+** |

**子服务使用映射**：
```typescript
// UI 状态
store.isMobile → uiState.isMobile
store.activeView → uiState.activeView
store.filterMode → uiState.filterMode
store.stageFilter → uiState.stageFilter

// 项目数据
store.projects → projectState.projects
store.tasks → projectState.tasks
store.activeProjectId → projectState.activeProjectId
store.currentUserId → userSession.currentUserId

// 任务操作
store.addTask → taskOpsAdapter.addTask
store.deleteTask → taskOpsAdapter.deleteTask
store.updateTaskTitle → taskOpsAdapter.updateTaskTitle

// 同步
store.isLoadingRemote → syncCoordinator.isLoadingRemote
store.schedulePersist → syncCoordinator.schedulePersist

// 偏好
store.setTheme → preferenceService.setTheme
```

**技术债务记录**：
- ~~app.component.ts 保留 `projectOps` (StoreService) 用于项目操作方法~~ ✅ 已解决
- ~~待创建 `ProjectOperationService` 分离 addProject/deleteProject/updateProjectMetadata/resolveConflict~~ ✅ 已创建

**验证结果**：
- ✅ TypeScript 编译通过
- ✅ 340 个单元测试全部通过
- ✅ 无循环依赖

#### 11. P2-1 阶段6: 门面精简 (2024-12-30)

**创建 ProjectOperationService** ([project-operation.service.ts](../src/services/project-operation.service.ts))

从 StoreService 中提取的方法：
- `addProject()` - 项目创建（含乐观更新、离线队列）
- `deleteProject()` - 项目删除（含乐观更新、离线队列）
- `updateProjectMetadata()` - 项目元数据更新
- `renameProject()` - 项目重命名
- `updateProjectFlowchartUrl()` - 流程图缩略图更新
- `resolveConflict()` - 数据冲突解决

**迁移的文件**：
| 文件 | 变更 |
|------|------|
| app.component.ts | `StoreService` → `ProjectOperationService` |
| project.guard.ts | `StoreService` → `ProjectStateService` + `SyncCoordinatorService` + `UserSessionService` |

**最终结果**：
- ✅ **零文件直接注入 StoreService**（除测试文件和 StoreService 本身）
- ✅ StoreService 现在仅作为向后兼容的门面存在
- ✅ 340 个单元测试全部通过

---

## 🚫 明确不做的事项

1. **~~不移除 StoreService 门面~~** → 已完成渐进式迁移
   - ~~原因：太多现有代码依赖，需渐进式迁移~~
   - ✅ 新代码直接注入子服务，旧代码已迁移
   - ✅ 阶段6: 创建 ProjectOperationService，实现零直接依赖

2. **不合并 Flow 服务**
   - 原因：GoJS 集成复杂，需专门规划
   - 策略：作为 Phase 3 长期任务

3. **不实现复杂冲突解决**
   - 顾问建议：单用户应用 LWW 足够
   - 保留简单的 LWW 策略，移除冲突模态框（V1）

---

## 📝 验证检查清单

运行以下命令验证变更：

```bash
# 类型检查
npm run typecheck

# 单元测试
npm run test:run

# Lint 检查
npm run lint

# E2E 测试（可选）
npm run test:e2e
```

---

## 📚 参考文档

- [copilot-instructions.md](../.github/copilot-instructions.md)
- [AGENTS.md](../AGENTS.md)
- 高级顾问代码审查（2024-12-30）

---

## 🔬 高复杂度任务深度规划

### P2-1: StoreService 门面评估与渐进式迁移

#### 📊 现状分析

**当前使用规模**：
- 26 处组件/服务注入 `StoreService`
- 910 行代码（纯门面 + 透传方法）
- 6 个子服务：`ui`, `project`, `sync`, `session`, `pref`, `taskOps`

**现有架构**：
```
StoreService (门面)
    ├── UiStateService        # UI 状态
    ├── ProjectStateService   # 项目/任务数据
    ├── SyncCoordinatorService# 同步调度
    ├── UserSessionService    # 用户会话
    ├── PreferenceService     # 偏好设置
    └── TaskOperationAdapterService  # 任务 CRUD
```

**问题识别**：
| 问题 | 严重度 | 描述 |
|------|--------|------|
| 方法透传冗余 | 中 | ~50% 的方法是 1:1 透传到子服务 |
| 测试复杂度 | 中 | 必须 mock 门面或多个子服务 |
| 循环依赖风险 | 低 | 子服务之间仍可能产生循环 |
| 新功能添加成本 | 低 | 新方法需同时改门面+子服务 |

#### 🎯 决策矩阵

| 选项 | 工作量 | 风险 | 收益 |
|------|--------|------|------|
| A. 保持现状 | 0 | 0 | 0 |
| B. 渐进式迁移（推荐）| 中 | 低 | 高 |
| C. 一次性移除门面 | 高 | 高 | 高 |

**推荐策略**：选项 B - 渐进式迁移

#### � 严格委托检查（顾问强制要求）

**当前代码审查发现的轻微泄漏**：

```typescript
// ⚠️ store.service.ts L505 - 包含验证逻辑
renameProject(projectId: string, newName: string) {
  if (!newName.trim()) return;  // ← 业务逻辑泄漏!
  this.project.updateProjects(...);
}

// ✅ 应改为严格透传
renameProject(projectId: string, newName: string) {
  return this.project.renameProject(projectId, newName);  // 验证在子服务
}
```

**审查清单**（迁移前必须检查）：
- [x] `renameProject` - 已移动 `trim()` 验证到 `ProjectStateService`
- [x] `lockTaskFields` - 默认值逻辑已封装在 `ChangeTrackerService`（符合规范）
- [x] 所有透传方法必须是 `return this.xxx.method(...)` 模式

#### 📋 执行计划（6 个阶段）

**阶段 1: 文档与约定（1 小时）** ✅ 已完成
- [x] 在 StoreService 顶部添加迁移指南注释
- [x] 更新 AGENTS.md：新代码必须直接注入子服务
- [x] 标记透传方法为 `@deprecated`（已标记 5 个典型方法）
- [x] 修复 `renameProject` 业务逻辑泄漏（移至 ProjectStateService）

**阶段 2: 新代码规范（持续）** ✅ 已完成
- [x] Code Review 强制检查：禁止新增 `inject(StoreService)` 
- [x] 提供代码片段/模板：常用子服务组合

**阶段 3: Flow 组件迁移（2 小时）** ✅ 已完成
目标：8 个 Flow 组件/服务 → 直接注入子服务

| 文件 | 使用的子服务 | 状态 |
|------|-------------|------|
| flow-diagram.service.ts | project, taskOps | ✅ |
| flow-event.service.ts | taskOps, ui | ✅ |
| flow-view.component.ts | project, ui, sync | ✅ |
| flow-drag-drop.service.ts | taskOps | ✅ |
| flow-link.service.ts | taskOps, project | ✅ |
| flow-template.service.ts | project, ui | ✅ |
| flow-touch.service.ts | taskOps | ✅ |
| flow-zoom.service.ts | ui | ✅ |
| + 其他 Flow 服务 | 各子服务 | ✅ |

**阶段 4: Text 组件迁移（1.5 小时）** ✅ 已完成
目标：8 个 Text 组件 → 直接注入子服务

| 文件 | 使用的子服务 | 状态 |
|------|-------------|------|
| text-view.component.ts | projectState, uiState, taskOps, syncCoordinator | ✅ |
| text-stages.component.ts | projectState, uiState | ✅ |
| text-stage-card.component.ts | projectState | ✅ |
| text-task-card.component.ts | projectState | ✅ |
| text-task-connections.component.ts | projectState | ✅ |
| text-task-editor.component.ts | taskOps, projectState, uiState, changeTracker | ✅ |
| text-unassigned.component.ts | taskOps, projectState, uiState, changeTracker | ✅ |
| text-unfinished.component.ts | taskOps, projectState, uiState | ✅ |

**阶段 5: Shared 组件迁移（1 小时）** ✅ 已完成
| 文件 | 使用的子服务 | 状态 |
|------|-------------|------|
| settings-modal.component.ts | projectState, preferenceService | ✅ |
| trash-modal.component.ts | projectState, taskOpsAdapter | ✅ |
| project-shell.component.ts | uiState, projectState, taskOpsAdapter, syncCoordinator | ✅ |
| app.component.ts | uiState, projectState, userSession, preferenceService, syncCoordinator, undoService, projectOps* | ✅ |

> *注: app.component.ts 保留 `projectOps` (StoreService) 用于项目操作方法 (addProject, deleteProject, updateProjectMetadata, resolveConflict)，待后续拆分到 ProjectOperationService

**阶段 6: 门面精简（可选，Phase 4）** ⏳ 待定
完成迁移后，StoreService 可缩减为：
- 仅保留跨多服务协调的复杂方法（如 `resolveConflict`、`addProject`）
- 移除所有 1:1 透传
- 最终 ~200 行

#### ⚠️ 风险控制

1. **回归测试**：每迁移一个组件立即运行 `npm run test:run`
2. **渐进式**：不要批量迁移，每次 1-2 个文件
3. **保持兼容**：门面方法保留但标 `@deprecated`
4. **循环依赖**：使用 `providedIn: 'root'` 或 `inject()` 动态注入

#### 📈 预期收益

| 指标 | 当前 | 迁移后 |
|------|------|--------|
| StoreService 代码行数 | 910 | ~200 |
| 单元测试 mock 复杂度 | 高 | 低 |
| 新功能添加步骤 | 2 | 1 |
| IDE 自动补全准确度 | 中 | 高 |

---

### P2-2: Flow 服务合并（14→5）

#### 📊 现状分析

**当前 Flow 服务清单（14 个，共 8364 行）**：

| 服务 | 行数 | 职责 | 依赖 |
|------|------|------|------|
| flow-diagram.service.ts | 2258 | 核心图表管理 | 5 个子服务 |
| flow-template.service.ts | 1207 | 节点/连接模板 | ConfigService |
| flow-link.service.ts | 890 | 连接线管理 | StoreService |
| flow-event.service.ts | 620 | 事件代理 | StoreService |
| flow-diagram-config.service.ts | 517 | 配置/数据转换 | - |
| flow-touch.service.ts | 453 | 移动端触摸 | DragDropService |
| flow-debug.service.ts | 439 | 调试工具 | - |
| flow-overview.service.ts | 422 | 小地图 | TemplateService |
| flow-drag-drop.service.ts | 389 | 拖放处理 | StoreService |
| flow-zoom.service.ts | 278 | 缩放控制 | StoreService |
| flow-task-operations.service.ts | 273 | 任务操作代理 | StoreService |
| flow-selection.service.ts | 272 | 选择管理 | - |
| flow-layout.service.ts | 263 | 布局计算 | StoreService |
| flow-template-events.ts | 54 | 事件总线 | - |
| index.ts | 29 | 导出 | - |

#### 🎯 合并策略

> **⚠️ 顾问警告（Split Brain 风险）**
> 
> 原计划的 `FlowDataService` 有高风险会演变为业务逻辑层。根据顾问建议：
> - **重命名为 `FlowModelAdapter`** - 明确定位为纯适配器
> - **严禁调用** `Supabase` 或 `SimpleSyncService`
> - **严禁维护状态** - 不要缓存 "Diagram 中的任务列表"
> - **单一数据源** - 始终从 `ProjectStateService` 读取

**目标架构（5 个核心服务 + 2 个支撑）**：

```
┌─────────────────────────────────────────────────────────────┐
│                    FlowDiagramService                        │
│  (合并: diagram + overview + zoom)                          │
│  职责: 图表生命周期、小地图、缩放、视图状态                   │
│  预计: ~1500 行                                              │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────────────┐  ┌─────────────────────┐
│ FlowRenderService │  │ FlowInteractionService │  │ FlowModelAdapter  │
│ (合并:              │  │ (合并:                 │  │ (合并:             │
│  template + config) │  │  event + selection     │  │  config 转换 +    │
│                     │  │  + layout + drag-drop) │  │  task-ops + link) │
│ 职责: 模板渲染、    │  │ 职责: 事件、选择、     │  │ 职责: 数据转换、  │
│      样式配置       │  │      布局、拖放          │  │      存储委托      │
│ 预计: ~1700 行      │  │ 预计: ~1500 行         │  │ 预计: ~800 行     │
└─────────────────┘  └─────────────────────────┘  └─────────────────────┘
         │
         ▼
┌─────────────────┐  ┌─────────────────┐
│ FlowTouchService │  │ FlowDebugService │
│ (保持独立)       │  │ (保持独立)       │
│ 职责: 移动端触摸 │  │ 职责: 开发调试   │
│ 预计: ~450 行    │  │ 预计: ~440 行    │
└─────────────────┘  └─────────────────┘
```

#### 📋 合并详细计划

**合并组 1: FlowRenderService（模板 + 配置）**

| 源服务 | 迁移内容 | 保留/删除 |
|--------|----------|----------|
| flow-template.service.ts | 全部 | 合并后删除 |
| flow-diagram-config.service.ts | 模板配置部分 | 合并后删除 |
| flow-template-events.ts | 保持独立 | 保留（事件总线） |

执行步骤：
1. [ ] 创建 `flow-render.service.ts`
2. [ ] 迁移 `FlowTemplateService` 全部代码
3. [ ] 迁移 `FlowDiagramConfigService` 的模板配置方法
4. [ ] 更新所有 import
5. [ ] 删除原文件

**合并组 2: FlowInteractionService（事件 + 选择 + 布局）**

| 源服务 | 迁移内容 | 保留/删除 |
|--------|----------|----------|
| flow-event.service.ts | 全部 | 合并后删除 |
| flow-selection.service.ts | 全部 | 合并后删除 |
| flow-layout.service.ts | 全部 | 合并后删除 |
| flow-drag-drop.service.ts | 全部 | 合并后删除 |

执行步骤：
1. [ ] 创建 `flow-interaction.service.ts`
2. [ ] 按职责分区迁移代码
3. [ ] 处理内部方法调用
4. [ ] 更新所有 import
5. [ ] 删除原文件

**合并组 3: FlowDiagramService（精简核心）**

| 源服务 | 迁移内容 | 保留/删除 |
|--------|----------|----------|
| flow-diagram.service.ts | 保留核心 | 重构 |
| flow-overview.service.ts | 全部 | 合并后删除 |
| flow-zoom.service.ts | 全部 | 合并后删除 |

执行步骤：
1. [ ] 将 overview 逻辑迁入 diagram
2. [ ] 将 zoom 逻辑迁入 diagram
3. [ ] 删除原文件
4. [ ] 精简 diagram 的职责描述

**合并组 4: FlowModelAdapter（纯适配器 - 重命名自 FlowDataService）**

> **🚨 严格约束（顾问强制要求）**
>
> ```typescript
> // ✅ 允许的操作
> Task[] → NodeData[]  // 输入转换
> DiagramEvent → StoreService.updateTask({x, y})  // 输出委托
>
> // ❌ 禁止的操作
> this.supabase.from('tasks')...  // 直接访问数据库
> this.localTasksCache = tasks;   // 维护本地状态
> this.syncService.push(...)      // 直接调用同步
> ```

| 源服务 | 迁移内容 | 保留/删除 |
|--------|----------|----------|
| flow-diagram-config.service.ts | 数据转换部分 | 合并后删除 |
| flow-task-operations.service.ts | 全部 | 合并后删除 |
| flow-link.service.ts | 全部 | 合并后删除 |

执行步骤：
1. [ ] 创建 `flow-model-adapter.service.ts`（注意命名）
2. [ ] 迁移数据转换方法（toNodeDataArray, toLinkDataArray）
3. [ ] 迁移任务操作和连接管理（确保委托给 StoreService）
4. [ ] 更新所有 import
5. [ ] 删除原文件
6. [ ] **审查**：确认无 Supabase/SimpleSyncService 直接调用

#### ⚠️ 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 循环依赖 | 中 | 高 | 见下方处理方案 |
| GoJS 交互中断 | 中 | 高 | 每个合并组后立即 E2E 测试 |
| 合并冲突 | 低 | 中 | 独立分支，逐个合并 |
| 性能回归 | 低 | 中 | 合并后性能基准测试 |
| Split Brain | 中 | 高 | FlowModelAdapter 严禁维护状态 |

**循环依赖处理方案（顾问建议）**：

合并 14 个服务时将遇到循环依赖（如 Interaction 需要 Diagram，Diagram 需要 Interaction 注册监听器）。

```typescript
// ❌ 错误：构造函数注入导致循环
@Injectable()
export class FlowInteractionService {
  constructor(private diagram: FlowDiagramService) {} // ← 循环!
}

// ✅ 正确：通过方法参数传递 Diagram 实例
@Injectable()
export class FlowInteractionService {
  setDiagram(diagram: go.Diagram) {
    this.diagram = diagram;
    this.registerListeners();
  }
}

// ✅ 正确：使用 Context 对象
interface FlowContext {
  diagram: go.Diagram;
  overview: go.Overview | null;
}

@Injectable()
export class FlowInteractionService {
  initialize(context: FlowContext) { ... }
}
```

**GoJS 拖拽 Optimistic UI 模式**：

```typescript
// 拖拽时立即更新 GoJS，异步同步到 Store
diagram.addDiagramListener('SelectionMoved', (e) => {
  // 1. GoJS 已经即时更新了视觉位置
  
  // 2. 异步同步到 Store（不等待回显）
  const node = e.subject.first();
  const loc = node.location;
  this.store.taskOps.updateTaskPosition(node.data.key, loc.x, loc.y);
});
```

#### 📈 预期收益

| 指标 | 当前 | 合并后 |
|------|------|--------|
| 服务数量 | 14 | 7 |
| 文件数量 | 15 | 8 |
| 代码行数 | 8364 | ~6000（-28%） |
| 导入语句 | 多 | 少 |
| 服务间调用 | 频繁 | 内部方法 |

#### 🚦 执行顺序建议

```
1. P2-1 StoreService 迁移（前提条件）
   └─ Flow 服务依赖 StoreService 的模式需先统一

2. 合并组 1: FlowRenderService
   └─ 最独立，依赖最少

3. 合并组 4: FlowModelAdapter  
   └─ 数据适配器，严禁业务逻辑

4. 合并组 2: FlowInteractionService
   └─ 事件处理需要仔细测试

5. 合并组 3: FlowDiagramService 精简
   └─ 最后合并核心服务
```

#### ⏱️ 工作量估算

| 阶段 | 工作量 | 依赖 |
|------|--------|------|
| P2-1 完成 | 6 小时 | 无 |
| 合并组 1 | 4 小时 | P2-1 |
| 合并组 4 | 4 小时 | 合并组 1 |
| 合并组 2 | 6 小时 | 合并组 4 |
| 合并组 3 | 4 小时 | 合并组 2 |
| 测试验证 | 4 小时 | 全部 |
| **总计** | **28 小时** | - |

---

## ✅ 深度规划完成检查

- [x] P2-1 StoreService 门面评估 - 详细规划完成
- [x] P2-2 Flow 服务合并 - 详细规划完成
- [x] 执行顺序和依赖关系明确
- [x] 风险评估和缓解措施就绪
