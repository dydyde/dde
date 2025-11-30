/**
 * 统一日期处理工具
 * 解决日期格式不一致问题，提供时区安全的日期操作
 */

/**
 * 获取当前时间的 ISO 字符串（UTC）
 * 统一使用此方法代替 new Date().toISOString()
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * 获取当前时间戳（毫秒）
 * 统一使用此方法代替 Date.now()
 */
export function nowTimestamp(): number {
  return Date.now();
}

/**
 * 将日期转换为 ISO 字符串
 * 安全处理各种输入格式
 */
export function toISO(date: Date | string | number | null | undefined): string {
  if (!date) return nowISO();
  
  if (date instanceof Date) {
    return isValidDate(date) ? date.toISOString() : nowISO();
  }
  
  if (typeof date === 'number') {
    const d = new Date(date);
    return isValidDate(d) ? d.toISOString() : nowISO();
  }
  
  if (typeof date === 'string') {
    const d = new Date(date);
    return isValidDate(d) ? d.toISOString() : nowISO();
  }
  
  return nowISO();
}

/**
 * 检查日期是否有效
 */
export function isValidDate(date: Date | null | undefined): boolean {
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * 解析日期字符串，返回 Date 对象或 null
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isValidDate(date) ? date : null;
}

/**
 * 格式化日期为本地显示格式
 */
export function formatDate(
  date: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (!isValidDate(d)) return '';
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...options
  };
  
  try {
    return d.toLocaleDateString('zh-CN', defaultOptions);
  } catch {
    return d.toISOString().split('T')[0];
  }
}

/**
 * 格式化日期时间为本地显示格式
 */
export function formatDateTime(
  date: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (!isValidDate(d)) return '';
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...options
  };
  
  try {
    return d.toLocaleString('zh-CN', defaultOptions);
  } catch {
    return d.toISOString().replace('T', ' ').substring(0, 16);
  }
}

/**
 * 格式化为相对时间（如"3分钟前"）
 * 支持未来时间和过去时间
 */
export function formatRelativeTime(date: Date | string | number | null | undefined): string {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (!isValidDate(d)) return '';
  
  const now = Date.now();
  const diff = now - d.getTime();
  const absDiff = Math.abs(diff);
  const isFuture = diff < 0;
  
  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  // 未来时间
  if (isFuture) {
    if (seconds < 60) return '即将';
    if (minutes < 60) return `${minutes}分钟后`;
    if (hours < 24) return `${hours}小时后`;
    if (days < 7) return `${days}天后`;
    if (days < 30) return `${Math.floor(days / 7)}周后`;
    if (days < 365) return `${Math.floor(days / 30)}个月后`;
    return `${Math.floor(days / 365)}年后`;
  }
  
  // 过去时间
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

/**
 * 格式化为 HTML datetime-local input 使用的格式
 */
export function formatForInput(date: Date | string | number | null | undefined): string {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (!isValidDate(d)) return '';
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 比较两个日期（用于排序）
 * 返回：负数 = a < b, 0 = 相等, 正数 = a > b
 */
export function compareDates(
  a: Date | string | number | null | undefined,
  b: Date | string | number | null | undefined
): number {
  const dateA = a ? new Date(a).getTime() : 0;
  const dateB = b ? new Date(b).getTime() : 0;
  return dateA - dateB;
}

/**
 * 检查日期是否在指定天数内
 */
export function isWithinDays(
  date: Date | string | number | null | undefined,
  days: number
): boolean {
  if (!date) return false;
  
  const d = date instanceof Date ? date : new Date(date);
  if (!isValidDate(d)) return false;
  
  const now = Date.now();
  const diff = now - d.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  
  return diff <= days * dayMs;
}

/**
 * 获取日期的开始时间（当天 00:00:00）
 */
export function startOfDay(date: Date | string | number | null | undefined): Date {
  const d = date ? new Date(date) : new Date();
  if (!isValidDate(d)) return new Date();
  
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 获取日期的结束时间（当天 23:59:59.999）
 */
export function endOfDay(date: Date | string | number | null | undefined): Date {
  const d = date ? new Date(date) : new Date();
  if (!isValidDate(d)) return new Date();
  
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * 添加天数到日期
 */
export function addDays(
  date: Date | string | number | null | undefined,
  days: number
): Date {
  const d = date ? new Date(date) : new Date();
  if (!isValidDate(d)) return new Date();
  
  d.setDate(d.getDate() + days);
  return d;
}
