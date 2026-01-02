// ============================================
// 任务配置
// 包含任务管理、回收站、撤销/重做相关常量
// ============================================

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
 * 撤销/重做配置
 */
export const UNDO_CONFIG = {
  /** 最大撤销历史数 */
  MAX_HISTORY_SIZE: 50,
  /** 版本容差：当远程版本超过记录版本这么多时，拒绝撤销 */
  VERSION_TOLERANCE: 5,
  /** 持久化配置 */
  PERSISTENCE: {
    /** 是否启用 sessionStorage 持久化 */
    ENABLED: true,
    /** sessionStorage key */
    STORAGE_KEY: 'nanoflow.undo-history',
    /** 持久化防抖延迟（毫秒） */
    DEBOUNCE_DELAY: 500,
    /** 最大持久化条目数（限制 sessionStorage 大小） */
    MAX_PERSISTED_ITEMS: 20,
  },
} as const;
