# NanoFlow 项目结构优化进度跟踪

> **创建日期**: 2024-12-26
> **状态**: 🔄 进行中
> **核心哲学**: 不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

---

## 📋 目录

1. [高级技术顾问评审摘要](#高级技术顾问评审摘要)
2. [优化阶段总览](#优化阶段总览)
3. [Phase 0: 清理废弃与重复代码](#phase-0-清理废弃与重复代码)
4. [Phase 1: 巨型服务拆分](#phase-1-巨型服务拆分)
5. [Phase 2: 目录结构重组](#phase-2-目录结构重组)
6. [Phase 3: 配置文件拆分](#phase-3-配置文件拆分)
7. [Phase 4: 类型安全增强](#phase-4-类型安全增强)
8. [Phase 5: 测试覆盖补充](#phase-5-测试覆盖补充)
9. [风险登记册](#风险登记册)
10. [变更日志](#变更日志)

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
| **Phase 2** | 目录结构重组 | 🔄 进行中 | 16h | 75% |
| **Phase 3** | 配置文件拆分 | ⏳ 待开始 | 2h | 0% |
| **Phase 4** | 类型安全增强 | ⏳ 待开始 | 4h | 0% |
| **Phase 5** | 测试覆盖补充 | ⏳ 待开始 | 16h | 0% |

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

### 1.1 FlowDiagramService 拆分 🔄

**当前行数**: 2140 行
**Overview 相关代码**: 301 行

**状态**: 🔄 进行中（采用 Strangler Fig 模式逐步迁移）

**已完成**:
- [x] 创建 `FlowOverviewService` 基础框架
- [x] 定义 Overview 相关的接口和类型
- [x] 实现基本的生命周期方法 (initialize/dispose/refresh)
- [x] 导出新服务到 `services/index.ts` 和 `features/flow/index.ts`
- [x] 验证构建通过

**后续迁移任务**（Strangler Fig 模式）:
- [ ] 将 `setupOverviewAutoScale()` 完整逻辑迁移到 `FlowOverviewService`
- [ ] 将 `attachOverviewPointerListeners()` 完整逻辑迁移
- [ ] 更新 `FlowDiagramService` 委托 Overview 初始化给新服务
- [ ] 移除 `FlowDiagramService` 中的 Overview 代码（~800 行）

**关键约束**:
- ✅ 保持 `@defer` block 和 `isMobile()` 检查完整
- ✅ 不破坏 `FlowEventService` 的事件代理模式

### 1.2 TaskOperationService 拆分 🔄

**当前行数**: 1784 行

**状态**: 🔄 进行中（采用 Strangler Fig 模式逐步迁移）

**已完成**:
- [x] 创建 `TaskTrashService` 回收站管理服务 (~320 行)
- [x] 定义回收站相关接口 (DeletedTaskMeta, DeleteResult, RestoreResult)
- [x] 实现软删除、永久删除、恢复、清空回收站方法
- [x] 支持 `keepChildren` 参数（删除时保留子任务）
- [x] 导出新服务到 `services/index.ts`
- [x] 验证构建通过

**拆分计划**:

| 新服务 | 状态 | 职责 |
|--------|------|------|
| `TaskTrashService` | ✅ 已创建 | 回收站管理：软删除、永久删除、恢复、清空 |
| `TaskMoveService` | ⏳ 待创建 | 移动任务：阶段变更、父子关系变更、重排序 |
| `TaskCrudService` | ⏳ 待创建 | 基础 CRUD：创建、读取、更新任务属性 |

**后续迁移任务**（Strangler Fig 模式）:
- [ ] 更新 `TaskOperationService` 委托回收站操作给 `TaskTrashService`
- [ ] 创建 `TaskMoveService` 处理移动/重排序逻辑
- [ ] 创建 `TaskCrudService` 处理基础 CRUD
- [ ] 将 `TaskOperationService` 转变为门面服务

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

**第三批: modals（低风险）**
- [ ] 创建 `src/app/features/project/components/modals/`
- [ ] 迁移 `src/components/modals/*.component.ts`
- [ ] 更新 `ModalLoaderService` 导入路径

**第四批: shared（清理）**
- [ ] 迁移通用组件到 `src/app/shared/components/`
- [ ] 删除空的 `src/components/` 目录

---

## Phase 3: 配置文件拆分

### 目标结构

```
src/config/
├── index.ts           # 统一导出
├── layout.config.ts   # LAYOUT_CONFIG
├── sync.config.ts     # SYNC_CONFIG, SYNC_PERCEPTION_CONFIG, etc.
├── ui.config.ts       # UI_CONFIG, GOJS_CONFIG, TOAST_CONFIG
├── auth.config.ts     # AUTH_CONFIG, GUARD_CONFIG
└── timeout.config.ts  # TIMEOUT_CONFIG, RETRY_POLICY
```

**任务清单**:
- [ ] 创建各配置文件
- [ ] 从 `constants.ts` 迁移配置
- [ ] 更新 `index.ts` 导出
- [ ] 全局替换导入路径

---

## Phase 4: 类型安全增强

### 优先级排序（按顾问建议）

| 优先级 | 范围 | 说明 |
|--------|------|------|
| P0 | `Task` 模型 | 触及 IndexedDB 和 Supabase 的核心数据 |
| P0 | `Project` 模型 | 同上 |
| P1 | `Connection` 模型 | 关系数据 |
| P2 | 服务层参数 | 公共 API |
| P3 | 内部实现 | 私有方法 |
| ❌ | 测试文件 | 不处理 |
| ❌ | 工具脚本 | 不处理 |

### 任务清单

- [ ] 修改 `eslint.config.js`: `'@typescript-eslint/no-explicit-any': 'warn'`
- [ ] 运行 `npm run lint` 收集所有 any 警告
- [ ] 按优先级修复 `src/models/` 中的 any
- [ ] 按优先级修复 `src/services/` 中的 any
- [ ] 逐步将规则升级为 `'error'`

---

## Phase 5: 测试覆盖补充

### 优先级

| 服务 | 当前覆盖 | 目标 |
|------|----------|------|
| `FlowDiagramService` | ❌ 无 | 核心方法 70% |
| `TaskOperationService` | ✅ 已有 | 补充边界用例 |
| `SimpleSyncService` | ✅ 已有 | 补充 Sentry 测试 |
| `LayoutService` | ✅ 已有 | 保持 |

### 任务清单

- [ ] 创建 `flow-diagram.service.spec.ts`
- [ ] 测试：节点创建/删除
- [ ] 测试：连接线创建/删除
- [ ] 测试：视图状态保存/恢复
- [ ] 创建 Sentry 集成测试

---

## 风险登记册

| ID | 风险 | 可能性 | 影响 | 缓解措施 | 状态 |
|----|------|--------|------|----------|------|
| R1 | `RetryQueue` 逻辑被意外拆分导致离线数据丢失 | 低 | 🔴 严重 | 遵循顾问建议，不拆分 `SimpleSyncService` 执行逻辑 | 🟢 已缓解 |
| R2 | Sentry 错误上报丢失 | 中 | 🟡 中等 | Phase 0 先创建守卫测试 | ⏳ 待处理 |
| R3 | 循环依赖导致构建失败 | 中 | 🟡 中等 | Strangler Fig 逐个迁移 | 🟢 已规划 |
| R4 | 移动端 GoJS 懒加载失效 | 低 | 🔴 严重 | Phase 1 验证 `@defer` 完整 | ⏳ 待处理 |
| R5 | 全局替换导入破坏构建 | 高 | 🟡 中等 | 不使用全局替换，手动修复 | 🟢 已规划 |

---

## 变更日志

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

| 服务文件 | 行数 | 建议 |
|----------|------|------|
| `flow-diagram.service.ts` | 2140 | 拆分 |
| `simple-sync.service.ts` | 1858 | ⚠️ 谨慎处理 |
| `task-operation.service.ts` | 1784 | 拆分 |
| `sync-coordinator.service.ts` | 1261 | 暂不处理 |
| `store.service.ts` | 806 | 保持门面 |
| `user-session.service.ts` | 552 | 保持 |
