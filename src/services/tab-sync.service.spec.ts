import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TabSyncService, TabEditLock, ConcurrentEditEvent } from './tab-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

/**
 * Mock BroadcastChannel for testing
 */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
  
  postMessage(data: unknown): void {
    // Broadcast to other instances with same name (simulating cross-tab)
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && instance.onmessage) {
        // Simulate async delivery
        setTimeout(() => instance.onmessage?.({ data }), 0);
      }
    }
  }
  
  close(): void {
    const index = MockBroadcastChannel.instances.indexOf(this);
    if (index > -1) {
      MockBroadcastChannel.instances.splice(index, 1);
    }
  }
  
  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

describe('TabSyncService', () => {
  let service: TabSyncService;
  let mockToast: { warning: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let mockLogger: { category: () => { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } };
  
  // Store original BroadcastChannel
  const originalBroadcastChannel = (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  
  beforeEach(() => {
    // Reset mock channels
    MockBroadcastChannel.reset();
    
    // Mock BroadcastChannel
    (globalThis as unknown as { BroadcastChannel?: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;
    
    mockToast = {
      warning: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    
    const loggerMethods = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    mockLogger = {
      category: () => loggerMethods
    };
    
    TestBed.configureTestingModule({
      providers: [
        TabSyncService,
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLogger },
      ]
    });
    
    service = TestBed.inject(TabSyncService);
  });
  
  afterEach(() => {
    // Restore original BroadcastChannel
    if (originalBroadcastChannel) {
      (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
    } else {
      delete (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    }
    
    if (service) {
      service.ngOnDestroy();
    }
    MockBroadcastChannel.reset();
  });
  
  describe('编辑锁基本功能', () => {
    it('应该成功获取编辑锁', () => {
      const result = service.acquireEditLock('task-1', 'content');
      expect(result).toBe(true);
    });
    
    it('应该能释放编辑锁', () => {
      service.acquireEditLock('task-1', 'content');
      
      // Should not throw
      expect(() => service.releaseEditLock('task-1', 'content')).not.toThrow();
    });
    
    it('释放未获取的锁不应报错', () => {
      expect(() => service.releaseEditLock('nonexistent', 'field')).not.toThrow();
    });
    
    it('应该能获取多个不同任务的锁', () => {
      expect(service.acquireEditLock('task-1', 'content')).toBe(true);
      expect(service.acquireEditLock('task-2', 'content')).toBe(true);
      expect(service.acquireEditLock('task-1', 'title')).toBe(true);
    });
  });
  
  describe('并发编辑检测', () => {
    it('初始状态下任务不应被标记为正在编辑', () => {
      expect(service.isBeingEditedByOtherTab('task-1')).toBe(false);
    });
    
    it('初始并发编辑计数应为 0', () => {
      expect(service.concurrentEditCount()).toBe(0);
    });
    
    it('应该能设置并发编辑回调', () => {
      const callback = vi.fn();
      expect(() => service.setOnConcurrentEditCallback(callback)).not.toThrow();
    });
    
    it('应该能获取指定任务的编辑者列表', () => {
      const editors = service.getOtherEditorsForTask('task-1');
      expect(editors).toEqual([]);
    });
  });
  
  describe('项目打开/关闭', () => {
    it('应该能通知项目打开', () => {
      expect(() => service.notifyProjectOpen('proj-1', 'Test Project')).not.toThrow();
    });
    
    it('应该能获取其他标签页数量', () => {
      const count = service.getOtherTabsCount('proj-1');
      expect(count).toBe(0);
    });
    
    it('应该能通知项目关闭', () => {
      service.notifyProjectOpen('proj-1', 'Test Project');
      expect(() => service.notifyProjectClose()).not.toThrow();
    });
  });
  
  describe('数据同步通知', () => {
    it('应该能通知数据同步完成', () => {
      expect(() => service.notifyDataSynced('proj-1', '2024-01-01T00:00:00Z')).not.toThrow();
    });
    
    it('应该能设置数据同步回调', () => {
      const callback = vi.fn();
      expect(() => service.setOnDataSyncedCallback(callback)).not.toThrow();
    });
  });
  
  describe('释放所有锁', () => {
    it('应该能释放所有编辑锁', () => {
      service.acquireEditLock('task-1', 'content');
      service.acquireEditLock('task-2', 'title');
      
      expect(() => service.releaseAllEditLocks()).not.toThrow();
    });
  });
});
