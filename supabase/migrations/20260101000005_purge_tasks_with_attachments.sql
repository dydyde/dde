-- ============================================
-- purge_tasks_v3: 永久删除任务并返回附件路径
-- 日期: 2026-01-01
-- ============================================
-- 目的：
-- - 在 purge_tasks_v2 基础上，返回被删除任务的附件存储路径
-- - 客户端收到路径后调用 Storage API 删除文件
-- - 防止任务删除后附件变成孤儿文件
-- - 添加速率限制防止 DoS 攻击

-- 返回类型：包含删除数量和附件路径
DROP TYPE IF EXISTS purge_result CASCADE;
CREATE TYPE purge_result AS (
  purged_count integer,
  attachment_paths text[]
);

-- 速率限制配置
-- 每用户每分钟最多 10 次 purge 调用，每次最多 100 个任务
CREATE TABLE IF NOT EXISTS public.purge_rate_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  call_count integer DEFAULT 0,
  window_start timestamptz DEFAULT now()
);

ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_rate_limit" ON public.purge_rate_limits
  FOR ALL USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.purge_tasks_v3(
  p_project_id uuid, 
  p_task_ids uuid[]
)
RETURNS purge_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result purge_result;
  owner_id uuid;
  task_record RECORD;
  attachment jsonb;
  attachment_paths text[] := ARRAY[]::text[];
  file_ext text;
  current_user_id uuid;
  rate_limit_record RECORD;
  max_calls_per_minute CONSTANT integer := 10;
  max_tasks_per_call CONSTANT integer := 100;
BEGIN
  result.purged_count := 0;
  result.attachment_paths := ARRAY[]::text[];
  current_user_id := auth.uid();

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN result;
  END IF;
  
  -- 速率限制检查
  IF array_length(p_task_ids, 1) > max_tasks_per_call THEN
    RAISE EXCEPTION 'Too many tasks in single request. Maximum: %', max_tasks_per_call;
  END IF;
  
  -- 检查并更新调用次数
  INSERT INTO public.purge_rate_limits (user_id, call_count, window_start)
  VALUES (current_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    call_count = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN 1 
      ELSE purge_rate_limits.call_count + 1 
    END,
    window_start = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN now() 
      ELSE purge_rate_limits.window_start 
    END
  RETURNING call_count INTO rate_limit_record;
  
  IF rate_limit_record.call_count > max_calls_per_minute THEN
    RAISE EXCEPTION 'Rate limit exceeded. Maximum % calls per minute', max_calls_per_minute;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  SELECT p.owner_id INTO owner_id
  FROM public.projects p
  WHERE p.id = p_project_id
    AND p.owner_id = auth.uid();

  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 收集附件路径（在删除前）
  -- 路径格式: {owner_id}/{project_id}/{task_id}/{attachment_id}.{ext}
  FOR task_record IN
    SELECT t.id AS task_id, t.attachments
    FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
      AND t.attachments IS NOT NULL
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      -- 提取文件扩展名
      file_ext := COALESCE(
        NULLIF(SUBSTRING((attachment->>'name') FROM '\.([^.]+)$'), ''),
        'bin'
      );
      
      -- 构建完整路径
      attachment_paths := array_append(
        attachment_paths,
        owner_id::text || '/' || 
        p_project_id::text || '/' || 
        task_record.task_id::text || '/' || 
        (attachment->>'id') || '.' || file_ext
      );
      
      -- 如果有缩略图，也加入删除列表
      IF attachment->>'thumbnailUrl' IS NOT NULL THEN
        attachment_paths := array_append(
          attachment_paths,
          owner_id::text || '/' || 
          p_project_id::text || '/' || 
          task_record.task_id::text || '/' || 
          (attachment->>'id') || '_thumb.webp'
        );
      END IF;
    END LOOP;
  END LOOP;

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
  SELECT count(*) INTO result.purged_count FROM del;

  result.attachment_paths := attachment_paths;
  RETURN result;
END;
$$;

-- 授权
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.purge_tasks_v3 IS 
'永久删除任务并返回附件存储路径。客户端需要调用 Storage API 删除返回的路径。';
