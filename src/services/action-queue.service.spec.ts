/**
 * ActionQueueService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 基本入队/出队操作
 * 2. 断网时操作队列化
 * 3. 网络恢复后自动重试
 * 4. 重试失败后的回滚/死信队列
 * 5. 业务错误 vs 网络错误的区分
 * 6. 指数退避重试策略
 * 7. 队列持久化和恢复
 * 8. 死信队列的 TTL 清理
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActionQueueService, EnqueueParams } from './action-queue.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

// 模拟 LoggerService
const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// 模拟 ToastService
const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

describe('ActionQueueService', () => {
  let service: ActionQueueService;

  // 辅助函数：模拟网络状态（不触发事件）
  function setNetworkStatus(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });
    // 直接修改服务内部状态，避免竞态条件
    (service as any).isOnline = online;
  }

  // 辅助函数：模拟网络状态变化并触发事件
  function triggerNetworkEvent(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });
    
    if (online) {
      window.dispatchEvent(new Event('online'));
    } else {
      window.dispatchEvent(new Event('offline'));
    }
  }

  // 辅助函数：创建测试操作
  function createTestProjectAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'project',
      entityId: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        project: {
          id: `proj-${Date.now()}`,
          name: 'Test Project',
          description: '',
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: [],
        } as any,
      },
    };
  }

  function createTestTaskAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'task',
      entityId: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        task: {
          id: `task-${Date.now()}`,
          title: 'Test Task',
          content: '',
        } as any,
        projectId: 'proj-1',
      },
    };
  }

  beforeEach(() => {
    // 重置 localStorage
    localStorage.clear();
    vi.clearAllMocks();
    
    // 设置初始网络状态为 true（在服务初始化之前）
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
    
    // 配置 Angular TestBed
    TestBed.configureTestingModule({
      providers: [
        ActionQueueService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });
    
    // 获取服务实例
    service = TestBed.inject(ActionQueueService);
  });

  afterEach(() => {
    service.reset();
    TestBed.resetTestingModule();
  });

  // ==================== 基本队列操作 ====================
  
  describe('基本队列操作', () => {
    it('应该能够入队一个操作', () => {
      setNetworkStatus(false); // 防止自动处理
      const actionId = service.enqueue(createTestProjectAction());
      
      expect(actionId).toBeDefined();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
    });
    
    it('应该能够出队一个操作', () => {
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      
      service.dequeue(actionId);
      
      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
    });
    
    it('应该限制队列大小为 100', () => {
      setNetworkStatus(false);
      // 入队 150 个操作
      for (let i = 0; i < 150; i++) {
        service.enqueue({
          type: 'update',
          entityType: 'task',
          entityId: `task-${i}`,
          payload: { task: { id: `task-${i}` } as any, projectId: 'proj-1' },
        });
      }
      
      // 队列应该被限制在 100 个
      expect(service.queueSize()).toBe(100);
    });
    
    it('应该能够清空队列', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      service.enqueue(createTestProjectAction());
      
      service.clearQueue();
      
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 处理器注册和执行 ====================
  
  describe('处理器注册和执行', () => {
    it('应该能够注册处理器并执行', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 先离线防止自动处理
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 再上线并手动处理
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(processor).toHaveBeenCalledTimes(1);
    });
    
    it('处理成功后应该从队列移除操作', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 先离线
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      expect(service.queueSize()).toBe(1);
      
      // 再上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(service.queueSize()).toBe(0);
    });
    
    it('无处理器的操作应该保留在队列中', async () => {
      // 先离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 不注册任何处理器，上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);
      expect(service.queueSize()).toBe(1); // 仍在队列中
    });
  });

  // ==================== 离线/在线状态处理 ====================
  
  describe('离线/在线状态处理', () => {
    it('离线时处理队列应该直接返回空结果', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 模拟离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      const result = await service.processQueue();
      
      // 离线时不应该处理任何操作
      expect(result.processed).toBe(0);
      expect(processor).not.toHaveBeenCalled();
    });
    
    it('网络恢复时应该自动处理队列', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      // 先离线
      setNetworkStatus(false);
      
      service.enqueue(createTestProjectAction());
      
      // 恢复在线 - 使用事件触发自动处理
      triggerNetworkEvent(true);
      
      // 等待处理完成（使用短超时提高测试速度）
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalled();
      }, { timeout: 100, interval: 10 });
    });
  });

  // ==================== 重试机制 ====================
  
  describe('重试机制', () => {
    it('网络错误应该保留在队列中等待重试', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Network timeout'));
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 网络错误后任务应该还在队列中（等待重试）
      expect(service.queueSize()).toBe(1);
      expect(processor).toHaveBeenCalledTimes(1);
    });
    
    it('重试成功后应该从队列移除', async () => {
      // 使用 fake timers 加速重试延迟测试
      vi.useFakeTimers();
      
      let callCount = 0;
      const processor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Network timeout');
        }
        return true;
      });
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      // 第一次处理（失败）
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.queueSize()).toBe(1);
      
      // 快进重试延迟时间后再次处理（成功）
      await vi.advanceTimersByTimeAsync(1100);
      await service.processQueue();
      
      expect(callCount).toBe(2);
      expect(service.queueSize()).toBe(0);
      
      vi.useRealTimers();
    });
  });

  // ==================== 业务错误 vs 网络错误 ====================
  
  describe('错误类型区分', () => {
    const businessErrors = [
      'not found',
      'permission denied',
      'unauthorized',
      'forbidden',
      'row level security',
      'violates constraint',
      'duplicate key',
      'unique constraint',
      'invalid input',
    ];
    
    it.each(businessErrors)('业务错误 "%s" 应该直接移入死信队列不重试', async (errorPattern) => {
      const processor = vi.fn().mockRejectedValue(new Error(`Error: ${errorPattern}`));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 业务错误应该只调用一次就进入死信队列
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 死信队列管理 ====================
  
  describe('死信队列管理', () => {
    it('应该能够从死信队列重试操作', async () => {
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error('RLS violation'))
        .mockResolvedValueOnce(true);
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      const deadLetters = service.deadLetterQueue();
      expect(deadLetters.length).toBe(1);
      
      // 重试操作会自动触发 processQueue，等待处理完成
      service.retryDeadLetter(deadLetters[0].action.id);
      
      // 等待自动处理完成（使用短超时提高测试速度）
      await vi.waitFor(() => {
        expect(service.queueSize()).toBe(0);
      }, { timeout: 100, interval: 10 });
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够放弃死信队列中的操作', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('not found'));
      service.registerProcessor('task:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { taskId: 'task-1', projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const deadLetters = service.deadLetterQueue();
      service.dismissDeadLetter(deadLetters[0].action.id);
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够清空死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('forbidden'));
      service.registerProcessor('project:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: `proj-${Date.now()}`,
        payload: { projectId: 'proj-1', userId: 'user-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      service.clearDeadLetterQueue();
      
      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });
  });

  // ==================== 持久化 ====================
  
  describe('队列持久化', () => {
    it('应该将队列持久化到 localStorage', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      const saved = localStorage.getItem('nanoflow.action-queue');
      expect(saved).toBeTruthy();
      
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });
    
    it('应该持久化死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('invalid input'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const savedDeadLetter = localStorage.getItem('nanoflow.dead-letter-queue');
      expect(savedDeadLetter).toBeTruthy();
      
      const parsed = JSON.parse(savedDeadLetter!);
      expect(parsed).toHaveLength(1);
    });
  });

  // ==================== 失败通知回调 ====================
  
  describe('失败通知回调', () => {
    it('应该在操作进入死信队列时触发回调', async () => {
      const callback = vi.fn();
      service.onFailure(callback);
      
      const processor = vi.fn().mockRejectedValue(new Error('violates foreign key constraint'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({
          entityType: 'task',
        }),
        reason: expect.stringContaining('业务错误'),
      }));
    });
  });

  // ==================== 队列处理生命周期回调 ====================
  
  describe('队列处理生命周期回调', () => {
    it('处理队列时应该调用开始和结束回调', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      
      service.setQueueProcessCallbacks(onStart, onEnd);
      
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 实体查询 ====================
  
  describe('实体相关操作查询', () => {
    it('应该能够获取特定实体的待处理操作', () => {
      setNetworkStatus(false);
      
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: { id: 'task-2' } as any, projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: { id: 'task-1', title: 'Updated' } as any, projectId: 'proj-1' },
      });
      
      const actions = service.getActionsForEntity('task', 'task-1');
      
      // 由于智能合并，同一实体的多个 update 操作会合并为一个
      expect(actions).toHaveLength(1);
      expect(actions.every(a => a.entityId === 'task-1')).toBe(true);
    });
  });

  // ==================== 并发处理保护 ====================
  
  describe('并发处理保护', () => {
    it('正在处理时不应该重复处理', async () => {
      const processor = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 100));
        return true;
      });
      
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      
      const promise1 = service.processQueue();
      const promise2 = service.processQueue();
      
      await Promise.all([promise1, promise2]);
      
      expect(processor).toHaveBeenCalledTimes(1);
    });
  });
});
