-- ============================================
-- 附件数量服务端限制
-- 日期：2026-01-01
-- 
-- 问题背景：
-- - 客户端限制可被绕过（通过直接 API 调用）
-- - 需要在服务端强制执行附件数量限制
-- ============================================

-- 定义最大附件数量常量
-- 与客户端 ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK 保持一致
DO $$
BEGIN
  -- 创建配置表（如果不存在）
  CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  
  -- 插入附件数量限制配置
  INSERT INTO public.app_config (key, value, description)
  VALUES ('max_attachments_per_task', '20', '每个任务最大附件数量')
  ON CONFLICT (key) DO NOTHING;
END $$;

-- 更新 append_task_attachment 函数，添加数量限制检查
CREATE OR REPLACE FUNCTION append_task_attachment(
  p_task_id UUID,
  p_attachment JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
  v_project_id UUID;
  v_user_id UUID;
  v_max_attachments INTEGER;
  v_current_count INTEGER;
BEGIN
  -- 🔴 安全检查：验证当前用户身份
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 获取最大附件数量限制（默认 20）
  SELECT COALESCE((value)::INTEGER, 20) INTO v_max_attachments
  FROM public.app_config
  WHERE key = 'max_attachments_per_task';
  
  IF v_max_attachments IS NULL THEN
    v_max_attachments := 20;
  END IF;

  -- 获取附件 ID
  v_attachment_id := p_attachment->>'id';
  
  IF v_attachment_id IS NULL THEN
    RAISE EXCEPTION 'Attachment must have an id';
  END IF;
  
  -- 使用 FOR UPDATE 锁定行，同时获取 project_id
  SELECT attachments, project_id INTO v_current_attachments, v_project_id
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;
  
  -- 🔴 安全检查：验证用户对该项目的所有权
  SELECT user_id INTO v_user_id
  FROM public.projects
  WHERE id = v_project_id;
  
  IF v_user_id IS NULL OR v_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: you do not own this project';
  END IF;
  
  -- 如果附件列为 NULL，初始化为空数组
  IF v_current_attachments IS NULL THEN
    v_current_attachments := '[]'::JSONB;
  END IF;
  
  -- 检查附件是否已存在（避免重复添加）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem
    WHERE elem->>'id' = v_attachment_id
  ) THEN
    -- 已存在，直接返回成功
    RETURN TRUE;
  END IF;
  
  -- 🔴 新增：检查附件数量限制
  v_current_count := jsonb_array_length(v_current_attachments);
  IF v_current_count >= v_max_attachments THEN
    RAISE EXCEPTION 'Attachment limit exceeded: maximum % attachments per task (current: %)', 
      v_max_attachments, v_current_count;
  END IF;
  
  -- 追加新附件
  UPDATE public.tasks
  SET 
    attachments = v_current_attachments || p_attachment,
    updated_at = NOW()
  WHERE id = p_task_id;
  
  RETURN TRUE;
END;
$$;

-- 添加注释
COMMENT ON FUNCTION append_task_attachment(UUID, JSONB) IS 
  '原子添加附件到任务，包含权限校验和数量限制检查（最大 20 个）';

-- 授权
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;

-- 为配置表添加 RLS
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- 只读策略（所有认证用户可读取配置）
CREATE POLICY "app_config_select" ON public.app_config
  FOR SELECT TO authenticated
  USING (true);

-- 表注释
COMMENT ON TABLE public.app_config IS '应用配置表，存储全局配置参数';
