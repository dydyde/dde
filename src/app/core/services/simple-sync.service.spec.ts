/**
 * SimpleSyncService 单元测试
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SimpleSyncService } from './simple-sync.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { Task, Project, Connection } from '../../../models';

describe('SimpleSyncService', () => {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockLogger: any;
  let mockToast: any;
  
  beforeEach(() => {
    mockSupabase = {
      isConfigured: vi.fn().mockReturnValue(false),
      client: vi.fn().mockReturnValue(null) // 离线模式
    };
    
    mockLogger = {
      category: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      })
    };
    
    mockToast = {
      error: vi.fn(),
      success: vi.fn()
    };
    
    TestBed.configureTestingModule({
      providers: [
        SimpleSyncService,
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast }
      ]
    });
    
    service = TestBed.inject(SimpleSyncService);
  });
  
  describe('初始化', () => {
    it('应该正确初始化状态', () => {
      expect(service.state().isSyncing).toBe(false);
      expect(service.state().pendingCount).toBe(0);
      expect(service.state().lastSyncTime).toBeNull();
    });
  });
  
  describe('离线模式', () => {
    it('pushTask 应该添加到重试队列（离线时）', async () => {
      const task: Task = {
        id: 'task-1',
        title: 'Test Task',
        content: '',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 0,
        status: 'active',
        x: 0,
        y: 0,
        createdDate: new Date().toISOString(),
        displayId: '1'
      };
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('pullTasks 应该返回空数组（离线时）', async () => {
      const tasks = await service.pullTasks('project-1');
      expect(tasks).toEqual([]);
    });
    
    it('pushProject 应该添加到重试队列（离线时）', async () => {
      const project: Project = {
        id: 'project-1',
        name: 'Test Project',
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [],
        connections: []
      };
      
      const result = await service.pushProject(project);
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
    
    it('pushConnection 应该添加到重试队列（离线时）', async () => {
      const connection: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2'
      };
      
      const result = await service.pushConnection(connection, 'project-1');
      
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);
    });
  });
  
  describe('在线模式', () => {
    beforeEach(() => {
      // 模拟在线状态
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null })
          })
        })
      });
    });
    
    it('pushTask 应该成功推送', async () => {
      const task: Task = {
        id: 'task-1',
        title: 'Test Task',
        content: '',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 0,
        status: 'active',
        x: 0,
        y: 0,
        createdDate: new Date().toISOString(),
        displayId: '1'
      };
      
      const result = await service.pushTask(task, 'project-1');
      
      expect(result).toBe(true);
      expect(service.state().lastSyncTime).not.toBeNull();
    });
    
    it('pullTasks 应该返回任务列表', async () => {
      const tasks = await service.pullTasks('project-1', '2025-01-01');
      expect(tasks).toEqual([]);
    });
  });
});
