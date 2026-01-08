-- ============================================
-- 修复 Realtime DELETE 事件问题
-- 日期: 2025-12-08
-- ============================================
--
-- 问题描述:
-- 当在一个设备上删除任务时，其他设备无法接收到删除事件
-- 这是因为表缺少 REPLICA IDENTITY FULL 配置
--
-- 解决方案:
-- 设置 REPLICA IDENTITY FULL 确保 DELETE 事件包含完整的旧行数据
-- 这样客户端可以正确识别被删除的记录

-- 设置 REPLICA IDENTITY FULL
-- 注意：这会增加一些存储开销，但对于确保跨设备同步的正确性是必需的
ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- 验证配置（可选，用于调试）
-- SELECT 
--   n.nspname as schemaname, 
--   c.relname as tablename, 
--   CASE c.relreplident
--     WHEN 'd' THEN 'DEFAULT (primary key)'
--     WHEN 'n' THEN 'NOTHING'
--     WHEN 'f' THEN 'FULL'
--     WHEN 'i' THEN 'INDEX'
--   END as replica_identity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' 
-- AND c.relname IN ('projects', 'tasks', 'connections');
