-- ============================================
-- Dashboard RPC 聚合函数
-- 减少流量：从 MB 级原始数据降至 ~200 Bytes JSON
-- ============================================
-- @see docs/plan_save.md Phase 1.3

-- 创建 Dashboard 统计聚合函数
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'  -- 🔒 防止 search_path 注入攻击
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  -- 使用 initplan 缓存 user_id，避免每行重复计算
  RETURN json_build_object(
    'pending', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'active' AND deleted_at IS NULL),
    'completed', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'completed' AND deleted_at IS NULL),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id)
  );
END;
$$;

-- 添加函数注释
COMMENT ON FUNCTION public.get_dashboard_stats() IS 
  'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。使用 SECURITY DEFINER 确保 RLS 生效。';

-- 授权：仅认证用户可调用
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;
