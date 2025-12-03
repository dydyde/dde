/**
 * RemoteChangeHandlerService 单元测试
 * 
 * 测试覆盖核心逻辑：
 * 1. 请求 ID 机制确保只处理最新请求
 * 2. 服务销毁后忽略进行中的请求
 * 3. 项目切换后忽略旧项目的请求
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, DestroyRef } from '@angular/core';
import { RemoteChangeHandlerService } from './remote-change-handler.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';

// ========== Mock 工厂函数 ==========

function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-project-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides
  };
}

function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1',
    title: 'Test Task',
    content: '',
    stage: 1,
    rank: 10000,
    displayId: '1',
    status: 'active',
    hasIncompleteTask: false,
    parentId: null,
    order: 0,
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    ...overrides
  };
}

// ========== Mock 服务 ==========

const mockSyncCoordinator = {
  loadSingleProject: vi.fn(),
  setupRemoteChangeCallbacks: vi.fn(),
  hasPendingLocalChanges: vi.fn().mockReturnValue(false),
  getLastPersistAt: vi.fn().mockReturnValue(0),
};

const mockUndoService = {
  clearOutdatedHistory: vi.fn().mockReturnValue(0),
  clearTaskHistory: vi.fn(),
};

const mockUiState = {
  isEditing: false,
};

const mockActiveProjectId = signal<string | null>('test-project-1');
const mockProjects = signal<Project[]>([createTestProject()]);

const mockProjectState = {
  activeProjectId: mockActiveProjectId,
  projects: mockProjects,
  updateProjects: vi.fn((updater: (ps: Project[]) => Project[]) => {
    mockProjects.set(updater(mockProjects()));
  }),
};

const mockToastService = {
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

const mockAuthService = {
  currentUserId: vi.fn().mockReturnValue('user-123'),
};

const mockLoggerService = {
  category: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
};

const destroyCallbacks: (() => void)[] = [];
const mockDestroyRef = {
  onDestroy: (callback: () => void) => {
    destroyCallbacks.push(callback);
  },
};

describe('RemoteChangeHandlerService', () => {
  let service: RemoteChangeHandlerService;

  beforeEach(() => {
    vi.clearAllMocks();
    destroyCallbacks.length = 0;
    mockActiveProjectId.set('test-project-1');
    mockProjects.set([createTestProject()]);
    mockUiState.isEditing = false;
    mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(false);
    mockSyncCoordinator.getLastPersistAt.mockReturnValue(0);

    TestBed.configureTestingModule({
      providers: [
        RemoteChangeHandlerService,
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ToastService, useValue: mockToastService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });

    service = TestBed.inject(RemoteChangeHandlerService);
  });

  afterEach(() => {
    service.reset();
  });

  describe('请求 ID 机制', () => {
    it('快速连续请求应只处理最后一个', async () => {
      const task1 = createTestTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTestTask({ id: 'task-1', title: 'Task 2' });
      const task3 = createTestTask({ id: 'task-1', title: 'Task 3 (Final)' });

      // 模拟三个连续的远程加载，每个返回不同的任务版本
      let resolveFirst: (value: Project) => void;
      let resolveSecond: (value: Project) => void;
      let resolveThird: (value: Project) => void;

      mockSyncCoordinator.loadSingleProject
        .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { resolveThird = resolve; }));

      // 设置回调
      service.setupCallbacks(async () => {});

      // 获取内部的任务变更处理器
      const taskChangeHandler = mockSyncCoordinator.setupRemoteChangeCallbacks.mock.calls[0][1];

      // 快速触发三个任务更新事件
      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });

      // 等待一下让所有请求都发出
      await new Promise(resolve => setTimeout(resolve, 10));

      // 第一个请求完成（应该被忽略，因为已经有更新的请求）
      resolveFirst!(createTestProject({ tasks: [task1] }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // 第二个请求完成（也应该被忽略）
      resolveSecond!(createTestProject({ tasks: [task2] }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // 第三个请求完成（应该被处理）
      resolveThird!(createTestProject({ tasks: [task3] }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // 验证只有最后一个请求的结果被应用
      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      const lastCall = mockProjectState.updateProjects.mock.calls[mockProjectState.updateProjects.mock.calls.length - 1];
      const updater = lastCall[0];
      const result = updater([createTestProject()]);
      expect(result[0].tasks[0].title).toBe('Task 3 (Final)');
    });
  });

  describe('服务销毁处理', () => {
    it('销毁后应忽略进行中的请求', async () => {
      let resolveRequest: (value: Project) => void;
      mockSyncCoordinator.loadSingleProject.mockImplementation(
        () => new Promise(resolve => { resolveRequest = resolve; })
      );

      service.setupCallbacks(async () => {});
      const taskChangeHandler = mockSyncCoordinator.setupRemoteChangeCallbacks.mock.calls[0][1];

      // 触发请求
      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      await new Promise(resolve => setTimeout(resolve, 10));

      // 在请求完成前触发销毁
      destroyCallbacks.forEach(cb => cb());

      // 请求完成
      resolveRequest!(createTestProject({ tasks: [createTestTask()] }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // 验证销毁后请求结果不被处理
      // updateProjects 不应该被调用（或者调用次数应该是销毁前的）
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
  });

  describe('项目切换处理', () => {
    it('项目切换后应忽略旧项目的请求', async () => {
      let resolveRequest: (value: Project) => void;
      mockSyncCoordinator.loadSingleProject.mockImplementation(
        () => new Promise(resolve => { resolveRequest = resolve; })
      );

      service.setupCallbacks(async () => {});
      const taskChangeHandler = mockSyncCoordinator.setupRemoteChangeCallbacks.mock.calls[0][1];

      // 触发项目1的任务更新请求
      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      await new Promise(resolve => setTimeout(resolve, 10));

      // 在请求完成前切换到另一个项目
      mockActiveProjectId.set('test-project-2');

      // 请求完成
      resolveRequest!(createTestProject({ tasks: [createTestTask()] }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // 验证旧项目的请求结果不被处理
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
  });

  describe('编辑状态检查', () => {
    it('用户编辑中应跳过远程更新', async () => {
      mockUiState.isEditing = true;

      service.setupCallbacks(async () => {});
      const taskChangeHandler = mockSyncCoordinator.setupRemoteChangeCallbacks.mock.calls[0][1];

      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      await new Promise(resolve => setTimeout(resolve, 10));

      // 验证编辑中不发起请求
      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
    });

    it('有待同步本地变更时应跳过远程更新', async () => {
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

      service.setupCallbacks(async () => {});
      const taskChangeHandler = mockSyncCoordinator.setupRemoteChangeCallbacks.mock.calls[0][1];

      taskChangeHandler({ eventType: 'UPDATE', taskId: 'task-1', projectId: 'test-project-1' });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
    });
  });
});
