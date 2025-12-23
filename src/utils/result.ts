/**
 * 操作结果类型
 * 用于统一表示可能失败的操作结果
 */
export type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * 操作错误类型
 */
export interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * 常见错误码
 */
export const ErrorCodes = {
  // 布局错误
  LAYOUT_RANK_CONFLICT: 'LAYOUT_RANK_CONFLICT',
  LAYOUT_PARENT_CHILD_CONFLICT: 'LAYOUT_PARENT_CHILD_CONFLICT',
  LAYOUT_CYCLE_DETECTED: 'LAYOUT_CYCLE_DETECTED',
  LAYOUT_NO_SPACE: 'LAYOUT_NO_SPACE',
  
  // 浮动任务树错误
  STAGE_OVERFLOW: 'STAGE_OVERFLOW',
  CROSS_BOUNDARY_VIOLATION: 'CROSS_BOUNDARY_VIOLATION',
  
  // 数据错误
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',
  DATA_INVALID: 'DATA_INVALID',
  DATA_DUPLICATE: 'DATA_DUPLICATE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  
  // 同步错误
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_OFFLINE: 'SYNC_OFFLINE',
  SYNC_AUTH_EXPIRED: 'SYNC_AUTH_EXPIRED',
  
  // 权限错误
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  
  // 通用错误
  UNKNOWN: 'UNKNOWN'
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * 创建成功结果
 */
export function success<T>(value: T): Result<T, OperationError> {
  return { ok: true, value };
}

/**
 * 创建失败结果
 */
export function failure<T = never>(
  code: ErrorCode, 
  message: string, 
  details?: Record<string, unknown>
): Result<T, OperationError> {
  return { 
    ok: false, 
    error: { code, message, details } 
  };
}

/**
 * 错误消息映射（用于 UI 显示）
 */
export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCodes.LAYOUT_RANK_CONFLICT]: '任务排序冲突，请稍后重试',
  [ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT]: '无法移动：会破坏父子关系约束',
  [ErrorCodes.LAYOUT_CYCLE_DETECTED]: '无法移动：会产生循环依赖',
  [ErrorCodes.LAYOUT_NO_SPACE]: '该区域已满，无法放置更多任务',
  [ErrorCodes.STAGE_OVERFLOW]: '操作被拦截：子任务将超出最大阶段限制',
  [ErrorCodes.CROSS_BOUNDARY_VIOLATION]: '非法操作：不能跨越待分配/已分配边界建立父子关系',
  [ErrorCodes.DATA_NOT_FOUND]: '数据不存在',
  [ErrorCodes.DATA_INVALID]: '数据格式无效',
  [ErrorCodes.DATA_DUPLICATE]: '数据重复',
  [ErrorCodes.VALIDATION_ERROR]: '数据验证失败',
  [ErrorCodes.SYNC_CONFLICT]: '数据冲突，请选择保留的版本',
  [ErrorCodes.SYNC_OFFLINE]: '当前离线，数据将在恢复连接后同步',
  [ErrorCodes.SYNC_AUTH_EXPIRED]: '登录已过期，请重新登录',
  [ErrorCodes.PERMISSION_DENIED]: '没有权限执行此操作',
  [ErrorCodes.UNKNOWN]: '未知错误'
};

/**
 * 获取用户友好的错误消息
 */
export function getErrorMessage(error: OperationError): string {
  return ErrorMessages[error.code as ErrorCode] || error.message || ErrorMessages[ErrorCodes.UNKNOWN];
}

/**
 * 类型守卫：判断结果是否成功
 */
export function isSuccess<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok === true;
}

/**
 * 类型守卫：判断结果是否失败
 */
export function isFailure<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return result.ok === false;
}

/**
 * 从 Result 中提取值，失败时抛出异常
 */
export function unwrap<T>(result: Result<T, OperationError>): T {
  if (result.ok) {
    return result.value;
  }
  // TypeScript 在这里知道 result 是 { ok: false; error: OperationError }
  const failedResult = result as { ok: false; error: OperationError };
  throw new Error(failedResult.error.message);
}

/**
 * 从 Result 中提取值，失败时返回默认值
 */
export function unwrapOr<T>(result: Result<T, OperationError>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * 安全地从 unknown 类型提取错误消息
 * 用于 catch 块中将 unknown 类型的错误转换为字符串
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * 网络错误消息映射表
 * 将技术性错误消息转换为用户友好的提示
 */
const NETWORK_ERROR_MESSAGES: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /Failed to fetch|fetch.*fail/i, message: '网络连接失败，请检查网络后重试' },
  { pattern: /NetworkError|network.*error/i, message: '网络错误，请检查网络连接' },
  { pattern: /timeout|ETIMEDOUT/i, message: '请求超时，请稍后重试' },
  { pattern: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i, message: '无法连接到服务器' },
  { pattern: /ERR_NETWORK|ERR_INTERNET/i, message: '网络不可用，请检查网络连接' },
  { pattern: /offline/i, message: '当前处于离线状态' },
  { pattern: /cors|cross-origin/i, message: '网络请求被阻止，请稍后重试' },
  { pattern: /abort/i, message: '请求已取消' },
  { pattern: /Invalid.*email|Email.*not.*confirmed/i, message: '邮箱格式不正确或未验证' },
  { pattern: /Invalid.*password|Invalid.*credentials/i, message: '用户名或密码错误' },
  { pattern: /User.*not.*found/i, message: '用户不存在' },
  { pattern: /Email.*already.*registered/i, message: '该邮箱已被注册' },
  { pattern: /rate.*limit|too.*many.*requests/i, message: '操作太频繁，请稍后再试' },
  { pattern: /unauthorized|401/i, message: '登录已过期，请重新登录' },
  { pattern: /forbidden|403/i, message: '没有权限执行此操作' },
  { pattern: /not.*found|404/i, message: '请求的资源不存在' },
  { pattern: /server.*error|500|502|503|504/i, message: '服务器繁忙，请稍后重试' },
];

/**
 * 将技术性错误消息转换为用户友好的提示
 * 用于在 UI 中显示错误时提供更好的用户体验
 * 
 * @example
 * // 技术性消息会被转换
 * humanizeErrorMessage('Failed to fetch') // => '网络连接失败，请检查网络后重试'
 * 
 * // 已经友好的消息会保持不变
 * humanizeErrorMessage('密码长度至少8位') // => '密码长度至少8位'
 */
export function humanizeErrorMessage(errorMessage: string): string {
  if (!errorMessage) {
    return '操作失败，请稍后重试';
  }
  
  // 检查是否匹配已知的技术性错误
  for (const { pattern, message } of NETWORK_ERROR_MESSAGES) {
    if (pattern.test(errorMessage)) {
      return message;
    }
  }
  
  // 如果是 TypeError: xxx 格式，提取并转换
  if (errorMessage.startsWith('TypeError:')) {
    const innerMessage = errorMessage.replace(/^TypeError:\s*/i, '');
    return humanizeErrorMessage(innerMessage);
  }
  
  // 如果消息看起来是技术性的（包含特殊字符或很长的英文），返回通用消息
  const looksLikeTechnical = 
    /^[A-Z_]+:|Error:|Exception:|^\[.*\]|{.*}/.test(errorMessage) ||
    (errorMessage.length > 100 && /^[a-zA-Z\s.,;:'"()[\]{}]+$/.test(errorMessage));
  
  if (looksLikeTechnical) {
    return '操作失败，请稍后重试';
  }
  
  // 返回原始消息（可能已经是用户友好的）
  return errorMessage;
}

/**
 * 将可能抛出异常的操作包装为 Result
 */
export function tryCatch<T>(
  fn: () => T,
  errorCode: ErrorCode = ErrorCodes.UNKNOWN
): Result<T, OperationError> {
  try {
    return success(fn());
  } catch (e: unknown) {
    return failure(errorCode, extractErrorMessage(e));
  }
}

/**
 * 将可能抛出异常的异步操作包装为 Result
 */
export async function tryCatchAsync<T>(
  fn: () => Promise<T>,
  errorCode: ErrorCode = ErrorCodes.UNKNOWN
): Promise<Result<T, OperationError>> {
  try {
    const value = await fn();
    return success(value);
  } catch (e: unknown) {
    return failure(errorCode, extractErrorMessage(e));
  }
}

/**
 * 映射 Result 的成功值
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (result.ok) {
    return { ok: true, value: fn(result.value) };
  }
  // 类型明确为失败，直接返回
  return result as { ok: false; error: E };
}

/**
 * 链式处理 Result（flatMap）
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  // 类型明确为失败，直接返回
  return result as { ok: false; error: E };
}
