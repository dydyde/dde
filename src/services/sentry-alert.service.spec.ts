import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SentryAlertService, AlertStats } from './sentry-alert.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { SENTRY_EVENT_TYPES, SENTRY_ALERT_CONFIG } from '../config/sentry-alert.config';
import * as Sentry from '@sentry/angular';

// Mock Sentry
vi.mock('@sentry/angular', () => ({
  captureMessage: vi.fn(),
}));

describe('SentryAlertService', () => {
  let service: SentryAlertService;
  let mockToast: {
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockToast = {
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    };
    
    const loggerMethods = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const mockLogger = {
      category: () => loggerMethods,
    };
    
    TestBed.configureTestingModule({
      providers: [
        SentryAlertService,
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    service = TestBed.inject(SentryAlertService);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  describe('熔断事件报告', () => {
    it('应报告熔断开启事件', () => {
      service.reportCircuitBreakerOpen({ failureCount: 3 });
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker opened'),
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_OPEN,
          }),
        })
      );
    });
    
    it('应报告熔断关闭事件', () => {
      service.reportCircuitBreakerClose();
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker closed'),
        expect.any(Object)
      );
    });
    
    it('应报告空数据阻止事件', () => {
      service.reportEmptyDataBlocked('project-123', { reason: 'empty tasks' });
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Empty data sync blocked'),
        expect.objectContaining({
          tags: expect.objectContaining({
            projectId: 'project-123',
          }),
        })
      );
    });
    
    it('应报告任务数骤降事件', () => {
      service.reportTaskDrop('project-123', 100, 10);
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Task count dropped'),
        expect.objectContaining({
          extra: expect.objectContaining({
            previousCount: 100,
            currentCount: 10,
            dropPercentage: '90.0',
          }),
        })
      );
    });
    
    it('应报告版本冲突事件', () => {
      service.reportVersionConflict('task', 'task-123', 5, 3);
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Version conflict on task'),
        expect.objectContaining({
          extra: expect.objectContaining({
            expectedVersion: 5,
            actualVersion: 3,
          }),
        })
      );
    });
  });
  
  describe('安全事件报告', () => {
    it('应报告权限拒绝事件', () => {
      service.reportPermissionDenied('deleteTask');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
        expect.objectContaining({
          tags: expect.objectContaining({
            operation: 'deleteTask',
          }),
        })
      );
    });
    
    it('应报告 Tombstone 复活尝试', () => {
      service.reportTombstoneViolation('task-123');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('resurrect tombstoned task'),
        expect.objectContaining({
          tags: expect.objectContaining({
            taskId: 'task-123',
          }),
        })
      );
    });
    
    it('应报告会话过期事件', () => {
      service.reportSessionExpired();
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('session expired'),
        expect.any(Object)
      );
    });
  });
  
  describe('数据完整性事件报告', () => {
    it('应报告校验失败事件', () => {
      service.reportIntegrityIssue('validation_failed', 'Invalid task data');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Invalid task data',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.INTEGRITY_VALIDATION_FAILED,
          }),
        })
      );
    });
    
    it('应报告循环引用事件', () => {
      service.reportIntegrityIssue('circular_reference', 'Circular reference detected');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Circular reference detected',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.INTEGRITY_CIRCULAR_REFERENCE,
          }),
        })
      );
    });
  });
  
  describe('存储事件报告', () => {
    it('应报告配额超限事件', () => {
      service.reportStorageIssue('quota_exceeded', 'Storage quota exceeded');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Storage quota exceeded',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.STORAGE_QUOTA_EXCEEDED,
          }),
        })
      );
    });
  });
  
  describe('同步事件报告', () => {
    it('应报告持续失败事件', () => {
      service.reportSyncIssue('persistent_failure', 'Sync failed repeatedly');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Sync failed repeatedly',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.SYNC_PERSISTENT_FAILURE,
          }),
        })
      );
    });
    
    it('应报告多标签页冲突事件', () => {
      service.reportSyncIssue('tab_conflict', 'Tab conflict detected');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Tab conflict detected',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.SYNC_TAB_CONFLICT,
          }),
        })
      );
    });
  });
  
  describe('备份事件报告', () => {
    it('应报告备份失败事件', () => {
      service.reportBackupEvent('failed', 'Backup failed');
      
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Backup failed',
        expect.objectContaining({
          tags: expect.objectContaining({
            eventType: SENTRY_EVENT_TYPES.BACKUP_FAILED,
          }),
        })
      );
    });
  });
  
  describe('事件去重', () => {
    it('应对相同事件进行去重', () => {
      // 第一次报告
      service.reportCircuitBreakerOpen();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      
      // 立即再次报告相同事件
      service.reportCircuitBreakerOpen();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      
      // 验证去重统计
      const stats = service.getStats();
      expect(stats.deduplicatedCount).toBe(1);
    });
    
    it('应区分不同的事件类型', () => {
      service.reportCircuitBreakerOpen();
      service.reportCircuitBreakerClose();
      
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    });
    
    it('应区分不同的标签', () => {
      service.reportEmptyDataBlocked('project-1');
      service.reportEmptyDataBlocked('project-2');
      
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('事件限流', () => {
    it('应在达到限流阈值后拒绝新事件', () => {
      const maxEvents = SENTRY_ALERT_CONFIG.MAX_EVENTS_PER_MINUTE;
      
      // 报告最大数量的事件，使用不同的项目 ID 避免去重
      for (let i = 0; i < maxEvents; i++) {
        service.reportEmptyDataBlocked(`project-${i}`);
      }
      
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(maxEvents);
      
      // 超出限制的事件应被拒绝（使用新的项目 ID）
      service.reportEmptyDataBlocked('project-extra');
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(maxEvents);
      
      // 验证限流统计
      const stats = service.getStats();
      expect(stats.rateLimitedCount).toBe(1);
    });
  });
  
  describe('用户通知', () => {
    it('应对 critical/high 级别事件显示错误 Toast', () => {
      service.reportEmptyDataBlocked('project-123');
      
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('应对 medium 级别事件显示警告 Toast', () => {
      service.reportVersionConflict('task', 'task-123', 5, 3);
      
      expect(mockToast.warning).toHaveBeenCalled();
    });
    
    it('不应对非通知事件显示 Toast', () => {
      service.reportCircuitBreakerClose();
      
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.warning).not.toHaveBeenCalled();
      expect(mockToast.info).not.toHaveBeenCalled();
    });
  });
  
  describe('统计功能', () => {
    it('应正确统计告警数量', () => {
      service.reportCircuitBreakerOpen();
      service.reportCircuitBreakerClose();
      
      const stats = service.getStats();
      expect(stats.totalAlerts).toBe(2);
    });
    
    it('应按类型统计告警', () => {
      service.reportCircuitBreakerOpen();
      service.reportEmptyDataBlocked('project-1');
      service.reportEmptyDataBlocked('project-2');
      
      const stats = service.getStats();
      expect(stats.byType[SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_OPEN]).toBe(1);
      expect(stats.byType[SENTRY_EVENT_TYPES.CIRCUIT_BREAKER_EMPTY_DATA]).toBe(2);
    });
    
    it('应记录最后告警时间', () => {
      service.reportCircuitBreakerOpen();
      
      const stats = service.getStats();
      expect(stats.lastAlertTime).not.toBeNull();
    });
    
    it('应能重置统计', () => {
      service.reportCircuitBreakerOpen();
      service.resetStats();
      
      const stats = service.getStats();
      expect(stats.totalAlerts).toBe(0);
      expect(stats.lastAlertTime).toBeNull();
    });
  });
  
  describe('信号响应', () => {
    it('应通过信号暴露统计', () => {
      expect(service.alertStats()).toEqual(expect.objectContaining({
        totalAlerts: 0,
      }));
      
      service.reportCircuitBreakerOpen();
      
      expect(service.alertStats().totalAlerts).toBe(1);
    });
  });
  
  describe('EventTypes 常量', () => {
    it('应暴露事件类型常量', () => {
      expect(service.EventTypes).toBe(SENTRY_EVENT_TYPES);
      expect(service.EventTypes.CIRCUIT_BREAKER_OPEN).toBe('CircuitBreaker:Open');
    });
  });
});
