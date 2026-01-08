-- 乐观锁强化：版本冲突从警告改为拒绝
-- 
-- 变更说明：
-- 1. 修改 check_version_increment() 函数，启用严格模式
-- 2. 版本回退时直接抛出异常，拒绝更新
-- 3. 记录到 circuit_breaker_logs 以便调试

CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在版本号存在且被修改时检查
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    -- 检测版本回退
    IF NEW.version < OLD.version THEN
      -- 记录版本回退事件到 circuit_breaker_logs
      BEGIN
        INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
        VALUES (
          auth.uid(),
          'version_regression',
          true,  -- 已阻止
          'Version regression detected and blocked',
          jsonb_build_object(
            'table', TG_TABLE_NAME,
            'record_id', NEW.id,
            'old_version', OLD.version,
            'new_version', NEW.version,
            'timestamp', NOW()
          )
        );
      EXCEPTION WHEN OTHERS THEN
        -- 日志记录失败不应影响主流程
        NULL;
      END;
      
      -- 严格模式：拒绝版本回退
      RAISE EXCEPTION 'Version regression not allowed: % -> % (table: %, id: %)', 
        OLD.version, NEW.version, TG_TABLE_NAME, NEW.id
        USING ERRCODE = 'P0001'; -- raise_exception
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 确保触发器存在于 projects 表
DROP TRIGGER IF EXISTS check_version_increment ON public.projects;
CREATE TRIGGER check_version_increment
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_version_increment();

-- 为 tasks 表添加版本检查（如果有 version 字段）
-- 注意：tasks 表可能没有 version 字段，需要根据实际情况调整
DO $$
BEGIN
  -- 检查 tasks 表是否有 version 列
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'tasks' 
    AND column_name = 'version'
  ) THEN
    DROP TRIGGER IF EXISTS check_version_increment ON public.tasks;
    CREATE TRIGGER check_version_increment
      BEFORE UPDATE ON public.tasks
      FOR EACH ROW
      EXECUTE FUNCTION public.check_version_increment();
  END IF;
END $$;

COMMENT ON FUNCTION public.check_version_increment IS 'Strict optimistic lock: rejects version regression instead of just warning. Logs to circuit_breaker_logs.';
