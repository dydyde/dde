-- ============================================
-- 熔断机制：服务端批量删除防护
-- 日期：2026-01-01
-- 
-- 功能：
--   1. safe_delete_tasks() - 安全批量删除 RPC
--   2. validate_task_data() - 任务数据校验触发器
--   3. circuit_breaker_logs - 熔断操作日志表
-- ============================================

-- ============================================
-- 规则 1: 安全批量删除 RPC
-- 
-- 设计原则：
-- - RLS 无法直接限制删除数量，需通过 RPC 包装
-- - 单次删除不能超过 50%，且不能超过 50 条
-- - 项目任务数 > 10 时，不允许删到 0
-- ============================================
CREATE OR REPLACE FUNCTION public.safe_delete_tasks(
  p_task_ids uuid[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  task_count integer;
  total_tasks integer;
  delete_ratio float;
  affected_count integer;
BEGIN
  -- 【权限校验】验证调用者是否有权操作该项目
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete tasks in project %', p_project_id;
  END IF;

  -- 获取待删除数量
  task_count := array_length(p_task_ids, 1);
  IF task_count IS NULL OR task_count = 0 THEN
    RETURN 0;
  END IF;
  
  -- 获取项目总任务数（未删除的）
  SELECT COUNT(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;
  
  -- 计算删除比例
  delete_ratio := task_count::float / GREATEST(total_tasks, 1);
  
  -- 规则 1：单次删除不能超过 50%
  IF delete_ratio > 0.5 THEN
    -- 记录到审计日志
    INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
    VALUES (
      auth.uid(),
      'safe_delete_tasks',
      true,
      'Delete ratio exceeded 50%',
      jsonb_build_object(
        'task_ids', p_task_ids,
        'project_id', p_project_id,
        'task_count', task_count,
        'total_tasks', total_tasks,
        'delete_ratio', delete_ratio
      )
    );
    
    RAISE EXCEPTION 'Bulk delete blocked: attempting to delete % tasks (%.1f%% of total %)', 
      task_count, delete_ratio * 100, total_tasks;
  END IF;
  
  -- 规则 2：单次删除不能超过 50 条
  IF task_count > 50 THEN
    -- 记录到审计日志
    INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
    VALUES (
      auth.uid(),
      'safe_delete_tasks',
      true,
      'Delete count exceeded 50',
      jsonb_build_object(
        'task_ids', p_task_ids,
        'project_id', p_project_id,
        'task_count', task_count,
        'total_tasks', total_tasks
      )
    );
    
    RAISE EXCEPTION 'Bulk delete blocked: attempting to delete % tasks (max 50 allowed)', 
      task_count;
  END IF;
  
  -- 规则 3：如果总任务数 > 10，不允许删到 0
  IF total_tasks > 10 AND task_count >= total_tasks THEN
    -- 记录到审计日志
    INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
    VALUES (
      auth.uid(),
      'safe_delete_tasks',
      true,
      'Cannot delete all tasks from large project',
      jsonb_build_object(
        'task_ids', p_task_ids,
        'project_id', p_project_id,
        'task_count', task_count,
        'total_tasks', total_tasks
      )
    );
    
    RAISE EXCEPTION 'Cannot delete all tasks from a project with more than 10 tasks';
  END IF;
  
  -- 执行软删除
  UPDATE public.tasks
  SET deleted_at = NOW(), updated_at = NOW()
  WHERE id = ANY(p_task_ids)
    AND project_id = p_project_id
    AND deleted_at IS NULL;  -- 只删除未删除的任务
  
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  
  -- 记录成功的删除操作到审计日志
  IF affected_count > 0 THEN
    INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
    VALUES (
      auth.uid(),
      'safe_delete_tasks',
      false,
      'Delete completed successfully',
      jsonb_build_object(
        'task_ids', p_task_ids,
        'project_id', p_project_id,
        'requested_count', task_count,
        'affected_count', affected_count,
        'total_tasks', total_tasks,
        'delete_ratio', delete_ratio
      )
    );
  END IF;
  
  RETURN affected_count;
END;
$$;

-- ============================================
-- 规则 2: 任务数据校验触发器
-- 
-- 确保任务数据的基本完整性：
-- - title 和 content 不能同时为空（除非是软删除）
-- - stage 必须非负（如果有值）
-- ============================================
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER AS $$
BEGIN
  -- 规则 1: 拒绝将 title 和 content 同时置空
  IF (NEW.title IS NULL OR NEW.title = '') AND (NEW.content IS NULL OR NEW.content = '') THEN
    -- 例外：软删除的任务允许
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Task must have either title or content (task_id: %)', NEW.id;
  END IF;
  
  -- 规则 2: stage 必须非负（如果有值）
  IF NEW.stage IS NOT NULL AND NEW.stage < 0 THEN
    RAISE EXCEPTION 'Invalid stage value: % (must be >= 0)', NEW.stage;
  END IF;
  
  -- 规则 3: rank 必须是正数（如果有值）
  IF NEW.rank IS NOT NULL AND NEW.rank < 0 THEN
    RAISE EXCEPTION 'Invalid rank value: % (must be >= 0)', NEW.rank;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 删除旧触发器（如果存在）
DROP TRIGGER IF EXISTS trg_validate_task_data ON public.tasks;

-- 创建新触发器
CREATE TRIGGER trg_validate_task_data
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.validate_task_data();

-- ============================================
-- 审计日志表
-- 记录所有熔断操作（阻止和通过的）
-- ============================================
CREATE TABLE IF NOT EXISTS public.circuit_breaker_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operation text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_user_id ON public.circuit_breaker_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_created_at ON public.circuit_breaker_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_blocked ON public.circuit_breaker_logs(blocked) WHERE blocked = true;

-- RLS 策略：只能查看自己的日志
ALTER TABLE public.circuit_breaker_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS circuit_breaker_logs_select_own ON public.circuit_breaker_logs;
CREATE POLICY circuit_breaker_logs_select_own ON public.circuit_breaker_logs
  FOR SELECT USING (user_id = auth.uid());

-- 不允许用户直接删除日志（审计日志需保留）
-- INSERT 由 RPC 函数内部执行（SECURITY DEFINER 绕过 RLS）

-- ============================================
-- 授权
-- ============================================
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- ============================================
-- 注释
-- ============================================
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS 
  '安全的批量删除任务 RPC。限制：单次最多删除 50 条或 50% 的任务。';
COMMENT ON FUNCTION public.validate_task_data() IS 
  '任务数据校验触发器。确保 title/content 不同时为空，stage/rank 为有效值。';
COMMENT ON TABLE public.circuit_breaker_logs IS 
  '熔断操作审计日志。记录所有批量删除操作（包括被阻止和成功的）。';
