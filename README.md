# NanoFlow Project Tracker

一个高效的项目追踪应用，具有双视图（文本/流程图）、Markdown 支持、离线优先、云端同步。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.x | 前端框架（Signals + 独立组件） |
| Supabase | ^2.84.0 | BaaS（认证 + 数据库 + 存储） |
| GoJS | ^3.1.1 | 流程图渲染 |
| Sentry | ^10.32.1 | 错误监控 |
| Vitest / Playwright | - | 单元测试 / E2E 测试 |

## 本地运行

**前置条件:** Node.js 18+

1. 安装依赖:
   ```bash
   npm install
   ```

2. 配置环境变量 (可选):
   
   创建 `.env.local` 文件并添加以下内容（如不配置将以离线模式运行）:
   ```
   # Supabase 配置（云端同步功能）
   NG_APP_SUPABASE_URL=your_supabase_url
   NG_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

3. 运行应用:
   ```bash
   npm start
   ```

## 开发命令

```bash
npm start              # 开发服务器
npm run test           # Vitest watch 模式
npm run test:run       # 单次运行测试
npm run test:e2e       # Playwright E2E
npm run lint:fix       # ESLint 自动修复
npm run build          # 生产构建
```

## 功能特性

- 📝 **双视图模式**: 文本视图与流程图视图无缝切换
- 🔄 **云端同步**: 通过 Supabase 实现多设备数据同步（LWW 冲突解决）
- 📱 **离线优先**: 本地 IndexedDB 存储，断网可用，联网自动同步
- 🎨 **主题系统**: 5 种精心设计的主题风格
- 📦 **PWA 支持**: 可安装，响应式设计
- 📝 **Markdown 支持**: 任务内容支持 Markdown 格式渲染
- 🔒 **附件支持**: 支持文件附件上传与管理

## 核心架构

```
src/
├── app/
│   ├── core/           # 核心单例（状态、同步）
│   ├── features/       # 业务模块（flow、text）
│   └── shared/         # 共享组件与模态框
├── services/           # 主服务层（50+ 服务）
├── config/             # 配置常量
├── models/             # 数据模型
└── utils/              # 工具函数
```

---

## Supabase 部署配置

### 快速开始（一次性导入）

在 Supabase SQL Editor 中执行 `scripts/init-database.sql` 即可完成所有数据库配置。

```bash
# 或者分步执行
scripts/supabase-setup.sql    # 核心表结构
scripts/storage-setup.sql     # Storage 策略
scripts/attachment-rpc.sql    # 附件 RPC 函数
```

### 数据库表结构

| 表名 | 用途 | 主要字段 |
|------|------|----------|
| `projects` | 项目 | id, owner_id, title, description, updated_at |
| `tasks` | 任务 | id, project_id, parent_id, title, content, stage, status, x, y, attachments |
| `connections` | 任务连接 | id, project_id, source_id, target_id, title, description |
| `project_members` | 项目成员 | id, project_id, user_id, role (viewer/editor/admin) |
| `user_preferences` | 用户偏好 | id, user_id, theme, layout_direction |
| `cleanup_logs` | 清理日志 | id, type, details, created_at |

### RPC 函数

| 函数 | 用途 | 调用示例 |
|------|------|----------|
| `append_task_attachment(task_id, attachment)` | 原子添加附件 | `supabase.rpc('append_task_attachment', {...})` |
| `remove_task_attachment(task_id, attachment_id)` | 原子删除附件 | `supabase.rpc('remove_task_attachment', {...})` |
| `cleanup_old_deleted_tasks()` | 清理软删除任务 | 定时任务调用 |
| `cleanup_deleted_attachments(days)` | 清理过期附件 | 定时任务调用 |

### Storage 配置

1. 在 Supabase Dashboard > Storage 中创建 `attachments` 桶：
   - **Public**: false（私有）
   - **File size limit**: 10MB
   - **路径格式**: `{user_id}/{project_id}/{task_id}/{filename}`

2. Storage 策略已包含在 `init-database.sql` 中，支持：
   - 用户上传/查看/删除自己的附件
   - 项目成员查看共享附件

### 定时任务配置（可选）

需要启用 pg_cron 扩展（Dashboard > Database > Extensions）：

```sql
-- 每天凌晨 3 点清理软删除任务
SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', 
  $$SELECT cleanup_old_deleted_tasks()$$);

-- 每周日凌晨调用 Edge Function 清理附件
SELECT cron.schedule('cleanup-attachments', '0 3 * * 0', $$
  SELECT net.http_post(
    url := '<YOUR_PROJECT_URL>/functions/v1/cleanup-attachments',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>'),
    body := '{}'::jsonb
  );
$$);
```

### 脚本说明

| 脚本 | 用途 | 执行时机 |
|------|------|----------|
| `init-database.sql` | **一次性完整初始化** | 新项目部署 |
| `supabase-setup.sql` | 核心表结构 + RLS | 单独配置时 |
| `storage-setup.sql` | Storage 桶策略 | 单独配置时 |
| `attachment-rpc.sql` | 附件操作函数 | 单独配置时 |
| `migrate-to-v2.sql` | 旧版 JSONB 迁移 | 升级旧数据库 |
| `purge-deleted-tasks.sql` | 回收站清理 | 配置定时任务 |

---

## 关键配置

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | API 超时 |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | 离线模式 |

## License

MIT
