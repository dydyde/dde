# supabase/migrations/archive

此目录用于归档已整合进「统一初始化脚本」的历史迁移文件。

## 为什么归档

NanoFlow 早期通过大量增量迁移逐步完善数据库对象（RLS、索引、tombstone、防复活、purge、病毒扫描、审计日志等）。

为了降低新用户部署门槛，现在推荐通过以下方式初始化：

- 在 Supabase SQL Editor 一次性执行：`scripts/init-supabase.sql`

因此，原 `supabase/migrations/` 中的历史迁移文件被移动到本目录保留，便于：

- 回溯历史变更
- 对比/排查线上数据库对象差异
- 参考单个迁移的设计意图

## 仍保留在 migrations 根目录的文件

- `rpc-integration-tests.sql`
  - 用途：RPC 集成测试脚本（不属于迁移、不会被整合）。

## 注意

- 如果你在使用 Supabase CLI 的迁移流程（`supabase db push` / `supabase migration up`），请确认你的工作流是否依赖这些历史迁移。
- 对新建项目：建议直接用 `scripts/init-supabase.sql` 一次性初始化。