// ============================================
// 应用配置常量
// ============================================

/**
 * 布局配置
 */
export const LAYOUT_CONFIG = {
  /** 阶段间水平间距 */
  STAGE_SPACING: 260,
  /** 任务行垂直间距 */
  ROW_SPACING: 140,
  /** 根任务基础 rank 值 */
  RANK_ROOT_BASE: 10000,
  /** rank 步进值 */
  RANK_STEP: 500,
  /** rank 最小间隔 */
  RANK_MIN_GAP: 50,
  /** 默认任务 X 坐标 */
  DEFAULT_TASK_X: 300,
} as const;

/**
 * 同步配置
 */
export const SYNC_CONFIG = {
  /** 防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 800,
  /** 编辑状态超时（毫秒） */
  EDITING_TIMEOUT: 1500,
  /** 远程变更处理延迟（毫秒） */
  REMOTE_CHANGE_DELAY: 500,
  /** 冲突检测时间阈值（毫秒）- 远端时间超过本地时间多少视为冲突 */
  CONFLICT_TIME_THRESHOLD: 2000,
  /** 重连基础延迟（毫秒） */
  RECONNECT_BASE_DELAY: 1000,
  /** 重连最大延迟（毫秒） */
  RECONNECT_MAX_DELAY: 30000,
} as const;

/**
 * 缓存配置
 */
export const CACHE_CONFIG = {
  /** 离线缓存 key */
  OFFLINE_CACHE_KEY: 'nanoflow.offline-cache-v2',
  /** 主题缓存 key */
  THEME_CACHE_KEY: 'nanoflow.theme',
  /** 缓存版本号 */
  CACHE_VERSION: 2,
  /** 待处理变更存活时间（毫秒）- 2小时 */
  PENDING_CHANGES_TTL: 2 * 60 * 60 * 1000,
  /** 待处理变更清理间隔（毫秒）- 10分钟 */
  PENDING_CHANGES_CLEANUP_INTERVAL: 10 * 60 * 1000,
} as const;

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
 * 撤销/重做配置
 */
export const UNDO_CONFIG = {
  /** 最大撤销历史数 */
  MAX_HISTORY_SIZE: 50,
  /** 版本容差：当远程版本超过记录版本这么多时，拒绝撤销 */
  VERSION_TOLERANCE: 5,
} as const;

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

/**
 * 乐观更新配置
 * 快照管理和 ID 漂移相关配置
 */
export const OPTIMISTIC_CONFIG = {
  /** 快照最大保留时间（毫秒）- 5 分钟 */
  SNAPSHOT_MAX_AGE_MS: 5 * 60 * 1000,
  /** 最大快照数量 */
  MAX_SNAPSHOTS: 20,
  /** 清理检查间隔（毫秒） */
  CLEANUP_INTERVAL_MS: 60 * 1000,
  /** ID 映射最大保留时间（毫秒）- 1 小时 */
  ID_MAPPING_MAX_AGE_MS: 60 * 60 * 1000,
  /** 临时 ID 前缀 */
  TEMP_ID_PREFIX: 'temp-',
} as const;

/**
 * 流程图配置
 * 图表初始化和重试相关配置
 */
export const FLOW_VIEW_CONFIG = {
  /** 最大图表初始化重试次数 */
  MAX_DIAGRAM_RETRIES: 3,
  /** 图表初始化重试基础延迟（毫秒） */
  DIAGRAM_RETRY_BASE_DELAY: 100,
} as const;

/**
 * 搜索配置
 */
export const SEARCH_CONFIG = {
  /** 搜索防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 300,
} as const;

/**
 * 深链接配置
 * 任务深链接定位相关配置
 */
export const DEEP_LINK_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 20,
  /** 基础延迟（毫秒） */
  BASE_DELAY: 100,
  /** 最大延迟（毫秒） */
  MAX_DELAY: 500,
} as const;

/**
 * 回收站配置
 */
export const TRASH_CONFIG = {
  /** 自动清理天数 */
  AUTO_CLEANUP_DAYS: 30,
  /** 清理检查间隔（毫秒）- 1小时 */
  CLEANUP_INTERVAL: 60 * 60 * 1000,
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

/**
 * Toast 配置
 */
export const TOAST_CONFIG = {
  /** 默认显示时长（毫秒） */
  DEFAULT_DURATION: 5000,
  /** 错误去重间隔（毫秒）- 5秒内相同错误只提示一次 */
  ERROR_DEDUP_INTERVAL: 5000,
} as const;

/**
 * 队列配置
 */
export const QUEUE_CONFIG = {
  /** 重试基础延迟（毫秒） */
  RETRY_BASE_DELAY: 1000,
  /** 无处理器超时时间（毫秒）- 5分钟 */
  NO_PROCESSOR_TIMEOUT: 5 * 60 * 1000,
} as const;

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

/**
 * UI 配置
 */
export const UI_CONFIG = {
  /** 图表更新延迟（毫秒）- 给 Angular 变更检测时间 */
  DIAGRAM_UPDATE_DELAY: 50,
  /** 输入框聚焦延迟（毫秒） */
  INPUT_FOCUS_DELAY: 100,
  /** 滚动到元素延迟（毫秒） */
  SCROLL_TO_ELEMENT_DELAY: 100,
  /** 长按拖拽触发延迟（毫秒） */
  LONG_PRESS_DELAY: 200,
  /** 移动端长按延迟（毫秒） - 稍长避免误触 */
  MOBILE_LONG_PRESS_DELAY: 250,
  /** 触摸拖拽边缘滚动区域（像素） */
  TOUCH_SCROLL_EDGE_SIZE: 80,
  /** 鼠标拖拽边缘滚动区域（像素） */
  MOUSE_SCROLL_EDGE_SIZE: 60,
  /** 最大滚动速度（像素/帧） */
  MAX_SCROLL_SPEED: 15,
  /** 滑动切换阈值（像素） */
  SWIPE_THRESHOLD: 50,
  /** 手势识别最小移动距离（像素） */
  GESTURE_MIN_DISTANCE: 30,
  /** 手势方向比率（水平距离/垂直距离超过此值认为是水平手势） */
  GESTURE_DIRECTION_RATIO: 1.5,
  /** 提示自动消失时间（毫秒） */
  HINT_AUTO_DISMISS: 3000,
  /** 视图状态保存防抖延迟（毫秒） */
  VIEW_STATE_SAVE_DEBOUNCE: 1000,
  /** 视图恢复延迟（毫秒） */
  VIEW_RESTORE_DELAY: 200,
  /** 动画/过渡延迟（毫秒） */
  ANIMATION_DELAY: 50,
  /** 短延迟（毫秒）- 用于简单的下一帧操作 */
  SHORT_DELAY: 50,
  /** 中等延迟（毫秒）- 用于需要等待 DOM 更新的操作 */
  MEDIUM_DELAY: 100,
  /** 重置尺寸防抖延迟（毫秒） */
  RESIZE_DEBOUNCE_DELAY: 100,
  /** 调色板最小高度（像素） */
  PALETTE_MIN_HEIGHT: 80,
  /** 调色板最大高度（像素） */
  PALETTE_MAX_HEIGHT: 500,
} as const;

/**
 * GoJS 流程图配置
 */
export const GOJS_CONFIG = {
  /** 自动布局层间距 */
  LAYER_SPACING: 100,
  /** 自动布局列间距 */
  COLUMN_SPACING: 40,
  /** 滚动边距 */
  SCROLL_MARGIN: 100,
  /** 待分配节点宽度 */
  UNASSIGNED_NODE_WIDTH: 140,
  /** 已分配节点宽度 */
  ASSIGNED_NODE_WIDTH: 200,
  /** 连接线捕获阈值（像素） */
  LINK_CAPTURE_THRESHOLD: 120,
  /** 端口大小 */
  PORT_SIZE: 10,
  /** 位置保存防抖延迟（毫秒） */
  POSITION_SAVE_DEBOUNCE: 300,
  /** 详情面板默认右边距 */
  DETAIL_PANEL_RIGHT_MARGIN: 8,
  /** 详情面板宽度（w-64 = 256px） */
  DETAIL_PANEL_WIDTH: 256,
  /** SSR 默认窗口高度 */
  SSR_DEFAULT_HEIGHT: 800,
} as const;

/**
 * 字母表（用于 displayId 生成）
 */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 上标数字映射
 */
export const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
};
