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
