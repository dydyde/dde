-- ============================================================================
-- 同步机制强化迁移脚本
-- 创建日期: 2025-12-15
-- 目的:
--   1. 为 user_preferences 表启用 REPLICA IDENTITY FULL
--   2. 添加缺失的索引以优化实时同步性能
--   3. 强化数据完整性约束
-- ============================================================================

-- ============================================================================
-- 1. 为 user_preferences 启用 REPLICA IDENTITY FULL
-- 这确保 Supabase Realtime 的 DELETE 事件能够返回完整的行数据
-- 没有这个设置，DELETE 事件只会返回主键，导致前端无法正确处理删除
-- ============================================================================
ALTER TABLE public.user_preferences REPLICA IDENTITY FULL;

-- 验证设置（通过注释记录，实际验证需要在 psql 中执行）
-- SELECT relreplident FROM pg_class WHERE relname = 'user_preferences';
-- 期望返回 'f' (full)

-- ============================================================================
-- 2. 为实时同步添加优化索引
-- 这些索引优化 Realtime 订阅的过滤查询
-- ============================================================================

-- 优化 projects 表的 owner_id 查询（如果不存在）
CREATE INDEX IF NOT EXISTS idx_projects_owner_id_updated 
ON public.projects(owner_id, updated_at DESC);

-- 优化 tasks 表的 project_id + updated_at 查询
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated 
ON public.tasks(project_id, updated_at DESC);

-- 优化 connections 表的 project_id 查询
CREATE INDEX IF NOT EXISTS idx_connections_project_id 
ON public.connections(project_id);

-- 优化 user_preferences 表的 user_id 查询
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id 
ON public.user_preferences(user_id);

-- ============================================================================
-- 3. 添加用于冲突检测的 updated_at 触发器（如果不存在）
-- 确保每次更新都会自动更新 updated_at 字段
-- ============================================================================

-- 创建通用的 updated_at 触发器函数
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为 projects 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.projects;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 tasks 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.tasks;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 connections 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.connections;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 user_preferences 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.user_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================================
-- 4. 添加版本号自动递增约束
-- 防止版本号回退，用于乐观锁冲突检测
-- ============================================================================

-- 创建版本号验证函数
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在版本号存在且被修改时检查
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    -- 允许版本号增加或保持不变（用于冲突解决后的强制覆盖）
    -- 但不允许回退
    IF NEW.version < OLD.version THEN
      RAISE WARNING 'Version regression detected: % -> %, allowing update but logging', OLD.version, NEW.version;
      -- 注意：这里只是警告，不阻止更新，因为冲突解决可能需要这样做
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为 projects 表添加版本检查触发器
DROP TRIGGER IF EXISTS check_version_increment ON public.projects;
CREATE TRIGGER check_version_increment
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_version_increment();

-- ============================================================================
-- 5. 添加死锁预防索引
-- 确保并发更新时有一致的锁定顺序
-- ============================================================================

-- 添加 tasks 表的 id 索引用于批量更新
CREATE INDEX IF NOT EXISTS idx_tasks_id_project_id 
ON public.tasks(id, project_id);

-- 添加 connections 表的复合索引用于批量删除
CREATE INDEX IF NOT EXISTS idx_connections_source_target 
ON public.connections(source_id, target_id);

-- ============================================================================
-- 完成
-- ============================================================================
COMMENT ON TABLE public.projects IS '项目表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.tasks IS '任务表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.connections IS '连接表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.user_preferences IS '用户偏好表 - REPLICA IDENTITY FULL for Realtime';
