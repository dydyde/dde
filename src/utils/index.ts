/**
 * 工具函数统一导出
 */

// 日期工具
export { 
  formatDate, 
  formatDateTime,
  formatRelativeTime, 
  nowISO, 
  nowTimestamp,
  toISO,
  parseDate,
  isValidDate,
  formatForInput,
  compareDates,
  isWithinDays,
  startOfDay,
  endOfDay,
  addDays
} from './date';

// Markdown 工具
export { renderMarkdown, renderMarkdownSafe, extractPlainText } from './markdown';

// Result 类型工具
export { 
  type Result, 
  type OperationError,
  type ErrorCode,
  ErrorCodes,
  ErrorMessages,
  success, 
  failure, 
  isSuccess, 
  isFailure, 
  unwrap, 
  unwrapOr, 
  map,
  flatMap,
  tryCatch,
  getErrorMessage
} from './result';

// 超时与重试工具
export { 
  withTimeout, 
  withRetry,
  fetchWithTimeout,
  fetchWithRetry,
  supabaseWithTimeout,
  supabaseWithRetry,
  type TimeoutOptions,
  type RetryOptions 
} from './timeout';

// 验证工具
export { 
  validateTask,
  validateProject,
  validateConnection,
  validateAttachment,
  sanitizeTask,
  sanitizeProject,
  sanitizeAttachment,
  detectCycles,
  detectOrphans,
  type ValidationResult 
} from './validation';
