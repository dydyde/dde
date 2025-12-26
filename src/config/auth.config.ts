// ============================================
// 认证配置
// 包含用户认证、会话管理、路由守卫相关常量
// ============================================

/**
 * 认证配置
 */
export const AUTH_CONFIG = {
  /** 会话检查超时（毫秒） */
  SESSION_CHECK_TIMEOUT: 10000,
  /** 记住登录状态过期时间（毫秒）- 7天 */
  REMEMBER_ME_EXPIRY: 7 * 24 * 60 * 60 * 1000,
  /** 密码最小长度（与后端保持一致） */
  MIN_PASSWORD_LENGTH: 8,
  /** 本地模式用户 ID（用于离线/本地编辑时的数据隔离） */
  LOCAL_MODE_USER_ID: 'local-user',
  /** 本地模式缓存 key */
  LOCAL_MODE_CACHE_KEY: 'nanoflow.local-mode',
} as const;

/**
 * Guard 配置
 * 路由守卫的超时和重试配置
 */
export const GUARD_CONFIG = {
  /** 数据初始化最大等待时间（毫秒）- 弱网环境建议增加 */
  DATA_INIT_TIMEOUT: 8000,
  /** 检查间隔（毫秒） */
  CHECK_INTERVAL: 100,
  /** 慢网络警告阈值（毫秒）- 超过此时间显示网络警告 */
  SLOW_NETWORK_THRESHOLD: 3000,
  /** 会话检查最大等待时间（毫秒） */
  SESSION_CHECK_TIMEOUT: 10000,
  /** 会话检查轮询初始间隔（毫秒） */
  SESSION_CHECK_POLL_INTERVAL: 50,
  /** 会话检查轮询最大间隔（毫秒） */
  SESSION_CHECK_POLL_MAX_INTERVAL: 200,
} as const;
