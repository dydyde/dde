-- NanoFlow v2 迁移完成清理脚本
-- 
-- ⚠️ 警告：此脚本会永久删除数据，请在运行前确保：
-- 1. 已完成所有数据迁移（migrate-to-v2.sql）
-- 2. 已验证迁移结果无误
-- 3. 所有前端代码已切换到使用 tasks/connections 表
-- 4. 已备份数据库
--
-- 使用方法：
-- 在 Supabase SQL 编辑器中逐步运行以下部分

-- ============================================
-- 0. 迁移前检查（必须全部通过才能继续）
-- ============================================

-- 检查是否所有项目都已迁移
DO $$
DECLARE
  unmigrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unmigrated_count
  FROM public.projects
  WHERE migrated_to_v2 = FALSE OR migrated_to_v2 IS NULL;
  
  IF unmigrated_count > 0 THEN
    RAISE EXCEPTION '❌ 还有 % 个项目未迁移！请先运行 migrate-to-v2.sql', unmigrated_count;
  ELSE
    RAISE NOTICE '✅ 所有项目已迁移';
  END IF;
END $$;

-- 检查 tasks 表是否有数据
DO $$
DECLARE
  task_count INTEGER;
  project_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO task_count FROM public.tasks;
  SELECT COUNT(*) INTO project_count FROM public.projects;
  
  IF task_count = 0 AND project_count > 0 THEN
    RAISE EXCEPTION '❌ tasks 表为空但存在项目！迁移可能未完成';
  ELSE
    RAISE NOTICE '✅ tasks 表有 % 条记录', task_count;
  END IF;
END $$;

-- 检查是否有孤儿任务
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.tasks t
  WHERE t.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tasks p 
    WHERE p.id = t.parent_id AND p.project_id = t.project_id
  );
  
  IF orphan_count > 0 THEN
    RAISE WARNING '⚠️ 发现 % 个孤儿任务，建议检查数据完整性', orphan_count;
  ELSE
    RAISE NOTICE '✅ 无孤儿任务';
  END IF;
END $$;

-- 检查是否有无效连接
DO $$
DECLARE
  invalid_conn_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_conn_count
  FROM public.connections c
  WHERE NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = c.source_id)
     OR NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = c.target_id);
  
  IF invalid_conn_count > 0 THEN
    RAISE WARNING '⚠️ 发现 % 个无效连接，建议检查数据完整性', invalid_conn_count;
  ELSE
    RAISE NOTICE '✅ 无无效连接';
  END IF;
END $$;

-- ============================================
-- 1. 数据对比报告（运行此部分查看迁移前后对比）
-- ============================================

-- 统计 JSONB 中的数据量
SELECT 
  'JSONB data 列统计' as description,
  p.id as project_id,
  p.title,
  COALESCE(jsonb_array_length(p.data->'tasks'), 0) as jsonb_tasks,
  COALESCE(jsonb_array_length(p.data->'connections'), 0) as jsonb_connections,
  (SELECT COUNT(*) FROM public.tasks t WHERE t.project_id = p.id) as v2_tasks,
  (SELECT COUNT(*) FROM public.connections c WHERE c.project_id = p.id) as v2_connections
FROM public.projects p
WHERE p.data IS NOT NULL;

-- ============================================
-- 2. 创建数据备份表（可选但强烈推荐）
-- ============================================

-- 备份 projects 表的 data 列
CREATE TABLE IF NOT EXISTS public.projects_data_backup AS
SELECT id, title, data, updated_at, NOW() as backed_up_at
FROM public.projects
WHERE data IS NOT NULL;

-- 添加注释
COMMENT ON TABLE public.projects_data_backup IS '迁移前 projects.data JSONB 列的备份，可在确认迁移无误后删除';

SELECT '✅ 备份已创建: projects_data_backup 表' as status;

-- ============================================
-- 3. 清理步骤（⚠️ 危险操作，请确认备份已完成）
-- ============================================

-- 步骤 3.1: 删除迁移函数
DROP FUNCTION IF EXISTS migrate_project_data_to_v2(UUID);
DROP FUNCTION IF EXISTS migrate_all_projects_to_v2();

SELECT '✅ 迁移函数已删除' as status;

-- 步骤 3.2: 删除 data 列（⚠️ 不可逆操作！）
-- 取消注释以下行来执行

-- ALTER TABLE public.projects DROP COLUMN IF EXISTS data;
-- SELECT '✅ data 列已删除' as status;

-- 步骤 3.3: 删除迁移标记列（在 data 列删除后执行）
-- 取消注释以下行来执行

-- ALTER TABLE public.projects DROP COLUMN IF EXISTS migrated_to_v2;
-- SELECT '✅ migrated_to_v2 列已删除' as status;

-- ============================================
-- 4. 验证清理结果
-- ============================================

-- 查看 projects 表当前结构
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'projects'
ORDER BY ordinal_position;

-- 查看当前数据统计
SELECT 
  (SELECT COUNT(*) FROM public.projects) as projects,
  (SELECT COUNT(*) FROM public.tasks) as tasks,
  (SELECT COUNT(*) FROM public.connections) as connections;

-- ============================================
-- 5. 清理备份表（可选，在确认一切正常后执行）
-- ============================================

-- 如果确认迁移成功且运行稳定（建议等待 1-2 周），可删除备份表
-- 取消注释以下行来执行

-- DROP TABLE IF EXISTS public.projects_data_backup;
-- SELECT '✅ 备份表已删除' as status;

-- ============================================
-- 完成！
-- ============================================
-- 清理完成后，数据库结构应该是：
-- 
-- projects 表：
--   - id, owner_id, title, description, created_date, updated_at, version
-- 
-- tasks 表：
--   - id, project_id, parent_id, title, content, stage, order, rank, status, ...
-- 
-- connections 表：
--   - id, project_id, source_id, target_id, description
--
-- 所有数据访问都通过这些表进行，不再使用 JSONB 列

