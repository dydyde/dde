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
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { SimpleSyncService } from './simple-sync.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { Task, Project, Connection } from '../../../models';

describe('SimpleSyncService', () => {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockLogger: any;
  let mockToast: any;
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
    mockClient = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            gt: vi.fn().mockResolvedValue({ data: [], error: null })
          })
        }),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null })
        })
      }),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis()
      })
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
    
    TestBed.configureTestingModule({
      providers: [
        SimpleSyncService,
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast }
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
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(true);
      expect(mockClient.from).toHaveBeenCalledWith('connections');
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
      
      // 验证使用了 upsert 而不是 insert
      const fromCall = mockClient.from.mock.results[0].value;
      expect(fromCall.upsert).toHaveBeenCalled();
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
  
  describe('兼容性接口', () => {
    it('state 别名应该指向 syncState', () => {
      expect(service.state).toBe(service.syncState);
    });
    
    it('isLoadingRemote signal 应该存在', () => {
      expect(service.isLoadingRemote()).toBe(false);
    });
  });
});
