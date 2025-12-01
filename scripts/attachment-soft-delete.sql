-- 附件软删除支持迁移
-- 为附件添加 deleted_at 字段支持软删除

-- 1. 在 tasks 表中添加 attachments_deleted 字段（存储已标记删除的附件ID列表）
-- 注意：attachments 字段已经是 JSONB 类型，我们在其中为每个附件添加 deletedAt 字段

-- 2. 创建清理过期附件的存储过程
CREATE OR REPLACE FUNCTION cleanup_deleted_attachments(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(
  deleted_count INTEGER,
  storage_paths TEXT[]
) AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  paths_to_delete TEXT[] := ARRAY[]::TEXT[];
  task_record RECORD;
  attachment JSONB;
  attachment_path TEXT;
  total_deleted INTEGER := 0;
BEGIN
  cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
  
  -- 遍历所有任务，找出过期的已删除附件
  FOR task_record IN 
    SELECT t.id AS task_id, t.project_id, t.attachments, p.owner_id
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.attachments IS NOT NULL 
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    -- 检查每个附件
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      -- 如果附件有 deletedAt 字段且已过期
      IF attachment->>'deletedAt' IS NOT NULL 
         AND (attachment->>'deletedAt')::TIMESTAMPTZ < cutoff_date THEN
        -- 构建存储路径
        attachment_path := task_record.owner_id || '/' || 
                          task_record.project_id || '/' || 
                          task_record.task_id || '/' || 
                          (attachment->>'id') || '.' || 
                          COALESCE(
                            SUBSTRING((attachment->>'name') FROM '\.([^.]+)$'),
                            'bin'
                          );
        paths_to_delete := array_append(paths_to_delete, attachment_path);
        total_deleted := total_deleted + 1;
      END IF;
    END LOOP;
    
    -- 更新任务，移除过期的已删除附件
    UPDATE tasks
    SET attachments = (
      SELECT jsonb_agg(att)
      FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NULL 
         OR (att->>'deletedAt')::TIMESTAMPTZ >= cutoff_date
    )
    WHERE id = task_record.task_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(task_record.attachments) AS att
        WHERE att->>'deletedAt' IS NOT NULL 
          AND (att->>'deletedAt')::TIMESTAMPTZ < cutoff_date
      );
  END LOOP;
  
  RETURN QUERY SELECT total_deleted, paths_to_delete;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. 创建定期清理的触发器（可选，也可以通过 Edge Function 调用）
-- 注意：PostgreSQL 不支持定时任务，需要通过外部调度器（如 pg_cron 扩展或 Edge Function）

COMMENT ON FUNCTION cleanup_deleted_attachments IS '清理过期的软删除附件。返回删除的附件数量和需要从 Storage 中删除的路径列表。';

-- 4. 授权
GRANT EXECUTE ON FUNCTION cleanup_deleted_attachments TO service_role;
