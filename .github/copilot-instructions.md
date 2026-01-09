# NanoFlow AI 编码指南

> **核心哲学**：不要造轮子。Supabase 做同步，UUID 做 ID，PWA 做离线，Sentry 做监控。

## 技术栈

| 技术 | 用途 |
|------|------|
| Angular 19.x | Signals + 独立组件 + OnPush |
| Supabase | 认证 + PostgreSQL + Storage |
| GoJS | 流程图渲染 |
| Sentry | 错误监控 + 会话回放 |
| Vitest / Playwright | 单元 / E2E 测试 |

---

## 核心规则

### ID 策略
- 所有实体 `crypto.randomUUID()` 客户端生成
- 禁止数据库自增 ID、临时 ID

### 数据同步（Offline-first）
```
读：IndexedDB → 后台增量拉取 (updated_at > last_sync_time)
写：本地写入 + UI 更新 → 后台推送（防抖 3s）→ 失败进 RetryQueue
冲突：LWW (Last-Write-Wins)
```

### 移动端 GoJS
- 默认 Text 视图，Flow 图 `@defer` 懒加载
- 禁止 `visibility:hidden`，必须销毁/重建

### 树遍历
- 迭代算法 + 深度限制 `MAX_SUBTREE_DEPTH: 100`

---

## 目录结构

```
src/
├── app/
│   ├── core/                      # 核心单例
│   │   ├── services/
│   │   │   ├── simple-sync.service.ts     # 同步核心（LWW + RetryQueue）
│   │   │   └── modal-loader.service.ts    # 模态框懒加载
│   │   └── state/
│   │       ├── stores.ts                  # Signals 状态（Map<id, Task>）
│   │       └── store-persistence.service.ts
│   │
│   ├── features/
│   │   ├── flow/                  # 流程图视图
│   │   │   ├── components/        # 11 组件
│   │   │   │   ├── flow-view.component.ts
│   │   │   │   ├── flow-toolbar.component.ts
│   │   │   │   ├── flow-palette.component.ts
│   │   │   │   ├── flow-task-detail.component.ts
│   │   │   │   ├── flow-connection-editor.component.ts
│   │   │   │   └── flow-*-dialog.component.ts    # 批量删除/级联分配/删除确认/链接
│   │   │   └── services/          # 12 GoJS 服务
│   │   │       ├── flow-diagram.service.ts        # 图表核心
│   │   │       ├── flow-template.service.ts       # 节点/链接模板
│   │   │       ├── flow-template-events.ts        # 事件代理（解耦）
│   │   │       ├── flow-event.service.ts
│   │   │       ├── flow-task-operations.service.ts
│   │   │       ├── flow-selection.service.ts
│   │   │       ├── flow-drag-drop.service.ts
│   │   │       ├── flow-link.service.ts
│   │   │       ├── flow-layout.service.ts
│   │   │       ├── flow-zoom.service.ts
│   │   │       └── flow-touch.service.ts
│   │   │
│   │   └── text/                  # 文本视图（移动端默认）
│   │       └── components/        # 12 组件
│   │           ├── text-view.component.ts
│   │           ├── text-stages.component.ts
│   │           ├── text-stage-card.component.ts
│   │           ├── text-task-card.component.ts
│   │           ├── text-task-editor.component.ts
│   │           ├── text-task-connections.component.ts
│   │           ├── text-unassigned.component.ts
│   │           ├── text-unfinished.component.ts
│   │           └── text-view-drag-drop.service.ts
│   │
│   └── shared/
│       ├── components/            # 8 通用组件
│       │   └── attachment-manager | error-boundary | error-page | not-found
│       │       offline-banner | reset-password | sync-status | toast-container
│       └── modals/                # 13 模态框
│           └── login | settings | new-project | dashboard | trash | delete-confirm
│               conflict | error-recovery | migration | config-help | storage-escape | recovery
│
├── components/
│   └── project-shell.component.ts   # 项目容器/视图切换
│
├── services/                      # 主服务层（60+ 服务）
│   ├── store.service.ts           # 门面 Facade ※ 禁止业务逻辑
│   │
│   ├── # 业务服务
│   ├── task-operation.service.ts           # 任务 CRUD
│   ├── task-operation-adapter.service.ts   # 任务操作 + 撤销协调
│   ├── task-repository.service.ts          # 任务持久化
│   ├── task-trash.service.ts               # 回收站
│   ├── project-operation.service.ts        # 项目 CRUD
│   ├── attachment.service.ts               # 附件管理
│   ├── attachment-export.service.ts        # 附件导出
│   ├── attachment-import.service.ts        # 附件导入
│   ├── export.service.ts / import.service.ts
│   ├── search.service.ts
│   ├── layout.service.ts
│   ├── lineage-color.service.ts
│   │
│   ├── # 状态服务
│   ├── project-state.service.ts    # 项目/任务状态
│   ├── ui-state.service.ts         # UI 状态
│   ├── optimistic-state.service.ts # 乐观更新
│   ├── undo.service.ts             # 撤销/重做
│   │
│   ├── # 同步服务
│   ├── sync-coordinator.service.ts    # 同步调度
│   ├── sync-mode.service.ts           # 模式管理
│   ├── mobile-sync-strategy.service.ts
│   ├── remote-change-handler.service.ts
│   ├── conflict-resolution.service.ts
│   ├── conflict-storage.service.ts
│   ├── change-tracker.service.ts
│   ├── action-queue.service.ts
│   ├── request-throttle.service.ts
│   ├── tab-sync.service.ts
│   ├── clock-sync.service.ts
│   │
│   ├── # 网络/健康
│   ├── network-awareness.service.ts
│   ├── circuit-breaker.service.ts
│   ├── offline-integrity.service.ts
│   ├── indexeddb-health.service.ts
│   ├── storage-quota.service.ts
│   │
│   ├── # 基础设施
│   ├── auth.service.ts
│   ├── user-session.service.ts
│   ├── supabase-client.service.ts
│   ├── preference.service.ts
│   ├── storage-adapter.service.ts
│   ├── local-backup.service.ts
│   ├── recovery.service.ts
│   ├── migration.service.ts
│   ├── toast.service.ts
│   ├── logger.service.ts
│   ├── theme.service.ts           # 主题管理（色调 + 颜色模式/深色模式）
│   ├── global-error-handler.service.ts
│   ├── sentry-alert.service.ts
│   ├── permission-denied-handler.service.ts
│   ├── persistence-failure-handler.service.ts
│   ├── before-unload-manager.service.ts
│   ├── file-type-validator.service.ts
│   ├── virus-scan.service.ts
│   │
│   └── guards/
│       ├── auth.guard.ts
│       ├── project.guard.ts
│       └── unsaved-changes.guard.ts
│
├── config/                        # 配置常量
│   ├── sync.config.ts             # SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG
│   ├── layout.config.ts           # LAYOUT_CONFIG, FLOATING_TREE_CONFIG, GOJS_CONFIG
│   ├── timeout.config.ts          # TIMEOUT_CONFIG, RETRY_POLICY
│   ├── auth.config.ts             # AUTH_CONFIG, GUARD_CONFIG
│   ├── ui.config.ts
│   ├── task.config.ts
│   ├── attachment.config.ts
│   ├── local-backup.config.ts
│   ├── sentry-alert.config.ts
│   ├── virus-scan.config.ts
│   ├── feature-flags.config.ts
│   └── flow-styles.ts             # GoJS 颜色配置（支持浅色/深色模式）
│
├── models/
│   ├── index.ts                   # Task, Project, Connection, Attachment, ColorMode
│   ├── supabase-types.ts
│   ├── supabase-mapper.ts
│   ├── api-types.ts
│   ├── flow-view-state.ts
│   └── gojs-boundary.ts
│
├── utils/
│   ├── result.ts                  # Result<T,E> + ErrorCodes
│   ├── supabase-error.ts          # supabaseErrorToError()
│   ├── permanent-failure-error.ts
│   ├── validation.ts
│   ├── date.ts
│   ├── timeout.ts
│   └── markdown.ts
│
├── types/
│   └── gojs-extended.d.ts
│
└── environments/
    ├── environment.ts             # 生产
    ├── environment.development.ts # 开发
    └── environment.template.ts
```

---

## 服务架构

```
StoreService (门面) ※ 禁止业务逻辑，透传子服务
    ├── UserSessionService           # 登录/登出、项目切换
    ├── TaskOperationAdapterService  # 任务 CRUD + 撤销协调
    ├── ProjectStateService          # 项目/任务状态读取
    ├── UiStateService               # UI 状态
    ├── SyncCoordinatorService       # 同步调度
    ├── SearchService                # 搜索
    └── PreferenceService            # 用户偏好

GoJS 事件解耦：
FlowTemplateService → flow-template-events.ts → FlowEventService
```

**⚠️ 新代码禁止 `inject(StoreService)`，直接注入子服务**

---

## 关键配置

| 配置 | 值 | 文件 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | sync.config.ts |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | sync.config.ts |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.QUICK` | 5000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.HEAVY` | 30000ms | timeout.config.ts |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | layout.config.ts |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | auth.config.ts |

---

## 数据模型

```typescript
interface Task {
  id: string;                    // UUID 客户端生成
  title: string;
  content: string;               // Markdown
  stage: number | null;          // null = 待分配区
  parentId: string | null;
  order: number;
  rank: number;
  status: 'active' | 'completed' | 'archived';
  x: number; y: number;          // 流程图坐标
  displayId: string;             // 动态 "1,a"
  shortId?: string;              // 永久 "NF-A1B2"
  updatedAt?: string;            // LWW 关键
  deletedAt?: string | null;     // 软删除
  attachments?: Attachment[];
  tags?: string[];               // 预留
  priority?: 'low' | 'medium' | 'high' | 'urgent';  // 预留
  dueDate?: string | null;       // 预留
  // 客户端临时
  deletedConnections?: Connection[];
  deletedMeta?: { parentId, stage, order, rank, x, y };
}

interface Connection {
  id: string; source: string; target: string;
  title?: string; description?: string;
  deletedAt?: string | null;
}
```

---

## 错误处理

```typescript
// Result 模式
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
success(data);
failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');

// Supabase 错误转换
supabaseErrorToError(error)
```

### 错误分级 (GlobalErrorHandler)

| 级别 | 处理 | 示例 |
|------|------|------|
| SILENT | 仅日志 | ResizeObserver |
| NOTIFY | Toast | 保存失败 |
| RECOVERABLE | 恢复对话框 | 同步冲突 |
| FATAL | 错误页面 | Store 初始化失败 |

---

## 开发命令

```bash
npm start               # 开发服务器
npm run test            # Vitest watch
npm run test:run        # 单次测试
npm run test:e2e        # Playwright E2E
npm run lint:fix        # ESLint 修复
```

---

## 代码规范

- 中文注释描述业务逻辑
- Angular Signals 状态管理
- `standalone: true` + `OnPush`
- 严格类型，`unknown` + 类型守卫替代 `any`
- 测试同目录：`*.service.ts` → `*.service.spec.ts`

---

## 常见陷阱

| 陷阱 | 方案 |
|------|------|
| 全量同步 | 增量 `updated_at > last_sync_time` |
| GoJS 内存泄漏 | `diagram.clear()` + 移除监听 |
| 递归栈溢出 | 迭代 + `MAX_SUBTREE_DEPTH: 100` |
| 离线数据丢失 | 失败进 RetryQueue |
| Sentry 错误丢失 | `supabaseErrorToError()` |

---

## 认证

- 强制登录，数据操作需 `user_id`
- 开发：`environment.devAutoLogin` 自动登录
- 离线模式：`LOCAL_MODE_USER_ID = 'local-user'`
