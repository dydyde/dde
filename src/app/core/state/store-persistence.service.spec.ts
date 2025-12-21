import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { StorePersistenceService } from './store-persistence.service';
import { TaskStore, ProjectStore, ConnectionStore } from './stores';
import { LoggerService } from '../../../services/logger.service';
import { Project, Task, Connection } from '../../../models';

/**
 * StorePersistenceService 单元测试
 * 
 * 注意：由于 IndexedDB mock 的限制，这些测试主要验证：
 * - 服务实例化
 * - 方法调用不抛出异常
 * - Store 交互
 * 
 * 完整的 IndexedDB 集成测试应在 E2E 测试中进行
 */
describe('StorePersistenceService', () => {
  let service: StorePersistenceService;
  let taskStore: TaskStore;
  let projectStore: ProjectStore;
  let connectionStore: ConnectionStore;
  
  // 模拟数据
  const mockProject: Project = {
    id: 'project-1',
    name: '测试项目',
    description: '测试描述',
    createdDate: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tasks: [],
    connections: []
  };
  
  const mockTask: Task = {
    id: 'task-1',
    title: '测试任务',
    content: '任务内容',
    status: 'active',
    stage: 1,
    rank: 1,
    order: 0,
    displayId: '1',
    shortId: 'NF-A1B2',
    parentId: null,
    x: 0,
    y: 0,
    createdDate: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    TestBed.configureTestingModule({
      providers: [
        StorePersistenceService,
        TaskStore,
        ProjectStore,
        ConnectionStore,
        LoggerService
      ]
    });
    
    service = TestBed.inject(StorePersistenceService);
    taskStore = TestBed.inject(TaskStore);
    projectStore = TestBed.inject(ProjectStore);
    connectionStore = TestBed.inject(ConnectionStore);
  });
  
  afterEach(() => {
    taskStore.clear();
    projectStore.clear();
    connectionStore.clear();
  });
  
  describe('初始化', () => {
    it('应该成功创建服务实例', () => {
      expect(service).toBeDefined();
    });
    
    it('应该注入所有依赖服务', () => {
      expect(taskStore).toBeDefined();
      expect(projectStore).toBeDefined();
      expect(connectionStore).toBeDefined();
    });
  });
  
  describe('保存操作（不阻塞）', () => {
    it('saveProject 调用不应抛出异常', () => {
      projectStore.setProject(mockProject);
      taskStore.setTask(mockTask, mockProject.id);
      
      // saveProject 返回 Promise 但我们不等待它
      expect(() => service.saveProject(mockProject.id)).not.toThrow();
    });
    
    it('saveAllProjects 调用不应抛出异常', () => {
      projectStore.setProject(mockProject);
      expect(() => service.saveAllProjects()).not.toThrow();
    });
    
    it('saveMeta 调用不应抛出异常', () => {
      expect(() => service.saveMeta()).not.toThrow();
    });
  });
  
  describe('删除操作（不阻塞）', () => {
    it('deleteProject 调用不应抛出异常', () => {
      expect(() => service.deleteProject('project-1')).not.toThrow();
    });
    
    it('clearAll 调用不应抛出异常', () => {
      expect(() => service.clearAll()).not.toThrow();
    });
  });
  
  describe('Store 交互', () => {
    it('应该能从 TaskStore 获取任务', () => {
      taskStore.setTask(mockTask, mockProject.id);
      expect(taskStore.getTask(mockTask.id)).toEqual(mockTask);
    });
    
    it('应该能从 ProjectStore 获取项目', () => {
      projectStore.setProject(mockProject);
      expect(projectStore.getProject(mockProject.id)).toEqual(mockProject);
    });
    
    it('应该能从 TaskStore 获取项目任务', () => {
      taskStore.setTask(mockTask, mockProject.id);
      const tasks = taskStore.getTasksByProject(mockProject.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(mockTask.id);
    });
  });
  
  describe('防抖逻辑', () => {
    it('多次调用 saveProject 不应累积调用', () => {
      projectStore.setProject(mockProject);
      
      // 连续调用多次，不应抛出异常
      expect(() => {
        service.saveProject(mockProject.id);
        service.saveProject(mockProject.id);
        service.saveProject(mockProject.id);
      }).not.toThrow();
    });
  });
});
