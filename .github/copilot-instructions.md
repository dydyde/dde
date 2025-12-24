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
// src/models/index.ts - Task, Project, Connection 都使用 string id
const newTask: Task = {
  id: crypto.randomUUID(),  // 禁止使用临时 ID 或数据库自增 ID
  title: '新任务',
  stage: null,              // null = 待分配区
  parentId: null,
  status: 'active',
  // ...
};
// 直接保存，无需 ID 转换
await localDb.tasks.put(newTask);
await supabase.from('tasks').upsert(newTask);
```

**好处**：离线创建的数据可直接关联（如创建任务 A，立即创建子任务 B 指向 A），同步时无需 ID 转换。

### 2. 数据流与同步（利用 Supabase）

```
读取：
  首屏加载 → 优先读取本地 IndexedDB
  后台 → 静默请求 Supabase (updated_at > last_sync_time)

写入（乐观更新）：
  用户操作 → 立即写入本地 → 立即更新 UI
  后台 → 推送到 Supabase（防抖 3 秒）
  错误 → 放入 RetryQueue，网络恢复自动重试

冲突解决：
  Last-Write-Wins (LWW) - 以 updated_at 为准，谁晚谁生效
```

### 3. 状态管理（Angular Signals）

```typescript
// 使用扁平化 Signal + Map 结构实现 O(1) 查找
// src/app/core/state/stores.ts
@Injectable({ providedIn: 'root' })
export class TaskStore {
  /** 任务 Map - O(1) 查找 */
  readonly tasksMap = signal<Map<string, Task>>(new Map());
  
  /** 任务列表（从 Map 派生） */
  readonly tasks = computed(() => Array.from(this.tasksMap().values()));
  
  /** 按项目 ID 索引的任务集合 - 快速获取某个项目的所有任务 */
  private readonly tasksByProject = signal<Map<string, Set<string>>>(new Map());
  
  getTask(id: string): Task | undefined {
    return this.tasksMap().get(id);  // O(1)
  }
  
  getTasksByProject(projectId: string): Task[] {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return [];
    const map = this.tasksMap();
    return Array.from(taskIds).map(id => map.get(id)).filter((t): t is Task => !!t);
  }
}
```

### 4. 移动端 GoJS 懒加载

```typescript
// 移动端使用 @defer + 条件渲染完全销毁/重建 FlowView
@if (!store.isMobile() || store.activeView() === 'flow') {
  @defer (on viewport; prefetch on idle) {
    <app-flow-view />
  } @placeholder {
    <div>加载流程视图...</div>
  }
}
```

**禁止**：不使用 `visibility: hidden` 隐藏 GoJS canvas（占用内存）。

### 5. RetryQueue 持久化（离线数据保护）

```typescript
// src/app/core/services/simple-sync.service.ts
// SimpleSyncService 自动将失败操作持久化到 localStorage
// 页面刷新后自动恢复，网络恢复后自动重试
private readonly RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
private readonly RETRY_QUEUE_VERSION = 1;

// 重试配置
private readonly MAX_RETRIES = 5;           // 最多重试 5 次
private readonly RETRY_INTERVAL = 5000;      // 间隔 5 秒
private readonly IMMEDIATE_RETRY_MAX = 3;    // 立即重试的最大次数（带指数退避）
private readonly IMMEDIATE_RETRY_BASE_DELAY = 1000; // 立即重试的基础延迟
```

### 6. 错误监控（Sentry 集成）

```typescript
// main.ts - 应用启动时初始化 Sentry
import * as Sentry from '@sentry/angular';

Sentry.init({
  dsn: 'https://020afcbad58675a58fb58aa2e2cc8662@o4510578675941376.ingest.us.sentry.io/4510578712969216',
  integrations: [
    Sentry.browserTracingIntegration(),   // 性能追踪
    Sentry.replayIntegration({             // 会话回放
      maskAllText: false,                   // 关闭文字遮蔽，方便调试
      blockAllMedia: false,                 // 允许录制图片
    }),
  ],
  tracePropagationTargets: ['localhost', /^https:\/\/dde-psi\.vercel\.app/],
  tracesSampleRate: 1.0,                   // 个人项目全量采集
  replaysSessionSampleRate: 1.0,           // 正常会话 100% 录制
  replaysOnErrorSampleRate: 1.0,           // 报错时 100% 录屏
  environment: isDevMode() ? 'development' : 'production',
});

// 业务代码中捕获错误
import * as Sentry from '@sentry/angular';
try {
  await riskyOperation();
} catch (error) {
  Sentry.captureException(error, { tags: { operation: 'operationName' } });
}
```

**Sentry 集成点**：
- `main.ts`：全局初始化 + Angular ErrorHandler 集成
- `src/app/core/services/simple-sync.service.ts`：同步操作错误上报
- `src/services/flow-diagram.service.ts`：GoJS 相关错误上报
- `src/app/core/services/modal-loader.service.ts`：模态框加载错误上报
- `src/app/core/state/store-persistence.service.ts`：本地存储错误上报

**Supabase 错误转换**（`src/utils/supabase-error.ts`）：
```typescript
// Supabase 返回的错误是普通对象，需要转换才能被 Sentry 正确捕获
const enhanced = supabaseErrorToError(error);
Sentry.captureException(enhanced, { 
  tags: { operation: 'syncTask' },
  level: enhanced.isRetryable ? 'warning' : 'error'
});
```

## 目录结构（实际架构）

```
src/
├── app/
│   ├── core/                    # 核心基础设施（单例服务）
│   │   ├── services/            
│   │   │   ├── simple-sync.service.ts   # SimpleSyncService - 简化同步（LWW + 持久化 RetryQueue）
│   │   │   └── modal-loader.service.ts  # ModalLoaderService - 模态框动态加载
│   │   └── state/               
│   │       ├── stores.ts                # TaskStore, ProjectStore - Signal-based Map<id, Entity>
│   │       └── store-persistence.service.ts # 本地持久化
│   ├── features/                # 业务功能（待迁移）
│   │   ├── flow/                # 流程图视图
│   │   └── text/                # 文本列表视图
│   └── shared/                  # 共享 UI 组件
│       ├── ui/                  
│       └── services/            
├── components/                  # 组件（主要存放位置）
│   ├── flow/                    # 流程图相关组件
│   │   ├── flow-palette.component.ts           # 调色板/工具栏
│   │   ├── flow-toolbar.component.ts           # 顶部工具栏
│   │   ├── flow-task-detail.component.ts       # 任务详情面板
│   │   ├── flow-connection-editor.component.ts # 连接编辑器
│   │   ├── flow-link-type-dialog.component.ts  # 连接类型选择
│   │   ├── flow-cascade-assign-dialog.component.ts # 级联分配对话框
│   │   └── flow-delete-confirm.component.ts    # 删除确认
│   ├── modals/                  # 模态框组件
│   │   ├── login-modal.component.ts            # 登录
│   │   ├── settings-modal.component.ts         # 设置
│   │   ├── new-project-modal.component.ts      # 新建项目
│   │   ├── trash-modal.component.ts            # 回收站
│   │   ├── conflict-modal.component.ts         # 冲突解决
│   │   ├── dashboard-modal.component.ts        # 仪表盘
│   │   ├── error-recovery-modal.component.ts   # 错误恢复
│   │   ├── migration-modal.component.ts        # 数据迁移
│   │   ├── config-help-modal.component.ts      # 配置帮助
│   │   └── storage-escape-modal.component.ts   # 存储异常
│   ├── text-view/               # 文本视图组件
│   │   ├── text-stages.component.ts            # 阶段列表
│   │   ├── text-unfinished.component.ts        # 未完成项
│   │   ├── text-unassigned.component.ts        # 待分配任务
│   │   ├── text-task-editor.component.ts       # 任务编辑器
│   │   ├── text-task-card.component.ts         # 任务卡片
│   │   ├── text-task-connections.component.ts  # 任务连接
│   │   └── text-view-drag-drop.service.ts      # 拖拽服务
│   ├── flow-view.component.ts   # 流程图主视图
│   ├── text-view.component.ts   # 文本主视图
│   ├── project-shell.component.ts # 项目容器/视图切换
│   ├── attachment-manager.component.ts # 附件管理器
│   ├── sync-status.component.ts # 同步状态指示器
│   ├── error-boundary.component.ts
│   ├── error-page.component.ts
│   ├── offline-banner.component.ts
│   └── toast-container.component.ts
├── services/                    # 服务层（主要存放位置）
│   ├── GoJS 流程图服务
│   │   ├── flow-diagram.service.ts        # 主服务：初始化、生命周期、导出
│   │   ├── flow-diagram-config.service.ts # 图表配置
│   │   ├── flow-event.service.ts          # 事件处理
│   │   ├── flow-template.service.ts       # 模板配置
│   │   ├── flow-template-events.ts        # 事件总线（解耦桥梁）
│   │   ├── flow-selection.service.ts      # 选择管理
│   │   ├── flow-zoom.service.ts           # 缩放控制
│   │   ├── flow-layout.service.ts         # 布局计算（已弃用，见 layout.service.ts）
│   │   ├── flow-drag-drop.service.ts      # 拖放逻辑
│   │   ├── flow-link.service.ts           # 连接线管理
│   │   ├── flow-touch.service.ts          # 触摸支持
│   │   ├── flow-task-operations.service.ts # 流程图内任务操作
│   │   └── flow-debug.service.ts          # 调试工具
│   ├── 业务服务
│   │   ├── task-operation.service.ts      # 任务 CRUD（核心业务逻辑）
│   │   ├── task-operation-adapter.service.ts # 任务操作适配器
│   │   ├── task-repository.service.ts     # 任务数据仓库
│   │   ├── attachment.service.ts          # 附件管理
│   │   ├── search.service.ts              # 搜索
│   │   ├── layout.service.ts              # 布局计算（MAX_TREE_DEPTH: 500）
│   │   ├── lineage-color.service.ts       # 血缘着色
│   │   └── minimap-math.service.ts        # 小地图数学计算
│   ├── 状态管理
│   │   ├── store.service.ts               # 门面服务（Facade）- 协调所有子服务
│   │   ├── project-state.service.ts       # 项目状态
│   │   ├── ui-state.service.ts            # UI 状态
│   │   ├── optimistic-state.service.ts    # 乐观更新状态
│   │   └── undo.service.ts                # 撤销/重做
│   ├── 同步服务
│   │   ├── sync-coordinator.service.ts    # 同步协调器
│   │   ├── remote-change-handler.service.ts # 远程变更处理
│   │   ├── conflict-resolution.service.ts # 冲突解决
│   │   ├── conflict-storage.service.ts    # 冲突存储
│   │   ├── change-tracker.service.ts      # 变更追踪
│   │   ├── storage-adapter.service.ts     # 存储适配
│   │   ├── action-queue.service.ts        # 操作队列
│   │   ├── request-throttle.service.ts    # 请求限流
│   │   ├── sync-mode.service.ts           # 同步模式（自动/手动）
│   │   ├── tab-sync.service.ts            # 标签页同步
│   │   └── persistence-failure-handler.service.ts # 持久化失败处理
│   ├── 错误处理
│   │   └── global-error-handler.service.ts # 全局错误处理（分级 + Sentry 集成）
│   ├── 基础设施
│   │   ├── auth.service.ts                # 认证
│   │   ├── supabase-client.service.ts     # Supabase 客户端
│   │   ├── user-session.service.ts        # 用户会话
│   │   ├── preference.service.ts          # 用户偏好
│   │   ├── toast.service.ts               # Toast 提示
│   │   ├── logger.service.ts              # 日志
│   │   ├── theme.service.ts               # 主题
│   │   ├── modal.service.ts               # 模态框
│   │   ├── dynamic-modal.service.ts       # 动态模态框
│   │   └── migration.service.ts           # 数据迁移
│   └── guards/                  # 路由守卫
│       └── ...
├── models/                      # 数据模型
│   ├── index.ts                 # Task, Project, Connection, Attachment 类型导出
│   ├── supabase-types.ts        # Supabase 数据库类型 (TaskRow, ProjectRow, ConnectionRow)
│   ├── supabase-mapper.ts       # 类型转换
│   ├── api-types.ts             # API 类型
│   ├── flow-view-state.ts       # 流程图视图状态
│   └── gojs-boundary.ts         # GoJS 边界类型
├── config/                      # 配置常量
│   ├── constants.ts             # 全局配置（同步、超时、UI、布局等）
│   └── flow-styles.ts           # GoJS 样式
├── utils/                       # 工具函数
│   ├── result.ts                # Result 类型 + ErrorCodes + success/failure 工厂
│   ├── supabase-error.ts        # Supabase 错误转换（Sentry 友好）
│   ├── date.ts                  # 日期工具 (nowISO)
│   ├── timeout.ts               # 超时工具
│   ├── markdown.ts              # Markdown 工具
│   └── validation.ts            # 验证工具
└── environments/                # 环境配置
    ├── environment.ts           # 生产环境
    ├── environment.development.ts # 开发环境
    └── environment.template.ts  # 模板
```

## 核心服务架构

```
服务架构 - 2024-12 更新
├── core/ (src/app/core/)
│   ├── services/
│   │   ├── SimpleSyncService        # 简化同步（LWW + 持久化 RetryQueue + Sentry 错误上报）
│   │   └── ModalLoaderService       # 模态框动态加载 + Sentry 错误上报
│   └── state/
│       ├── stores.ts                # 状态管理 (Signal-based Map<id, Entity>)
│       │   ├── TaskStore            # 任务状态 - tasksMap + tasksByProject 索引
│       │   └── ProjectStore         # 项目状态
│       └── StorePersistenceService  # 本地持久化 + Sentry 错误上报
│
├── services/ (src/services/) - 主服务层
│   ├── StoreService (门面服务/Facade)
│   │   │  ※ 纯门面：严禁添加新业务逻辑！
│   │   │  协调以下子服务：
│   │   ├── UserSessionService       # 用户登录/登出、项目切换
│   │   ├── TaskOperationAdapterService # 任务 CRUD + 撤销/重做协调
│   │   ├── PreferenceService        # 主题管理、用户偏好
│   │   ├── SyncCoordinatorService   # 持久化调度、离线队列
│   │   ├── RemoteChangeHandlerService # 实时更新处理
│   │   ├── ProjectStateService      # 项目/任务状态
│   │   ├── UiStateService           # UI 状态（侧边栏、搜索等）
│   │   └── SearchService            # 搜索逻辑
│   │
│   ├── GoJS 流程图服务（已完全拆分）
│   │   ├── FlowDiagramService       # 主服务：初始化、生命周期、导出 + Sentry 错误上报
│   │   ├── FlowDiagramConfigService # 图表配置（缩放、平移限制等）
│   │   ├── FlowEventService         # 事件处理：回调注册、事件代理
│   │   ├── FlowTemplateService      # 模板配置：节点/连接线/Overview
│   │   ├── FlowSelectionService     # 选择管理：选中/多选/高亮
│   │   ├── FlowZoomService          # 缩放控制：放大/缩小/适应内容
│   │   ├── FlowDragDropService      # 拖放逻辑
│   │   ├── FlowLinkService          # 连接线管理
│   │   ├── FlowTouchService         # 触摸支持
│   │   └── flow-template-events.ts  # 事件总线（解耦桥梁）
│   │
│   ├── 业务服务
│   │   ├── TaskOperationService     # 任务 CRUD（核心业务逻辑）
│   │   ├── TaskRepositoryService    # 任务数据仓库
│   │   ├── AttachmentService        # 附件管理
│   │   ├── LayoutService            # 布局计算（ALGORITHM_CONFIG.MAX_TREE_DEPTH: 500）
│   │   ├── LineageColorService      # 血缘着色
│   │   └── SearchService            # 搜索
│   │
│   ├── 同步服务
│   │   ├── SyncCoordinatorService   # 同步协调
│   │   ├── RemoteChangeHandlerService # 远程变更处理
│   │   ├── ConflictResolutionService # 冲突解决
│   │   ├── ChangeTrackerService     # 变更追踪
│   │   ├── ActionQueueService       # 操作队列
│   │   ├── RequestThrottleService   # 请求限流（MAX_CONCURRENT: 4）
│   │   └── OptimisticStateService   # 乐观更新状态
│   │
│   ├── 错误处理
│   │   └── GlobalErrorHandler       # 全局错误处理（分级 + Sentry 集成）
│   │       ├── ErrorSeverity.SILENT      # 静默级：仅记录日志
│   │       ├── ErrorSeverity.NOTIFY      # 提示级：Toast 提示
│   │       ├── ErrorSeverity.RECOVERABLE # 可恢复级：恢复对话框
│   │       └── ErrorSeverity.FATAL       # 致命级：跳转错误页面
│   │
│   └── 基础设施
│       ├── AuthService              # 认证（强制登录模式）
│       ├── SupabaseClientService    # Supabase 客户端
│       ├── UserSessionService       # 用户会话
│       ├── PreferenceService        # 用户偏好
│       ├── ToastService             # Toast 提示
│       ├── LoggerService            # 日志（带分类 category()）
│       └── ThemeService             # 主题（5 种主题）
│
└── utils/ (src/utils/)
    ├── result.ts                    # Result 类型统一错误处理
    │   ├── Result<T, E>             # 成功/失败联合类型
    │   ├── success(value)           # 创建成功结果
    │   ├── failure(code, message)   # 创建失败结果
    │   └── ErrorCodes               # 标准错误码
    └── supabase-error.ts            # Supabase 错误转换为 Sentry 友好的 Error
```

### 事件代理模式（FlowTemplateService ↔ FlowEventService）

```typescript
// 模板中发送信号（flow-template.service.ts）
click: (e: any, node: any) => {
  flowTemplateEventHandlers.onNodeClick?.(node);
}

// EventService 注册处理器（flow-event.service.ts）
flowTemplateEventHandlers.onNodeClick = (node) => {
  this.zone.run(() => this.emitNodeClick(node.data.key, false));
};
```

**好处**：完全解耦，模板不知道回调是谁，EventService 不知道模板长什么样。

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

1. **全量同步**：使用增量同步，基于 `updated_at > last_sync_time`
2. **GoJS 内存泄漏**：组件销毁时调用 `diagram.clear()` 和移除事件监听
3. **递归栈溢出**：所有树遍历使用迭代算法 + 深度限制（MAX_TREE_DEPTH: 500）
4. **离线数据丢失**：失败操作必须进入 RetryQueue
5. **Sentry 错误丢失**：Supabase 错误是普通对象，需使用 `supabaseErrorToError()` 转换

## 关键配置（src/config/constants.ts）

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖延迟 |
| `SYNC_CONFIG.EDITING_TIMEOUT` | 5000ms | 编辑状态超时 |
| `SYNC_CONFIG.REMOTE_CHANGE_DELAY` | 2000ms | 远程变更处理延迟 |
| `SYNC_CONFIG.CONFLICT_TIME_THRESHOLD` | 10000ms | 冲突检测时间阈值 |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | 云端数据加载超时 |
| `SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL` | 1000ms | 本地自动保存间隔 |
| `TIMEOUT_CONFIG.QUICK` | 5000ms | 快速读取操作超时 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API 超时 |
| `TIMEOUT_CONFIG.HEAVY` | 30000ms | 重型操作超时 |
| `TIMEOUT_CONFIG.UPLOAD` | 60000ms | 文件上传超时 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求数 |
| `TRASH_CONFIG.AUTO_CLEANUP_DAYS` | 30 | 回收站自动清理 |
| `UNDO_CONFIG.MAX_HISTORY_SIZE` | 50 | 最大撤销历史数 |
| `ALGORITHM_CONFIG.MAX_TREE_DEPTH` | 500 | 树遍历最大深度 |
| `LAYOUT_CONFIG.STAGE_SPACING` | 260 | 阶段间水平间距 |
| `LAYOUT_CONFIG.ROW_SPACING` | 140 | 任务行垂直间距 |

---

<details>
<summary>📚 详细架构文档（点击展开）</summary>

## 架构概览

NanoFlow 是一个 **Angular 19 + Supabase** 构建的项目追踪应用，支持**双视图模式**（文本/流程图）和**离线优先**的云端同步。

### 用户意图

用户希望获得一个**"打开即用"**的 PWA：
- 不需要复杂的协同算法
- 必须要快：点击完成，立刻打勾，没有 loading 转圈
- 必须要稳：地铁上断网写的日记，连上 wifi 后必须自动传上去，别丢数据

### 核心架构决策

1. **离线优先**：本地 IndexedDB 为主，云端 Supabase 为备份
2. **乐观更新**：UI 立即响应，后台异步同步
3. **LWW 冲突解决**：以 updated_at 为准，简单可靠
4. **客户端 UUID**：所有实体 ID 在客户端生成

### 视图架构

```
AppComponent (全局容器)
    └── ProjectShellComponent (视图切换)
            ├── TextViewComponent (文本视图)
            │       ├── TextUnfinishedComponent
            │       ├── TextUnassignedComponent
            │       └── TextStagesComponent
            └── FlowViewComponent (流程图视图) - 移动端条件渲染
                    ├── FlowPaletteComponent
                    ├── FlowToolbarComponent
                    └── FlowTaskDetailComponent
```

---

## LWW（Last-Write-Wins）同步策略

```typescript
// SimpleSyncService 核心逻辑
async pullTasks(projectId: string, since?: string): Promise<Task[]> {
  const { data } = await supabase
    .from('tasks')
    .select()
    .eq('project_id', projectId)
    .gt('updated_at', since);
  
  // LWW：更新比本地新的数据
  for (const remote of data) {
    const local = await localDb.tasks.get(remote.id);
    if (!local || remote.updated_at > local.updated_at) {
      await localDb.tasks.put(remote);
    }
  }
}
```

**策略说明**：
- 个人应用场景中，冲突概率极低
- 简化实现，减少复杂度
- 以 updated_at 时间戳为准

---

## GoJS 流程图集成

### 服务拆分（2024-12 优化后）

| 服务 | 职责 |
|------|------|
| **FlowDiagramService** | 主服务：初始化、生命周期、导出 + Sentry 错误上报 |
| **FlowEventService** | 事件处理：回调注册、事件代理 |
| **FlowTemplateService** | 模板配置：节点/连接线/Overview |
| **FlowSelectionService** | 选择管理：选中/多选/高亮 |
| **FlowZoomService** | 缩放控制：放大/缩小/适应内容 |
| **FlowLayoutService** | 布局计算：自动布局/位置保存 |
| **FlowDragDropService** | 拖放逻辑 |
| **flow-template-events.ts** | 事件总线（解耦桥梁） |

### 布局算法

- **stage**：阶段/列索引（1, 2, 3...）
- **rank**：垂直排序权重
- **parentId**：父子关系
- **displayId**：动态计算（如 "1", "1,a"）
- **shortId**：永久 ID（如 "NF-A1B2"）

---

## 数据模型

```typescript
// src/models/index.ts

/** 任务状态枚举 */
type TaskStatus = 'active' | 'completed' | 'archived';

/** 附件类型 */
type AttachmentType = 'image' | 'document' | 'link' | 'file';

/** 附件模型 */
interface Attachment {
  id: string;
  type: AttachmentType;
  name: string;
  url: string;           // 签名 URL
  thumbnailUrl?: string; // 图片缩略图
  mimeType?: string;
  size?: number;
  createdAt: string;
  signedAt?: string;     // URL 签名时间戳
  deletedAt?: string;    // 软删除时间戳
}

/** 任务模型 */
interface Task {
  id: string;           // UUID（客户端生成）
  title: string;
  content: string;      // Markdown 内容
  stage: number | null; // null = 待分配区
  parentId: string | null;
  order: number;        // 阶段内排序
  rank: number;         // 基于重力的排序权重
  status: TaskStatus;
  x: number;            // 流程图 X 坐标
  y: number;            // 流程图 Y 坐标
  createdDate: string;
  updatedAt?: string;   // LWW 关键字段
  displayId: string;    // 动态显示 ID（如 "1", "1,a"）
  shortId?: string;     // 永久短 ID（如 "NF-A1B2"）
  hasIncompleteTask?: boolean;
  deletedAt?: string | null;    // 软删除时间戳
  attachments?: Attachment[];
  tags?: string[];              // 预留
  priority?: 'low' | 'medium' | 'high' | 'urgent'; // 预留
  dueDate?: string | null;      // 预留
}

/** 连接模型 */
interface Connection {
  id: string;           // UUID
  source: string;
  target: string;
  description?: string; // 联系块描述
  deletedAt?: string | null;
}

/** 项目模型 */
interface Project {
  id: string;           // UUID
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string;
  version?: number;     // 数据版本号
  viewState?: ViewState; // 视图状态持久化
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/** 视图状态 */
interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}

/** 主题类型 */
type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';
```

### Supabase 表结构

- `projects`：项目元数据
- `tasks`：任务（独立表，v2 架构）
- `connections`：连接线（独立表，v2 架构）

---

## 认证

强制登录模式，所有数据操作都需要 user_id。

开发环境可配置自动登录（`environment.devAutoLogin`）。

未配置 Supabase 时自动启用离线模式（`AUTH_CONFIG.LOCAL_MODE_USER_ID = 'local-user'`）。

---

## 错误处理

```typescript
// Result 类型统一错误处理 - src/utils/result.ts
import { Result, success, failure, ErrorCodes } from '../utils/result';

// Result 类型定义
type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

// 操作错误接口
interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// 使用示例
function doSomething(): Result<Project, OperationError> {
  if (error) return failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');
  return success(project);
}

// 常见错误码 (ErrorCodes)
const ErrorCodes = {
  // 布局错误
  LAYOUT_RANK_CONFLICT: 'LAYOUT_RANK_CONFLICT',
  LAYOUT_PARENT_CHILD_CONFLICT: 'LAYOUT_PARENT_CHILD_CONFLICT',
  LAYOUT_CYCLE_DETECTED: 'LAYOUT_CYCLE_DETECTED',
  LAYOUT_NO_SPACE: 'LAYOUT_NO_SPACE',
  
  // 浮动任务树错误
  STAGE_OVERFLOW: 'STAGE_OVERFLOW',
  CROSS_BOUNDARY_VIOLATION: 'CROSS_BOUNDARY_VIOLATION',
  
  // 数据错误
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',
  DATA_INVALID: 'DATA_INVALID',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  
  // 同步错误
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_OFFLINE: 'SYNC_OFFLINE',
  SYNC_AUTH_EXPIRED: 'SYNC_AUTH_EXPIRED',
  
  // 通用错误
  UNKNOWN: 'UNKNOWN'
};
```

### 错误严重级别（GlobalErrorHandler）

| 级别 | 说明 | 处理方式 |
|------|------|----------|
| `SILENT` | 无关紧要的错误 | 仅记录日志 |
| `NOTIFY` | 需要告知用户 | Toast 提示 |
| `RECOVERABLE` | 可恢复错误 | 恢复对话框 |
| `FATAL` | 致命错误 | 跳转错误页面 |

**自动分类规则**（按优先级匹配）：
```typescript
// 静默级（SILENT）- 不打扰用户
- NG0203 inject 上下文错误（异步组件加载触发）
- 图片/字体加载失败
- Supabase Auth 多标签页锁争用
- ResizeObserver loop 警告
- 用户取消操作

// 提示级（NOTIFY）
- 网络请求失败
- 数据保存失败
- 同步冲突

// 致命级（FATAL）
- Store 初始化失败
- 数据库连接断开
```

### Sentry 错误上报

关键操作失败时会自动上报到 Sentry，包含 `tags.operation` 标识操作类型。

```typescript
// 示例：同步操作错误上报
Sentry.captureException(enhanced, { 
  tags: { operation: 'syncTask', projectId },
  level: enhanced.isRetryable ? 'warning' : 'error'
});
```

---

## 测试策略

### 单元测试（Vitest + happy-dom）

测试文件与源文件同目录：`*.service.ts` → `*.service.spec.ts`

**已有测试文件**：
- `stores.spec.ts` - 状态管理测试
- `store-persistence.service.spec.ts` - 本地持久化测试
- `simple-sync.service.spec.ts` - 同步服务测试
- `layout.service.spec.ts` - 布局计算测试
- `conflict-resolution.service.spec.ts` - 冲突解决测试
- `task-operation.service.spec.ts` - 任务操作测试
- `action-queue.service.spec.ts` - 操作队列测试
- `change-tracker.service.spec.ts` - 变更追踪测试

### E2E 测试（Playwright）

关键选择器约定：`data-testid="xxx"`

**测试文件位置**：`e2e/critical-paths.spec.ts`

</details>
