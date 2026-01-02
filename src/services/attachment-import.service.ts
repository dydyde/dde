/**
 * AttachmentImportService - 附件导入服务
 * 
 * 【Week 8-9 数据保护 - 附件导入（分批）】
 * 职责：
 * - 从 ZIP 文件中提取附件
 * - 分批上传到 Supabase Storage
 * - 配额检查和进度反馈
 * - 错误处理和重试
 * 
 * 设计理念：
 * - 分批上传避免内存溢出
 * - 配额检查在上传前
 * - 断点续传支持（后续迭代）
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { Attachment, AttachmentType } from '../models';
import { ATTACHMENT_CONFIG } from '../config';

// ============================================
// 配置
// ============================================

export const ATTACHMENT_IMPORT_CONFIG = {
  /** 并发上传数量 */
  CONCURRENT_UPLOADS: 3,
  
  /** 单批最大文件数 */
  BATCH_SIZE: 10,
  
  /** 重试次数 */
  MAX_RETRIES: 2,
  
  /** 重试延迟（毫秒） */
  RETRY_DELAY: 1000,
  
  /** 配额警告阈值（使用百分比） */
  QUOTA_WARNING_THRESHOLD: 0.8,
} as const;

// ============================================
// 类型定义
// ============================================

export interface AttachmentImportItem {
  /** 任务 ID */
  taskId: string;
  /** 附件元数据 */
  metadata: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
  };
  /** 文件数据（从 ZIP 提取） */
  data?: Blob;
  /** 在 ZIP 中的路径 */
  zipPath?: string;
}

export interface AttachmentImportProgress {
  stage: 'idle' | 'extracting' | 'checking-quota' | 'uploading' | 'completed' | 'error';
  percentage: number;
  currentItem?: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
}

export interface AttachmentImportResult {
  success: boolean;
  imported: number;
  failed: number;
  skipped: number;
  errors: Array<{
    taskId: string;
    attachmentName: string;
    error: string;
  }>;
}

export interface QuotaCheckResult {
  hasQuota: boolean;
  usedBytes: number;
  totalBytes: number;
  requiredBytes: number;
  message?: string;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class AttachmentImportService {
  private readonly logger = inject(LoggerService).category('AttachmentImport');
  private readonly toast = inject(ToastService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly auth = inject(AuthService);
  
  // ==================== 状态 ====================
  
  private readonly _progress = signal<AttachmentImportProgress>({
    stage: 'idle',
    percentage: 0,
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    skippedItems: 0,
  });
  readonly progress = this._progress.asReadonly();
  
  private readonly _isImporting = signal(false);
  readonly isImporting = this._isImporting.asReadonly();
  
  private abortController: AbortController | null = null;
  
  // ==================== 公共方法 ====================
  
  /**
   * 导入附件
   * 
   * @param projectId 项目 ID
   * @param items 待导入的附件列表
   * @returns 导入结果
   */
  async importAttachments(
    projectId: string,
    items: AttachmentImportItem[]
  ): Promise<AttachmentImportResult> {
    if (this._isImporting()) {
      return {
        success: false,
        imported: 0,
        failed: 0,
        skipped: 0,
        errors: [{ taskId: '', attachmentName: '', error: '已有导入任务进行中' }]
      };
    }
    
    const userId = this.auth.currentUserId();
    if (!userId) {
      return {
        success: false,
        imported: 0,
        failed: 0,
        skipped: items.length,
        errors: [{ taskId: '', attachmentName: '', error: '未登录' }]
      };
    }
    
    this._isImporting.set(true);
    this.abortController = new AbortController();
    
    const result: AttachmentImportResult = {
      success: false,
      imported: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };
    
    try {
      // 阶段 1：过滤有效项
      const validItems = items.filter(item => item.data);
      const skippedCount = items.length - validItems.length;
      result.skipped = skippedCount;
      
      if (validItems.length === 0) {
        this.logger.info('无有效附件需要导入');
        result.success = true;
        return result;
      }
      
      this.updateProgress('checking-quota', 5, undefined, validItems.length);
      
      // 阶段 2：配额检查
      const totalSize = validItems.reduce((sum, item) => sum + item.metadata.size, 0);
      const quotaCheck = await this.checkQuota(totalSize);
      
      if (!quotaCheck.hasQuota) {
        this.toast.error(
          '存储配额不足',
          quotaCheck.message ?? '请清理一些附件后重试',
          { duration: 5000 }
        );
        result.errors.push({
          taskId: '',
          attachmentName: '',
          error: quotaCheck.message ?? '存储配额不足',
        });
        return result;
      }
      
      // 阶段 3：分批上传
      this.updateProgress('uploading', 10, undefined, validItems.length);
      
      const batches = this.createBatches(validItems, ATTACHMENT_IMPORT_CONFIG.BATCH_SIZE);
      let processedCount = 0;
      
      for (const batch of batches) {
        if (this.abortController?.signal.aborted) {
          this.logger.info('导入已被用户取消');
          break;
        }
        
        // 并发处理批次内的项目
        const batchResults = await this.processBatch(
          userId,
          projectId,
          batch
        );
        
        for (const batchResult of batchResults) {
          processedCount++;
          
          if (batchResult.success) {
            result.imported++;
          } else {
            result.failed++;
            result.errors.push({
              taskId: batchResult.taskId,
              attachmentName: batchResult.attachmentName,
              error: batchResult.error ?? '上传失败',
            });
          }
          
          const percentage = 10 + (processedCount / validItems.length) * 85;
          this.updateProgress('uploading', percentage, batchResult.attachmentName, validItems.length);
        }
      }
      
      // 完成
      this.updateProgress('completed', 100, undefined, validItems.length);
      result.success = result.failed === 0;
      
      this.logger.info('附件导入完成', {
        imported: result.imported,
        failed: result.failed,
        skipped: result.skipped,
      });
      
      return result;
      
    } catch (error) {
      this.logger.error('附件导入失败', error);
      this.updateProgress('error', 0);
      result.errors.push({
        taskId: '',
        attachmentName: '',
        error: error instanceof Error ? error.message : '未知错误',
      });
      return result;
      
    } finally {
      this._isImporting.set(false);
      this.abortController = null;
    }
  }
  
  /**
   * 取消导入
   */
  cancelImport(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.logger.info('用户取消了附件导入');
    }
  }
  
  /**
   * 重置进度
   */
  resetProgress(): void {
    this._progress.set({
      stage: 'idle',
      percentage: 0,
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
    });
  }
  
  /**
   * 检查存储配额
   * 
   * @param requiredBytes 需要的字节数
   */
  async checkQuota(requiredBytes: number): Promise<QuotaCheckResult> {
    // 简化实现：假设配额充足
    // 完整实现应该查询 Supabase Storage 使用量
    const storageLimit = 100 * 1024 * 1024; // 100MB 默认
    
    // TODO: 实际查询使用量
    // const usedBytes = await this.getStorageUsage();
    const usedBytes = 0;
    
    const remainingBytes = storageLimit - usedBytes;
    const hasQuota = remainingBytes >= requiredBytes;
    
    if (!hasQuota) {
      return {
        hasQuota: false,
        usedBytes,
        totalBytes: storageLimit,
        requiredBytes,
        message: `存储空间不足：需要 ${this.formatBytes(requiredBytes)}，剩余 ${this.formatBytes(remainingBytes)}`,
      };
    }
    
    // 检查警告阈值
    const usageRatio = (usedBytes + requiredBytes) / storageLimit;
    if (usageRatio > ATTACHMENT_IMPORT_CONFIG.QUOTA_WARNING_THRESHOLD) {
      return {
        hasQuota: true,
        usedBytes,
        totalBytes: storageLimit,
        requiredBytes,
        message: `警告：导入后存储使用率将达到 ${Math.round(usageRatio * 100)}%`,
      };
    }
    
    return {
      hasQuota: true,
      usedBytes,
      totalBytes: storageLimit,
      requiredBytes,
    };
  }
  
  /**
   * 从 ZIP 数据中提取附件信息
   * 这是一个占位方法，实际实现需要 ZIP 解析库
   * 
   * @param zipData ZIP 文件数据
   * @returns 附件导入项列表
   */
  async extractAttachmentsFromZip(
    zipData: ArrayBuffer,
    taskAttachmentMap: Map<string, Array<{ id: string; name: string; size: number; mimeType: string }>>
  ): Promise<AttachmentImportItem[]> {
    const items: AttachmentImportItem[] = [];
    
    // TODO: 使用 ZIP 解析库（如 JSZip）提取附件
    // 这里只创建元数据占位符
    
    for (const [taskId, attachments] of taskAttachmentMap) {
      for (const att of attachments) {
        items.push({
          taskId,
          metadata: {
            id: att.id,
            name: att.name,
            size: att.size,
            mimeType: att.mimeType,
          },
          // data: 需要从 ZIP 中提取
          zipPath: `attachments/${taskId}/${att.id}`,
        });
      }
    }
    
    return items;
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 创建批次
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
  
  /**
   * 处理单个批次
   */
  private async processBatch(
    userId: string,
    projectId: string,
    batch: AttachmentImportItem[]
  ): Promise<Array<{
    success: boolean;
    taskId: string;
    attachmentName: string;
    attachment?: Attachment;
    error?: string;
  }>> {
    const results: Array<{
      success: boolean;
      taskId: string;
      attachmentName: string;
      attachment?: Attachment;
      error?: string;
    }> = [];
    
    // 并发上传，但限制并发数
    const semaphore = new Semaphore(ATTACHMENT_IMPORT_CONFIG.CONCURRENT_UPLOADS);
    
    const promises = batch.map(async (item) => {
      await semaphore.acquire();
      
      try {
        if (!item.data) {
          return {
            success: false,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            error: '附件数据缺失',
          };
        }
        
        // 将 Blob 转换为 File
        const file = new File([item.data], item.metadata.name, {
          type: item.metadata.mimeType,
        });
        
        // 使用 AttachmentService 上传
        const uploadResult = await this.attachmentService.uploadFile(
          userId,
          projectId,
          item.taskId,
          file
        );
        
        if (uploadResult.success && uploadResult.attachment) {
          return {
            success: true,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            attachment: uploadResult.attachment,
          };
        } else {
          return {
            success: false,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            error: uploadResult.error ?? '上传失败',
          };
        }
        
      } catch (error) {
        return {
          success: false,
          taskId: item.taskId,
          attachmentName: item.metadata.name,
          error: error instanceof Error ? error.message : '未知错误',
        };
        
      } finally {
        semaphore.release();
      }
    });
    
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    
    return results;
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: AttachmentImportProgress['stage'],
    percentage: number,
    currentItem?: string,
    totalItems?: number
  ): void {
    this._progress.update(p => ({
      ...p,
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
      totalItems: totalItems ?? p.totalItems,
    }));
  }
  
  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// ============================================
// 辅助类：信号量（用于并发控制）
// ============================================

class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
  
  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next?.();
    } else {
      this.permits++;
    }
  }
}
