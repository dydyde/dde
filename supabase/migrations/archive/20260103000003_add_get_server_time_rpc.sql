-- ============================================================
-- 添加 get_server_time RPC 函数
-- ============================================================
-- 
-- 用途：为客户端提供服务端时间，用于时钟偏移检测
-- 被调用：clock-sync.service.ts
-- 
-- 版本: 1.0.0
-- 日期: 2026-01-03
-- ============================================================

-- 创建获取服务端时间的 RPC 函数
-- 返回当前服务端 UTC 时间戳（ISO 8601 格式）
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT NOW();
$$;

-- 授予所有认证用户执行权限
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;

-- 允许匿名用户执行（用于未登录时的时钟检测）
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon;

COMMENT ON FUNCTION public.get_server_time() IS '获取服务端当前时间，用于客户端时钟偏移检测';
