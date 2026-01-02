-- NanoFlow 服务端备份系统数据库设置
-- 版本: 1.0.0
-- 日期: 2026-01-01
-- 描述: 创建备份元数据表、存储 bucket 和相关权限

-- ===========================================
-- 1. 创建备份元数据表
-- ===========================================

CREATE TABLE IF NOT EXISTS backup_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 备份类型
  type TEXT NOT NULL CHECK (type IN ('full', 'incremental')),
  
  -- 存储路径（对象存储中的路径）
  path TEXT NOT NULL UNIQUE,
  
  -- 备份范围（null = 全用户）
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- 备份统计
  project_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  connection_count INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  
  -- 文件信息
  size_bytes BIGINT NOT NULL DEFAULT 0,
  compressed BOOLEAN NOT NULL DEFAULT true,
  encrypted BOOLEAN NOT NULL DEFAULT false,
  
  -- 完整性校验
  checksum TEXT NOT NULL, -- SHA-256 hash
  checksum_algorithm TEXT NOT NULL DEFAULT 'SHA-256',
  
  -- 加密信息（如果加密）
  encryption_algorithm TEXT, -- e.g., 'AES-256-GCM'
  encryption_key_id TEXT,    -- 用于多版本密钥管理
  
  -- 健康校验结果
  validation_passed BOOLEAN NOT NULL DEFAULT true,
  validation_warnings JSONB DEFAULT '[]'::jsonb,
  
  -- 时间戳
  backup_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_completed_at TIMESTAMPTZ,
  
  -- 增量备份相关
  base_backup_id UUID REFERENCES backup_metadata(id) ON DELETE SET NULL,
  incremental_since TIMESTAMPTZ, -- updated_at > this time
  
  -- 保留策略
  expires_at TIMESTAMPTZ,
  retention_tier TEXT CHECK (retention_tier IN ('hourly', 'daily', 'weekly', 'monthly')),
  
  -- 状态
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'expired')),
  error_message TEXT,
  
  -- 元数据
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_backup_metadata_type ON backup_metadata(type);
CREATE INDEX idx_backup_metadata_status ON backup_metadata(status);
CREATE INDEX idx_backup_metadata_created_at ON backup_metadata(created_at DESC);
CREATE INDEX idx_backup_metadata_expires_at ON backup_metadata(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_backup_metadata_user_id ON backup_metadata(user_id) WHERE user_id IS NOT NULL;

-- 更新触发器
CREATE OR REPLACE FUNCTION update_backup_metadata_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backup_metadata_updated_at
  BEFORE UPDATE ON backup_metadata
  FOR EACH ROW
  EXECUTE FUNCTION update_backup_metadata_updated_at();

-- ===========================================
-- 2. 创建备份恢复历史表
-- ===========================================

CREATE TABLE IF NOT EXISTS backup_restore_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 关联的备份
  backup_id UUID NOT NULL REFERENCES backup_metadata(id) ON DELETE CASCADE,
  
  -- 执行恢复的用户
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 恢复配置
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'merge')),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'project')),
  project_id UUID, -- 如果 scope = 'project'
  
  -- 恢复前快照
  pre_restore_snapshot_id UUID REFERENCES backup_metadata(id) ON DELETE SET NULL,
  
  -- 恢复统计
  projects_restored INTEGER NOT NULL DEFAULT 0,
  tasks_restored INTEGER NOT NULL DEFAULT 0,
  connections_restored INTEGER NOT NULL DEFAULT 0,
  
  -- 状态
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
  error_message TEXT,
  
  -- 时间戳
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_restore_history_user_id ON backup_restore_history(user_id);
CREATE INDEX idx_backup_restore_history_backup_id ON backup_restore_history(backup_id);
CREATE INDEX idx_backup_restore_history_created_at ON backup_restore_history(created_at DESC);

-- ===========================================
-- 3. 创建加密密钥元数据表（用于密钥轮换）
-- ===========================================

CREATE TABLE IF NOT EXISTS backup_encryption_keys (
  id TEXT PRIMARY KEY, -- e.g., 'key_v1', 'key_v2'
  
  -- 密钥状态
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  
  -- 创建和过期时间
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deprecated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  
  -- 算法信息
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  
  -- 备注
  notes TEXT
);

-- ===========================================
-- 4. RLS 策略
-- ===========================================

-- 启用 RLS
ALTER TABLE backup_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_restore_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_encryption_keys ENABLE ROW LEVEL SECURITY;

-- backup_metadata: 仅 service_role 可访问
-- 普通用户通过 Edge Function 间接访问

-- 管理员/Service Role 可以访问所有备份元数据
CREATE POLICY backup_metadata_service_role_all ON backup_metadata
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- 用户可以查看自己的备份（如果有用户级备份）
CREATE POLICY backup_metadata_user_select ON backup_metadata
  FOR SELECT
  USING (user_id = auth.uid());

-- backup_restore_history: 用户可以查看自己的恢复历史
CREATE POLICY backup_restore_history_user_select ON backup_restore_history
  FOR SELECT
  USING (user_id = auth.uid());

-- backup_restore_history: Service Role 可以管理所有恢复历史
CREATE POLICY backup_restore_history_service_role_all ON backup_restore_history
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- backup_encryption_keys: 仅 service_role 可访问
CREATE POLICY backup_encryption_keys_service_role_all ON backup_encryption_keys
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- ===========================================
-- 5. 创建备份存储 bucket
-- ===========================================

-- 创建私有 bucket 用于存储备份文件
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'backups',
  'backups',
  false, -- 私有
  524288000, -- 500MB 限制
  ARRAY['application/json', 'application/gzip', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- 存储策略：仅 service_role 可以操作备份 bucket
CREATE POLICY backups_service_role_all ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'backups' 
    AND auth.jwt()->>'role' = 'service_role'
  )
  WITH CHECK (
    bucket_id = 'backups'
    AND auth.jwt()->>'role' = 'service_role'
  );

-- ===========================================
-- 6. 辅助函数
-- ===========================================

-- 获取最新的完成备份
CREATE OR REPLACE FUNCTION get_latest_completed_backup(backup_type TEXT DEFAULT 'full')
RETURNS backup_metadata
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
BEGIN
  RETURN (
    SELECT *
    FROM backup_metadata
    WHERE type = backup_type
      AND status = 'completed'
    ORDER BY backup_completed_at DESC
    LIMIT 1
  );
END;
$$;

-- 标记过期备份
CREATE OR REPLACE FUNCTION mark_expired_backups()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE backup_metadata
  SET status = 'expired'
  WHERE status = 'completed'
    AND expires_at IS NOT NULL
    AND expires_at < now();
  
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

-- 获取备份统计
CREATE OR REPLACE FUNCTION get_backup_stats()
RETURNS TABLE (
  total_backups BIGINT,
  completed_backups BIGINT,
  failed_backups BIGINT,
  total_size_bytes BIGINT,
  latest_full_backup TIMESTAMPTZ,
  latest_incremental_backup TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_backups,
    COUNT(*) FILTER (WHERE status = 'completed')::BIGINT AS completed_backups,
    COUNT(*) FILTER (WHERE status = 'failed')::BIGINT AS failed_backups,
    COALESCE(SUM(size_bytes) FILTER (WHERE status = 'completed'), 0)::BIGINT AS total_size_bytes,
    MAX(backup_completed_at) FILTER (WHERE type = 'full' AND status = 'completed') AS latest_full_backup,
    MAX(backup_completed_at) FILTER (WHERE type = 'incremental' AND status = 'completed') AS latest_incremental_backup
  FROM backup_metadata;
END;
$$;

-- ===========================================
-- 7. 清理过期备份文件的存储过程
-- ===========================================

-- 注意：此函数标记过期备份，实际文件删除由 Edge Function 处理
-- 因为 PostgreSQL 无法直接删除 Storage bucket 中的文件
CREATE OR REPLACE FUNCTION cleanup_expired_backups()
RETURNS TABLE (
  expired_count INTEGER,
  paths_to_delete TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_expired_count INTEGER;
  v_paths TEXT[];
BEGIN
  -- 收集要删除的路径
  SELECT array_agg(path)
  INTO v_paths
  FROM backup_metadata
  WHERE status = 'completed'
    AND expires_at IS NOT NULL
    AND expires_at < now();
  
  -- 标记为过期
  UPDATE backup_metadata
  SET status = 'expired'
  WHERE status = 'completed'
    AND expires_at IS NOT NULL
    AND expires_at < now();
  
  GET DIAGNOSTICS v_expired_count = ROW_COUNT;
  
  RETURN QUERY SELECT v_expired_count, COALESCE(v_paths, ARRAY[]::TEXT[]);
END;
$$;

-- ===========================================
-- 8. 注释
-- ===========================================

COMMENT ON TABLE backup_metadata IS '备份元数据表，记录所有备份的信息';
COMMENT ON TABLE backup_restore_history IS '备份恢复历史，记录用户的恢复操作';
COMMENT ON TABLE backup_encryption_keys IS '备份加密密钥元数据，用于密钥轮换管理';

COMMENT ON COLUMN backup_metadata.type IS '备份类型：full=全量备份，incremental=增量备份';
COMMENT ON COLUMN backup_metadata.path IS '备份文件在对象存储中的路径';
COMMENT ON COLUMN backup_metadata.checksum IS '备份文件的 SHA-256 校验和';
COMMENT ON COLUMN backup_metadata.retention_tier IS '保留策略级别：hourly=小时级(24h)，daily=天级(7d)，weekly=周级(30d)，monthly=月级(90d)';
COMMENT ON COLUMN backup_metadata.incremental_since IS '增量备份的起始时间点，备份 updated_at > 此时间的记录';

COMMENT ON FUNCTION get_latest_completed_backup IS '获取最新完成的指定类型备份';
COMMENT ON FUNCTION mark_expired_backups IS '标记已过期的备份为 expired 状态';
COMMENT ON FUNCTION get_backup_stats IS '获取备份系统统计信息';
COMMENT ON FUNCTION cleanup_expired_backups IS '清理过期备份，返回需要删除的文件路径';
