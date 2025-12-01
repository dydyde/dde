-- NanoFlow 完整数据库设置 v2.0
-- 在 Supabase SQL 编辑器中运行此脚本
--
-- 版本更新说明：
-- v2.0: 重构为独立表结构（tasks, connections），解决 JSONB 并发问题
--       新增 project_members 表预留协作功能
--       新增服务端时间戳触发器和回收站自动清理
--
-- 安全说明:
-- 所有表都启用了 Row Level Security (RLS)
-- 策略确保用户只能访问自己的数据
-- 使用 auth.uid() 函数获取当前登录用户的 ID
-- 
-- 重要：确保在生产环境中：
-- 1. RLS 已启用 (ALTER TABLE ... ENABLE ROW LEVEL SECURITY)
-- 2. 所有策略都正确创建 (CREATE POLICY)
-- 3. 不要使用 service_role key 在前端代码中
-- 4. 前端只使用 anon key，配合 RLS 保护数据

-- ============================================
-- 0. 辅助函数：自动更新 updated_at 时间戳
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 1. 项目表 (projects) - 先创建表，RLS 策略稍后添加
-- ============================================

-- 如果表不存在则创建
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  -- 保留 data 列用于向后兼容，新数据将存储在独立表中
  data JSONB DEFAULT '{}'::jsonb,
  -- 标记是否已迁移到新表结构
  migrated_to_v2 BOOLEAN DEFAULT FALSE
);

-- 添加新列（针对已有表的情况）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'projects' 
    AND column_name = 'version'
  ) THEN
    ALTER TABLE public.projects ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'projects' 
    AND column_name = 'migrated_to_v2'
  ) THEN
    ALTER TABLE public.projects ADD COLUMN migrated_to_v2 BOOLEAN DEFAULT FALSE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'projects' 
    AND column_name = 'data'
  ) THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- 创建 updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 启用行级安全策略 (RLS)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON public.projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON public.projects(updated_at);

-- ============================================
-- 2. 项目成员表 (project_members) - 必须在 projects RLS 策略之前创建
-- ============================================

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  -- 每个用户在每个项目中只能有一个角色
  UNIQUE(project_id, user_id)
);

-- 启用 RLS
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON public.project_members(user_id);

-- ============================================
-- 3. 现在创建 projects 表的 RLS 策略（project_members 已存在）
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;
DROP POLICY IF EXISTS "member select" ON public.projects;

-- 创建新策略 - 支持项目成员访问
CREATE POLICY "owner select" ON public.projects
  FOR SELECT USING (
    auth.uid() = owner_id 
    OR EXISTS (
      SELECT 1 FROM public.project_members 
      WHERE project_id = projects.id AND user_id = auth.uid()
    )
  );

CREATE POLICY "owner insert" ON public.projects
  FOR INSERT WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "owner update" ON public.projects
  FOR UPDATE USING (
    auth.uid() = owner_id
    OR EXISTS (
      SELECT 1 FROM public.project_members 
      WHERE project_id = projects.id 
      AND user_id = auth.uid() 
      AND role IN ('editor', 'admin')
    )
  );

CREATE POLICY "owner delete" ON public.projects
  FOR DELETE USING (auth.uid() = owner_id);

-- ============================================
-- 4. project_members 表的 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members update" ON public.project_members;
DROP POLICY IF EXISTS "project_members delete" ON public.project_members;

-- 创建策略
-- 成员可以查看自己所属项目的成员列表
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = project_members.project_id 
      AND p.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm 
      WHERE pm.project_id = project_members.project_id 
      AND pm.user_id = auth.uid()
    )
  );

-- 只有项目所有者或管理员可以添加成员
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = project_members.project_id 
      AND p.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm 
      WHERE pm.project_id = project_members.project_id 
      AND pm.user_id = auth.uid() 
      AND pm.role = 'admin'
    )
  );

-- 只有项目所有者可以修改成员角色
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = project_members.project_id 
      AND p.owner_id = auth.uid()
    )
  );

-- 项目所有者可以删除任何成员，成员可以退出
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = project_members.project_id 
      AND p.owner_id = auth.uid()
    )
  );

-- ============================================
-- 5. 任务表 (tasks) - 独立存储
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

-- 创建 updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_tasks_updated_at ON public.tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 启用 RLS
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- 删除旧策略
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

-- 创建策略 - 基于项目权限
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = tasks.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
    )
  );

CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = tasks.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id 
          AND pm.user_id = auth.uid() 
          AND pm.role IN ('editor', 'admin')
        )
      )
    )
  );

CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = tasks.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id 
          AND pm.user_id = auth.uid() 
          AND pm.role IN ('editor', 'admin')
        )
      )
    )
  );

CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = tasks.project_id 
      AND p.owner_id = auth.uid()
    )
  );

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON public.tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_stage ON public.tasks(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON public.tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_short_id ON public.tasks(project_id, short_id);

-- ============================================
-- 6. 连接表 (connections) - 独立存储
-- ============================================

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 防止重复连接
  UNIQUE(project_id, source_id, target_id)
);

-- 创建 updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 启用 RLS
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

-- 删除旧策略
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

-- 创建策略 - 基于项目权限
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = connections.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
    )
  );

CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = connections.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id 
          AND pm.user_id = auth.uid() 
          AND pm.role IN ('editor', 'admin')
        )
      )
    )
  );

CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = connections.project_id 
      AND (
        p.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id 
          AND pm.user_id = auth.uid() 
          AND pm.role IN ('editor', 'admin')
        )
      )
    )
  );

CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.projects p 
      WHERE p.id = connections.project_id 
      AND p.owner_id = auth.uid()
    )
  );

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_connections_project_id ON public.connections(project_id);
CREATE INDEX IF NOT EXISTS idx_connections_source_id ON public.connections(source_id);
CREATE INDEX IF NOT EXISTS idx_connections_target_id ON public.connections(target_id);

-- ============================================
-- 7. 用户偏好设置表 (user_preferences)
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

-- 创建 updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 启用行级安全策略 (RLS)
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（如果存在）
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

-- 创建策略
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE USING (auth.uid() = user_id);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences(user_id);

-- ============================================
-- 8. 附件存储配置 (Supabase Storage)
-- ============================================

-- 创建附件存储桶（如果不存在）
-- 注意：这需要在 Supabase Dashboard 中手动创建，或通过 API
-- INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false)
-- ON CONFLICT (id) DO NOTHING;

-- Storage RLS 策略（在 Supabase Dashboard 中配置）
-- 用户只能上传到自己项目的文件夹
-- 路径格式: {user_id}/{project_id}/{task_id}/{filename}

-- ============================================
-- 9. 清理日志表 (cleanup_logs)
-- ============================================

CREATE TABLE IF NOT EXISTS public.cleanup_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 启用 RLS（仅服务端可访问）
ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs(type);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs(created_at);

-- 自动清理超过 30 天的日志
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.cleanup_logs 
    WHERE created_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. 回收站自动清理函数
-- ============================================

-- 创建清理函数
CREATE OR REPLACE FUNCTION cleanup_old_deleted_tasks()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- 删除超过 30 天的软删除任务
  WITH deleted AS (
    DELETE FROM public.tasks 
    WHERE deleted_at IS NOT NULL 
    AND deleted_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 注意：自动执行需要 pg_cron 扩展
-- 在 Supabase Dashboard > Database > Extensions 中启用 pg_cron
-- 然后运行以下命令设置定时任务：
--
-- SELECT cron.schedule(
--   'cleanup-deleted-tasks',
--   '0 3 * * *',  -- 每天凌晨 3 点执行
--   $$SELECT cleanup_old_deleted_tasks()$$
-- );
--
-- SELECT cron.schedule(
--   'cleanup-old-logs',
--   '0 4 * * *',  -- 每天凌晨 4 点执行
--   $$SELECT cleanup_old_logs()$$
-- );

-- ============================================
-- 11. 启用实时订阅
-- ============================================

DO $$
BEGIN
  -- Projects 表
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'projects'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
  
  -- Tasks 表
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  
  -- Connections 表
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'connections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
END $$;

-- ============================================
-- 12. RLS 验证查询（可选）
-- ============================================

-- 验证 RLS 是否启用
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';

-- 验证策略是否创建
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
-- FROM pg_policies 
-- WHERE schemaname = 'public';

-- ============================================
-- 13. 附加脚本说明
-- ============================================
-- 
-- 以下脚本需要单独运行：
--
-- 📎 attachment-rpc.sql
--    用途：附件操作的原子 RPC 函数（append_task_attachment, remove_task_attachment）
--    时机：在本脚本运行后执行
--    说明：提供并发安全的附件添加/删除操作
--
-- 📦 storage-setup.sql  
--    用途：配置 Supabase Storage bucket 用于附件上传
--    时机：在本脚本运行后执行
--
-- 🔄 migrate-to-v2.sql
--    用途：从旧版 JSONB 结构迁移数据到独立表
--    时机：仅在升级旧版数据库时执行
--
-- 🧹 cleanup-v1-data.sql
--    用途：清理迁移后的旧数据
--    时机：确认迁移成功后执行

-- ============================================
-- 完成！
-- ============================================
-- 运行后，你的数据库将支持：
-- 1. 独立的任务和连接表，支持细粒度并发更新
-- 2. 服务端自动维护 updated_at 时间戳，确保冲突检测准确性
-- 3. 项目成员表预留，支持未来的团队协作功能
-- 4. 回收站自动清理（需要启用 pg_cron）
-- 5. 附件存储配置预留
-- 6. 实时订阅支持任务级别的变更通知
--
-- 安全检查清单：
-- ✓ RLS 已在所有用户数据表上启用
-- ✓ 所有 CRUD 操作都有对应的策略
-- ✓ 策略使用 auth.uid() 验证用户身份
-- ✓ 项目成员访问权限已配置
-- ✓ 前端代码只使用 anon key
