-- ============================================
-- purge_tasks_v2: 支持在 tasks 行不存在时也能落 tombstone
-- 日期: 2025-12-12
-- ============================================
-- 目的：
-- - 客户端“永久删除”时，优先写入不可逆 tombstone，阻断旧端/离线端 upsert 复活。
-- - 即使 tasks 行已不存在（例如历史物理删除），也能通过 project_id 强制落 tombstone。

CREATE OR REPLACE FUNCTION public.purge_tasks_v2(p_project_id uuid, p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 先落 tombstone（即使 tasks 行已不存在也会生效）
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT unnest(p_task_ids), p_project_id, now(), auth.uid()
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行（如果存在）
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del;

  RETURN COALESCE(purged_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;
