-- ============================================
-- 安全加固迁移：修复 SECURITY DEFINER 函数权限校验
-- 日期：2026-01-01
-- 修复问题：
--   - Critical #2: append_task_attachment/remove_task_attachment 无权限校验
--   - Critical #5: is_task_tombstoned 无权限校验
-- ============================================

-- 【Critical #2】修复 append_task_attachment 函数 - 添加权限校验
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
BEGIN
  -- 🔴【关键修复】权限校验：验证调用者是否有权操作该任务
  IF NOT EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = p_task_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify task %', p_task_id;
  END IF;

  -- 获取附件 ID
  v_attachment_id := p_attachment->>'id';
  
  IF v_attachment_id IS NULL THEN
    RAISE EXCEPTION 'Attachment must have an id';
  END IF;
  
  -- 使用 FOR UPDATE 锁定行，防止并发修改
  SELECT attachments INTO v_current_attachments
  FROM tasks
  WHERE id = p_task_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
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

-- 【Critical #2】修复 remove_task_attachment 函数 - 添加权限校验
CREATE OR REPLACE FUNCTION remove_task_attachment(
  p_task_id UUID,
  p_attachment_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
BEGIN
  -- 🔴【关键修复】权限校验：验证调用者是否有权操作该任务
  IF NOT EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = p_task_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify task %', p_task_id;
  END IF;

  -- 使用 FOR UPDATE 锁定行
  SELECT attachments INTO v_current_attachments
  FROM tasks
  WHERE id = p_task_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
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

-- 【Critical #5】修复 is_task_tombstoned 函数 - 添加权限校验
-- 🔴 v5.3 修正：无权访问时返回 false（与任务不存在行为一致）
-- 避免通过 NULL vs false 区分任务存在性（信息泄露）
CREATE OR REPLACE FUNCTION is_task_tombstoned(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  -- 🔴【关键修复】权限校验：无权访问时返回 false，与任务不存在行为一致
  IF NOT EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = p_task_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    -- 无权访问时返回 false（与任务不存在行为一致，避免信息泄露）
    RETURN false;
  END IF;
  
  -- 检查任务是否在 tombstone 表中
  RETURN EXISTS (
    SELECT 1 FROM task_tombstones
    WHERE task_id = p_task_id
  );
END;
$$;

-- 重新授予权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION is_task_tombstoned(UUID) TO authenticated;

-- 添加注释说明安全措施
COMMENT ON FUNCTION append_task_attachment(UUID, JSONB) IS 
  '安全地添加任务附件（带权限校验）。只有任务所属项目的 owner 或成员才能操作。';
COMMENT ON FUNCTION remove_task_attachment(UUID, TEXT) IS 
  '安全地移除任务附件（带权限校验）。只有任务所属项目的 owner 或成员才能操作。';
COMMENT ON FUNCTION is_task_tombstoned(UUID) IS 
  '检查任务是否已被永久删除（带权限校验）。无权访问时返回 false 以避免信息泄露。';
