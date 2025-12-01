# NanoFlow Project Tracker

一个复杂的项目追踪应用，具有双视图（文本/流程图）、Markdown 支持、任务云端同步。

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

## 功能特性

- 📝 **双视图模式**: 文本视图与流程图视图无缝切换
- 🔄 **云端同步**: 通过 Supabase 实现多设备数据同步
- 🎨 **主题系统**: 5 种精心设计的主题风格
- 📱 **响应式设计**: 完美适配桌面端和移动端
- 📦 **离线支持**: 无需后端配置也能使用基础功能
- 📝 **Markdown 支持**: 任务内容支持 Markdown 格式渲染
- 🔒 **附件支持**: 支持文件附件上传与管理

## Supabase 部署配置

### 数据库设置

执行 `scripts/supabase-setup.sql` 创建必要的数据库表和 RLS 策略。

### 定时任务配置 (Cron Jobs)

需要在 Supabase Dashboard 中配置以下定时任务：

#### 1. 附件清理任务

调用 Edge Function `cleanup-attachments` 清理孤立的存储文件：

```sql
-- 在 Supabase Dashboard > SQL Editor 中执行
SELECT cron.schedule(
  'cleanup-attachments',           -- Job 名称
  '0 3 * * 0',                     -- 每周日凌晨 3 点执行
  $$
  SELECT net.http_post(
    url := '<YOUR_PROJECT_URL>/functions/v1/cleanup-attachments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || '<YOUR_SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

#### 2. 清理日志任务

自动清理 30 天前的清理日志：

```sql
-- 已包含在 supabase-setup.sql 中
SELECT cron.schedule(
  'cleanup-old-logs',
  '0 4 * * 0',                     -- 每周日凌晨 4 点执行
  $$DELETE FROM cleanup_logs WHERE created_at < NOW() - INTERVAL '30 days'$$
);
```

### 存储桶配置

执行 `scripts/storage-setup.sql` 或使用 `scripts/setup-storage-bucket.cjs` 脚本创建附件存储桶。
