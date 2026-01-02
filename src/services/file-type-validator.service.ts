/**
 * 文件类型验证服务
 * 
 * 策划案 3.4 - 文件类型验证增强（High 优先级）
 * 
 * 问题：
 * - 仅依赖 file.type（MIME 类型）可被伪造
 * - 恶意文件可伪装成安全类型上传
 * - 无法检测真实文件类型
 * 
 * 解决方案：
 * 1. 文件魔数（Magic Number）验证 - 检查文件头部字节
 * 2. 扩展名白名单验证
 * 3. MIME 类型白名单验证
 * 4. 三重验证一致性检查
 * 
 * @version 5.11
 * @since 2026-01-03
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import * as Sentry from '@sentry/angular';

// ============================================
// 配置常量
// ============================================

/**
 * 文件类型验证配置
 */
export const FILE_TYPE_VALIDATION_CONFIG = {
  /** 是否启用文件类型验证 */
  ENABLED: true,
  
  /** 是否启用魔数验证 */
  MAGIC_NUMBER_CHECK: true,
  
  /** 是否要求扩展名与 MIME 类型一致 */
  REQUIRE_EXTENSION_MATCH: true,
  
  /** 是否允许未知文件类型 */
  ALLOW_UNKNOWN_TYPES: false,
  
  /** 读取文件头的最大字节数 */
  MAX_HEADER_BYTES: 16,
  
  /** 严格模式：三重验证必须全部通过 */
  STRICT_MODE: true,
} as const;

/**
 * 允许的文件扩展名白名单（小写）
 */
export const ALLOWED_EXTENSIONS = new Set([
  // 图片
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
  // 文档
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'markdown', 'rtf', 'csv',
  // 代码/配置
  'json', 'xml', 'yaml', 'yml',
  // 压缩文件
  'zip',
]);

/**
 * 允许的 MIME 类型白名单
 */
export const ALLOWED_MIME_TYPES = new Set([
  // 图片
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  // PDF
  'application/pdf',
  // Office 文档
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 文本
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/rtf',
  'application/rtf',
  // 数据格式
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
  // 压缩
  'application/zip',
  'application/x-zip-compressed',
]);

/**
 * 危险 MIME 类型黑名单（即使绕过验证也要拒绝）
 */
export const DANGEROUS_MIME_TYPES = new Set([
  // 可执行文件
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/exe',
  'application/x-exe',
  'application/dos-exe',
  // 脚本
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/x-python',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-perl',
  'application/x-ruby',
  'application/x-php',
  // HTML（可包含脚本）
  'text/html',
  'application/xhtml+xml',
  // Java
  'application/java-archive',
  'application/x-java-class',
  // 其他危险类型
  'application/x-msi',
  'application/vnd.microsoft.portable-executable',
]);

/**
 * 危险扩展名黑名单
 */
export const DANGEROUS_EXTENSIONS = new Set([
  // 可执行
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif',
  // 脚本
  'js', 'vbs', 'ps1', 'sh', 'bash', 'zsh', 'py', 'rb', 'pl', 'php',
  // Java
  'jar', 'class',
  // 链接/快捷方式
  'lnk', 'url',
  // 网页（可包含脚本）
  'html', 'htm', 'xhtml', 'hta', 'mht', 'mhtml',
  // 其他
  'dll', 'sys', 'drv', 'cpl',
]);

/**
 * 文件魔数签名映射
 * 键：16 进制字符串（文件头字节）
 * 值：{ mimeType, extensions }
 */
export const MAGIC_NUMBERS: Map<string, { mimeType: string; extensions: string[] }> = new Map([
  // JPEG: FF D8 FF
  ['ffd8ff', { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'] }],
  
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  ['89504e470d0a1a0a', { mimeType: 'image/png', extensions: ['png'] }],
  
  // GIF87a/GIF89a: 47 49 46 38
  ['47494638', { mimeType: 'image/gif', extensions: ['gif'] }],
  
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  // 注意：WebP 需要特殊处理，前 4 字节是 RIFF
  ['52494646', { mimeType: 'image/webp', extensions: ['webp'] }], // 部分匹配
  
  // BMP: 42 4D
  ['424d', { mimeType: 'image/bmp', extensions: ['bmp'] }],
  
  // ICO: 00 00 01 00
  ['00000100', { mimeType: 'image/x-icon', extensions: ['ico'] }],
  
  // PDF: 25 50 44 46 (%PDF)
  ['25504446', { mimeType: 'application/pdf', extensions: ['pdf'] }],
  
  // ZIP (also used for docx, xlsx, pptx): 50 4B 03 04
  ['504b0304', { mimeType: 'application/zip', extensions: ['zip', 'docx', 'xlsx', 'pptx'] }],
  
  // DOC: D0 CF 11 E0 (OLE Compound Document)
  ['d0cf11e0', { mimeType: 'application/msword', extensions: ['doc', 'xls', 'ppt'] }],
  
  // RTF: 7B 5C 72 74 66 ({\rtf)
  ['7b5c727466', { mimeType: 'application/rtf', extensions: ['rtf'] }],
]);

/**
 * SVG 文件的文本签名（需要特殊处理）
 */
const SVG_SIGNATURES = [
  '<svg',
  '<?xml',
  '<!DOCTYPE svg',
];

// ============================================
// 类型定义
// ============================================

/**
 * 文件验证结果
 */
export interface FileValidationResult {
  /** 验证是否通过 */
  valid: boolean;
  
  /** 检测到的 MIME 类型 */
  detectedMimeType?: string;
  
  /** 声明的 MIME 类型 */
  declaredMimeType: string;
  
  /** 文件扩展名 */
  extension: string;
  
  /** 错误信息（验证失败时） */
  error?: string;
  
  /** 错误代码 */
  errorCode?: FileValidationErrorCode;
  
  /** 验证详情 */
  details: {
    extensionValid: boolean;
    mimeTypeValid: boolean;
    magicNumberValid: boolean;
    consistencyValid: boolean;
  };
  
  /** 警告信息（验证通过但有注意事项） */
  warnings?: string[];
}

/**
 * 文件验证错误代码
 */
export type FileValidationErrorCode = 
  | 'DANGEROUS_EXTENSION'
  | 'DANGEROUS_MIME_TYPE'
  | 'EXTENSION_NOT_ALLOWED'
  | 'MIME_TYPE_NOT_ALLOWED'
  | 'MAGIC_NUMBER_MISMATCH'
  | 'EXTENSION_MIME_MISMATCH'
  | 'UNKNOWN_FILE_TYPE'
  | 'EMPTY_FILE'
  | 'READ_ERROR';

// ============================================
// 服务实现
// ============================================

/**
 * 文件类型验证服务
 * 
 * 提供三重验证机制：
 * 1. 扩展名白名单验证
 * 2. MIME 类型白名单验证
 * 3. 文件魔数验证
 */
@Injectable({
  providedIn: 'root'
})
export class FileTypeValidatorService {
  private readonly logger = inject(LoggerService).category('FileTypeValidator');

  /**
   * 验证文件类型
   * 执行三重验证：扩展名、MIME 类型、魔数
   * 
   * @param file 要验证的文件
   * @returns 验证结果
   */
  async validateFile(file: File): Promise<FileValidationResult> {
    const extension = this.getExtension(file.name);
    const declaredMimeType = file.type || 'application/octet-stream';
    
    const result: FileValidationResult = {
      valid: false,
      declaredMimeType,
      extension,
      details: {
        extensionValid: false,
        mimeTypeValid: false,
        magicNumberValid: false,
        consistencyValid: false,
      },
      warnings: [],
    };

    // 空文件检查
    if (file.size === 0) {
      result.error = '文件为空';
      result.errorCode = 'EMPTY_FILE';
      this.logValidationFailure(file, result);
      return result;
    }

    // 1. 检查危险扩展名（黑名单优先）
    if (DANGEROUS_EXTENSIONS.has(extension)) {
      result.error = `不允许上传 .${extension} 类型的文件`;
      result.errorCode = 'DANGEROUS_EXTENSION';
      this.logValidationFailure(file, result);
      return result;
    }

    // 2. 检查危险 MIME 类型（黑名单优先）
    if (DANGEROUS_MIME_TYPES.has(declaredMimeType)) {
      result.error = `不允许上传 ${declaredMimeType} 类型的文件`;
      result.errorCode = 'DANGEROUS_MIME_TYPE';
      this.logValidationFailure(file, result);
      return result;
    }

    // 3. 扩展名白名单验证
    result.details.extensionValid = ALLOWED_EXTENSIONS.has(extension);
    if (!result.details.extensionValid && !FILE_TYPE_VALIDATION_CONFIG.ALLOW_UNKNOWN_TYPES) {
      result.error = `不支持的文件扩展名: .${extension}`;
      result.errorCode = 'EXTENSION_NOT_ALLOWED';
      this.logValidationFailure(file, result);
      return result;
    }

    // 4. MIME 类型白名单验证
    result.details.mimeTypeValid = ALLOWED_MIME_TYPES.has(declaredMimeType);
    if (!result.details.mimeTypeValid && !FILE_TYPE_VALIDATION_CONFIG.ALLOW_UNKNOWN_TYPES) {
      result.error = `不支持的文件类型: ${declaredMimeType}`;
      result.errorCode = 'MIME_TYPE_NOT_ALLOWED';
      this.logValidationFailure(file, result);
      return result;
    }

    // 5. 魔数验证（如果启用）
    if (FILE_TYPE_VALIDATION_CONFIG.MAGIC_NUMBER_CHECK) {
      try {
        const magicResult = await this.validateMagicNumber(file);
        result.details.magicNumberValid = magicResult.valid;
        result.detectedMimeType = magicResult.detectedMimeType;
        
        if (!magicResult.valid) {
          // 严格模式下，魔数不匹配直接拒绝
          if (FILE_TYPE_VALIDATION_CONFIG.STRICT_MODE) {
            result.error = magicResult.error || '文件内容与声明类型不匹配';
            result.errorCode = 'MAGIC_NUMBER_MISMATCH';
            this.logValidationFailure(file, result);
            return result;
          } else {
            // 非严格模式，添加警告
            result.warnings?.push(magicResult.error || '无法验证文件内容类型');
          }
        }
      } catch (e) {
        this.logger.warn('魔数验证失败', { fileName: file.name, error: e });
        result.warnings?.push('无法读取文件进行内容验证');
        // 读取错误不阻止上传，但记录警告
      }
    } else {
      // 跳过魔数验证时，标记为有效
      result.details.magicNumberValid = true;
    }

    // 6. 一致性验证：检查扩展名与 MIME 类型是否匹配
    if (FILE_TYPE_VALIDATION_CONFIG.REQUIRE_EXTENSION_MATCH) {
      result.details.consistencyValid = this.checkExtensionMimeConsistency(extension, declaredMimeType);
      if (!result.details.consistencyValid) {
        if (FILE_TYPE_VALIDATION_CONFIG.STRICT_MODE) {
          result.error = `文件扩展名 .${extension} 与类型 ${declaredMimeType} 不匹配`;
          result.errorCode = 'EXTENSION_MIME_MISMATCH';
          this.logValidationFailure(file, result);
          return result;
        } else {
          result.warnings?.push(`文件扩展名与 MIME 类型不一致`);
        }
      }
    } else {
      result.details.consistencyValid = true;
    }

    // 全部验证通过
    result.valid = true;
    this.logger.debug('文件类型验证通过', {
      fileName: file.name,
      extension,
      mimeType: declaredMimeType,
      detectedMimeType: result.detectedMimeType,
    });
    
    return result;
  }

  /**
   * 快速验证（仅检查扩展名和 MIME 类型，不读取文件内容）
   * 用于批量验证或性能敏感场景
   */
  quickValidate(fileName: string, mimeType: string): { valid: boolean; error?: string } {
    const extension = this.getExtension(fileName);
    
    // 检查危险类型
    if (DANGEROUS_EXTENSIONS.has(extension)) {
      return { valid: false, error: `不允许上传 .${extension} 类型的文件` };
    }
    if (DANGEROUS_MIME_TYPES.has(mimeType)) {
      return { valid: false, error: `不允许上传 ${mimeType} 类型的文件` };
    }
    
    // 检查白名单
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return { valid: false, error: `不支持的文件扩展名: .${extension}` };
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return { valid: false, error: `不支持的文件类型: ${mimeType}` };
    }
    
    return { valid: true };
  }

  /**
   * 验证文件魔数
   * 读取文件头部字节，与已知魔数签名比对
   */
  private async validateMagicNumber(file: File): Promise<{ valid: boolean; detectedMimeType?: string; error?: string }> {
    const extension = this.getExtension(file.name);
    
    // SVG 是文本格式，需要特殊处理
    if (extension === 'svg' || file.type === 'image/svg+xml') {
      return this.validateSvg(file);
    }
    
    // 文本文件不进行魔数验证（返回有效）
    if (this.isTextFile(extension, file.type)) {
      return { valid: true, detectedMimeType: file.type };
    }
    
    try {
      const headerBytes = await this.readFileHeader(file, FILE_TYPE_VALIDATION_CONFIG.MAX_HEADER_BYTES);
      const hexString = this.bytesToHex(headerBytes);
      
      // 查找匹配的魔数
      for (const [magic, info] of MAGIC_NUMBERS) {
        if (hexString.startsWith(magic)) {
          // 魔数匹配，检查扩展名是否在允许列表中
          if (info.extensions.includes(extension) || this.isOfficeFormat(extension)) {
            return { valid: true, detectedMimeType: info.mimeType };
          }
          
          // WebP 特殊处理：需要检查更多字节
          if (magic === '52494646' && headerBytes.length >= 12) {
            const webpSignature = this.bytesToHex(headerBytes.slice(8, 12));
            if (webpSignature === '57454250') { // WEBP
              if (extension === 'webp') {
                return { valid: true, detectedMimeType: 'image/webp' };
              }
            }
          }
          
          // 魔数匹配但扩展名不匹配
          return {
            valid: false,
            detectedMimeType: info.mimeType,
            error: `文件实际类型是 ${info.mimeType}，但扩展名是 .${extension}`,
          };
        }
      }
      
      // 未找到匹配的魔数
      if (FILE_TYPE_VALIDATION_CONFIG.ALLOW_UNKNOWN_TYPES) {
        return { valid: true };
      }
      
      return {
        valid: false,
        error: '无法识别的文件格式',
      };
    } catch (e) {
      throw e;
    }
  }

  /**
   * 验证 SVG 文件
   * SVG 是 XML 文本格式，需要检查文本内容
   */
  private async validateSvg(file: File): Promise<{ valid: boolean; detectedMimeType?: string; error?: string }> {
    try {
      // 读取前 1KB 进行检查
      const slice = file.slice(0, 1024);
      const text = await slice.text();
      const trimmed = text.trim().toLowerCase();
      
      // 检查是否包含 SVG 签名
      for (const sig of SVG_SIGNATURES) {
        if (trimmed.startsWith(sig.toLowerCase())) {
          return { valid: true, detectedMimeType: 'image/svg+xml' };
        }
      }
      
      // 检查是否包含 svg 标签（可能有 BOM 或空白）
      if (trimmed.includes('<svg')) {
        return { valid: true, detectedMimeType: 'image/svg+xml' };
      }
      
      return {
        valid: false,
        error: '文件内容不是有效的 SVG',
      };
    } catch {
      return {
        valid: false,
        error: '无法读取 SVG 文件内容',
      };
    }
  }

  /**
   * 读取文件头部字节
   */
  private readFileHeader(file: File, bytes: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const slice = file.slice(0, bytes);
      
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
        } else {
          reject(new Error('FileReader result is not ArrayBuffer'));
        }
      };
      
      reader.onerror = () => {
        reject(reader.error);
      };
      
      reader.readAsArrayBuffer(slice);
    });
  }

  /**
   * 字节数组转 16 进制字符串
   */
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 获取文件扩展名（小写）
   */
  private getExtension(fileName: string): string {
    const parts = fileName.split('.');
    if (parts.length < 2) return '';
    return parts[parts.length - 1].toLowerCase();
  }

  /**
   * 检查扩展名与 MIME 类型的一致性
   */
  private checkExtensionMimeConsistency(extension: string, mimeType: string): boolean {
    // 常见的扩展名到 MIME 类型映射
    const extensionMimeMap: Record<string, string[]> = {
      'jpg': ['image/jpeg'],
      'jpeg': ['image/jpeg'],
      'png': ['image/png'],
      'gif': ['image/gif'],
      'webp': ['image/webp'],
      'svg': ['image/svg+xml'],
      'bmp': ['image/bmp'],
      'ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
      'pdf': ['application/pdf'],
      'doc': ['application/msword'],
      'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      'xls': ['application/vnd.ms-excel'],
      'xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      'ppt': ['application/vnd.ms-powerpoint'],
      'pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      'txt': ['text/plain'],
      'md': ['text/markdown', 'text/plain'],
      'markdown': ['text/markdown', 'text/plain'],
      'csv': ['text/csv', 'text/plain'],
      'rtf': ['text/rtf', 'application/rtf'],
      'json': ['application/json', 'text/plain'],
      'xml': ['application/xml', 'text/xml', 'text/plain'],
      'yaml': ['application/x-yaml', 'text/yaml', 'text/plain'],
      'yml': ['application/x-yaml', 'text/yaml', 'text/plain'],
      'zip': ['application/zip', 'application/x-zip-compressed'],
    };
    
    const allowedMimes = extensionMimeMap[extension];
    if (!allowedMimes) {
      // 未知扩展名，放行
      return true;
    }
    
    return allowedMimes.includes(mimeType);
  }

  /**
   * 检查是否为文本文件类型
   */
  private isTextFile(extension: string, mimeType: string): boolean {
    const textExtensions = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml'];
    const textMimeTypes = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml'];
    
    return textExtensions.includes(extension) || textMimeTypes.some(t => mimeType.startsWith(t.split('/')[0]));
  }

  /**
   * 检查是否为 Office 格式（ZIP 容器）
   */
  private isOfficeFormat(extension: string): boolean {
    return ['docx', 'xlsx', 'pptx'].includes(extension);
  }

  /**
   * 记录验证失败日志
   */
  private logValidationFailure(file: File, result: FileValidationResult): void {
    this.logger.warn('文件类型验证失败', {
      fileName: file.name,
      fileSize: file.size,
      declaredMimeType: result.declaredMimeType,
      extension: result.extension,
      errorCode: result.errorCode,
      error: result.error,
    });
    
    // 上报到 Sentry
    Sentry.captureMessage('文件类型验证失败', {
      level: 'warning',
      tags: {
        operation: 'file-type-validation',
        errorCode: result.errorCode || 'unknown',
      },
      extra: {
        fileName: file.name,
        fileSize: file.size,
        declaredMimeType: result.declaredMimeType,
        extension: result.extension,
        error: result.error,
      },
    });
  }

  /**
   * 获取允许的文件扩展名列表（用于 UI 显示）
   */
  getAllowedExtensions(): string[] {
    return Array.from(ALLOWED_EXTENSIONS);
  }

  /**
   * 获取 accept 属性值（用于 input[type="file"]）
   */
  getAcceptAttribute(): string {
    const extensions = Array.from(ALLOWED_EXTENSIONS).map(ext => `.${ext}`);
    const mimeTypes = Array.from(ALLOWED_MIME_TYPES);
    return [...extensions, ...mimeTypes].join(',');
  }
}
