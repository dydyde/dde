import { Injectable, inject, signal } from '@angular/core';
import * as Sentry from '@sentry/angular';
import { 
  SENTRY_EVENT_TYPES, 
  SENTRY_ALERT_RULES, 
  SENTRY_ALERT_CONFIG,
  SentryEventType,
  AlertLevel,
  ALERT_LEVELS 
} from '../config/sentry-alert.config';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';

/**
 * 告警事件接口
 */
export interface AlertEvent {
  /** 事件类型 */
  type: SentryEventType;
  /** 事件消息 */
  message: string;
  /** 额外数据 */
  extra?: Record<string, unknown>;
  /** 标签 */
  tags?: Record<string, string>;
  /** 时间戳 */
  timestamp: string;
}

/**
 * 告警统计接口
 */
export interface AlertStats {
  /** 总告警数 */
  totalAlerts: number;
  /** 按类型统计 */
  byType: Record<string, number>;
  /** 按级别统计 */
  byLevel: Record<string, number>;
  /** 最后一次告警时间 */
  lastAlertTime: string | null;
  /** 被去重的告警数 */
  deduplicatedCount: number;
  /** 被限流的告警数 */
  rateLimitedCount: number;
}

/**
 * Sentry 告警服务
 * 统一管理熔断事件、安全事件、数据保护事件的上报
 * 
 * 主要功能：
 * 1. 事件去重 - 防止短时间内重复上报相同事件
 * 2. 限流 - 防止事件风暴
 * 3. 自动通知用户 - 根据规则决定是否显示 Toast
 * 4. 统计分析 - 收集告警统计数据
 */
@Injectable({
  providedIn: 'root'
})
export class SentryAlertService {
  private readonly toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SentryAlert');
  
  // 事件去重缓存：eventKey -> lastReportTime
  private readonly dedupeCache = new Map<string, number>();
  
  // 限流计数器
  private eventCountThisMinute = 0;
  private currentMinuteStart = Date.now();
  
  // 告警统计
  private stats: AlertStats = {
    totalAlerts: 0,
    byType: {},
    byLevel: {},
    lastAlertTime: null,
    deduplicatedCount: 0,
    rateLimitedCount: 0,
  };
  
  // 公开的统计信号
  readonly alertStats = signal<AlertStats>(this.stats);
  
  // 事件类型常量导出
  readonly EventTypes = SENTRY_EVENT_TYPES;
  
  constructor() {
    // 每分钟重置限流计数器
    if (typeof window !== 'undefined') {
      setInterval(() => this.resetRateLimiter(), 60000);
    }
  }
  
  /**
   * 报告熔断事件
   */
  reportCircuitBreakerOpen(extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_OPEN,
      message: 'Circuit breaker opened due to consecutive failures',
      extra,
    });
  }
  
  /**
   * 报告熔断恢复
   */
  reportCircuitBreakerClose(extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_CLOSE,
      message: 'Circuit breaker closed, service recovered',
      extra,
    });
  }
  
  /**
   * 报告空数据同步阻止
   */
  reportEmptyDataBlocked(projectId: string, extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_EMPTY_DATA,
      message: 'Empty data sync blocked',
      tags: { projectId },
      extra,
    });
  }
  
  /**
   * 报告任务数骤降
   */
  reportTaskDrop(
    projectId: string, 
    previousCount: number, 
    currentCount: number,
    extra?: Record<string, unknown>
  ): void {
    this.report({
      type: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_TASK_DROP,
      message: `Task count dropped from ${previousCount} to ${currentCount}`,
      tags: { projectId },
      extra: {
        ...extra,
        previousCount,
        currentCount,
        dropPercentage: ((previousCount - currentCount) / previousCount * 100).toFixed(1),
      },
    });
  }
  
  /**
   * 报告版本冲突
   */
  reportVersionConflict(
    entityType: 'task' | 'project' | 'connection',
    entityId: string,
    expectedVersion: number,
    actualVersion: number,
    extra?: Record<string, unknown>
  ): void {
    this.report({
      type: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_VERSION_CONFLICT,
      message: `Version conflict on ${entityType}`,
      tags: { entityType, entityId },
      extra: {
        ...extra,
        expectedVersion,
        actualVersion,
      },
    });
  }
  
  /**
   * 报告安全事件 - 权限拒绝
   */
  reportPermissionDenied(operation: string, extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.SECURITY_PERMISSION_DENIED,
      message: `Permission denied for operation: ${operation}`,
      tags: { operation },
      extra,
    });
  }
  
  /**
   * 报告安全事件 - Tombstone 复活尝试
   */
  reportTombstoneViolation(taskId: string, extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.SECURITY_TOMBSTONE_VIOLATION,
      message: 'Attempted to resurrect tombstoned task',
      tags: { taskId },
      extra,
    });
  }
  
  /**
   * 报告安全事件 - 会话过期
   */
  reportSessionExpired(extra?: Record<string, unknown>): void {
    this.report({
      type: SENTRY_EVENT_TYPES.SECURITY_SESSION_EXPIRED,
      message: 'User session expired',
      extra,
    });
  }
  
  /**
   * 报告数据完整性问题
   */
  reportIntegrityIssue(
    issueType: 'validation_failed' | 'circular_reference' | 'orphan_data' | 'auto_repair',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const eventTypeMap = {
      validation_failed: SENTRY_EVENT_TYPES.INTEGRITY_VALIDATION_FAILED,
      circular_reference: SENTRY_EVENT_TYPES.INTEGRITY_CIRCULAR_REFERENCE,
      orphan_data: SENTRY_EVENT_TYPES.INTEGRITY_ORPHAN_DATA,
      auto_repair: SENTRY_EVENT_TYPES.INTEGRITY_AUTO_REPAIR,
    };
    
    this.report({
      type: eventTypeMap[issueType],
      message,
      extra,
    });
  }
  
  /**
   * 报告存储问题
   */
  reportStorageIssue(
    issueType: 'quota_exceeded' | 'quota_warning' | 'indexeddb_failed',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const eventTypeMap = {
      quota_exceeded: SENTRY_EVENT_TYPES.STORAGE_QUOTA_EXCEEDED,
      quota_warning: SENTRY_EVENT_TYPES.STORAGE_QUOTA_WARNING,
      indexeddb_failed: SENTRY_EVENT_TYPES.STORAGE_INDEXEDDB_FAILED,
    };
    
    this.report({
      type: eventTypeMap[issueType],
      message,
      extra,
    });
  }
  
  /**
   * 报告同步问题
   */
  reportSyncIssue(
    issueType: 'persistent_failure' | 'retry_queue_overflow' | 'tab_conflict',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const eventTypeMap = {
      persistent_failure: SENTRY_EVENT_TYPES.SYNC_PERSISTENT_FAILURE,
      retry_queue_overflow: SENTRY_EVENT_TYPES.SYNC_RETRY_QUEUE_OVERFLOW,
      tab_conflict: SENTRY_EVENT_TYPES.SYNC_TAB_CONFLICT,
    };
    
    this.report({
      type: eventTypeMap[issueType],
      message,
      extra,
    });
  }
  
  /**
   * 报告备份事件
   */
  reportBackupEvent(
    eventType: 'success' | 'failed' | 'restore_success' | 'restore_failed',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const eventTypeMap = {
      success: SENTRY_EVENT_TYPES.BACKUP_SUCCESS,
      failed: SENTRY_EVENT_TYPES.BACKUP_FAILED,
      restore_success: SENTRY_EVENT_TYPES.BACKUP_RESTORE_SUCCESS,
      restore_failed: SENTRY_EVENT_TYPES.BACKUP_RESTORE_FAILED,
    };
    
    this.report({
      type: eventTypeMap[eventType],
      message,
      extra,
    });
  }
  
  /**
   * 通用报告方法
   */
  report(event: Omit<AlertEvent, 'timestamp'>): void {
    const fullEvent: AlertEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    
    // 检查是否启用
    if (!this.isEnabled()) {
      this.logger.debug('Sentry alerts disabled, skipping', event.type);
      return;
    }
    
    // 检查去重
    const dedupeKey = this.getDedupeKey(fullEvent);
    if (this.isDuplicate(dedupeKey)) {
      this.stats.deduplicatedCount++;
      this.updateStats();
      this.logger.debug('Duplicate event deduplicated', event.type);
      return;
    }
    
    // 检查限流
    if (this.isRateLimited()) {
      this.stats.rateLimitedCount++;
      this.updateStats();
      this.logger.warn('Event rate limited', event.type);
      return;
    }
    
    // 更新去重缓存
    this.dedupeCache.set(dedupeKey, Date.now());
    this.eventCountThisMinute++;
    
    // 获取告警规则
    const rule = SENTRY_ALERT_RULES[event.type];
    if (!rule) {
      this.logger.warn('No alert rule found for event type', event.type);
      return;
    }
    
    // 发送到 Sentry
    this.sendToSentry(fullEvent, rule.level, rule.fingerprint);
    
    // 更新统计
    this.updateStatsForEvent(fullEvent, rule.level);
    
    // 通知用户（如果需要）
    if (rule.shouldNotifyUser && rule.userMessage) {
      this.notifyUser(rule.level, rule.userMessage);
    }
    
    this.logger.info('Alert reported', { type: event.type, message: event.message });
  }
  
  /**
   * 获取告警统计
   */
  getStats(): AlertStats {
    return { ...this.stats };
  }
  
  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      totalAlerts: 0,
      byType: {},
      byLevel: {},
      lastAlertTime: null,
      deduplicatedCount: 0,
      rateLimitedCount: 0,
    };
    this.updateStats();
  }
  
  // ==================== 私有方法 ====================
  
  private isEnabled(): boolean {
    if (!SENTRY_ALERT_CONFIG.ENABLED) {
      return false;
    }
    
    // 开发环境检查
    if (!environment.production && !SENTRY_ALERT_CONFIG.ENABLED_IN_DEV) {
      return false;
    }
    
    return true;
  }
  
  private getDedupeKey(event: AlertEvent): string {
    const tagString = event.tags ? JSON.stringify(event.tags) : '';
    return `${event.type}:${tagString}`;
  }
  
  private isDuplicate(key: string): boolean {
    const lastTime = this.dedupeCache.get(key);
    if (!lastTime) {
      return false;
    }
    
    const elapsed = Date.now() - lastTime;
    return elapsed < SENTRY_ALERT_CONFIG.DEDUPE_WINDOW;
  }
  
  private isRateLimited(): boolean {
    // 检查是否需要重置计数器
    const now = Date.now();
    if (now - this.currentMinuteStart >= 60000) {
      this.resetRateLimiter();
    }
    
    return this.eventCountThisMinute >= SENTRY_ALERT_CONFIG.MAX_EVENTS_PER_MINUTE;
  }
  
  private resetRateLimiter(): void {
    this.eventCountThisMinute = 0;
    this.currentMinuteStart = Date.now();
    
    // 同时清理过期的去重缓存
    const now = Date.now();
    for (const [key, time] of this.dedupeCache.entries()) {
      if (now - time > SENTRY_ALERT_CONFIG.DEDUPE_WINDOW) {
        this.dedupeCache.delete(key);
      }
    }
  }
  
  private sendToSentry(
    event: AlertEvent, 
    level: AlertLevel, 
    fingerprint: readonly string[]
  ): void {
    try {
      Sentry.captureMessage(event.message, {
        level: level as Sentry.SeverityLevel,
        tags: {
          eventType: event.type,
          ...event.tags,
        },
        extra: {
          ...event.extra,
          timestamp: event.timestamp,
        },
        fingerprint: [...fingerprint],
      });
    } catch (error) {
      this.logger.error('Failed to send to Sentry', error);
    }
  }
  
  private notifyUser(level: AlertLevel, message: string): void {
    switch (level) {
      case ALERT_LEVELS.CRITICAL:
      case ALERT_LEVELS.HIGH:
        this.toast.error(message);
        break;
      case ALERT_LEVELS.MEDIUM:
        this.toast.warning(message);
        break;
      case ALERT_LEVELS.LOW:
        this.toast.info(message);
        break;
    }
  }
  
  private updateStatsForEvent(event: AlertEvent, level: AlertLevel): void {
    this.stats.totalAlerts++;
    this.stats.byType[event.type] = (this.stats.byType[event.type] || 0) + 1;
    this.stats.byLevel[level] = (this.stats.byLevel[level] || 0) + 1;
    this.stats.lastAlertTime = event.timestamp;
    this.updateStats();
  }
  
  private updateStats(): void {
    this.alertStats.set({ ...this.stats });
  }
}
