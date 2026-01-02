/**
 * 备份系统共享模块
 * 包含加密、校验、压缩等公共功能
 * 
 * 位置: supabase/functions/_shared/backup-utils.ts
 */

// ===========================================
// 类型定义
// ===========================================

/** 备份类型 */
export type BackupType = 'full' | 'incremental';

/** 备份状态 */
export type BackupStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired';

/** 备份元数据 */
export interface BackupMetadata {
  id?: string;
  type: BackupType;
  path: string;
  userId?: string | null;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  attachmentCount: number;
  sizeBytes: number;
  compressed: boolean;
  encrypted: boolean;
  checksum: string;
  checksumAlgorithm: string;
  encryptionAlgorithm?: string;
  encryptionKeyId?: string;
  validationPassed: boolean;
  validationWarnings: string[];
  backupStartedAt: string;
  backupCompletedAt?: string;
  baseBackupId?: string;
  incrementalSince?: string;
  expiresAt?: string;
  retentionTier?: 'hourly' | 'daily' | 'weekly' | 'monthly';
  status: BackupStatus;
  errorMessage?: string;
}

/** 备份数据结构 */
export interface BackupData {
  version: string;
  type: BackupType;
  createdAt: string;
  projects: BackupProject[];
  tasks: BackupTask[];
  connections: BackupConnection[];
  attachments?: BackupAttachmentMeta[];
}

export interface BackupProject {
  id: string;
  userId: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  parentId?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: string;
  x?: number;
  y?: number;
  displayId?: string;
  shortId?: string;
  attachments?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BackupConnection {
  id: string;
  projectId: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BackupAttachmentMeta {
  id: string;
  taskId: string;
  name: string;
  type: string;
  size: number;
  storagePath: string;
}

/** 健康校验结果 */
export interface BackupValidation {
  isJsonValid: boolean;
  hasRequiredTables: boolean;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  taskCountInRange: boolean;
  orphanedTasks: number;
  brokenConnections: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ===========================================
// 配置常量
// ===========================================

export const BACKUP_CONFIG = {
  /** 备份版本 */
  VERSION: '1.0.0',
  
  /** 健康校验配置 */
  VALIDATION: {
    /** 任务数变化阈值 - 分级告警 */
    TASK_COUNT_CHANGE: {
      WARNING_RATIO: 0.1,    // 10% → 警告
      BLOCK_RATIO: 0.3,      // 30% → 阻止备份
      ABSOLUTE_THRESHOLD: 20, // 变化超过 20 个任务 → 至少触发警告
      MIN_TASK_COUNT_FOR_RATIO: 50, // 小于 50 个任务时使用绝对值
    },
    /** 是否允许空备份 */
    ALLOW_EMPTY_BACKUP: false,
    /** 最小项目数（低于则告警） */
    MIN_PROJECT_COUNT: 1,
    /** 孤儿任务阈值（超过则告警） */
    MAX_ORPHANED_TASKS: 10,
    /** 断开连接阈值 */
    MAX_BROKEN_CONNECTIONS: 20,
  },
  
  /** 加密配置 */
  ENCRYPTION: {
    ENABLED: true,
    ALGORITHM: 'AES-GCM' as const,
    KEY_LENGTH: 256,
    IV_LENGTH: 12, // 96 bits for AES-GCM
    TAG_LENGTH: 128,
  },
  
  /** 完整性校验配置 */
  INTEGRITY: {
    CHECKSUM_ALGORITHM: 'SHA-256',
    VERIFY_ON_UPLOAD: true,
    VERIFY_ON_RESTORE: true,
  },
  
  /** 压缩配置 */
  COMPRESSION: {
    ENABLED: true,
    LEVEL: 9, // 最高压缩级别
  },
  
  /** 保留策略 */
  RETENTION: {
    /** 最近 24 小时：保留所有增量 */
    HOURLY_MAX_AGE_HOURS: 24,
    /** 最近 7 天：每天保留 4 个点 */
    DAILY_MAX_AGE_DAYS: 7,
    DAILY_SAMPLE_HOURS: [0, 6, 12, 18],
    /** 最近 30 天：每天保留 1 个全量 */
    WEEKLY_MAX_AGE_DAYS: 30,
    /** 更久：每周保留 1 个 */
    MONTHLY_MAX_AGE_DAYS: 90,
  },
} as const;

// ===========================================
// 加密工具
// ===========================================

/**
 * 使用 AES-256-GCM 加密数据
 * @param data 要加密的数据（UTF-8 字符串）
 * @param keyBase64 Base64 编码的 256 位密钥
 * @returns 加密后的数据（IV + 密文 + Tag 的 Base64）
 */
export async function encryptData(data: string, keyBase64: string): Promise<string> {
  // 解码密钥
  const keyBytes = base64ToBytes(keyBase64);
  if (keyBytes.length !== 32) {
    throw new Error('Invalid encryption key length. Expected 256 bits (32 bytes).');
  }
  
  // 导入密钥 - 使用 ArrayBuffer 确保类型兼容
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  
  // 生成随机 IV
  const iv = crypto.getRandomValues(new Uint8Array(BACKUP_CONFIG.ENCRYPTION.IV_LENGTH));
  
  // 编码数据
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);
  
  // 加密
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: BACKUP_CONFIG.ENCRYPTION.TAG_LENGTH },
    cryptoKey,
    dataBytes
  );
  
  // 组合 IV + 密文
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  
  return bytesToBase64(combined);
}

/**
 * 使用 AES-256-GCM 解密数据
 * @param encryptedBase64 加密数据（IV + 密文 + Tag 的 Base64）
 * @param keyBase64 Base64 编码的 256 位密钥
 * @returns 解密后的数据（UTF-8 字符串）
 */
export async function decryptData(encryptedBase64: string, keyBase64: string): Promise<string> {
  // 解码密钥
  const keyBytes = base64ToBytes(keyBase64);
  if (keyBytes.length !== 32) {
    throw new Error('Invalid encryption key length. Expected 256 bits (32 bytes).');
  }
  
  // 导入密钥 - 使用 ArrayBuffer 确保类型兼容
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  
  // 解码加密数据
  const combined = base64ToBytes(encryptedBase64);
  
  // 分离 IV 和密文
  const iv = combined.slice(0, BACKUP_CONFIG.ENCRYPTION.IV_LENGTH);
  const ciphertext = combined.slice(BACKUP_CONFIG.ENCRYPTION.IV_LENGTH);
  
  // 解密
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: BACKUP_CONFIG.ENCRYPTION.TAG_LENGTH },
    cryptoKey,
    ciphertext
  );
  
  // 解码数据
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// ===========================================
// 完整性校验工具
// ===========================================

/**
 * 计算数据的 SHA-256 校验和
 * @param data 要计算的数据
 * @returns 十六进制编码的校验和
 */
export async function calculateChecksum(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' 
    ? new TextEncoder().encode(data) 
    : data;
  
  // 使用 ArrayBuffer 确保类型兼容
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  
  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 验证数据的校验和
 */
export async function verifyChecksum(data: string | Uint8Array, expectedChecksum: string): Promise<boolean> {
  const actualChecksum = await calculateChecksum(data);
  return actualChecksum === expectedChecksum;
}

// ===========================================
// 压缩工具
// ===========================================

/**
 * 使用 gzip 压缩数据
 * @param data 要压缩的数据
 * @returns 压缩后的 Uint8Array
 */
export async function compressData(data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);
  
  // 使用 Web Streams API 的 CompressionStream
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // 使用 ArrayBuffer 确保类型兼容
  const dataBuffer = dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength) as ArrayBuffer;
  writer.write(new Uint8Array(dataBuffer) as unknown as BufferSource);
  writer.close();
  
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  
  // 合并所有块
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  
  return result;
}

/**
 * 解压 gzip 数据
 * @param data 压缩的数据
 * @returns 解压后的字符串
 */
export async function decompressData(data: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  // 使用 ArrayBuffer 确保类型兼容
  const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  writer.write(new Uint8Array(dataBuffer) as unknown as BufferSource);
  writer.close();
  
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  
  // 合并所有块
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  
  const decoder = new TextDecoder();
  return decoder.decode(result);
}

// ===========================================
// 健康校验
// ===========================================

/**
 * 执行备份健康校验
 */
export function validateBackup(
  data: BackupData,
  previousMeta?: { taskCount: number } | null
): BackupValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 1. 基础结构校验
  const hasRequiredTables = 
    Array.isArray(data.projects) &&
    Array.isArray(data.tasks) &&
    Array.isArray(data.connections);
  
  if (!hasRequiredTables) {
    errors.push('缺少必需的数据表 (projects, tasks, connections)');
  }
  
  const projectCount = data.projects?.length ?? 0;
  const taskCount = data.tasks?.length ?? 0;
  const connectionCount = data.connections?.length ?? 0;
  
  // 2. 空备份检查
  if (!BACKUP_CONFIG.VALIDATION.ALLOW_EMPTY_BACKUP && taskCount === 0) {
    errors.push('备份数据为空 (任务数=0)');
  }
  
  // 3. 最小项目数检查
  if (projectCount < BACKUP_CONFIG.VALIDATION.MIN_PROJECT_COUNT) {
    warnings.push(`项目数 (${projectCount}) 低于最小值 (${BACKUP_CONFIG.VALIDATION.MIN_PROJECT_COUNT})`);
  }
  
  // 4. 任务数变化检查
  let taskCountInRange = true;
  if (previousMeta && previousMeta.taskCount > 0) {
    const change = Math.abs(taskCount - previousMeta.taskCount);
    const ratio = change / previousMeta.taskCount;
    const config = BACKUP_CONFIG.VALIDATION.TASK_COUNT_CHANGE;
    
    // 使用相对值或绝对值（取较大者）
    const useAbsolute = previousMeta.taskCount < config.MIN_TASK_COUNT_FOR_RATIO;
    
    if (useAbsolute) {
      // 小项目使用绝对值
      if (change > config.ABSOLUTE_THRESHOLD) {
        if (ratio > config.BLOCK_RATIO) {
          errors.push(`任务数变化过大: ${previousMeta.taskCount} → ${taskCount}`);
          taskCountInRange = false;
        } else {
          warnings.push(`任务数变化异常: ${previousMeta.taskCount} → ${taskCount} (${change} 个)`);
        }
      }
    } else {
      // 大项目使用相对值
      if (ratio > config.BLOCK_RATIO) {
        errors.push(`任务数变化超过阈值: ${previousMeta.taskCount} → ${taskCount} (${(ratio * 100).toFixed(1)}%)`);
        taskCountInRange = false;
      } else if (ratio > config.WARNING_RATIO || change > config.ABSOLUTE_THRESHOLD) {
        warnings.push(`任务数变化异常: ${previousMeta.taskCount} → ${taskCount} (${(ratio * 100).toFixed(1)}%)`);
      }
    }
  }
  
  // 5. 孤儿任务检测
  const projectIds = new Set(data.projects?.map(p => p.id) ?? []);
  const orphanedTasks = data.tasks?.filter(t => t.projectId && !projectIds.has(t.projectId)) ?? [];
  if (orphanedTasks.length > BACKUP_CONFIG.VALIDATION.MAX_ORPHANED_TASKS) {
    warnings.push(`发现 ${orphanedTasks.length} 个孤儿任务（无对应项目）`);
  }
  
  // 6. 断开连接检测
  const taskIds = new Set(data.tasks?.map(t => t.id) ?? []);
  const brokenConnections = data.connections?.filter(
    c => !taskIds.has(c.source) || !taskIds.has(c.target)
  ) ?? [];
  if (brokenConnections.length > BACKUP_CONFIG.VALIDATION.MAX_BROKEN_CONNECTIONS) {
    warnings.push(`发现 ${brokenConnections.length} 个断开的连接（端点任务不存在）`);
  }
  
  return {
    isJsonValid: true, // JSON 解析成功才能到这里
    hasRequiredTables,
    projectCount,
    taskCount,
    connectionCount,
    taskCountInRange,
    orphanedTasks: orphanedTasks.length,
    brokenConnections: brokenConnections.length,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

// ===========================================
// 路径生成
// ===========================================

/**
 * 生成备份文件路径
 */
export function generateBackupPath(
  type: BackupType,
  timestamp: Date = new Date()
): string {
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');
  const hour = String(timestamp.getUTCHours()).padStart(2, '0');
  const minute = String(timestamp.getUTCMinutes()).padStart(2, '0');
  const second = String(timestamp.getUTCSeconds()).padStart(2, '0');
  
  // 格式: backups/{type}/{year}/{month}/{type}-{YYYYMMDD-HHmmss}.json.gz
  const filename = `${type}-${year}${month}${day}-${hour}${minute}${second}.json.gz`;
  return `backups/${type}/${year}/${month}/${filename}`;
}

/**
 * 计算备份过期时间
 */
export function calculateExpiresAt(
  type: BackupType,
  timestamp: Date = new Date()
): { expiresAt: Date; retentionTier: 'hourly' | 'daily' | 'weekly' | 'monthly' } {
  const config = BACKUP_CONFIG.RETENTION;
  const now = timestamp.getTime();
  
  if (type === 'incremental') {
    // 增量备份：24 小时后过期
    return {
      expiresAt: new Date(now + config.HOURLY_MAX_AGE_HOURS * 60 * 60 * 1000),
      retentionTier: 'hourly',
    };
  } else {
    // 全量备份：30 天后过期
    return {
      expiresAt: new Date(now + config.WEEKLY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
      retentionTier: 'daily',
    };
  }
}

// ===========================================
// 工具函数
// ===========================================

function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 将 Uint8Array 转为 Base64 字符串
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

/**
 * 将 Base64 字符串转为 Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  return base64ToBytes(base64);
}
