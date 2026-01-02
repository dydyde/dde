/**
 * 增量备份 Edge Function
 * 
 * 功能：
 * 1. 仅导出 updated_at > last_backup_time 的记录
 * 2. 执行健康校验
 * 3. 压缩并可选加密
 * 4. 上传到 Storage bucket
 * 5. 记录备份元数据
 * 
 * 触发方式：
 * - Supabase Cron: 每 15 分钟
 * - 手动调用（管理员）
 * 
 * 环境变量：
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - BACKUP_ENCRYPTION_KEY (可选，Base64 编码的 256 位密钥)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  BACKUP_CONFIG,
  BackupData,
  BackupProject,
  BackupTask,
  BackupConnection,
  validateBackup,
  encryptData,
  calculateChecksum,
  compressData,
  generateBackupPath,
  calculateExpiresAt,
  uint8ArrayToBase64,
} from "../_shared/backup-utils.ts";

// ===========================================
// 配置
// ===========================================

const BATCH_SIZE = 1000;
const MIN_CHANGES_FOR_BACKUP = 0; // 即使没有变更也创建备份（记录状态）

interface IncrementalBackupRequest {
  /** 是否跳过加密 */
  skipEncryption?: boolean;
  /** 是否为测试模式 */
  dryRun?: boolean;
  /** 手动指定起始时间（覆盖自动检测） */
  since?: string;
  /** 特定用户 ID */
  userId?: string;
}

interface BackupResult {
  success: boolean;
  path?: string;
  backupId?: string;
  stats?: {
    projectCount: number;
    taskCount: number;
    connectionCount: number;
    sizeBytes: number;
    compressedSizeBytes: number;
    durationMs: number;
    incrementalSince: string;
  };
  validation?: {
    ok: boolean;
    warnings: string[];
  };
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

// ===========================================
// 告警辅助函数
// ===========================================

async function sendBackupFailedAlert(
  supabaseUrl: string,
  supabaseKey: string,
  error: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/backup-alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        action: 'backup_failed',
        backupType: 'incremental',
        error,
        details,
      }),
    });
    
    if (!response.ok) {
      console.warn('Failed to send backup alert:', await response.text());
    }
  } catch (alertError) {
    console.warn('Failed to send backup alert:', alertError);
  }
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
    let options: IncrementalBackupRequest = {};
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
    const result = await executeIncrementalBackup(supabase, options, startTime);
    
    return jsonResponse(result, result.success ? 200 : 500);
    
  } catch (error) {
    console.error("Incremental backup failed:", error);
    
    // 发送告警
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && supabaseKey) {
      await sendBackupFailedAlert(
        supabaseUrl,
        supabaseKey,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
    
    return jsonResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// ===========================================
// 备份执行
// ===========================================

async function executeIncrementalBackup(
  supabase: SupabaseClient,
  options: IncrementalBackupRequest,
  startTime: number
): Promise<BackupResult> {
  
  console.log("Starting incremental backup...", { options });
  
  // 1. 确定增量起始时间
  const incrementalSince = options.since || await getLastBackupTime(supabase);
  
  if (!incrementalSince) {
    // 没有历史备份，应该执行全量备份
    return {
      success: false,
      skipped: true,
      skipReason: "No previous backup found. Run full backup first.",
    };
  }
  
  console.log(`Incremental since: ${incrementalSince}`);
  
  // 2. 检查是否有变更
  const changeCount = await countChanges(supabase, incrementalSince, options.userId);
  
  if (changeCount.total === 0 && MIN_CHANGES_FOR_BACKUP > 0) {
    console.log("No changes since last backup, skipping");
    return {
      success: true,
      skipped: true,
      skipReason: "No changes since last backup",
    };
  }
  
  console.log(`Found ${changeCount.total} changes (projects: ${changeCount.projects}, tasks: ${changeCount.tasks}, connections: ${changeCount.connections})`);
  
  // 3. 创建备份元数据记录
  const backupPath = generateBackupPath("incremental");
  const { expiresAt, retentionTier } = calculateExpiresAt("incremental");
  
  // 获取最新的全量备份 ID 作为 base
  const baseBackupId = await getLatestFullBackupId(supabase);
  
  const { data: backupMeta, error: metaError } = await supabase
    .from("backup_metadata")
    .insert({
      type: "incremental",
      path: backupPath,
      user_id: options.userId || null,
      status: "in_progress",
      backup_started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      retention_tier: retentionTier,
      checksum: "",
      compressed: true,
      encrypted: !options.skipEncryption,
      base_backup_id: baseBackupId,
      incremental_since: incrementalSince,
    })
    .select()
    .single();
  
  if (metaError) {
    console.error("Failed to create backup metadata:", metaError);
    return { success: false, error: `Failed to create backup metadata: ${metaError.message}` };
  }
  
  const backupId = backupMeta.id;
  
  try {
    // 4. 导出增量数据
    console.log("Exporting incremental data...");
    const backupData = await exportIncrementalData(supabase, incrementalSince, options.userId);
    
    // 5. 健康校验（增量备份使用简化校验）
    console.log("Validating backup...");
    const validation = validateIncrementalBackup(backupData);
    
    if (!validation.ok) {
      await updateBackupStatus(supabase, backupId, "failed", validation.errors.join("; "));
      return { 
        success: false, 
        error: `Validation failed: ${validation.errors.join("; ")}`,
        validation: { ok: false, warnings: validation.warnings },
      };
    }
    
    // 6. 序列化
    const jsonData = JSON.stringify(backupData);
    const originalSize = new TextEncoder().encode(jsonData).length;
    
    // 7. 压缩
    console.log("Compressing data...");
    const compressed = await compressData(jsonData);
    
    // 8. 可选加密
    let finalData: Uint8Array | string = compressed;
    let encrypted = false;
    let encryptionKeyId: string | undefined;
    
    const encryptionKey = Deno.env.get("BACKUP_ENCRYPTION_KEY");
    if (encryptionKey && !options.skipEncryption) {
      console.log("Encrypting data...");
      const base64Compressed = uint8ArrayToBase64(compressed);
      const encryptedData = await encryptData(base64Compressed, encryptionKey);
      finalData = new TextEncoder().encode(encryptedData);
      encrypted = true;
      encryptionKeyId = "key_v1";
    }
    
    // 9. 计算校验和
    const checksum = await calculateChecksum(finalData instanceof Uint8Array ? finalData : new TextEncoder().encode(finalData));
    
    // 10. 上传到 Storage
    if (!options.dryRun) {
      console.log("Uploading to storage...", { path: backupPath });
      const uploadData = finalData instanceof Uint8Array ? finalData : new TextEncoder().encode(finalData);
      
      const { error: uploadError } = await supabase.storage
        .from("backups")
        .upload(backupPath, uploadData, {
          contentType: encrypted ? "application/octet-stream" : "application/gzip",
          upsert: false,
        });
      
      if (uploadError) {
        await updateBackupStatus(supabase, backupId, "failed", `Upload failed: ${uploadError.message}`);
        return { success: false, error: `Upload failed: ${uploadError.message}` };
      }
    }
    
    // 11. 更新备份元数据
    const finalSize = finalData instanceof Uint8Array ? finalData.length : new TextEncoder().encode(finalData).length;
    const durationMs = Date.now() - startTime;
    
    await supabase
      .from("backup_metadata")
      .update({
        status: "completed",
        project_count: backupData.projects.length,
        task_count: backupData.tasks.length,
        connection_count: backupData.connections.length,
        size_bytes: finalSize,
        checksum,
        checksum_algorithm: BACKUP_CONFIG.INTEGRITY.CHECKSUM_ALGORITHM,
        encrypted,
        encryption_algorithm: encrypted ? "AES-256-GCM" : null,
        encryption_key_id: encryptionKeyId,
        validation_passed: validation.ok,
        validation_warnings: validation.warnings,
        backup_completed_at: new Date().toISOString(),
      })
      .eq("id", backupId);
    
    console.log("Incremental backup completed successfully", {
      backupId,
      path: backupPath,
      projectCount: backupData.projects.length,
      taskCount: backupData.tasks.length,
      connectionCount: backupData.connections.length,
      durationMs,
    });
    
    return {
      success: true,
      path: backupPath,
      backupId,
      stats: {
        projectCount: backupData.projects.length,
        taskCount: backupData.tasks.length,
        connectionCount: backupData.connections.length,
        sizeBytes: originalSize,
        compressedSizeBytes: finalSize,
        durationMs,
        incrementalSince,
      },
      validation: {
        ok: validation.ok,
        warnings: validation.warnings,
      },
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await updateBackupStatus(supabase, backupId, "failed", errorMessage);
    throw error;
  }
}

// ===========================================
// 数据导出
// ===========================================

async function exportIncrementalData(
  supabase: SupabaseClient,
  since: string,
  userId?: string
): Promise<BackupData> {
  
  const projects: BackupProject[] = [];
  const tasks: BackupTask[] = [];
  const connections: BackupConnection[] = [];
  
  // 导出更新的项目
  let projectOffset = 0;
  while (true) {
    let query = supabase
      .from("projects")
      .select("*")
      .gt("updated_at", since)
      .range(projectOffset, projectOffset + BATCH_SIZE - 1)
      .order("id");
    
    if (userId) {
      query = query.eq("user_id", userId);
    }
    
    const { data, error } = await query;
    
    if (error) {
      throw new Error(`Failed to export projects: ${error.message}`);
    }
    
    if (!data || data.length === 0) break;
    
    projects.push(...data.map(mapProject));
    projectOffset += data.length;
    
    if (data.length < BATCH_SIZE) break;
  }
  
  // 如果是用户级备份，获取项目 ID 集合
  let projectIds: Set<string> | undefined;
  if (userId && projects.length > 0) {
    // 获取用户的所有项目 ID（包括未更新的）
    const { data: allProjects } = await supabase
      .from("projects")
      .select("id")
      .eq("user_id", userId);
    
    projectIds = new Set(allProjects?.map(p => p.id) || []);
  }
  
  // 导出更新的任务
  let taskOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .gt("updated_at", since)
      .range(taskOffset, taskOffset + BATCH_SIZE - 1)
      .order("id");
    
    if (error) {
      throw new Error(`Failed to export tasks: ${error.message}`);
    }
    
    if (!data || data.length === 0) break;
    
    const filteredTasks = projectIds
      ? data.filter(t => projectIds!.has(t.project_id))
      : data;
    
    tasks.push(...filteredTasks.map(mapTask));
    taskOffset += data.length;
    
    if (data.length < BATCH_SIZE) break;
  }
  
  // 导出更新的连接
  let connectionOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("connections")
      .select("*")
      .gt("updated_at", since)
      .range(connectionOffset, connectionOffset + BATCH_SIZE - 1)
      .order("id");
    
    if (error) {
      throw new Error(`Failed to export connections: ${error.message}`);
    }
    
    if (!data || data.length === 0) break;
    
    const filteredConnections = projectIds
      ? data.filter(c => projectIds!.has(c.project_id))
      : data;
    
    connections.push(...filteredConnections.map(mapConnection));
    connectionOffset += data.length;
    
    if (data.length < BATCH_SIZE) break;
  }
  
  console.log(`Exported incremental: ${projects.length} projects, ${tasks.length} tasks, ${connections.length} connections`);
  
  return {
    version: BACKUP_CONFIG.VERSION,
    type: "incremental",
    createdAt: new Date().toISOString(),
    projects,
    tasks,
    connections,
  };
}

// ===========================================
// 辅助函数
// ===========================================

async function getLastBackupTime(supabase: SupabaseClient): Promise<string | null> {
  // 优先查找最近的增量备份，否则使用全量备份时间
  const { data } = await supabase
    .from("backup_metadata")
    .select("backup_completed_at")
    .eq("status", "completed")
    .order("backup_completed_at", { ascending: false })
    .limit(1)
    .single();
  
  return data?.backup_completed_at || null;
}

async function getLatestFullBackupId(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("backup_metadata")
    .select("id")
    .eq("type", "full")
    .eq("status", "completed")
    .order("backup_completed_at", { ascending: false })
    .limit(1)
    .single();
  
  return data?.id || null;
}

async function countChanges(
  supabase: SupabaseClient,
  since: string,
  userId?: string
): Promise<{ total: number; projects: number; tasks: number; connections: number }> {
  
  // 统计项目变更
  let projectQuery = supabase
    .from("projects")
    .select("id", { count: "exact", head: true })
    .gt("updated_at", since);
  
  if (userId) {
    projectQuery = projectQuery.eq("user_id", userId);
  }
  
  const { count: projectCount } = await projectQuery;
  
  // 统计任务变更
  const { count: taskCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .gt("updated_at", since);
  
  // 统计连接变更
  const { count: connectionCount } = await supabase
    .from("connections")
    .select("id", { count: "exact", head: true })
    .gt("updated_at", since);
  
  return {
    total: (projectCount || 0) + (taskCount || 0) + (connectionCount || 0),
    projects: projectCount || 0,
    tasks: taskCount || 0,
    connections: connectionCount || 0,
  };
}

function validateIncrementalBackup(data: BackupData): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 增量备份使用简化校验
  const hasRequiredStructure = 
    Array.isArray(data.projects) &&
    Array.isArray(data.tasks) &&
    Array.isArray(data.connections);
  
  if (!hasRequiredStructure) {
    errors.push("Invalid backup structure");
  }
  
  // 检查数据完整性
  const taskIds = new Set(data.tasks.map(t => t.id));
  const brokenConnections = data.connections.filter(
    c => !taskIds.has(c.source) || !taskIds.has(c.target)
  );
  
  if (brokenConnections.length > 0) {
    // 增量备份中允许断开的连接（因为端点任务可能在之前的备份中）
    warnings.push(`${brokenConnections.length} connections reference tasks not in this incremental backup`);
  }
  
  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function updateBackupStatus(
  supabase: SupabaseClient,
  backupId: string,
  status: "completed" | "failed",
  errorMessage?: string
): Promise<void> {
  await supabase
    .from("backup_metadata")
    .update({
      status,
      error_message: errorMessage,
      backup_completed_at: new Date().toISOString(),
    })
    .eq("id", backupId);
}

function mapProject(row: Record<string, unknown>): BackupProject {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    createdAt: row.created_at as string | undefined,
    updatedAt: row.updated_at as string | undefined,
  };
}

function mapTask(row: Record<string, unknown>): BackupTask {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    content: (row.content as string) || undefined,
    parentId: row.parent_id as string | null | undefined,
    stage: row.stage as number | null | undefined,
    order: row.order as number | undefined,
    rank: row.rank as number | undefined,
    status: row.status as string | undefined,
    x: row.x as number | undefined,
    y: row.y as number | undefined,
    displayId: row.display_id as string | undefined,
    shortId: row.short_id as string | undefined,
    attachments: row.attachments as unknown[] | undefined,
    createdAt: row.created_at as string | undefined,
    updatedAt: row.updated_at as string | undefined,
    deletedAt: row.deleted_at as string | null | undefined,
  };
}

function mapConnection(row: Record<string, unknown>): BackupConnection {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    source: row.source as string,
    target: row.target as string,
    title: (row.title as string) || undefined,
    description: (row.description as string) || undefined,
    createdAt: row.created_at as string | undefined,
    updatedAt: row.updated_at as string | undefined,
    deletedAt: row.deleted_at as string | null | undefined,
  };
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
