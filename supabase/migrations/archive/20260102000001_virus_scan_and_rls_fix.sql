-- ============================================
-- 病毒扫描表 + cleanup_logs RLS 修复
-- 版本: v5.12
-- ============================================

-- ============================================
-- 1. 创建病毒扫描记录表
-- ============================================

-- 存储文件扫描结果
CREATE TABLE IF NOT EXISTS public.attachment_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id UUID NOT NULL,
  file_hash VARCHAR(64), -- SHA-256 哈希
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  threat_name VARCHAR(255),
  threat_description TEXT,
  scanner VARCHAR(50) NOT NULL DEFAULT 'clamav',
  engine_version VARCHAR(50),
  signature_version VARCHAR(50),
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- 约束
  CONSTRAINT valid_status CHECK (status IN ('pending', 'scanning', 'clean', 'threat_detected', 'failed', 'quarantined', 'skipped'))
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_id ON public.attachment_scans(file_id);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_status ON public.attachment_scans(status);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_scanned_at ON public.attachment_scans(scanned_at);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_hash ON public.attachment_scans(file_hash);

-- 启用 RLS
ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问扫描记录
-- 前端通过 Edge Function 间接访问
DROP POLICY IF EXISTS "attachment_scans_service_only" ON public.attachment_scans;
CREATE POLICY "attachment_scans_service_only" ON public.attachment_scans
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- 隔离区表（可选，用于存储被隔离的恶意文件信息）
CREATE TABLE IF NOT EXISTS public.quarantined_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_file_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  threat_name VARCHAR(255) NOT NULL,
  threat_description TEXT,
  quarantined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  quarantined_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMP WITH TIME ZONE,
  restored BOOLEAN DEFAULT FALSE,
  restored_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quarantined_files_expires_at ON public.quarantined_files(expires_at);
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问隔离区
DROP POLICY IF EXISTS "quarantined_files_service_only" ON public.quarantined_files;
CREATE POLICY "quarantined_files_service_only" ON public.quarantined_files
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 2. 修复 cleanup_logs RLS（仅 service_role 可访问）
-- 问题：当前策略 USING(true) 允许任意认证用户读写日志
-- ============================================

-- 删除旧的宽松策略
DROP POLICY IF EXISTS "cleanup_logs select" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs insert" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs_select_policy" ON public.cleanup_logs;

-- 创建新的限制性策略：仅 service_role 可访问
-- 这意味着普通用户无法直接访问日志，只能通过 Edge Function
CREATE POLICY "cleanup_logs_service_role_select" ON public.cleanup_logs
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY "cleanup_logs_service_role_insert" ON public.cleanup_logs
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "cleanup_logs_service_role_delete" ON public.cleanup_logs
  FOR DELETE TO service_role
  USING (true);

-- ============================================
-- 3. 定期清理过期扫描记录的函数
-- ============================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_scan_records()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- 删除 30 天前的扫描记录（保留威胁检测记录更长时间）
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '30 days'
    AND status NOT IN ('threat_detected', 'quarantined');
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- 删除 90 天前的威胁检测记录
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;
  
  -- 删除过期的隔离文件记录
  DELETE FROM public.quarantined_files
  WHERE expires_at < NOW() AND restored = FALSE;
  
  GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;
  
  -- 记录清理日志
  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', deleted_count,
    'cleaned_at', NOW()
  ));
  
  RETURN deleted_count;
END;
$$;

-- ============================================
-- 4. 更新触发器
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION public.update_attachment_scans_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_attachment_scans_timestamp ON public.attachment_scans;
CREATE TRIGGER trg_update_attachment_scans_timestamp
  BEFORE UPDATE ON public.attachment_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.update_attachment_scans_timestamp();

-- ============================================
-- 5. 授予权限
-- ============================================

-- service_role 完全访问
GRANT ALL ON public.attachment_scans TO service_role;
GRANT ALL ON public.quarantined_files TO service_role;

-- 普通用户无直接访问权限（通过 Edge Function）
REVOKE ALL ON public.attachment_scans FROM authenticated;
REVOKE ALL ON public.quarantined_files FROM authenticated;

-- 函数执行权限
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
