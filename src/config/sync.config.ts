// ============================================
// 同步配置
// 包含数据同步、离线缓存、冲突处理、请求限流相关常量
// ============================================

/**
 * 同步配置
 * 
 * 保守模式设计理念：优先保证数据不丢失，降低实时性
 * - 较长的防抖延迟，避免频繁同步导致冲突
 * - 本地优先，云端作为备份
 * - 永不主动丢弃用户数据
 * 
 * 【流量优化】2024-12-31
 * - 默认禁用 Realtime，改用轮询
 * - 字段筛选替代 SELECT *
 * - 增量同步优化
 */
export const SYNC_CONFIG = {
  /** 防抖延迟（毫秒）- 增加到3秒，确保用户完成一轮编辑后再同步 */
  DEBOUNCE_DELAY: 3000,
  /** 编辑状态超时（毫秒）- 增加到5秒，给用户更多思考时间 */
  EDITING_TIMEOUT: 5000,
  /** 远程变更处理延迟（毫秒）- 增加到2秒，避免干扰本地编辑 */
  REMOTE_CHANGE_DELAY: 2000,
  /** 冲突检测时间阈值（毫秒）- 放宽到10秒，减少误判 */
  CONFLICT_TIME_THRESHOLD: 10000,
  /** 重连基础延迟（毫秒） */
  RECONNECT_BASE_DELAY: 1000,
  /** 重连最大延迟（毫秒） */
  RECONNECT_MAX_DELAY: 30000,
  /** 云端数据加载超时（毫秒）- 增加到30秒，避免网络慢时加载失败 */
  CLOUD_LOAD_TIMEOUT: 30000,
  /** 本地缓存保存频率（毫秒）- 每1秒自动保存到本地，防止数据丢失 */
  LOCAL_AUTOSAVE_INTERVAL: 1000,
  /** 连通性探测间隔（毫秒）- 用于在 VPN/网络切换后自动恢复在线状态 */
  CONNECTIVITY_PROBE_INTERVAL: 15000,
  /** 连通性探测超时（毫秒）- 避免弱网时长时间挂起 */
  CONNECTIVITY_PROBE_TIMEOUT: 5000,
  /** 断路器：连续失败次数阈值 */
  CIRCUIT_BREAKER_THRESHOLD: 5,
  /** 断路器：打开状态持续时间（毫秒）- 2分钟 */
  CIRCUIT_BREAKER_TIMEOUT: 2 * 60 * 1000,
  /** 断路器：半开状态重试次数 */
  CIRCUIT_BREAKER_HALF_OPEN_RETRIES: 3,
  /** 
   * 重试队列最大大小（防止 localStorage 溢出）
   * 【2024-12-31 修复】从 500 降低到 100，因为每个 Task 可能包含大量内容
   * localStorage 配额约 5-10MB，100 个大型任务约占用 1-2MB
   */
  MAX_RETRY_QUEUE_SIZE: 100,
  /** 重试项最大年龄（毫秒，24 小时）*/
  MAX_RETRY_ITEM_AGE: 24 * 60 * 60 * 1000,
  /**
   * 存储配额警告阈值（字节）
   * 当重试队列序列化后超过此大小时触发缩减
   * 默认 1MB，留出余量给其他 localStorage 使用
   */
  RETRY_QUEUE_SIZE_LIMIT_BYTES: 1 * 1024 * 1024,
  
  // ==================== Realtime 配置（流量优化）====================
  /**
   * 是否启用 Realtime 订阅
   * 【流量优化】默认禁用，改用轮询节省 WebSocket 流量
   * 对于个人 PWA，轮询足够且更节省流量
   */
  REALTIME_ENABLED: false,
  /** 轮询间隔（毫秒）- 替代 Realtime 的轮询频率 */
  POLLING_INTERVAL: 30000,
  /** 轮询活跃状态判定时间（毫秒）- 用户活跃时使用较短间隔 */
  POLLING_ACTIVE_INTERVAL: 15000,
  /** 用户活跃超时（毫秒）- 用户无操作后视为不活跃 */
  USER_ACTIVE_TIMEOUT: 60000,
  
  // ==================== 增量同步配置 ====================
  /** Tombstone 缓存有效期（毫秒）- 5 分钟 */
  TOMBSTONE_CACHE_TTL: 5 * 60 * 1000,
} as const;

/**
 * 字段筛选配置 - 替代 SELECT * 节省流量
 * 
 * 【流量优化】2024-12-31
 * - 任务列表查询只返回元数据，不包含 content
 * - content 仅在查看任务详情时按需加载
 */
export const FIELD_SELECT_CONFIG = {
  /** 任务列表字段（不含 content，节省 60-70% 流量） */
  TASK_LIST_FIELDS: 'id,title,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id',
  /** 任务详情字段（包含 content） */
  TASK_DETAIL_FIELDS: 'id,title,content,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id,attachments',
  /** 连接字段 */
  CONNECTION_FIELDS: 'id,source_id,target_id,title,description,deleted_at,updated_at',
  /** 项目列表字段 */
  PROJECT_LIST_FIELDS: 'id,title,description,created_date,updated_at,version,owner_id',
  /** Tombstone 字段 */
  TOMBSTONE_FIELDS: 'task_id',
} as const;

/**
 * 请求限流配置
 * 解决并发 Supabase API 调用耗尽连接池的问题
 * 
 * 问题背景：
 * - Chrome 对同一域名限制 6 个并发 HTTP 连接
 * - Supabase 数据库连接池有限
 * - 页面加载时大量并发请求可能导致 "Failed to fetch" 错误
 */
export const REQUEST_THROTTLE_CONFIG = {
  /** 最大并发请求数 - Chrome 对同一域名限制 6 个，留 2 个给用户交互 */
  MAX_CONCURRENT: 4,
  /** 默认超时时间（毫秒）- 增加到 60 秒，因为队列等待时间也计入超时 */
  DEFAULT_TIMEOUT: 60000,
  /** 批量同步操作超时时间（毫秒）- 90 秒，给批量 push 操作更多时间 */
  BATCH_SYNC_TIMEOUT: 90000,
  /** 单个操作超时时间（毫秒）- 30 秒，平衡用户体验和慢速网络 */
  INDIVIDUAL_OPERATION_TIMEOUT: 30000,
  /** 默认重试次数 */
  DEFAULT_RETRIES: 3,
  /** 重试基础延迟（毫秒）*/
  RETRY_BASE_DELAY: 1000,
  /** 重试最大延迟（毫秒）*/
  RETRY_MAX_DELAY: 30000,
  /** 去重缓存过期时间（毫秒）*/
  DEDUPE_TTL: 5000,
  /** 请求队列最大长度 */
  MAX_QUEUE_SIZE: 100,
} as const;

/**
 * Circuit Breaker 配置
 * 防止在服务端持续故障时（如 504 Gateway Timeout）无效重试
 * 
 * 工作原理：
 * - closed: 正常状态，允许所有请求
 * - open: 熔断状态，拒绝所有请求，等待恢复时间
 * - half-open: 半开状态，允许少量试探请求
 */
export const CIRCUIT_BREAKER_CONFIG = {
  /** 触发熔断的连续失败次数 */
  FAILURE_THRESHOLD: 3,
  /** 熔断恢复时间（毫秒）- 30 秒 */
  RECOVERY_TIME: 30000,
  /** 半开状态允许的试探请求数 */
  HALF_OPEN_REQUESTS: 1,
  /** 触发熔断的错误类型（服务端超时/网关错误） */
  TRIGGER_ERROR_TYPES: ['NetworkTimeoutError', 'GatewayError', 'ServiceUnavailableError'] as readonly string[],
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
 * 乐观更新配置
 * 快照管理配置（已移除临时 ID 相关配置 - 使用客户端 UUID）
 */
export const OPTIMISTIC_CONFIG = {
  /** 快照最大保留时间（毫秒）- 5 分钟 */
  SNAPSHOT_MAX_AGE_MS: 5 * 60 * 1000,
  /** 最大快照数量 */
  MAX_SNAPSHOTS: 20,
  /** 清理检查间隔（毫秒） */
  CLEANUP_INTERVAL_MS: 60 * 1000,
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
