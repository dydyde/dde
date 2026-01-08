-- ============================================
-- 阻止“永久删除任务”被旧端 upsert 复活
-- 日期: 2025-12-12
-- ============================================
--
-- 背景：
-- 1) 物理 DELETE 后，如果某个离线/旧版本客户端仍持有该 task 并执行 upsert，
--    Postgres 会将其当作 INSERT，从而把任务“插回”云端（复活）。
-- 2) 解决思路：为“永久删除”建立不可逆 tombstone。
--    - purge RPC：写入 tombstone + 删除 tasks 行（以及相关 connections）。
--    - trigger：拦截对 tombstoned task_id 的 INSERT/UPDATE，直接丢弃写入，避免复活。

-- 1) Tombstone 表
CREATE TABLE IF NOT EXISTS public.task_tombstones (
  task_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid NULL
);

ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;

-- 允许项目 owner 读取 tombstones（用于诊断/未来同步增强）
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.owner_id = auth.uid()
    )
  );

-- 仅允许项目 owner 写入 tombstones（通过 RPC 调用）
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.owner_id = auth.uid()
    )
  );

-- 2) purge RPC：批量永久删除任务（写 tombstone + 删除 tasks + 删除相关 connections）
CREATE OR REPLACE FUNCTION public.purge_tasks(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH to_purge AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = ANY(p_task_ids)
      AND p.owner_id = auth.uid()
  ),
  ins AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT task_id, project_id, now(), auth.uid()
    FROM to_purge
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id
  ),
  del_connections AS (
    DELETE FROM public.connections c
    USING to_purge tp
    WHERE c.project_id = tp.project_id
      AND (c.source_id = tp.task_id OR c.target_id = tp.task_id)
  ),
  del_tasks AS (
    DELETE FROM public.tasks t
    USING to_purge tp
    WHERE t.id = tp.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del_tasks;

  RETURN COALESCE(purged_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO service_role;

-- 3) 防复活触发器：拦截对已 tombstone task_id 的 INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_task_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_tombstones tt
    WHERE tt.task_id = NEW.id
  ) THEN
    -- 静默丢弃写入，避免旧端 upsert 复活
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_tombstoned_task_writes ON public.tasks;
CREATE TRIGGER trg_prevent_tombstoned_task_writes
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.prevent_tombstoned_task_writes();
