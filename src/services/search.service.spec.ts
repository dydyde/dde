/**
 * SearchService 单元测试
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SearchService } from './search.service';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';
import { Task, Project } from '../models';

describe('SearchService', () => {
  let service: SearchService;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SearchService,
        { 
          provide: ProjectStateService, 
          useValue: { 
            tasks: vi.fn().mockReturnValue([]),
            projects: vi.fn().mockReturnValue([]),
          } 
        },
        { 
          provide: UiStateService, 
          useValue: { 
            searchQuery: vi.fn().mockReturnValue(''),
            projectSearchQuery: vi.fn().mockReturnValue(''),
          } 
        },
      ],
    });
    
    service = TestBed.inject(SearchService);
  });
  
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
  
  function createProject(overrides: Partial<Project> = {}): Project {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: 'Test Project',
      description: '',
      createdDate: now,
      updatedAt: now,
      tasks: [],
      connections: [],
      ...overrides,
    };
  }
  
  describe('searchTasks', () => {
    it('空查询应返回空数组', () => {
      const tasks = [createTask({ title: 'Task 1' })];
      const results = service.searchTasks('', tasks);
      expect(results).toHaveLength(0);
    });
    
    it('应按标题搜索', () => {
      const tasks = [
        createTask({ title: '完成报告' }),
        createTask({ title: '开会讨论' }),
        createTask({ title: '报告评审' }),
      ];
      const results = service.searchTasks('报告', tasks);
      expect(results).toHaveLength(2);
    });
    
    it('应按内容搜索', () => {
      const tasks = [
        createTask({ title: 'Task 1', content: '这是关于 Angular 的任务' }),
        createTask({ title: 'Task 2', content: '这是关于 React 的任务' }),
      ];
      const results = service.searchTasks('Angular', tasks);
      expect(results).toHaveLength(1);
    });
    
    it('搜索应忽略大小写', () => {
      const tasks = [
        createTask({ title: 'Angular Task' }),
        createTask({ title: 'React Task' }),
      ];
      const results = service.searchTasks('angular', tasks);
      expect(results).toHaveLength(1);
    });
    
    it('应排除已删除的任务', () => {
      const tasks = [
        createTask({ title: '活跃任务', deletedAt: null }),
        createTask({ title: '已删除任务', deletedAt: new Date().toISOString() }),
      ];
      const results = service.searchTasks('任务', tasks);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('活跃任务');
    });
  });
  
  describe('searchProjects', () => {
    it('空查询应返回所有项目', () => {
      const projects = [
        createProject({ name: 'Project 1' }),
        createProject({ name: 'Project 2' }),
      ];
      const results = service.searchProjects('', projects);
      expect(results).toHaveLength(2);
    });
    
    it('应按名称搜索', () => {
      const projects = [
        createProject({ name: 'NanoFlow' }),
        createProject({ name: 'DataSync' }),
      ];
      const results = service.searchProjects('Nano', projects);
      expect(results).toHaveLength(1);
    });
    
    it('应按描述搜索', () => {
      const projects = [
        createProject({ name: 'Project 1', description: '任务追踪系统' }),
        createProject({ name: 'Project 2', description: '电商平台' }),
      ];
      const results = service.searchProjects('任务', projects);
      expect(results).toHaveLength(1);
    });
  });
  
  describe('highlightMatch', () => {
    it('应高亮匹配的文本', () => {
      const text = '这是一个 Angular 项目';
      const query = 'Angular';
      const result = service.highlightMatch(text, query);
      expect(result).toContain('<mark class="search-highlight">');
    });
    
    it('空查询应返回原文本', () => {
      const text = '原始文本';
      const result = service.highlightMatch(text, '');
      expect(result).toBe(text);
    });
  });
});
