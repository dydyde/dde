-- 附件原子操作 RPC 函数
-- 用于安全地添加和移除任务附件，避免竞态条件
-- v2: 添加 auth.uid() 权限校验，防止越权访问

-- 添加附件的原子操作
-- 使用 JSONB 数组追加，确保并发安全
CREATE OR REPLACE FUNCTION append_task_attachment(
  p_task_id UUID,
  p_attachment JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
  v_project_id UUID;
  v_user_id UUID;
BEGIN
  -- 🔴 安全检查：验证当前用户身份
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 获取附件 ID
  v_attachment_id := p_attachment->>'id';
  
  IF v_attachment_id IS NULL THEN
    RAISE EXCEPTION 'Attachment must have an id';
  END IF;
  
  -- 使用 FOR UPDATE 锁定行，同时获取 project_id
  SELECT attachments, project_id INTO v_current_attachments, v_project_id
  FROM tasks
  WHERE id = p_task_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;
  
  -- 🔴 安全检查：验证用户对该项目的所有权
  SELECT user_id INTO v_user_id
  FROM projects
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
  
  -- 追加新附件
  UPDATE tasks
  SET 
    attachments = v_current_attachments || p_attachment,
    updated_at = NOW()
  WHERE id = p_task_id;
  
  RETURN TRUE;
END;
$$;

-- 移除附件的原子操作
CREATE OR REPLACE FUNCTION remove_task_attachment(
  p_task_id UUID,
  p_attachment_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
  v_project_id UUID;
  v_user_id UUID;
BEGIN
  -- 🔴 安全检查：验证当前用户身份
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 使用 FOR UPDATE 锁定行，同时获取 project_id
  SELECT attachments, project_id INTO v_current_attachments, v_project_id
  FROM tasks
  WHERE id = p_task_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;
  
  -- 🔴 安全检查：验证用户对该项目的所有权
  SELECT user_id INTO v_user_id
  FROM projects
  WHERE id = v_project_id;
  
  IF v_user_id IS NULL OR v_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: you do not own this project';
  END IF;
  
  -- 如果附件列为 NULL 或空，直接返回
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN
    RETURN TRUE;
  END IF;
  
  -- 过滤掉要删除的附件
  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB)
  INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem
  WHERE elem->>'id' != p_attachment_id;
  
  -- 更新附件列表
  UPDATE tasks
  SET 
    attachments = v_new_attachments,
    updated_at = NOW()
  WHERE id = p_task_id;
  
  RETURN TRUE;
END;
$$;

-- 授予 authenticated 用户执行权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;

-- 注意：这些函数使用 SECURITY DEFINER 并在内部实现了 auth.uid() 校验
-- 确保只有项目所有者才能操作任务附件
