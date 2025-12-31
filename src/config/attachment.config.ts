// ============================================
// 附件配置
// 包含文件上传、存储桶、签名 URL 相关常量
// ============================================

/**
 * 附件配置
 * 
 * 【流量优化】2024-12-31
 * - 延长签名 URL 有效期到 30 天
 * - 惰性刷新：仅在 URL 即将过期时才刷新
 * - 增加刷新检查间隔到 4 小时
 * - 设置 1 年 cache-control 以利用 Smart CDN 降低 egress 成本
 */
export const ATTACHMENT_CONFIG = {
  /** 
   * 签名 URL 刷新缓冲时间（毫秒）- 29天
   * 【流量优化】延长到 29 天，仅在最后 1 天刷新
   * 大幅减少不必要的 URL 刷新请求
   */
  URL_EXPIRY_BUFFER: 29 * 24 * 60 * 60 * 1000,
  /** 
   * URL 刷新检查间隔（毫秒）- 4小时
   * 【流量优化】从 1 小时增加到 4 小时
   */
  URL_REFRESH_CHECK_INTERVAL: 4 * 60 * 60 * 1000,
  /**
   * Cache-Control max-age（秒）- 1 年
   * 【Egress 优化】利用 Supabase Smart CDN，缓存命中按 $0.03/GB 计费
   * 比未缓存的 $0.09/GB 便宜 3 倍
   */
  CACHE_CONTROL_MAX_AGE: 31536000,
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
  /** 
   * 签名 URL 有效期（秒）- 30天
   * 【流量优化】从 7 天延长到 30 天
   */
  SIGNED_URL_EXPIRY: 60 * 60 * 24 * 30
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
