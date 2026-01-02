-- ============================================
-- Connection Tombstone 防复活机制
-- 日期：2026-01-01
-- 
-- 问题背景：
-- - 连接删除后，如果旧客户端尝试同步旧数据，可能导致已删除连接复活
-- - 参考 task_tombstones 实现相同的防复活机制
-- ============================================

-- 创建连接 tombstone 表
CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  connection_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 添加索引优化查询
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project 
  ON public.connection_tombstones(project_id);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_at 
  ON public.connection_tombstones(deleted_at);

-- 表注释
COMMENT ON TABLE public.connection_tombstones IS 
  '连接 Tombstone 表，记录已永久删除的连接，用于防止数据复活';

COMMENT ON COLUMN public.connection_tombstones.connection_id IS '被删除的连接 ID';
COMMENT ON COLUMN public.connection_tombstones.project_id IS '连接所属项目 ID';
COMMENT ON COLUMN public.connection_tombstones.deleted_at IS '删除时间';
COMMENT ON COLUMN public.connection_tombstones.deleted_by IS '执行删除的用户 ID';

-- ==================== RLS 策略 ====================
-- 启用 RLS
ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;

-- 读取策略：用户只能读取自己项目的 tombstone
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

-- 插入策略：用户只能为自己的项目创建 tombstone
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

-- 🔴 关键：不允许删除 tombstone（防复活机制的核心）
-- 不创建 DELETE 策略，这样任何删除操作都会被 RLS 拒绝

-- ==================== 防复活触发器 ====================
-- 防止已 tombstone 的连接被重新插入或更新
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_connection_writes()
RETURNS trigger AS $$
BEGIN
  -- 检查是否存在 tombstone 记录
  IF EXISTS (
    SELECT 1 FROM public.connection_tombstones ct
    WHERE ct.connection_id = NEW.id
  ) THEN
    -- 静默忽略该操作，避免旧客户端数据复活
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 在 connections 表上创建触发器
DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tombstoned_connection_writes();

-- ==================== 自动记录 Tombstone ====================
-- 当连接被永久删除时，自动记录到 tombstone 表
-- 注意：这需要在 purge 操作时调用，而不是软删除

CREATE OR REPLACE FUNCTION public.record_connection_tombstone()
RETURNS trigger AS $$
BEGIN
  -- 只在真正删除时记录（不是软删除）
  IF OLD.deleted_at IS NOT NULL THEN
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_by)
    VALUES (OLD.id, OLD.project_id, auth.uid())
    ON CONFLICT (connection_id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  BEFORE DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.record_connection_tombstone();

-- ==================== 授权 ====================
-- service_role 需要完整权限用于管理操作
GRANT SELECT, INSERT ON public.connection_tombstones TO service_role;
GRANT SELECT, INSERT ON public.connection_tombstones TO authenticated;

-- ==================== 检查函数 ====================
-- 用于客户端检查连接是否已被 tombstone
CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  -- 权限校验：无权访问时返回 false（避免信息泄露）
  IF NOT EXISTS (
    SELECT 1 FROM public.connections c
    JOIN public.projects p ON c.project_id = p.id
    WHERE c.id = p_connection_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    -- 无权访问时返回 false（与连接不存在行为一致）
    RETURN false;
  END IF;
  
  -- 检查是否在 tombstone 表中
  RETURN EXISTS (
    SELECT 1 FROM public.connection_tombstones
    WHERE connection_id = p_connection_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(UUID) TO authenticated;

COMMENT ON FUNCTION public.is_connection_tombstoned(UUID) IS 
  '检查连接是否已被永久删除（带权限校验）。无权访问时返回 false 以避免信息泄露。';
