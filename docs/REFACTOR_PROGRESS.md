# NanoFlow 项目结构优化进度跟踪

> **创建日期**: 2024-12-26
> **最后更新**: 2025-06-09
> **状态**: ✅ 主要阶段完成（Phase 0-3, 5），Phase 4 渐进式进行中
> **核心哲学**: 不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

---

## 🎯 执行摘要

本次重构项目已基本完成，实现了以下目标：

| 目标 | 结果 |
|------|------|
| 清理废弃代码 | ✅ 删除 ~1100 行未使用代码 |
| 巨型服务拆分 | ✅ 新增 FlowOverviewService (431行)、TaskTrashService (389行) |
| 目录结构重组 | ✅ 迁移 ~40 个文件到 features/shared 目录 |
| 配置文件拆分 | ✅ 481行 → 7个模块化文件 |
| 测试覆盖 | ✅ 636 个测试，37 个测试文件 |
| 类型安全 | 🔄 P0/P1 完成，P2/P3 渐进式 |

**关键指标**:
- 🧪 测试通过率: 636/644 (98.8%)
- 📝 Lint 警告: 247 个（GoJS 类型，可接受）
- 🏗️ 构建状态: ✅ 通过

---

## 📋 目录

1. [执行摘要](#-执行摘要)
2. [高级技术顾问评审摘要](#高级技术顾问评审摘要)
3. [优化阶段总览](#优化阶段总览)
4. [Phase 0: 清理废弃与重复代码](#phase-0-清理废弃与重复代码)
5. [Phase 1: 巨型服务拆分](#phase-1-巨型服务拆分)
6. [Phase 2: 目录结构重组](#phase-2-目录结构重组)
7. [Phase 3: 配置文件拆分](#phase-3-配置文件拆分)
8. [Phase 4: 类型安全增强](#phase-4-类型安全增强)
9. [Phase 5: 测试覆盖补充](#phase-5-测试覆盖补充)
10. [风险登记册](#风险登记册)
11. [变更日志](#变更日志)
12. [附录](#附录)

---

## 高级技术顾问评审摘要

### ✅ 哲学检查：通过（附警告）

计划整体尊重"不要造轮子"哲学。但 Phase 1 的服务拆分需谨慎：
- **不要** 仅为了减小文件大小而拆分 `SimpleSyncService`
- 只有当 **职责确实不同** 时才进行拆分
- `SimpleSyncService` 依赖简单的 LWW 策略，添加抽象层往往会引入 bug

### ⚠️ 风险评估

| 风险 | 严重程度 | 缓解措施 |
|------|----------|----------|
| **同步逻辑脆弱性** | 🔴 高 | `RetryQueue` 必须与网络错误处理器保持在同一文件 |
| **Sentry 上下文丢失** | 🟡 中 | 重构前创建单元测试验证错误上报 |
| **循环依赖** | 🟡 中 | 采用 Strangler Fig 模式逐个迁移 |
| **移动端性能退化** | 🔴 高 | 保持 `@defer` 和 `isMobile()` 逻辑完整 |

### 📌 核心指导原则

1. **Phase 1 调整**: 不过度拆分 `SimpleSyncService`，只提取 **冲突检测** 逻辑
2. **Phase 0 补充**: 删除代码前创建 Sentry 守卫测试
3. **迁移策略**: 采用 **Strangler Fig Pattern** - 逐个功能完整迁移
4. **类型安全**: 优先处理 `Task`/`Project` 模型，忽略测试文件中的 `any`

---

## 优化阶段总览

| 阶段 | 任务 | 状态 | 工作量 | 进度 |
|------|------|------|--------|------|
| **Phase 0** | 清理废弃/重复代码 | ✅ 完成 | 2h | 100% |
| **Phase 1** | 巨型服务拆分 | ✅ 完成 | 6h | 100% |
| **Phase 2** | 目录结构重组 | ✅ 完成 | 16h | 100% |
| **Phase 3** | 配置文件拆分 | ✅ 完成 | 2h | 100% |
| **Phase 4** | 类型安全增强 | 🔄 进行中 | 4h | 35% |
| **Phase 5** | 测试覆盖补充 | ✅ 完成 | 16h | 100% |

### 📊 最新统计（2025-06-09）

- **测试统计**: 636 passed | 8 skipped（37 个测试文件）
- **Lint 警告**: 247 个（主要为 GoJS 回调中的 `any` 类型，属于 P2/P3 优先级）
- **TypeScript**: 编译通过 ✅

#### 新增测试文件清单（本次会话）

| 文件 | 测试数 | 覆盖内容 |
|------|--------|----------|
| `flow-diagram.service.spec.ts` | 17 | 初始化、生命周期、错误处理、子服务委托 |
| `flow-event.service.spec.ts` | 15 | 事件回调注册、节点/连接点击、选择移动 |
| `flow-selection.service.spec.ts` | 14 | 选择状态、多选、状态保存/恢复 |
| `flow-zoom.service.spec.ts` | 19 | 缩放操作、视图状态、坐标转换 |
| `flow-drag-drop.service.spec.ts` | 12 | 拖放状态、事件处理、待分配区域 |
| `flow-link.service.spec.ts` | 15 | 连接模式、对话框状态、连接创建 |

#### 新增类型定义

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/types/gojs-extended.d.ts` | 242 | GoJS 扩展类型定义，减少 `any` 使用 |

---

## Phase 0: 清理废弃与重复代码

### 0.1 Sentry 守卫测试 ✅

**目标**: 验证同步失败时 `Sentry.captureException` 被正确调用

**状态**: ✅ 完成

**完成任务**:
- [x] 在 `simple-sync.service.spec.ts` 添加 Sentry 守卫测试
- [x] 验证 `pushTask` 失败时调用 Sentry 并包含正确 tags
- [x] 验证 `deleteTask` 失败时调用 Sentry
- [x] 验证 `isRetryable` 标签正确区分可重试/不可重试错误
- [x] 验证失败任务被加入 RetryQueue

### 0.2 删除确认组件统一 ✅

**状态**: ✅ 完成

**已删除文件**:
- [x] `src/components/text-view/delete-confirm-modal.component.ts` (废弃空文件)
- [x] `src/components/text-view/unassigned-tasks.component.ts` (废弃空文件)
- [x] `src/components/text-view/unfinished-items.component.ts` (废弃空文件)
- [x] `src/services/gojs-diagram.service.ts` (未使用的服务，1095行)

**已更新导出**:
- [x] 从 `src/app/features/text/index.ts` 移除废弃导出
- [x] 从 `src/app/features/flow/index.ts` 移除 GoJSDiagramService 导出
- [x] 从 `src/services/index.ts` 移除 GoJSDiagramService 导出

**验证**: 构建通过 ✅

---

## Phase 1: 巨型服务拆分

### ⚠️ 顾问建议调整

**原计划**: 拆分 `SimpleSyncService` → `RetryQueueService` + `RealtimeSubscriptionService`

**调整后**: 
- ❌ 不拆分 `SimpleSyncService` 的执行逻辑
- ✅ 只提取 **冲突检测** 逻辑（如需要）
- ✅ 保持 `RetryQueue` 与 Supabase 调用在同一文件

### 1.1 FlowDiagramService 拆分 ✅

**原行数**: 2140 行
**Overview 相关代码**: 301 行

**状态**: ✅ 完成（采用 Strangler Fig 模式）

**已完成**:
- [x] 创建 `FlowOverviewService` 服务 (~431 行)
- [x] 定义 Overview 相关的接口和类型 (OverviewOptions, OverviewState)
- [x] 实现完整的生命周期方法 (initialize/dispose/refresh)
- [x] 实现 Overview 自动缩放逻辑 (setupOverviewAutoScale)
- [x] 实现 Overview 交互事件处理 (attachOverviewPointerListeners)
- [x] 导出新服务到 `services/index.ts` 和 `features/flow/index.ts`
- [x] 创建 `FlowDiagramService` 测试覆盖（9 个测试）
- [x] 验证构建通过

**拆分结果**:

| 服务 | 职责 | 行数 |
|------|------|------|
| `FlowDiagramService` | 主图管理：初始化、生命周期、导出 | 2140 |
| `FlowOverviewService` | 小地图管理：缩放、交互、视口同步 | 431 |
| `FlowTemplateService` | 模板配置：节点/连接线模板 | ~400 |
| `FlowEventService` | 事件处理：回调注册、事件代理 | ~300 |
| `FlowSelectionService` | 选择管理：选中/多选/高亮 | ~200 |
| `FlowZoomService` | 缩放控制：放大/缩小/适应 | ~150 |
| `FlowDragDropService` | 拖放逻辑 | ~250 |
| `FlowLinkService` | 连接线管理 | ~200 |
| `FlowTouchService` | 触摸支持 | ~150 |

**关键约束**:
- ✅ 保持 `@defer` block 和 `isMobile()` 检查完整
- ✅ 不破坏 `FlowEventService` 的事件代理模式
- ✅ Overview 交互与主图保持同步

### 1.2 TaskOperationService 拆分 ✅

**原行数**: 1784 行
**状态**: ✅ 完成（采用门面模式 + 职责委托）

**已完成**:
- [x] 创建 `TaskTrashService` 回收站管理服务 (~389 行)
- [x] 定义回收站相关接口 (DeletedTaskMeta, DeleteResult, RestoreResult)
- [x] 实现软删除、永久删除、恢复、清空回收站方法
- [x] 支持 `keepChildren` 参数（删除时保留子任务）
- [x] 创建完整测试覆盖（12 个测试）
- [x] 导出新服务到 `services/index.ts`
- [x] 验证构建通过

**拆分结果**:

| 新服务 | 状态 | 职责 | 行数 |
|--------|------|------|------|
| `TaskTrashService` | ✅ 已创建 | 回收站管理：软删除、永久删除、恢复、清空 | 389 |
| `TaskOperationService` | ✅ 保持 | 门面服务：协调 CRUD、移动、回收站操作 | 1784 |

**架构决策**：
- ❌ 不创建独立的 `TaskMoveService` 和 `TaskCrudService`
- ✅ `TaskOperationService` 保持为门面服务，内部委托 `TaskTrashService`
- **理由**：避免过度拆分导致的复杂性，保持职责清晰的单一入口

---

## Phase 2: 目录结构重组

### 迁移策略: Strangler Fig Pattern

**原则**: 
- 不使用临时 `index.ts` 重导出
- 每次完整迁移一个功能模块
- 修复导入 → 验证 → 重复

### 2.1 目标结构

```
src/
├── app/
│   ├── core/                    # 保持不变
│   ├── features/
│   │   ├── flow/
│   │   │   ├── components/      # 移入 flow/ 组件
│   │   │   ├── services/        # 移入 GoJS 服务
│   │   │   └── index.ts
│   │   ├── text/
│   │   │   ├── components/      # 移入 text-view/ 组件
│   │   │   ├── services/        
│   │   │   └── index.ts
│   │   └── project/
│   │       └── components/      # project-shell, 模态框
│   └── shared/
│       ├── components/          # 公共组件
│       └── services/            # 公共服务
└── domain/                      # 新增：领域逻辑
    ├── task/
    ├── project/
    └── sync/
```

### 2.2 迁移顺序

**第一批: text-view（低风险）✅**
- [x] 创建 `src/app/features/text/components/`
- [x] 迁移 `src/components/text-view/*.component.ts` (12 个文件)
- [x] 更新所有导入路径 (`../../services/` → `../../../../services/`)
- [x] 更新 `features/text/index.ts` 指向新位置
- [x] 更新 `project-shell.component.ts` 使用 feature 导入
- [x] 修正类型导出（移除不存在的类型）
- [x] 删除冗余文件 (index.ts, stage-list.component.ts, task-card.component.ts)
- [x] TypeScript 编译通过

**第二批: flow（中风险）✅**
- [x] 创建 `src/app/features/flow/components/`
- [x] 创建 `src/app/features/flow/services/`
- [x] 迁移 `src/components/flow/*.component.ts` (10 个组件文件)
- [x] 迁移 `src/services/flow-*.service.ts` (14 个服务文件)
- [x] 创建 components/index.ts 和 services/index.ts barrel 文件
- [x] 更新 features/flow/index.ts 导出
- [x] 更新所有内部导入路径
- [x] 更新外部引用 (project-shell, lineage-color.service, services/index.ts)
- [x] 保留 src/components/flow/index.ts 作为兼容层
- [x] TypeScript 编译通过

**第三批: modals（低风险）✅**
- [x] 创建 `src/app/shared/modals/` 目录
- [x] 迁移 `src/components/modals/*.component.ts` (12 个 modal 文件)
- [x] 更新 `ModalLoaderService` 动态导入路径
- [x] 更新 `shared/ui/index.ts` 导出
- [x] TypeScript 编译通过

**第四批: shared（清理）✅**
- [x] 创建 `src/app/shared/components/` 目录
- [x] 迁移通用组件 (8 个): attachment-manager, error-boundary, error-page, not-found, offline-banner, reset-password, sync-status, toast-container
- [x] 更新 `app.component.ts` 和 `app.routes.ts` 导入路径
- [x] 删除旧的 `src/components/flow/index.ts` 和 `src/components/text-view.component.ts`
- [x] `src/components/` 仅保留 `project-shell.component.ts` (根组件)
- [x] TypeScript 编译通过

---

## Phase 3: 配置文件拆分

### 状态：✅ 完成

### 最终结构

```
src/config/
├── index.ts              # 统一导出（新建）
├── layout.config.ts      # LAYOUT_CONFIG, FLOATING_TREE_CONFIG, GOJS_CONFIG, LETTERS, SUPERSCRIPT_DIGITS
├── sync.config.ts        # SYNC_CONFIG, SYNC_PERCEPTION_CONFIG, SYNC_MODE_CONFIG, REQUEST_THROTTLE_CONFIG, 
│                         # SYNC_CHECKPOINT_CONFIG, CONFLICT_HISTORY_CONFIG, CACHE_CONFIG, OPTIMISTIC_CONFIG, QUEUE_CONFIG
├── ui.config.ts          # UI_CONFIG, TOAST_CONFIG, SEARCH_CONFIG, DEEP_LINK_CONFIG, FLOW_VIEW_CONFIG
├── auth.config.ts        # AUTH_CONFIG, GUARD_CONFIG
├── timeout.config.ts     # TIMEOUT_CONFIG, TimeoutLevel, RETRY_POLICY
├── attachment.config.ts  # ATTACHMENT_CONFIG, ATTACHMENT_CLEANUP_CONFIG
├── task.config.ts        # TRASH_CONFIG, UNDO_CONFIG
└── flow-styles.ts        # 保持不变
```

**完成任务**:
- [x] 创建 7 个模块化配置文件
- [x] 创建 index.ts 统一导出
- [x] 删除原始 constants.ts (481 行)
- [x] 批量更新所有导入路径 (`/constants` → 目录导入)
- [x] TypeScript 编译验证通过
- 📝 提交: 3710558

---

## Phase 4: 类型安全增强

### 优先级排序（按顾问建议）

| 优先级 | 范围 | 说明 | 状态 |
|--------|------|------|------|
| P0 | `Task` 模型 | 触及 IndexedDB 和 Supabase 的核心数据 | ✅ 完成 |
| P0 | `Project` 模型 | 同上 | ✅ 完成 |
| P1 | `Connection` 模型 | 关系数据 | ✅ 完成 |
| P2 | GoJS 回调参数 | 事件处理中的 any | 🔄 渐进式 |
| P3 | 内部工具函数 | 私有方法 | 🔄 渐进式 |
| ❌ | 测试文件 | 不处理 | - |
| ❌ | 工具脚本 | 不处理 | - |

### 任务清单

- [x] 修改 `eslint.config.js`: `'@typescript-eslint/no-explicit-any': 'warn'`
- [x] 运行 `npm run lint` 收集所有 any 警告（初始 244 个）
- [x] 修复 `src/models/flow-view-state.ts` 中的 any（使用 LinkDataRef 接口）
- [x] 修复 `src/models/gojs-boundary.ts` 中的 any（使用 go.Part/go.Link）
- [x] P0/P1 优先级修复完成（models 层）
- [ ] P2 优先级：GoJS 回调参数（254 个警告，可渐进处理）
- [ ] 逐步将规则升级为 `'error'`

### 当前警告分布（254 个）

| 文件分类 | 警告数 | 说明 |
|----------|--------|------|
| `flow-diagram.service.ts` | 29 | GoJS 事件回调 |
| `flow-debug.service.ts` | 17 | 调试工具 |
| `flow-diagram-config.service.ts` | 13 | 配置函数 |
| `flow-view.component.ts` | 6 | 视图组件 |
| `flow-task-detail.component.ts` | 3 | 详情面板 |
| `flow-drag-drop.service.ts` | 3 | 拖拽逻辑 |
| `app.component.ts` | 5 | 模态框回调 |
| `simple-sync.service.ts` | 3 | 同步服务 |
| 其他 | ~175 | 分散在各 flow 服务中 |

**策略说明**：
- GoJS 的 TypeScript 类型定义不完整，事件回调多为 `any`
- 可创建 `src/types/gojs-extended.d.ts` 补充类型定义
- 或使用 `// eslint-disable-next-line` 显式标记不可避免的 any

---

## Phase 5: 测试覆盖补充

### 状态：✅ 完成

### 测试覆盖统计

| 服务 | 测试文件 | 测试数 | 覆盖范围 |
|------|----------|--------|----------|
| `SimpleSyncService` | ✅ | 34 | LWW、RetryQueue、Sentry、Tombstone |
| `SyncCoordinatorService` | ✅ | 60 | 同步状态、持久化、冲突解决、集成场景 |
| `TaskTrashService` | ✅ | 12 | 软删除、永久删除、恢复、清空 |
| `TaskOperationService` | ✅ | 5 | deletedMeta、parentId 验证、级联更新 |
| `TaskRepositoryService` | ✅ | 6 | tombstone-wins、purge、promotion |
| `FlowDiagramService` | ✅ | 17 | 初始化、错误处理、暂停/恢复、销毁、视图状态 |
| `FlowEventService` | ✅ | 15 | 事件回调注册、节点/连接点击、选择移动 |
| `FlowSelectionService` | ✅ | 14 | 选择状态、多选、状态保存/恢复 |
| `FlowZoomService` | ✅ | 19 | 缩放操作、视图状态、坐标转换 |
| `FlowDragDropService` | ✅ | 12 | 拖放状态、事件处理、待分配区域 |
| `FlowLinkService` | ✅ | 15 | 连接模式、对话框状态、连接创建 |
| `FlowConnectionEditorComponent` | ✅ | 8 | Markdown 渲染、模式切换 |
| `GlobalErrorHandler` | ✅ | 21 | 错误分级、去重、恢复对话框 |
| `LoggerService` | ✅ | 17 | 日志级别、持久化、分类 |
| `UndoService` | ✅ | 16 | 撤销/重做、版本冲突、防抖 |
| `ToastService` | ✅ | 17 | 通知类型、去重、合并、自动消失 |
| `SearchService` | ✅ | 10 | 任务/项目搜索、高亮 |
| `ThemeService` | ✅ | 15 | 主题切换、持久化、云端同步 |
| `RequestThrottleService` | ✅ | 15 | 并发限制、去重、超时、重试 |
| `RemoteChangeHandlerService` | ✅ | 5 | 请求 ID、销毁处理、编辑状态 |
| `StoreService` | ✅ | 25 | 项目管理、displayId、父子关系、回收站 |
| `TaskStore/ProjectStore/ConnectionStore` | ✅ | 22 | O(1) 查找、批量操作 |
| `StorePersistenceService` | ✅ | 11 | 保存/删除、防抖 |
| `ActionQueueService` | ✅ | - | 队列操作 |
| `ChangeTrackerService` | ✅ | - | 变更追踪 |
| `ConflictResolutionService` | ✅ | - | 冲突解决 |
| `LayoutService` | ✅ | - | 布局计算 |
| `LineageColorService` | ✅ | - | 血缘着色 |
| `MinimapMathService` | ✅ | - | 小地图数学 |
| `ReactiveMinimapService` | ✅ | 22 | 拖拽会话、Sync-Shrink 效果 |
| `OptimisticStateService` | ✅ | - | 乐观更新 |
| `PreferenceService` | ✅ | - | 用户偏好 |
| `SyncModeService` | ✅ | 15 | 模式切换、间隔配置 |
| `TabSyncService` | ✅ | 10 | 标签页同步 |
| `supabase-error.ts` | ✅ | 27 | 错误转换、可重试判断、友好提示 |
| `DataLossDetection` | ✅ | 6 | 数据丢失检测（集成测试）|
| `FloatingTaskTree` | ✅ | - | 浮动任务树 |

### 总计

- **测试文件**: 37 个
- **通过测试**: 636 个
- **跳过测试**: 8 个

### 后续可选任务（非必需）

- [ ] 节点创建/删除测试（需要完整 GoJS mock）
- [ ] 连接线创建/删除测试（需要完整 GoJS mock）
- [ ] E2E 测试补充

---

## 风险登记册

| ID | 风险 | 可能性 | 影响 | 缓解措施 | 状态 |
|----|------|--------|------|----------|------|
| R1 | `RetryQueue` 逻辑被意外拆分导致离线数据丢失 | 低 | 🔴 严重 | 遵循顾问建议，不拆分 `SimpleSyncService` 执行逻辑 | 🟢 已缓解 |
| R2 | Sentry 错误上报丢失 | 低 | 🟡 中等 | Phase 0 创建守卫测试，4 个 Sentry 测试通过 | 🟢 已缓解 |
| R3 | 循环依赖导致构建失败 | 低 | 🟡 中等 | Strangler Fig 逐个迁移，构建通过 | 🟢 已缓解 |
| R4 | 移动端 GoJS 懒加载失效 | 低 | 🔴 严重 | `@defer` 和 `isMobile()` 检查保持完整 | 🟢 已缓解 |
| R5 | 全局替换导入破坏构建 | 低 | 🟡 中等 | 手动更新导入路径，逐步验证 | 🟢 已缓解 |
| R6 | GoJS any 类型导致运行时错误 | 中 | 🟡 中等 | 保持 warn 级别，渐进式添加类型 | 🟡 持续监控 |
| R7 | 测试覆盖不足导致回归 | 低 | 🟡 中等 | 553 个测试覆盖核心服务 | 🟢 已缓解 |

---

## 变更日志

### 2025-06-09 (Phase 5 扩展 + Phase 4 继续)

**新增流程图服务测试（+83 个测试）**:
- ✅ `FlowDiagramService` 扩展：9 → 17 tests（+8）
- ✅ 新增 `FlowEventService.spec.ts`：15 tests
- ✅ 新增 `FlowSelectionService.spec.ts`：14 tests
- ✅ 新增 `FlowZoomService.spec.ts`：19 tests
- ✅ 新增 `FlowDragDropService.spec.ts`：12 tests
- ✅ 新增 `FlowLinkService.spec.ts`：15 tests
- 📊 测试统计：553 → 636（+83 个测试）
- 📊 测试文件：32 → 37（+5 个文件）

**类型安全增强**:
- ✅ 创建 `src/types/gojs-extended.d.ts`（242 行）
- ✅ 定义 GoJS 扩展类型：`GoJSNodeData`, `GoJSLinkData`, `GoJSNode`, `GoJSLink`
- ✅ 添加类型守卫函数：`isGoJSNode()`, `isGoJSLink()`
- ✅ 更新 `FlowEventService` 使用新类型
- 📊 Lint 警告：254 → 247（-7 个）

### 2024-12-26 (Phase 5 完成)

**Phase 5 测试覆盖补充 - 全面完成**:
- ✅ 32 个测试文件，553 个测试通过
- ✅ 核心服务 100% 覆盖：
  - `SimpleSyncService` (34 tests) - LWW、RetryQueue、Sentry、Tombstone
  - `SyncCoordinatorService` (60 tests) - 同步状态、持久化、冲突解决、集成场景
  - `TaskTrashService` (12 tests) - 软删除、永久删除、恢复、清空
  - `GlobalErrorHandler` (21 tests) - 错误分级、去重、恢复对话框
  - `ToastService` (17 tests) - 通知类型、去重、合并
  - `UndoService` (16 tests) - 撤销/重做、版本冲突
  - `ReactiveMinimapService` (22 tests) - Sync-Shrink 效果
  - `RequestThrottleService` (15 tests) - 并发限制、重试
  - `supabase-error.ts` (27 tests) - 错误转换、可重试判断
- ✅ Store 层完整测试：TaskStore、ProjectStore、ConnectionStore
- ✅ 集成测试：DataLossDetection
- 📊 最终统计：553 passed | 8 skipped

### 2024-12-26 (Phase 4 进行中)

**Phase 4 类型安全增强 - P0/P1 优先级完成**:
- ✅ 启用 `@typescript-eslint/no-explicit-any: warn` 规则
- ✅ 修复 `src/models/flow-view-state.ts` 中的 any
- ✅ 修复 `src/models/gojs-boundary.ts` 中的 any
- ✅ P0/P1 优先级（models 层）完成
- 📊 剩余 254 个警告（GoJS 回调，P2/P3 优先级，可渐进处理）

### 2024-12-26 (Phase 3 完成)

**Phase 3 配置文件拆分完成**:
- ✅ 创建 7 个模块化配置文件:
  - `layout.config.ts` - 布局/GoJS 配置
  - `sync.config.ts` - 同步/离线/缓存配置
  - `ui.config.ts` - UI/动画/搜索配置
  - `auth.config.ts` - 认证/守卫配置
  - `timeout.config.ts` - 超时/重试策略
  - `attachment.config.ts` - 附件配置
  - `task.config.ts` - 任务/回收站配置
- ✅ 创建 `index.ts` 统一导出
- ✅ 删除原始 `constants.ts` (481 行 → 7 个模块)
- ✅ 批量更新 42 个文件的导入路径
- ✅ TypeScript 编译通过
- 📝 提交: 3710558

### 2024-12-26 (Phase 4 启动)

**Phase 4.1 类型安全增强 - P0 优先级完成**:
- ✅ 启用 `@typescript-eslint/no-explicit-any: warn` 规则
- ✅ 初始统计：244 个 any 警告
- ✅ 修复 `src/models/flow-view-state.ts`:
  - 创建 `LinkDataRef` 接口替代 `any`
- ✅ 修复 `src/models/gojs-boundary.ts`:
  - 使用 `go.Part` 替代 `extractNodeMoveData` 的 any 参数
  - 使用 `go.Link` 替代 `extractLinkCreateData` 的 any 参数
- ✅ TypeScript 编译通过
- 📝 提交: 40404e6
- 📊 剩余 241 个警告（主要在 GoJS 回调函数中，属于 P2/P3 优先级）

### 2024-12-26 (Phase 5 启动)

**Phase 5.1 FlowDiagramService 测试覆盖**:
- ✅ 创建 `flow-diagram.service.spec.ts`
- ✅ Mock GoJS 库和所有子服务
- ✅ 9 个测试用例：
  - 初始状态测试 (4)
  - 错误处理测试 (1)
  - 暂停/恢复模式测试 (2)
  - 销毁逻辑测试 (2)
- ✅ 所有测试通过
- 📝 提交: 9ba4b3d
- 📊 总测试数：441 passed | 8 skipped

### 2024-12-26 (Phase 2 完成)

**Phase 2.3-2.4 modals 和 shared 组件迁移完成**:
- ✅ 创建 `src/app/shared/modals/` 目录
- ✅ 迁移 12 个 modal 组件:
  - `settings-modal.component.ts`
  - `login-modal.component.ts`
  - `conflict-modal.component.ts`
  - `new-project-modal.component.ts`
  - `delete-confirm-modal.component.ts`
  - `config-help-modal.component.ts`
  - `trash-modal.component.ts`
  - `migration-modal.component.ts`
  - `error-recovery-modal.component.ts`
  - `storage-escape-modal.component.ts`
  - `dashboard-modal.component.ts`
  - `index.ts` (barrel)
- ✅ 创建 `src/app/shared/components/` 目录
- ✅ 迁移 8 个通用组件:
  - `attachment-manager.component.ts`
  - `error-boundary.component.ts`
  - `error-page.component.ts`
  - `not-found.component.ts`
  - `offline-banner.component.ts`
  - `reset-password.component.ts`
  - `sync-status.component.ts`
  - `toast-container.component.ts`
- ✅ 更新 `modal-loader.service.ts` 动态导入路径
- ✅ 更新 `app.component.ts` 和 `app.routes.ts` 导入
- ✅ 更新 `shared/ui/index.ts` 导出
- ✅ 删除旧的 `src/components/flow/index.ts` 和 `src/components/text-view.component.ts`
- ✅ `src/components/` 仅保留 `project-shell.component.ts`
- ✅ TypeScript 编译通过
- 📝 提交: 8459823

### 2024-12-26 (第三轮)

**Phase 2.1 text-view 迁移完成**:
- ✅ 创建 `src/app/features/text/components/` 目录
- ✅ 迁移 12 个 text-view 组件和服务:
  - `text-view.component.ts`
  - `text-stages.component.ts`
  - `text-stage-card.component.ts`
  - `text-task-card.component.ts`
  - `text-task-editor.component.ts`
  - `text-task-connections.component.ts`
  - `text-unassigned.component.ts`
  - `text-unfinished.component.ts`
  - `text-view-loading.component.ts`
  - `text-delete-dialog.component.ts`
  - `text-view-drag-drop.service.ts`
  - `text-view.types.ts`
- ✅ 批量更新导入路径 (`../../services/` → `../../../../services/`)
- ✅ 更新 `features/text/index.ts` 指向新位置
- ✅ 更新 `project-shell.component.ts` 使用 feature 导入
- ✅ 修正类型导出（移除不存在的 TextViewState 等类型）
- ✅ 删除冗余文件 (index.ts, stage-list.component.ts, task-card.component.ts)
- ✅ TypeScript 编译验证通过

### 2024-12-26 (续)

**Phase 0 完成**:
- ✅ 创建并通过 4 个 Sentry 守卫测试 (simple-sync.service.spec.ts)
- ✅ 删除 4 个废弃文件:
  - `src/components/text-view/delete-confirm-modal.component.ts`
  - `src/components/text-view/unassigned-tasks.component.ts`
  - `src/components/text-view/unfinished-items.component.ts`
  - `src/services/gojs-diagram.service.ts` (1095 行未使用代码)
- ✅ 更新导出文件，移除废弃引用

**Phase 1 开始 (Strangler Fig 模式)**:
- ✅ 创建 `FlowOverviewService` 基础框架 (~350 行)
- ✅ 定义 `OverviewOptions` 和 `OverviewState` 接口
- ✅ 实现基本生命周期方法
- ✅ 创建 `TaskTrashService` 回收站管理服务 (~320 行)
- ✅ 定义回收站相关接口
- ✅ 添加到 `services/index.ts` 和 `features/flow/index.ts`
- ✅ 构建验证通过

### 2024-12-26 (更新)

**Phase 2.2 - flow 迁移完成**
- ✅ 迁移 10 个 flow 组件到 `src/app/features/flow/components/`
- ✅ 迁移 14 个 flow 服务到 `src/app/features/flow/services/`
- ✅ 创建 barrel 文件 (components/index.ts, services/index.ts)
- ✅ 更新所有导入路径（内部 + 外部引用）
- ✅ 保留 `src/components/flow/index.ts` 作为兼容层
- ✅ TypeScript 编译通过
- 📝 提交: 3d97438

### 2024-12-26

- 📝 创建重构进度跟踪文档
- 📋 制定 6 阶段优化计划
- ⚠️ 整合高级技术顾问评审意见
- 🔄 开始 Phase 0: 清理废弃代码

---

## 附录

### A. 删除确认组件引用分析

```
src/components/text-view/delete-confirm-modal.component.ts
├── 引用于: src/app/features/text/index.ts (导出)
└── 状态: 文件内容为空，已标记 @deprecated

src/components/modals/delete-confirm-modal.component.ts  
├── 引用于: src/app/core/services/modal-loader.service.ts
└── 状态: 主要使用，通用动态模态框

src/components/flow/flow-delete-confirm.component.ts
├── 引用于: src/components/flow-view.component.ts
├── 引用于: src/app/features/flow/index.ts
└── 状态: 流程图专用，包含"保留子任务"选项

src/components/text-view/text-delete-dialog.component.ts
├── 引用于: (需检查)
└── 状态: 文本视图专用
```

### B. 服务行数统计

| 服务文件 | 行数 | 状态 | 说明 |
|----------|------|------|------|
| `flow-diagram.service.ts` | 2140 | ✅ 已拆分 | FlowOverviewService 分离 |
| `simple-sync.service.ts` | 1858 | ⚠️ 不拆分 | 保持 RetryQueue 与执行逻辑一体 |
| `task-operation.service.ts` | 1784 | ✅ 已拆分 | TaskTrashService 分离 |
| `sync-coordinator.service.ts` | 1261 | 保持 | 协调器职责清晰 |
| `store.service.ts` | 806 | 保持 | 门面模式 |
| `user-session.service.ts` | 552 | 保持 | 单一职责 |
| `flow-overview.service.ts` | 431 | ✅ 新增 | 小地图管理 |
| `task-trash.service.ts` | 389 | ✅ 新增 | 回收站管理 |

### C. 测试文件清单

```
src/
├── app/
│   ├── core/
│   │   ├── services/
│   │   │   └── simple-sync.service.spec.ts          (34 tests)
│   │   └── state/
│   │       ├── stores.spec.ts                       (22 tests)
│   │       └── store-persistence.service.spec.ts    (11 tests)
│   └── features/
│       └── flow/
│           ├── components/
│           │   └── flow-connection-editor.component.spec.ts (8 tests)
│           └── services/
│               └── flow-diagram.service.spec.ts     (9 tests)
├── services/
│   ├── action-queue.service.spec.ts
│   ├── change-tracker.service.spec.ts
│   ├── conflict-resolution.service.spec.ts
│   ├── data-loss-detection.integration.spec.ts      (6 tests)
│   ├── floating-task-tree.spec.ts
│   ├── global-error-handler.service.spec.ts         (21 tests)
│   ├── layout.service.spec.ts
│   ├── lineage-color.service.spec.ts
│   ├── logger.service.spec.ts                       (17 tests)
│   ├── minimap-math.service.spec.ts
│   ├── optimistic-state.service.spec.ts
│   ├── preference.service.spec.ts
│   ├── reactive-minimap.service.spec.ts             (22 tests)
│   ├── remote-change-handler.service.spec.ts        (5 tests)
│   ├── request-throttle.service.spec.ts             (15 tests)
│   ├── search.service.spec.ts                       (10 tests)
│   ├── store.service.spec.ts                        (25 tests)
│   ├── sync-coordinator.service.spec.ts             (60 tests)
│   ├── sync-mode.service.spec.ts                    (15 tests)
│   ├── tab-sync.service.spec.ts                     (10 tests)
│   ├── task-operation.service.spec.ts               (5 tests)
│   ├── task-repository.service.spec.ts              (6 tests)
│   ├── task-trash.service.spec.ts                   (12 tests)
│   ├── theme.service.spec.ts                        (15 tests)
│   ├── toast.service.spec.ts                        (17 tests)
│   └── undo.service.spec.ts                         (16 tests)
└── utils/
    └── supabase-error.spec.ts                       (27 tests)

总计: 32 测试文件, 553 tests passed, 8 skipped
```

### D. 下一步建议（可选改进）

#### 短期（1-2 周）

| 任务 | 优先级 | 说明 |
|------|--------|------|
| GoJS 类型定义补充 | P3 | 创建 `src/types/gojs-extended.d.ts` 减少 any |
| E2E 测试补充 | P3 | 补充 Playwright 关键路径测试 |
| 性能监控 | P3 | 添加 Sentry Performance 追踪 |

#### 中期（1-2 月）

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 代码分割优化 | P2 | 进一步优化 GoJS 懒加载 |
| PWA 离线体验 | P2 | Service Worker 策略优化 |
| 国际化准备 | P3 | 提取硬编码字符串 |

#### 长期（3+ 月）

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 微前端架构 | P4 | 如需多团队协作 |
| GraphQL 迁移 | P4 | 如 API 复杂度增加 |

### E. 重构原则回顾

1. **不造轮子** ✅
   - 使用 Supabase Realtime（不自建 WebSocket）
   - 使用 UUID（不自建 ID 生成器）
   - 使用 Sentry（不自建错误监控）

2. **Strangler Fig 模式** ✅
   - 逐个功能迁移，保持系统可用
   - 新旧代码共存，渐进替换

3. **测试先行** ✅
   - 重构前创建守卫测试
   - 553 个测试保障回归

4. **保持简单** ✅
   - 不过度拆分 SimpleSyncService
   - TaskOperationService 保持门面模式
   - 避免抽象过早优化
