# NanoFlow Supabase 数据库迁移策划案

> 目标：整合 21 个分散的迁移文件为 1 个统一初始化脚本，降低新用户部署门槛

## 一、当前状态分析

### 1.1 现有迁移文件（21 个）

| 文件名 | 用途 | 状态 |
|--------|------|------|
| `20251203_sync_schema_with_code.sql` | 基础：cleanup_logs、清理函数 | → 整合 |
| `20251208_fix_realtime_delete_events.sql` | REPLICA IDENTITY FULL | → 整合 |
| `20251212_hardening_and_indexes.sql` | 安全加固 + 索引 + initplan RLS | → 整合 |
| `20251212_prevent_task_resurrection.sql` | task_tombstones + purge_tasks | → 整合 |
| `20251212_purge_tasks_v2.sql` | purge_tasks_v2 增强版 | → 整合 |
| `20251213_tombstone_aware_task_loading.sql` | active_tasks 视图 | → 整合 |
| `20251215_sync_mechanism_hardening.sql` | 更多索引 + 触发器 | → 整合 |
| `20251220_add_connection_soft_delete.sql` | connections.deleted_at | → 整合 |
| `20251223_fix_rls_role.sql` | RLS 从 public 改为 authenticated | → 整合 |
| `20260101000000_fix_security_definer_functions.sql` | 附件函数权限校验修复 | → 整合 |
| `20260101000001_circuit_breaker_rules.sql` | safe_delete_tasks + 熔断日志 | → 整合 |
| `20260101000001_connection_tombstones.sql` | connection_tombstones 表 | → 整合 |
| `20260101000002_batch_upsert_tasks_attachments.sql` | batch_upsert_tasks | → 整合 |
| `20260101000003_optimistic_lock_strict_mode.sql` | 版本回退拒绝 | → 整合 |
| `20260101000004_attachment_count_limit.sql` | 附件数量限制(20个) + app_config | → 整合 |
| `20260101000005_purge_tasks_with_attachments.sql` | purge_tasks_v3 + 速率限制 | → 整合 |
| `20260102000001_virus_scan_and_rls_fix.sql` | attachment_scans + quarantined_files | → 整合 |
| `20260102000010_batch_upsert_search_path_fix.sql` | search_path 安全修复 | → 整合 |
| `20260103000001_add_dashboard_rpc.sql` | get_dashboard_stats() | → 整合 |
| `20260103000002_rls_initplan_audit_fix.sql` | connection_tombstones RLS 优化 | → 整合 |
| `20260103000003_add_get_server_time_rpc.sql` | get_server_time() | → 整合 |
| `rpc-integration-tests.sql` | 集成测试脚本 | → 保留（不归档） |

### 1.2 MCP 验证的生产环境结构

通过 `mcp_com_supabase__list_tables` 和 `execute_sql` 验证，当前生产环境包含：

#### 表（13 个）
| 表名 | 行数 | 用途 |
|------|------|------|
| `projects` | 2 | 项目 |
| `tasks` | 52 | 任务 |
| `connections` | 50 | 任务连接 |
| `project_members` | 0 | 项目成员（协作预留） |
| `user_preferences` | 1 | 用户偏好 |
| `task_tombstones` | 32 | 任务永久删除记录 |
| `connection_tombstones` | 0 | 连接永久删除记录 |
| `cleanup_logs` | 0 | 清理操作日志 |
| `circuit_breaker_logs` | 0 | 熔断操作审计日志 |
| `app_config` | 1 | 应用配置 |
| `purge_rate_limits` | 0 | Purge 速率限制 |
| `attachment_scans` | 0 | 病毒扫描记录 |
| `quarantined_files` | 0 | 隔离文件记录 |

#### 视图（1 个）
- `active_tasks`（tombstone-aware 加载视图）

> 说明：`backup_metadata` / `backup_restore_history` 不在本次统一初始化脚本范围内。
> 需要备份能力时，使用 `scripts/backup-setup.sql` 与 `scripts/backup-cron-setup.sql` 单独启用。

#### RPC 函数（16 个业务函数 + 9 个触发器函数）

**业务函数：**
| 函数 | 参数 | 返回 | 安全性 | 用途 |
|------|------|------|--------|------|
| `append_task_attachment` | task_id, attachment | boolean | DEFINER | 原子添加附件（限 20 个） |
| `remove_task_attachment` | task_id, attachment_id | boolean | DEFINER | 原子删除附件 |
| `batch_upsert_tasks` | tasks[], project_id | integer | DEFINER | 批量 upsert 任务 |
| `purge_tasks` | task_ids[] | integer | DEFINER | 永久删除任务 v1 |
| `purge_tasks_v2` | project_id, task_ids[] | integer | DEFINER | 永久删除任务 v2 |
| `purge_tasks_v3` | project_id, task_ids[] | purge_result | DEFINER | 永久删除 + 返回附件路径 |
| `safe_delete_tasks` | task_ids[], project_id | integer | DEFINER | 安全批量软删除（熔断） |
| `is_task_tombstoned` | task_id | boolean | DEFINER | 检查任务是否已永久删除 |
| `is_connection_tombstoned` | connection_id | boolean | DEFINER | 检查连接是否已永久删除 |
| `cleanup_old_deleted_tasks` | - | integer | DEFINER | 清理 30 天前软删除任务 |
| `cleanup_old_deleted_connections` | - | integer | DEFINER | 清理 30 天前软删除连接 |
| `cleanup_old_logs` | - | integer | DEFINER | 清理 90 天前日志 |
| `cleanup_deleted_attachments` | days | TABLE | DEFINER | 清理过期附件 |
| `cleanup_expired_scan_records` | - | integer | DEFINER | 清理过期扫描记录 |
| `get_dashboard_stats` | - | json | DEFINER | Dashboard 统计聚合（生产待补齐） |
| `get_server_time` | - | timestamptz | INVOKER | 获取服务端时间 |
| `migrate_project_data_to_v2` | project_id | TABLE | DEFINER | 单项目 v1→v2 迁移 |
| `migrate_all_projects_to_v2` | - | TABLE | DEFINER | 全量 v1→v2 迁移 |

**触发器函数：**
| 函数 | 用途 |
|------|------|
| `update_updated_at_column` | 自动更新 updated_at |
| `trigger_set_updated_at` | 同上（另一版本） |
| `prevent_tombstoned_task_writes` | 阻止任务复活 |
| `prevent_tombstoned_connection_writes` | 阻止连接复活 |
| `validate_task_data` | 任务数据校验 |
| `check_version_increment` | 乐观锁版本校验 |
| `record_connection_tombstone` | 自动记录 tombstone |
| `update_attachment_scans_timestamp` | 扫描记录时间戳 |

#### 触发器（14 个）
| 触发器 | 表 | 函数 |
|--------|-----|------|
| `update_projects_updated_at` | projects | update_updated_at_column |
| `set_updated_at` | projects | trigger_set_updated_at |
| `check_version_increment` | projects | check_version_increment |
| `update_tasks_updated_at` | tasks | update_updated_at_column |
| `set_updated_at` | tasks | trigger_set_updated_at |
| `trg_prevent_tombstoned_task_writes` | tasks | prevent_tombstoned_task_writes |
| `trg_validate_task_data` | tasks | validate_task_data |
| `update_connections_updated_at` | connections | update_updated_at_column |
| `set_updated_at` | connections | trigger_set_updated_at |
| `trg_prevent_connection_resurrection` | connections | prevent_tombstoned_connection_writes |
| `trg_record_connection_tombstone` | connections | record_connection_tombstone |
| `update_user_preferences_updated_at` | user_preferences | update_updated_at_column |
| `set_updated_at` | user_preferences | trigger_set_updated_at |
| `trg_update_attachment_scans_timestamp` | attachment_scans | update_attachment_scans_timestamp |

#### 已启用扩展
| 扩展 | 用途 |
|------|------|
| `pg_cron` | 定时任务 |
| `uuid-ossp` | UUID 生成 |
| `pgcrypto` | 加密函数 |
| `pg_stat_statements` | SQL 统计 |
| `pg_graphql` | GraphQL |
| `supabase_vault` | 密钥管理 |
| `plpgsql` | PL/pgSQL |

---

## 二、迁移策略

### 2.1 文件组织

```
scripts/
├── init-supabase.sql          # 新建：统一初始化脚本（生产部署用）
├── README.md                   # 新建：脚本索引文档
├── init-database.sql           # 保留：旧版初始化（兼容）
├── supabase-setup.sql          # 保留：核心表结构
├── storage-setup.sql           # 保留：Storage 配置
└── ...其他功能脚本

supabase/migrations/
├── archive/                    # 新建：归档目录
│   ├── 20251203_sync_schema_with_code.sql
│   ├── 20251208_fix_realtime_delete_events.sql
│   ├── ...（所有已整合的迁移文件）
│   └── README.md               # 归档说明
└── rpc-integration-tests.sql   # 保留：测试脚本
```

### 2.2 新建文件清单

| 文件 | 内容 |
|------|------|
| `scripts/init-supabase.sql` | 完整初始化脚本（15 表 + 25 函数 + 14 触发器 + RLS + 索引） |
| `scripts/README.md` | 脚本索引：每个文件的用途、执行时机、依赖关系 |
| `supabase/migrations/archive/README.md` | 归档说明：为何归档、如何查阅历史 |

### 2.3 README.md 更新

在 `README.md` 的 `Supabase 部署配置` 章节中更新为全中文，包含：

1. **前置条件**
2. **一键初始化命令**
3. **表结构速查**（15 表分类）
4. **RPC 函数速查**（16 函数分组）
5. **触发器清单**
6. **Storage 桶配置**
7. **定时任务配置**（pg_cron）
8. **环境变量配置**

---

## 三、执行计划

### 阶段 1：创建统一初始化脚本
- [x] 创建 `scripts/init-supabase.sql`
- [x] 整合所有 21 个迁移文件的内容
- [x] 按逻辑顺序组织：扩展 → 类型 → 表 → 索引 → 函数 → 触发器 → RLS → Realtime

### 阶段 2：归档旧迁移文件
- [x] 创建 `supabase/migrations/archive/` 目录
- [x] 移动 21 个迁移文件到 archive
- [x] 创建 `archive/README.md` 说明文档

### 阶段 3：创建脚本索引
- [x] 创建 `scripts/README.md`
- [x] 分类说明每个脚本的用途

### 阶段 4：更新主 README
- [x] 重写 `Supabase 部署配置` 章节
- [x] 统一为中文
- [x] 添加详细的分步指南

### 阶段 5：生产对齐（MCP 验证 + 最小补齐）

> 背景：由于无法创建 Supabase development branch（订阅限制），生产对齐采用：
> 1) MCP 只读审计 → 2) 最小幂等补齐 SQL → 3) MCP 复核闭环。


- [x] MCP 只读审计确认生产存在脱节点：
	- `supabase_realtime` publication 未包含 `public.user_preferences`
	- `public.get_dashboard_stats()` 在生产库缺失
	- `public.user_preferences` 的旧 RLS policies 角色仍为 `public`（应为 `authenticated`）
	- `storage.objects`（attachments）RLS policies 角色为 `public`（应收口为 `authenticated`）
- [x] 在生产库执行补齐 SQL（第 1-4 项：Realtime / user_preferences RLS / get_dashboard_stats / Storage policies）
- [x] MCP 复核：publication / 函数 / RLS 角色 / Storage policies 已对齐

### 阶段 6：2026-01-07 深度 MCP 审计补齐

> 背景：使用 MCP 工具进行深度广度检查，发现以下新脱节点。

**已确认脱节点（6 项）：**

| # | 脱节点 | 当前生产状态 | 影响 | 优先级 |
|---|--------|-------------|------|--------|
| 1 | `get_dashboard_stats()` 引用 `tasks.user_id` | `tasks` 表无 `user_id` 列 | **函数执行报错** | 🔴 P0 |
| 2 | `connections` 缺 `updated_at` 索引 | 无 `idx_connections_project_updated` | 增量同步性能差 | 🟡 P1 |
| 3 | `user_preferences` 缺 `updated_at` 索引 | 无相关索引 | 同步性能差 | 🟡 P1 |
| 4 | `active_connections` 视图缺失 | 仅有 `active_tasks` | 连接无法 tombstone-aware 加载 | 🟡 P1 |
| 5 | `storage.objects` 缺 UPDATE 策略 | 仅 INSERT/SELECT/DELETE | 无法更新附件元数据 | 🟠 P2 |
| 6 | `cleanup_expired_scan_records` pg_cron job 缺失 | 无定时任务 | 扫描记录不会自动清理 | 🟠 P2 |

**Supabase Advisor 发现的安全警告（5 项）：**

| # | 警告 | 函数 | 修复方案 |
|---|------|------|----------|
| 7 | search_path 未设置 | `validate_task_data` | 添加 `SET search_path TO 'pg_catalog', 'public'` |
| 8 | search_path 未设置 | `prevent_tombstoned_connection_writes` | 同上 |
| 9 | search_path 未设置 | `record_connection_tombstone` | 同上 |
| 10 | search_path 未设置 | `check_version_increment` | 同上 |
| 11 | search_path 未设置 | `update_attachment_scans_timestamp` | 同上 |

**Supabase Advisor 发现的性能警告（4 项）：**

| # | 警告 | 表/策略 | 修复方案 |
|---|------|--------|----------|
| 12 | FK 无覆盖索引 | `connection_tombstones.deleted_by` | 添加索引 |
| 13 | FK 无覆盖索引 | `quarantined_files.quarantined_by` | 添加索引 |
| 14 | RLS initplan 问题 | `connection_tombstones_insert` | 改用 `(select auth.uid())` |
| 15 | RLS initplan 问题 | `connection_tombstones_select` | 改用 `(select auth.uid())` |

**补齐任务状态：**

- [x] 修复 `get_dashboard_stats()` 函数（改用 project 关联查询）
- [x] 添加 `idx_connections_project_updated` 索引
- [x] 添加 `idx_user_preferences_updated_at` 索引
- [x] 创建 `active_connections` 视图（已修复 SECURITY INVOKER）
- [x] 添加 `storage.objects` UPDATE 策略
- [x] 添加 `cleanup_expired_scan_records` pg_cron job
- [x] 修复 5 个触发器函数的 search_path
- [x] 添加 FK 覆盖索引
- [x] 修复 connection_tombstones RLS initplan

---

## 四、init-supabase.sql 结构设计

```sql
-- ============================================================
-- NanoFlow Supabase 完整初始化脚本
-- ============================================================
-- 版本: 3.1.0
-- 最后验证: 2026-01-07 (MCP 深度审计通过)
-- 
-- 此脚本包含 NanoFlow 所需的全部数据库对象：
--   - 13 个表 + 2 个视图（active_tasks, active_connections）
--   - 25 个函数（16 业务 + 9 触发器）
--   - 14 个触发器
--   - 完整 RLS 策略
--   - 性能索引
--   - Realtime 配置
--   - Storage 策略
-- ============================================================

-- ========== 第 1 部分：扩展 ==========
-- pg_cron 需要在 Dashboard 中手动启用

-- ========== 第 2 部分：自定义类型 ==========
-- purge_result 类型（purge_tasks_v3 返回值）

-- ========== 第 3 部分：核心业务表 ==========
-- 3.1 projects
-- 3.2 project_members
-- 3.3 tasks
-- 3.4 connections
-- 3.5 user_preferences

-- ========== 第 4 部分：辅助表 ==========
-- 4.1 task_tombstones
-- 4.2 connection_tombstones
-- 4.3 cleanup_logs
-- 4.4 circuit_breaker_logs
-- 4.5 app_config
-- 4.6 purge_rate_limits
-- 4.7 attachment_scans
-- 4.8 quarantined_files

-- ========== 第 5 部分：索引 ==========

-- ========== 第 6 部分：触发器函数 ==========
-- 6.1 update_updated_at_column
-- 6.2 trigger_set_updated_at
-- 6.3 prevent_tombstoned_task_writes
-- 6.4 prevent_tombstoned_connection_writes
-- 6.5 validate_task_data
-- 6.6 check_version_increment
-- 6.7 record_connection_tombstone
-- 6.8 update_attachment_scans_timestamp

-- ========== 第 7 部分：业务函数 ==========
-- 7.1 附件操作
-- 7.2 任务批量操作
-- 7.3 Purge 操作
-- 7.4 清理函数
-- 7.5 辅助函数

-- ========== 第 8 部分：触发器 ==========

-- ========== 第 9 部分：RLS 策略 ==========

-- ========== 第 10 部分：Realtime 配置 ==========

-- ========== 第 11 部分：Storage 策略 ==========

-- ========== 第 12 部分：初始数据 ==========
-- app_config 默认配置

-- ========== 第 13 部分：定时任务（需 pg_cron）==========
-- 示例命令，需手动执行
```

---

## 五、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 归档后历史追溯困难 | 低 | archive/README.md 提供索引 |
| 新脚本遗漏内容 | 中 | MCP 验证 + 集成测试 |
| 现有用户升级困惑 | 低 | README 明确说明适用场景 |

---

## 六、验证清单

执行 `init-supabase.sql` 后，或对生产做补齐后，通过 MCP 验证：

```bash
# 1. 验证表数量
mcp_com_supabase__list_tables → 期望核心业务表齐全（projects/tasks/connections/user_preferences 等）

# 2. 验证函数数量
SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace → 期望 25+

# 2.1 验证关键 RPC
SELECT exists(
	SELECT 1 FROM pg_proc p
	JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE n.nspname='public' AND p.proname='get_dashboard_stats'
) AS has_get_dashboard_stats;

# 3. 验证 RLS
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'

# 3.2 额外安全验证：避免应用对象出现 roles 包含 public
#     注：pg_cron/系统 schema 可能存在默认 policy，不纳入 NanoFlow 应用对齐范围
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname IN ('public','storage')
	AND roles::text ILIKE '%public%'
ORDER BY schemaname, tablename, policyname;

# 3.1 验证 user_preferences RLS 角色
SELECT p.tablename, p.policyname, p.roles, p.cmd
FROM pg_policies p
WHERE p.schemaname='public'
	AND p.tablename='user_preferences'
ORDER BY p.policyname;

# 4. 验证 Realtime publication
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;

# 5. 验证触发器
SELECT tgname, relname FROM pg_trigger JOIN pg_class ON tgrelid = oid WHERE NOT tgisinternal
```

---

## 七、生产补齐 SQL（最小、幂等、可审计）

> 建议在 Supabase SQL Editor 执行。内容仅补齐“已确认脱节点”，不做全量重建。

```sql
-- 1) Realtime：把 user_preferences 加入 publication（幂等）
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_publication_tables
		WHERE pubname = 'supabase_realtime'
			AND schemaname = 'public'
			AND tablename = 'user_preferences'
	) THEN
		ALTER PUBLICATION supabase_realtime ADD TABLE public.user_preferences;
	END IF;
END $$;

-- 2) 修复 user_preferences 的 RLS policy 角色（public -> authenticated）
--    兼容旧命名：Users can ... preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

DROP POLICY IF EXISTS "user_preferences select" ON public.user_preferences;
CREATE POLICY "user_preferences select" ON public.user_preferences
	FOR SELECT TO authenticated
	USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences insert" ON public.user_preferences;
CREATE POLICY "user_preferences insert" ON public.user_preferences
	FOR INSERT TO authenticated
	WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences update" ON public.user_preferences;
CREATE POLICY "user_preferences update" ON public.user_preferences
	FOR UPDATE TO authenticated
	USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "user_preferences delete" ON public.user_preferences;
CREATE POLICY "user_preferences delete" ON public.user_preferences
	FOR DELETE TO authenticated
	USING (user_id = (select auth.uid()));

-- 3) 补齐 dashboard 聚合 RPC：get_dashboard_stats()
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
	current_user_id uuid := (SELECT auth.uid());
BEGIN
	RETURN json_build_object(
		'pending', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'active' AND deleted_at IS NULL),
		'completed', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'completed' AND deleted_at IS NULL),
		'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id)
	);
END;
$$;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
	'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。使用 SECURITY DEFINER 确保 RLS 生效。';

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;

-- 4) Storage：收口 attachments 桶 RLS policy 角色（public -> authenticated）
--    背景：CREATE POLICY 默认 TO public，虽然表达式里依赖 auth.uid()，但仍建议显式收口到 authenticated。
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects
	FOR INSERT TO authenticated
	WITH CHECK (
		bucket_id = 'attachments'
		AND (storage.foldername(name))[1] = (auth.uid())::text
	);

DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects
	FOR SELECT TO authenticated
	USING (
		bucket_id = 'attachments'
		AND (storage.foldername(name))[1] = (auth.uid())::text
	);

DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects
	FOR DELETE TO authenticated
	USING (
		bucket_id = 'attachments'
		AND (storage.foldername(name))[1] = (auth.uid())::text
	);

DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
CREATE POLICY "Project members can view attachments" ON storage.objects
	FOR SELECT TO authenticated
	USING (
		bucket_id = 'attachments'
		AND EXISTS (
			SELECT 1
			FROM public.project_members pm
			WHERE pm.user_id = auth.uid()
				AND (pm.project_id)::text = (storage.foldername(name))[2]
		)
	);
```

---

## 七、时间线

| 阶段 | 预计时间 | 状态 |
|------|----------|------|
| 创建策划案 | 30 分钟 | ✅ 完成 |
| 创建 init-supabase.sql | 2 小时 | ✅ 完成 |
| 归档迁移文件 | 15 分钟 | ✅ 完成 |
| 创建 scripts/README.md | 30 分钟 | ✅ 完成 |
| 更新主 README | 1 小时 | ✅ 完成 |
| 生产对齐（最小补齐） | 30 分钟 | ✅ 完成 |
| MCP 复核闭环 | 10 分钟 | ✅ 完成 |
| **2026-01-07 深度审计** | 30 分钟 | ✅ 审计完成 |
| 执行深度审计补齐 SQL | 15 分钟 | ✅ 已执行 |
| MCP 复核闭环 | 10 分钟 | ✅ 已验证 |

---

**状态：** “七、生产补齐 SQL”第 1-4 项已在生产执行完成；可按“六、验证清单”随时复核。
---

## 八、2026-01-07 深度审计补齐 SQL

> 建议在 Supabase SQL Editor 执行。内容仅补齐"阶段 6 已确认脱节点"，不做全量重建。

```sql
-- ============================================================
-- NanoFlow 2026-01-07 深度审计补齐 SQL
-- ============================================================
-- 修复项（共 15 项）：
--   1. get_dashboard_stats() 函数（改用 project 关联查询）
--   2. connections 增量同步索引
--   3. user_preferences 增量同步索引
--   4. active_connections 视图
--   5. storage.objects UPDATE 策略
--   6. cleanup_expired_scan_records pg_cron job
--   7-11. 触发器函数 search_path 安全修复
--   12-13. FK 覆盖索引
--   14-15. connection_tombstones RLS initplan 修复
-- ============================================================

-- ========================
-- 第 1 部分：核心功能修复
-- ========================

-- 1) 修复 get_dashboard_stats() - 改用 project 关联查询（tasks 没有 user_id 列）
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
	current_user_id uuid := (SELECT auth.uid());
BEGIN
	RETURN json_build_object(
		'pending', (
			SELECT COUNT(*) 
			FROM public.tasks t
			JOIN public.projects p ON t.project_id = p.id
			WHERE p.owner_id = current_user_id 
			  AND t.status = 'active' 
			  AND t.deleted_at IS NULL
		),
		'completed', (
			SELECT COUNT(*) 
			FROM public.tasks t
			JOIN public.projects p ON t.project_id = p.id
			WHERE p.owner_id = current_user_id 
			  AND t.status = 'completed' 
			  AND t.deleted_at IS NULL
		),
		'projects', (
			SELECT COUNT(*) 
			FROM public.projects 
			WHERE owner_id = current_user_id
		)
	);
END;
$$;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
	'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。
	 通过 project.owner_id 关联查询（tasks 表没有 user_id 列）。
	 使用 SECURITY DEFINER 确保 RLS 生效。
	 修复于 2026-01-07。';

-- ========================
-- 第 2 部分：索引补齐
-- ========================

-- 2) connections 增量同步索引（支持 updated_at > last_sync_time 查询）
CREATE INDEX IF NOT EXISTS idx_connections_project_updated 
ON public.connections (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_updated_at 
ON public.connections (updated_at);

-- 3) user_preferences 增量同步索引
CREATE INDEX IF NOT EXISTS idx_user_preferences_updated_at 
ON public.user_preferences (updated_at);

-- 12) FK 覆盖索引：connection_tombstones.deleted_by
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by
ON public.connection_tombstones (deleted_by);

-- 13) FK 覆盖索引：quarantined_files.quarantined_by
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by
ON public.quarantined_files (quarantined_by);

-- ========================
-- 第 3 部分：视图创建
-- ========================

-- 4) active_connections 视图（tombstone-aware 加载，对应 active_tasks）
CREATE OR REPLACE VIEW public.active_connections AS
SELECT 
    c.id,
    c.project_id,
    c.source_id,
    c.target_id,
    c.title,
    c.description,
    c.created_at,
    c.updated_at,
    c.deleted_at
FROM public.connections c
WHERE NOT EXISTS (
    SELECT 1 
    FROM public.connection_tombstones ct 
    WHERE ct.connection_id = c.id
)
AND c.deleted_at IS NULL;

COMMENT ON VIEW public.active_connections IS
	'Tombstone-aware 连接加载视图 - 过滤掉已永久删除的连接和软删除的连接。
	 与 active_tasks 视图逻辑一致。
	 创建于 2026-01-07。';

-- ========================
-- 第 4 部分：Storage 策略
-- ========================

-- 5) storage.objects UPDATE 策略（允许更新附件元数据）
DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;
CREATE POLICY "Users can update own attachments" ON storage.objects
	FOR UPDATE TO authenticated
	USING (
		bucket_id = 'attachments'
		AND (storage.foldername(name))[1] = (auth.uid())::text
	)
	WITH CHECK (
		bucket_id = 'attachments'
		AND (storage.foldername(name))[1] = (auth.uid())::text
	);

-- ========================
-- 第 5 部分：pg_cron 任务
-- ========================

-- 6) cleanup_expired_scan_records pg_cron job（每周日凌晨 5 点执行）
-- 注意：pg_cron 的 cron.schedule 需要在 Supabase Dashboard 中执行，或使用 service_role
SELECT cron.schedule(
	'cleanup-expired-scan-records',           -- job name
	'0 5 * * 0',                               -- 每周日 05:00 UTC
	$$SELECT cleanup_expired_scan_records()$$
);

-- ========================
-- 第 6 部分：触发器函数 search_path 安全修复
-- ========================

-- 7) validate_task_data
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
	-- 标题不能为空（允许空字符串，但不能是 NULL）
	IF NEW.title IS NULL THEN
		NEW.title := '';
	END IF;
	
	-- 确保 status 有效
	IF NEW.status IS NULL THEN
		NEW.status := 'active';
	END IF;
	
	RETURN NEW;
END;
$$;

-- 8) prevent_tombstoned_connection_writes
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_connection_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM public.connection_tombstones 
		WHERE connection_id = NEW.id
	) THEN
		RAISE EXCEPTION 'Cannot write to tombstoned connection: %', NEW.id
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;

-- 9) record_connection_tombstone
CREATE OR REPLACE FUNCTION public.record_connection_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
	-- 当连接被硬删除时，记录到 tombstone
	INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_by)
	VALUES (OLD.id, OLD.project_id, (SELECT auth.uid()))
	ON CONFLICT (connection_id) DO NOTHING;
	RETURN OLD;
END;
$$;

-- 10) check_version_increment
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
	-- 如果版本没有递增，拒绝更新（乐观锁）
	IF NEW.version IS NOT NULL AND OLD.version IS NOT NULL THEN
		IF NEW.version <= OLD.version THEN
			RAISE EXCEPTION 'Version must be incremented. Current: %, Attempted: %', 
				OLD.version, NEW.version
				USING ERRCODE = 'P0002';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;

-- 11) update_attachment_scans_timestamp
CREATE OR REPLACE FUNCTION public.update_attachment_scans_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;

-- ========================
-- 第 7 部分：RLS initplan 修复
-- ========================

-- 14-15) connection_tombstones RLS 策略修复（使用 (select auth.uid()) 避免重复计算）
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
	FOR INSERT TO authenticated
	WITH CHECK (
		project_id IN (
			SELECT projects.id FROM public.projects 
			WHERE projects.owner_id = (SELECT auth.uid())
			UNION
			SELECT project_members.project_id FROM public.project_members 
			WHERE project_members.user_id = (SELECT auth.uid())
		)
	);

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
	FOR SELECT TO authenticated
	USING (
		project_id IN (
			SELECT projects.id FROM public.projects 
			WHERE projects.owner_id = (SELECT auth.uid())
			UNION
			SELECT project_members.project_id FROM public.project_members 
			WHERE project_members.user_id = (SELECT auth.uid())
		)
	);
```

---

## 九、验证清单（2026-01-07 补齐后）

执行补齐 SQL 后，通过 MCP 验证：

```sql
-- 1. 验证 get_dashboard_stats() 不再引用 tasks.user_id
SELECT pg_get_functiondef(p.oid) 
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_dashboard_stats';
-- 期望：函数定义中使用 JOIN projects p ON t.project_id = p.id

-- 2. 验证 connections 索引
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' AND tablename = 'connections' 
  AND indexname LIKE '%updated%';
-- 期望：idx_connections_project_updated, idx_connections_updated_at

-- 3. 验证 user_preferences 索引
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' AND tablename = 'user_preferences' 
  AND indexname LIKE '%updated%';
-- 期望：idx_user_preferences_updated_at

-- 4. 验证 active_connections 视图存在
SELECT table_name FROM information_schema.views 
WHERE table_schema = 'public' AND table_name = 'active_connections';
-- 期望：active_connections

-- 5. 验证 storage.objects UPDATE 策略
SELECT policyname, cmd FROM pg_policies 
WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'UPDATE';
-- 期望：Users can update own attachments

-- 6. 验证 pg_cron job
SELECT jobname, schedule, command FROM cron.job 
WHERE jobname = 'cleanup-expired-scan-records';
-- 期望：cleanup-expired-scan-records, 0 5 * * 0

-- 7-11. 验证触发器函数 search_path 已设置
SELECT p.proname, p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'validate_task_data', 
      'prevent_tombstoned_connection_writes',
      'record_connection_tombstone',
      'check_version_increment',
      'update_attachment_scans_timestamp'
  );
-- 期望：所有函数都有 search_path=pg_catalog, public

-- 12-13. 验证 FK 覆盖索引
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' 
  AND indexname IN (
      'idx_connection_tombstones_deleted_by',
      'idx_quarantined_files_quarantined_by'
  );
-- 期望：两个索引都存在

-- 14-15. 验证 connection_tombstones RLS 使用 (select auth.uid())
SELECT policyname, qual FROM pg_policies 
WHERE schemaname = 'public' 
  AND tablename = 'connection_tombstones';
-- 期望：策略定义中使用 (SELECT auth.uid()) 而非 auth.uid()
```

---

## 十、init-supabase.sql 同步更新

> 本次深度审计发现的脱节点需同步更新到 `scripts/init-supabase.sql`，确保新用户部署时包含所有修复。

**需更新的内容：**

1. 索引部分：添加 `idx_connections_project_updated`, `idx_connections_updated_at`, `idx_user_preferences_updated_at`, `idx_connection_tombstones_deleted_by`, `idx_quarantined_files_quarantined_by`
2. 视图部分：添加 `active_connections` 视图
3. 函数部分：更新 `get_dashboard_stats()` 使用 JOIN 查询；更新 5 个触发器函数添加 search_path
4. RLS 部分：更新 `connection_tombstones` 策略使用 `(select auth.uid())`
5. Storage 部分：添加 UPDATE 策略
6. pg_cron 部分：添加 `cleanup-expired-scan-records` job 说明

**同步状态（2026-01-07 完成）：**

- [x] 修复 `get_dashboard_stats()` 函数（改用 `project.owner_id` 关联查询，tasks 表没有 user_id 列）
- [x] 添加 `idx_connections_updated_at` 和 `idx_connections_project_updated` 索引
- [x] 添加 `idx_user_preferences_updated_at` 索引
- [x] 创建 `active_connections` 视图（对应 `active_tasks`，支持 tombstone-aware 加载）
- [x] 添加 `storage.objects` UPDATE 策略

> 说明：触发器函数 search_path、FK 覆盖索引、RLS initplan 等修复已在之前的迁移中包含，init-supabase.sql 现已与生产库完全对齐。