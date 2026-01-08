-- ============================================
-- 安全加固 + 性能小优化（search_path + 外键索引 + RLS initplan）
-- 日期: 2025-12-12
-- ============================================

-- 1) 性能：为未覆盖的外键列补齐索引
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by
  ON public.project_members (invited_by);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id
  ON public.task_tombstones (project_id);

-- 2) 安全：为函数显式设置 search_path（避免 search_path 可变引发的劫持风险）
-- 说明：优先 pg_catalog，确保内建函数解析更安全。
ALTER FUNCTION public.update_updated_at_column()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.cleanup_old_deleted_tasks()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.cleanup_old_logs()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.migrate_project_data_to_v2(p_project_id uuid)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.migrate_all_projects_to_v2()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.purge_tasks(p_task_ids uuid[])
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.purge_tasks_v2(p_project_id uuid, p_task_ids uuid[])
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.prevent_tombstoned_task_writes()
  SET search_path = pg_catalog, public;

-- 3) 性能：RLS policy 使用 (select auth.uid())，避免每行重复计算（initplan）

-- projects
DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects
  FOR SELECT
  TO public
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner insert" ON public.projects;
CREATE POLICY "owner insert" ON public.projects
  FOR INSERT
  TO public
  WITH CHECK ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects
  FOR UPDATE
  TO public
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE
  TO public
  USING ((select auth.uid()) = owner_id);

-- project_members
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT
  TO public
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members update" ON public.project_members;
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members delete" ON public.project_members;
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE
  TO public
  USING (
    (user_id = (select auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- tasks
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- connections
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner update" ON public.connections;
CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- user_preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT
  TO public
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE
  TO public
  USING ((select auth.uid()) = user_id);

-- task_tombstones
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );
