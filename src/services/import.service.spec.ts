/**
 * ImportService 单元测试
 * 
 * 覆盖场景：
 * - 文件验证（大小、类型、结构、版本）
 * - 校验和验证
 * - 导入预览生成
 * - 冲突检测
 * - 各种导入策略（skip/overwrite/merge/rename）
 * - 数据转换
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  ImportService, 
  IMPORT_CONFIG,
  ImportOptions,
  FileValidationResult 
} from './import.service';
import { ExportData, EXPORT_CONFIG } from './export.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Project, Task, Connection } from '../models';

describe('ImportService', () => {
  let service: ImportService;
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  const mockToast = {
    show: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    TestBed.configureTestingModule({
      providers: [
        ImportService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
      ],
    });
    
    service = TestBed.inject(ImportService);
  });
  
  // ==================== 辅助函数 ====================
  
  function createValidExportData(overrides?: Partial<ExportData>): ExportData {
    return {
      metadata: {
        exportedAt: new Date().toISOString(),
        version: '2.0',
        appVersion: '1.0.0',
        projectCount: 1,
        taskCount: 2,
        connectionCount: 1,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [
        {
          id: 'proj-1',
          name: '测试项目',
          description: '描述',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              id: 'task-1',
              title: '任务1',
              content: '',
              stage: 0,
              parentId: null,
              order: 0,
              rank: 10000,
              status: 'active',
              x: 100,
              y: 100,
              displayId: '1',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'task-2',
              title: '任务2',
              content: '',
              stage: 0,
              parentId: 'task-1',
              order: 0,
              rank: 10000,
              status: 'active',
              x: 200,
              y: 200,
              displayId: '1,a',
              createdAt: new Date().toISOString(),
            },
          ],
          connections: [
            {
              id: 'conn-1',
              source: 'task-1',
              target: 'task-2',
            },
          ],
        },
      ],
      ...overrides,
    };
  }
  
  function createFile(content: string, name = 'backup.json', type = 'application/json'): File {
    return new File([content], name, { type });
  }
  
  function createExistingProject(): Project {
    return {
      id: 'proj-1',
      name: '现有项目',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [
        {
          id: 'existing-task',
          title: '现有任务',
          content: '',
          stage: 0,
          parentId: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '1',
          createdDate: new Date().toISOString(),
        } as Task,
      ],
      connections: [],
    };
  }
  
  // ==================== 文件验证测试 ====================
  
  describe('validateFile', () => {
    it('应验证有效的 JSON 文件', async () => {
      const data = createValidExportData();
      const file = createFile(JSON.stringify(data));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
    });
    
    it('应拒绝过大的文件', async () => {
      // 创建一个模拟的大文件
      const largeContent = 'x'.repeat(IMPORT_CONFIG.MAX_FILE_SIZE + 1);
      const file = createFile(largeContent);
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('文件过大');
    });
    
    it('应拒绝无效的 JSON', async () => {
      const file = createFile('{ invalid json }');
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON 解析失败');
    });
    
    it('应拒绝缺少 metadata 的数据', async () => {
      const file = createFile(JSON.stringify({ projects: [] }));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('缺少元数据');
    });
    
    it('应拒绝缺少 projects 的数据', async () => {
      const file = createFile(JSON.stringify({ metadata: { version: '2.0' } }));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('缺少项目数据');
    });
    
    it('应拒绝版本过低的数据', async () => {
      const data = createValidExportData();
      data.metadata.version = '0.5';
      const file = createFile(JSON.stringify(data));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('版本过低');
    });
    
    it('应拒绝版本过高的数据', async () => {
      const data = createValidExportData();
      data.metadata.version = '99.0';
      const file = createFile(JSON.stringify(data));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('版本过高');
    });
    
    it('应接受 .json 扩展名的无类型文件', async () => {
      const data = createValidExportData();
      const file = createFile(JSON.stringify(data), 'backup.json', '');
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(true);
    });
    
    it('应拒绝项目缺少 id 的数据', async () => {
      const data = {
        metadata: { version: '2.0' },
        projects: [{ name: '无ID项目' }],
      };
      const file = createFile(JSON.stringify(data));
      
      const result = await service.validateFile(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('项目缺少必需字段');
    });
  });
  
  // ==================== 预览生成测试 ====================
  
  describe('generatePreview', () => {
    it('应生成正确的项目预览', async () => {
      const data = createValidExportData();
      
      const preview = await service.generatePreview(data, []);
      
      expect(preview.canImport).toBe(true);
      expect(preview.projects).toHaveLength(1);
      expect(preview.projects[0].name).toBe('测试项目');
      expect(preview.projects[0].taskCount).toBe(2);
      expect(preview.projects[0].connectionCount).toBe(1);
    });
    
    it('应检测 ID 冲突', async () => {
      const data = createValidExportData();
      const existingProject = createExistingProject();
      
      const preview = await service.generatePreview(data, [existingProject]);
      
      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0].type).toBe('id');
      expect(preview.conflicts[0].projectId).toBe('proj-1');
    });
    
    it('应检测名称冲突', async () => {
      const data = createValidExportData();
      const existingProject: Project = {
        id: 'different-id',
        name: '测试项目', // 同名
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [],
        connections: [],
      };
      
      const preview = await service.generatePreview(data, [existingProject]);
      
      const nameConflicts = preview.conflicts.filter(c => c.type === 'name');
      expect(nameConflicts).toHaveLength(1);
    });
    
    it('应显示校验和不匹配警告', async () => {
      const data = createValidExportData();
      data.metadata.checksum = 'invalid-checksum';
      
      const preview = await service.generatePreview(data, []);
      
      expect(preview.warnings.some(w => w.includes('校验和'))).toBe(true);
    });
    
    it('应显示附件 URL 过期警告', async () => {
      const data = createValidExportData();
      data.projects[0].tasks[0].attachments = [
        {
          id: 'att-1',
          name: 'file.pdf',
          size: 1000,
          mimeType: 'application/pdf',
          url: 'https://example.com/file.pdf',
          createdAt: new Date().toISOString(),
        },
      ];
      
      const preview = await service.generatePreview(data, []);
      
      expect(preview.warnings.some(w => w.includes('附件'))).toBe(true);
    });
    
    it('无冲突时 hasConflict 应为 false', async () => {
      const data = createValidExportData();
      
      const preview = await service.generatePreview(data, []);
      
      expect(preview.projects[0].hasConflict).toBe(false);
    });
  });
  
  // ==================== 导入执行测试 ====================
  
  describe('executeImport', () => {
    const defaultOptions: ImportOptions = {
      conflictStrategy: 'skip',
    };
    
    it('应成功导入无冲突的项目', async () => {
      const data = createValidExportData();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      const result = await service.executeImport(
        data,
        [],
        defaultOptions,
        onProjectImported
      );
      
      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(onProjectImported).toHaveBeenCalledTimes(1);
    });
    
    it('使用 skip 策略时应跳过已存在的项目', async () => {
      const data = createValidExportData();
      const existingProject = createExistingProject();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      const result = await service.executeImport(
        data,
        [existingProject],
        { conflictStrategy: 'skip' },
        onProjectImported
      );
      
      expect(result.skippedCount).toBe(1);
      expect(result.importedCount).toBe(0);
      expect(onProjectImported).not.toHaveBeenCalled();
    });
    
    it('使用 overwrite 策略时应覆盖已存在的项目', async () => {
      const data = createValidExportData();
      const existingProject = createExistingProject();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      const result = await service.executeImport(
        data,
        [existingProject],
        { conflictStrategy: 'overwrite' },
        onProjectImported
      );
      
      expect(result.importedCount).toBe(1);
      expect(result.details[0].action).toBe('overwritten');
      expect(onProjectImported).toHaveBeenCalledTimes(1);
    });
    
    it('使用 merge 策略时应合并任务', async () => {
      const data = createValidExportData();
      const existingProject = createExistingProject();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      const result = await service.executeImport(
        data,
        [existingProject],
        { conflictStrategy: 'merge' },
        onProjectImported
      );
      
      expect(result.importedCount).toBe(1);
      expect(result.details[0].action).toBe('merged');
      expect(onProjectImported).toHaveBeenCalledTimes(1);
      
      // 验证合并后的项目包含新任务
      const mergedProject = onProjectImported.mock.calls[0][0] as Project;
      expect(mergedProject.tasks.length).toBeGreaterThan(existingProject.tasks.length);
    });
    
    it('使用 rename 策略时应创建新项目', async () => {
      const data = createValidExportData();
      const existingProject = createExistingProject();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      const result = await service.executeImport(
        data,
        [existingProject],
        { conflictStrategy: 'rename' },
        onProjectImported
      );
      
      expect(result.importedCount).toBe(1);
      expect(result.details[0].action).toBe('imported');
      
      // 验证新项目有不同的 ID
      const importedProject = onProjectImported.mock.calls[0][0] as Project;
      expect(importedProject.id).not.toBe(existingProject.id);
      expect(importedProject.name).toContain('(导入)');
    });
    
    it('generateNewIds 选项应生成全新的 ID', async () => {
      const data = createValidExportData();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      await service.executeImport(
        data,
        [],
        { conflictStrategy: 'skip', generateNewIds: true },
        onProjectImported
      );
      
      const importedProject = onProjectImported.mock.calls[0][0] as Project;
      expect(importedProject.id).not.toBe('proj-1');
      expect(importedProject.tasks[0].id).not.toBe('task-1');
    });
    
    it('应正确更新父子关系的 ID', async () => {
      const data = createValidExportData();
      const onProjectImported = vi.fn().mockResolvedValue(undefined);
      
      await service.executeImport(
        data,
        [],
        { conflictStrategy: 'skip', generateNewIds: true },
        onProjectImported
      );
      
      const importedProject = onProjectImported.mock.calls[0][0] as Project;
      const task1 = importedProject.tasks.find(t => t.title === '任务1');
      const task2 = importedProject.tasks.find(t => t.title === '任务2');
      
      expect(task2?.parentId).toBe(task1?.id);
    });
    
    it('应拒绝并发导入', async () => {
      // 使用 fake timers 避免等待真实 100ms
      vi.useFakeTimers();
      
      const data = createValidExportData();
      const slowCallback = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 100))
      );
      
      // 启动第一个导入（不 await，让它处于进行中状态）
      const promise1 = service.executeImport(data, [], defaultOptions, slowCallback);
      
      // 等待一个微任务周期确保第一个导入开始
      await Promise.resolve();
      
      // 尝试启动第二个导入（应该立即被拒绝）
      const result2 = await service.executeImport(data, [], defaultOptions, slowCallback);
      
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('正在进行中');
      
      // 快进定时器让第一个导入完成
      await vi.runAllTimersAsync();
      await promise1;
      
      vi.useRealTimers();
    });
    
    it('导入失败时应记录错误', async () => {
      const data = createValidExportData();
      const failingCallback = vi.fn().mockRejectedValue(new Error('保存失败'));
      
      const result = await service.executeImport(
        data,
        [],
        defaultOptions,
        failingCallback
      );
      
      expect(result.failedCount).toBe(1);
      expect(result.details[0].action).toBe('failed');
      expect(result.details[0].error).toContain('保存失败');
    });
  });
  
  // ==================== 状态信号测试 ====================
  
  describe('状态信号', () => {
    it('导入时 isImporting 应为 true', async () => {
      const data = createValidExportData();
      let capturedIsImporting = false;
      
      const slowCallback = vi.fn().mockImplementation(async () => {
        capturedIsImporting = service.isImporting();
      });
      
      await service.executeImport(data, [], { conflictStrategy: 'skip' }, slowCallback);
      
      expect(capturedIsImporting).toBe(true);
      expect(service.isImporting()).toBe(false);
    });
    
    it('应正确报告进度', async () => {
      const data = createValidExportData();
      const progressValues: number[] = [];
      
      const callback = vi.fn().mockImplementation(async () => {
        progressValues.push(service.progress().percentage);
      });
      
      await service.executeImport(data, [], { conflictStrategy: 'skip' }, callback);
      
      expect(service.progress().stage).toBe('complete');
      expect(service.progress().percentage).toBe(100);
    });
  });
  
  // ==================== 配置测试 ====================
  
  describe('配置', () => {
    it('应有合理的最大文件大小', () => {
      expect(IMPORT_CONFIG.MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    });
    
    it('应支持 JSON 和纯文本类型', () => {
      expect(IMPORT_CONFIG.ALLOWED_MIME_TYPES).toContain('application/json');
      expect(IMPORT_CONFIG.ALLOWED_MIME_TYPES).toContain('text/plain');
    });
    
    it('默认冲突策略应为 skip', () => {
      expect(IMPORT_CONFIG.DEFAULT_CONFLICT_STRATEGY).toBe('skip');
    });
    
    it('版本范围应与导出配置兼容', () => {
      const currentVersion = parseFloat(EXPORT_CONFIG.FORMAT_VERSION);
      const maxSupported = parseFloat(IMPORT_CONFIG.MAX_SUPPORTED_VERSION);
      
      expect(currentVersion).toBeLessThanOrEqual(maxSupported);
    });
  });
});
