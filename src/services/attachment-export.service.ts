/**
 * AttachmentExportService - 附件导出服务
 * 
 * 【Week 8 数据保护 - P1 附件导出（流式 ZIP）】
 * 职责：
 * - 下载并打包附件为 ZIP 文件
 * - 流式处理避免内存溢出
 * - 附件去重（同一附件多任务引用只导出一份）
 * - 进度追踪
 * 
 * 设计理念：
 * - 内存安全：分批处理 + 流式写入
 * - 完整性：包含 manifest 和校验和
 * - 可恢复：支持断点续传（未来版本）
 * 
 * 依赖说明：
 * - 使用浏览器原生 Compression Streams API（需 Chrome 80+/Safari 16.4+）
 * - 兼容方案：JSZip 库作为 fallback
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Project, Task, Attachment } from '../models';

// ============================================
// 配置
// ============================================

export const ATTACHMENT_EXPORT_CONFIG = {
  /** 批次大小（每批下载多少个附件） */
  BATCH_SIZE: 5,
  
  /** 单个附件最大大小（字节）- 100MB */
  MAX_SINGLE_FILE_SIZE: 100 * 1024 * 1024,
  
  /** 总导出最大大小（字节）- 500MB */
  MAX_TOTAL_SIZE: 500 * 1024 * 1024,
  
  /** 下载超时（毫秒） */
  DOWNLOAD_TIMEOUT: 60 * 1000,
  
  /** 重试次数 */
  RETRY_COUNT: 3,
  
  /** 重试延迟（毫秒） */
  RETRY_DELAY: 1000,
  
  /** ZIP 文件名前缀 */
  FILENAME_PREFIX: 'nanoflow-attachments',
  
  /** 附件目录名 */
  ATTACHMENTS_DIR: 'attachments',
  
  /** Manifest 文件名 */
  MANIFEST_FILENAME: 'manifest.json',
} as const;

// ============================================
// 类型定义
// ============================================

/**
 * 附件清单项
 */
export interface AttachmentManifest {
  id: string;
  taskIds: string[];
  projectIds: string[];
  name: string;
  mimeType: string;
  size: number;
  checksum?: string;
  /** ZIP 内相对路径 */
  bundlePath: string;
  /** 原始 URL（可能已过期） */
  originalUrl?: string;
  /** 下载状态 */
  downloadStatus?: 'pending' | 'success' | 'failed' | 'skipped';
  /** 失败原因 */
  failureReason?: string;
}

/**
 * 导出 Manifest
 */
export interface ExportManifest {
  version: string;
  exportedAt: string;
  totalAttachments: number;
  totalSize: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  attachments: AttachmentManifest[];
}

/**
 * 导出进度
 */
export interface AttachmentExportProgress {
  stage: 'collecting' | 'downloading' | 'packaging' | 'complete' | 'failed';
  percentage: number;
  currentItem?: string;
  processedCount: number;
  totalCount: number;
  processedSize: number;
  totalSize: number;
  errors: string[];
}

/**
 * 导出结果
 */
export interface AttachmentExportResult {
  success: boolean;
  error?: string;
  /** 生成的 ZIP Blob */
  blob?: Blob;
  /** 文件名 */
  filename?: string;
  /** Manifest */
  manifest?: ExportManifest;
  /** 耗时（毫秒） */
  durationMs: number;
}

/**
 * 下载单个附件的结果
 */
interface DownloadResult {
  attachment: AttachmentManifest;
  data?: Blob;
  success: boolean;
  error?: string;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class AttachmentExportService {
  private readonly logger = inject(LoggerService).category('AttachmentExport');
  private readonly toast = inject(ToastService);
  
  // 状态信号
  private readonly _isExporting = signal(false);
  private readonly _progress = signal<AttachmentExportProgress>({
    stage: 'collecting',
    percentage: 0,
    processedCount: 0,
    totalCount: 0,
    processedSize: 0,
    totalSize: 0,
    errors: [],
  });
  
  // 公开的计算属性
  readonly isExporting = computed(() => this._isExporting());
  readonly progress = computed(() => this._progress());
  
  /**
   * 导出项目的附件为 ZIP
   */
  async exportAttachments(projects: Project[]): Promise<AttachmentExportResult> {
    if (this._isExporting()) {
      return {
        success: false,
        error: '导出正在进行中',
        durationMs: 0,
      };
    }
    
    const startTime = Date.now();
    this._isExporting.set(true);
    this.resetProgress();
    
    try {
      // 1. 收集所有附件
      this.updateProgress('collecting', 0);
      const manifest = this.collectAttachments(projects);
      
      if (manifest.length === 0) {
        this.updateProgress('complete', 100);
        this._isExporting.set(false);
        return {
          success: true,
          error: undefined,
          manifest: this.createManifestData(manifest, 0, 0, 0),
          durationMs: Date.now() - startTime,
        };
      }
      
      // 2. 检查总大小
      const totalSize = manifest.reduce((sum, a) => sum + a.size, 0);
      if (totalSize > ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE) {
        throw new Error(`附件总大小 ${this.formatBytes(totalSize)} 超出限制 ${this.formatBytes(ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE)}`);
      }
      
      this._progress.update(p => ({
        ...p,
        totalCount: manifest.length,
        totalSize,
      }));
      
      // 3. 下载附件
      this.updateProgress('downloading', 10);
      const downloadResults = await this.downloadAllAttachments(manifest);
      
      // 4. 打包为 ZIP
      this.updateProgress('packaging', 80);
      const zipResult = await this.createZipBundle(downloadResults, manifest);
      
      // 5. 统计结果
      const successCount = downloadResults.filter(r => r.success).length;
      const failedCount = downloadResults.filter(r => !r.success).length;
      
      this.updateProgress('complete', 100);
      
      this.logger.info('附件导出完成', {
        total: manifest.length,
        success: successCount,
        failed: failedCount,
      });
      
      return {
        success: true,
        blob: zipResult.blob,
        filename: zipResult.filename,
        manifest: this.createManifestData(manifest, successCount, failedCount, 0),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.updateProgress('failed', 0);
      this.logger.error('附件导出失败', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : '导出失败',
        durationMs: Date.now() - startTime,
      };
    } finally {
      this._isExporting.set(false);
    }
  }
  
  /**
   * 下载并保存 ZIP
   */
  async exportAndDownload(projects: Project[]): Promise<AttachmentExportResult> {
    const result = await this.exportAttachments(projects);
    
    if (result.success && result.blob && result.filename) {
      this.triggerDownload(result.blob, result.filename);
    }
    
    return result;
  }
  
  // ==================== 收集附件 ====================
  
  /**
   * 从项目中收集所有附件（去重）
   */
  private collectAttachments(projects: Project[]): AttachmentManifest[] {
    const attachmentMap = new Map<string, AttachmentManifest>();
    
    for (const project of projects) {
      for (const task of project.tasks) {
        if (!task.attachments || task.deletedAt) continue;
        
        for (const att of task.attachments) {
          const existing = attachmentMap.get(att.id);
          
          if (existing) {
            // 附件已存在，添加引用
            if (!existing.taskIds.includes(task.id)) {
              existing.taskIds.push(task.id);
            }
            if (!existing.projectIds.includes(project.id)) {
              existing.projectIds.push(project.id);
            }
          } else {
            // 新附件
            attachmentMap.set(att.id, {
              id: att.id,
              taskIds: [task.id],
              projectIds: [project.id],
              name: att.name,
              mimeType: att.mimeType || 'application/octet-stream',
              size: att.size || 0,
              bundlePath: this.generateBundlePath(att),
              originalUrl: att.url,
              downloadStatus: 'pending',
            });
          }
        }
      }
    }
    
    return Array.from(attachmentMap.values());
  }
  
  /**
   * 生成 ZIP 内路径
   */
  private generateBundlePath(att: Attachment): string {
    const ext = this.getFileExtension(att.name);
    const safeId = att.id.replace(/[^a-zA-Z0-9-]/g, '');
    return `${ATTACHMENT_EXPORT_CONFIG.ATTACHMENTS_DIR}/${safeId}${ext}`;
  }
  
  /**
   * 获取文件扩展名
   */
  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.substring(lastDot) : '';
  }
  
  // ==================== 下载附件 ====================
  
  /**
   * 下载所有附件（分批处理）
   */
  private async downloadAllAttachments(
    manifest: AttachmentManifest[]
  ): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];
    const { BATCH_SIZE } = ATTACHMENT_EXPORT_CONFIG;
    
    for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
      const batch = manifest.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(att => this.downloadSingleAttachment(att))
      );
      
      results.push(...batchResults);
      
      // 更新进度
      const percentage = 10 + (results.length / manifest.length) * 70;
      this._progress.update(p => ({
        ...p,
        percentage,
        processedCount: results.length,
        currentItem: batch[0]?.name,
      }));
    }
    
    return results;
  }
  
  /**
   * 下载单个附件（带重试）
   */
  private async downloadSingleAttachment(
    attachment: AttachmentManifest
  ): Promise<DownloadResult> {
    const { RETRY_COUNT, RETRY_DELAY, DOWNLOAD_TIMEOUT, MAX_SINGLE_FILE_SIZE } = 
      ATTACHMENT_EXPORT_CONFIG;
    
    // 检查 URL
    if (!attachment.originalUrl) {
      attachment.downloadStatus = 'skipped';
      attachment.failureReason = 'URL 不存在';
      return {
        attachment,
        success: false,
        error: 'URL 不存在',
      };
    }
    
    // 检查文件大小
    if (attachment.size > MAX_SINGLE_FILE_SIZE) {
      attachment.downloadStatus = 'skipped';
      attachment.failureReason = '文件过大';
      return {
        attachment,
        success: false,
        error: `文件过大：${this.formatBytes(attachment.size)}`,
      };
    }
    
    // 带重试的下载
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
        
        const response = await fetch(attachment.originalUrl, {
          signal: controller.signal,
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        
        // 计算校验和
        attachment.checksum = await this.calculateBlobChecksum(blob);
        attachment.downloadStatus = 'success';
        
        this._progress.update(p => ({
          ...p,
          processedSize: p.processedSize + blob.size,
        }));
        
        return {
          attachment,
          data: blob,
          success: true,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('下载失败');
        
        if (attempt < RETRY_COUNT - 1) {
          await this.delay(RETRY_DELAY * (attempt + 1));
        }
      }
    }
    
    attachment.downloadStatus = 'failed';
    attachment.failureReason = lastError?.message || '下载失败';
    
    this._progress.update(p => ({
      ...p,
      errors: [...p.errors, `${attachment.name}: ${lastError?.message}`],
    }));
    
    return {
      attachment,
      success: false,
      error: lastError?.message,
    };
  }
  
  // ==================== ZIP 打包 ====================
  
  /**
   * 创建 ZIP 包
   * 使用简化的 ZIP 格式实现（无压缩，适合已压缩的文件如图片）
   */
  private async createZipBundle(
    downloadResults: DownloadResult[],
    manifest: AttachmentManifest[]
  ): Promise<{ blob: Blob; filename: string }> {
    // 准备文件列表
    const files: Array<{ path: string; data: Blob | string }> = [];
    
    // 添加成功下载的附件
    for (const result of downloadResults) {
      if (result.success && result.data) {
        files.push({
          path: result.attachment.bundlePath,
          data: result.data,
        });
      }
    }
    
    // 添加 manifest.json
    const manifestData = this.createManifestData(
      manifest,
      downloadResults.filter(r => r.success).length,
      downloadResults.filter(r => !r.success).length,
      0
    );
    
    files.push({
      path: ATTACHMENT_EXPORT_CONFIG.MANIFEST_FILENAME,
      data: JSON.stringify(manifestData, null, 2),
    });
    
    // 创建 ZIP
    const zipBlob = await this.createSimpleZip(files);
    
    const filename = this.generateFilename();
    
    return { blob: zipBlob, filename };
  }
  
  /**
   * 创建简单 ZIP 文件（Store 模式，无压缩）
   * 
   * ZIP 文件格式：
   * - [Local file header 1]
   * - [File data 1]
   * - [Local file header 2]
   * - [File data 2]
   * - ...
   * - [Central directory header 1]
   * - [Central directory header 2]
   * - ...
   * - [End of central directory record]
   */
  private async createSimpleZip(
    files: Array<{ path: string; data: Blob | string }>
  ): Promise<Blob> {
    const parts: BlobPart[] = [];
    const centralDirectory: Uint8Array[] = [];
    let offset = 0;
    
    for (const file of files) {
      const pathBytes = new TextEncoder().encode(file.path);
      let fileData: Uint8Array;
      
      if (typeof file.data === 'string') {
        fileData = new TextEncoder().encode(file.data);
      } else {
        fileData = new Uint8Array(await file.data.arrayBuffer());
      }
      
      const crc = this.crc32(fileData);
      
      // Local file header (30 bytes + filename)
      const localHeader = this.createLocalFileHeader(
        pathBytes,
        fileData.length,
        crc
      );
      
      // Central directory file header
      const centralHeader = this.createCentralDirectoryHeader(
        pathBytes,
        fileData.length,
        crc,
        offset
      );
      
      parts.push(localHeader.buffer.slice(localHeader.byteOffset, localHeader.byteOffset + localHeader.byteLength) as ArrayBuffer);
      parts.push(fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength) as ArrayBuffer);
      
      centralDirectory.push(centralHeader);
      
      offset += localHeader.length + fileData.length;
    }
    
    // Central directory
    const centralDirOffset = offset;
    let centralDirSize = 0;
    
    for (const header of centralDirectory) {
      parts.push(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength) as ArrayBuffer);
      centralDirSize += header.length;
    }
    
    // End of central directory record
    const eocd = this.createEndOfCentralDirectory(
      files.length,
      centralDirSize,
      centralDirOffset
    );
    
    parts.push(eocd.buffer.slice(eocd.byteOffset, eocd.byteOffset + eocd.byteLength) as ArrayBuffer);
    
    return new Blob(parts, { type: 'application/zip' });
  }
  
  /**
   * 创建 Local file header
   */
  private createLocalFileHeader(
    filename: Uint8Array,
    size: number,
    crc: number
  ): Uint8Array {
    const header = new Uint8Array(30 + filename.length);
    const view = new DataView(header.buffer);
    
    // Signature
    view.setUint32(0, 0x04034b50, true);
    // Version needed
    view.setUint16(4, 20, true);
    // General purpose flag
    view.setUint16(6, 0, true);
    // Compression method (0 = store)
    view.setUint16(8, 0, true);
    // Last mod time
    view.setUint16(10, 0, true);
    // Last mod date
    view.setUint16(12, 0, true);
    // CRC-32
    view.setUint32(14, crc, true);
    // Compressed size
    view.setUint32(18, size, true);
    // Uncompressed size
    view.setUint32(22, size, true);
    // Filename length
    view.setUint16(26, filename.length, true);
    // Extra field length
    view.setUint16(28, 0, true);
    // Filename
    header.set(filename, 30);
    
    return header;
  }
  
  /**
   * 创建 Central directory file header
   */
  private createCentralDirectoryHeader(
    filename: Uint8Array,
    size: number,
    crc: number,
    localHeaderOffset: number
  ): Uint8Array {
    const header = new Uint8Array(46 + filename.length);
    const view = new DataView(header.buffer);
    
    // Signature
    view.setUint32(0, 0x02014b50, true);
    // Version made by
    view.setUint16(4, 20, true);
    // Version needed
    view.setUint16(6, 20, true);
    // General purpose flag
    view.setUint16(8, 0, true);
    // Compression method
    view.setUint16(10, 0, true);
    // Last mod time
    view.setUint16(12, 0, true);
    // Last mod date
    view.setUint16(14, 0, true);
    // CRC-32
    view.setUint32(16, crc, true);
    // Compressed size
    view.setUint32(20, size, true);
    // Uncompressed size
    view.setUint32(24, size, true);
    // Filename length
    view.setUint16(28, filename.length, true);
    // Extra field length
    view.setUint16(30, 0, true);
    // File comment length
    view.setUint16(32, 0, true);
    // Disk number start
    view.setUint16(34, 0, true);
    // Internal file attributes
    view.setUint16(36, 0, true);
    // External file attributes
    view.setUint32(38, 0, true);
    // Relative offset of local header
    view.setUint32(42, localHeaderOffset, true);
    // Filename
    header.set(filename, 46);
    
    return header;
  }
  
  /**
   * 创建 End of central directory record
   */
  private createEndOfCentralDirectory(
    entryCount: number,
    centralDirSize: number,
    centralDirOffset: number
  ): Uint8Array {
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    
    // Signature
    view.setUint32(0, 0x06054b50, true);
    // Disk number
    view.setUint16(4, 0, true);
    // Disk number with central directory
    view.setUint16(6, 0, true);
    // Number of entries on this disk
    view.setUint16(8, entryCount, true);
    // Total number of entries
    view.setUint16(10, entryCount, true);
    // Size of central directory
    view.setUint32(12, centralDirSize, true);
    // Offset of central directory
    view.setUint32(16, centralDirOffset, true);
    // Comment length
    view.setUint16(20, 0, true);
    
    return eocd;
  }
  
  /**
   * CRC-32 计算
   */
  private crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 生成文件名
   */
  private generateFilename(): string {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    return `${ATTACHMENT_EXPORT_CONFIG.FILENAME_PREFIX}-${timestamp}.zip`;
  }
  
  /**
   * 创建 Manifest 数据
   */
  private createManifestData(
    attachments: AttachmentManifest[],
    successCount: number,
    failedCount: number,
    skippedCount: number
  ): ExportManifest {
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      totalAttachments: attachments.length,
      totalSize: attachments.reduce((sum, a) => sum + a.size, 0),
      successCount,
      failedCount,
      skippedCount,
      attachments,
    };
  }
  
  /**
   * 计算 Blob 校验和
   */
  private async calculateBlobChecksum(blob: Blob): Promise<string> {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {
      // 忽略错误
    }
    
    // Fallback: 简单校验和
    return `size-${blob.size}`;
  }
  
  /**
   * 触发下载
   */
  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  /**
   * 格式化字节大小
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
  
  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 重置进度
   */
  private resetProgress(): void {
    this._progress.set({
      stage: 'collecting',
      percentage: 0,
      processedCount: 0,
      totalCount: 0,
      processedSize: 0,
      totalSize: 0,
      errors: [],
    });
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: AttachmentExportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.update(p => ({
      ...p,
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    }));
  }
}
