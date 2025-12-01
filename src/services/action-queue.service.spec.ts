/**
 * ActionQueueService 单元测试 (Vitest)
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

// 模拟依赖服务
const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLogger = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

// 在导入 ActionQueueService 之前设置模拟
vi.mock('./logger.service', () => ({
  LoggerService: vi.fn(() => mockLogger),
}));

vi.mock('./toast.service', () => ({
  ToastService: vi.fn(() => mockToast),
}));

// 动态导入以确保模拟生效
const { ActionQueueService } = await import('./action-queue.service');
type QueuedAction = import('./action-queue.service').QueuedAction;
type DeadLetterItem = import('./action-queue.service').DeadLetterItem;
type EnqueueParams = import('./action-queue.service').EnqueueParams;

describe('ActionQueueService', () => {
  let service: InstanceType<typeof ActionQueueService>;

  // 辅助函数：模拟网络状态
  function setNetworkStatus(online: boolean) {
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
      entityId: `proj-${Date.now()}`,
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
      entityId: `task-${Date.now()}`,
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
    
    // 模拟在线状态
    setNetworkStatus(true);
    
    // 创建服务实例
    service = new ActionQueueService();
  });

  afterEach(() => {
    service.ngOnDestroy();
  });

  // ==================== 基本队列操作 ====================
  
  describe('基本队列操作', () => {
    it('应该能够入队一个操作', () => {
      const actionId = service.enqueue(createTestProjectAction());
      
      expect(actionId).toBeDefined();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
    });
    
    it('应该能够出队一个操作', () => {
      const actionId = service.enqueue(createTestProjectAction());
      
      service.dequeue(actionId);
      
      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
    });
    
    it('应该限制队列大小为 100', () => {
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
      service.enqueue(createTestProjectAction());
      service.enqueue(createTestProjectAction());
      
      service.clearQueue();
      
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 处理器注册和执行 ====================
  
  describe('处理器注册和执行', () => {
    it('应该能够注册处理器', async () => {
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
      
      // 恢复在线 - 这会触发自动处理
      setNetworkStatus(true);
      
      // 等待处理完成
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalled();
      }, { timeout: 1000 });
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
      
      // 网络错误后任务应该还在队列中
      expect(service.queueSize()).toBe(1);
      expect(processor).toHaveBeenCalledTimes(1);
    });
    
    it('重试成功后应该从队列移除', async () => {
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
      
      // 等待重试延迟后再次处理（成功）
      await new Promise(r => setTimeout(r, 1100));
      await service.processQueue();
      
      expect(callCount).toBe(2);
      expect(service.queueSize()).toBe(0);
    });
    
    it('超过最大重试次数后应该移入死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Persistent network failure'));
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      setNetworkStatus(true);
      
      // 模拟多次重试直到超过最大次数
      for (let i = 0; i < 7; i++) {
        await service.processQueue();
        // 短暂等待指数退避
        await new Promise(r => setTimeout(r, 100));
      }
      
      // 检查是否进入死信队列
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.deadLetterSize()).toBeGreaterThan(0);
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
      'rls violation',
      'violates constraint',
      'duplicate key',
      'unique constraint',
      'foreign key constraint',
      'invalid input',
    ];
    
    it.each(businessErrors)('业务错误 "%s" 应该直接移入死信队列不重试', async (errorPattern) => {
      const processor = vi.fn().mockRejectedValue(new Error(`Error: ${errorPattern}`));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
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
      // 先让一个操作进入死信队列
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error('RLS violation'))
        .mockResolvedValueOnce(true);
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      // 获取死信队列项
      const deadLetters = service.deadLetterQueue();
      expect(deadLetters.length).toBe(1);
      
      // 从死信队列重试
      service.retryDeadLetter(deadLetters[0].action.id);
      
      // 应该回到主队列
      expect(service.queueSize()).toBe(1);
      expect(service.deadLetterSize()).toBe(0);
      
      // 再次处理应该成功
      await service.processQueue();
      expect(service.queueSize()).toBe(0);
    });
    
    it('应该能够放弃死信队列中的操作', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('not found'));
      service.registerProcessor('task:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'task',
        entityId: 'task-1',
        payload: { taskId: 'task-1', projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const deadLetters = service.deadLetterQueue();
      service.dismissDeadLetter(deadLetters[0].action.id);
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该限制死信队列大小为 50', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('unauthorized'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      
      // 添加 60 个会失败的操作
      for (let i = 0; i < 60; i++) {
        service.enqueue({
          type: 'create',
          entityType: 'task',
          entityId: `task-${i}`,
          payload: { task: { id: `task-${i}` } as any, projectId: 'proj-1' },
        });
      }
      
      setNetworkStatus(true);
      
      // 处理所有操作
      for (let i = 0; i < 60; i++) {
        await service.processQueue();
      }
      
      // 死信队列应该被限制在 50 个
      expect(service.deadLetterSize()).toBeLessThanOrEqual(50);
    });
    
    it('应该能够清空死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('forbidden'));
      service.registerProcessor('project:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: 'proj-1',
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

  // ==================== 持久化和恢复 ====================
  
  describe('队列持久化', () => {
    it('应该将队列持久化到 localStorage', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      const saved = localStorage.getItem('nanoflow.action-queue');
      expect(saved).toBeTruthy();
      
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });
    
    it('应该从 localStorage 恢复队列', () => {
      // 预设一些数据
      const presetActions: QueuedAction[] = [{
        id: 'action-1',
        type: 'update',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { project: { id: 'proj-1' } } as any,
        timestamp: Date.now(),
        retryCount: 0,
      }];
      
      localStorage.setItem('nanoflow.action-queue', JSON.stringify(presetActions));
      
      // 创建新实例，应该自动加载
      const newService = new ActionQueueService();
      
      expect(newService.queueSize()).toBe(1);
      expect(newService.pendingActions()[0].entityId).toBe('proj-1');
      
      newService.ngOnDestroy();
    });
    
    it('应该持久化死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('invalid input'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const savedDeadLetter = localStorage.getItem('nanoflow.dead-letter-queue');
      expect(savedDeadLetter).toBeTruthy();
      
      const parsed = JSON.parse(savedDeadLetter!);
      expect(parsed).toHaveLength(1);
    });
    
    it('应该在加载时清理过期的死信队列项', () => {
      // 预设一个过期的死信队列项（超过 24 小时）
      const oldDeadLetter: DeadLetterItem[] = [{
        action: {
          id: 'action-old',
          type: 'update',
          entityType: 'project',
          entityId: 'proj-old',
          payload: { project: { id: 'proj-old' } } as any,
          timestamp: Date.now() - 25 * 60 * 60 * 1000,
          retryCount: 5,
        },
        failedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        reason: 'Test failure',
      }];
      
      localStorage.setItem('nanoflow.dead-letter-queue', JSON.stringify(oldDeadLetter));
      
      // 创建新实例
      const newService = new ActionQueueService();
      
      // 过期项应该被清理
      expect(newService.deadLetterSize()).toBe(0);
      
      newService.ngOnDestroy();
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
        entityId: 'task-1',
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({
          entityId: 'task-1',
        }),
        reason: expect.stringContaining('业务错误'),
      }));
    });
    
    it('多个回调都应该被调用', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      service.onFailure(callback1);
      service.onFailure(callback2);
      
      const processor = vi.fn().mockRejectedValue(new Error('not found'));
      service.registerProcessor('project:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { projectId: 'proj-1', userId: 'user-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
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
    
    it('即使处理出错也应该调用结束回调', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      
      service.setQueueProcessCallbacks(onStart, onEnd);
      
      const processor = vi.fn().mockRejectedValue(new Error('duplicate key'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: { id: 'task-1' } as any, projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(onEnd).toHaveBeenCalled();
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
      
      expect(actions).toHaveLength(2);
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
      
      // 同时触发两次处理
      const promise1 = service.processQueue();
      const promise2 = service.processQueue();
      
      await Promise.all([promise1, promise2]);
      
      // 处理器应该只被调用一次
      expect(processor).toHaveBeenCalledTimes(1);
    });
  });
});
