/**
 * UndoService 撤销功能测试
 * 验证撤销/重做核心功能
 */

import { TestBed } from '@angular/core/testing';
import { UndoService } from './undo.service';
import { Project, Task } from '../models';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('UndoService', () => {
  let service: UndoService;
  
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
  
  // 创建测试用项目
  const createTestProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'test-project-1',
    name: '测试项目',
    description: '',
    createdDate: now,
    tasks: [createTask({ id: 'task-1', title: '任务1' })],
    connections: [],
    ...overrides
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [UndoService]
    });
    service = TestBed.inject(UndoService);
  });

  afterEach(() => {
    service.clearHistory();
  });

  describe('基本撤销功能', () => {
    it('初始状态应该没有可撤销的操作', () => {
      expect(service.canUndo()).toBe(false);
      expect(service.undoCount()).toBe(0);
    });

    it('记录操作后应该有可撤销的操作', () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '新任务', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBe(1);
    });

    it('撤销后应该返回正确的快照', () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '新任务', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      const result = service.undo();
      
      expect(result).not.toBeNull();
      expect(result).not.toBe('version-mismatch');
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.tasks?.length).toBe(1);
        expect(result.data.after.tasks?.length).toBe(2);
      }
    });
  });

  describe('连接操作撤销', () => {
    it('添加跨树连接后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '任务2', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' }),
          createTask({ id: 'task-3', title: '任务3', order: 2, rank: 2000, y: 200, displayId: '2' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-3' }]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.connections?.length).toBe(0);
        expect(result.data.after.connections?.length).toBe(1);
      }
    });

    it('快照应该正确捕获任务和连接', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '任务2', stage: null, rank: 500, x: 50, y: 50, displayId: '?' })
        ],
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-2' }]
      });
      
      const snapshot = service.createProjectSnapshot(project);
      
      expect(snapshot.tasks?.length).toBe(2);
      expect(snapshot.connections?.length).toBe(1);
      expect(snapshot.tasks?.find(t => t.id === 'task-1')).toBeDefined();
      expect(snapshot.tasks?.find(t => t.id === 'task-2')?.stage).toBeNull();
      expect(snapshot.connections?.[0].source).toBe('task-1');
    });
  });

  describe('待分配到已分配任务移动撤销', () => {
    it('将待分配任务分配到阶段后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '待分配任务', stage: null, rank: 500, x: 50, y: 50, displayId: '?' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '待分配任务', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        const beforeTask2 = result.data.before.tasks?.find(t => t.id === 'task-2');
        const afterTask2 = result.data.after.tasks?.find(t => t.id === 'task-2');
        
        expect(beforeTask2?.stage).toBeNull();
        expect(beforeTask2?.parentId).toBeNull();
        expect(afterTask2?.stage).toBe(2);
        expect(afterTask2?.parentId).toBe('task-1');
      }
    });
  });

  describe('子树迁移撤销', () => {
    it('将子任务迁移到新父任务后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '父任务1' }),
          createTask({ id: 'task-1a', title: '子任务1a', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' }),
          createTask({ id: 'task-1ab', title: '孙任务1ab', stage: 3, parentId: 'task-1a', rank: 1750, x: 300, displayId: '1,a,a' }),
          createTask({ id: 'task-2', title: '父任务2', order: 2, rank: 2000, y: 200, displayId: '2' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          createTask({ id: 'task-1', title: '父任务1' }),
          createTask({ id: 'task-1a', title: '子任务1a', stage: 2, parentId: 'task-2', rank: 2500, x: 200, y: 200, displayId: '2,a' }),
          createTask({ id: 'task-1ab', title: '孙任务1ab', stage: 3, parentId: 'task-1a', rank: 2750, x: 300, y: 200, displayId: '2,a,a' }),
          createTask({ id: 'task-2', title: '父任务2', order: 2, rank: 2000, y: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        const beforeTask1a = result.data.before.tasks?.find(t => t.id === 'task-1a');
        const afterTask1a = result.data.after.tasks?.find(t => t.id === 'task-1a');
        
        expect(beforeTask1a?.parentId).toBe('task-1');
        expect(beforeTask1a?.displayId).toBe('1,a');
        expect(afterTask1a?.parentId).toBe('task-2');
        expect(afterTask1a?.displayId).toBe('2,a');
      }
    });
  });

  describe('操作合并', () => {
    it('2秒内的连续操作应该合并', async () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject1: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '任务2', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot1 = service.createProjectSnapshot(afterProject1);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot1 }
      });
      
      expect(service.undoCount()).toBe(1);
      
      const afterProject2: Project = {
        ...afterProject1,
        tasks: [
          ...afterProject1.tasks,
          createTask({ id: 'task-3', title: '任务3', order: 3, rank: 3000, x: 300, displayId: '3' })
        ]
      };
      const afterSnapshot2 = service.createProjectSnapshot(afterProject2);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: afterSnapshot1, after: afterSnapshot2 }
      });
      
      expect(service.undoCount()).toBe(1);
      
      const result = service.undo();
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.tasks?.length).toBe(1);
        expect(result.data.after.tasks?.length).toBe(3);
      }
    });
  });

  describe('批处理模式', () => {
    it('批处理模式下的操作应该合并为一个撤销单元', () => {
      const project = createTestProject();
      
      service.beginBatch(project);
      
      const afterProject1: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '任务2', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: service.createProjectSnapshot(project), after: service.createProjectSnapshot(afterProject1) }
      });
      
      expect(service.undoCount()).toBe(0);
      
      service.endBatch(afterProject1);
      
      expect(service.undoCount()).toBe(1);
    });
  });
});
