/**
 * AttachmentExportService 单元测试
 * 
 * 覆盖场景：
 * - 附件收集和去重
 * - 下载处理（超时、重试、错误处理）
 * - ZIP 打包
 * - 进度追踪
 * - 大小限制
 * 
 * 性能优化：
 * - 使用 fake timers 避免重试延迟等待（RETRY_DELAY = 1000ms）
 * - 测试执行时间从 9s+ 降至 <1s
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  AttachmentExportService, 
  ATTACHMENT_EXPORT_CONFIG,
  AttachmentManifest 
} from './attachment-export.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Project, Task, Attachment } from '../models';

describe('AttachmentExportService', () => {
  let service: AttachmentExportService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  
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
    // 启用 fake timers 避免重试延迟等待
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    TestBed.configureTestingModule({
      providers: [
        AttachmentExportService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
      ],
    });
    
    service = TestBed.inject(AttachmentExportService);
    
    // Mock fetch
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  
  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });
  
  // ==================== 辅助函数 ====================
  
  /**
   * 执行异步操作并自动快进所有定时器
   * 用于避免等待真实的重试延迟（1s, 2s, 3s...）
   */
  async function runWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
    // 循环快进直到 Promise 完成
    const result = await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(100);
      return promise;
    }, { timeout: 5000 });
    return result;
  }
  
  function createProject(options: {
    id?: string;
    tasks?: Partial<Task>[];
  } = {}): Project {
    const tasks: Task[] = (options.tasks || []).map((t, i) => ({
      id: t.id || `task-${i}`,
      title: t.title || `任务 ${i}`,
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active' as const,
      x: 0,
      y: 0,
      displayId: `${i}`,
      createdDate: new Date().toISOString(),
      attachments: t.attachments,
      deletedAt: t.deletedAt,
    }));
    
    return {
      id: options.id || 'proj-1',
      name: '测试项目',
      description: '',
      createdDate: new Date().toISOString(),
      tasks,
      connections: [],
    };
  }
  
  function createAttachment(overrides?: Partial<Attachment>): Attachment {
    return {
      id: overrides?.id || `att-${Math.random().toString(36).slice(2)}`,
      type: overrides?.type || 'file',
      name: overrides?.name || 'test-file.pdf',
      size: overrides?.size || 1024,
      mimeType: overrides?.mimeType || 'application/pdf',
      url: overrides?.url || 'https://example.com/file.pdf',
      createdAt: new Date().toISOString(),
    };
  }
  
  function mockSuccessfulFetch(data?: Blob) {
    const blob = data || new Blob(['test content'], { type: 'text/plain' });
    fetchSpy.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    } as Response);
  }
  
  function mockFailedFetch(status = 404) {
    fetchSpy.mockResolvedValue({
      ok: false,
      status,
    } as Response);
  }
  
  // ==================== 配置测试 ====================
  
  describe('配置', () => {
    it('应有合理的批次大小', () => {
      expect(ATTACHMENT_EXPORT_CONFIG.BATCH_SIZE).toBe(5);
    });
    
    it('应有合理的单文件大小限制', () => {
      expect(ATTACHMENT_EXPORT_CONFIG.MAX_SINGLE_FILE_SIZE).toBe(100 * 1024 * 1024);
    });
    
    it('应有合理的总大小限制', () => {
      expect(ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE).toBe(500 * 1024 * 1024);
    });
    
    it('应有合理的重试次数', () => {
      expect(ATTACHMENT_EXPORT_CONFIG.RETRY_COUNT).toBe(3);
    });
  });
  
  // ==================== 附件收集测试 ====================
  
  describe('附件收集', () => {
    it('应收集项目中的所有附件', async () => {
      const att1 = createAttachment({ id: 'att-1', name: 'file1.pdf' });
      const att2 = createAttachment({ id: 'att-2', name: 'file2.jpg' });
      
      const project = createProject({
        tasks: [
          { attachments: [att1] },
          { attachments: [att2] },
        ],
      });
      
      mockSuccessfulFetch();
      
      const result = await service.exportAttachments([project]);
      
      expect(result.success).toBe(true);
      expect(result.manifest?.totalAttachments).toBe(2);
    });
    
    it('应对同一附件去重', async () => {
      const sharedAtt = createAttachment({ id: 'shared-att' });
      
      const project = createProject({
        tasks: [
          { id: 'task-1', attachments: [sharedAtt] },
          { id: 'task-2', attachments: [sharedAtt] },
        ],
      });
      
      mockSuccessfulFetch();
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest?.totalAttachments).toBe(1);
      // 验证 taskIds 包含两个任务
      const att = result.manifest?.attachments[0];
      expect(att?.taskIds).toContain('task-1');
      expect(att?.taskIds).toContain('task-2');
    });
    
    it('应跳过已删除任务的附件', async () => {
      const att = createAttachment();
      
      const project = createProject({
        tasks: [
          { attachments: [att], deletedAt: new Date().toISOString() },
        ],
      });
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest?.totalAttachments).toBe(0);
    });
    
    it('无附件时应正常完成', async () => {
      const project = createProject({ tasks: [{ title: '无附件任务' }] });
      
      const result = await service.exportAttachments([project]);
      
      expect(result.success).toBe(true);
      expect(result.manifest?.totalAttachments).toBe(0);
    });
  });
  
  // ==================== 下载测试 ====================
  
  describe('下载处理', () => {
    it('应成功下载附件', async () => {
      const att = createAttachment({ url: 'https://example.com/file.pdf' });
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockSuccessfulFetch(new Blob(['pdf content'], { type: 'application/pdf' }));
      
      const result = await service.exportAttachments([project]);
      
      expect(result.success).toBe(true);
      expect(result.manifest?.successCount).toBe(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/file.pdf',
        expect.any(Object)
      );
    });
    
    it('应处理下载失败', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockFailedFetch(404);
      
      // 使用 Promise + runAllTimersAsync 模式避免等待真实重试延迟
      const resultPromise = service.exportAttachments([project]);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      
      expect(result.success).toBe(true); // 部分失败不影响整体
      expect(result.manifest?.failedCount).toBe(1);
    });
    
    it('应跳过没有 URL 的附件', async () => {
      // 创建附件时手动设置 url 为 undefined
      const att: Attachment = {
        id: 'no-url-att',
        type: 'file',
        name: 'no-url.pdf',
        size: 1024,
        mimeType: 'application/pdf',
        url: '', // 空 URL
        createdAt: new Date().toISOString(),
      };
      
      const project = createProject({ 
        tasks: [{ 
          attachments: [att] 
        }] 
      });
      
      // 不需要 mock fetch，因为没有 URL 就不会调用 fetch
      
      const result = await service.exportAttachments([project]);
      
      // 没有 URL 的附件状态应该是 skipped 或 failed
      expect(result.manifest?.attachments[0].downloadStatus).toMatch(/skipped|failed/);
      expect(result.manifest?.attachments[0].failureReason).toContain('URL');
    });
    
    it('应跳过过大的文件', async () => {
      const att = createAttachment({ 
        size: ATTACHMENT_EXPORT_CONFIG.MAX_SINGLE_FILE_SIZE + 1 
      });
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest?.attachments[0].downloadStatus).toBe('skipped');
      expect(result.manifest?.attachments[0].failureReason).toContain('过大');
    });
    
    it('下载失败时应重试', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      // 前两次失败，第三次成功
      fetchSpy
        .mockRejectedValueOnce(new Error('网络错误'))
        .mockRejectedValueOnce(new Error('网络错误'))
        .mockResolvedValueOnce({
          ok: true,
          blob: () => Promise.resolve(new Blob(['content'])),
        } as Response);
      
      // 使用 Promise + runAllTimersAsync 模式避免等待真实延迟
      const resultPromise = service.exportAttachments([project]);
      
      // 快进所有定时器（包括重试延迟：1s + 2s = 3s）
      await vi.runAllTimersAsync();
      
      const result = await resultPromise;
      
      expect(result.success).toBe(true);
      expect(result.manifest?.successCount).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });
  
  // ==================== 大小限制测试 ====================
  
  describe('大小限制', () => {
    it('应拒绝超过总大小限制的导出', async () => {
      // 创建一个超大附件
      const att = createAttachment({ 
        size: ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE + 1 
      });
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      const result = await service.exportAttachments([project]);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('超出限制');
    });
  });
  
  // ==================== ZIP 打包测试 ====================
  
  describe('ZIP 打包', () => {
    it('应生成有效的 ZIP 文件', async () => {
      const att = createAttachment({ name: 'test.txt' });
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockSuccessfulFetch(new Blob(['hello world'], { type: 'text/plain' }));
      
      const result = await service.exportAttachments([project]);
      
      expect(result.blob).toBeDefined();
      expect(result.blob?.type).toBe('application/zip');
      expect(result.filename).toMatch(/^nanoflow-attachments-.*\.zip$/);
    });
    
    it('ZIP 应包含 manifest.json', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockSuccessfulFetch();
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.version).toBe('1.0');
      expect(result.manifest?.exportedAt).toBeDefined();
    });
  });
  
  // ==================== 进度追踪测试 ====================
  
  describe('进度追踪', () => {
    it('导出时 isExporting 应为 true', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      let capturedIsExporting = false;
      
      mockSuccessfulFetch();
      
      // 使用延迟的 fetch 来捕获状态
      fetchSpy.mockImplementation(() => {
        capturedIsExporting = service.isExporting();
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(['content'])),
        } as Response);
      });
      
      await service.exportAttachments([project]);
      
      expect(capturedIsExporting).toBe(true);
      expect(service.isExporting()).toBe(false);
    });
    
    it('完成时进度应为 100%', async () => {
      const project = createProject({ tasks: [] });
      
      await service.exportAttachments([project]);
      
      expect(service.progress().stage).toBe('complete');
      expect(service.progress().percentage).toBe(100);
    });
    
    it('失败时应记录错误', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      fetchSpy.mockRejectedValue(new Error('网络错误'));
      
      // 使用 Promise + runAllTimersAsync 模式避免等待真实重试延迟
      const resultPromise = service.exportAttachments([project]);
      await vi.runAllTimersAsync();
      await resultPromise;
      
      expect(service.progress().errors.length).toBeGreaterThan(0);
    });
  });
  
  // ==================== 并发控制测试 ====================
  
  describe('并发控制', () => {
    it('应拒绝并发导出', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      // 模拟慢速下载（使用 fake timers 时无需真实等待）
      fetchSpy.mockImplementation(() => 
        new Promise(resolve => 
          setTimeout(() => resolve({
            ok: true,
            blob: () => Promise.resolve(new Blob(['content'])),
          } as Response), 100)
        )
      );
      
      // 启动第一个导出（不 await，让它处于进行中状态）
      const promise1 = service.exportAttachments([project]);
      
      // 等待一个微任务周期确保第一个导出开始
      await Promise.resolve();
      
      // 尝试启动第二个导出（应该立即被拒绝）
      const result2 = await service.exportAttachments([project]);
      
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('正在进行中');
      
      // 快进定时器让第一个导出完成
      await vi.runAllTimersAsync();
      await promise1;
    });
  });
  
  // ==================== exportAndDownload 测试 ====================
  
  describe('exportAndDownload', () => {
    it('应导出并触发下载', async () => {
      const att = createAttachment();
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockSuccessfulFetch();
      
      // Mock DOM API
      const mockClick = vi.fn();
      const mockAppendChild = vi.spyOn(document.body, 'appendChild').mockImplementation(() => null as unknown as Node);
      const mockRemoveChild = vi.spyOn(document.body, 'removeChild').mockImplementation(() => null as unknown as Node);
      const mockCreateElement = vi.spyOn(document, 'createElement').mockReturnValue({
        click: mockClick,
        href: '',
        download: '',
      } as unknown as HTMLAnchorElement);
      const mockCreateObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
      const mockRevokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      
      const result = await service.exportAndDownload([project]);
      
      expect(result.success).toBe(true);
      expect(mockClick).toHaveBeenCalled();
      
      // 清理
      mockAppendChild.mockRestore();
      mockRemoveChild.mockRestore();
      mockCreateElement.mockRestore();
      mockCreateObjectURL.mockRestore();
      mockRevokeObjectURL.mockRestore();
    });
  });
  
  // ==================== Manifest 测试 ====================
  
  describe('Manifest', () => {
    it('应包含正确的统计信息', async () => {
      const att1 = createAttachment({ id: 'att-1', size: 1000 });
      // 创建没有 URL 的附件
      const att2: Attachment = {
        id: 'att-2',
        type: 'file',
        name: 'no-url.pdf',
        size: 2000,
        mimeType: 'application/pdf',
        url: '', // 空 URL
        createdAt: new Date().toISOString(),
      };
      const project = createProject({
        tasks: [
          { attachments: [att1] },
          { attachments: [att2] },
        ],
      });
      
      mockSuccessfulFetch();
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest?.totalAttachments).toBe(2);
      // att1 成功，att2 失败（没有URL）
      expect(result.manifest?.successCount).toBe(1);
      expect(result.manifest?.failedCount).toBe(1);
    });
    
    it('应包含 bundlePath', async () => {
      const att = createAttachment({ id: 'test-att', name: 'document.pdf' });
      const project = createProject({ tasks: [{ attachments: [att] }] });
      
      mockSuccessfulFetch();
      
      const result = await service.exportAttachments([project]);
      
      expect(result.manifest?.attachments[0].bundlePath).toMatch(/^attachments\//);
      expect(result.manifest?.attachments[0].bundlePath).toContain('test-att');
    });
  });
});
