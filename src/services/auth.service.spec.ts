/**
 * AuthService 认证服务测试
 * 
 * 覆盖场景：
 * - onAuthStateChange 监听
 * - Token 刷新成功/失败处理
 * - 会话过期检测
 * - 手动登出 vs Token 过期区分
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

describe('AuthService', () => {
  let service: AuthService;
  let mockToastService: { show: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> };
  let mockSupabaseClient: {
    isConfigured: boolean;
    client: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  let authStateCallback: ((event: string, session: unknown) => void) | null = null;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  
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
    authStateCallback = null;
    mockUnsubscribe = vi.fn();
    
    mockToastService = {
      show: vi.fn(),
      warning: vi.fn(),
    };
    
    mockSupabaseClient = {
      isConfigured: true,
      client: vi.fn().mockReturnValue({
        auth: {
          onAuthStateChange: vi.fn((callback: (event: string, session: unknown) => void) => {
            authStateCallback = callback;
            return {
              data: {
                subscription: { unsubscribe: mockUnsubscribe }
              }
            };
          }),
          getSession: vi.fn().mockResolvedValue({
            data: { session: null },
            error: null
          }),
        }
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
    };
    
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    service = TestBed.inject(AuthService);
  });
  
  afterEach(() => {
    service.reset();
  });
  
  describe('onAuthStateChange 监听', () => {
    it('应该注册认证状态变更监听器', () => {
      expect(mockSupabaseClient.client).toHaveBeenCalled();
      expect(authStateCallback).toBeDefined();
    });
    
    it('TOKEN_REFRESHED 事件应该清除过期标记', () => {
      // 先设置过期状态
      (service as unknown as { sessionExpired: { set: (v: boolean) => void } }).sessionExpired.set(true);
      expect(service.sessionExpired()).toBe(true);
      
      // 触发 TOKEN_REFRESHED 事件
      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      // 过期标记应该被清除
      expect(service.sessionExpired()).toBe(false);
    });
    
    it('SIGNED_IN 事件应该更新用户信息', () => {
      expect(service.currentUserId()).toBeNull();
      
      // 触发 SIGNED_IN 事件
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      expect(service.currentUserId()).toBe('user-1');
      expect(service.sessionEmail()).toBe('test@example.com');
    });
  });
  
  describe('会话过期检测', () => {
    it('非主动登出时应该触发会话过期处理', () => {
      // 触发 SIGNED_OUT 事件（非主动登出）
      authStateCallback!('SIGNED_OUT', null);
      
      // 应该设置过期标记
      expect(service.sessionExpired()).toBe(true);
      
      // 应该显示 Toast 提示
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '登录已过期',
        '请重新登录以继续同步数据',
        { duration: 0 }
      );
    });
    
    it('主动登出时不应该触发会话过期提示', async () => {
      // 先登录
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      // 主动登出
      await service.signOut();
      
      // 模拟 SIGNED_OUT 事件
      authStateCallback!('SIGNED_OUT', null);
      
      // 不应该设置过期标记
      expect(service.sessionExpired()).toBe(false);
    });
  });
  
  describe('reset', () => {
    it('应该重置所有状态', () => {
      // 设置一些状态
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      expect(service.currentUserId()).toBe('user-1');
      
      // 重置
      service.reset();
      
      // 所有状态应该被清空
      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(service.sessionExpired()).toBe(false);
    });
  });
});
