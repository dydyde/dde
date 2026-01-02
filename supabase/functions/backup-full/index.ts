/**
 * 全量备份 Edge Function
 * 
 * 功能：
 * 1. 导出所有用户的项目、任务、连接数据
 * 2. 执行健康校验
 * 3. 压缩并可选加密
 * 4. 上传到 Storage bucket
 * 5. 记录备份元数据
 * 
 * 触发方式：
 * - Supabase Cron: 每日 00:00 UTC
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
  BackupMetadata,
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

const BATCH_SIZE = 1000; // 每批查询的记录数
const MAX_BACKUP_SIZE_MB = 100; // 最大备份大小（MB）

interface BackupJobRequest {
  /** 是否跳过加密（用于调试） */
  skipEncryption?: boolean;
  /** 是否为测试模式（不实际上传） */
  dryRun?: boolean;
  /** 特定用户 ID（可选，默认全量） */
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
  };
  validation?: {
    ok: boolean;
    warnings: string[];
  };
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
        backupType: 'full',
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
  
  // 验证请求方法
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  
  // 验证授权
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  
  try {
    // 解析请求
    let options: BackupJobRequest = {};
    try {
      const body = await req.text();
      if (body) {
        options = JSON.parse(body);
      }
    } catch {
      // 允许空 body
    }
    
    // 创建 Supabase 客户端
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: "Missing Supabase configuration" }, 500);
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 执行备份
    const result = await executeFullBackup(supabase, options, startTime);
    
    return jsonResponse(result, result.success ? 200 : 500);
    
  } catch (error) {
    console.error("Backup failed:", error);
    
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

async function executeFullBackup(
  supabase: SupabaseClient,
  options: BackupJobRequest,
  startTime: number
): Promise<BackupResult> {
  
  console.log("Starting full backup...", { options });
  
  // 1. 创建备份元数据记录（状态：in_progress）
  const backupPath = generateBackupPath("full");
  const { expiresAt, retentionTier } = calculateExpiresAt("full");
  
  const { data: backupMeta, error: metaError } = await supabase
    .from("backup_metadata")
    .insert({
      type: "full",
      path: backupPath,
      user_id: options.userId || null,
      status: "in_progress",
      backup_started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      retention_tier: retentionTier,
      checksum: "", // 稍后更新
      compressed: true,
      encrypted: !options.skipEncryption,
    })
    .select()
    .single();
  
  if (metaError) {
    console.error("Failed to create backup metadata:", metaError);
    return { success: false, error: `Failed to create backup metadata: ${metaError.message}` };
  }
  
  const backupId = backupMeta.id;
  
  try {
    // 2. 导出数据
    console.log("Exporting data...");
    const backupData = await exportAllData(supabase, options.userId);
    
    // 3. 健康校验
    console.log("Validating backup...");
    const previousMeta = await getPreviousBackupMeta(supabase);
    const validation = validateBackup(backupData, previousMeta);
    
    if (!validation.ok) {
      // 校验失败，标记备份失败
      await updateBackupStatus(supabase, backupId, "failed", validation.errors.join("; "));
      return { 
        success: false, 
        error: `Validation failed: ${validation.errors.join("; ")}`,
        validation: { ok: false, warnings: validation.warnings },
      };
    }
    
    // 4. 序列化
    const jsonData = JSON.stringify(backupData);
    const originalSize = new TextEncoder().encode(jsonData).length;
    
    // 检查大小限制
    if (originalSize > MAX_BACKUP_SIZE_MB * 1024 * 1024) {
      await updateBackupStatus(supabase, backupId, "failed", "Backup size exceeds limit");
      return { success: false, error: `Backup size (${(originalSize / 1024 / 1024).toFixed(2)} MB) exceeds limit (${MAX_BACKUP_SIZE_MB} MB)` };
    }
    
    // 5. 压缩
    console.log("Compressing data...");
    const compressed = await compressData(jsonData);
    console.log(`Compression: ${originalSize} → ${compressed.length} bytes (${((1 - compressed.length / originalSize) * 100).toFixed(1)}% reduction)`);
    
    // 6. 可选加密
    let finalData: Uint8Array | string = compressed;
    let encrypted = false;
    let encryptionKeyId: string | undefined;
    
    const encryptionKey = Deno.env.get("BACKUP_ENCRYPTION_KEY");
    if (encryptionKey && !options.skipEncryption) {
      console.log("Encrypting data...");
      // 先转为 Base64，再加密
      const base64Compressed = uint8ArrayToBase64(compressed);
      const encryptedData = await encryptData(base64Compressed, encryptionKey);
      finalData = new TextEncoder().encode(encryptedData);
      encrypted = true;
      encryptionKeyId = "key_v1"; // TODO: 实现密钥轮换
    }
    
    // 7. 计算校验和
    const checksum = await calculateChecksum(finalData instanceof Uint8Array ? finalData : new TextEncoder().encode(finalData));
    
    // 8. 上传到 Storage
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
    
    // 9. 更新备份元数据
    const finalSize = finalData instanceof Uint8Array ? finalData.length : new TextEncoder().encode(finalData).length;
    const durationMs = Date.now() - startTime;
    
    const { error: updateError } = await supabase
      .from("backup_metadata")
      .update({
        status: "completed",
        project_count: validation.projectCount,
        task_count: validation.taskCount,
        connection_count: validation.connectionCount,
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
    
    if (updateError) {
      console.error("Failed to update backup metadata:", updateError);
      // 备份已成功，仅记录警告
    }
    
    console.log("Full backup completed successfully", {
      backupId,
      path: backupPath,
      projectCount: validation.projectCount,
      taskCount: validation.taskCount,
      connectionCount: validation.connectionCount,
      originalSize,
      finalSize,
      durationMs,
    });
    
    return {
      success: true,
      path: backupPath,
      backupId,
      stats: {
        projectCount: validation.projectCount,
        taskCount: validation.taskCount,
        connectionCount: validation.connectionCount,
        sizeBytes: originalSize,
        compressedSizeBytes: finalSize,
        durationMs,
      },
      validation: {
        ok: validation.ok,
        warnings: validation.warnings,
      },
    };
    
  } catch (error) {
    // 备份失败，更新状态
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await updateBackupStatus(supabase, backupId, "failed", errorMessage);
    throw error;
  }
}

// ===========================================
// 数据导出
// ===========================================

async function exportAllData(
  supabase: SupabaseClient,
  userId?: string
): Promise<BackupData> {
  
  const projects: BackupProject[] = [];
  const tasks: BackupTask[] = [];
  const connections: BackupConnection[] = [];
  
  // 导出项目
  let projectOffset = 0;
  while (true) {
    let query = supabase
      .from("projects")
      .select("*")
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
  
  console.log(`Exported ${projects.length} projects`);
  
  // 获取项目 ID 集合（用于过滤任务和连接）
  const projectIds = new Set(projects.map(p => p.id));
  
  // 导出任务
  let taskOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .range(taskOffset, taskOffset + BATCH_SIZE - 1)
      .order("id");
    
    if (error) {
      throw new Error(`Failed to export tasks: ${error.message}`);
    }
    
    if (!data || data.length === 0) break;
    
    // 过滤属于目标项目的任务
    const filteredTasks = userId 
      ? data.filter((t: Record<string, unknown>) => projectIds.has(t.project_id as string))
      : data;
    
    tasks.push(...filteredTasks.map(mapTask));
    taskOffset += data.length;
    
    if (data.length < BATCH_SIZE) break;
  }
  
  console.log(`Exported ${tasks.length} tasks`);
  
  // 导出连接
  let connectionOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("connections")
      .select("*")
      .range(connectionOffset, connectionOffset + BATCH_SIZE - 1)
      .order("id");
    
    if (error) {
      throw new Error(`Failed to export connections: ${error.message}`);
    }
    
    if (!data || data.length === 0) break;
    
    // 过滤属于目标项目的连接
    const filteredConnections = userId
      ? data.filter((c: Record<string, unknown>) => projectIds.has(c.project_id as string))
      : data;
    
    connections.push(...filteredConnections.map(mapConnection));
    connectionOffset += data.length;
    
    if (data.length < BATCH_SIZE) break;
  }
  
  console.log(`Exported ${connections.length} connections`);
  
  return {
    version: BACKUP_CONFIG.VERSION,
    type: "full",
    createdAt: new Date().toISOString(),
    projects,
    tasks,
    connections,
  };
}

// ===========================================
// 数据映射
// ===========================================

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

// ===========================================
// 辅助函数
// ===========================================

async function getPreviousBackupMeta(
  supabase: SupabaseClient
): Promise<{ taskCount: number } | null> {
  const { data, error } = await supabase
    .from("backup_metadata")
    .select("task_count")
    .eq("type", "full")
    .eq("status", "completed")
    .order("backup_completed_at", { ascending: false })
    .limit(1)
    .single();
  
  if (error || !data) {
    return null;
  }
  
  return { taskCount: data.task_count };
}

async function updateBackupStatus(
  supabase: SupabaseClient,
  backupId: string,
  status: "completed" | "failed",
  errorMessage?: string
): Promise<void> {
  const { error } = await supabase
    .from("backup_metadata")
    .update({
      status,
      error_message: errorMessage,
      backup_completed_at: new Date().toISOString(),
    })
    .eq("id", backupId);
  
  if (error) {
    console.error("Failed to update backup status:", error);
  }
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
