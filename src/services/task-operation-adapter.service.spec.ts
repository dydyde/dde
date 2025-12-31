/**
 * TaskOperationAdapterService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. moveTaskToStage - Toast 显示逻辑
 * 2. 边缘情况 - 项目切换竞态条件
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { TaskOperationService } from './task-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { success } from '../utils/result';

// ========== 辅助函数 ==========

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  title: '测试任务',
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
  displayId: '1',
  hasIncompleteTask: false,
  ...overrides,
});

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: '测试项目',
  description: '',
  createdDate: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: [],
  connections: [],
  version: 1,
  ...overrides,
});

// ========== Mock 服务 ==========

let mockProjectsSignal = signal<Project[]>([]);
let mockActiveProjectIdSignal = signal<string | null>(null);

const mockProjectStateService = {
  projects: () => mockProjectsSignal(),
  activeProject: () => {
    const projectId = mockActiveProjectIdSignal();
    return mockProjectsSignal().find(p => p.id === projectId) || null;
  },
  activeProjectId: () => mockActiveProjectIdSignal(),
  setProjects: vi.fn((projects: Project[]) => {
    mockProjectsSignal.set(projects);
  }),
  updateProjects: vi.fn((mutator: (projects: Project[]) => Project[]) => {
    mockProjectsSignal.update(mutator);
  }),
};

const mockTaskOperationService = {
  moveTaskToStage: vi.fn(),
  setCallbacks: vi.fn(),
};

const mockOptimisticStateService = {
  createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1', type: 'task-move' })),
  commitSnapshot: vi.fn(),
  rollbackSnapshot: vi.fn(),
  discardSnapshot: vi.fn(),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockSyncCoordinatorService = {
  markLocalChanges: vi.fn(),
};

const mockChangeTrackerService = {};
const mockUndoService = {};
const mockUiStateService = { isEditing: false };
const mockLayoutService = {};

describe('TaskOperationAdapterService - moveTaskToStage', () => {
  let service: TaskOperationAdapterService;
  let project: Project;
  let task1: Task;
  let task2: Task;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    
    TestBed.configureTestingModule({
      providers: [
        TaskOperationAdapterService,
        { provide: TaskOperationService, useValue: mockTaskOperationService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: OptimisticStateService, useValue: mockOptimisticStateService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinatorService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: LayoutService, useValue: mockLayoutService },
      ],
    });

    service = TestBed.inject(TaskOperationAdapterService);

    // 初始化项目和任务
    task1 = createTask({ id: 'task-1', stage: 1, parentId: null });
    task2 = createTask({ id: 'task-2', stage: 2, parentId: 'task-1' });
    project = createProject({ id: 'proj-1', tasks: [task1, task2] });
    
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
  });

  it('should not show toast when task is not actually moved (same stage and parentId)', () => {
    // 模拟移动前后任务状态没有变化
    mockTaskOperationService.moveTaskToStage.mockReturnValue(success(undefined));
    
    // 调用移动（到相同的 stage，parentId 也相同）
    const result = service.moveTaskToStage('task-1', 1, null, null);
    
    // 验证
    expect(result.ok).toBe(true);
    expect(mockToastService.success).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
      '任务未发生实际移动，跳过 Toast 提示',
      expect.any(Object)
    );
  });

  it('should show toast when task stage changes', () => {
    // 模拟 stage 改变
    mockTaskOperationService.moveTaskToStage.mockImplementation(() => {
      // 修改任务的 stage
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, stage: 2 } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockToastService.success).toHaveBeenCalledWith(
      '已移动到阶段 2',
      undefined,
      expect.objectContaining({
        duration: 5000,
        action: expect.objectContaining({
          label: '撤销',
        }),
      })
    );
    expect(mockOptimisticStateService.discardSnapshot).not.toHaveBeenCalled();
  });

  it('should show toast when task parentId changes', () => {
    // 模拟 parentId 改变
    mockTaskOperationService.moveTaskToStage.mockImplementation(() => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-2' ? { ...t, parentId: null } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = service.moveTaskToStage('task-2', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockToastService.success).toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).not.toHaveBeenCalled();
  });

  it('should discard snapshot when project is switched during operation', () => {
    // 模拟操作期间项目切换
    mockTaskOperationService.moveTaskToStage.mockImplementation(() => {
      // 切换到另一个项目
      mockActiveProjectIdSignal.set('proj-2');
      return success(undefined);
    });
    
    const result = service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockToastService.success).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      '项目在操作期间被切换，丢弃移动结果',
      expect.objectContaining({
        projectIdBefore: 'proj-1',
        projectIdAfter: 'proj-2',
      })
    );
  });

  it('should rollback snapshot when operation fails', () => {
    // 模拟操作失败
    const failureResult = { ok: false, error: { code: 'ERROR', message: '操作失败' } };
    mockTaskOperationService.moveTaskToStage.mockReturnValue(failureResult);
    
    const result = service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(false);
    expect(mockToastService.success).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
  });

  it('should show toast when moving to unassigned area', () => {
    // 模拟移动到待分配区
    mockTaskOperationService.moveTaskToStage.mockImplementation(() => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, stage: null } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = service.moveTaskToStage('task-1', null, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockToastService.success).toHaveBeenCalledWith(
      '已移动到待分配区',
      undefined,
      expect.any(Object)
    );
  });
});
