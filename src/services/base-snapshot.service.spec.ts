/**
 * BaseSnapshotService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖基本的服务实例化和接口定义。
 * 由于 IndexedDB 模拟的限制，只测试同步方法和服务接口。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BaseSnapshotService } from './base-snapshot.service';
import { LoggerService } from './logger.service';

// ========== 模拟依赖服务 ==========

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: () => mockLoggerCategory,
};

describe('BaseSnapshotService', () => {
  let service: BaseSnapshotService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        BaseSnapshotService,
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });
    
    service = TestBed.inject(BaseSnapshotService);
  });

  describe('服务实例化', () => {
    it('应该成功创建服务实例', () => {
      expect(service).toBeDefined();
    });

    it('应该具有所有必需的公共方法', () => {
      expect(typeof service.saveProjectSnapshot).toBe('function');
      expect(typeof service.getProjectSnapshot).toBe('function');
      expect(typeof service.getSnapshotVersion).toBe('function');
      expect(typeof service.hasSnapshot).toBe('function');
      expect(typeof service.deleteProjectSnapshot).toBe('function');
      expect(typeof service.saveTaskSnapshot).toBe('function');
      expect(typeof service.getTaskSnapshot).toBe('function');
      expect(typeof service.cleanupExpiredSnapshots).toBe('function');
      expect(typeof service.clearAll).toBe('function');
      expect(typeof service.reset).toBe('function');
    });
  });

  describe('reset', () => {
    it('应该可以重置服务状态', () => {
      // reset 是同步方法，应该不会抛出错误
      expect(() => service.reset()).not.toThrow();
    });
  });
});
