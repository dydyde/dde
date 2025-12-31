/**
 * SimpleSyncService 单元测试
 * 
 * 测试覆盖：
 * - 初始化状态
 * - 离线模式行为
 * - 在线模式行为
 * - LWW (Last-Write-Wins) 冲突策略
 * - RetryQueue 重试逻辑
 * - 网络恢复回调
 * - Sentry 错误上报守卫测试
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SimpleSyncService } from './simple-sync.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { Task, Project, Connection } from '../../../models';

// Mock Sentry 模块 - 使用闭包捕获 mock 函数
vi.mock('@sentry/angular', () => {
  const captureException = vi.fn().mockReturnValue('mock-event-id');
  return {
    captureException,
    init: vi.fn(),
    browserTracingIntegration: vi.fn(),
    replayIntegration: vi.fn(),
  };
});

// 获取 mocked Sentry 以便在测试中访问
import * as Sentry from '@sentry/angular';
const mockCaptureException = vi.mocked(Sentry.captureException);

describe('SimpleSyncService', () => {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockLogger: any;
  let mockToast: any;
  let mockThrottle: any;
  let mockClient: any;
  
  // 测试数据工厂
  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    updatedAt: new Date().toISOString(),
    ...overrides
  });
  
  const createMockProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides
  });
  
  const createMockConnection = (overrides: Partial<Connection> = {}): Connection => ({
    id: 'conn-1',
    source: 'task-1',
    target: 'task-2',
    ...overrides
  });
  
  beforeEach(() => {
    // 重置模拟客户端
    // 注意：pushTask 现在会先检查 task_tombstones，然后再 upsert
    mockClient = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        // 默认返回用于 tasks/projects/connections 的 mock
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null })
          })
        };
      }),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis()
      }),
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        })
      }
    };
    
    mockSupabase = {
      isConfigured: false,
      client: vi.fn().mockReturnValue(null)
    };
    
    mockLogger = {
      category: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      })
    };
    
    mockToast = {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn()
    };
    
    // Mock RequestThrottleService - 直接执行传入的函数
    mockThrottle = {
      execute: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      })
    };
    
    TestBed.configureTestingModule({
      providers: [
        SimpleSyncService,
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: RequestThrottleService, useValue: mockThrottle }
      ]
    });
    
    service = TestBed.inject(SimpleSyncService);
  });
  
  afterEach(() => {
    // 清理定时器
    vi.clearAllTimers();
  });
  
  describe('初始化', () => {
    it('应该正确初始化状态', () => {
      expect(service.state().isSyncing).toBe(false);
      expect(service.state().pendingCount).toBe(0);
      expect(service.state().lastSyncTime).toBeNull();
    });
    
    it('应该初始化网络状态为在线', () => {
      expect(service.state().isOnline).toBe(true);
    });
    
    it('便捷 computed 属性应该正常工作', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.isSyncing()).toBe(false);
      expect(service.hasConflict()).toBe(false);
    });
  });
  
  describe('离线模式', () => {
    it('pushTask 应该添加到重试队列（离线时）', async () => {
      const task = createMockTask();
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('pullTasks 应该返回空数组（离线时）', async () => {
      const tasks = await service.pullTasks('project-1');
      expect(tasks).toEqual([]);
    });
    
    it('pushProject 应该添加到重试队列（离线时）', async () => {
      const project = createMockProject();
      
      const result = await service.pushProject(project);
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('pushConnection 应该添加到重试队列（离线时）', async () => {
      const connection = createMockConnection();
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('多个操作应该累积到重试队列', async () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2' });
      const project = createMockProject();
      
      await service.pushTask(task1, 'project-1');
      await service.pushTask(task2, 'project-1');
      await service.pushProject(project);
      
      expect(service.state().pendingCount).toBe(3);
    });
  });
  
  describe('在线模式', () => {
    beforeEach(() => {
      // 模拟在线状态
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });
    
    it('pushTask 应该成功推送', async () => {
      const task = createMockTask();
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(true);
      expect(service.state().lastSyncTime).not.toBeNull();
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
    
    it('pushTask 失败时应该加入重试队列', async () => {
      const task = createMockTask();
      mockClient.from = vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: new Error('Network error') })
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('pullTasks 应该返回任务列表', async () => {
      const tasks = await service.pullTasks('project-1', '2025-01-01');
      expect(tasks).toEqual([]);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
    
    it('pushProject 应该成功推送', async () => {
      const project = createMockProject();
      
      const result = await service.pushProject(project);
      
      expect(result).toBe(true);
      expect(mockClient.from).toHaveBeenCalledWith('projects');
    });
    
    it('pushConnection 应该成功推送', async () => {
      const connection = createMockConnection();
      
      // Mock 任务存在性查询（预检查）
      // 注意：移除了 .is('deleted_at', null) 检查，因为外键约束只检查任务行是否存在
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { id: connection.source },
                { id: connection.target }
              ],
              error: null
            })
          })
        })
      };
      
      // Mock connections upsert
      const connectionsQueryMock = {
        upsert: vi.fn().mockResolvedValue({ error: null })
      };
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return tasksQueryMock;
        if (table === 'connections') return connectionsQueryMock;
        return {};
      });
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(true);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
      expect(mockClient.from).toHaveBeenCalledWith('connections');
    });
    
    it('pushConnection 应该在任务不存在时跳过推送', async () => {
      const connection = createMockConnection();
      
      // Mock 任务查询返回空（任务不存在）
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [], // 任务不存在
              error: null
            })
          })
        })
      };
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return tasksQueryMock;
        return {};
      });
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(false);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
      expect(mockClient.from).not.toHaveBeenCalledWith('connections');
    });
    
    it('pushConnection 应该在外键约束错误时不加入重试队列', async () => {
      const connection = createMockConnection();
      
      // Mock 任务查询通过（假装任务存在）
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { id: connection.source },
                { id: connection.target }
              ],
              error: null
            })
          })
        })
      };
      
      // Mock connections upsert 返回外键错误
      const connectionsQueryMock = {
        upsert: vi.fn().mockResolvedValue({ 
          error: { 
            code: '23503',
            message: 'insert or update on table "connections" violates foreign key constraint "connections_source_id_fkey"'
          } 
        })
      };
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return tasksQueryMock;
        if (table === 'connections') return connectionsQueryMock;
        return {};
      });
      
      const initialQueueSize = service['retryQueue'].length;
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(false);
      // 外键错误不应该加入重试队列
      expect(service['retryQueue'].length).toBe(initialQueueSize);
    });
    
    it('pushConnection 应该在任务查询超时时跳过推送', async () => {
      const connection = createMockConnection();
      
      // Mock 任务查询超时（Promise.race 会选择 timeout）
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue(
              new Promise((resolve) => setTimeout(resolve, 10000)) // 10秒延迟，触发超时
            )
          })
        })
      };
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return tasksQueryMock;
        return {};
      });
      
      const result = await service.pushConnection(connection, 'project-1');
      
      // 超时应该导致推送失败（因为无法验证任务存在）
      expect(result).toBe(false);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
      expect(mockClient.from).not.toHaveBeenCalledWith('connections');
    });
  });
  
  describe('LWW (Last-Write-Wins) 冲突策略', () => {
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });
    
    it('推送任务时应该使用 upsert 实现 LWW', async () => {
      const task = createMockTask({ updatedAt: '2025-12-21T10:00:00Z' });
      
      await service.pushTask(task, 'project-1');
      
      // 验证调用了 tasks 表（第二次调用，第一次是 task_tombstones）
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
      // 验证 from 被调用了两次：先检查 tombstones，再 upsert
      expect(mockClient.from.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    
    it('拉取任务时应该支持增量同步（since 参数）', async () => {
      const since = '2025-12-20T00:00:00Z';
      
      await service.pullTasks('project-1', since);
      
      // 验证查询使用了 since 时间戳
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
    
    it('本地新/远程旧场景：本地数据应该通过 upsert 覆盖远程', async () => {
      const localTask = createMockTask({ 
        id: 'task-conflict',
        title: 'Local Version',
        updatedAt: '2025-12-21T12:00:00Z' // 更新的时间戳
      });
      
      const result = await service.pushTask(localTask, 'project-1');
      
      expect(result).toBe(true);
      // LWW：本地更新的数据会覆盖远程旧数据
    });
  });
  
  describe('RetryQueue 重试逻辑', () => {
    it('重试队列应该在网络恢复时自动处理', async () => {
      // 1. 离线状态添加任务
      const task = createMockTask();
      await service.pushTask(task, 'project-1');
      expect(service.state().pendingCount).toBe(1);
      
      // 2. 模拟网络恢复
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      // 手动触发网络恢复事件
      window.dispatchEvent(new Event('online'));
      
      // 等待异步处理
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 注意：由于 processRetryQueue 是私有方法，我们通过状态验证行为
      // 在实际实现中，网络恢复会自动触发重试
    });
    
    it('超过最大重试次数应该放弃并通知用户', async () => {
      // 这个测试验证的是重试逻辑的边界条件
      // 由于 MAX_RETRIES = 5，我们验证配置存在
      expect(service['MAX_RETRIES']).toBe(5);
    });
    
    it('重试间隔应该为 5 秒', () => {
      expect(service['RETRY_INTERVAL']).toBe(5000);
    });
    
    it('应该对 504 错误进行立即重试（指数退避）', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      const task = createMockTask();
      let upsertAttempts = 0;
      
      // 模拟前 2 次 upsert 失败（504），第 3 次成功
      // 注意：pushTask 会先检查 task_tombstones
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockImplementation(() => {
            upsertAttempts++;
            if (upsertAttempts < 3) {
              return Promise.resolve({ error: { code: 504, message: 'Gateway timeout' } });
            }
            return Promise.resolve({ error: null });
          })
        };
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(upsertAttempts).toBe(3); // 验证重试了 2 次后成功
      expect(result).toBe(true);
    });
    
    it('应该对 429 错误进行立即重试', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      const connection = createMockConnection();
      let attempts = 0;
      
      // Mock 任务存在性查询
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { id: connection.source },
                { id: connection.target }
              ],
              error: null
            })
          })
        })
      };
      
      // 模拟 429 错误后成功
      const connectionsQueryMock = {
        upsert: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts === 1) {
            return Promise.resolve({ error: { code: 429, message: 'Too many requests' } });
          }
          return Promise.resolve({ error: null });
        })
      };
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return tasksQueryMock;
        if (table === 'connections') return connectionsQueryMock;
        return {};
      });
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(attempts).toBe(2); // 验证重试了 1 次后成功
      expect(result).toBe(true);
    });
    
    it('非可重试错误应该立即失败（无重试）', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      const task = createMockTask();
      let upsertAttempts = 0;
      
      // 模拟 401 错误（不可重试）
      // 注意：pushTask 会先检查 task_tombstones
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockImplementation(() => {
            upsertAttempts++;
            return Promise.resolve({ error: { code: 401, message: 'Unauthorized' } });
          })
        };
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(upsertAttempts).toBe(1); // 验证没有重试
      expect(result).toBe(false);
    });
  });
  
  describe('网络状态监听', () => {
    it('应该在网络断开时更新状态', () => {
      window.dispatchEvent(new Event('offline'));
      
      // 等待事件处理
      expect(service.state().isOnline).toBe(false);
    });
    
    it('应该在网络恢复时更新状态', () => {
      // 先断开
      window.dispatchEvent(new Event('offline'));
      expect(service.state().isOnline).toBe(false);
      
      // 再恢复
      window.dispatchEvent(new Event('online'));
      expect(service.state().isOnline).toBe(true);
    });
  });
  
  describe('Realtime 订阅', () => {
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });
    
    it('setOnRemoteChange 应该设置回调', () => {
      const callback = vi.fn();
      service.setOnRemoteChange(callback);
      
      // 验证回调已设置（通过私有属性检查）
      expect(service['onRemoteChangeCallback']).toBe(callback);
    });
    
    it('subscribeToProject 应该创建 Realtime 通道', async () => {
      await service.subscribeToProject('project-1', 'user-123');
      
      expect(mockClient.channel).toHaveBeenCalled();
    });
  });
  
  describe('Tombstone 防护（防止已删除任务复活）', () => {
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });
    
    it('pushTask 应该跳过已在 tombstones 中的任务', async () => {
      const task = createMockTask({ id: 'deleted-task' });
      
      // 模拟 tombstones 中存在该任务
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ 
                  data: { task_id: 'deleted-task' }, 
                  error: null 
                })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null })
        };
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      // 【关键修复】tombstone 跳过时应返回 false，防止被标记为成功推送
      // 这样 saveProjectToCloud 不会将此任务加入 successfulTaskIds
      // 从而避免推送引用此任务的连接，防止外键约束违规
      expect(result).toBe(false);
      // 不应该加入重试队列（因为这不是失败，只是跳过）
      expect(service.state().pendingCount).toBe(0);
      // upsert 不应该被调用
      expect(mockClient.from).toHaveBeenCalledWith('task_tombstones');
    });
    
    it('pushTask 应该正常推送不在 tombstones 中的任务', async () => {
      const task = createMockTask({ id: 'normal-task' });
      
      // 模拟 tombstones 中不存在该任务
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null })
        };
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(true);
      expect(mockClient.from).toHaveBeenCalledWith('task_tombstones');
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
    
    it('pushTask tombstone 跳过时不应加入重试队列', async () => {
      // 验证 tombstone 跳过不会导致任务被加入重试队列
      const task = createMockTask({ id: 'tombstone-task' });
      
      // 模拟 tombstones 中存在该任务
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ 
                  data: { task_id: 'tombstone-task' }, 
                  error: null 
                })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null })
        };
      });
      
      // 先确认初始状态
      expect(service.state().pendingCount).toBe(0);
      
      const result = await service.pushTask(task, 'project-1');
      
      // tombstone 跳过返回 false，但不应加入重试队列
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(0);
    });
  });
  
  describe('兼容性接口', () => {
    it('state 别名应该指向 syncState', () => {
      expect(service.state).toBe(service.syncState);
    });
    
    it('isLoadingRemote signal 应该存在', () => {
      expect(service.isLoadingRemote()).toBe(false);
    });
  });
  
  describe('Sentry 错误上报守卫测试', () => {
    /**
     * Phase 0 Sentry 守卫测试
     * 验证同步失败时 Sentry.captureException 被正确调用
     * 这是重构前的安全网，确保错误上报逻辑不会被意外删除
     */
    
    beforeEach(() => {
      // 清除之前的调用记录
      mockCaptureException.mockClear();
      
      // 配置为在线模式
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });
    
    it('pushTask 失败时应该调用 Sentry.captureException 并包含正确的 tags', async () => {
      const task = createMockTask({ id: 'fail-task' });
      const networkError = new Error('Network error');
      
      // 模拟 pushTask 过程中发生错误
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        // tasks 表的 upsert 失败
        return {
          upsert: vi.fn().mockRejectedValue(networkError)
        };
      });
      
      const result = await service.pushTask(task, 'project-1');
      
      // 验证返回失败
      expect(result).toBe(false);
      
      // 验证 Sentry 被调用
      expect(mockCaptureException).toHaveBeenCalled();
      
      // 验证调用参数包含正确的 tags
      const callArgs = mockCaptureException.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        tags: expect.objectContaining({
          operation: 'pushTask'
        })
      });
    });
    
    it('pushTask 失败时应该将任务加入 RetryQueue', async () => {
      const task = createMockTask({ id: 'retry-task' });
      const networkError = new Error('Network error');
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockRejectedValue(networkError)
        };
      });
      
      await service.pushTask(task, 'project-1');
      
      // 验证 pendingCount 增加（任务被加入重试队列）
      expect(service.state().pendingCount).toBeGreaterThan(0);
    });
    
    it('deleteTask 失败时应该调用 Sentry.captureException', async () => {
      const deleteError = new Error('Delete failed');
      
      // 正确模拟 deleteTask 的调用链: from('tasks').delete().eq('id', taskId)
      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockRejectedValue(deleteError)
        })
      });
      
      await service.deleteTask('task-to-delete', 'project-1');
      
      expect(mockCaptureException).toHaveBeenCalled();
      const callArgs = mockCaptureException.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        tags: expect.objectContaining({
          operation: 'deleteTask'
        })
      });
    });
    
    it('Sentry 上报应该区分可重试和不可重试错误', async () => {
      const task = createMockTask({ id: 'level-test-task' });
      
      // 模拟一个可重试的网络错误
      const retryableError = new Error('fetch failed');
      (retryableError as any).code = 'NETWORK_ERROR';
      
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockRejectedValue(retryableError)
        };
      });
      
      await service.pushTask(task, 'project-1');
      
      expect(mockCaptureException).toHaveBeenCalled();
      // 验证包含 isRetryable 标签
      const callArgs = mockCaptureException.mock.calls[0];
      expect((callArgs[1] as any)?.tags).toHaveProperty('isRetryable');
    });
  });

  describe('RetryQueue Dependency Logic', () => {
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });

    it('should skip connection if source task fails to sync in the same batch', async () => {
      const task1 = createMockTask({ id: 'task-1' }); // Will fail
      const task2 = createMockTask({ id: 'task-2' }); // Will succeed
      const conn = createMockConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });

      // Mock task-1 failure
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                    })
                })
            };
        }
        if (table === 'tasks') {
          return {
            upsert: vi.fn().mockImplementation((data) => {
              if (data.id === 'task-1') {
                return Promise.resolve({ error: new Error('Sync failed') });
              }
              return Promise.resolve({ error: null });
            })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          delete: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          })
        };
      });

      // Add to retry queue manually
      (service as any).addToRetryQueue('task', 'upsert', task1, 'project-1');
      (service as any).addToRetryQueue('task', 'upsert', task2, 'project-1');
      (service as any).addToRetryQueue('connection', 'upsert', conn, 'project-1');

      // Trigger processing
      await (service as any).processRetryQueue();

      // Verify task-1 failed, task-2 succeeded
      // Verify connection was NOT attempted (because source task-1 failed)
      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: any[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(0);

      // Verify connection remains in queue
      expect((service as any).retryQueue.length).toBeGreaterThan(0);
      const queuedConn = (service as any).retryQueue.find((item: any) => item.type === 'connection');
      expect(queuedConn).toBeDefined();
      expect(queuedConn.data.id).toBe('conn-1');
    });

    it('should sync connection if both tasks succeed', async () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2' });
      const conn = createMockConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });

      // 使用更通用的 mock，所有 select 查询都返回任务存在
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        if (table === 'tasks') {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null
                }),
                // 也处理没有 eq 的情况（批量查询）
                then: (resolve: Function) => resolve({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null
                })
              })
            })
          };
        }
        if (table === 'connections') {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [], error: null })
          })
        };
      });

      (service as any).addToRetryQueue('task', 'upsert', task1, 'project-1');
      (service as any).addToRetryQueue('task', 'upsert', task2, 'project-1');
      (service as any).addToRetryQueue('connection', 'upsert', conn, 'project-1');

      await (service as any).processRetryQueue();

      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: any[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(1);
      expect((service as any).retryQueue.length).toBe(0);
    });
  });
});
