# Project Context: NanoFlow Lite (Fast & Efficient)

> **核心哲学**：不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线。

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
    - 后台：推送到 Supabase。
    - 错误处理：如果推送失败，放入 `RetryQueue`（重试队列），等待网络恢复自动重试。
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
    - `projects` signal: 存储元数据。
    - `tasksMap` signal: `Map<string, Task>` 用于 O(1) 查找。
    - 避免深层嵌套对象的 Signal，保持扁平化。

## 3. 代码风格与模式

### 错误处理 (Result Pattern)
- 保持原有的 Result 类型设计，避免 try-catch 地狱。
- 网络错误静默处理（加入队列），业务错误 Toast 提示。

### 目录结构
- `src/app/core/` (单例服务：SupabaseClient, SyncService)
- `src/app/features/` (业务组件：Flow, List)
- `src/app/shared/` (UI 组件库)

## 4. 用户意图 (User Intent)
用户希望获得一个**“打开即用”**的 PWA。
- 不需要复杂的协同算法。
- 必须要快：点击完成，立刻打勾，没有 loading 转圈。
- 必须要稳：我在地铁上断网写的日记，连上 wifi 后必须自动传上去，别丢数据。