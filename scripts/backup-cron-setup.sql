-- NanoFlow 备份系统定时任务配置
-- 版本: 1.0.0
-- 日期: 2026-01-01
-- 描述: 配置 Supabase pg_cron 定时触发备份 Edge Functions

-- ===========================================
-- 前置要求
-- ===========================================
-- 1. 需要在 Supabase Dashboard 中启用 pg_cron 扩展
-- 2. 需要启用 pg_net 扩展用于 HTTP 调用
-- 3. Edge Functions 需要已部署

-- 启用扩展（如果尚未启用）
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ===========================================
-- 1. 全量备份定时任务
-- ===========================================
-- 每日 00:00 UTC 执行全量备份

SELECT cron.schedule(
  'nanoflow-backup-full',           -- 任务名称
  '0 0 * * *',                      -- Cron 表达式：每天 00:00 UTC
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ===========================================
-- 2. 增量备份定时任务
-- ===========================================
-- 每 15 分钟执行增量备份

SELECT cron.schedule(
  'nanoflow-backup-incremental',    -- 任务名称
  '*/15 * * * *',                   -- Cron 表达式：每 15 分钟
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-incremental',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ===========================================
-- 3. 备份清理定时任务
-- ===========================================
-- 每日 01:00 UTC 执行备份清理（在全量备份后 1 小时）

SELECT cron.schedule(
  'nanoflow-backup-cleanup',        -- 任务名称
  '0 1 * * *',                      -- Cron 表达式：每天 01:00 UTC
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-cleanup',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ===========================================
-- 4. 附件清理定时任务
-- ===========================================
-- 每日 02:00 UTC 执行附件清理

SELECT cron.schedule(
  'nanoflow-cleanup-attachments',   -- 任务名称
  '0 2 * * *',                      -- Cron 表达式：每天 02:00 UTC
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/cleanup-attachments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ===========================================
-- 5. 每日健康报告
-- ===========================================
-- 每日 08:00 UTC (北京时间 16:00) 发送备份健康报告

SELECT cron.schedule(
  'nanoflow-backup-health-report',   -- 任务名称
  '0 8 * * *',                       -- Cron 表达式：每天 08:00 UTC
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-alert',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"action": "health_report"}'::jsonb
  )
  $$
);

-- ===========================================
-- 辅助查询
-- ===========================================

-- 查看所有已配置的定时任务
-- SELECT * FROM cron.job WHERE jobname LIKE 'nanoflow-%';

-- 查看定时任务执行历史
-- SELECT * FROM cron.job_run_details 
-- WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'nanoflow-%')
-- ORDER BY start_time DESC
-- LIMIT 20;

-- 手动运行任务（用于测试）
-- SELECT cron.run_job('nanoflow-backup-full');

-- 暂停任务
-- UPDATE cron.job SET active = false WHERE jobname = 'nanoflow-backup-full';

-- 恢复任务
-- UPDATE cron.job SET active = true WHERE jobname = 'nanoflow-backup-full';

-- 删除任务
-- SELECT cron.unschedule('nanoflow-backup-full');

-- ===========================================
-- 注意事项
-- ===========================================

-- 1. 上述 SQL 使用了 current_setting('app.settings.xxx') 来获取配置
--    需要在 Supabase Dashboard → Settings → Database 中配置这些值
--    或者使用 ALTER SYSTEM SET 命令设置

-- 2. 如果使用硬编码的 URL 和密钥，替换为：
/*
SELECT cron.schedule(
  'nanoflow-backup-full',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/backup-full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
*/

-- 3. 建议在生产环境中使用 Vault 存储敏感配置：
/*
SELECT cron.schedule(
  'nanoflow-backup-full',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url := vault.decrypted_secrets(secret_name := 'supabase_url') || '/functions/v1/backup-full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || vault.decrypted_secrets(secret_name := 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
*/

COMMENT ON EXTENSION pg_cron IS 'NanoFlow 使用 pg_cron 调度备份和清理任务';
