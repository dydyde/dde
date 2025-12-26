import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Attachment, AttachmentType } from '../models';
import { ATTACHMENT_CONFIG } from '../config';
import { supabaseErrorToError } from '../utils/supabase-error';

/**
 * 上传进度
 */
export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled';
  error?: string;
}

/**
 * 安全的路径段验证
 * 防止路径遍历攻击
 */
function sanitizePathSegment(segment: string): string {
  // 移除路径遍历字符和特殊字符
  return segment
    .replace(/\.\.+/g, '') // 移除 ..
    .replace(/[\/\\]/g, '') // 移除斜杠
    .replace(/[<>:"|?*\x00-\x1f]/g, '') // 移除不安全字符
    .trim();
}

/**
 * 验证路径段是否安全
 * 允许 UUID 格式（包含连字符）和常见安全字符
 */
function isValidPathSegment(segment: string): boolean {
  if (!segment || segment.length === 0) return false;
  if (segment.length > 255) return false;
  if (segment.includes('..')) return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  // 允许字母、数字、下划线和连字符（UUID 需要连字符）
  return /^[a-zA-Z0-9_\-]+$/.test(segment);
}

/**
 * 附件上传服务
 * 负责与 Supabase Storage 的文件上传、下载、删除操作
 * 包含自动 URL 刷新机制和上传取消支持
 */
@Injectable({
  providedIn: 'root'
})
export class AttachmentService {
  private supabase = inject(SupabaseClientService);
  private destroyRef = inject(DestroyRef);

  /** 当前上传进度 */
  readonly uploadProgress = signal<UploadProgress[]>([]);

  /** 是否正在上传 */
  readonly isUploading = signal(false);

  /** URL 刷新定时器 */
  private urlRefreshTimer: ReturnType<typeof setInterval> | null = null;
  
  /** URL 刷新回调（由使用者注册） */
  private urlRefreshCallback: ((refreshedUrls: Map<string, { url: string; thumbnailUrl?: string }>) => void) | null = null;
  
  /** 需要监控刷新的附件列表 */
  private monitoredAttachments: Map<string, { userId: string; projectId: string; taskId: string; attachment: Attachment }> = new Map();

  /** 上传取消控制器映射 (fileName -> AbortController) */
  private uploadAbortControllers: Map<string, AbortController> = new Map();

  constructor() {
    this.startUrlRefreshMonitor();
    
    // 使用 DestroyRef 替代 ngOnDestroy，确保 root 服务也能正确清理
    this.destroyRef.onDestroy(() => {
      this.stopUrlRefreshMonitor();
      this.cancelAllUploads();
      this.clearUrlRefreshCallback();
      this.clearMonitoredAttachments();
    });
  }

  /**
   * 启动 URL 刷新监控
   */
  private startUrlRefreshMonitor() {
    if (this.urlRefreshTimer) return;
    
    this.urlRefreshTimer = setInterval(async () => {
      await this.checkAndRefreshExpiredUrls();
    }, ATTACHMENT_CONFIG.URL_REFRESH_CHECK_INTERVAL);
  }

  /**
   * 停止 URL 刷新监控
   */
  private stopUrlRefreshMonitor() {
    if (this.urlRefreshTimer) {
      clearInterval(this.urlRefreshTimer);
      this.urlRefreshTimer = null;
    }
  }

  /**
   * 注册 URL 刷新回调
   */
  setUrlRefreshCallback(callback: (refreshedUrls: Map<string, { url: string; thumbnailUrl?: string }>) => void) {
    this.urlRefreshCallback = callback;
  }

  /**
   * 清除 URL 刷新回调
   * 在组件销毁时调用，防止内存泄漏
   */
  clearUrlRefreshCallback() {
    this.urlRefreshCallback = null;
  }

  /**
   * 添加附件到监控列表
   */
  monitorAttachment(userId: string, projectId: string, taskId: string, attachment: Attachment) {
    this.monitoredAttachments.set(attachment.id, { userId, projectId, taskId, attachment });
  }

  /**
   * 从监控列表移除附件
   */
  unmonitorAttachment(attachmentId: string) {
    this.monitoredAttachments.delete(attachmentId);
  }

  /**
   * 清空监控列表
   */
  clearMonitoredAttachments() {
    this.monitoredAttachments.clear();
  }

  /**
   * 用户登出时调用
   * 停止 URL 刷新定时器，防止尝试刷新已失效的 URL
   * 
   * 设计理念：
   * - 用户登出后，所有签名 URL 都已失效
   * - 继续刷新只会产生无效请求
   * - 新用户登录后会重新启动监控
   */
  onUserLogout(): void {
    // 停止 URL 刷新监控
    this.stopUrlRefreshMonitor();
    
    // 清空监控列表
    this.clearMonitoredAttachments();
    
    // 取消所有进行中的上传
    this.cancelAllUploads();
    
    // 清除回调
    this.clearUrlRefreshCallback();
    
    // 清除上传进度
    this.clearProgress();
  }
  
  /**
   * 用户登录后调用
   * 重新启动 URL 刷新监控
   */
  onUserLogin(): void {
    this.startUrlRefreshMonitor();
  }

  /**
   * 检查并刷新过期的 URL
   */
  private async checkAndRefreshExpiredUrls() {
    if (this.monitoredAttachments.size === 0 || !this.supabase.isConfigured) return;

    const refreshedUrls = new Map<string, { url: string; thumbnailUrl?: string; signedAt: string }>();
    const now = Date.now();
    const expiryBuffer = ATTACHMENT_CONFIG.URL_EXPIRY_BUFFER;

    for (const [id, { userId, projectId, taskId, attachment }] of this.monitoredAttachments) {
      // 检查 URL 是否即将过期（优先使用 signedAt，fallback 到 createdAt）
      const signedAt = attachment.signedAt ? new Date(attachment.signedAt).getTime() : new Date(attachment.createdAt).getTime();
      const urlAge = now - signedAt;
      
      // 如果 URL 年龄超过缓冲时间，刷新它
      if (urlAge > expiryBuffer) {
        try {
          const newUrls = await this.refreshUrl(userId, projectId, taskId, attachment);
          if (newUrls) {
            const signedAtNow = new Date().toISOString();
            refreshedUrls.set(id, { ...newUrls, signedAt: signedAtNow });
            // 更新监控列表中的附件
            this.monitoredAttachments.set(id, {
              userId, projectId, taskId,
              attachment: { ...attachment, url: newUrls.url, thumbnailUrl: newUrls.thumbnailUrl, signedAt: signedAtNow }
            });
          }
        } catch (e) {
          // URL 刷新失败，静默处理，下次检查会重试
          console.warn(`刷新附件 URL 失败: ${id}`, e);
        }
      }
    }

    // 通知回调
    if (refreshedUrls.size > 0 && this.urlRefreshCallback) {
      this.urlRefreshCallback(refreshedUrls);
    }
  }

  /**
   * 上传文件
   * 支持取消操作：调用 cancelUpload(fileName) 可取消进行中的上传
   * @param userId 用户 ID
   * @param projectId 项目 ID
   * @param taskId 任务 ID
   * @param file 文件对象
   * @returns 附件对象
   */
  async uploadFile(
    userId: string,
    projectId: string,
    taskId: string,
    file: File
  ): Promise<{ success: boolean; attachment?: Attachment; error?: string; cancelled?: boolean }> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Supabase 未配置' };
    }

    // 验证文件大小
    if (file.size > ATTACHMENT_CONFIG.MAX_FILE_SIZE) {
      return { success: false, error: `文件大小不能超过 ${ATTACHMENT_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB` };
    }

    // 验证路径参数安全性
    if (!isValidPathSegment(userId)) {
      return { success: false, error: '用户 ID 包含不安全字符' };
    }
    if (!isValidPathSegment(projectId)) {
      return { success: false, error: '项目 ID 包含不安全字符' };
    }
    if (!isValidPathSegment(taskId)) {
      return { success: false, error: '任务 ID 包含不安全字符' };
    }

    const attachmentId = crypto.randomUUID();
    const fileExt = sanitizePathSegment(file.name.split('.').pop() || 'bin');
    const filePath = `${userId}/${projectId}/${taskId}/${attachmentId}.${fileExt}`;
    
    // 创建取消控制器
    const abortController = new AbortController();
    this.uploadAbortControllers.set(file.name, abortController);
    
    // 更新上传进度
    this.updateProgress(file.name, 0, 'uploading');
    this.isUploading.set(true);

    try {
      // 检查是否已被取消
      if (abortController.signal.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }

      // 上传文件到 Supabase Storage
      // 注意：Supabase Storage JS SDK 目前不原生支持 AbortController
      // 我们通过在上传前后检查信号状态来实现取消
      const uploadPromise = this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false
        });

      // 创建取消监听
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(new DOMException('Upload cancelled', 'AbortError'));
        });
      });

      // 竞速：上传完成或被取消
      const { error } = await Promise.race([
        uploadPromise,
        abortPromise.then(() => ({ data: null, error: new Error('Upload cancelled') }))
      ]) as { data: unknown; error: Error | null };

      if (error) {
        throw supabaseErrorToError(error);
      }

      // 再次检查是否在上传完成后被取消（边界情况）
      if (abortController.signal.aborted) {
        // 上传已完成但用户取消了，尝试删除已上传的文件
        await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .remove([filePath]);
        throw new DOMException('Upload cancelled', 'AbortError');
      }

      // 获取公开 URL 或签名 URL
      const { data: urlData } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .createSignedUrl(filePath, 60 * 60 * 24 * 7); // 7 天有效期

      const url = urlData?.signedUrl || '';

      // 构建附件对象
      const attachment: Attachment = {
        id: attachmentId,
        type: this.getAttachmentType(file.type),
        name: file.name,
        url,
        mimeType: file.type,
        size: file.size,
        createdAt: new Date().toISOString(),
        signedAt: new Date().toISOString() // 记录 URL 签名时间
      };

      // 如果是图片，尝试生成缩略图 URL
      if (this.isImage(file.type)) {
        const { data: thumbData } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .createSignedUrl(filePath, 60 * 60 * 24 * 7, {
            transform: {
              width: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              height: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              resize: 'contain'
            }
          });
        attachment.thumbnailUrl = thumbData?.signedUrl;
      }

      this.updateProgress(file.name, 100, 'completed');
      
      return { success: true, attachment };
    } catch (e: any) {
      // 检查是否为取消操作
      if (e?.name === 'AbortError' || e?.message === 'Upload cancelled') {
        console.log(`Upload cancelled: ${file.name}`);
        this.updateProgress(file.name, 0, 'cancelled');
        return { success: false, cancelled: true, error: '上传已取消' };
      }
      
      console.error('File upload failed:', e);
      this.updateProgress(file.name, 0, 'error', e?.message);
      return { success: false, error: e?.message ?? '上传失败' };
    } finally {
      // 清理取消控制器
      this.uploadAbortControllers.delete(file.name);
      
      // 更新上传状态
      if (this.uploadAbortControllers.size === 0) {
        this.isUploading.set(false);
      }
    }
  }

  /**
   * 取消指定文件的上传
   * @param fileName 文件名
   * @returns 是否成功取消
   */
  cancelUpload(fileName: string): boolean {
    const controller = this.uploadAbortControllers.get(fileName);
    if (controller) {
      controller.abort();
      this.uploadAbortControllers.delete(fileName);
      this.updateProgress(fileName, 0, 'cancelled');
      return true;
    }
    return false;
  }

  /**
   * 取消所有正在进行的上传
   */
  cancelAllUploads(): void {
    for (const [fileName, controller] of this.uploadAbortControllers) {
      controller.abort();
      this.updateProgress(fileName, 0, 'cancelled');
    }
    this.uploadAbortControllers.clear();
    this.isUploading.set(false);
  }

  /**
   * 检查指定文件是否正在上传
   */
  isFileUploading(fileName: string): boolean {
    return this.uploadAbortControllers.has(fileName);
  }

  /**
   * 获取正在上传的文件数量
   */
  getActiveUploadCount(): number {
    return this.uploadAbortControllers.size;
  }

  /**
   * 批量上传文件
   */
  async uploadFiles(
    userId: string,
    projectId: string,
    taskId: string,
    files: FileList | File[]
  ): Promise<{ attachments: Attachment[]; errors: string[] }> {
    const attachments: Attachment[] = [];
    const errors: string[] = [];

    for (const file of Array.from(files)) {
      const result = await this.uploadFile(userId, projectId, taskId, file);
      if (result.success && result.attachment) {
        attachments.push(result.attachment);
      } else if (result.error) {
        errors.push(`${file.name}: ${result.error}`);
      }
    }

    return { attachments, errors };
  }

  /**
   * 软删除文件（标记为已删除，不立即从存储中移除）
   * 附件会在指定保留期后由后台任务清理
   * @param attachment 要删除的附件对象
   * @returns 带有 deletedAt 标记的附件对象
   */
  markAsDeleted(attachment: Attachment): Attachment {
    return {
      ...attachment,
      deletedAt: new Date().toISOString()
    };
  }

  /**
   * 检查附件是否已被软删除
   */
  isDeleted(attachment: Attachment): boolean {
    return !!attachment.deletedAt;
  }

  /**
   * 恢复软删除的附件
   */
  restoreDeleted(attachment: Attachment): Attachment {
    const { deletedAt: _deletedAt, ...rest } = attachment as Attachment & { deletedAt?: string };
    return rest as Attachment;
  }

  /**
   * 过滤掉已删除的附件（用于显示）
   */
  filterActive(attachments: Attachment[]): Attachment[] {
    return attachments.filter(a => !this.isDeleted(a));
  }

  /**
   * 删除文件（硬删除 - 仅供清理任务使用）
   * 注意：正常删除应使用 markAsDeleted 进行软删除
   */
  async deleteFile(
    userId: string,
    projectId: string,
    taskId: string,
    attachmentId: string,
    fileExt: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Supabase 未配置' };
    }

    const filePath = `${userId}/${projectId}/${taskId}/${attachmentId}.${fileExt}`;

    try {
      const { error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .remove([filePath]);

      if (error) {
        throw supabaseErrorToError(error);
      }

      return { success: true };
    } catch (e: any) {
      console.error('File deletion failed:', e);
      return { success: false, error: e?.message ?? '删除失败' };
    }
  }

  /**
   * 批量硬删除文件（供清理任务使用）
   */
  async deleteFiles(filePaths: string[]): Promise<{ success: boolean; deletedCount: number; errors: string[] }> {
    if (!this.supabase.isConfigured) {
      return { success: false, deletedCount: 0, errors: ['Supabase 未配置'] };
    }

    if (filePaths.length === 0) {
      return { success: true, deletedCount: 0, errors: [] };
    }

    const errors: string[] = [];
    let deletedCount = 0;

    // Supabase Storage 批量删除有限制，分批处理
    const batchSize = 100;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      try {
        const { error } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .remove(batch);

        if (error) {
          errors.push(`批次 ${Math.floor(i / batchSize) + 1}: ${error.message}`);
        } else {
          deletedCount += batch.length;
        }
      } catch (e: any) {
        errors.push(`批次 ${Math.floor(i / batchSize) + 1}: ${e?.message ?? '删除失败'}`);
      }
    }

    return { 
      success: errors.length === 0, 
      deletedCount, 
      errors 
    };
  }

  /**
   * 刷新附件 URL（当签名过期时）
   */
  async refreshUrl(
    userId: string,
    projectId: string,
    taskId: string,
    attachment: Attachment
  ): Promise<{ url: string; thumbnailUrl?: string } | null> {
    if (!this.supabase.isConfigured) {
      return null;
    }

    const fileExt = attachment.name.split('.').pop() || '';
    const filePath = `${userId}/${projectId}/${taskId}/${attachment.id}.${fileExt}`;

    try {
      const { data: urlData } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .createSignedUrl(filePath, 60 * 60 * 24 * 7);

      if (!urlData?.signedUrl) {
        return null;
      }

      const result: { url: string; thumbnailUrl?: string } = {
        url: urlData.signedUrl
      };

      // 如果是图片，也刷新缩略图 URL
      if (attachment.type === 'image' && attachment.mimeType) {
        const { data: thumbData } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .createSignedUrl(filePath, 60 * 60 * 24 * 7, {
            transform: {
              width: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              height: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              resize: 'contain'
            }
          });
        result.thumbnailUrl = thumbData?.signedUrl;
      }

      return result;
    } catch (e) {
      console.error('Failed to refresh URL:', e);
      return null;
    }
  }

  /**
   * 下载文件
   */
  async downloadFile(
    userId: string,
    projectId: string,
    taskId: string,
    attachment: Attachment
  ): Promise<Blob | null> {
    if (!this.supabase.isConfigured) {
      return null;
    }

    const fileExt = attachment.name.split('.').pop() || '';
    const filePath = `${userId}/${projectId}/${taskId}/${attachment.id}.${fileExt}`;

    try {
      const { data, error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .download(filePath);

      if (error) {
        throw supabaseErrorToError(error);
      }

      return data;
    } catch (e) {
      console.error('File download failed:', e);
      return null;
    }
  }

  /**
   * 验证附件数量限制
   */
  canAddAttachment(currentCount: number): boolean {
    return currentCount < ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK;
  }

  /**
   * 获取文件类型
   */
  private getAttachmentType(mimeType: string): AttachmentType {
    if (ATTACHMENT_CONFIG.IMAGE_TYPES.includes(mimeType)) {
      return 'image';
    }
    if (ATTACHMENT_CONFIG.DOCUMENT_TYPES.includes(mimeType)) {
      return 'document';
    }
    return 'file';
  }

  /**
   * 是否为图片
   */
  private isImage(mimeType: string): boolean {
    return ATTACHMENT_CONFIG.IMAGE_TYPES.includes(mimeType);
  }

  /**
   * 更新上传进度
   */
  private updateProgress(fileName: string, progress: number, status: UploadProgress['status'], error?: string) {
    this.uploadProgress.update(list => {
      const existing = list.find(p => p.fileName === fileName);
      if (existing) {
        return list.map(p => p.fileName === fileName ? { ...p, progress, status, error } : p);
      }
      return [...list, { fileName, progress, status, error }];
    });

    // 清除已完成或错误的进度（延迟 3 秒）
    if (status === 'completed' || status === 'error') {
      setTimeout(() => {
        this.uploadProgress.update(list => list.filter(p => p.fileName !== fileName));
      }, 3000);
    }
  }

  /**
   * 清除所有进度
   */
  clearProgress() {
    this.uploadProgress.set([]);
  }
}
