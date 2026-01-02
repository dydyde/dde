/**
 * AttachmentImportService 单元测试
 * 
 * 覆盖场景：
 * - 配额检查
 * - 批量导入
 * - 并发控制
 * - 错误处理
 * - 取消操作
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  AttachmentImportService, 
  AttachmentImportItem,
  ATTACHMENT_IMPORT_CONFIG 
} from './attachment-import.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

describe('AttachmentImportService', () => {
  let service: AttachmentImportService;
  let mockAttachmentService: {
    uploadFile: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
  };
  let mockToastService: {
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockAttachmentService = {
      uploadFile: vi.fn().mockResolvedValue({
        success: true,
        attachment: {
          id: 'att-1',
          name: 'test.png',
          type: 'image',
          url: 'https://example.com/test.png',
          mimeType: 'image/png',
          size: 1024,
          createdAt: new Date().toISOString(),
        },
      }),
    };
    
    mockAuthService = {
      currentUserId: vi.fn().mockReturnValue('user-1'),
    };
    
    mockToastService = {
      error: vi.fn(),
      warning: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        AttachmentImportService,
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    service = TestBed.inject(AttachmentImportService);
  });
  
  afterEach(() => {
    service.resetProgress();
  });
  
  describe('importAttachments', () => {
    it('未登录时应返回失败', async () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      
      const result = await service.importAttachments('project-1', []);
      
      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain('未登录');
    });
    
    it('空列表应返回成功', async () => {
      const result = await service.importAttachments('project-1', []);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
    });
    
    it('无有效数据的项应被跳过', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          // 没有 data
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);
    });
    
    it('有效项应该被上传', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(mockAttachmentService.uploadFile).toHaveBeenCalledWith(
        'user-1',
        'project-1',
        'task-1',
        expect.any(File)
      );
    });
    
    it('上传失败应记录错误', async () => {
      mockAttachmentService.uploadFile.mockResolvedValue({
        success: false,
        error: '上传失败',
      });
      
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('上传失败');
    });
    
    it('多个项应该分批处理', async () => {
      const items: AttachmentImportItem[] = Array.from({ length: 15 }, (_, i) => ({
        taskId: `task-${i}`,
        metadata: { id: `att-${i}`, name: `test-${i}.png`, size: 1024, mimeType: 'image/png' },
        data: new Blob(['test data'], { type: 'image/png' }),
      }));
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(15);
      expect(mockAttachmentService.uploadFile).toHaveBeenCalledTimes(15);
    });
  });
  
  describe('checkQuota', () => {
    it('小文件应该通过配额检查', async () => {
      const result = await service.checkQuota(1024);
      
      expect(result.hasQuota).toBe(true);
    });
    
    it('超大文件应该失败', async () => {
      // 请求 200MB（超过 100MB 默认限制）
      const result = await service.checkQuota(200 * 1024 * 1024);
      
      expect(result.hasQuota).toBe(false);
      expect(result.message).toContain('存储空间不足');
    });
  });
  
  describe('cancelImport', () => {
    it('取消应该中止正在进行的导入', async () => {
      vi.useFakeTimers();
      try {
        const items: AttachmentImportItem[] = Array.from({ length: 50 }, (_, i) => ({
          taskId: `task-${i}`,
          metadata: { id: `att-${i}`, name: `test-${i}.png`, size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        }));
        
        // 延迟上传以便有时间取消
        mockAttachmentService.uploadFile.mockImplementation(() => 
          new Promise(resolve => setTimeout(() => resolve({
            success: true,
            attachment: { id: 'att', name: 'test.png', type: 'image', url: '', mimeType: '', size: 0, createdAt: '' },
          }), 50))
        );
        
        // 开始导入
        const importPromise = service.importAttachments('project-1', items);
        
        // 快进一点时间然后取消
        await vi.advanceTimersByTimeAsync(100);
        service.cancelImport();
        
        // 完成所有剩余定时器
        await vi.runAllTimersAsync();
        const result = await importPromise;
        
        // 应该有一些项被处理，但不是全部
        expect(result.imported).toBeLessThan(50);
      } finally {
        vi.useRealTimers();
      }
    });
  });
  
  describe('progress', () => {
    it('初始状态应为 idle', () => {
      expect(service.progress().stage).toBe('idle');
      expect(service.progress().percentage).toBe(0);
    });
    
    it('导入过程中应更新进度', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      await service.importAttachments('project-1', items);
      
      // 完成后应该是 completed
      expect(service.progress().stage).toBe('completed');
      expect(service.progress().percentage).toBe(100);
    });
    
    it('resetProgress 应重置状态', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      await service.importAttachments('project-1', items);
      expect(service.progress().stage).toBe('completed');
      
      service.resetProgress();
      
      expect(service.progress().stage).toBe('idle');
      expect(service.progress().percentage).toBe(0);
    });
  });
});
