/**
 * TaskStore/ProjectStore/ConnectionStore 测试
 * 
 * 测试 O(1) 查找、批量操作和状态管理
 */
import { TestBed } from '@angular/core/testing';
import { TaskStore, ProjectStore, ConnectionStore } from './stores';
import { Task, Project, Connection } from '../../../models';

describe('TaskStore', () => {
  let store: TaskStore;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TaskStore]
    });
    store = TestBed.inject(TaskStore);
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
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
  });
  
  describe('getTask - O(1) 查找', () => {
    it('应该返回存在的任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      expect(store.getTask('task-1')).toEqual(task);
    });
    
    it('应该对不存在的任务返回 undefined', () => {
      expect(store.getTask('non-existent')).toBeUndefined();
    });
  });
  
  describe('setTask', () => {
    it('应该添加新任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      expect(store.tasksMap().size).toBe(1);
      expect(store.tasks().length).toBe(1);
    });
    
    it('应该更新现有任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      const updatedTask = { ...task, title: 'Updated Title' };
      store.setTask(updatedTask, 'project-1');
      
      expect(store.getTask('task-1')?.title).toBe('Updated Title');
      expect(store.tasksMap().size).toBe(1);
    });
  });
  
  describe('setTasks - 批量设置', () => {
    it('应该批量设置任务', () => {
      const tasks = [
        createMockTask('task-1'),
        createMockTask('task-2'),
        createMockTask('task-3')
      ];
      
      store.setTasks(tasks, 'project-1');
      
      expect(store.tasksMap().size).toBe(3);
      expect(store.tasks().length).toBe(3);
    });
    
    it('应该替换项目的所有任务', () => {
      store.setTasks([createMockTask('old-1'), createMockTask('old-2')], 'project-1');
      store.setTasks([createMockTask('new-1')], 'project-1');
      
      expect(store.getTasksByProject('project-1').length).toBe(1);
      expect(store.getTasksByProject('project-1')[0].id).toBe('new-1');
    });
  });
  
  describe('removeTask', () => {
    it('应该删除任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      store.removeTask('task-1', 'project-1');
      
      expect(store.getTask('task-1')).toBeUndefined();
      expect(store.tasksMap().size).toBe(0);
    });
  });
  
  describe('getTasksByProject', () => {
    it('应该返回指定项目的所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-1');
      store.setTask(createMockTask('task-3'), 'project-2');
      
      expect(store.getTasksByProject('project-1').length).toBe(2);
      expect(store.getTasksByProject('project-2').length).toBe(1);
    });
    
    it('应该对不存在的项目返回空数组', () => {
      expect(store.getTasksByProject('non-existent')).toEqual([]);
    });
  });
  
  describe('clearProject', () => {
    it('应该清除指定项目的所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-2');
      
      store.clearProject('project-1');
      
      expect(store.getTasksByProject('project-1').length).toBe(0);
      expect(store.getTasksByProject('project-2').length).toBe(1);
    });
  });
  
  describe('clear', () => {
    it('应该清除所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-2');
      
      store.clear();
      
      expect(store.tasksMap().size).toBe(0);
      expect(store.tasks().length).toBe(0);
    });
  });
});

describe('ProjectStore', () => {
  let store: ProjectStore;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ProjectStore]
    });
    store = TestBed.inject(ProjectStore);
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockProject = (id: string): Project => ({
    id,
    name: `Project ${id}`,
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: []
  });
  
  describe('getProject - O(1) 查找', () => {
    it('应该返回存在的项目', () => {
      const project = createMockProject('project-1');
      store.setProject(project);
      
      expect(store.getProject('project-1')).toEqual(project);
    });
    
    it('应该对不存在的项目返回 undefined', () => {
      expect(store.getProject('non-existent')).toBeUndefined();
    });
  });
  
  describe('activeProject', () => {
    it('应该返回当前活动项目', () => {
      const project = createMockProject('project-1');
      store.setProject(project);
      store.activeProjectId.set('project-1');
      
      expect(store.activeProject()?.id).toBe('project-1');
    });
    
    it('应该在没有活动项目时返回 null', () => {
      expect(store.activeProject()).toBeNull();
    });
  });
  
  describe('setProjects - 批量设置', () => {
    it('应该批量设置项目', () => {
      const projects = [
        createMockProject('project-1'),
        createMockProject('project-2')
      ];
      
      store.setProjects(projects);
      
      expect(store.projectsMap().size).toBe(2);
      expect(store.projects().length).toBe(2);
    });
  });
  
  describe('removeProject', () => {
    it('应该删除项目', () => {
      store.setProject(createMockProject('project-1'));
      store.removeProject('project-1');
      
      expect(store.getProject('project-1')).toBeUndefined();
    });
    
    it('应该清除活动项目 ID（如果删除的是活动项目）', () => {
      store.setProject(createMockProject('project-1'));
      store.activeProjectId.set('project-1');
      store.removeProject('project-1');
      
      expect(store.activeProjectId()).toBeNull();
    });
  });
});

describe('ConnectionStore', () => {
  let store: ConnectionStore;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ConnectionStore]
    });
    store = TestBed.inject(ConnectionStore);
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockConnection = (id: string): Connection => ({
    id,
    source: 'task-1',
    target: 'task-2'
  });
  
  describe('getConnection - O(1) 查找', () => {
    it('应该返回存在的连接', () => {
      const connection = createMockConnection('conn-1');
      store.setConnection(connection, 'project-1');
      
      expect(store.getConnection('conn-1')).toEqual(connection);
    });
    
    it('应该对不存在的连接返回 undefined', () => {
      expect(store.getConnection('non-existent')).toBeUndefined();
    });
  });
  
  describe('setConnections - 批量设置', () => {
    it('应该批量设置连接', () => {
      const connections = [
        createMockConnection('conn-1'),
        createMockConnection('conn-2')
      ];
      
      store.setConnections(connections, 'project-1');
      
      expect(store.connectionsMap().size).toBe(2);
      expect(store.connections().length).toBe(2);
    });
  });
  
  describe('getConnectionsByProject', () => {
    it('应该返回指定项目的所有连接', () => {
      store.setConnection(createMockConnection('conn-1'), 'project-1');
      store.setConnection(createMockConnection('conn-2'), 'project-2');
      
      expect(store.getConnectionsByProject('project-1').length).toBe(1);
      expect(store.getConnectionsByProject('project-2').length).toBe(1);
    });
  });
});
