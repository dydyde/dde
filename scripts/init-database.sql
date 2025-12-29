-- ============================================================
-- NanoFlow 数据库初始化脚本 (一次性导入)
-- ============================================================
-- 
-- 用法：在 Supabase SQL Editor 中执行此脚本完成所有数据库配置
-- 
-- 包含：
--   1. 核心表结构 (projects, tasks, connections, user_preferences)
--   2. RLS 安全策略
--   3. 自动更新时间戳触发器
--   4. 附件 RPC 函数
--   5. 定时清理函数
--   6. 实时订阅配置
--   7. Storage 策略
--
-- 版本: 2.1.0
-- 最后更新: 2025-01-01
-- ============================================================

-- ============================================
-- 0. 辅助函数
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 1. 项目表 (projects)
-- ============================================

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  data JSONB DEFAULT '{}'::jsonb,
  migrated_to_v2 BOOLEAN DEFAULT FALSE
);

-- 添加新列（兼容已有表）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'version') THEN
    ALTER TABLE public.projects ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'migrated_to_v2') THEN
    ALTER TABLE public.projects ADD COLUMN migrated_to_v2 BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'data') THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON public.projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON public.projects(updated_at);

-- ============================================
-- 2. 项目成员表 (project_members)
-- ============================================

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(project_id, user_id)
);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON public.project_members(user_id);

-- ============================================
-- 3. 任务表 (tasks)
-- ============================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  stage INTEGER,
  "order" INTEGER DEFAULT 0,
  rank NUMERIC DEFAULT 10000,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  x NUMERIC DEFAULT 0,
  y NUMERIC DEFAULT 0,
  short_id VARCHAR(20),
  priority VARCHAR(20) CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMP WITH TIME ZONE,
  tags JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_tasks_updated_at ON public.tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON public.tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_stage ON public.tasks(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON public.tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_short_id ON public.tasks(project_id, short_id);

-- ============================================
-- 4. 连接表 (connections)
-- ============================================

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(project_id, source_id, target_id)
);

-- 兼容旧表
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'title') THEN
    ALTER TABLE public.connections ADD COLUMN title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.connections ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connections_project_id ON public.connections(project_id);
CREATE INDEX IF NOT EXISTS idx_connections_source_id ON public.connections(source_id);
CREATE INDEX IF NOT EXISTS idx_connections_target_id ON public.connections(target_id);
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at ON public.connections(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup ON public.connections(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================
-- 5. 用户偏好设置表 (user_preferences)
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'default',
  layout_direction VARCHAR(10) DEFAULT 'ltr',
  floating_window_pref VARCHAR(20) DEFAULT 'auto',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences(user_id);

-- ============================================
-- 6. 清理日志表 (cleanup_logs)
-- ============================================

CREATE TABLE IF NOT EXISTS public.cleanup_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs(type);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs(created_at);

-- ============================================
-- 6.1 任务 Tombstone 表 (task_tombstones)
-- 用于永久删除任务后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.task_tombstones (
  task_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id ON public.task_tombstones(project_id);

-- RLS 策略
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;

CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = task_tombstones.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = task_tombstones.project_id AND p.owner_id = auth.uid())
);

-- 防止 tombstone 任务复活的触发器
CREATE OR REPLACE FUNCTION prevent_tombstoned_task_writes()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.task_tombstones WHERE task_id = NEW.id) THEN
    RAISE EXCEPTION 'Task % has been permanently deleted and cannot be restored', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_tombstoned_task_writes ON public.tasks;
CREATE TRIGGER trg_prevent_tombstoned_task_writes
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION prevent_tombstoned_task_writes();

-- ============================================
-- 7. RLS 策略 - Projects
-- ============================================

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects FOR SELECT USING (
  auth.uid() = owner_id OR EXISTS (
    SELECT 1 FROM public.project_members WHERE project_id = projects.id AND user_id = auth.uid()
  )
);
CREATE POLICY "owner insert" ON public.projects FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "owner update" ON public.projects FOR UPDATE USING (
  auth.uid() = owner_id OR EXISTS (
    SELECT 1 FROM public.project_members WHERE project_id = projects.id AND user_id = auth.uid() AND role IN ('editor', 'admin')
  )
);
CREATE POLICY "owner delete" ON public.projects FOR DELETE USING (auth.uid() = owner_id);

-- ============================================
-- 8. RLS 策略 - Project Members
-- ============================================

DROP POLICY IF EXISTS "project_members select" ON public.project_members;
DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members update" ON public.project_members;
DROP POLICY IF EXISTS "project_members delete" ON public.project_members;

CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (
  user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_members.project_id AND pm.user_id = auth.uid())
);
CREATE POLICY "project_members insert" ON public.project_members FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_members.project_id AND pm.user_id = auth.uid() AND pm.role = 'admin')
);
CREATE POLICY "project_members update" ON public.project_members FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
);
CREATE POLICY "project_members delete" ON public.project_members FOR DELETE USING (
  user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 9. RLS 策略 - Tasks
-- ============================================

DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

CREATE POLICY "tasks owner select" ON public.tasks FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "tasks owner insert" ON public.tasks FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "tasks owner update" ON public.tasks FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "tasks owner delete" ON public.tasks FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 10. RLS 策略 - Connections
-- ============================================

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

CREATE POLICY "connections owner select" ON public.connections FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "connections owner insert" ON public.connections FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "connections owner update" ON public.connections FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "connections owner delete" ON public.connections FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 11. RLS 策略 - User Preferences
-- ============================================

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 12. 附件 RPC 函数
-- ============================================

-- 添加附件（原子操作）
CREATE OR REPLACE FUNCTION append_task_attachment(p_task_id UUID, p_attachment JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN RAISE EXCEPTION 'Attachment must have an id'; END IF;
  
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL THEN v_current_attachments := '[]'::JSONB; END IF;
  
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' = v_attachment_id) THEN
    RETURN TRUE;
  END IF;
  
  UPDATE tasks SET attachments = v_current_attachments || p_attachment, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 移除附件（原子操作）
CREATE OR REPLACE FUNCTION remove_task_attachment(p_task_id UUID, p_attachment_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
BEGIN
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN RETURN TRUE; END IF;
  
  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' != p_attachment_id;
  
  UPDATE tasks SET attachments = v_new_attachments, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 授予 authenticated 用户执行权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;

-- ============================================
-- 13. 清理函数
-- ============================================

-- 清理软删除任务（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_tasks()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.tasks WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;

-- 清理旧日志（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.cleanup_logs WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;

-- 清理软删除连接（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_connections()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.connections WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', NOW()));
  END IF;
  
  RETURN deleted_count;
END; $$;

-- 永久删除任务（写入 tombstone + 物理删除）
-- 核心 RPC：防止已删除任务复活
CREATE OR REPLACE FUNCTION purge_tasks_v2(p_project_id UUID, p_task_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.owner_id = auth.uid()
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
END; $$;

GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;

-- 清理过期软删除附件
CREATE OR REPLACE FUNCTION cleanup_deleted_attachments(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count INTEGER, storage_paths TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  paths_to_delete TEXT[] := ARRAY[]::TEXT[];
  task_record RECORD;
  attachment JSONB;
  total_deleted INTEGER := 0;
BEGIN
  cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
  
  FOR task_record IN 
    SELECT t.id AS task_id, t.project_id, t.attachments, p.owner_id
    FROM tasks t JOIN projects p ON t.project_id = p.id
    WHERE t.attachments IS NOT NULL AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments) LOOP
      IF attachment->>'deletedAt' IS NOT NULL AND (attachment->>'deletedAt')::TIMESTAMPTZ < cutoff_date THEN
        paths_to_delete := array_append(paths_to_delete, 
          task_record.owner_id || '/' || task_record.project_id || '/' || task_record.task_id || '/' || (attachment->>'id')
        );
        total_deleted := total_deleted + 1;
      END IF;
    END LOOP;
    
    UPDATE tasks SET attachments = (
      SELECT jsonb_agg(att) FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NULL OR (att->>'deletedAt')::TIMESTAMPTZ >= cutoff_date
    ) WHERE id = task_record.task_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NOT NULL AND (att->>'deletedAt')::TIMESTAMPTZ < cutoff_date
    );
  END LOOP;
  
  RETURN QUERY SELECT total_deleted, paths_to_delete;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION cleanup_deleted_attachments TO service_role;

-- ============================================
-- 14. 配置 REPLICA IDENTITY（Realtime DELETE 事件所需）
-- ============================================

ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- ============================================
-- 15. 启用实时订阅
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'projects') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
END $$;

-- ============================================
-- 16. Storage 策略（attachments 桶）
-- ============================================

-- 用户可以上传自己的附件 (路径格式: {user_id}/{project_id}/{task_id}/{filename})
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以查看自己的附件
DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects FOR SELECT
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以删除自己的附件
DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects FOR DELETE
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 项目成员可以查看附件
DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
CREATE POLICY "Project members can view attachments" ON storage.objects FOR SELECT
USING (bucket_id = 'attachments' AND EXISTS (
  SELECT 1 FROM public.project_members pm WHERE pm.user_id = auth.uid() AND pm.project_id::text = (storage.foldername(name))[2]
));

-- ============================================
-- 完成！
-- ============================================
-- 
-- 数据库表：
--   ✓ projects          - 项目
--   ✓ project_members   - 项目成员（协作预留）
--   ✓ tasks             - 任务（含 deleted_at 软删除）
--   ✓ connections       - 任务连接（含 title, deleted_at）
--   ✓ user_preferences  - 用户偏好
--   ✓ cleanup_logs      - 清理日志
--   ✓ task_tombstones   - 任务永久删除记录（防止复活）
--
-- RPC 函数：
--   ✓ append_task_attachment(task_id, attachment)
--   ✓ remove_task_attachment(task_id, attachment_id)
--   ✓ cleanup_old_deleted_tasks()
--   ✓ cleanup_old_deleted_connections()
--   ✓ cleanup_old_logs()
--   ✓ cleanup_deleted_attachments(retention_days)
--   ✓ purge_tasks_v2(project_id, task_ids)  - 永久删除任务（写入 tombstone）
--
-- 定时任务（需要启用 pg_cron 后手动配置）：
--   SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', $$SELECT cleanup_old_deleted_tasks()$$);
--   SELECT cron.schedule('cleanup-deleted-connections', '0 3 * * *', $$SELECT cleanup_old_deleted_connections()$$);
--   SELECT cron.schedule('cleanup-old-logs', '0 4 * * 0', $$SELECT cleanup_old_logs()$$);
--
-- Storage 桶配置（需要在 Dashboard 中创建）：
--   Name: attachments
--   Public: false
--   File size limit: 10MB
