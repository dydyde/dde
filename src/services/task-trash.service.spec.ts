/**
 * TaskTrashService 单元测试
 * 
 * 测试覆盖：
 * - 软删除任务（移动到回收站）
 * - 永久删除任务
 * - 从回收站恢复任务
 * - 清空回收站
 * - keepChildren 参数（保留子任务）
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TaskTrashService, TrashServiceCallbacks, DeleteResult } from './task-trash.service';
import { LoggerService } from './logger.service';
import { LayoutService } from './layout.service';
import { Project, Task } from '../models';

// 测试数据工厂
function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 100,
    y: 100,
    createdDate: now,
    updatedAt: now,
    displayId: '1',
    deletedAt: null,
    ...overrides,
  };
}

function createProject(tasks: Task[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks,
    connections: [],
  };
}

describe('TaskTrashService', () => {
  let service: TaskTrashService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  let mockLayoutService: Partial<LayoutService>;
  let currentProject: Project | null;
  let mockCallbacks: TrashServiceCallbacks;
  
  beforeEach(() => {
    currentProject = null;
    
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockLogger = {
      category: vi.fn().mockReturnValue(loggerMock),
    };
    
    // LayoutService mock - rebalance 直接返回传入的项目
    mockLayoutService = {
      rebalance: vi.fn().mockImplementation((p: Project) => p),
    };
    
    // 设置回调
    mockCallbacks = {
      getActiveProject: () => currentProject,
      recordAndUpdate: (mutator) => {
        if (currentProject) {
          currentProject = mutator(currentProject);
        }
      },
    };
    
    TestBed.configureTestingModule({
      providers: [
        TaskTrashService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: LayoutService, useValue: mockLayoutService },
      ],
    });
    
    service = TestBed.inject(TaskTrashService);
    service.setCallbacks(mockCallbacks);
  });
  
  describe('初始状态', () => {
    it('无活动项目时删除返回空结果', () => {
      currentProject = null;
      const result = service.deleteTask('task-1');
      expect(result.deletedTaskIds.size).toBe(0);
      expect(result.deletedConnectionIds).toHaveLength(0);
    });
    
    it('任务不存在时返回空结果', () => {
      currentProject = createProject([]);
      const result = service.deleteTask('non-existent');
      expect(result.deletedTaskIds.size).toBe(0);
    });
  });
  
  describe('软删除任务', () => {
    it('删除单个任务应设置 deletedAt', () => {
      const task = createTask({ id: 'task-1', title: 'Root Task' });
      currentProject = createProject([task]);
      
      const result = service.deleteTask('task-1');
      
      expect(result.deletedTaskIds.has('task-1')).toBe(true);
      expect(result.deletedTaskIds.size).toBe(1);
      
      const deletedTask = currentProject.tasks.find(t => t.id === 'task-1');
      expect(deletedTask?.deletedAt).toBeDefined();
      expect(deletedTask?.stage).toBeNull();
    });
    
    it('级联删除应包含所有子任务', () => {
      const root = createTask({ id: 'root', title: 'Root' });
      const child1 = createTask({ id: 'child1', parentId: 'root', title: 'Child 1' });
      const child2 = createTask({ id: 'child2', parentId: 'root', title: 'Child 2' });
      const grandchild = createTask({ id: 'grandchild', parentId: 'child1', title: 'Grandchild' });
      currentProject = createProject([root, child1, child2, grandchild]);
      
      const result = service.deleteTask('root');
      
      expect(result.deletedTaskIds.size).toBe(4);
      expect(result.deletedTaskIds.has('root')).toBe(true);
      expect(result.deletedTaskIds.has('child1')).toBe(true);
      expect(result.deletedTaskIds.has('child2')).toBe(true);
      expect(result.deletedTaskIds.has('grandchild')).toBe(true);
    });
    
    it('keepChildren=true 时应保留子任务', () => {
      const root = createTask({ id: 'root', parentId: null, title: 'Root' });
      const child = createTask({ id: 'child', parentId: 'root', title: 'Child' });
      currentProject = createProject([root, child]);
      
      const result = service.deleteTask('root', true);
      
      // 只删除根任务
      expect(result.deletedTaskIds.size).toBe(1);
      expect(result.deletedTaskIds.has('root')).toBe(true);
      expect(result.deletedTaskIds.has('child')).toBe(false);
      
      // 子任务应提升到被删除任务的父级
      const childTask = currentProject.tasks.find(t => t.id === 'child');
      expect(childTask?.parentId).toBeNull();
    });
    
    it('删除任务应同时删除相关连接', () => {
      const task1 = createTask({ id: 'task1' });
      const task2 = createTask({ id: 'task2' });
      const task3 = createTask({ id: 'task3' });
      currentProject = createProject([task1, task2, task3]);
      currentProject.connections = [
        { id: 'conn1', source: 'task1', target: 'task2' },
        { id: 'conn2', source: 'task2', target: 'task3' },
      ];
      
      const result = service.deleteTask('task2');
      
      expect(result.deletedConnectionIds).toContain('conn1');
      expect(result.deletedConnectionIds).toContain('conn2');
      expect(currentProject.connections).toHaveLength(0);
    });
  });
  
  describe('永久删除任务', () => {
    it('永久删除应从列表中移除任务', () => {
      const task = createTask({ id: 'task-1' });
      currentProject = createProject([task]);
      
      const result = service.permanentlyDeleteTask('task-1');
      
      expect(result.deletedTaskIds.has('task-1')).toBe(true);
      expect(currentProject.tasks.find(t => t.id === 'task-1')).toBeUndefined();
    });
    
    it('永久删除应级联删除子任务', () => {
      const root = createTask({ id: 'root' });
      const child = createTask({ id: 'child', parentId: 'root' });
      currentProject = createProject([root, child]);
      
      const result = service.permanentlyDeleteTask('root');
      
      expect(result.deletedTaskIds.size).toBe(2);
      expect(currentProject.tasks).toHaveLength(0);
    });
  });
  
  describe('恢复任务', () => {
    it('恢复任务应清除 deletedAt', () => {
      const task = createTask({ 
        id: 'task-1', 
        deletedAt: new Date().toISOString(),
        stage: null 
      });
      // 模拟 deletedMeta
      (task as any).deletedMeta = { parentId: null, stage: 1, order: 0, rank: 10000, x: 100, y: 100 };
      currentProject = createProject([task]);
      
      const result = service.restoreTask('task-1');
      
      expect(result.restoredTaskIds.has('task-1')).toBe(true);
      const restoredTask = currentProject.tasks.find(t => t.id === 'task-1');
      expect(restoredTask?.deletedAt).toBeNull();
      expect(restoredTask?.stage).toBe(1);
    });
  });
  
  describe('获取回收站任务', () => {
    it('应返回所有已删除的任务', () => {
      const activeTask = createTask({ id: 'active', deletedAt: null });
      const deletedTask = createTask({ id: 'deleted', deletedAt: new Date().toISOString() });
      currentProject = createProject([activeTask, deletedTask]);
      
      const trashTasks = service.getTrashTasks();
      
      expect(trashTasks).toHaveLength(1);
      expect(trashTasks[0].id).toBe('deleted');
    });
    
    it('无活动项目时返回空数组', () => {
      currentProject = null;
      const trashTasks = service.getTrashTasks();
      expect(trashTasks).toHaveLength(0);
    });
  });
  
  describe('清空回收站', () => {
    it('应永久删除所有回收站任务', () => {
      const activeTask = createTask({ id: 'active', deletedAt: null });
      const deletedTask1 = createTask({ id: 'deleted1', deletedAt: new Date().toISOString() });
      const deletedTask2 = createTask({ id: 'deleted2', deletedAt: new Date().toISOString() });
      currentProject = createProject([activeTask, deletedTask1, deletedTask2]);
      
      const result = service.emptyTrash();
      
      expect(result.deletedTaskIds.size).toBe(2);
      expect(currentProject.tasks).toHaveLength(1);
      expect(currentProject.tasks[0].id).toBe('active');
    });
  });
});
