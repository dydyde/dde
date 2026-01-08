-- ============================================
-- 同步数据库 Schema 与项目代码
-- 日期: 2025-12-03
-- ============================================

-- 1. 为 user_preferences 表添加缺失的列
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS layout_direction varchar(10) DEFAULT 'ltr',
  ADD COLUMN IF NOT EXISTS floating_window_pref varchar(10) DEFAULT 'auto';

-- 添加约束检查
DO $$
BEGIN
  -- 删除旧约束（如果存在）然后添加新约束
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_layout_direction_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_layout_direction_check 
    CHECK (layout_direction IS NULL OR layout_direction IN ('ltr', 'rtl'));
    
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_floating_window_pref_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_floating_window_pref_check 
    CHECK (floating_window_pref IS NULL OR floating_window_pref IN ('auto', 'fixed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. 创建清理日志表
CREATE TABLE IF NOT EXISTS cleanup_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(50) NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- 为清理日志表启用 RLS
ALTER TABLE cleanup_logs ENABLE ROW LEVEL SECURITY;

-- 清理日志表的 RLS 策略（仅允许系统写入，无用户直接访问）
DROP POLICY IF EXISTS "cleanup_logs_select_policy" ON cleanup_logs;
CREATE POLICY "cleanup_logs_select_policy" ON cleanup_logs
  FOR SELECT USING (false); -- 普通用户不能读取

-- 3. 创建清理过期软删除任务的函数
CREATE OR REPLACE FUNCTION cleanup_old_deleted_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- 删除超过 30 天的软删除任务
  WITH deleted AS (
    DELETE FROM tasks
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  
  -- 记录清理日志
  IF deleted_count > 0 THEN
    INSERT INTO cleanup_logs (type, details)
    VALUES ('deleted_tasks_cleanup', jsonb_build_object(
      'deleted_count', deleted_count,
      'cleanup_time', NOW()
    ));
  END IF;
  
  RETURN deleted_count;
END;
$$;

-- 4. 创建清理旧日志的函数
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- 删除超过 90 天的日志
  WITH deleted AS (
    DELETE FROM cleanup_logs
    WHERE created_at < NOW() - INTERVAL '90 days'
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  
  RETURN deleted_count;
END;
$$;

-- 5. 为 tasks 表的 deleted_at 添加索引（加速清理查询）
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 6. 为 cleanup_logs 表添加索引
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON cleanup_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON cleanup_logs (type);

-- 7. 授予必要的权限
GRANT SELECT, INSERT ON cleanup_logs TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_logs() TO service_role;
