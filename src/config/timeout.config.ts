// ============================================
// 超时与重试配置
// 包含 API 超时策略、重试策略相关常量
// ============================================

/**
 * 分级超时策略配置
 * 根据业务场景设置不同的超时时间：
 * - QUICK: 快速读取操作（简单查询、检查存在性）
 * - STANDARD: 普通 API 调用（增删改查）
 * - HEAVY: 重型操作（复杂聚合查询、批量操作）
 * - UPLOAD: 文件上传操作
 */
export const TIMEOUT_CONFIG = {
  /** 快速读取操作超时（毫秒）- 5秒 */
  QUICK: 5000,
  /** 普通 API 调用超时（毫秒）- 10秒 */
  STANDARD: 10000,
  /** 重型操作超时（毫秒）- 30秒 */
  HEAVY: 30000,
  /** 文件上传超时（毫秒）- 60秒 */
  UPLOAD: 60000,
  /** 实时连接超时（毫秒）- 15秒 */
  REALTIME: 15000,
} as const;

export type TimeoutLevel = keyof typeof TIMEOUT_CONFIG;

/**
 * 重试策略配置
 * 针对幂等操作（GET 请求、存在性检查等）自动重试
 */
export const RETRY_POLICY = {
  /** 最大重试次数 */
  MAX_RETRIES: 3,
  /** 初始重试延迟（毫秒） */
  INITIAL_DELAY: 500,
  /** 最大重试延迟（毫秒） */
  MAX_DELAY: 5000,
  /** 延迟增长因子（指数退避） */
  BACKOFF_FACTOR: 2,
  /** 可重试的 HTTP 状态码 */
  RETRYABLE_STATUS_CODES: [408, 429, 500, 502, 503, 504],
  /** 可重试的错误消息模式 */
  RETRYABLE_ERROR_PATTERNS: [
    'network',
    'timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'fetch failed',
    'Failed to fetch'
  ],
} as const;
