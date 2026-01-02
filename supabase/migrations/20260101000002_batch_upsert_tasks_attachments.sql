-- batch_upsert_tasks 函数：支持批量 upsert 任务，包含 attachments 字段
-- 用于批量操作的事务保护（≥20 个任务）
-- 
-- v5.2.2 修正：添加 attachments jsonb 字段支持
-- 安全特性：
-- 1. SECURITY DEFINER + auth.uid() 权限校验
-- 2. 只能操作自己的项目和任务
-- 3. 事务保证原子性

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
BEGIN
  -- 权限校验：获取当前用户 ID
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;
  
  -- 权限校验：验证用户是项目所有者
  IF NOT EXISTS (
    SELECT 1 FROM public.projects 
    WHERE id = p_project_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner (project_id: %, user_id: %)', p_project_id, v_user_id;
  END IF;
  
  -- 事务内执行，任何失败自动回滚
  FOREACH v_task IN ARRAY p_tasks
  LOOP
    INSERT INTO public.tasks (
      id, project_id, title, content, stage, parent_id, 
      "order", rank, status, x, y, short_id, deleted_at, owner_id,
      attachments  -- v5.2.2 新增
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_task->>'title',
      v_task->>'content',
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::integer, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::integer, 0),
      COALESCE((v_task->>'y')::integer, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      v_user_id,
      COALESCE(v_task->'attachments', '[]'::jsonb)  -- v5.2.2 新增：默认空数组
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = EXCLUDED.attachments,  -- v5.2.2 新增
      updated_at = NOW()
    WHERE public.tasks.owner_id = v_user_id;  -- 只能更新自己的任务
    
    v_count := v_count + 1;
  END LOOP;
  
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  -- 任何错误导致整个事务回滚
  RAISE;
END;
$$;

-- 授权
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

COMMENT ON FUNCTION public.batch_upsert_tasks IS 'Batch upsert tasks with transaction guarantee. Includes attachments field support (v5.2.2).';
