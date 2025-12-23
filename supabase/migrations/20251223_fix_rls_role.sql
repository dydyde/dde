-- ============================================
-- 修复 RLS 策略角色：public -> authenticated
-- 日期: 2025-12-23
-- 问题: RLS 策略使用了 'TO public'，但 Supabase 认证用户属于 'authenticated' 角色
-- 症状: 认证用户请求返回 "Failed to fetch" 错误（底层是 403/权限被拒）
-- ============================================

-- 1. 修复 projects 表 RLS 策略
DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner insert" ON public.projects;
CREATE POLICY "owner insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

-- 2. 修复 project_members 表 RLS 策略
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members update" ON public.project_members;
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members delete" ON public.project_members;
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE TO authenticated
  USING (
    (user_id = (select auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- 3. 修复 tasks 表 RLS 策略
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- 4. 修复 connections 表 RLS 策略
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner update" ON public.connections;
CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- 5. 修复 task_tombstones 表 RLS 策略
DROP POLICY IF EXISTS "tombstones owner select" ON public.task_tombstones;
CREATE POLICY "tombstones owner select" ON public.task_tombstones
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tombstones owner insert" ON public.task_tombstones;
CREATE POLICY "tombstones owner insert" ON public.task_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tombstones owner delete" ON public.task_tombstones;
CREATE POLICY "tombstones owner delete" ON public.task_tombstones
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- 6. 修复 cleanup_logs 表 RLS 策略
DROP POLICY IF EXISTS "cleanup_logs select" ON public.cleanup_logs;
CREATE POLICY "cleanup_logs select" ON public.cleanup_logs
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "cleanup_logs insert" ON public.cleanup_logs;
CREATE POLICY "cleanup_logs insert" ON public.cleanup_logs
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- 7. 修复 user_preferences 表 RLS 策略
DROP POLICY IF EXISTS "user_preferences select" ON public.user_preferences;
CREATE POLICY "user_preferences select" ON public.user_preferences
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences insert" ON public.user_preferences;
CREATE POLICY "user_preferences insert" ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences update" ON public.user_preferences;
CREATE POLICY "user_preferences update" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences delete" ON public.user_preferences;
CREATE POLICY "user_preferences delete" ON public.user_preferences
  FOR DELETE TO authenticated
  USING (user_id = (select auth.uid()));
