# NanoFlow AI 编码指南

> **核心哲学**：不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.x | 前端框架 |
| Supabase | ^2.84.0 | 后端即服务 (BaaS) |
| GoJS | ^3.1.1 | 流程图渲染 |
| Sentry | ^10.32.1 | 错误监控 + 会话回放 |
| Vitest | - | 单元测试 |
| Playwright | - | E2E 测试 |

## 极简架构原则

### 1. ID 策略：客户端生成 UUID

```typescript
// 绝对规则：所有实体在客户端创建时使用 UUID v4
const newTask: Task = {
  id: crypto.randomUUID(),  // 禁止使用临时 ID 或数据库自增 ID
  title: '新任务',
  stage: null,              // null = 待分配区
  parentId: null,
  status: 'active',
};
```

**好处**：离线创建的数据可直接关联，同步时无需 ID 转换。

### 2. 数据流与同步

```
读取：首屏加载 → 本地 IndexedDB → 后台拉取 Supabase (updated_at > last_sync_time)
写入：用户操作 → 立即写入本地 + 更新 UI → 后台推送 Supabase（防抖 3s）→ 失败放入 RetryQueue
冲突：Last-Write-Wins (LWW) - 以 updated_at 为准
```

### 3. 状态管理（Angular Signals + Map）

```typescript
// src/app/core/state/stores.ts - O(1) 查找
readonly tasksMap = signal<Map<string, Task>>(new Map());
readonly tasks = computed(() => Array.from(this.tasksMap().values()));
```

### 4. 移动端 GoJS 懒加载

```typescript
// 条件渲染，完全销毁/重建，禁止 visibility: hidden
@if (!store.isMobile() || store.activeView() === 'flow') {
  @defer (on viewport) { <app-flow-view /> }
}
```

### 5. 错误监控（Sentry）

```typescript
import * as Sentry from '@sentry/angular';
Sentry.captureException(error, { tags: { operation: 'operationName' } });
// Supabase 错误需转换：supabaseErrorToError(error) → src/utils/supabase-error.ts
```

---

## 目录结构

```
src/
├── app/
│   ├── core/                         # 核心单例服务
│   │   ├── services/
│   │   │   ├── simple-sync.service.ts      # 同步（LWW + RetryQueue）
│   │   │   └── modal-loader.service.ts     # 模态框懒加载
│   │   └── state/
│   │       ├── stores.ts                   # TaskStore, ProjectStore (Signal-based)
│   │       └── store-persistence.service.ts # 本地持久化
│   │
│   ├── features/                     # 业务功能模块
│   │   ├── flow/                     # 流程图视图
│   │   │   ├── components/
│   │   │   │   ├── flow-view.component.ts
│   │   │   │   ├── flow-palette.component.ts
│   │   │   │   ├── flow-toolbar.component.ts
│   │   │   │   ├── flow-task-detail.component.ts
│   │   │   │   ├── flow-connection-editor.component.ts
│   │   │   │   ├── flow-cascade-assign-dialog.component.ts
│   │   │   │   ├── flow-delete-confirm.component.ts
│   │   │   │   ├── flow-link-type-dialog.component.ts
│   │   │   │   └── flow-link-delete-hint.component.ts
│   │   │   └── services/             # GoJS 流程图服务（已拆分）
│   │   │       ├── flow-diagram.service.ts       # 主服务：初始化、生命周期
│   │   │       ├── flow-diagram-config.service.ts
│   │   │       ├── flow-event.service.ts         # 事件处理
│   │   │       ├── flow-template.service.ts      # 节点/连线模板
│   │   │       ├── flow-template-events.ts       # 事件总线（解耦桥梁）
│   │   │       ├── flow-selection.service.ts
│   │   │       ├── flow-zoom.service.ts
│   │   │       ├── flow-drag-drop.service.ts
│   │   │       ├── flow-link.service.ts
│   │   │       ├── flow-touch.service.ts
│   │   │       ├── flow-layout.service.ts
│   │   │       ├── flow-overview.service.ts
│   │   │       ├── flow-task-operations.service.ts
│   │   │       └── flow-debug.service.ts
│   │   └── text/                     # 文本列表视图
│   │       └── components/
│   │           ├── text-view.component.ts
│   │           ├── text-stages.component.ts
│   │           ├── text-unfinished.component.ts
│   │           ├── text-unassigned.component.ts
│   │           ├── text-task-card.component.ts
│   │           ├── text-task-editor.component.ts
│   │           ├── text-task-connections.component.ts
│   │           ├── text-stage-card.component.ts
│   │           ├── text-delete-dialog.component.ts
│   │           └── text-view-drag-drop.service.ts
│   │
│   └── shared/                       # 共享组件
│       ├── components/
│       │   ├── attachment-manager.component.ts
│       │   ├── sync-status.component.ts
│       │   ├── error-boundary.component.ts
│       │   ├── error-page.component.ts
│       │   ├── offline-banner.component.ts
│       │   ├── toast-container.component.ts
│       │   ├── not-found.component.ts
│       │   └── reset-password.component.ts
│       └── modals/
│           ├── login-modal.component.ts
│           ├── settings-modal.component.ts
│           ├── new-project-modal.component.ts
│           ├── trash-modal.component.ts
│           ├── conflict-modal.component.ts
│           ├── dashboard-modal.component.ts
│           ├── error-recovery-modal.component.ts
│           ├── migration-modal.component.ts
│           ├── config-help-modal.component.ts
│           ├── storage-escape-modal.component.ts
│           └── delete-confirm-modal.component.ts
│
├── components/
│   └── project-shell.component.ts    # 项目容器/视图切换
│
├── services/                         # 主服务层
│   ├── 状态门面
│   │   └── store.service.ts          # 门面服务（Facade）- 协调所有子服务
│   ├── 业务服务
│   │   ├── task-operation.service.ts       # 任务 CRUD（核心）
│   │   ├── task-operation-adapter.service.ts
│   │   ├── task-repository.service.ts
│   │   ├── task-trash.service.ts
│   │   ├── attachment.service.ts
│   │   ├── search.service.ts
│   │   ├── layout.service.ts               # 布局计算
│   │   ├── lineage-color.service.ts
│   │   ├── minimap-math.service.ts
│   │   └── reactive-minimap.service.ts
│   ├── 状态服务
│   │   ├── project-state.service.ts
│   │   ├── ui-state.service.ts
│   │   ├── optimistic-state.service.ts
│   │   └── undo.service.ts
│   ├── 同步服务
│   │   ├── sync-coordinator.service.ts
│   │   ├── remote-change-handler.service.ts
│   │   ├── conflict-resolution.service.ts
│   │   ├── conflict-storage.service.ts
│   │   ├── change-tracker.service.ts
│   │   ├── storage-adapter.service.ts
│   │   ├── action-queue.service.ts
│   │   ├── request-throttle.service.ts
│   │   ├── sync-mode.service.ts
│   │   ├── tab-sync.service.ts
│   │   └── persistence-failure-handler.service.ts
│   ├── 基础设施
│   │   ├── auth.service.ts
│   │   ├── supabase-client.service.ts
│   │   ├── user-session.service.ts
│   │   ├── preference.service.ts
│   │   ├── toast.service.ts
│   │   ├── logger.service.ts
│   │   ├── theme.service.ts
│   │   ├── modal.service.ts
│   │   ├── dynamic-modal.service.ts
│   │   └── migration.service.ts
│   ├── 错误处理
│   │   └── global-error-handler.service.ts # 分级 + Sentry 集成
│   └── guards/
│
├── config/                           # 配置常量（按职责拆分）
│   ├── index.ts                      # 统一导出
│   ├── sync.config.ts                # SYNC_CONFIG, REQUEST_THROTTLE_CONFIG
│   ├── layout.config.ts              # LAYOUT_CONFIG, GOJS_CONFIG
│   ├── timeout.config.ts             # TIMEOUT_CONFIG, RETRY_POLICY
│   ├── ui.config.ts                  # UI_CONFIG, TOAST_CONFIG
│   ├── auth.config.ts
│   ├── task.config.ts
│   ├── attachment.config.ts
│   └── flow-styles.ts                # GoJS 样式
│
├── models/
│   ├── index.ts                      # Task, Project, Connection, Attachment
│   ├── supabase-types.ts             # TaskRow, ProjectRow, ConnectionRow
│   ├── supabase-mapper.ts
│   └── api-types.ts
│
├── utils/
│   ├── result.ts                     # Result<T,E> + ErrorCodes
│   ├── supabase-error.ts             # Supabase 错误转 Error
│   ├── date.ts
│   ├── timeout.ts
│   └── markdown.ts
│
└── environments/
```

## 核心服务架构

```
StoreService (门面/Facade) ※ 严禁添加新业务逻辑
    ├── UserSessionService       # 登录/登出、项目切换
    ├── TaskOperationAdapterService # 任务 CRUD + 撤销协调
    ├── ProjectStateService      # 项目/任务状态
    ├── UiStateService           # UI 状态
    ├── SyncCoordinatorService   # 同步调度
    ├── SearchService            # 搜索
    └── PreferenceService        # 用户偏好
```

### 事件代理模式（GoJS 解耦）

```typescript
// FlowTemplateService → flow-template-events.ts → FlowEventService
// 模板发送信号，EventService 注册处理器，完全解耦
click: (e, node) => flowTemplateEventHandlers.onNodeClick?.(node);
```

---

## 关键配置

### 同步配置 (src/config/sync.config.ts)

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖延迟 |
| `SYNC_CONFIG.EDITING_TIMEOUT` | 5000ms | 编辑状态超时 |
| `SYNC_CONFIG.CONFLICT_TIME_THRESHOLD` | 10000ms | 冲突检测阈值 |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | 云端加载超时 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求 |

### 布局配置 (src/config/layout.config.ts)

| 配置 | 值 | 说明 |
|------|-----|------|
| `LAYOUT_CONFIG.STAGE_SPACING` | 260 | 阶段间水平间距 |
| `LAYOUT_CONFIG.ROW_SPACING` | 140 | 任务行垂直间距 |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | 子树最大深度 |

### 超时配置 (src/config/timeout.config.ts)

| 配置 | 值 | 说明 |
|------|-----|------|
| `TIMEOUT_CONFIG.QUICK` | 5000ms | 快速操作 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API |
| `TIMEOUT_CONFIG.HEAVY` | 30000ms | 重型操作 |
| `TIMEOUT_CONFIG.UPLOAD` | 60000ms | 文件上传 |

## 开发命令

```bash
npm start              # 开发服务器 (localhost:3000)
npm run test           # Vitest watch 模式
npm run test:run       # 单次运行测试
npm run test:e2e       # Playwright E2E
npm run lint:fix       # ESLint 自动修复
```

## 代码风格

- **中文注释**描述业务逻辑和架构决策
- **Angular Signals** 进行状态管理（非 RxJS BehaviorSubject）
- **独立组件**：`standalone: true` + `OnPush` 变更检测
- **严格类型**：避免 `any`，使用 `unknown` + 类型守卫
- 测试文件与源文件同目录：`*.service.ts` → `*.service.spec.ts`

## 常见陷阱

| 陷阱 | 解决方案 |
|------|----------|
| 全量同步 | 增量同步 `updated_at > last_sync_time` |
| GoJS 内存泄漏 | 销毁时 `diagram.clear()` + 移除监听 |
| 递归栈溢出 | 迭代算法 + `MAX_SUBTREE_DEPTH: 100` |
| 离线数据丢失 | 失败操作必须进 RetryQueue |
| Sentry 错误丢失 | `supabaseErrorToError()` 转换 |

---

## 数据模型

```typescript
// src/models/index.ts
interface Task {
  id: string;                    // UUID（客户端生成）
  title: string;
  content: string;               // Markdown
  stage: number | null;          // null = 待分配区
  parentId: string | null;
  order: number;
  rank: number;                  // 排序权重
  status: 'active' | 'completed' | 'archived';
  x: number; y: number;          // 流程图坐标
  displayId: string;             // 动态 ID（如 "1,a"）
  shortId?: string;              // 永久 ID（如 "NF-A1B2"）
  updatedAt?: string;            // LWW 关键字段
  deletedAt?: string | null;     // 软删除
  attachments?: Attachment[];
  deletedConnections?: Connection[];  // 客户端临时字段
  deletedMeta?: { parentId, stage, order, rank, x, y }; // 客户端临时字段
}

interface Connection {
  id: string;
  source: string;
  target: string;
  title?: string;                // 联系块标题
  description?: string;
  deletedAt?: string | null;
}

interface Project {
  id: string;
  name: string;
  description: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string;
  viewState?: { scale: number; positionX: number; positionY: number };
}
```

---

## 错误处理

```typescript
// Result 类型 - src/utils/result.ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const result = success(data);
const result = failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');
```

### 错误严重级别 (GlobalErrorHandler)

| 级别 | 处理方式 | 示例 |
|------|----------|------|
| `SILENT` | 仅日志 | ResizeObserver、图片加载失败 |
| `NOTIFY` | Toast | 网络失败、保存失败 |
| `RECOVERABLE` | 恢复对话框 | 同步冲突 |
| `FATAL` | 错误页面 | Store 初始化失败 |

---

## 测试文件

测试文件与源文件同目录（`*.spec.ts`）：

- **核心状态**：`stores.spec.ts`, `store-persistence.service.spec.ts`
- **同步服务**：`simple-sync.service.spec.ts`, `sync-coordinator.service.spec.ts`, `conflict-resolution.service.spec.ts`
- **业务服务**：`task-operation.service.spec.ts`, `layout.service.spec.ts`, `search.service.spec.ts`
- **队列/限流**：`action-queue.service.spec.ts`, `request-throttle.service.spec.ts`
- **其他**：`change-tracker.service.spec.ts`, `optimistic-state.service.spec.ts`, `undo.service.spec.ts`
- **GoJS**：`flow-diagram.service.spec.ts`, `flow-event.service.spec.ts`, `flow-selection.service.spec.ts`
- **E2E**：`e2e/critical-paths.spec.ts`

---

## 认证

- 强制登录模式，数据操作需 `user_id`
- 开发环境可配置 `environment.devAutoLogin`
- 未配置 Supabase 时启用离线模式 (`AUTH_CONFIG.LOCAL_MODE_USER_ID = 'local-user'`)
