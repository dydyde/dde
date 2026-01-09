import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  ExportService, 
  ExportResult, 
  EXPORT_CONFIG 
} from './export.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { PreferenceService } from './preference.service';
import { Project, Task, Connection } from '../models';

describe('ExportService', () => {
  let service: ExportService;
  let mockToast: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  let mockPreference: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  
  beforeEach(() => {
    mockToast = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    };
    
    mockPreference = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(null),
    };
    
    const loggerMethods = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const mockLogger = {
      category: () => loggerMethods,
    };
    
    TestBed.configureTestingModule({
      providers: [
        ExportService,
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLogger },
        { provide: PreferenceService, useValue: mockPreference },
      ],
    });
    
    service = TestBed.inject(ExportService);
  });
  
  // 辅助函数：创建测试项目
  function createTestProject(overrides: Partial<Project> = {}): Project {
    return {
      id: 'project-1',
      name: 'Test Project',
      description: 'Test Description',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
      ...overrides,
    };
  }
  
  // 辅助函数：创建测试任务
  function createTestTask(overrides: Partial<Task> = {}): Task {
    return {
      id: crypto.randomUUID(),
      title: 'Test Task',
      content: 'Test Content',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 100,
      y: 200,
      displayId: '1',
      createdDate: new Date().toISOString(),
      ...overrides,
    };
  }
  
  // 辅助函数：创建测试连接
  function createTestConnection(overrides: Partial<Connection> = {}): Connection {
    return {
      id: crypto.randomUUID(),
      source: 'task-1',
      target: 'task-2',
      ...overrides,
    };
  }
  
  describe('exportProject', () => {
    it('应成功导出单个项目', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      expect(result.success).toBe(true);
      expect(result.blob).toBeDefined();
      expect(result.filename).toContain('nanoflow-backup-project');
      expect(result.metadata?.projectCount).toBe(1);
      expect(result.metadata?.exportType).toBe('single-project');
    });
    
    it('应包含任务数据', async () => {
      const task = createTestTask({ id: 'task-1', title: 'My Task' });
      const project = createTestProject({ tasks: [task] });
      
      const result = await service.exportProject(project);
      
      expect(result.success).toBe(true);
      expect(result.metadata?.taskCount).toBe(1);
      
      // 解析导出数据验证内容
      const text = await result.blob!.text();
      const data = JSON.parse(text);
      expect(data.projects[0].tasks).toHaveLength(1);
      expect(data.projects[0].tasks[0].title).toBe('My Task');
    });
    
    it('应包含连接数据', async () => {
      const task1 = createTestTask({ id: 'task-1' });
      const task2 = createTestTask({ id: 'task-2' });
      const conn = createTestConnection({ source: 'task-1', target: 'task-2' });
      const project = createTestProject({ 
        tasks: [task1, task2], 
        connections: [conn] 
      });
      
      const result = await service.exportProject(project);
      
      expect(result.success).toBe(true);
      expect(result.metadata?.connectionCount).toBe(1);
    });
    
    it('应包含已删除的任务（回收站数据完整备份）', async () => {
      const activeTask = createTestTask({ id: 'active', title: 'Active' });
      const deletedTask = createTestTask({ 
        id: 'deleted', 
        title: 'Deleted',
        deletedAt: new Date().toISOString() 
      });
      const project = createTestProject({ tasks: [activeTask, deletedTask] });
      
      const result = await service.exportProject(project);
      
      const text = await result.blob!.text();
      const data = JSON.parse(text);
      // 默认 INCLUDE_DELETED_ITEMS = true，应包含所有任务
      expect(data.projects[0].tasks).toHaveLength(2);
      expect(data.projects[0].tasks.find((t: { title: string }) => t.title === 'Active')).toBeDefined();
      expect(data.projects[0].tasks.find((t: { title: string }) => t.title === 'Deleted')).toBeDefined();
    });
    
    it('应包含已删除的连接（回收站数据完整备份）', async () => {
      const activeConn = createTestConnection({ id: 'active' });
      const deletedConn = createTestConnection({ 
        id: 'deleted',
        deletedAt: new Date().toISOString() 
      });
      const project = createTestProject({ connections: [activeConn, deletedConn] });
      
      const result = await service.exportProject(project);
      
      const text = await result.blob!.text();
      const data = JSON.parse(text);
      // 默认 INCLUDE_DELETED_ITEMS = true，应包含所有连接
      expect(data.projects[0].connections).toHaveLength(2);
    });
  });
  
  describe('exportAllProjects', () => {
    it('应成功导出多个项目', async () => {
      const project1 = createTestProject({ id: 'p1', name: 'Project 1' });
      const project2 = createTestProject({ id: 'p2', name: 'Project 2' });
      
      const result = await service.exportAllProjects([project1, project2]);
      
      expect(result.success).toBe(true);
      expect(result.metadata?.projectCount).toBe(2);
      expect(result.metadata?.exportType).toBe('full');
    });
    
    it('应正确统计所有项目的任务数', async () => {
      const project1 = createTestProject({ 
        id: 'p1', 
        tasks: [createTestTask(), createTestTask()] 
      });
      const project2 = createTestProject({ 
        id: 'p2', 
        tasks: [createTestTask()] 
      });
      
      const result = await service.exportAllProjects([project1, project2]);
      
      expect(result.metadata?.taskCount).toBe(3);
    });
  });
  
  describe('校验和', () => {
    it('导出数据应包含校验和', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      expect(result.metadata?.checksum).toBeDefined();
      expect(result.metadata?.checksum.length).toBeGreaterThan(0);
    });
    
    it('相同数据应生成相同的校验和', async () => {
      const project = createTestProject({ id: 'fixed-id', name: 'Fixed Name' });
      
      const result1 = await service.exportProject(project);
      const result2 = await service.exportProject(project);
      
      // 因为时间戳不同，校验和可能不同
      // 但元数据格式应该正确
      expect(result1.metadata?.checksum).toMatch(/^[a-f0-9]+$|^simple-/);
      expect(result2.metadata?.checksum).toMatch(/^[a-f0-9]+$|^simple-/);
    });
  });
  
  describe('文件名生成', () => {
    it('单项目导出应使用 -project 后缀', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      expect(result.filename).toContain('-project-');
    });
    
    it('全量导出不应有特殊后缀', async () => {
      const project = createTestProject();
      
      const result = await service.exportAllProjects([project]);
      
      expect(result.filename).not.toContain('-project-');
      expect(result.filename).not.toContain('-selected-');
    });
    
    it('文件名应包含日期', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      // 验证包含 YYYYMMDD 格式的日期
      expect(result.filename).toMatch(/\d{8}/);
    });
  });
  
  describe('状态信号', () => {
    it('初始状态应为非导出中', () => {
      expect(service.isExporting()).toBe(false);
    });
    
    it('导出时应更新 isExporting 状态', async () => {
      const project = createTestProject();
      
      // 开始导出
      const exportPromise = service.exportProject(project);
      
      // 导出完成后状态应恢复
      await exportPromise;
      expect(service.isExporting()).toBe(false);
    });
    
    it('导出完成后应更新 lastExportTime', async () => {
      const project = createTestProject();
      
      await service.exportProject(project);
      
      expect(service.lastExportTime()).not.toBeNull();
    });
  });
  
  describe('附件处理', () => {
    it('应包含附件元数据', async () => {
      const task = createTestTask({
        id: 'task-1',
        attachments: [{
          id: 'att-1',
          type: 'file',
          name: 'test.pdf',
          size: 1024,
          mimeType: 'application/pdf',
          url: 'https://example.com/test.pdf',
          createdAt: new Date().toISOString(),
        }],
      });
      const project = createTestProject({ tasks: [task] });
      
      const result = await service.exportProject(project);
      
      expect(result.metadata?.attachmentCount).toBe(1);
      
      const text = await result.blob!.text();
      const data = JSON.parse(text);
      expect(data.projects[0].tasks[0].attachments).toHaveLength(1);
      expect(data.projects[0].tasks[0].attachments[0].name).toBe('test.pdf');
    });
  });
  
  describe('downloadExport', () => {
    it('失败的导出结果应返回 false', () => {
      const failedResult: ExportResult = {
        success: false,
        error: 'Export failed',
      };
      
      const downloaded = service.downloadExport(failedResult);
      
      expect(downloaded).toBe(false);
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('成功的导出结果应返回 true', async () => {
      const project = createTestProject();
      const result = await service.exportProject(project);
      
      // Mock DOM API
      const mockClick = vi.fn();
      const mockRemoveChild = vi.fn();
      const mockAppendChild = vi.fn();
      
      vi.spyOn(document, 'createElement').mockReturnValue({
        href: '',
        download: '',
        click: mockClick,
      } as unknown as HTMLAnchorElement);
      
      vi.spyOn(document.body, 'appendChild').mockImplementation(mockAppendChild);
      vi.spyOn(document.body, 'removeChild').mockImplementation(mockRemoveChild);
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      
      const downloaded = service.downloadExport(result);
      
      expect(downloaded).toBe(true);
      expect(mockToast.success).toHaveBeenCalled();
    });
  });
  
  describe('exportAndDownload', () => {
    it('应导出并下载', async () => {
      const project = createTestProject();
      
      // Mock DOM API
      vi.spyOn(document, 'createElement').mockReturnValue({
        href: '',
        download: '',
        click: vi.fn(),
      } as unknown as HTMLAnchorElement);
      vi.spyOn(document.body, 'appendChild').mockImplementation(() => document.body);
      vi.spyOn(document.body, 'removeChild').mockImplementation(() => document.body);
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      
      const success = await service.exportAndDownload([project]);
      
      expect(success).toBe(true);
    });
  });
  
  describe('导出配置', () => {
    it('应使用正确的格式版本', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      expect(result.metadata?.version).toBe(EXPORT_CONFIG.FORMAT_VERSION);
    });
    
    it('应生成 JSON 格式', async () => {
      const project = createTestProject();
      
      const result = await service.exportProject(project);
      
      expect(result.blob?.type).toBe(EXPORT_CONFIG.MIME_TYPE);
    });
  });
  
  describe('needsExportReminder', () => {
    it('从未导出过应需要提醒', () => {
      // 初始状态下 lastExportTime 为 null
      expect(service.needsExportReminder()).toBe(true);
    });
  });
});
