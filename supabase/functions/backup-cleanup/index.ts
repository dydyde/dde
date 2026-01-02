/**
 * 备份清理 Edge Function
 * 
 * 功能：
 * 1. 根据保留策略清理过期备份
 * 2. 保留策略：
 *    - 最近 24 小时：保留所有增量
 *    - 最近 7 天：每天保留 4 个点 (00:00, 06:00, 12:00, 18:00)
 *    - 最近 30 天：每天保留 1 个全量
 *    - 更久：每周保留 1 个
 * 3. 删除 Storage 中的备份文件
 * 4. 更新数据库中的备份状态
 * 
 * 触发方式：
 * - Supabase Cron: 每日 01:00 UTC（在全量备份后 1 小时执行）
 * - 手动调用（管理员）
 * 
 * 环境变量：
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BACKUP_CONFIG } from "../_shared/backup-utils.ts";

// ===========================================
// 配置
// ===========================================

const BATCH_SIZE = 50; // 每批删除的文件数
const MAX_DELETIONS_PER_RUN = 500; // 每次运行最多删除的文件数

interface CleanupRequest {
  /** 测试模式（不实际删除） */
  dryRun?: boolean;
  /** 强制清理所有过期备份（忽略保留策略中的采样逻辑） */
  forceCleanAll?: boolean;
}

interface CleanupResult {
  success: boolean;
  stats: {
    expiredCount: number;
    sampledToKeep: number;
    deletedCount: number;
    storageDeletedCount: number;
    storageErrors: string[];
    durationMs: number;
  };
  error?: string;
}

interface BackupRecord {
  id: string;
  path: string;
  type: 'full' | 'incremental';
  backup_completed_at: string;
  expires_at: string | null;
  retention_tier: string | null;
}

// ===========================================
// 主处理器
// ===========================================

Deno.serve(async (req: Request): Promise<Response> => {
  const startTime = Date.now();
  
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  
  try {
    let options: CleanupRequest = {};
    try {
      const body = await req.text();
      if (body) {
        options = JSON.parse(body);
      }
    } catch {
      // 允许空 body
    }
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: "Missing Supabase configuration" }, 500);
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    const result = await executeCleanup(supabase, options, startTime);
    
    return jsonResponse(result, result.success ? 200 : 500);
    
  } catch (error) {
    console.error("Backup cleanup failed:", error);
    return jsonResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// ===========================================
// 清理执行
// ===========================================

async function executeCleanup(
  supabase: SupabaseClient,
  options: CleanupRequest,
  startTime: number
): Promise<CleanupResult> {
  
  console.log("Starting backup cleanup...", { options });
  
  const now = new Date();
  const stats = {
    expiredCount: 0,
    sampledToKeep: 0,
    deletedCount: 0,
    storageDeletedCount: 0,
    storageErrors: [] as string[],
    durationMs: 0,
  };
  
  // 1. 获取所有已完成的备份
  const { data: allBackups, error: fetchError } = await supabase
    .from("backup_metadata")
    .select("id, path, type, backup_completed_at, expires_at, retention_tier")
    .eq("status", "completed")
    .order("backup_completed_at", { ascending: false });
  
  if (fetchError) {
    return { success: false, stats, error: `Failed to fetch backups: ${fetchError.message}` };
  }
  
  if (!allBackups || allBackups.length === 0) {
    console.log("No backups to clean up");
    stats.durationMs = Date.now() - startTime;
    return { success: true, stats };
  }
  
  console.log(`Found ${allBackups.length} completed backups`);
  
  // 2. 根据保留策略确定要删除的备份
  const toDelete = selectBackupsToDelete(allBackups, now, options.forceCleanAll);
  
  stats.expiredCount = toDelete.expired.length;
  stats.sampledToKeep = toDelete.sampledKeep.length;
  
  const backupsToDelete = [...toDelete.expired, ...toDelete.sampled];
  
  console.log(`Backups to delete: ${backupsToDelete.length} (${toDelete.expired.length} expired, ${toDelete.sampled.length} sampled out)`);
  console.log(`Backups to keep (sampled): ${toDelete.sampledKeep.length}`);
  
  if (backupsToDelete.length === 0) {
    console.log("No backups to delete");
    stats.durationMs = Date.now() - startTime;
    return { success: true, stats };
  }
  
  // 3. 限制每次运行删除的数量
  const limitedBackups = backupsToDelete.slice(0, MAX_DELETIONS_PER_RUN);
  
  if (backupsToDelete.length > MAX_DELETIONS_PER_RUN) {
    console.log(`Limited to ${MAX_DELETIONS_PER_RUN} deletions (${backupsToDelete.length} total pending)`);
  }
  
  // 4. 批量删除
  for (let i = 0; i < limitedBackups.length; i += BATCH_SIZE) {
    const batch = limitedBackups.slice(i, i + BATCH_SIZE);
    
    if (!options.dryRun) {
      // 4.1 删除 Storage 文件
      const paths = batch.map(b => b.path);
      const { error: storageError } = await supabase.storage
        .from("backups")
        .remove(paths);
      
      if (storageError) {
        stats.storageErrors.push(`Batch ${i}: ${storageError.message}`);
        console.error(`Storage delete error:`, storageError);
      } else {
        stats.storageDeletedCount += batch.length;
      }
      
      // 4.2 更新数据库状态为 expired
      const ids = batch.map(b => b.id);
      const { error: dbError } = await supabase
        .from("backup_metadata")
        .update({ status: "expired" })
        .in("id", ids);
      
      if (dbError) {
        console.error(`Database update error:`, dbError);
      } else {
        stats.deletedCount += batch.length;
      }
    } else {
      console.log(`[DRY RUN] Would delete ${batch.length} backups:`, batch.map(b => b.path));
      stats.deletedCount += batch.length;
      stats.storageDeletedCount += batch.length;
    }
  }
  
  stats.durationMs = Date.now() - startTime;
  
  console.log("Backup cleanup completed", stats);
  
  return { success: true, stats };
}

// ===========================================
// 保留策略
// ===========================================

interface DeleteSelection {
  /** 已过期的备份（expires_at < now） */
  expired: BackupRecord[];
  /** 根据采样规则需要删除的备份 */
  sampled: BackupRecord[];
  /** 根据采样规则需要保留的备份 */
  sampledKeep: BackupRecord[];
}

function selectBackupsToDelete(
  backups: BackupRecord[],
  now: Date,
  forceCleanAll?: boolean
): DeleteSelection {
  
  const expired: BackupRecord[] = [];
  const sampled: BackupRecord[] = [];
  const sampledKeep: BackupRecord[] = [];
  
  const nowMs = now.getTime();
  const config = BACKUP_CONFIG.RETENTION;
  
  // 时间边界
  const hourlyBoundary = nowMs - config.HOURLY_MAX_AGE_HOURS * 60 * 60 * 1000;
  const dailyBoundary = nowMs - config.DAILY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const weeklyBoundary = nowMs - config.WEEKLY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const monthlyBoundary = nowMs - config.MONTHLY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  
  // 用于采样的辅助结构
  // key: "YYYY-MM-DD-HH" (用于 daily 采样)
  // key: "YYYY-MM-DD" (用于 weekly 采样)
  // key: "YYYY-WW" (用于 monthly 采样)
  const dailySamples = new Map<string, BackupRecord[]>();
  const weeklySamples = new Map<string, BackupRecord[]>();
  const monthlySamples = new Map<string, BackupRecord[]>();
  
  for (const backup of backups) {
    const backupTime = new Date(backup.backup_completed_at).getTime();
    
    // 检查是否已过期（有明确的过期时间）
    if (backup.expires_at && new Date(backup.expires_at).getTime() < nowMs) {
      expired.push(backup);
      continue;
    }
    
    // 最近 24 小时：保留所有
    if (backupTime >= hourlyBoundary) {
      sampledKeep.push(backup);
      continue;
    }
    
    // 7 天内：每天保留 4 个点
    if (backupTime >= dailyBoundary) {
      const key = getDailySampleKey(backup.backup_completed_at);
      if (!dailySamples.has(key)) {
        dailySamples.set(key, []);
      }
      dailySamples.get(key)!.push(backup);
      continue;
    }
    
    // 30 天内：每天保留 1 个全量
    if (backupTime >= weeklyBoundary) {
      const key = getWeeklySampleKey(backup.backup_completed_at);
      if (!weeklySamples.has(key)) {
        weeklySamples.set(key, []);
      }
      weeklySamples.get(key)!.push(backup);
      continue;
    }
    
    // 90 天内：每周保留 1 个
    if (backupTime >= monthlyBoundary) {
      const key = getMonthlySampleKey(backup.backup_completed_at);
      if (!monthlySamples.has(key)) {
        monthlySamples.set(key, []);
      }
      monthlySamples.get(key)!.push(backup);
      continue;
    }
    
    // 超过 90 天：标记为过期
    expired.push(backup);
  }
  
  // 处理 daily 采样（每天保留 00:00, 06:00, 12:00, 18:00 附近的 4 个备份）
  for (const [, groupBackups] of dailySamples) {
    if (forceCleanAll) {
      sampled.push(...groupBackups);
      continue;
    }
    
    const { keep, remove } = sampleByHour(groupBackups, config.DAILY_SAMPLE_HOURS);
    sampledKeep.push(...keep);
    sampled.push(...remove);
  }
  
  // 处理 weekly 采样（每天保留 1 个全量）
  for (const [, groupBackups] of weeklySamples) {
    if (forceCleanAll) {
      sampled.push(...groupBackups);
      continue;
    }
    
    // 优先保留全量备份，如果没有则保留最新的增量
    const fullBackups = groupBackups.filter(b => b.type === 'full');
    const incrementalBackups = groupBackups.filter(b => b.type === 'incremental');
    
    if (fullBackups.length > 0) {
      // 保留最新的全量备份
      fullBackups.sort((a, b) => 
        new Date(b.backup_completed_at).getTime() - new Date(a.backup_completed_at).getTime()
      );
      sampledKeep.push(fullBackups[0]);
      sampled.push(...fullBackups.slice(1), ...incrementalBackups);
    } else if (incrementalBackups.length > 0) {
      // 没有全量备份，保留最新的增量
      incrementalBackups.sort((a, b) => 
        new Date(b.backup_completed_at).getTime() - new Date(a.backup_completed_at).getTime()
      );
      sampledKeep.push(incrementalBackups[0]);
      sampled.push(...incrementalBackups.slice(1));
    }
  }
  
  // 处理 monthly 采样（每周保留 1 个）
  for (const [, groupBackups] of monthlySamples) {
    if (forceCleanAll) {
      sampled.push(...groupBackups);
      continue;
    }
    
    // 优先保留全量备份
    const fullBackups = groupBackups.filter(b => b.type === 'full');
    const incrementalBackups = groupBackups.filter(b => b.type === 'incremental');
    
    if (fullBackups.length > 0) {
      fullBackups.sort((a, b) => 
        new Date(b.backup_completed_at).getTime() - new Date(a.backup_completed_at).getTime()
      );
      sampledKeep.push(fullBackups[0]);
      sampled.push(...fullBackups.slice(1), ...incrementalBackups);
    } else if (incrementalBackups.length > 0) {
      incrementalBackups.sort((a, b) => 
        new Date(b.backup_completed_at).getTime() - new Date(a.backup_completed_at).getTime()
      );
      sampledKeep.push(incrementalBackups[0]);
      sampled.push(...incrementalBackups.slice(1));
    }
  }
  
  return { expired, sampled, sampledKeep };
}

// ===========================================
// 采样辅助函数
// ===========================================

function getDailySampleKey(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeeklySampleKey(timestamp: string): string {
  // 与 daily 相同，按天分组
  return getDailySampleKey(timestamp);
}

function getMonthlySampleKey(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  // 计算周数
  const firstDayOfYear = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((date.getTime() - firstDayOfYear.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.floor(dayOfYear / 7) + 1;
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

function sampleByHour(
  backups: BackupRecord[],
  sampleHours: readonly number[]
): { keep: BackupRecord[]; remove: BackupRecord[] } {
  
  const keep: BackupRecord[] = [];
  const remove: BackupRecord[] = [];
  
  // 按小时分组
  const byHour = new Map<number, BackupRecord[]>();
  
  for (const backup of backups) {
    const hour = new Date(backup.backup_completed_at).getUTCHours();
    if (!byHour.has(hour)) {
      byHour.set(hour, []);
    }
    byHour.get(hour)!.push(backup);
  }
  
  // 对于每个采样小时，保留最接近该小时的备份
  const usedBackups = new Set<string>();
  
  for (const targetHour of sampleHours) {
    let closest: BackupRecord | null = null;
    let closestDiff = Infinity;
    
    for (const [hour, hourBackups] of byHour) {
      const diff = Math.min(
        Math.abs(hour - targetHour),
        Math.abs(hour - targetHour + 24),
        Math.abs(hour - targetHour - 24)
      );
      
      if (diff < closestDiff) {
        // 选择该小时组中最新的备份
        const sorted = [...hourBackups].sort((a, b) => 
          new Date(b.backup_completed_at).getTime() - new Date(a.backup_completed_at).getTime()
        );
        const candidate = sorted.find(b => !usedBackups.has(b.id));
        if (candidate) {
          closest = candidate;
          closestDiff = diff;
        }
      }
    }
    
    if (closest && !usedBackups.has(closest.id)) {
      keep.push(closest);
      usedBackups.add(closest.id);
    }
  }
  
  // 剩余的标记为删除
  for (const backup of backups) {
    if (!usedBackups.has(backup.id)) {
      remove.push(backup);
    }
  }
  
  return { keep, remove };
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
