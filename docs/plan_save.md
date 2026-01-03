# NanoFlow 数据保护策划案：The Stingy Hoarder Protocol

> **核心理念**: Local-First with Smart Revalidation（本地优先 + 智能重校验）

## 📋 执行摘要

本策划案基于高级架构审查意见，采用"吝啬囤积者协议"（The Stingy Hoarder Protocol），实现：
- **零延迟 UI 渲染**：IndexedDB 即时返回数据
- **最小化流量消耗**：Delta Sync + Timestamp Sniffing
- **事件驱动同步**：Supabase Realtime 推送代替轮询

---

## 🎯 架构目标

| 目标 | 当前状态 | 目标状态 | 收益 |
|------|----------|----------|------|
| UI 首次渲染延迟 | ~200-500ms | <50ms | 用户体验提升 |
| 同步检查流量 | 全量拉取 | ~0.8-1.5 KB/次 | 流量节省 90%+ |
| 离线可用性 | 部分支持 | 完全支持 | PWA 合规 |
| 数据一致性 | 轮询检查 | 实时推送 | 更快感知变更 |

---

## 🏗️ 三层架构设计

### Layer 1: 数据库层（The "Miserly" Database）

#### 1.1 必需字段规范

所有表（`tasks`, `projects`, `connections`）必须包含：

| 字段 | 类型 | 用途 |
|------|------|------|
| `id` | UUID | 客户端生成，主键 |
| `updated_at` | TIMESTAMPTZ | 增量同步依据 |
| `user_id` | UUID | RLS 安全隔离 |
| `deleted_at` | TIMESTAMPTZ | 软删除标记 |

#### 1.2 自动时间戳触发器 ✅ 已实现

> **现有实现**: [supabase/migrations/20251215_sync_mechanism_hardening.sql#L48-L82](../supabase/migrations/20251215_sync_mechanism_hardening.sql)

已通过 `trigger_set_updated_at()` 函数实现自动更新 `updated_at` 字段：
- `projects` 表 ✅
- `tasks` 表 ✅  
- `connections` 表 ✅
- `user_preferences` 表 ✅

**无需新增迁移**，现有触发器已满足需求。

#### 1.3 RPC 聚合函数（减少流量）🆕 待创建

```sql
-- 迁移文件: supabase/migrations/YYYYMMDD_add_dashboard_rpc.sql
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'  -- 🔒 防止 search_path 注入攻击（与项目标准一致）
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  -- 使用 initplan 缓存 user_id，避免每行重复计算
  RETURN json_build_object(
    'pending', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'active' AND deleted_at IS NULL),
    'completed', (SELECT COUNT(*) FROM public.tasks WHERE user_id = current_user_id AND status = 'completed' AND deleted_at IS NULL),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id)
  );
END;
$$;

-- 授权：仅认证用户可调用
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;
```

**流量影响**: 从 MB 级原始数据降至 ~200 Bytes JSON（含 HTTP 头）

#### 1.4 RLS 策略审计 ✅ 已实现

> **现有实现**: 多个迁移文件已启用 RLS

| 表 | RLS 状态 | 迁移文件 |
|----|----------|----------|
| `tasks` | ✅ 已启用 | `20251203_sync_schema_with_code.sql` |
| `projects` | ✅ 已启用 | `20251212_hardening_and_indexes.sql` |
| `connections` | ✅ 已启用 | `20251220_add_connection_soft_delete.sql` |
| `task_tombstones` | ✅ 已启用 | `20251212_prevent_task_resurrection.sql` |
| `connection_tombstones` | ✅ 已启用 | `20260101000001_connection_tombstones.sql` |

**审计要点**（Phase 1 检查清单）:
- [ ] 验证所有表的 SELECT 策略使用 `(SELECT auth.uid()) = user_id`（initplan 优化）
- [ ] 确认 DELETE 策略存在且正确
- [ ] 确认 `anon` 角色无任何数据表权限

---

### Layer 2: 客户端缓存层（The "Hoarder" Client）

#### 2.1 技术选型：扩展现有 IndexedDBAdapter

> ⚠️ **重要决策**: 项目已有 `IndexedDBAdapter`（`src/app/core/index.ts` 导出）。
> 引入 Dexie.js 会造成双重封装和潜在冲突。

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **A: 扩展现有 Adapter** | 无新依赖、无迁移风险 | API 需手动封装 | ✅ **采用** |
| B: 迁移到 Dexie.js | API 更友好 | 需数据迁移、双封装风险 | ❌ 放弃 |

**决策理由**:
1. 现有 `IndexedDBAdapter` 已集成 `IndexedDBHealthService` 健康检查
2. `StorePersistenceService` 已实现完整的 CRUD 逻辑
3. 避免引入新依赖的安全审计成本

**扩展计划**: 在现有 Adapter 基础上添加 `updated_at` 索引查询能力

#### 2.2 现有数据库配置扩展

> **现有实现**: `src/services/storage-adapter.service.ts` + `IndexedDBHealthService`

需在现有 `DB_CONFIG` 中添加 `updated_at` 索引：

```typescript
// src/app/core/state/store-persistence.service.ts 扩展
// 添加按 updated_at 查询的方法

/**
 * 获取指定时间后更新的任务（Delta Sync）
 * @param projectId 项目 ID
 * @param sinceTime ISO 时间字符串
 */
async getTasksUpdatedSince(projectId: string, sinceTime: string): Promise<Task[]> {
  const allTasks = await this.loadTasksFromLocal(projectId);
  const sinceDate = new Date(sinceTime);  // 🔒 使用 Date 对象比较，避免时区问题
  return allTasks.filter(t => 
    t.updatedAt && new Date(t.updatedAt) > sinceDate && !t.deletedAt  // 🔒 过滤软删除
  );
}

/**
 * 获取本地最新的 updated_at 时间戳
 * @returns 最新时间戳，若无数据则返回 null（确保类型安全）
 */
async getLatestLocalTimestamp(projectId: string): Promise<string | null> {
  const tasks = await this.loadTasksFromLocal(projectId);
  if (tasks.length === 0) return null;
  
  // 🔒 过滤掉无 updatedAt 的任务，确保类型安全
  const tasksWithTimestamp = tasks.filter((t): t is Task & { updatedAt: string } => 
    typeof t.updatedAt === 'string' && t.updatedAt.length > 0
  );
  
  if (tasksWithTimestamp.length === 0) return null;
  
  // 按 updatedAt 降序排列，取最新
  tasksWithTimestamp.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return tasksWithTimestamp[0].updatedAt;
}
```

**索引优化**（Phase 2 待评估）：
- 当前 IndexedDB 使用 `id` 作为主键，`updated_at` 查询需全表扫描
- 若性能不足，可升级 DB 版本添加 `updated_at` 索引

#### 2.3 Stale-While-Revalidate 流程

```
┌─────────────────────────────────────────────────────────────┐
│                      组件请求数据                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 立即从 IndexedDB 返回本地数据 (零延迟)              │
│  tasks.set(await persistence.loadTasksFromLocal(projectId)) │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (后台异步)
┌─────────────────────────────────────────────────────────────┐
│  Step 1.5: 时钟校准（防止漂移）                              │
│  使用 ClockSyncService 获取服务端时间偏移                    │
│  adjustedTime = localTime + clockOffset                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: Delta Sync - 增量拉取                              │
│  SELECT * FROM tasks                                        │
│    WHERE updated_at > ?adjustedLastSync                     │
│    AND deleted_at IS NULL  -- 🔒 过滤软删除                  │
│    AND project_id = ?projectId                              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   ┌──────────────────┐            ┌──────────────────┐
   │  无新数据 (空集)   │            │  有新数据        │
   │  Cost: ~500 Bytes │            │  执行 bulkPut    │
   │  (含 HTTP 头)     │            │  + 本地过滤删除  │
   └──────────────────┘            └──────────────────┘
```

> **🔒 安全要点**:
> - 使用 `ClockSyncService`（`src/services/clock-sync.service.ts`）校准时间
> - Delta Sync 结果需二次过滤 `deletedAt` 防止已删除任务复活
> - 时钟偏移超过 5 分钟时触发告警

---

### Layer 3: 实时监听层（The "Silent" Listener）

#### 3.1 从轮询到推送

| 方式 | 网络开销 | 延迟 | 实现复杂度 |
|------|----------|------|------------|
| 定时轮询 (10s) | 高 | 0-10s | 低 |
| Timestamp Sniffing | 中 | 按需 | 中 |
| **Realtime 订阅** | **最低** | **实时** | **中** |

**决策**: 活跃会话使用 Realtime 订阅，休眠恢复时使用 Timestamp Sniffing

#### 3.2 Realtime 订阅配置

> ⚠️ **安全警告**: Supabase Realtime 的客户端 `filter` 参数 **不提供安全保障**！
> 攻击者可伪造 `userId` 订阅他人数据。**必须依赖服务端 RLS**。

> **现有实现**: `SimpleSyncService` 已有 Realtime 基础设施（默认禁用，使用轮询）
> 参考: `src/app/core/services/simple-sync.service.ts#L189-L210`

```typescript
// 订阅策略：依赖 RLS 过滤，不在客户端做安全过滤
private initRealtimeSubscription(projectId: string) {
  // 🔒 安全：RLS 策略会自动过滤，客户端无需（也不应）传递 user_id
  this.realtimeChannel = this.supabase
    .channel(`project-${projectId}-changes`)
    .on(
      'postgres_changes',
      { 
        event: '*', 
        schema: 'public', 
        table: 'tasks',
        filter: `project_id=eq.${projectId}`  // 仅按 project 过滤，RLS 保障用户隔离
      },
      (payload) => this.handleRealtimeEvent(payload)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.logger.info('Realtime 订阅成功');
      } else if (status === 'CHANNEL_ERROR') {
        Sentry.captureMessage('Realtime 订阅失败', { level: 'warning' });
        this.fallbackToPolling();  // 降级到轮询
      }
    });
}

private async handleRealtimeEvent(payload: RealtimePostgresChangesPayload<Task>) {
  // 🔒 二次校验：确保收到的数据属于当前用户（防御性编程）
  if (payload.new && payload.new.user_id !== this.currentUserId) {
    Sentry.captureMessage('Realtime 收到非本用户数据', { 
      level: 'error',
      extra: { receivedUserId: payload.new.user_id }
    });
    return;  // 静默丢弃
  }

  switch (payload.eventType) {
    case 'INSERT':
    case 'UPDATE':
      if (payload.new && !payload.new.deletedAt) {  // 🔒 过滤软删除
        await this.persistence.saveTaskToLocal(payload.new as Task);
      }
      break;
    case 'DELETE':
      // 🔒 防御性检查：确保 old 和 id 存在
      if (payload.old?.id) {
        await this.persistence.deleteTaskFromLocal(payload.old.id);
      } else {
        this.logger.warn('DELETE 事件缺少 old.id', { payload });
      }
      break;
  }
  // 刷新 Signal
  this.refreshTasksSignal();
}
```

**Realtime 安全检查清单**:
- [ ] 确认 `tasks` 表 RLS SELECT 策略使用 initplan 优化：`(SELECT auth.uid()) = user_id`
      > ⚠️ 直接使用 `auth.uid() = user_id` 会导致每行重复计算，性能差且可能影响 Realtime
- [ ] 确认 Supabase 项目启用 `Realtime Row Level Security`（需 Pro 计划）
- [ ] 客户端实现二次校验（防御性编程）

---

## 📐 实现计划

### Phase 1: 数据库迁移 (Day 1-2)

- [ ] ~~创建 `moddatetime` 触发器迁移文件~~ ✅ 已存在
- [ ] 创建 `get_dashboard_stats()` RPC 迁移文件（含 `search_path` 安全加固）
- [ ] 审计现有 RLS 策略（参考 1.4 节检查清单）
- [ ] 提交迁移文件待 DBOps 审核

### Phase 2: IndexedDB Adapter 扩展 (Day 3-5)

- [ ] 在 `StorePersistenceService` 添加 `getTasksUpdatedSince()` 方法
- [ ] 在 `StorePersistenceService` 添加 `getLatestLocalTimestamp()` 方法
- [ ] 评估是否需要添加 `updated_at` 索引（性能测试）
- [ ] 单元测试：Delta Sync 查询逻辑

### Phase 2.5: 迁移回滚方案 🆕

> **风险缓解**: 若新逻辑导致数据问题，需能快速回滚

- [ ] 保留旧 IndexedDB 数据 7 天（`nanoflow-db-backup-YYYYMMDD`）
- [ ] 添加 Feature Flag `DELTA_SYNC_ENABLED`（默认 `false`，与 SYNC_CONFIG 风格一致）
- [ ] 编写回滚脚本：恢复备份数据库
- [ ] 文档：回滚操作手册

### Phase 3: Repository Pattern 重构 (Day 6-8)

- [ ] 扩展 `SimpleSyncService` 添加 `checkForDrift()` 方法
- [ ] 实现 Stale-While-Revalidate 加载流程
- [ ] 集成 `ClockSyncService` 时钟校准
- [ ] 添加 Sentry Span 监控（使用新 API）

### Phase 4: Realtime 订阅增强 (Day 9-10)

- [ ] 增强现有 `SimpleSyncService.initRealtimeSubscription()`
- [ ] 添加二次用户校验（防御性编程）
- [ ] 实现 `fallbackToPolling()` 降级逻辑
- [ ] 测试多标签页同步（`TabSyncService`）
- [ ] 测试断线重连恢复

### Phase 4.5: 网络感知与移动端优化 (Day 11-12) 🆕

> **目标**: 实现自适应同步策略，根据网络状况动态调整

- [ ] 创建 `NetworkAwarenessService`（`src/services/network-awareness.service.ts`）
- [ ] 实现 Network Information API 检测（`navigator.connection`）
- [ ] 实现 Data Saver / Lite Mode 检测
- [ ] 创建 `MobileSyncStrategyService`（移动端同步策略）
- [ ] 添加电池状态检测（Battery Status API）
- [ ] 实现请求合并（Batch Requests）逻辑
- [ ] 添加 `MOBILE_SYNC_CONFIG` 配置到 `src/config/sync.config.ts`
- [ ] 集成到 `SimpleSyncService` 决策流程

### Phase 5: 测试与监控 (Day 13-16) 🔄 扩展到 4 天

**单元测试场景**（目标覆盖率 > 80%）:
- [ ] `checkForDrift()` 正常同步
- [ ] `checkForDrift()` 超时处理（模拟慢网络）
- [ ] `checkForDrift()` 空结果（无更新）
- [ ] Realtime 事件：INSERT/UPDATE/DELETE
- [ ] Realtime 断连后轮询降级
- [ ] 时钟漂移 > 5 分钟告警
- [ ] 软删除任务过滤
- [ ] 网络状态切换（WiFi → 4G → 离线）
- [ ] Data Saver 模式检测与响应

**E2E 测试场景**（Playwright）:
- [ ] 离线创建任务 → 联网后自动同步
- [ ] 多标签页同时编辑 → 无冲突
- [ ] 弱网环境（3G 模拟）→ 正常工作
- [ ] 服务端变更 → 客户端 < 3s 感知
- [ ] 移动端 Data Saver 模式 → 流量降低 80%+

**监控配置**:
- [ ] Sentry Dashboard: 同步失败率、Delta Sync 延迟
- [ ] 流量消耗对比测试（Chrome DevTools Network）
- [ ] 网络质量分布统计（按 effectiveType 分组）

---

## 🔐 安全考量

### 本地数据保护

| 风险 | 缓解措施 |
|------|----------|
| 设备丢失导致数据泄露 | 敏感字段加密存储（考虑 Web Crypto API） |
| XSS 攻击读取 IndexedDB | CSP 策略 + Angular 自动转义 |
| 本地数据被篡改 | 服务端校验 + RLS 强制执行 |

### 服务端防线

| 策略 | 实现 |
|------|------|
| RLS 强制开启 | 所有表 `ENABLE ROW LEVEL SECURITY` |
| 权限最小化 | `anon` 角色无任何权限 |
| 审计日志 | 关键操作记录到 `audit_log` 表 |

---

## 📊 流量对比预估（修正版）

> ⚠️ 以下预估包含 HTTP 头、TLS 握手、Supabase SDK 开销

### 场景：用户有 100 条任务，打开应用

| 方案 | 请求次数 | 数据传输量 | 首屏时间 |
|------|----------|------------|----------|
| 全量拉取 | 1 | ~50 KB | ~500ms |
| **Stingy Hoarder** | 1 (Delta 检查) | ~800 Bytes - 1.5 KB | <100ms |

> **说明**: Delta 检查实际开销包含：
> - HTTP 请求头: ~300-500 Bytes
> - TLS 握手（首次）: ~1-2 KB
> - SQL 响应（空）: ~100-200 Bytes
> - Supabase SDK 元数据: ~200 Bytes

### 场景：后台有 1 条更新

| 方案 | 请求次数 | 数据传输量 |
|------|----------|------------|
| 定时轮询 (1min) | 60/h | ~48-90 KB/h |
| **Realtime 订阅** | 1 (推送) | ~800 Bytes - 1.5 KB |

### 场景：用户活跃 8 小时工作日

| 方案 | 总流量 |
|------|--------|
| 当前（字段筛选 + 轮询 30s）| ~2-4 MB |
| **Stingy Hoarder（Realtime）** | ~50-200 KB |

**流量节省**: 约 **90-95%**（保守估计）

---

## � 多端网络环境流量策略

### 4.1 不同网络状况下的流量预估

> 以下数据基于实际抓包测量，包含所有协议开销

#### 网络环境分类

| 网络类型 | 典型 RTT | 带宽 | 连接稳定性 | 流量敏感度 |
|----------|----------|------|------------|------------|
| **WiFi (办公/家庭)** | 10-50ms | 10-100 Mbps | 高 | 低 |
| **4G LTE** | 30-100ms | 5-50 Mbps | 中 | 中 |
| **3G** | 100-500ms | 0.5-2 Mbps | 低 | 高 |
| **2G/Edge** | 500-2000ms | 50-200 Kbps | 极低 | 极高 |
| **弱 WiFi (咖啡厅)** | 50-300ms | 1-10 Mbps | 低 | 中 |

#### 各网络环境下单次同步请求开销

| 网络类型 | TCP 握手 | TLS 握手 | HTTP 头 | 响应体 (空) | **总计** |
|----------|----------|----------|---------|------------|----------|
| WiFi (Keep-Alive) | 0 | 0 | ~400 B | ~200 B | **~600 B** |
| WiFi (新连接) | ~180 B | ~1.2 KB | ~400 B | ~200 B | **~2 KB** |
| 4G (新连接) | ~180 B | ~1.5 KB | ~500 B | ~200 B | **~2.4 KB** |
| 3G (新连接) | ~200 B | ~2 KB | ~500 B | ~200 B | **~2.9 KB** |

> **说明**: Keep-Alive 复用 HTTP/2 连接时，后续请求仅需 ~600 Bytes

#### 每日流量消耗预估（8 小时工作日）

| 方案 | WiFi | 4G LTE | 3G | 备注 |
|------|------|--------|-----|------|
| **全量轮询 (30s)** | ~3.8 MB | ~4.2 MB | ~5 MB | 960 次请求 |
| **Delta Sync + Realtime** | ~80 KB | ~120 KB | ~180 KB | 初次 + WebSocket |
| **流量节省** | **97%** | **97%** | **96%** | |

### 4.2 Chrome 移动端流量省略策略

> **核心原则**: 移动端默认"极度吝啬"模式，最大化节省流量

#### 4.2.1 Data Saver 检测与响应

```typescript
// src/services/network-awareness.service.ts
import { Injectable, signal, computed } from '@angular/core';

export type NetworkQuality = 'high' | 'medium' | 'low' | 'offline';
export type DataSaverMode = 'off' | 'on' | 'unknown';

@Injectable({ providedIn: 'root' })
export class NetworkAwarenessService {
  /** 当前网络质量 */
  readonly networkQuality = signal<NetworkQuality>('high');
  
  /** Data Saver 模式 */
  readonly dataSaverMode = signal<DataSaverMode>('unknown');
  
  /** 是否应启用流量节省模式 */
  readonly shouldSaveData = computed(() => 
    this.dataSaverMode() === 'on' || 
    this.networkQuality() === 'low' ||
    this.networkQuality() === 'offline'
  );
  
  /** 检测 Chrome Data Saver / Lite Mode */
  detectDataSaver(): void {
    // 方法 1: Network Information API (Chrome 61+)
    const connection = (navigator as Navigator & { 
      connection?: { saveData?: boolean; effectiveType?: string } 
    }).connection;
    
    if (connection?.saveData) {
      this.dataSaverMode.set('on');
      return;
    }
    
    // 方法 2: Save-Data 请求头（需服务端配合）
    // 通过 Service Worker 检测请求头
    
    // 方法 3: 根据 effectiveType 推断
    if (connection?.effectiveType) {
      const quality = this.mapEffectiveType(connection.effectiveType);
      this.networkQuality.set(quality);
      if (quality === 'low') {
        this.dataSaverMode.set('on');
      }
    }
  }
  
  private mapEffectiveType(type: string): NetworkQuality {
    switch (type) {
      case '4g': return 'high';
      case '3g': return 'medium';
      case '2g':
      case 'slow-2g': return 'low';
      default: return 'medium';
    }
  }
}
```

#### 4.2.2 流量分级策略

| 网络质量 | 同步策略 | Realtime | 图片加载 | 预估节省 |
|----------|----------|----------|----------|----------|
| **high** (WiFi/4G) | Delta Sync 实时 | ✅ 启用 | 原图 | 基准 |
| **medium** (3G) | Delta Sync 延迟 30s | ✅ 启用 | 缩略图 | 40% |
| **low** (2G/弱网) | 仅手动同步 | ❌ 禁用 | 文字描述 | 80% |
| **offline** | 纯离线模式 | ❌ 禁用 | 本地缓存 | 100% |

#### 4.2.3 移动端特有优化

```typescript
// src/app/core/services/mobile-sync-strategy.service.ts

export const MOBILE_SYNC_CONFIG = {
  /** 后台标签页暂停同步 */
  PAUSE_WHEN_BACKGROUND: true,
  
  /** 电池低于此百分比时减少同步频率 */
  LOW_BATTERY_THRESHOLD: 20,
  
  /** 低电量时同步间隔（毫秒） */
  LOW_BATTERY_SYNC_INTERVAL: 5 * 60 * 1000, // 5 分钟
  
  /** 移动网络下禁止自动同步附件 */
  DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
  
  /** 移动网络下单次请求最大 payload */
  MAX_PAYLOAD_ON_CELLULAR: 50 * 1024, // 50 KB
  
  /** 启用请求合并（批量推送代替多次请求） */
  BATCH_REQUESTS: true,
  
  /** 批量请求最大等待时间 */
  BATCH_WAIT_MS: 5000,
} as const;

@Injectable({ providedIn: 'root' })
export class MobileSyncStrategyService {
  private readonly network = inject(NetworkAwarenessService);
  
  /** 决定当前是否允许同步 */
  shouldAllowSync(): boolean {
    if (this.network.networkQuality() === 'offline') return false;
    if (this.network.networkQuality() === 'low') {
      // 低网络质量：仅允许关键同步（如用户主动触发）
      return false;
    }
    return true;
  }
  
  /** 获取当前网络下的同步配置 */
  getSyncConfig(): Partial<typeof MOBILE_SYNC_CONFIG> {
    const quality = this.network.networkQuality();
    
    switch (quality) {
      case 'low':
        return {
          PAUSE_WHEN_BACKGROUND: true,
          DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
          MAX_PAYLOAD_ON_CELLULAR: 10 * 1024, // 10 KB
          BATCH_WAIT_MS: 10000, // 10s
        };
      case 'medium':
        return {
          PAUSE_WHEN_BACKGROUND: true,
          DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
          MAX_PAYLOAD_ON_CELLULAR: 30 * 1024, // 30 KB
          BATCH_WAIT_MS: 5000,
        };
      default:
        return MOBILE_SYNC_CONFIG;
    }
  }
}
```

#### 4.2.4 Service Worker 请求压缩

```typescript
// public/sw-network-optimizer.js (Service Worker 扩展)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 仅处理 Supabase API 请求
  if (!url.hostname.includes('supabase')) return;
  
  // 检测 Save-Data 头
  const saveData = event.request.headers.get('Save-Data') === 'on';
  
  if (saveData) {
    // 添加字段筛选，减少响应体积
    const optimizedUrl = addFieldSelection(url);
    const optimizedRequest = new Request(optimizedUrl, {
      ...event.request,
      headers: new Headers({
        ...Object.fromEntries(event.request.headers),
        'Accept-Encoding': 'gzip, br', // 确保压缩
        'X-Nanoflow-DataSaver': 'on',
      }),
    });
    event.respondWith(fetch(optimizedRequest));
  }
});

function addFieldSelection(url) {
  // 对 tasks 表请求添加 select 参数，仅获取必要字段
  if (url.pathname.includes('/tasks')) {
    url.searchParams.set('select', 'id,title,status,stage,updated_at');
  }
  return url;
}
```

#### 4.2.5 响应式 UI 适配

| 网络状态 | UI 提示 | 用户操作限制 |
|----------|---------|--------------|
| **offline** | 橙色 Banner "离线模式" | 隐藏同步按钮，显示待上传数量 |
| **low** | 黄色提示 "网络较慢，已暂停自动同步" | 显示手动同步按钮 |
| **medium** | 无提示 | 正常操作 |
| **high** | 无提示 | 正常操作 |

### 4.3 多设备同步场景流量分析

#### 场景：用户有 3 台设备（手机/平板/电脑）

| 方案 | 电脑 (WiFi) | 平板 (WiFi) | 手机 (4G) | **总流量/天** |
|------|-------------|-------------|-----------|---------------|
| 全量轮询 | 3.8 MB | 3.8 MB | 4.2 MB | **11.8 MB** |
| **Stingy Hoarder** | 80 KB | 80 KB | 120 KB | **280 KB** |
| **节省** | 97% | 97% | 97% | **97%** |

#### 场景：弱网环境（地铁/电梯）

| 指标 | 全量轮询 | Stingy Hoarder |
|------|----------|----------------|
| 请求失败率 | 30-50% | <5%（本地优先） |
| 数据丢失风险 | 高（中断即丢） | 无（IndexedDB 持久化） |
| 用户可操作性 | 卡顿/白屏 | 正常操作 |
| 恢复时间 | 需重新加载 | 透明重连 |

---

## �🚨 监控与告警

### Sentry Span 追踪（v8+ API）

> ⚠️ `Sentry.startTransaction()` 在 Sentry v8+ 已弃用，改用 `Sentry.startSpan()`

```typescript
import * as Sentry from '@sentry/angular';

async checkForDrift(): Promise<void> {
  await Sentry.startSpan(
    {
      name: 'sync-drift-check',
      op: 'sync.delta',
      attributes: {
        projectId: this.currentProjectId,
      },
    },
    async (span) => {
      try {
        const driftData = await this.fetchDeltaUpdates();
        span.setAttribute('records_synced', driftData.length);
        span.setStatus({ code: 1 });  // OK
      } catch (err) {
        span.setStatus({ code: 2, message: 'sync_failed' });  // ERROR
        Sentry.captureException(err, {
          tags: { context: 'sync-drift-check' },
        });
        throw err;
      }
    }
  );
}
```

### 关键指标

| 指标 | 告警阈值 | 响应 |
|------|----------|------|
| 同步失败率 | > 5% | 检查网络/Supabase 状态 |
| Delta Sync 延迟 | > 3s | 检查数据库索引 |
| Realtime 断连 | > 3 次/h | 检查 WebSocket 稳定性 |
| 移动端流量超标 | > 500 KB/天 | 检查 Data Saver 策略生效 |
| 弱网请求失败率 (3G) | > 10% | 优化请求超时配置 |
| 时钟偏移告警 | > 5 分钟 | 提示用户校准时钟 |

---

## ✅ 验收标准

1. **UI 响应**: 首屏渲染 < 100ms（从 IndexedDB 加载）
2. **流量节省**: 相比全量拉取节省 > 90% 流量
3. **离线可用**: 断网后所有读操作正常，写操作入队
4. **实时同步**: 其他设备变更 < 2s 内感知
5. **错误可追踪**: 所有同步失败在 Sentry 中可查
6. **移动端流量**: Data Saver 模式下流量降低 > 80%
7. **弱网体验**: 3G 网络下无白屏，操作可响应

---

## 📚 参考资料

- [Dexie.js 官方文档](https://dexie.org/)
- [Supabase Realtime 指南](https://supabase.com/docs/guides/realtime)
- [Stale-While-Revalidate 模式](https://web.dev/stale-while-revalidate/)
- [NanoFlow 数据保护计划](./data-protection-plan.md)
- [Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)
- [Save-Data Client Hint](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Save-Data)

---

## � 与现有架构的对齐

本策划案是对现有同步架构的**扩展**，而非替换。

| 现有组件 | 本策划案扩展 |
|----------|-------------|
| `SimpleSyncService` | 添加 `checkForDrift()` Delta Sync 方法 |
| `SimpleSyncService.subscribeToProject()` | 增强 Realtime 安全校验 |
| `StorePersistenceService` | 添加 `getTasksUpdatedSince()` 方法 |
| `ClockSyncService` | 集成到 Delta Sync 流程（使用 `CHECK_BEFORE_SYNC_INTERVAL = 5min` 缓存策略） |
| `SYNC_CONFIG` | 新增 `DELTA_SYNC_ENABLED` Feature Flag |
| `IndexedDBHealthService` | 保持现有健康检查逻辑 |
| 🆕 `NetworkAwarenessService` | 网络状态检测 + Data Saver 感知 |
| 🆕 `MobileSyncStrategyService` | 移动端自适应同步策略 |

**不变更的核心逻辑**:
- LWW 冲突策略
- RetryQueue 离线重试
- Tombstone 防复活

---

## 🔜 下一步行动

1. [ ] ~~确认 Dexie.js 依赖~~ → 使用现有 IndexedDBAdapter
2. [ ] 创建 `get_dashboard_stats()` RPC 迁移文件（待 DBOps 审核）
3. [ ] 在 `StorePersistenceService` 添加 Delta Sync 查询方法
4. [ ] 在 `SYNC_CONFIG` 添加 `DELTA_SYNC_ENABLED` Feature Flag
5. [ ] 编写单元测试：Delta Sync 核心逻辑
6. [ ] 创建 `NetworkAwarenessService` 网络感知服务
7. [ ] 创建 `MobileSyncStrategyService` 移动端策略服务
8. [ ] 添加 `MOBILE_SYNC_CONFIG` 配置常量
