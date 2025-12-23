/**
 * Supabase 错误处理工具
 * 
 * 统一处理 Supabase 错误，提供友好的错误消息和错误分类
 */

/**
 * 增强的错误类型
 */
export interface EnhancedError extends Error {
  code?: string | number;
  details?: string;
  hint?: string;
  isRetryable: boolean;
  errorType: string;
}

/**
 * 可重试的错误类型
 */
const RETRYABLE_ERROR_TYPES = new Set([
  'NetworkTimeoutError',
  'ServiceUnavailableError',
  'GatewayError',
  'RequestTimeoutError',
  'TimeoutError',
  'NetworkError',
  'OfflineError',
]);

/**
 * 将 Supabase 错误对象转换为标准 Error 实例
 * 
 * Supabase 返回的错误是普通对象 {code, details, hint, message}，需要转换才能被 Sentry 正确捕获
 * 此函数会识别常见的网络错误（504, 503, 502等）并提供更友好的错误消息
 * 
 * **错误识别优先级**:
 * 1. 优先通过 HTTP 状态码（code/status）判断错误类型
 * 2. 如果没有状态码，尝试从 message 内容识别
 * 3. 最后使用默认的 SupabaseError 类型
 * 
 * @param error - Supabase 错误对象或标准 Error
 * @returns 增强的 Error 实例，包含 isRetryable 和 errorType 属性
 */
export function supabaseErrorToError(error: any): EnhancedError {
  if (error instanceof Error) {
    const enhanced = error as EnhancedError;
    const lowerMsg = enhanced.message.toLowerCase();
    
    // 识别 Error 实例中的网络错误模式
    if (lowerMsg.includes('failed to fetch')) {
      enhanced.errorType = 'NetworkError';
      enhanced.isRetryable = true;
    } else if (lowerMsg.includes('network error') || lowerMsg.includes('networkerror')) {
      enhanced.errorType = 'NetworkError';
      enhanced.isRetryable = true;
    } else if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
      enhanced.errorType = 'TimeoutError';
      enhanced.isRetryable = true;
    } else if (lowerMsg.includes('offline') || lowerMsg.includes('no connection')) {
      enhanced.errorType = 'OfflineError';
      enhanced.isRetryable = true;
    } else {
      // 如果没有识别出具体类型，使用 name 属性
      if (!enhanced.isRetryable) {
        enhanced.isRetryable = RETRYABLE_ERROR_TYPES.has(enhanced.name);
      }
      if (!enhanced.errorType) {
        enhanced.errorType = enhanced.name;
      }
    }
    
    return enhanced;
  }
  
  // 识别网络相关错误
  const code = error?.code || error?.status;
  let message = error?.message;
  let errorType = 'SupabaseError';
  
  // HTTP 状态码判断（优先级最高，因为最可靠）
  if (code === 504 || code === '504') {
    message = '服务器响应超时 (504 Gateway Timeout)';
    errorType = 'NetworkTimeoutError';
  } else if (code === 503 || code === '503') {
    message = '服务暂时不可用 (503 Service Unavailable)';
    errorType = 'ServiceUnavailableError';
  } else if (code === 502 || code === '502') {
    message = '网关错误 (502 Bad Gateway)';
    errorType = 'GatewayError';
  } else if (code === 408 || code === '408') {
    message = '请求超时 (408 Request Timeout)';
    errorType = 'RequestTimeoutError';
  } else if (code === 429 || code === '429') {
    message = '请求过于频繁 (429 Too Many Requests)';
    errorType = 'RateLimitError';
  } else if (code === 401 || code === '401') {
    message = '未授权或登录已过期 (401 Unauthorized)';
    errorType = 'AuthError';
  } else if (code === 403 || code === '403') {
    message = '权限不足 (403 Forbidden)';
    errorType = 'PermissionError';
  } else if (message && typeof message === 'string') {
    // 如果没有状态码，尝试从消息中识别错误类型
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
      errorType = 'TimeoutError';
    } else if (lowerMsg.includes('network') || lowerMsg.includes('fetch')) {
      errorType = 'NetworkError';
    } else if (lowerMsg.includes('offline') || lowerMsg.includes('no connection')) {
      errorType = 'OfflineError';
    } else if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many requests')) {
      errorType = 'RateLimitError';
    } else if (lowerMsg.includes('jwt') || lowerMsg.includes('session') || lowerMsg.includes('expired')) {
      errorType = 'AuthError';
    }
  }
  
  // 如果 message 仍然为空，使用默认消息
  if (!message) {
    message = 'Unknown Supabase error';
  }
  
  const err = new Error(message) as EnhancedError;
  err.name = errorType;
  
  // 保留原始错误信息
  err.code = code;
  err.details = error?.details;
  err.hint = error?.hint;
  err.isRetryable = RETRYABLE_ERROR_TYPES.has(errorType);
  err.errorType = errorType;
  
  return err;
}

/**
 * 判断错误是否可重试
 * 
 * @param error - 错误对象
 * @returns 是否可重试
 */
export function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  const enhanced = supabaseErrorToError(error);
  return enhanced.isRetryable;
}

/**
 * 获取用户友好的错误消息
 * 
 * @param error - 错误对象
 * @returns 用户友好的错误消息
 */
export function getFriendlyErrorMessage(error: any): string {
  const enhanced = supabaseErrorToError(error);
  
  // 对于可重试的错误，提供简洁的提示
  if (enhanced.isRetryable) {
    switch (enhanced.errorType) {
      case 'NetworkTimeoutError':
      case 'RequestTimeoutError':
      case 'TimeoutError':
        return '网络响应超时，已加入重试队列';
      case 'ServiceUnavailableError':
        return '服务暂时不可用，已加入重试队列';
      case 'GatewayError':
        return '网关错误，已加入重试队列';
      case 'NetworkError':
        return '网络连接失败，数据将自动重试同步';
      case 'OfflineError':
        return '当前离线，数据将在恢复连接后同步';
      default:
        return '操作失败，已加入重试队列';
    }
  }
  
  // 对于不可重试的错误，返回详细消息
  return enhanced.message;
}
