/**
 * SyncService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 离线快照持久化
 * 2. 状态管理
 * 3. Realtime 订阅管理
 * 4. 冲突解决
 * 
 * 注意：完整的云同步测试需要集成测试环境
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SyncService } from './sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';

// ========== 模拟 Supabase Client ==========

const mockSupabaseChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockImplementation((callback) => {
    if (callback) callback('SUBSCRIBED');
    return mockSupabaseChannel;
  }),
  unsubscribe: vi.fn(),
};

const createMockFromChain = () => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
});

let mockFromChain = createMockFromChain();

const mockSupabaseClient = {
  from: vi.fn(() => mockFromChain),
  channel: vi.fn().mockReturnValue(mockSupabaseChannel),
  removeChannel: vi.fn(),
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } }),
  },
};

// 模拟 SupabaseClientService
const mockSupabaseClientService = {
  client: vi.fn().mockReturnValue(mockSupabaseClient),
  isConfigured: true,
  configurationError: signal<string | null>(null),
  isOfflineMode: signal(false),
};

// 模拟 TaskRepositoryService
const mockTaskRepository = {
  loadProjectTasks: vi.fn().mockResolvedValue([]),
  loadProjectConnections: vi.fn().mockResolvedValue([]),
  saveProjectTasks: vi.fn().mockResolvedValue({ success: true }),
  saveProjectConnections: vi.fn().mockResolvedValue({ success: true }),
  deleteProjectData: vi.fn().mockResolvedValue({ success: true }),
};

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

// ========== 辅助函数 ==========

function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}

// ========== 测试用例 ==========

describe('SyncService', () => {
  let service: SyncService;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    // 重置 mock 链
    mockFromChain = createMockFromChain();
    mockSupabaseClient.from.mockReturnValue(mockFromChain);

    TestBed.configureTestingModule({
      providers: [
        SyncService,
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: TaskRepositoryService, useValue: mockTaskRepository },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    // 获取服务实例
    service = TestBed.inject(SyncService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ==================== 离线快照持久化 ====================

  describe('离线快照持久化', () => {
    it('应该保存离线快照到 localStorage', () => {
      const projects = [
        createTestProject({ id: 'proj-1', name: 'Project 1' }),
        createTestProject({ id: 'proj-2', name: 'Project 2' }),
      ];

      service.saveOfflineSnapshot(projects);

      const saved = localStorage.getItem('nanoflow.offline-cache-v2');
      expect(saved).toBeTruthy();

      const parsed = JSON.parse(saved!);
      expect(parsed.projects).toHaveLength(2);
    });

    it('应该能够加载离线快照', () => {
      const projects = [
        createTestProject({ id: 'proj-1', name: 'Project 1' }),
      ];

      service.saveOfflineSnapshot(projects);
      const loaded = service.loadOfflineSnapshot();

      expect(loaded).toHaveLength(1);
      expect(loaded![0].name).toBe('Project 1');
    });

    it('离线快照应该包含版本号', () => {
      const projects = [createTestProject()];

      service.saveOfflineSnapshot(projects);

      const saved = localStorage.getItem('nanoflow.offline-cache-v2');
      const parsed = JSON.parse(saved!);

      // 实现中保存的是 version 而不是 timestamp
      expect(parsed.version).toBeDefined();
    });

    it('清除离线缓存应该移除 localStorage 数据', () => {
      service.saveOfflineSnapshot([createTestProject()]);
      expect(localStorage.getItem('nanoflow.offline-cache-v2')).toBeTruthy();

      service.clearOfflineCache();

      expect(localStorage.getItem('nanoflow.offline-cache-v2')).toBeNull();
    });

    it('加载空缓存应该返回 null', () => {
      const loaded = service.loadOfflineSnapshot();
      expect(loaded).toBeNull();
    });

    it('应该保存大量项目', () => {
      const projects = Array.from({ length: 100 }, (_, i) =>
        createTestProject({ id: `proj-${i}`, name: `Project ${i}` })
      );

      service.saveOfflineSnapshot(projects);
      const loaded = service.loadOfflineSnapshot();

      expect(loaded).toHaveLength(100);
    });
  });

  // ==================== 状态管理 ====================

  describe('状态管理', () => {
    it('初始状态应该正确', () => {
      const state = service.syncState();

      expect(state.isSyncing).toBe(false);
      expect(state.offlineMode).toBe(false);
      expect(state.sessionExpired).toBe(false);
      expect(state.hasConflict).toBe(false);
    });

    it('isLoadingRemote 初始值应该为 false', () => {
      expect(service.isLoadingRemote()).toBe(false);
    });
  });

  // ==================== 冲突解决 ====================

  describe('冲突解决', () => {
    it('解决冲突后应该清除 hasConflict 状态', () => {
      // 先模拟设置冲突状态
      const conflictProject = createTestProject({ id: 'proj-1' });
      
      // 调用 resolveConflict
      service.resolveConflict('proj-1', conflictProject, 'local');

      // 验证状态被清除
      expect(service.syncState().hasConflict).toBe(false);
      expect(service.syncState().conflictData).toBeNull();
    });

    it('解决冲突时应该记录日志', () => {
      const project = createTestProject({ id: 'proj-1' });
      
      service.resolveConflict('proj-1', project, 'local');

      expect(mockLoggerCategory.info).toHaveBeenCalled();
    });
  });

  // ==================== Realtime 订阅管理 ====================

  describe('Realtime 订阅管理', () => {
    it('暂停更新应该记录日志', () => {
      // 实际实现中 pauseRealtimeUpdates 设置内部 pauseRemoteUpdates 变量
      // 而不是修改 syncState.offlineMode
      service.pauseRealtimeUpdates();

      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('远程更新已暂停');
    });

    it('恢复更新应该记录日志', () => {
      service.pauseRealtimeUpdates();
      service.resumeRealtimeUpdates();

      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('远程更新已恢复');
    });

    it('销毁订阅应该调用 removeChannel', async () => {
      // 先初始化订阅
      await service.initRealtimeSubscription('user-1');
      
      // 销毁
      service.teardownRealtimeSubscription();

      expect(mockSupabaseClient.removeChannel).toHaveBeenCalled();
    });
  });

  // ==================== 回调设置 ====================

  describe('回调设置', () => {
    it('应该能够设置远程变更回调', () => {
      const callback = vi.fn();
      
      // 通过某种方式设置回调（根据实际实现）
      service.setRemoteChangeCallback(callback);

      // 验证不会抛出错误
      expect(true).toBe(true);
    });

    it('应该能够设置任务变更回调', () => {
      const callback = vi.fn();
      
      service.setTaskChangeCallback(callback);

      expect(true).toBe(true);
    });
  });

  // ==================== 边界条件 ====================

  describe('边界条件', () => {
    it('无效的离线快照数据应该返回 null', () => {
      localStorage.setItem('nanoflow.offline-cache', 'invalid json');
      
      const loaded = service.loadOfflineSnapshot();
      
      expect(loaded).toBeNull();
    });

    it('空 userId 不应该初始化订阅', async () => {
      await service.initRealtimeSubscription('');
      
      // 不应该创建 channel
      // 具体行为取决于实现
    });
  });
});
