// ============================================
// Sentry 告警配置
// 定义熔断事件、安全事件、数据保护事件的告警规则
// ============================================

/**
 * Sentry 事件类型枚举
 * 用于标记不同类型的告警事件
 */
export const SENTRY_EVENT_TYPES = {
  // ==================== 熔断事件 ====================
  /** 网络层熔断触发 */
  CIRCUIT_BREAKER_OPEN: 'CircuitBreaker:Open',
  /** 熔断恢复 */
  CIRCUIT_BREAKER_CLOSE: 'CircuitBreaker:Close',
  /** 空数据同步阻止 */
  CIRCUIT_BREAKER_EMPTY_DATA: 'CircuitBreaker:EmptyData',
  /** 任务数骤降检测 */
  CIRCUIT_BREAKER_TASK_DROP: 'CircuitBreaker:TaskDrop',
  /** 服务端批量删除阻止 */
  CIRCUIT_BREAKER_BATCH_DELETE: 'CircuitBreaker:BatchDelete',
  /** 版本冲突检测 */
  CIRCUIT_BREAKER_VERSION_CONFLICT: 'CircuitBreaker:VersionConflict',
  
  // ==================== 安全事件 ====================
  /** 权限校验失败 */
  SECURITY_PERMISSION_DENIED: 'Security:PermissionDenied',
  /** Tombstone 复活尝试 */
  SECURITY_TOMBSTONE_VIOLATION: 'Security:TombstoneViolation',
  /** 未授权访问尝试 */
  SECURITY_UNAUTHORIZED: 'Security:Unauthorized',
  /** 会话过期 */
  SECURITY_SESSION_EXPIRED: 'Security:SessionExpired',
  
  // ==================== 数据完整性事件 ====================
  /** 数据校验失败 */
  INTEGRITY_VALIDATION_FAILED: 'Integrity:ValidationFailed',
  /** 循环引用检测 */
  INTEGRITY_CIRCULAR_REFERENCE: 'Integrity:CircularReference',
  /** 孤儿数据检测 */
  INTEGRITY_ORPHAN_DATA: 'Integrity:OrphanData',
  /** 数据修复执行 */
  INTEGRITY_AUTO_REPAIR: 'Integrity:AutoRepair',
  
  // ==================== 存储事件 ====================
  /** 存储配额超限 */
  STORAGE_QUOTA_EXCEEDED: 'Storage:QuotaExceeded',
  /** 存储配额预警 */
  STORAGE_QUOTA_WARNING: 'Storage:QuotaWarning',
  /** IndexedDB 操作失败 */
  STORAGE_INDEXEDDB_FAILED: 'Storage:IndexedDBFailed',
  
  // ==================== 同步事件 ====================
  /** 同步持续失败 */
  SYNC_PERSISTENT_FAILURE: 'Sync:PersistentFailure',
  /** 重试队列溢出 */
  SYNC_RETRY_QUEUE_OVERFLOW: 'Sync:RetryQueueOverflow',
  /** 多标签页冲突 */
  SYNC_TAB_CONFLICT: 'Sync:TabConflict',
  
  // ==================== 备份事件 ====================
  /** 备份成功 */
  BACKUP_SUCCESS: 'Backup:Success',
  /** 备份失败 */
  BACKUP_FAILED: 'Backup:Failed',
  /** 恢复成功 */
  BACKUP_RESTORE_SUCCESS: 'Backup:RestoreSuccess',
  /** 恢复失败 */
  BACKUP_RESTORE_FAILED: 'Backup:RestoreFailed',
} as const;

export type SentryEventType = typeof SENTRY_EVENT_TYPES[keyof typeof SENTRY_EVENT_TYPES];

/**
 * 告警级别定义
 * 与 Sentry 的 level 对应
 */
export const ALERT_LEVELS = {
  /** P0: 立即处理 - 系统故障或数据丢失风险 */
  CRITICAL: 'fatal',
  /** P1: 紧急 - 功能受损需快速响应 */
  HIGH: 'error',
  /** P2: 重要 - 需要关注但不紧急 */
  MEDIUM: 'warning',
  /** P3: 低 - 仅记录供分析 */
  LOW: 'info',
} as const;

export type AlertLevel = typeof ALERT_LEVELS[keyof typeof ALERT_LEVELS];

/**
 * 告警规则配置
 * 定义每种事件类型的告警级别和额外处理
 */
export const SENTRY_ALERT_RULES = {
  // ==================== 熔断事件规则 ====================
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_OPEN]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['circuit-breaker', 'open'],
    shouldNotifyUser: true,
    userMessage: '服务暂时不可用，正在自动恢复',
  },
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_EMPTY_DATA]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['circuit-breaker', 'empty-data'],
    shouldNotifyUser: true,
    userMessage: '检测到数据异常，同步已暂停',
  },
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_TASK_DROP]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['circuit-breaker', 'task-drop'],
    shouldNotifyUser: true,
    userMessage: '检测到任务数异常变化，同步已暂停',
  },
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_BATCH_DELETE]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['circuit-breaker', 'batch-delete'],
    shouldNotifyUser: false,
  },
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_VERSION_CONFLICT]: {
    level: ALERT_LEVELS.MEDIUM,
    fingerprint: ['circuit-breaker', 'version-conflict'],
    shouldNotifyUser: true,
    userMessage: '数据版本冲突，请刷新页面',
  },
  [SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_CLOSE]: {
    level: ALERT_LEVELS.LOW,
    fingerprint: ['circuit-breaker', 'close'],
    shouldNotifyUser: false,
  },
  
  // ==================== 安全事件规则 ====================
  [SENTRY_EVENT_TYPES.SECURITY_PERMISSION_DENIED]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['security', 'permission-denied'],
    shouldNotifyUser: true,
    userMessage: '权限不足，请重新登录',
  },
  [SENTRY_EVENT_TYPES.SECURITY_TOMBSTONE_VIOLATION]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['security', 'tombstone-violation'],
    shouldNotifyUser: false,
  },
  [SENTRY_EVENT_TYPES.SECURITY_UNAUTHORIZED]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['security', 'unauthorized'],
    shouldNotifyUser: true,
    userMessage: '会话已过期，请重新登录',
  },
  [SENTRY_EVENT_TYPES.SECURITY_SESSION_EXPIRED]: {
    level: ALERT_LEVELS.MEDIUM,
    fingerprint: ['security', 'session-expired'],
    shouldNotifyUser: true,
    userMessage: '登录已过期，请重新登录',
  },
  
  // ==================== 数据完整性事件规则 ====================
  [SENTRY_EVENT_TYPES.INTEGRITY_VALIDATION_FAILED]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['integrity', 'validation-failed'],
    shouldNotifyUser: true,
    userMessage: '数据校验失败，正在尝试修复',
  },
  [SENTRY_EVENT_TYPES.INTEGRITY_CIRCULAR_REFERENCE]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['integrity', 'circular-reference'],
    shouldNotifyUser: true,
    userMessage: '检测到数据循环引用，请联系支持',
  },
  [SENTRY_EVENT_TYPES.INTEGRITY_ORPHAN_DATA]: {
    level: ALERT_LEVELS.MEDIUM,
    fingerprint: ['integrity', 'orphan-data'],
    shouldNotifyUser: false,
  },
  [SENTRY_EVENT_TYPES.INTEGRITY_AUTO_REPAIR]: {
    level: ALERT_LEVELS.LOW,
    fingerprint: ['integrity', 'auto-repair'],
    shouldNotifyUser: false,
  },
  
  // ==================== 存储事件规则 ====================
  [SENTRY_EVENT_TYPES.STORAGE_QUOTA_EXCEEDED]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['storage', 'quota-exceeded'],
    shouldNotifyUser: true,
    userMessage: '存储空间不足，请导出数据或清理缓存',
  },
  [SENTRY_EVENT_TYPES.STORAGE_QUOTA_WARNING]: {
    level: ALERT_LEVELS.MEDIUM,
    fingerprint: ['storage', 'quota-warning'],
    shouldNotifyUser: true,
    userMessage: '存储空间即将用尽',
  },
  [SENTRY_EVENT_TYPES.STORAGE_INDEXEDDB_FAILED]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['storage', 'indexeddb-failed'],
    shouldNotifyUser: true,
    userMessage: '本地存储操作失败',
  },
  
  // ==================== 同步事件规则 ====================
  [SENTRY_EVENT_TYPES.SYNC_PERSISTENT_FAILURE]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['sync', 'persistent-failure'],
    shouldNotifyUser: true,
    userMessage: '同步失败，数据已保存到本地',
  },
  [SENTRY_EVENT_TYPES.SYNC_RETRY_QUEUE_OVERFLOW]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['sync', 'retry-queue-overflow'],
    shouldNotifyUser: true,
    userMessage: '待同步数据过多，请尽快联网同步',
  },
  [SENTRY_EVENT_TYPES.SYNC_TAB_CONFLICT]: {
    level: ALERT_LEVELS.MEDIUM,
    fingerprint: ['sync', 'tab-conflict'],
    shouldNotifyUser: true,
    userMessage: '检测到其他标签页正在编辑，请刷新',
  },
  
  // ==================== 备份事件规则 ====================
  [SENTRY_EVENT_TYPES.BACKUP_SUCCESS]: {
    level: ALERT_LEVELS.LOW,
    fingerprint: ['backup', 'success'],
    shouldNotifyUser: false,
  },
  [SENTRY_EVENT_TYPES.BACKUP_FAILED]: {
    level: ALERT_LEVELS.HIGH,
    fingerprint: ['backup', 'failed'],
    shouldNotifyUser: true,
    userMessage: '备份失败，请手动导出数据',
  },
  [SENTRY_EVENT_TYPES.BACKUP_RESTORE_SUCCESS]: {
    level: ALERT_LEVELS.LOW,
    fingerprint: ['backup', 'restore-success'],
    shouldNotifyUser: true,
    userMessage: '数据恢复成功',
  },
  [SENTRY_EVENT_TYPES.BACKUP_RESTORE_FAILED]: {
    level: ALERT_LEVELS.CRITICAL,
    fingerprint: ['backup', 'restore-failed'],
    shouldNotifyUser: true,
    userMessage: '数据恢复失败，请联系支持',
  },
} as const;

/**
 * Sentry 告警服务配置
 */
export const SENTRY_ALERT_CONFIG = {
  /** 是否启用告警上报 */
  ENABLED: true,
  
  /** 相同事件去重时间窗口（毫秒）*/
  DEDUPE_WINDOW: 60000, // 1 分钟内相同事件只报一次
  
  /** 每分钟最大事件数（防止事件风暴）*/
  MAX_EVENTS_PER_MINUTE: 10,
  
  /** 是否在开发环境启用 */
  ENABLED_IN_DEV: false,
  
  /** 需要额外上下文的事件类型 */
  EVENTS_REQUIRING_CONTEXT: [
    SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_EMPTY_DATA,
    SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_TASK_DROP,
    SENTRY_EVENT_TYPES.INTEGRITY_CIRCULAR_REFERENCE,
    SENTRY_EVENT_TYPES.STORAGE_QUOTA_EXCEEDED,
  ] as readonly string[],
} as const;
