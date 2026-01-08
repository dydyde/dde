-- ============================================
-- RLS 策略 initplan 优化审计修复
-- 日期: 2026-01-03
-- 
-- 问题: connection_tombstones 表的 RLS 策略未使用 (select auth.uid())
-- 影响: 每行都会重复计算 auth.uid()，影响性能
-- 解决: 使用 initplan 缓存 auth.uid() 值
-- 
-- @see docs/plan_save.md Phase 1.4
-- ============================================

-- 修复 connection_tombstones 表 RLS 策略
-- 使用 (select auth.uid()) 替代 auth.uid() 实现 initplan 优化

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = (select auth.uid())
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = (select auth.uid())
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = (select auth.uid())
    )
  );

-- 更新相关函数的 auth.uid() 调用也使用 initplan
-- 注意：在函数中设置 search_path 以防止注入攻击

ALTER FUNCTION public.record_connection_tombstone()
  SET search_path = pg_catalog, public;

-- 添加 RLS 策略审计注释
COMMENT ON POLICY "connection_tombstones_select" ON public.connection_tombstones IS
  'SELECT 策略 - 使用 initplan 优化的 (select auth.uid())';

COMMENT ON POLICY "connection_tombstones_insert" ON public.connection_tombstones IS
  'INSERT 策略 - 使用 initplan 优化的 (select auth.uid())';
