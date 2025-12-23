/**
 * Supabase 错误处理工具测试
 */
import { describe, it, expect } from 'vitest';
import { 
  supabaseErrorToError, 
  isRetryableError, 
  getFriendlyErrorMessage 
} from './supabase-error';

describe('supabase-error', () => {
  describe('supabaseErrorToError', () => {
    it('应该识别 504 Gateway Timeout 错误', () => {
      const error = { code: 504, message: 'Gateway timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkTimeoutError');
      expect(result.message).toContain('504 Gateway Timeout');
      expect(result.isRetryable).toBe(true);
      expect(result.errorType).toBe('NetworkTimeoutError');
    });
    
    it('应该识别 503 Service Unavailable 错误', () => {
      const error = { code: 503, message: 'Service unavailable' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('ServiceUnavailableError');
      expect(result.message).toContain('503 Service Unavailable');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 502 Bad Gateway 错误', () => {
      const error = { code: 502, message: 'Bad gateway' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('GatewayError');
      expect(result.message).toContain('502 Bad Gateway');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 408 Request Timeout 错误', () => {
      const error = { code: 408, message: 'Request timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('RequestTimeoutError');
      expect(result.message).toContain('408 Request Timeout');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该识别 429 Rate Limit 错误', () => {
      const error = { code: 429, message: 'Too many requests' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('RateLimitError');
      expect(result.message).toContain('429 Too Many Requests');
      expect(result.isRetryable).toBe(false);
    });
    
    it('应该识别 401 Unauthorized 错误', () => {
      const error = { code: 401, message: 'Unauthorized' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('AuthError');
      expect(result.message).toContain('401 Unauthorized');
      expect(result.isRetryable).toBe(false);
    });
    
    it('应该从消息内容识别 timeout 关键词', () => {
      const error = { message: 'Connection timed out' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('TimeoutError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该从消息内容识别 network 关键词', () => {
      const error = { message: 'Network request failed' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该从消息内容识别 offline 关键词', () => {
      const error = { message: 'You are offline' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('OfflineError');
      expect(result.isRetryable).toBe(true);
    });
    
    it('应该处理已经是 Error 实例的情况', () => {
      const error = new Error('Test error');
      const result = supabaseErrorToError(error);
      
      expect(result).toBe(error);
      expect(result.isRetryable).toBeDefined();
      expect(result.errorType).toBeDefined();
    });
    
    it('应该处理 Unknown Supabase error', () => {
      const error = {};
      const result = supabaseErrorToError(error);
      
      expect(result.message).toBe('Unknown Supabase error');
      expect(result.name).toBe('SupabaseError');
      expect(result.isRetryable).toBe(false);
    });
    
    it('应该保留原始错误的 code, details, hint', () => {
      const error = {
        code: '42P01',
        message: 'Table not found',
        details: 'relation "tasks" does not exist',
        hint: 'Run migrations'
      };
      const result = supabaseErrorToError(error);
      
      expect(result.code).toBe('42P01');
      expect(result.details).toBe('relation "tasks" does not exist');
      expect(result.hint).toBe('Run migrations');
    });
    
    it('应该支持字符串形式的状态码', () => {
      const error = { code: '504', message: 'Gateway timeout' };
      const result = supabaseErrorToError(error);
      
      expect(result.name).toBe('NetworkTimeoutError');
      expect(result.isRetryable).toBe(true);
    });
  });
  
  describe('isRetryableError', () => {
    it('应该正确判断可重试错误', () => {
      expect(isRetryableError({ code: 504 })).toBe(true);
      expect(isRetryableError({ code: 503 })).toBe(true);
      expect(isRetryableError({ code: 502 })).toBe(true);
      expect(isRetryableError({ message: 'timeout' })).toBe(true);
      expect(isRetryableError({ message: 'network error' })).toBe(true);
    });
    
    it('应该正确判断不可重试错误', () => {
      expect(isRetryableError({ code: 401 })).toBe(false);
      expect(isRetryableError({ code: 403 })).toBe(false);
      expect(isRetryableError({ code: 429 })).toBe(false);
      expect(isRetryableError({ message: 'Invalid input' })).toBe(false);
    });
    
    it('应该处理 null 和 undefined', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });
  
  describe('getFriendlyErrorMessage', () => {
    it('应该为可重试错误提供友好提示', () => {
      expect(getFriendlyErrorMessage({ code: 504 })).toContain('网络响应超时');
      expect(getFriendlyErrorMessage({ code: 503 })).toContain('服务暂时不可用');
      expect(getFriendlyErrorMessage({ code: 502 })).toContain('网关错误');
      expect(getFriendlyErrorMessage({ message: 'timeout' })).toContain('网络响应超时');
      expect(getFriendlyErrorMessage({ message: 'offline' })).toContain('离线');
    });
    
    it('应该为不可重试错误返回详细消息', () => {
      const error = { code: 401, message: 'Unauthorized access' };
      const result = getFriendlyErrorMessage(error);
      
      // 应该返回错误的实际消息
      expect(result).toBeTruthy();
    });
  });
});
