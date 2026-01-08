-- ============================================
-- Tombstone-aware task loading optimization
-- 日期: 2025-12-13
-- ============================================
--
-- 背景：
-- - 修复了"电脑端删除的任务在手机端登录后恢复"的问题
-- - 原因：loadTasks 函数没有检查 task_tombstones 表，也没有过滤软删除的任务
-- - 解决方案：
--   1. 在 loadTasks 中同时检查 tombstone 和 deleted_at
--   2. 创建辅助视图和函数简化客户端查询
--   3. 添加性能索引
--
-- 优化：
-- - 创建视图简化客户端查询
-- - 添加性能索引
-- - 确保 RLS 策略正确应用
--
-- 修复的具体问题：
-- 1. 永久删除的任务（有 tombstone）在其他设备上复活
-- 2. 软删除的任务（deleted_at 不为 null）在其他设备上复活
-- 3. 待分配任务（stage = null）的删除也会在其他设备上恢复

-- 1) 创建视图：自动过滤已 tombstone 和软删除的任务
CREATE OR REPLACE VIEW public.active_tasks AS
SELECT t.*
FROM public.tasks t
WHERE NOT EXISTS (
  SELECT 1 
  FROM public.task_tombstones tt 
  WHERE tt.task_id = t.id
)
AND t.deleted_at IS NULL;

-- 为视图设置 RLS（继承基表的 RLS）
ALTER VIEW public.active_tasks SET (security_invoker = true);

COMMENT ON VIEW public.active_tasks IS '
自动过滤已被永久删除（tombstone）和软删除（deleted_at 不为 null）的任务的视图。
客户端应优先使用此视图而非直接查询 tasks 表，以避免已删除任务复活。
此视图解决了以下问题：
1. 永久删除的任务在其他设备上复活
2. 软删除的任务在其他设备上复活  
3. 待分配任务（stage = null）的删除也会在其他设备上恢复
';

-- 2) 创建辅助函数：批量检查任务是否在 tombstone 中
CREATE OR REPLACE FUNCTION public.is_task_tombstoned(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.task_tombstones 
    WHERE task_id = p_task_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO service_role;

COMMENT ON FUNCTION public.is_task_tombstoned IS '
检查指定任务是否已被永久删除（在 tombstone 表中）。
返回 true 表示该任务已被永久删除，不应被恢复或显示。
';

-- 3) 性能优化：确保 tombstone 查询索引存在
-- （这个索引应该已在 20251212_hardening_and_indexes.sql 中创建，这里做防御性检查）
CREATE INDEX IF NOT EXISTS idx_task_tombstones_task_id 
  ON public.task_tombstones (task_id);

-- 4) 数据一致性检查：查找存在 tombstone 但仍有 tasks 行的数据
-- （这些数据理论上不应存在，因为 purge RPC 会同时删除）
DO $$
DECLARE
  inconsistent_count integer;
BEGIN
  SELECT COUNT(*) INTO inconsistent_count
  FROM public.task_tombstones tt
  INNER JOIN public.tasks t ON t.id = tt.task_id;
  
  IF inconsistent_count > 0 THEN
    RAISE WARNING 'Found % tasks that exist in both tasks and task_tombstones tables. Consider running cleanup.', inconsistent_count;
  END IF;
END $$;
