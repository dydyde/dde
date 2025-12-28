/**
 * 撤销功能集成测试
 * 验证从 FlowLinkService 到 UndoService 的完整撤销链路
 */

import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { TaskOperationService } from './task-operation.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { UndoService } from './undo.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { UiStateService } from './ui-state.service';
import { Project, Task } from '../models';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock services
const mockSyncCoordinator = {
  markLocalChanges: vi.fn(),
  schedulePersist: vi.fn(),
  hasPendingLocalChanges: vi.fn(() => false)
};

const mockOptimisticState = {
  createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1', taskId: 'task-1', timestamp: Date.now() })),
  rollbackSnapshot: vi.fn()
};

const mockUiState = {
  markEditing: vi.fn(),
  isEditing: false
};

describe('撤销功能集成测试', () => {
  let taskOps: TaskOperationService;
  let taskAdapter: TaskOperationAdapterService;
  let undoService: UndoService;
  let projectState: ProjectStateService;
  let layoutService: LayoutService;
  
  // 测试项目
  let testProject: Project;
  let projectsSignal: WritableSignal<Project[]>;

  const now = new Date().toISOString();
  
  // 创建测试用任务的辅助函数
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '任务1',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 100,
    y: 100,
    displayId: '1',
    createdDate: now,
    ...overrides
  });
  
  const createTestProject = (): Project => ({
    id: 'test-project-1',
    name: '测试项目',
    description: '',
    createdDate: now,
    tasks: [
      createTask({ id: 'task-1', title: '根任务1' }),
      createTask({ id: 'task-1a', title: '子任务1a', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' }),
      createTask({ id: 'task-2', title: '根任务2', order: 2, rank: 2000, y: 200, displayId: '2' }),
      createTask({ id: 'unassigned-1', title: '待分配任务', stage: null, rank: 500, x: 50, y: 50, displayId: '?' })
    ],
    connections: []
  });

  beforeEach(() => {
    testProject = createTestProject();
    projectsSignal = signal([testProject]);
    
    TestBed.configureTestingModule({
      providers: [
        TaskOperationService,
        TaskOperationAdapterService,
        UndoService,
        LayoutService,
        {
          provide: ProjectStateService,
          useValue: {
            activeProject: () => projectsSignal()[0],
            updateProjects: (fn: (projects: Project[]) => Project[]) => {
              projectsSignal.update(fn);
            }
          }
        },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: OptimisticStateService, useValue: mockOptimisticState },
        { provide: UiStateService, useValue: mockUiState }
      ]
    });
    
    taskOps = TestBed.inject(TaskOperationService);
    taskAdapter = TestBed.inject(TaskOperationAdapterService);
    undoService = TestBed.inject(UndoService);
    projectState = TestBed.inject(ProjectStateService);
    layoutService = TestBed.inject(LayoutService);
  });

  afterEach(() => {
    undoService.clearHistory();
    vi.clearAllMocks();
  });

  describe('跨树连接撤销', () => {
    it('添加跨树连接后应该能够撤销', () => {
      const initialConnCount = projectsSignal()[0].connections.length;
      expect(initialConnCount).toBe(0);
      
      // 添加跨树连接
      taskAdapter.addCrossTreeConnection('task-1', 'task-2');
      
      // 验证连接已添加
      expect(projectsSignal()[0].connections.length).toBe(1);
      expect(projectsSignal()[0].connections[0].source).toBe('task-1');
      expect(projectsSignal()[0].connections[0].target).toBe('task-2');
      
      // 验证撤销记录已创建
      expect(undoService.canUndo()).toBe(true);
      expect(undoService.undoCount()).toBe(1);
    });

    it('添加并撤销跨树连接后连接数应恢复', () => {
      expect(projectsSignal()[0].connections.length).toBe(0);
      
      // 添加跨树连接
      taskAdapter.addCrossTreeConnection('task-1', 'task-2');
      expect(projectsSignal()[0].connections.length).toBe(1);
      
      // 执行撤销
      const undoAction = undoService.undo();
      expect(undoAction).not.toBeNull();
      
      // 应用撤销快照
      if (undoAction && typeof undoAction === 'object' && 'data' in undoAction) {
        const before = undoAction.data.before;
        projectsSignal.update(projects => projects.map(p => {
          if (p.id === undoAction.projectId) {
            return layoutService.rebalance({
              ...p,
              tasks: before.tasks ?? p.tasks,
              connections: before.connections ?? p.connections
            });
          }
          return p;
        }));
      }
      
      // 验证连接已恢复
      expect(projectsSignal()[0].connections.length).toBe(0);
    });
  });

  describe('待分配任务分配撤销', () => {
    it('将待分配任务分配到阶段后应该记录撤销', () => {
      const unassignedTask = projectsSignal()[0].tasks.find(t => t.id === 'unassigned-1');
      expect(unassignedTask?.stage).toBeNull();
      
      // 将待分配任务分配到 stage 2，成为 task-1 的子任务
      const result = taskAdapter.moveTaskToStage('unassigned-1', 2, undefined, 'task-1');
      expect(result.ok).toBe(true);
      
      // 验证任务已分配
      const assignedTask = projectsSignal()[0].tasks.find(t => t.id === 'unassigned-1');
      expect(assignedTask?.stage).toBe(2);
      expect(assignedTask?.parentId).toBe('task-1');
      
      // 验证撤销记录
      expect(undoService.canUndo()).toBe(true);
    });

    it('撤销分配操作后任务应恢复到待分配状态', () => {
      // 分配任务
      taskAdapter.moveTaskToStage('unassigned-1', 2, undefined, 'task-1');
      
      // 执行撤销
      const undoAction = undoService.undo();
      expect(undoAction).not.toBeNull();
      
      // 应用撤销快照
      if (undoAction && typeof undoAction === 'object' && 'data' in undoAction) {
        const before = undoAction.data.before;
        projectsSignal.update(projects => projects.map(p => {
          if (p.id === undoAction.projectId) {
            return layoutService.rebalance({
              ...p,
              tasks: before.tasks ?? p.tasks,
              connections: before.connections ?? p.connections
            });
          }
          return p;
        }));
      }
      
      // 验证任务恢复到待分配状态
      const restoredTask = projectsSignal()[0].tasks.find(t => t.id === 'unassigned-1');
      expect(restoredTask?.stage).toBeNull();
      expect(restoredTask?.parentId).toBeNull();
    });
  });

  describe('子树迁移撤销', () => {
    it('子树迁移后应该记录撤销', () => {
      // 验证初始状态
      const task1a = projectsSignal()[0].tasks.find(t => t.id === 'task-1a');
      expect(task1a?.parentId).toBe('task-1');
      
      // 将 task-1a 迁移到 task-2 下
      const result = taskAdapter.moveSubtreeToNewParent('task-1a', 'task-2');
      expect(result.ok).toBe(true);
      
      // 验证迁移成功
      const movedTask = projectsSignal()[0].tasks.find(t => t.id === 'task-1a');
      expect(movedTask?.parentId).toBe('task-2');
      
      // 验证撤销记录
      expect(undoService.canUndo()).toBe(true);
    });

    it('撤销子树迁移后应恢复原始父子关系', () => {
      // 迁移子树
      taskAdapter.moveSubtreeToNewParent('task-1a', 'task-2');
      
      // 执行撤销
      const undoAction = undoService.undo();
      expect(undoAction).not.toBeNull();
      
      // 应用撤销快照
      if (undoAction && typeof undoAction === 'object' && 'data' in undoAction) {
        const before = undoAction.data.before;
        projectsSignal.update(projects => projects.map(p => {
          if (p.id === undoAction.projectId) {
            return layoutService.rebalance({
              ...p,
              tasks: before.tasks ?? p.tasks,
              connections: before.connections ?? p.connections
            });
          }
          return p;
        }));
      }
      
      // 验证恢复到原始状态
      const restoredTask = projectsSignal()[0].tasks.find(t => t.id === 'task-1a');
      expect(restoredTask?.parentId).toBe('task-1');
    });
  });
});
