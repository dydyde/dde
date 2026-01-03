-- ============================================
-- 安全加固：为 batch_upsert_tasks 添加 search_path
-- 日期: 2026-01-02
-- 问题: batch_upsert_tasks 函数缺少 SET search_path，存在 search_path 注入风险
-- 解决: 添加 SET search_path TO 'pg_catalog', 'public' 与项目标准一致
-- ============================================

-- 为 batch_upsert_tasks 设置安全的 search_path
ALTER FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  SET search_path TO 'pg_catalog', 'public';

-- 验证说明（在 psql 中执行）:
-- SELECT proconfig FROM pg_proc WHERE proname = 'batch_upsert_tasks';
-- 期望返回包含 search_path=pg_catalog, public
