// ============================================
// 病毒扫描服务
// 提供文件上传前/下载前的病毒扫描功能
// 通过 Supabase Edge Function 调用 ClamAV
// ============================================

import { inject, Injectable, signal } from '@angular/core';
import * as Sentry from '@sentry/angular';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import {
  VIRUS_SCAN_CONFIG,
  SCAN_STATUS,
  TOCTOU_PROTECTION,
  type ScanResult,
  type ScanStatus,
  type AttachmentScanMetadata,
} from '../config/virus-scan.config';

/**
 * 扫描错误类型
 */
export type ScanErrorCode =
  | 'SCAN_TIMEOUT'
  | 'SCAN_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'FILE_TOO_LARGE'
  | 'HASH_MISMATCH'
  | 'THREAT_DETECTED'
  | 'NETWORK_ERROR';

/**
 * 扫描响应接口
 */
export interface ScanResponse {
  success: boolean;
  result?: ScanResult;
  error?: string;
  errorCode?: ScanErrorCode;
}

/**
 * 批量扫描任务接口
 */
interface ScanTask {
  fileId: string;
  file: Blob;
  filename: string;
  hash?: string;
}

/**
 * 病毒扫描服务
 * 
 * 功能：
 * 1. 上传前扫描 - 阻止恶意文件进入系统
 * 2. 下载前检查 - 验证文件状态和哈希
 * 3. 异步重扫 - 定期重新扫描已存储文件
 * 4. TOCTOU 防护 - 哈希校验防止文件替换
 * 
 * 使用示例：
 * ```typescript
 * const result = await virusScan.scanBeforeUpload(file, 'document.pdf');
 * if (!result.success) {
 *   console.error('扫描失败:', result.error);
 *   return;
 * }
 * if (result.result?.status === SCAN_STATUS.THREAT_DETECTED) {
 *   console.error('发现威胁:', result.result.threatName);
 *   return;
 * }
 * // 安全，可以上传
 * ```
 */
@Injectable({ providedIn: 'root' })
export class VirusScanService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('VirusScan');
  private readonly toast = inject(ToastService);

  // ==================== 状态 ====================
  
  /** 服务是否可用 */
  readonly isAvailable = signal<boolean>(true);
  
  /** 当前扫描中的文件数 */
  readonly scanningCount = signal<number>(0);
  
  /** 最后一次扫描结果 */
  readonly lastScanResult = signal<ScanResult | null>(null);

  // ==================== 公共 API ====================

  /**
   * 上传前扫描文件
   * 阻塞操作，等待扫描完成
   * 
   * @param file 要扫描的文件
   * @param filename 文件名
   * @returns 扫描结果
   */
  async scanBeforeUpload(file: Blob, filename: string): Promise<ScanResponse> {
    // 检查是否启用上传扫描
    if (!VIRUS_SCAN_CONFIG.UPLOAD_SCAN.ENABLED) {
      this.logger.debug('上传扫描已禁用，跳过');
      return {
        success: true,
        result: this.createSkippedResult(filename, 'scan_disabled'),
      };
    }

    // 检查文件大小
    if (file.size > VIRUS_SCAN_CONFIG.UPLOAD_SCAN.MAX_FILE_SIZE) {
      this.logger.warn('文件过大，跳过扫描', { size: file.size, limit: VIRUS_SCAN_CONFIG.UPLOAD_SCAN.MAX_FILE_SIZE });
      return {
        success: true,
        result: this.createSkippedResult(filename, 'file_too_large'),
      };
    }

    // 检查文件类型是否需要扫描
    if (this.shouldSkipScan(file.type)) {
      this.logger.debug('安全文件类型，跳过扫描', { type: file.type });
      return {
        success: true,
        result: this.createSkippedResult(filename, 'safe_type'),
      };
    }

    // 执行扫描
    return this.performScan(file, filename);
  }

  /**
   * 下载前检查文件状态
   * 验证扫描状态和文件哈希
   * 
   * @param fileId 文件 ID
   * @param storedHash 存储的文件哈希（上传时计算）
   * @returns 是否允许下载
   */
  async checkBeforeDownload(fileId: string, storedHash?: string): Promise<ScanResponse> {
    if (!VIRUS_SCAN_CONFIG.DOWNLOAD_CHECK.ENABLED) {
      return { success: true };
    }

    try {
      // 获取扫描状态
      const statusResult = await this.checkScanStatus(fileId);
      
      if (!statusResult.success || !statusResult.result) {
        // 未扫描的文件处理
        return this.handleUnscannedFile(fileId);
      }

      const { result } = statusResult;

      // 检查是否发现威胁
      if (result.status === SCAN_STATUS.THREAT_DETECTED) {
        this.logger.error('文件存在威胁，阻止下载', { fileId, threat: result.threatName });
        this.toast.error('安全警告', `文件包含恶意内容: ${result.threatName}`);
        return {
          success: false,
          error: `检测到威胁: ${result.threatName}`,
          errorCode: 'THREAT_DETECTED',
          result,
        };
      }

      // 检查状态是否过期
      if (this.isScanStatusExpired(result.scannedAt)) {
        return this.handleExpiredStatus(fileId, result);
      }

      // 哈希校验（TOCTOU 防护）
      if (TOCTOU_PROTECTION.HASH_VERIFICATION && storedHash) {
        const hashValid = await this.verifyFileHash(fileId, storedHash);
        if (!hashValid) {
          this.logger.error('文件哈希不匹配，可能被篡改', { fileId });
          Sentry.captureMessage('File hash mismatch - potential TOCTOU attack', {
            level: 'error',
            tags: { type: 'security', fileId },
          });
          return {
            success: false,
            error: '文件完整性校验失败',
            errorCode: 'HASH_MISMATCH',
          };
        }
      }

      return { success: true, result };
    } catch (error) {
      this.logger.error('下载前检查失败', { error, fileId });
      // 失败时根据配置决定是否允许下载
      return { success: true }; // 默认允许，避免阻塞用户
    }
  }

  /**
   * 计算文件 SHA-256 哈希
   * 用于 TOCTOU 防护
   * 
   * @param file 文件
   * @returns 十六进制哈希字符串
   */
  async calculateFileHash(file: Blob): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 获取附件扫描元数据
   * 用于在 attachments JSONB 中存储扫描信息
   * 
   * @param result 扫描结果
   * @returns 扫描元数据
   */
  createScanMetadata(result: ScanResult): AttachmentScanMetadata {
    const metadata: AttachmentScanMetadata = {
      lastScannedAt: result.scannedAt,
      scanStatus: result.status,
      scanHistory: [
        {
          scannedAt: result.scannedAt,
          status: result.status,
          scanner: result.scanner,
        },
      ],
    };

    if (result.status === SCAN_STATUS.THREAT_DETECTED && result.threatName) {
      metadata.threat = {
        name: result.threatName,
        description: result.threatDescription || '',
        detectedAt: result.scannedAt,
      };
    }

    return metadata;
  }

  /**
   * 检查扫描服务是否可用
   */
  async checkServiceHealth(): Promise<boolean> {
    try {
      const client = this.supabase.client();
      if (!client) {
        this.isAvailable.set(false);
        return false;
      }

      const { data, error } = await client.functions.invoke('virus-scan', {
        body: { action: 'health' },
      });

      const available = !error && data?.status === 'healthy';
      this.isAvailable.set(available);
      return available;
    } catch {
      this.isAvailable.set(false);
      return false;
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 执行实际扫描
   */
  private async performScan(file: Blob, filename: string): Promise<ScanResponse> {
    this.scanningCount.update(c => c + 1);
    
    try {
      const client = this.supabase.client();
      if (!client) {
        return {
          success: false,
          error: '未连接到服务',
          errorCode: 'SERVICE_UNAVAILABLE',
        };
      }

      // 计算文件哈希（用于后续 TOCTOU 防护）
      const fileHash = await this.calculateFileHash(file);

      // 将文件转为 base64（Edge Function 需要）
      const fileBase64 = await this.blobToBase64(file);

      // 调用 Edge Function
      const { data, error } = await Promise.race([
        client.functions.invoke('virus-scan', {
          body: {
            action: 'scan',
            file: fileBase64,
            filename,
            hash: fileHash,
            mimeType: file.type,
          },
        }),
        this.createTimeoutPromise(VIRUS_SCAN_CONFIG.UPLOAD_SCAN.TIMEOUT),
      ]);

      if (error) {
        this.logger.error('扫描服务调用失败', { error });
        return this.handleScanFailure(filename, error.message);
      }

      // 解析扫描结果
      const result: ScanResult = {
        fileId: data.fileId || crypto.randomUUID(),
        status: data.status as ScanStatus,
        threatName: data.threatName,
        threatDescription: data.threatDescription,
        scannedAt: new Date().toISOString(),
        scanner: 'supabase_edge_clamav',
        engineVersion: data.engineVersion,
        signatureVersion: data.signatureVersion,
      };

      this.lastScanResult.set(result);

      // 处理威胁检测
      if (result.status === SCAN_STATUS.THREAT_DETECTED) {
        this.handleThreatDetected(result);
        return {
          success: false,
          error: `检测到威胁: ${result.threatName}`,
          errorCode: 'THREAT_DETECTED',
          result,
        };
      }

      return { success: true, result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      
      if (errorMessage.includes('timeout')) {
        return this.handleScanTimeout(filename);
      }
      
      return this.handleScanFailure(filename, errorMessage);
    } finally {
      this.scanningCount.update(c => Math.max(0, c - 1));
    }
  }

  /**
   * 检查文件扫描状态
   */
  private async checkScanStatus(fileId: string): Promise<ScanResponse> {
    try {
      const client = this.supabase.client();
      if (!client) {
        return { success: false, error: '未连接到服务' };
      }

      const { data, error } = await client.functions.invoke('virus-scan', {
        body: { action: 'status', fileId },
      });

      if (error || !data) {
        return { success: false, error: error?.message || '获取状态失败' };
      }

      return {
        success: true,
        result: data as ScanResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
      };
    }
  }

  /**
   * 验证文件哈希
   */
  private async verifyFileHash(fileId: string, expectedHash: string): Promise<boolean> {
    try {
      const client = this.supabase.client();
      if (!client) return false;

      const { data, error } = await client.functions.invoke('virus-scan', {
        body: { action: 'verify-hash', fileId, expectedHash },
      });

      return !error && data?.valid === true;
    } catch {
      return false;
    }
  }

  /**
   * 判断文件类型是否跳过扫描
   */
  private shouldSkipScan(mimeType: string): boolean {
    const { SKIP_MIME_TYPES, SCAN_MIME_TYPES } = VIRUS_SCAN_CONFIG.UPLOAD_SCAN;
    
    // 明确跳过的类型
    if (SKIP_MIME_TYPES.some(type => mimeType === type)) {
      return true;
    }

    // 检查是否匹配需要扫描的类型
    return !SCAN_MIME_TYPES.some(pattern => {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1);
        return mimeType.startsWith(prefix);
      }
      return mimeType === pattern;
    });
  }

  /**
   * 检查扫描状态是否过期
   */
  private isScanStatusExpired(scannedAt: string): boolean {
    const scanTime = new Date(scannedAt).getTime();
    const now = Date.now();
    return now - scanTime > VIRUS_SCAN_CONFIG.DOWNLOAD_CHECK.STATUS_EXPIRY;
  }

  /**
   * 处理未扫描文件
   */
  private handleUnscannedFile(fileId: string): ScanResponse {
    const action = VIRUS_SCAN_CONFIG.DOWNLOAD_CHECK.ON_UNSCANNED as string;
    
    switch (action) {
      case 'block':
        return {
          success: false,
          error: '文件未经扫描，禁止下载',
        };
      case 'warn':
        this.toast.warning('安全提示', '此文件尚未完成安全扫描');
        return { success: true };
      case 'allow':
      default:
        return { success: true };
    }
  }

  /**
   * 处理状态过期
   */
  private handleExpiredStatus(fileId: string, oldResult: ScanResult): ScanResponse {
    const action = VIRUS_SCAN_CONFIG.DOWNLOAD_CHECK.ON_EXPIRED_STATUS as string;
    
    switch (action) {
      case 'block':
        return {
          success: false,
          error: '扫描状态已过期，请等待重新扫描',
        };
      case 'rescan':
        // 触发异步重扫，但允许下载
        this.triggerAsyncRescan(fileId).catch(e => 
          this.logger.error('触发重扫失败', { error: e })
        );
        this.toast.info('安全提示', '正在后台重新扫描此文件');
        return { success: true, result: oldResult };
      case 'warn':
        this.toast.warning('安全提示', '文件扫描状态已过期');
        return { success: true, result: oldResult };
      case 'allow':
      default:
        return { success: true, result: oldResult };
    }
  }

  /**
   * 触发异步重扫
   */
  private async triggerAsyncRescan(fileId: string): Promise<void> {
    const client = this.supabase.client();
    if (!client) return;

    await client.functions.invoke('virus-scan', {
      body: { action: 'rescan', fileId },
    });
  }

  /**
   * 处理扫描超时
   */
  private handleScanTimeout(filename: string): ScanResponse {
    const action = VIRUS_SCAN_CONFIG.UPLOAD_SCAN.ON_TIMEOUT as string;
    
    this.logger.warn('扫描超时', { filename });
    
    switch (action) {
      case 'reject':
        this.toast.error('扫描超时', '文件扫描超时，请稍后重试');
        return {
          success: false,
          error: '扫描超时',
          errorCode: 'SCAN_TIMEOUT',
        };
      case 'allow_with_warning':
        this.toast.warning('安全提示', '文件扫描超时，已暂时允许上传');
        return {
          success: true,
          result: this.createPendingResult(filename),
        };
      case 'queue_for_async':
        return {
          success: true,
          result: this.createPendingResult(filename),
        };
      default:
        return {
          success: false,
          error: '扫描超时',
          errorCode: 'SCAN_TIMEOUT',
        };
    }
  }

  /**
   * 处理扫描失败
   */
  private handleScanFailure(filename: string, errorMessage: string): ScanResponse {
    const action = VIRUS_SCAN_CONFIG.UPLOAD_SCAN.ON_FAILURE as string;
    
    this.logger.error('扫描失败', { filename, error: errorMessage });
    
    switch (action) {
      case 'reject':
        this.toast.error('扫描失败', '文件安全检查失败，请稍后重试');
        return {
          success: false,
          error: errorMessage,
          errorCode: 'SCAN_FAILED',
        };
      case 'allow_with_warning':
        this.toast.warning('安全提示', '文件扫描失败，已暂时允许上传');
        return {
          success: true,
          result: this.createPendingResult(filename),
        };
      case 'queue_for_async':
        return {
          success: true,
          result: this.createPendingResult(filename),
        };
      default:
        return {
          success: false,
          error: errorMessage,
          errorCode: 'SCAN_FAILED',
        };
    }
  }

  /**
   * 处理威胁检测
   */
  private handleThreatDetected(result: ScanResult): void {
    this.logger.error('检测到恶意文件', {
      threatName: result.threatName,
      threatDescription: result.threatDescription,
    });

    // 通知用户
    if (VIRUS_SCAN_CONFIG.SCAN_RESULT.NOTIFY_USER) {
      this.toast.error(
        '安全警告',
        `文件包含恶意内容: ${result.threatName}`,
        { duration: 10000 }
      );
    }

    // 上报 Sentry
    if (VIRUS_SCAN_CONFIG.SCAN_RESULT.REPORT_TO_SENTRY) {
      Sentry.captureMessage('Malware detected in uploaded file', {
        level: 'warning',
        tags: { type: 'security', category: 'malware' },
        extra: {
          threatName: result.threatName,
          threatDescription: result.threatDescription,
          scanner: result.scanner,
        },
      });
    }
  }

  /**
   * 创建跳过扫描的结果
   */
  private createSkippedResult(filename: string, reason: string): ScanResult {
    return {
      fileId: crypto.randomUUID(),
      status: SCAN_STATUS.SKIPPED,
      scannedAt: new Date().toISOString(),
      scanner: 'local',
      threatDescription: `跳过扫描: ${reason}`,
    };
  }

  /**
   * 创建待扫描的结果
   */
  private createPendingResult(filename: string): ScanResult {
    return {
      fileId: crypto.randomUUID(),
      status: SCAN_STATUS.PENDING,
      scannedAt: new Date().toISOString(),
      scanner: 'pending',
    };
  }

  /**
   * 将 Blob 转换为 base64
   */
  private async blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // 移除 data URL 前缀
        const base64 = result.split(',')[1] || result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), ms);
    });
  }
}
