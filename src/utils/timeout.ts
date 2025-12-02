import { TIMEOUT_CONFIG, RETRY_POLICY, TimeoutLevel } from '../config/constants';

/**
 * 请求超时和重试工具函数
 * 提供分级超时策略和自动重试机制
 */

/**
 * 超时选项
 */
export interface TimeoutOptions {
  /** 超时时间（毫秒），或使用预定义级别 */
  timeout?: number | TimeoutLevel;
  /** 超时时的错误消息 */
  timeoutMessage?: string;
  /** AbortController 信号（用于外部取消） */
  signal?: AbortSignal;
}

/**
 * 重试选项
 */
export interface RetryOptions extends TimeoutOptions {
  /** 是否启用重试（默认 true） */
  enableRetry?: boolean;
  /** 最大重试次数（默认使用 RETRY_POLICY.MAX_RETRIES） */
  maxRetries?: number;
  /** 自定义重试条件 */
  shouldRetry?: (error: any) => boolean;
  /** 重试时的回调 */
  onRetry?: (attempt: number, error: any) => void;
}

/**
 * 获取超时时间
 */
function getTimeoutMs(timeout?: number | TimeoutLevel): number {
  if (typeof timeout === 'number') return timeout;
  if (typeof timeout === 'string') return TIMEOUT_CONFIG[timeout];
  return TIMEOUT_CONFIG.STANDARD;
}

/**
 * 检查错误是否可重试
 */
function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  const message = String(error.message ?? error).toLowerCase();
  
  // 检查错误消息模式
  for (const pattern of RETRY_POLICY.RETRYABLE_ERROR_PATTERNS) {
    if (message.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  
  // 检查 HTTP 状态码
  const status = error.status ?? error.statusCode;
  if (typeof status === 'number') {
    return (RETRY_POLICY.RETRYABLE_STATUS_CODES as readonly number[]).includes(status);
  }
  
  // AbortError（超时）可重试
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  
  return false;
}

/**
 * 计算重试延迟（指数退避）
 */
function calculateRetryDelay(attempt: number): number {
  const delay = RETRY_POLICY.INITIAL_DELAY * Math.pow(RETRY_POLICY.BACKOFF_FACTOR, attempt);
  return Math.min(delay, RETRY_POLICY.MAX_DELAY);
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的 Promise 包装
 * @param promise 要包装的 Promise
 * @param options 超时选项
 * @returns 带超时保护的 Promise
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  options: TimeoutOptions = {}
): Promise<T> {
  const timeoutMs = getTimeoutMs(options.timeout);
  const timeoutMessage = options.timeoutMessage ?? `操作超时（${timeoutMs}ms）`;
  
  // 创建 AbortController 用于超时
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  // 如果提供了外部信号，链接它
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }
  
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(timeoutMessage));
        });
      })
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 带超时和自动重试的 Promise 包装
 * 适用于幂等的读取操作
 * @param fn 返回 Promise 的函数（每次重试都会重新调用）
 * @param options 重试选项
 * @returns 带超时和重试保护的 Promise
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    enableRetry = true,
    maxRetries = RETRY_POLICY.MAX_RETRIES,
    shouldRetry = isRetryableError,
    onRetry,
    ...timeoutOptions
  } = options;
  
  let lastError: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 第一次尝试或重试
      const promise = fn();
      return await withTimeout(promise, timeoutOptions);
    } catch (error: any) {
      lastError = error;
      
      // 检查是否应该重试
      if (!enableRetry || attempt >= maxRetries) {
        throw error;
      }
      
      if (!shouldRetry(error)) {
        throw error;
      }
      
      // 计算重试延迟
      const retryDelay = calculateRetryDelay(attempt);
      
      // 调用重试回调
      onRetry?.(attempt + 1, error);
      
      // 等待后重试
      await delay(retryDelay);
    }
  }
  
  throw lastError;
}

/**
 * 创建带超时的 fetch 请求
 * @param url 请求 URL
 * @param init fetch 选项
 * @param timeout 超时时间
 * @returns fetch 响应
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeout: number | TimeoutLevel = 'STANDARD'
): Promise<Response> {
  const timeoutMs = getTimeoutMs(timeout);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 创建带超时和重试的 fetch 请求
 * 仅适用于 GET 等幂等请求
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  return withRetry(
    () => fetchWithTimeout(url, init, options.timeout),
    options
  );
}

/**
 * 为 Supabase 操作创建超时包装
 * 使用示例：
 * ```ts
 * const { data, error } = await supabaseWithTimeout(
 *   () => supabase.from('projects').select('*'),
 *   'STANDARD'
 * );
 * ```
 */
export async function supabaseWithTimeout<T>(
  queryFn: () => PromiseLike<T>,
  timeout: number | TimeoutLevel = 'STANDARD'
): Promise<T> {
  return withTimeout(Promise.resolve(queryFn()), { timeout });
}

/**
 * 为 Supabase 幂等读取操作创建超时+重试包装
 * 使用示例：
 * ```ts
 * const { data, error } = await supabaseWithRetry(
 *   () => supabase.from('projects').select('*').eq('id', projectId),
 *   { timeout: 'QUICK' }
 * );
 * ```
 */
export async function supabaseWithRetry<T>(
  queryFn: () => PromiseLike<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withRetry(() => Promise.resolve(queryFn()), options);
}
