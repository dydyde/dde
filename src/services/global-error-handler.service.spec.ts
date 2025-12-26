/**
 * GlobalErrorHandler 单元测试
 * 
 * 测试覆盖：
 * - 错误分类规则 (classifyError)
 * - 不同级别错误的处理流程
 * - 错误去重机制
 * - 可恢复错误对话框
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { GlobalErrorHandler, ErrorSeverity } from './global-error-handler.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

describe('GlobalErrorHandler', () => {
  let service: GlobalErrorHandler;
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  let mockToast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  let mockRouter: { navigate: ReturnType<typeof vi.fn> };
  
  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    
    mockToast = {
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    };
    
    mockRouter = {
      navigate: vi.fn().mockResolvedValue(true),
    };
    
    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        { 
          provide: LoggerService, 
          useValue: { 
            category: vi.fn().mockReturnValue(mockLogger) 
          } 
        },
        { provide: ToastService, useValue: mockToast },
        { provide: Router, useValue: mockRouter },
      ],
    });
    
    service = TestBed.inject(GlobalErrorHandler);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  describe('错误分类', () => {
    it('NG0203 错误应分类为静默级', () => {
      const error = new Error('NG0203: inject() must be called from an injection context');
      
      service.handleError(error);
      
      // 静默级只记录 debug 日志，不显示 toast
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });
    
    it('图片加载错误应分类为静默级', () => {
      const error = new Error('Failed to load image: /assets/logo.png');
      
      service.handleError(error);
      
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });
    
    it('ResizeObserver 错误应分类为静默级', () => {
      const error = new Error('ResizeObserver loop completed with undelivered notifications');
      
      service.handleError(error);
      
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });
    
    it('网络错误应分类为提示级', () => {
      const error = new Error('Network error: Failed to fetch');
      
      service.handleError(error);
      
      // 提示级应显示 toast
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('保存失败应分类为提示级', () => {
      const error = new Error('Save failed: connection timeout');
      
      service.handleError(error);
      
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('UUID 格式错误应分类为提示级', () => {
      const error = new Error('invalid input syntax for type uuid: "not-a-uuid"');
      
      service.handleError(error);
      
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('Store 初始化失败应分类为致命级', () => {
      const error = new Error('Store initialization failed');
      
      service.handleError(error);
      
      // 致命级应导航到错误页面
      expect(mockRouter.navigate).toHaveBeenCalledWith(
        expect.arrayContaining(['/error']),
        expect.anything()
      );
    });
    
    it('内存溢出应分类为致命级', () => {
      const error = new Error('Out of memory');
      
      service.handleError(error);
      
      expect(mockRouter.navigate).toHaveBeenCalled();
    });
  });
  
  describe('手动指定错误级别', () => {
    it('forceSeverity 应覆盖自动分类', () => {
      // 网络错误通常是 NOTIFY 级别
      const error = new Error('Network error');
      
      // 但强制指定为 SILENT
      service.handleError(error, ErrorSeverity.SILENT);
      
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });
    
    it('reportError 应使用指定的错误级别', () => {
      const error = new Error('Custom error');
      
      service.reportError(error, ErrorSeverity.NOTIFY, '自定义错误消息');
      
      expect(mockToast.error).toHaveBeenCalled();
    });
  });
  
  describe('错误去重', () => {
    it('相同错误短时间内不应重复提示', () => {
      const error = new Error('Network timeout');
      
      // 第一次
      service.handleError(error);
      expect(mockToast.error).toHaveBeenCalledTimes(1);
      
      // 第二次（立即重复）
      service.handleError(error);
      expect(mockToast.error).toHaveBeenCalledTimes(1); // 不增加
    });
    
    it('不同错误应分别处理', () => {
      service.handleError(new Error('Network error 1'));
      service.handleError(new Error('Network error 2'));
      
      expect(mockToast.error).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('致命错误状态', () => {
    it('初始状态应为非致命', () => {
      expect(service.isFatalState).toBe(false);
    });
    
    it('致命错误后应进入致命状态', () => {
      const error = new Error('Store init failed');
      
      service.handleError(error);
      
      expect(service.isFatalState).toBe(true);
    });
    
    it('重置后应恢复为非致命状态', () => {
      const error = new Error('Store init failed');
      service.handleError(error);
      
      service.resetFatalState();
      
      expect(service.isFatalState).toBe(false);
    });
    
    it('致命状态下不应重复导航', () => {
      service.handleError(new Error('Store init failed'));
      service.handleError(new Error('Router init failed'));
      
      // 只导航一次
      expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('可恢复错误对话框', () => {
    it('showRecoveryDialog 应设置 recoverableError signal', async () => {
      const dialogPromise = service.showRecoveryDialog({
        title: '测试对话框',
        message: '这是测试消息',
        options: [
          { id: 'ok', label: '确定', style: 'primary' },
          { id: 'cancel', label: '取消', style: 'secondary' },
        ],
      });
      
      // signal 应该被设置
      const error = service.recoverableError();
      expect(error).not.toBeNull();
      expect(error?.title).toBe('测试对话框');
      expect(error?.options).toHaveLength(2);
      
      // 模拟用户选择
      error?.resolve('ok');
      
      // Promise 应该 resolve
      const result = await dialogPromise;
      expect(result).toBe('ok');
    });
    
    it('resolve 后应清除 recoverableError', async () => {
      const dialogPromise = service.showRecoveryDialog({
        title: '测试',
        message: '消息',
        options: [{ id: 'ok', label: '确定', style: 'primary' }],
      });
      
      service.recoverableError()?.resolve('ok');
      await dialogPromise;
      
      expect(service.recoverableError()).toBeNull();
    });
  });
  
  describe('错误消息提取', () => {
    it('Error 对象应提取 message', () => {
      const error = new Error('Test error message');
      
      service.handleError(error, ErrorSeverity.NOTIFY);
      
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('字符串应直接使用', () => {
      service.handleError('String error', ErrorSeverity.NOTIFY);
      
      expect(mockToast.error).toHaveBeenCalled();
    });
    
    it('对象应尝试提取 message 属性', () => {
      const error = { message: 'Object error', code: 500 };
      
      service.handleError(error, ErrorSeverity.NOTIFY);
      
      expect(mockToast.error).toHaveBeenCalled();
    });
  });
});
