// ============================================
// Supabase Edge Function: 病毒扫描服务
// 提供文件病毒扫描功能
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ==================== 配置 ====================

const CLAMAV_API_URL = Deno.env.get('CLAMAV_API_URL') || 'http://clamav:3310';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// 扫描状态常量
const SCAN_STATUS = {
  PENDING: 'pending',
  SCANNING: 'scanning',
  CLEAN: 'clean',
  THREAT_DETECTED: 'threat_detected',
  FAILED: 'failed',
  QUARANTINED: 'quarantined',
  SKIPPED: 'skipped',
} as const;

// ==================== 类型定义 ====================

interface ScanRequest {
  action: 'scan' | 'status' | 'health' | 'verify-hash' | 'rescan';
  file?: string; // base64 编码的文件
  filename?: string;
  hash?: string;
  mimeType?: string;
  fileId?: string;
  expectedHash?: string;
}

interface ScanResult {
  fileId: string;
  status: string;
  threatName?: string;
  threatDescription?: string;
  scannedAt: string;
  scanner: string;
  engineVersion?: string;
  signatureVersion?: string;
}

// ==================== CORS 处理 ====================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ==================== 主函数 ====================

serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ScanRequest;
    const { action } = body;

    switch (action) {
      case 'health':
        return handleHealthCheck();
      
      case 'scan':
        return handleScan(body);
      
      case 'status':
        return handleStatusCheck(body);
      
      case 'verify-hash':
        return handleHashVerification(body);
      
      case 'rescan':
        return handleRescan(body);
      
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (error) {
    console.error('Error processing request:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});

// ==================== 处理函数 ====================

/**
 * 健康检查
 */
async function handleHealthCheck(): Promise<Response> {
  try {
    // 检查 ClamAV 是否可用
    const clamAvHealth = await checkClamAvHealth();
    
    return jsonResponse({
      status: clamAvHealth ? 'healthy' : 'degraded',
      clamav: clamAvHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return jsonResponse({
      status: 'unhealthy',
      error: String(error),
      timestamp: new Date().toISOString(),
    }, 503);
  }
}

/**
 * 执行文件扫描
 */
async function handleScan(body: ScanRequest): Promise<Response> {
  const { file, filename, hash, mimeType } = body;
  
  if (!file || !filename) {
    return jsonResponse({ error: 'Missing required fields: file, filename' }, 400);
  }

  const fileId = crypto.randomUUID();
  
  try {
    // 解码 base64 文件
    const fileBytes = Uint8Array.from(atob(file), c => c.charCodeAt(0));
    
    // 调用 ClamAV 扫描
    const scanResult = await scanWithClamAv(fileBytes, filename);
    
    // 记录扫描结果
    await saveScanResult(fileId, hash || '', scanResult);
    
    const result: ScanResult = {
      fileId,
      status: scanResult.infected ? SCAN_STATUS.THREAT_DETECTED : SCAN_STATUS.CLEAN,
      threatName: scanResult.virusName,
      threatDescription: scanResult.description,
      scannedAt: new Date().toISOString(),
      scanner: 'clamav',
      engineVersion: scanResult.engineVersion,
      signatureVersion: scanResult.signatureVersion,
    };

    return jsonResponse(result);
  } catch (error) {
    console.error('Scan error:', error);
    
    // 保存失败记录
    await saveScanResult(fileId, hash || '', {
      infected: false,
      status: SCAN_STATUS.FAILED,
      error: String(error),
    });
    
    return jsonResponse({
      fileId,
      status: SCAN_STATUS.FAILED,
      error: String(error),
      scannedAt: new Date().toISOString(),
      scanner: 'clamav',
    });
  }
}

/**
 * 检查扫描状态
 */
async function handleStatusCheck(body: ScanRequest): Promise<Response> {
  const { fileId } = body;
  
  if (!fileId) {
    return jsonResponse({ error: 'Missing required field: fileId' }, 400);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('*')
      .eq('file_id', fileId)
      .single();

    if (error || !data) {
      return jsonResponse({ error: 'Scan record not found' }, 404);
    }

    return jsonResponse({
      fileId: data.file_id,
      status: data.status,
      threatName: data.threat_name,
      threatDescription: data.threat_description,
      scannedAt: data.scanned_at,
      scanner: data.scanner,
      engineVersion: data.engine_version,
      signatureVersion: data.signature_version,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return jsonResponse({ error: 'Failed to check status' }, 500);
  }
}

/**
 * 验证文件哈希
 */
async function handleHashVerification(body: ScanRequest): Promise<Response> {
  const { fileId, expectedHash } = body;
  
  if (!fileId || !expectedHash) {
    return jsonResponse({ error: 'Missing required fields: fileId, expectedHash' }, 400);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('file_hash')
      .eq('file_id', fileId)
      .single();

    if (error || !data) {
      return jsonResponse({ valid: false, error: 'File not found' });
    }

    const valid = data.file_hash === expectedHash;
    
    if (!valid) {
      // 记录可能的篡改尝试
      console.warn('Hash mismatch detected:', { fileId, expected: expectedHash, actual: data.file_hash });
    }

    return jsonResponse({ valid });
  } catch (error) {
    console.error('Hash verification error:', error);
    return jsonResponse({ valid: false, error: 'Verification failed' });
  }
}

/**
 * 触发重新扫描
 */
async function handleRescan(body: ScanRequest): Promise<Response> {
  const { fileId } = body;
  
  if (!fileId) {
    return jsonResponse({ error: 'Missing required field: fileId' }, 400);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // 更新状态为 scanning
    await supabase
      .from('attachment_scans')
      .update({ status: SCAN_STATUS.SCANNING })
      .eq('file_id', fileId);

    // TODO: 从 Storage 获取文件并重新扫描
    // 这里应该触发一个后台任务
    
    return jsonResponse({
      fileId,
      status: SCAN_STATUS.SCANNING,
      message: 'Rescan queued',
    });
  } catch (error) {
    console.error('Rescan error:', error);
    return jsonResponse({ error: 'Failed to queue rescan' }, 500);
  }
}

// ==================== 辅助函数 ====================

/**
 * 检查 ClamAV 健康状态
 */
async function checkClamAvHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${CLAMAV_API_URL}/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface ClamAvScanResult {
  infected: boolean;
  virusName?: string;
  description?: string;
  status?: string;
  error?: string;
  engineVersion?: string;
  signatureVersion?: string;
}

/**
 * 使用 ClamAV 扫描文件
 */
async function scanWithClamAv(fileBytes: Uint8Array, filename: string): Promise<ClamAvScanResult> {
  try {
    // 构建 multipart 请求
    const formData = new FormData();
    const blob = new Blob([fileBytes]);
    formData.append('file', blob, filename);

    const response = await fetch(`${CLAMAV_API_URL}/scan`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`ClamAV returned status ${response.status}`);
    }

    const result = await response.json();
    
    return {
      infected: result.infected || false,
      virusName: result.virus_name,
      description: result.description,
      engineVersion: result.engine_version,
      signatureVersion: result.signature_version,
    };
  } catch (error) {
    console.error('ClamAV scan error:', error);
    
    // ClamAV 不可用时，使用降级策略
    // 对于已知安全的文件类型，可以允许通过
    // 对于可执行文件等高风险类型，应该拒绝
    return {
      infected: false,
      status: SCAN_STATUS.FAILED,
      error: `ClamAV scan failed: ${error}`,
    };
  }
}

/**
 * 保存扫描结果到数据库
 */
async function saveScanResult(
  fileId: string, 
  fileHash: string, 
  result: ClamAvScanResult
): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const status = result.infected 
    ? SCAN_STATUS.THREAT_DETECTED 
    : (result.status || SCAN_STATUS.CLEAN);

  await supabase.from('attachment_scans').upsert({
    file_id: fileId,
    file_hash: fileHash,
    status,
    threat_name: result.virusName,
    threat_description: result.description,
    scanner: 'clamav',
    engine_version: result.engineVersion,
    signature_version: result.signatureVersion,
    scanned_at: new Date().toISOString(),
    error_message: result.error,
  });
}

/**
 * 返回 JSON 响应
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
