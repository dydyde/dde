// ============================================
// 特性开关配置
// 用于功能开关（开/关），与环境配置分离
// 
// 使用方式：
// import { FEATURE_FLAGS } from '@config/feature-flags.config';
// if (FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED) { ... }
// 
// 当前版本：静态配置，需重新部署
// 未来考虑：可通过 Supabase Edge Config 实现运行时动态开关
// ============================================

/**
 * 特性开关
 * 
 * 职责：控制功能的开/关
 * 与 environment.ts 的区别：
 * - FEATURE_FLAGS 用于功能开关（开/关）
 * - environment.ts 用于环境配置（开发/生产）
 */
export const FEATURE_FLAGS = {
  // ==================== 熔断层 ====================
  /** 是否启用客户端熔断保护 */
  CIRCUIT_BREAKER_ENABLED: true,
  /** 是否启用 L3 硬熔断（可单独关闭硬熔断） */
  CIRCUIT_BREAKER_L3_ENABLED: true,
  
  // ==================== 安全功能 ====================
  /** 是否启用会话过期检查 */
  SESSION_EXPIRED_CHECK_ENABLED: true,
  /** 是否启用登出时数据清理 */
  LOGOUT_CLEANUP_ENABLED: true,
  /** 是否启用 Connection Tombstone 防复活 */
  CONNECTION_TOMBSTONE_ENABLED: true,
  
  // ==================== 备份功能 ====================
  /** 是否启用自动备份 */
  AUTO_BACKUP_ENABLED: false, // 默认关闭，待 P2 实现
  /** 是否启用用户手动导出 */
  MANUAL_EXPORT_ENABLED: false, // 默认关闭，待 P1 实现
  
  // ==================== 同步功能 ====================
  /** 是否启用 Realtime 订阅（替代轮询） */
  REALTIME_ENABLED: false, // 流量优化，默认使用轮询
  /** 是否启用增量同步优化 */
  INCREMENTAL_SYNC_ENABLED: true,
  
  // ==================== 迁移功能 ====================
  /** 是否启用迁移快照 */
  MIGRATION_SNAPSHOT_ENABLED: true,
  /** 是否要求迁移二次确认 */
  MIGRATION_CONFIRMATION_REQUIRED: true,
  
  // ==================== 调试功能 ====================
  /** 是否启用详细日志 */
  VERBOSE_LOGGING_ENABLED: false,
  /** 是否启用性能监控 */
  PERFORMANCE_MONITORING_ENABLED: false,
} as const;

/**
 * 特性开关类型
 */
export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/**
 * 检查特性是否启用
 * 
 * @param flag 特性开关名称
 * @returns 是否启用
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag];
}
