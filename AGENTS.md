# Project Context: NanoFlow

> **核心哲学**：不要造轮子。利用 Supabase 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

## 1. 极简架构原则

### ID 策略：客户端生成 UUID
- **绝对规则**：所有数据实体的 `id` 使用 `crypto.randomUUID()` 在客户端生成
- **禁止**：数据库自增 ID、临时 ID
- **好处**：离线创建可直接关联，同步无需 ID 转换

### 数据流与同步
```
读取：本地 IndexedDB → 后台增量拉取 (updated_at > last_sync_time)
写入：本地写入 + UI 更新 → 后台推送（防抖 3s）→ 失败进 RetryQueue
冲突：Last-Write-Wins (LWW)
```

## 2. 关键技术约束

### 移动端 GoJS 懒加载
- 手机默认文本视图，流程图按需加载（`@defer`）
- **禁止 `visibility: hidden`**，必须完全销毁/重建

### 状态管理 (Angular Signals)
- `TaskStore.tasksMap` signal: `Map<string, Task>` 用于 O(1) 查找
- `TaskStore.tasksByProject` signal: `Map<string, Set<string>>` 按项目索引
- 保持扁平化，避免深层嵌套

### 树遍历深度限制
- 所有树遍历使用迭代算法 + 深度限制（`MAX_SUBTREE_DEPTH: 100`）

## 3. 代码风格

### 错误处理 (Result Pattern + Sentry)
- Result 类型：避免 try-catch 地狱
- 网络错误静默处理（加入队列），业务错误 Toast
- Supabase 错误需转换：`supabaseErrorToError(error)`

### 错误分级 (GlobalErrorHandler)
| 级别 | 处理 | 示例 |
|------|------|------|
| `SILENT` | 仅日志 | ResizeObserver 警告 |
| `NOTIFY` | Toast | 保存失败 |
| `RECOVERABLE` | 恢复对话框 | 同步冲突 |
| `FATAL` | 错误页面 | Store 初始化失败 |

### 目录结构
- `src/app/core/` - 核心单例：SimpleSyncService, stores.ts
- `src/app/features/` - 业务组件：Flow, Text
- `src/app/shared/` - 共享组件与模态框
- `src/services/` - 主服务层（50+ 服务）
- `src/config/` - 配置常量（按职责拆分）
- `src/utils/` - 工具函数：result.ts, supabase-error.ts

## 4. 关键配置

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖 |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | 云端加载超时 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API 超时 |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | 子树最大深度 |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | 离线模式用户 |

## 5. 用户意图
用户希望获得一个**"打开即用"**的 PWA：
- 个人使用的项目，不需要复杂协同算法
- 必须要快：点击完成，立刻打勾，没有 loading 转圈
- 必须要稳：断网写的数据，联网后自动同步，不丢数据
