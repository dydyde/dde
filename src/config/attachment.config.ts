// ============================================
// 附件配置
// 包含文件上传、存储桶、签名 URL 相关常量
// ============================================

/**
 * 附件配置
 */
export const ATTACHMENT_CONFIG = {
  /** 
   * 签名 URL 刷新缓冲时间（毫秒）- 6天
   * Supabase 签名 URL 默认有效期为 7 天，我们在到期前 1 天刷新
   * 这样确保 URL 在实际过期前被刷新
   */
  URL_EXPIRY_BUFFER: 6 * 24 * 60 * 60 * 1000,
  /** URL 刷新检查间隔（毫秒）- 1小时 */
  URL_REFRESH_CHECK_INTERVAL: 60 * 60 * 1000,
  /** 最大文件大小 (10MB) */
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  /** 每个任务最大附件数 */
  MAX_ATTACHMENTS_PER_TASK: 20,
  /** 存储桶名称 */
  BUCKET_NAME: 'attachments',
  /** 图片类型 */
  IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'] as readonly string[],
  /** 文档类型 */
  DOCUMENT_TYPES: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'] as readonly string[],
  /** 缩略图最大尺寸 */
  THUMBNAIL_MAX_SIZE: 200,
  /** 签名 URL 有效期（秒）- 7天 */
  SIGNED_URL_EXPIRY: 60 * 60 * 24 * 7
} as const;

/**
 * 附件清理配置
 * 用于前端和 Edge Function 共用的配置
 */
export const ATTACHMENT_CLEANUP_CONFIG = {
  /** 软删除附件保留天数 */
  RETENTION_DAYS: 30,
  /** 每批处理的文件数 */
  BATCH_SIZE: 100,
} as const;
