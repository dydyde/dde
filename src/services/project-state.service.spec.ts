/**
 * ProjectStateService 单元测试 (Vitest + Injector 隔离模式)
 * 
 * 测试覆盖：
 * 1. taskConnectionsMap - 连接关系缓存计算
 * 2. getTaskConnections - O(1) 查找
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { ProjectStateService, TaskConnectionInfo } from './project-state.service';
import { Task, Project, Connection } from '../models';
import { LayoutService } from './layout.service';
import { UiStateService } from './ui-state.service';
import { TaskStore, ProjectStore, ConnectionStore } from '../app/core/state/stores';

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

const createConnection = (source: string, target: string, description?: string): Connection => ({
  id: crypto.randomUUID(),
  source,
  target,
  description,
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
let mockTasksMap = new Map<string, Task>();
let mockConnectionsMap = new Map<string, Connection>();

const mockTaskStore = {
  getTasksByProject: vi.fn((projectId: string) => {
    const project = mockProjectsSignal().find(p => p.id === projectId);
    return project?.tasks || [];
  }),
  getTask: vi.fn((id: string) => mockTasksMap.get(id)),
  setTasks: vi.fn(),
  clear: vi.fn(),
};

const mockProjectStore = {
  projects: () => mockProjectsSignal(),
  activeProjectId: mockActiveProjectIdSignal,
  activeProject: () => {
    const id = mockActiveProjectIdSignal();
    return mockProjectsSignal().find(p => p.id === id) || null;
  },
  setProjects: vi.fn((projects: Project[]) => {
    mockProjectsSignal.set(projects);
  }),
  clear: vi.fn(),
};

const mockConnectionStore = {
  getConnection: vi.fn((id: string) => mockConnectionsMap.get(id)),
  setConnections: vi.fn(),
  clear: vi.fn(),
};

const mockLayoutService = {};
const mockUiStateService = {
  filterMode: vi.fn(() => 'all'),
};

describe('ProjectStateService - taskConnectionsMap', () => {
  let service: ProjectStateService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTasksMap.clear();
    mockConnectionsMap.clear();
    mockProjectsSignal.set([]);
    mockActiveProjectIdSignal.set(null);
    
    const injector = Injector.create({
      providers: [
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ConnectionStore, useValue: mockConnectionStore },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: UiStateService, useValue: mockUiStateService },
      ],
    });

    service = runInInjectionContext(injector, () => new ProjectStateService());
  });

  it('should return empty Map when no active project', () => {
    mockActiveProjectIdSignal.set(null);
    
    const result = service.taskConnectionsMap();
    
    expect(result.size).toBe(0);
  });

  it('should return empty TaskConnectionInfo for non-existent task', () => {
    const project = createProject({ id: 'proj-1', tasks: [], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const result = service.getTaskConnections('non-existent-id');
    
    expect(result).toEqual({ outgoing: [], incoming: [] });
  });

  it('should correctly compute outgoing connections', () => {
    const task1 = createTask({ id: 'task-1', title: 'Task 1' });
    const task2 = createTask({ id: 'task-2', title: 'Task 2' });
    const conn = createConnection('task-1', 'task-2', '依赖关系');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [task1, task2],
      connections: [conn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const result = service.getTaskConnections('task-1');
    
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0].targetId).toBe('task-2');
    expect(result.outgoing[0].targetTask?.title).toBe('Task 2');
    expect(result.outgoing[0].description).toBe('依赖关系');
    expect(result.incoming).toHaveLength(0);
  });

  it('should correctly compute incoming connections', () => {
    const task1 = createTask({ id: 'task-1', title: 'Task 1' });
    const task2 = createTask({ id: 'task-2', title: 'Task 2' });
    const conn = createConnection('task-1', 'task-2');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [task1, task2],
      connections: [conn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const result = service.getTaskConnections('task-2');
    
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].sourceId).toBe('task-1');
    expect(result.incoming[0].sourceTask?.title).toBe('Task 1');
    expect(result.outgoing).toHaveLength(0);
  });

  it('should filter out parent-child relationships from connections', () => {
    const parentTask = createTask({ id: 'parent', title: 'Parent' });
    const childTask = createTask({ id: 'child', title: 'Child', parentId: 'parent' });
    // 父子关系的连接应该被过滤
    const parentChildConn = createConnection('parent', 'child');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [parentTask, childTask],
      connections: [parentChildConn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const parentResult = service.getTaskConnections('parent');
    const childResult = service.getTaskConnections('child');
    
    // 父子连接应该被过滤掉
    expect(parentResult.outgoing).toHaveLength(0);
    expect(childResult.incoming).toHaveLength(0);
  });

  it('should include non-parent-child connections even between parent and child', () => {
    const parentTask = createTask({ id: 'parent', title: 'Parent' });
    const childTask = createTask({ id: 'child', title: 'Child', parentId: 'parent' });
    const siblingTask = createTask({ id: 'sibling', title: 'Sibling' });
    
    // 父子关系连接（应过滤）+ 跨树连接（应保留）
    const parentChildConn = createConnection('parent', 'child');
    const crossConn = createConnection('child', 'sibling', '跨树依赖');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [parentTask, childTask, siblingTask],
      connections: [parentChildConn, crossConn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const childResult = service.getTaskConnections('child');
    
    // 父子连接被过滤，跨树连接保留
    expect(childResult.incoming).toHaveLength(0);
    expect(childResult.outgoing).toHaveLength(1);
    expect(childResult.outgoing[0].targetId).toBe('sibling');
  });

  it('should handle multiple connections for same task', () => {
    const task1 = createTask({ id: 'task-1' });
    const task2 = createTask({ id: 'task-2' });
    const task3 = createTask({ id: 'task-3' });
    
    const conn1 = createConnection('task-1', 'task-2', '连接1');
    const conn2 = createConnection('task-1', 'task-3', '连接2');
    const conn3 = createConnection('task-2', 'task-1', '反向连接');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [task1, task2, task3],
      connections: [conn1, conn2, conn3],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const result = service.getTaskConnections('task-1');
    
    expect(result.outgoing).toHaveLength(2);
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].sourceId).toBe('task-2');
  });

  it('should return O(1) cached result on subsequent calls', () => {
    const task1 = createTask({ id: 'task-1' });
    const task2 = createTask({ id: 'task-2' });
    const conn = createConnection('task-1', 'task-2');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [task1, task2],
      connections: [conn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    // 多次调用应返回相同的缓存对象
    const result1 = service.getTaskConnections('task-1');
    const result2 = service.getTaskConnections('task-1');
    
    expect(result1).toBe(result2); // 同一个对象引用
  });

  it('should handle connections with missing target task gracefully', () => {
    const task1 = createTask({ id: 'task-1' });
    // task-2 不存在，但连接指向它
    const orphanConn = createConnection('task-1', 'task-2-missing');
    
    const project = createProject({
      id: 'proj-1',
      tasks: [task1],
      connections: [orphanConn],
    });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');
    
    const result = service.getTaskConnections('task-1');
    
    // 连接仍然应该被记录，但 targetTask 为 undefined
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0].targetId).toBe('task-2-missing');
    expect(result.outgoing[0].targetTask).toBeUndefined();
  });
});

// ========== rootTasks 测试 ==========

describe('ProjectStateService - rootTasks', () => {
  let service: ProjectStateService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTasksMap.clear();
    mockConnectionsMap.clear();
    mockProjectsSignal.set([]);
    mockActiveProjectIdSignal.set(null);

    const injector = Injector.create({
      providers: [
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ConnectionStore, useValue: mockConnectionStore },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: UiStateService, useValue: mockUiStateService },
      ],
    });

    service = runInInjectionContext(injector, () => new ProjectStateService());
  });

  it('should return empty array when no tasks', () => {
    const project = createProject({ id: 'proj-1', tasks: [], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    expect(service.rootTasks()).toEqual([]);
  });

  it('should include stage-1 task with direct unfinished item', () => {
    const task = createTask({ id: 't1', stage: 1, displayId: '1', content: '- [ ] 待办' });
    const project = createProject({ id: 'proj-1', tasks: [task], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    expect(service.rootTasks()).toContain(task);
  });

  it('should include stage-1 task whose descendant has unfinished item', () => {
    const root = createTask({ id: 'root', stage: 1, displayId: '1', content: '' });
    const child = createTask({ id: 'child', stage: 1, displayId: '1,a', content: '- [ ] 子任务待办' });
    const project = createProject({ id: 'proj-1', tasks: [root, child], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    expect(service.rootTasks()).toContain(root);
  });

  it('should exclude stage-1 task with no unfinished items anywhere in its subtree', () => {
    const taskDone = createTask({ id: 't1', stage: 1, displayId: '1', content: '- [x] 已完成' });
    const project = createProject({ id: 'proj-1', tasks: [taskDone], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    expect(service.rootTasks()).toEqual([]);
  });

  it('should not include deleted tasks', () => {
    const task = createTask({ id: 't1', stage: 1, displayId: '1', content: '- [ ] 待办', deletedAt: new Date().toISOString() });
    const project = createProject({ id: 'proj-1', tasks: [task], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    expect(service.rootTasks()).toEqual([]);
  });

  it('should handle deeply nested unfinished descendants', () => {
    const root = createTask({ id: 'r', stage: 1, displayId: '2', content: '' });
    const deep = createTask({ id: 'd', stage: 1, displayId: '2,b,c,d', content: '- [ ] 深层待办' });
    const unrelated = createTask({ id: 'u', stage: 1, displayId: '3', content: '' });
    const project = createProject({ id: 'proj-1', tasks: [root, deep, unrelated], connections: [] });
    mockProjectsSignal.set([project]);
    mockActiveProjectIdSignal.set('proj-1');

    const result = service.rootTasks();
    expect(result).toContain(root);
    expect(result).not.toContain(unrelated);
  });
});
