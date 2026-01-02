/**
 * 本地备份配置
 * 
 * 【P3 桌面坚果云备份 - C 层可选增强】
 * 
 * 注意事项：
 * - 仅桌面 Chrome 支持 File System Access API
 * - 需要用户手动授权目录访问
 * - 浏览器重启后需要重新授权
 * - 建议将备份目录设置在坚果云同步目录中
 */

export const LOCAL_BACKUP_CONFIG = {
  /** 默认备份间隔（毫秒）- 30 分钟 */
  DEFAULT_INTERVAL_MS: 30 * 60 * 1000,
  
  /** 备份文件名前缀 */
  FILENAME_PREFIX: 'nanoflow-backup',
  
  /** 备份文件扩展名 */
  FILE_EXTENSION: '.json',
  
  /** 最大保留备份文件数 */
  MAX_BACKUP_FILES: 30,
  
  /** 备份文件名时间格式 */
  TIMESTAMP_FORMAT: 'yyyy-MM-dd_HH-mm-ss',
  
  /** localStorage 存储键 */
  STORAGE_KEYS: {
    /** 目录句柄持久化键 */
    DIRECTORY_HANDLE: 'nanoflow.local-backup.directory-handle',
    /** 上次备份时间 */
    LAST_BACKUP_TIME: 'nanoflow.local-backup.last-time',
    /** 是否启用自动备份 */
    AUTO_BACKUP_ENABLED: 'nanoflow.local-backup.auto-enabled',
    /** 自动备份间隔 */
    AUTO_BACKUP_INTERVAL: 'nanoflow.local-backup.interval',
  },
  
  /** 目录选择器选项 */
  DIRECTORY_PICKER_OPTIONS: {
    /** 默认起始目录 */
    startIn: 'documents' as FileSystemPermissionMode,
    /** 访问模式 */
    mode: 'readwrite' as FileSystemPermissionMode,
  },
  
  /** 备份验证选项 */
  VALIDATION: {
    /** 是否验证写入（反读校验） */
    VERIFY_WRITE: true,
    /** 是否记录校验和 */
    INCLUDE_CHECKSUM: true,
  },
} as const;

/**
 * 备份结果
 */
export interface LocalBackupResult {
  success: boolean;
  error?: string;
  filename?: string;
  size?: number;
  timestamp?: string;
  /** 备份文件路径提示 */
  pathHint?: string;
}

/**
 * 目录授权结果
 */
export interface DirectoryAuthResult {
  success: boolean;
  error?: string;
  /** 目录名称 */
  directoryName?: string;
}

/**
 * 备份状态
 */
export interface LocalBackupStatus {
  /** 是否已授权 */
  isAuthorized: boolean;
  /** 授权目录名称 */
  directoryName?: string;
  /** 上次备份时间 */
  lastBackupTime?: string;
  /** 是否启用自动备份 */
  autoBackupEnabled: boolean;
  /** 自动备份间隔 */
  autoBackupIntervalMs: number;
}

/**
 * 平台兼容性检查结果
 */
export interface LocalBackupCompatibility {
  /** 是否支持 File System Access API */
  isSupported: boolean;
  /** 是否为桌面平台 */
  isDesktop: boolean;
  /** 不支持原因 */
  unsupportedReason?: string;
}
