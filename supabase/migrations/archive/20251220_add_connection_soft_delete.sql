-- ============================================
-- 为 connections 表添加软删除支持
-- 日期: 2025-12-20
-- 
-- 目的：支持跨树连接的软删除同步
-- 解决问题：在一个设备上删除的连接，在其他设备上会因为同步逻辑问题而"复活"
-- 
-- 解决方案：使用 deleted_at 字段标记软删除状态，而不是物理删除
-- 这样删除操作可以正确同步到所有设备
-- ============================================

-- 1. 为 connections 表添加 deleted_at 列
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 2. 创建索引以加速查询未删除的连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at 
  ON public.connections (deleted_at)
  WHERE deleted_at IS NULL;

-- 3. 创建索引以加速查询需要清理的已删除连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 4. 创建清理过期软删除连接的函数
CREATE OR REPLACE FUNCTION cleanup_old_deleted_connections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- 删除超过 30 天的软删除连接
  WITH deleted AS (
    DELETE FROM connections
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  
  -- 记录清理日志
  IF deleted_count > 0 THEN
    INSERT INTO cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object(
      'deleted_count', deleted_count,
      'cleanup_time', NOW()
    ));
  END IF;
  
  RETURN deleted_count;
END;
$$;

-- 5. 添加注释说明
COMMENT ON COLUMN public.connections.deleted_at IS '软删除时间戳，存在表示已标记删除，等待恢复或永久清理';
