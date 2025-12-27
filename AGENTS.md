# Project Context: NanoFlow Lite (Fast & Efficient)

> **核心哲学**：不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

## 1. 极简架构原则

### ID 策略：客户端生成 UUID (Client-Side IDs)
- **绝对规则**：所有数据实体（Project, Task, Connection）的 `id` 必须在客户端创建时使用 UUID v4 生成。
- **禁止**：禁止使用数据库自增 ID。禁止使用临时 ID（temp-id）概念。
- **好处**：离线创建的数据可以直接关联（如：创建任务 A，立即创建子任务 B 指向 A），同步到服务器时无需任何 ID 转换逻辑。

### 数据流与同步 (利用 Supabase)
1.  **读取**：
    - 首屏加载：优先读取本地 IndexedDB (Dexie.js 或直接封装)。
    - 后台：静默请求 Supabase 拉取最新数据 (`updated_at > last_sync_time`) 并更新本地库。
2.  **写入 (乐观更新)**：
    - 用户操作 -> 立即写入本地 IndexedDB -> 立即更新 UI。
    - 后台：推送到 Supabase（防抖 3 秒）。
    - 错误处理：如果推送失败，放入 `RetryQueue`（重试队列，持久化到 localStorage），等待网络恢复自动重试。
3.  **冲突解决**：
    - 采用 **Last-Write-Wins (LWW)** 策略。以 `updated_at` 时间戳为准，谁晚谁生效。对于个人目标追踪，这足够好用且实现成本最低。

## 2. 关键技术约束

### 移动端 GoJS 优化 (Lazy Loading)
- **问题**：GoJS 在移动端极其消耗资源。
- **策略**：
    - 手机端默认进入 **文本列表视图**。
    - 只有当用户显式点击“流程图模式”时，才动态加载 GoJS 组件 (`@defer` block in Angular)。
    - **禁止**：禁止在移动端使用 `visibility: hidden` 隐藏绘图板（这会占用后台内存），必须根据路由或 Tab 状态完全销毁/重建组件。

### 状态管理 (Angular Signals)
- 使用 Angular 19 的 Signals 进行细粒度更新。
- **Store 设计**：
    - `TaskStore.tasksMap` signal: `Map<string, Task>` 用于 O(1) 查找。
    - `TaskStore.tasksByProject` signal: `Map<string, Set<string>>` 按项目索引任务。
    - `ProjectStore.projects` signal: 存储元数据。
    - 避免深层嵌套对象的 Signal，保持扁平化。

### 树遍历深度限制
- **问题**：深层嵌套任务树可能导致栈溢出。
- **策略**：所有树遍历使用迭代算法 + 深度限制（`ALGORITHM_CONFIG.MAX_TREE_DEPTH: 500`）。

## 3. 代码风格与模式

### 错误处理 (Result Pattern + Sentry)
- 保持原有的 Result 类型设计，避免 try-catch 地狱。
- 网络错误静默处理（加入队列），业务错误 Toast 提示。
- 关键错误自动上报 Sentry（`Sentry.captureException`）。
- Supabase 错误需转换：`supabaseErrorToError(error)` 后再上报。

### 错误分级 (GlobalErrorHandler)
- `SILENT`：静默级，仅记录日志（图片加载失败、ResizeObserver 警告等）
- `NOTIFY`：提示级，Toast 告知用户（网络断开、保存失败）
- `RECOVERABLE`：可恢复级，显示恢复对话框
- `FATAL`：致命级，跳转错误页面

### 目录结构
- `src/app/core/` (核心单例服务：SimpleSyncService, stores.ts)
- `src/app/features/` (业务组件：Flow, Text)
- `src/app/shared/` (UI 组件库)
- `src/services/` (主服务层：StoreService 门面、GoJS 服务、业务服务)
- `src/utils/` (工具函数：result.ts, supabase-error.ts)

## 4. 关键配置 (src/config/)

配置文件已拆分到独立模块：

| 配置文件 | 主要常量 |
|----------|----------|
| `sync.config.ts` | SYNC_CONFIG, REQUEST_THROTTLE_CONFIG |
| `layout.config.ts` | LAYOUT_CONFIG, FLOATING_TREE_CONFIG |
| `timeout.config.ts` | TIMEOUT_CONFIG, RETRY_POLICY |
| `ui.config.ts` | UI_CONFIG, TOAST_CONFIG |

**核心配置值**：
| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖延迟 |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | 云端数据加载超时 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求数 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API 超时 |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | 子树最大深度 |

## 5. 用户意图 (User Intent)
用户希望获得一个**“打开即用”**的 PWA。
- 个人使用的项目: 决策时候以个人项目进行选择 (Highest priority-first)
- 不需要复杂的协同算法。
- 必须要快：点击完成，立刻打勾，没有 loading 转圈。
- 必须要稳：我在地铁上断网写的日记，连上 wifi 后必须自动传上去，别丢数据。