/**
 * 附件备份 Edge Function
 * 
 * 功能：
 * 1. 同步复制附件到备份 bucket
 * 2. 与数据备份配合使用
 * 3. 支持增量备份（仅复制新增/修改的附件）
 * 
 * 触发方式：
 * - 在全量备份完成后调用
 * - 手动调用
 * 
 * 位置: supabase/functions/backup-attachments/index.ts
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===========================================
// 类型定义
// ===========================================

interface AttachmentBackupRequest {
  /** 增量备份起始时间 */
  since?: string;
  /** 特定用户 ID */
  userId?: string;
  /** 是否为测试模式 */
  dryRun?: boolean;
  /** 关联的数据备份 ID */
  dataBackupId?: string;
}

interface AttachmentBackupResult {
  success: boolean;
  stats?: {
    totalAttachments: number;
    copiedCount: number;
    skippedCount: number;
    failedCount: number;
    totalSizeBytes: number;
    durationMs: number;
  };
  errors?: string[];
  error?: string;
}

interface AttachmentRecord {
  id: string;
  task_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  created_at: string;
  updated_at: string;
}

// ===========================================
// 配置
// ===========================================

const CONFIG = {
  /** 源 bucket 名称 */
  SOURCE_BUCKET: 'attachments',
  /** 目标备份 bucket 名称 */
  BACKUP_BUCKET: 'backups',
  /** 备份路径前缀 */
  BACKUP_PREFIX: 'attachments/',
  /** 每批处理数量 */
  BATCH_SIZE: 50,
  /** 单个文件最大大小 (50MB) */
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  /** 并发复制数量 */
  CONCURRENCY: 5,
} as const;

// ===========================================
// 辅助函数
// ===========================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 生成备份路径
 */
function generateBackupPath(originalPath: string, backupId?: string): string {
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const prefix = backupId 
    ? `${CONFIG.BACKUP_PREFIX}${backupId}/`
    : `${CONFIG.BACKUP_PREFIX}${timestamp}/`;
  
  return `${prefix}${originalPath}`;
}

/**
 * 检查备份文件是否已存在
 */
async function backupExists(
  supabase: SupabaseClient,
  backupPath: string
): Promise<boolean> {
  const { data } = await supabase.storage
    .from(CONFIG.BACKUP_BUCKET)
    .list(backupPath.split('/').slice(0, -1).join('/'), {
      search: backupPath.split('/').pop(),
    });
  
  return (data?.length ?? 0) > 0;
}

/**
 * 复制单个附件到备份 bucket
 */
async function copyAttachment(
  supabase: SupabaseClient,
  attachment: AttachmentRecord,
  backupId?: string,
  dryRun = false
): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
  try {
    const backupPath = generateBackupPath(attachment.file_path, backupId);
    
    // 检查是否已备份
    if (await backupExists(supabase, backupPath)) {
      return { success: true, skipped: true };
    }
    
    if (dryRun) {
      console.log(`[DRY RUN] Would copy: ${attachment.file_path} → ${backupPath}`);
      return { success: true };
    }
    
    // 下载源文件
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(CONFIG.SOURCE_BUCKET)
      .download(attachment.file_path);
    
    if (downloadError) {
      // 文件可能已被删除
      if (downloadError.message.includes('not found')) {
        return { success: true, skipped: true };
      }
      return { success: false, error: `Download failed: ${downloadError.message}` };
    }
    
    if (!fileData) {
      return { success: false, error: 'No file data received' };
    }
    
    // 检查文件大小
    if (fileData.size > CONFIG.MAX_FILE_SIZE) {
      return { success: false, error: `File too large: ${fileData.size} bytes` };
    }
    
    // 上传到备份 bucket
    const { error: uploadError } = await supabase.storage
      .from(CONFIG.BACKUP_BUCKET)
      .upload(backupPath, fileData, {
        contentType: attachment.mime_type,
        upsert: false,
      });
    
    if (uploadError) {
      // 如果是文件已存在，视为成功
      if (uploadError.message.includes('already exists')) {
        return { success: true, skipped: true };
      }
      return { success: false, error: `Upload failed: ${uploadError.message}` };
    }
    
    console.log(`Copied: ${attachment.file_path} → ${backupPath}`);
    return { success: true };
    
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * 并发处理附件
 */
async function processInBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  
  return results;
}

// ===========================================
// 主处理器
// ===========================================

Deno.serve(async (req: Request): Promise<Response> => {
  const startTime = Date.now();
  
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  
  try {
    let options: AttachmentBackupRequest = {};
    try {
      const body = await req.text();
      if (body) {
        options = JSON.parse(body);
      }
    } catch {
      // 允许空 body
    }
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: 'Missing Supabase configuration' }, 500);
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    const result = await executeAttachmentBackup(supabase, options, startTime);
    
    return jsonResponse(result, result.success ? 200 : 500);
    
  } catch (error) {
    console.error('Attachment backup failed:', error);
    return jsonResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// ===========================================
// 备份执行
// ===========================================

async function executeAttachmentBackup(
  supabase: SupabaseClient,
  options: AttachmentBackupRequest,
  startTime: number
): Promise<AttachmentBackupResult> {
  
  console.log('Starting attachment backup...', { options });
  
  // 1. 查询需要备份的附件
  let query = supabase
    .from('attachments')
    .select('id, task_id, file_name, file_path, file_size, mime_type, created_at, updated_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  
  // 增量备份：仅处理指定时间之后的附件
  if (options.since) {
    query = query.gte('created_at', options.since);
  }
  
  // 如果指定了用户 ID，需要通过 tasks 表关联
  // 这里简化处理，假设 attachments 表有 user_id 或通过 RPC 查询
  
  const allAttachments: AttachmentRecord[] = [];
  let offset = 0;
  
  while (true) {
    const { data, error } = await query.range(offset, offset + CONFIG.BATCH_SIZE - 1);
    
    if (error) {
      console.error('Failed to query attachments:', error);
      return { success: false, error: `Query failed: ${error.message}` };
    }
    
    if (!data || data.length === 0) break;
    
    allAttachments.push(...(data as AttachmentRecord[]));
    offset += data.length;
    
    if (data.length < CONFIG.BATCH_SIZE) break;
  }
  
  console.log(`Found ${allAttachments.length} attachments to backup`);
  
  if (allAttachments.length === 0) {
    return {
      success: true,
      stats: {
        totalAttachments: 0,
        copiedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        totalSizeBytes: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }
  
  // 2. 复制附件到备份 bucket
  const errors: string[] = [];
  let copiedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let totalSizeBytes = 0;
  
  const results = await processInBatches(
    allAttachments,
    async (attachment) => {
      const result = await copyAttachment(
        supabase, 
        attachment, 
        options.dataBackupId,
        options.dryRun
      );
      
      if (result.success) {
        if (result.skipped) {
          skippedCount++;
        } else {
          copiedCount++;
          totalSizeBytes += attachment.file_size || 0;
        }
      } else {
        failedCount++;
        if (result.error) {
          errors.push(`${attachment.file_name}: ${result.error}`);
        }
      }
      
      return result;
    },
    CONFIG.CONCURRENCY
  );
  
  const durationMs = Date.now() - startTime;
  
  console.log('Attachment backup completed', {
    totalAttachments: allAttachments.length,
    copiedCount,
    skippedCount,
    failedCount,
    totalSizeBytes,
    durationMs,
  });
  
  // 3. 记录备份信息到 backup_metadata（如果有关联的数据备份）
  if (options.dataBackupId && copiedCount > 0) {
    await supabase
      .from('backup_metadata')
      .update({
        attachment_count: copiedCount,
        attachment_size_bytes: totalSizeBytes,
      })
      .eq('id', options.dataBackupId);
  }
  
  return {
    success: failedCount === 0 || failedCount < allAttachments.length * 0.1, // 允许 10% 失败
    stats: {
      totalAttachments: allAttachments.length,
      copiedCount,
      skippedCount,
      failedCount,
      totalSizeBytes,
      durationMs,
    },
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // 最多返回 10 个错误
  };
}
