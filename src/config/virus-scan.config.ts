// ============================================
// 附件病毒扫描配置
// 定义病毒扫描策略、时机和处理流程
// ============================================

/**
 * 扫描时机策略
 * 
 * 问题背景（TOCTOU - Time Of Check to Time Of Use）：
 * 文件在扫描通过后到用户下载使用之间可能被替换为恶意文件。
 * 
 * 解决方案：多层扫描策略
 */
export const VIRUS_SCAN_CONFIG = {
  // ==================== 扫描策略 ====================
  
  /**
   * 扫描时机策略
   * 
   * 'upload': 仅在上传时扫描
   *   - 优点：用户立即得到反馈，阻止恶意文件进入系统
   *   - 缺点：TOCTOU 窗口，后续替换无法检测
   * 
   * 'download': 仅在下载时扫描
   *   - 优点：确保用户下载的文件是安全的
   *   - 缺点：恶意文件已在存储中，影响其他用户
   * 
   * 'both': 上传和下载时都扫描
   *   - 优点：双重保护，覆盖 TOCTOU 窗口
   *   - 缺点：增加延迟和成本
   * 
   * 'async': 上传后异步扫描，下载时检查状态
   *   - 优点：不阻塞上传，后台处理
   *   - 缺点：扫描完成前文件状态不确定
   * 
   * 推荐策略：'upload_with_async_rescan'
   *   1. 上传时同步扫描（阻止明确恶意文件）
   *   2. 定期异步重新扫描所有文件（更新病毒库后）
   *   3. 下载时检查最后扫描状态
   */
  SCAN_STRATEGY: 'upload_with_async_rescan' as const,
  
  // ==================== 上传时扫描配置 ====================
  UPLOAD_SCAN: {
    /** 是否启用上传时扫描 */
    ENABLED: true,
    
    /** 扫描超时时间（毫秒）*/
    TIMEOUT: 30000, // 30 秒
    
    /** 超时后的处理策略 */
    ON_TIMEOUT: 'reject' as const, // 'reject' | 'allow_with_warning' | 'queue_for_async'
    
    /** 扫描失败后的处理策略 */
    ON_FAILURE: 'reject' as const, // 'reject' | 'allow_with_warning' | 'queue_for_async'
    
    /** 最大文件大小（字节）- 超过此大小跳过扫描 */
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    
    /** 需要扫描的文件类型（MIME 类型匹配） */
    SCAN_MIME_TYPES: [
      'application/*',
      'text/*',
      'image/svg+xml', // SVG 可包含脚本
    ],
    
    /** 跳过扫描的安全文件类型 */
    SKIP_MIME_TYPES: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ],
  },
  
  // ==================== 异步重扫配置 ====================
  ASYNC_RESCAN: {
    /** 是否启用异步重扫 */
    ENABLED: true,
    
    /** 重扫间隔（毫秒）- 每周一次 */
    INTERVAL: 7 * 24 * 60 * 60 * 1000,
    
    /** 每批次扫描文件数 */
    BATCH_SIZE: 100,
    
    /** 批次间隔（毫秒）*/
    BATCH_INTERVAL: 1000,
    
    /** 是否在病毒库更新后立即触发重扫 */
    RESCAN_ON_SIGNATURE_UPDATE: true,
  },
  
  // ==================== 下载时检查配置 ====================
  DOWNLOAD_CHECK: {
    /** 是否启用下载时检查 */
    ENABLED: true,
    
    /** 检查类型 */
    CHECK_TYPE: 'status_only' as const, // 'status_only' | 'full_rescan'
    
    /** 扫描状态过期时间（毫秒）- 7 天 */
    STATUS_EXPIRY: 7 * 24 * 60 * 60 * 1000,
    
    /** 状态过期后的处理 */
    ON_EXPIRED_STATUS: 'rescan' as const, // 'allow' | 'warn' | 'rescan' | 'block'
    
    /** 未扫描文件的处理 */
    ON_UNSCANNED: 'warn' as const, // 'allow' | 'warn' | 'block'
  },
  
  // ==================== 扫描结果处理 ====================
  SCAN_RESULT: {
    /** 发现威胁时的处理 */
    ON_THREAT_DETECTED: 'quarantine' as const, // 'delete' | 'quarantine' | 'block_access'
    
    /** 隔离区保留时间（毫秒）- 30 天 */
    QUARANTINE_RETENTION: 30 * 24 * 60 * 60 * 1000,
    
    /** 是否通知用户 */
    NOTIFY_USER: true,
    
    /** 是否通知管理员 */
    NOTIFY_ADMIN: true,
    
    /** 是否上报 Sentry */
    REPORT_TO_SENTRY: true,
  },
  
  // ==================== 扫描服务配置 ====================
  SCANNER: {
    /** 
     * 扫描服务类型
     * 
     * 'clamav': ClamAV（开源，需自建服务）
     * 'virustotal': VirusTotal API（云服务，有配额限制）
     * 'supabase_edge': Supabase Edge Function + ClamAV
     * 'external_api': 自定义外部 API
     */
    SERVICE_TYPE: 'supabase_edge' as const,
    
    /** API 端点（用于 external_api 类型）*/
    API_ENDPOINT: '',
    
    /** API 密钥环境变量名 */
    API_KEY_ENV: 'VIRUS_SCAN_API_KEY',
    
    /** 重试次数 */
    RETRY_COUNT: 2,
    
    /** 重试延迟（毫秒）*/
    RETRY_DELAY: 1000,
  },
} as const;

/**
 * 扫描状态枚举
 */
export const SCAN_STATUS = {
  /** 待扫描 */
  PENDING: 'pending',
  /** 扫描中 */
  SCANNING: 'scanning',
  /** 扫描通过 */
  CLEAN: 'clean',
  /** 发现威胁 */
  THREAT_DETECTED: 'threat_detected',
  /** 扫描失败 */
  FAILED: 'failed',
  /** 已隔离 */
  QUARANTINED: 'quarantined',
  /** 跳过（文件类型安全） */
  SKIPPED: 'skipped',
} as const;

export type ScanStatus = typeof SCAN_STATUS[keyof typeof SCAN_STATUS];

/**
 * 扫描结果接口
 */
export interface ScanResult {
  /** 文件 ID */
  fileId: string;
  /** 扫描状态 */
  status: ScanStatus;
  /** 威胁名称（如果有） */
  threatName?: string;
  /** 威胁描述 */
  threatDescription?: string;
  /** 扫描时间 */
  scannedAt: string;
  /** 扫描服务 */
  scanner: string;
  /** 扫描引擎版本 */
  engineVersion?: string;
  /** 病毒库版本 */
  signatureVersion?: string;
}

/**
 * 附件扫描元数据接口
 * 存储在 attachments JSONB 字段中
 */
export interface AttachmentScanMetadata {
  /** 最后扫描时间 */
  lastScannedAt?: string;
  /** 扫描状态 */
  scanStatus?: ScanStatus;
  /** 威胁信息（如果有） */
  threat?: {
    name: string;
    description: string;
    detectedAt: string;
  };
  /** 扫描历史（最近 5 次） */
  scanHistory?: Array<{
    scannedAt: string;
    status: ScanStatus;
    scanner: string;
  }>;
}

/**
 * TOCTOU（Time Of Check To Time Of Use）防护策略
 * 
 * 问题：文件在扫描后可能被替换
 * 
 * 防护措施：
 * 1. 文件哈希校验 - 下载前验证文件哈希与扫描时一致
 * 2. 不可变存储 - 使用 Supabase Storage 的版本控制
 * 3. 签名验证 - 扫描结果签名，防止篡改
 * 4. 定期重扫 - 病毒库更新后重新扫描
 */
export const TOCTOU_PROTECTION = {
  /** 是否启用文件哈希校验 */
  HASH_VERIFICATION: true,
  
  /** 哈希算法 */
  HASH_ALGORITHM: 'SHA-256' as const,
  
  /** 是否使用不可变存储 */
  IMMUTABLE_STORAGE: true,
  
  /** 扫描结果签名密钥环境变量 */
  SIGNATURE_KEY_ENV: 'SCAN_RESULT_SIGN_KEY',
  
  /** 签名算法 */
  SIGNATURE_ALGORITHM: 'HMAC-SHA256' as const,
} as const;

/**
 * 扫描触发时机详细说明
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        扫描流程图                               │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  用户上传文件                                                    │
 * │       │                                                         │
 * │       ▼                                                         │
 * │  ┌─────────────┐                                                │
 * │  │ 文件类型检查 │ ──跳过安全类型──▶ 标记为 SKIPPED               │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼ 需要扫描                                                │
 * │  ┌─────────────┐                                                │
 * │  │ 同步扫描    │ ──超时/失败──▶ 根据配置处理                     │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼ 扫描通过                                                │
 * │  ┌─────────────┐                                                │
 * │  │ 存储文件    │ ──记录哈希──▶ 保存扫描元数据                    │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼                                                         │
 * │  ┌─────────────┐                                                │
 * │  │ 定期重扫    │ ◀──病毒库更新触发                               │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼ 用户请求下载                                            │
 * │  ┌─────────────┐                                                │
 * │  │ 状态检查    │ ──过期──▶ 触发重扫                              │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼ 状态有效且安全                                          │
 * │  ┌─────────────┐                                                │
 * │  │ 哈希校验    │ ──不匹配──▶ 阻止下载 + 告警                     │
 * │  └─────────────┘                                                │
 * │       │                                                         │
 * │       ▼ 哈希匹配                                                │
 * │  ┌─────────────┐                                                │
 * │  │ 允许下载    │                                                 │
 * │  └─────────────┘                                                │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

/**
 * 扫描服务需要实现的接口
 */
export interface VirusScannerService {
  /** 扫描单个文件 */
  scanFile(file: Blob | ArrayBuffer, filename: string): Promise<ScanResult>;
  
  /** 批量扫描 */
  scanBatch(files: Array<{ id: string; url: string }>): Promise<ScanResult[]>;
  
  /** 检查扫描状态 */
  checkStatus(fileId: string): Promise<ScanResult | null>;
  
  /** 获取引擎信息 */
  getEngineInfo(): Promise<{
    name: string;
    version: string;
    signatureVersion: string;
    lastUpdate: string;
  }>;
}
