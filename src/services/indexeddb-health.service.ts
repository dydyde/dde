/**
 * IndexedDB 健康检查服务
 * 
 * 【v5.10 实现】策划案 4.10 节
 * 
 * 职责：
 * - 检测 IndexedDB 打开失败、损坏、版本错误等问题
 * - 检测数据静默损坏（JSON 解析失败、Schema 不匹配）
 * - 提供恢复策略：从云端恢复、导出残余数据
 * 
 * 检测方法：
 * - open-error: 数据库无法打开
 * - version-error: 版本号错误
 * - transaction-abort: 事务中断
 * - quota-error: 配额不足
 * - json-parse-error: 数据 JSON 解析失败
 * - schema-mismatch: 数据结构不匹配
 * - checksum-mismatch: 校验和不匹配（可选）
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import * as Sentry from '@sentry/angular';

// ========== 类型定义 ==========

/**
 * 数据库健康状态
 */
export type DatabaseHealthStatus = 
  | 'unknown'      // 未检测
  | 'healthy'      // 健康
  | 'degraded'     // 部分损坏
  | 'corrupted'    // 严重损坏
  | 'unavailable'; // 完全不可用

/**
 * 错误类型枚举
 */
export type DatabaseErrorType =
  | 'open-error'
  | 'version-error'
  | 'transaction-abort'
  | 'quota-error'
  | 'json-parse-error'
  | 'schema-mismatch'
  | 'checksum-mismatch'
  | 'security-error'
  | 'unknown-error';

/**
 * 完整性问题
 */
export interface IntegrityIssue {
  type: DatabaseErrorType;
  severity: 'warning' | 'error' | 'critical';
  entityType?: 'project' | 'task' | 'connection';
  entityId?: string;
  message: string;
  details?: Record<string, unknown>;
  canRecover: boolean;
}

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  status: DatabaseHealthStatus;
  healthy: boolean;
  timestamp: string;
  issues: IntegrityIssue[];
  canRecover: boolean;
  suggestedAction: 'none' | 'cloud-recovery' | 'export-remaining' | 'clear-and-restart';
  stats?: {
    projectCount: number;
    taskCount: number;
    connectionCount: number;
    corruptedRecords: number;
  };
}

/**
 * 恢复结果
 */
export interface RecoveryResult {
  success: boolean;
  action: string;
  recoveredRecords: number;
  remainingIssues: number;
  message: string;
}

/**
 * 健康检查恢复策略类型
 */
type HealthCorruptionStrategy = 'auto-cloud' | 'prompt-recovery' | 'notify-only';

/**
 * 健康检查配置
 */
export const INDEXEDDB_HEALTH_CONFIG = {
  /** 初始化时检测数据库健康 */
  CHECK_ON_INIT: true,
  
  /** 启动时数据完整性校验 */
  STARTUP_INTEGRITY_CHECK: {
    ENABLED: true,
    /** 抽样校验的记录数量 */
    SAMPLE_SIZE: 10,
    /** 校验 JSON 解析 */
    CHECK_JSON_PARSE: true,
    /** 校验必填字段 */
    CHECK_REQUIRED_FIELDS: true,
    /** 校验校验和（性能开销较大，默认关闭） */
    CHECK_CHECKSUM: false,
  },
  
  /** 损坏时的恢复策略 */
  ON_CORRUPTION: 'prompt-recovery' as HealthCorruptionStrategy,
  
  /** 定期健康检查间隔（毫秒）- 每 30 分钟 */
  PERIODIC_CHECK_INTERVAL: 30 * 60 * 1000,
  
  /** 任务必填字段 */
  REQUIRED_TASK_FIELDS: ['id', 'title'] as const,
  
  /** 项目必填字段 */
  REQUIRED_PROJECT_FIELDS: ['id', 'name'] as const,
  
  /** 连接必填字段 */
  REQUIRED_CONNECTION_FIELDS: ['id', 'source', 'target'] as const,
} as const;

/** 数据库配置（与 store-persistence.service.ts 保持一致） */
const DB_CONFIG = {
  name: 'nanoflow-store-cache',
  version: 1,
  stores: {
    projects: 'projects',
    tasks: 'tasks',
    connections: 'connections',
    meta: 'meta'
  }
} as const;

@Injectable({
  providedIn: 'root'
})
export class IndexedDBHealthService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('IndexedDBHealth');
  private readonly toast = inject(ToastService);
  
  /** 当前健康状态 */
  readonly healthStatus = signal<DatabaseHealthStatus>('unknown');
  
  /** 最后一次检查结果 */
  readonly lastCheckResult = signal<HealthCheckResult | null>(null);
  
  /** 是否正在检查中 */
  readonly isChecking = signal(false);
  
  /** 是否有未解决的问题 */
  readonly hasUnresolvedIssues = computed(() => {
    const result = this.lastCheckResult();
    return result !== null && !result.healthy;
  });
  
  /** 定期检查定时器 */
  private periodicCheckTimer: ReturnType<typeof setInterval> | null = null;
  
  constructor() {
    // 启动时执行健康检查
    if (INDEXEDDB_HEALTH_CONFIG.CHECK_ON_INIT) {
      this.performHealthCheck().catch(err => {
        this.logger.error('启动时健康检查失败', err);
      });
    }
  }
  
  /**
   * 执行完整健康检查
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    if (this.isChecking()) {
      const lastResult = this.lastCheckResult();
      if (lastResult) return lastResult;
      // 等待当前检查完成
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.performHealthCheck();
    }
    
    this.isChecking.set(true);
    const issues: IntegrityIssue[] = [];
    
    try {
      // 1. 检查数据库是否可以打开
      const openResult = await this.checkDatabaseOpen();
      if (!openResult.success) {
        issues.push({
          type: openResult.errorType,
          severity: 'critical',
          message: openResult.message,
          canRecover: openResult.canRecover,
          details: { errorName: openResult.errorName }
        });
        
        return this.buildResult('unavailable', issues);
      }
      
      // 2. 检查数据完整性（抽样）
      if (INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK.ENABLED) {
        const integrityIssues = await this.checkDataIntegrity(openResult.db!);
        issues.push(...integrityIssues);
      }
      
      // 3. 确定状态
      const status = this.determineStatus(issues);
      return this.buildResult(status, issues);
      
    } catch (error) {
      this.logger.error('健康检查过程发生错误', error);
      issues.push({
        type: 'unknown-error',
        severity: 'error',
        message: `健康检查失败: ${error instanceof Error ? error.message : String(error)}`,
        canRecover: true
      });
      
      return this.buildResult('degraded', issues);
    } finally {
      this.isChecking.set(false);
    }
  }
  
  /**
   * 检查数据库是否可以打开
   */
  private async checkDatabaseOpen(): Promise<{
    success: boolean;
    db?: IDBDatabase;
    errorType: DatabaseErrorType;
    errorName?: string;
    message: string;
    canRecover: boolean;
  }> {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve({
          success: false,
          errorType: 'open-error',
          message: 'IndexedDB API 不可用',
          canRecover: false
        });
        return;
      }
      
      try {
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
        
        request.onerror = () => {
          const error = request.error;
          const errorName = error?.name ?? 'UnknownError';
          
          let errorType: DatabaseErrorType = 'open-error';
          let canRecover = true;
          
          if (errorName === 'QuotaExceededError') {
            errorType = 'quota-error';
          } else if (errorName === 'SecurityError') {
            errorType = 'security-error';
            canRecover = false;
          } else if (errorName === 'VersionError') {
            errorType = 'version-error';
          }
          
          resolve({
            success: false,
            errorType,
            errorName,
            message: `数据库打开失败: ${error?.message ?? errorName}`,
            canRecover
          });
        };
        
        request.onsuccess = () => {
          resolve({
            success: true,
            db: request.result,
            errorType: 'open-error', // not used when success
            message: 'OK',
            canRecover: true
          });
        };
        
        request.onblocked = () => {
          resolve({
            success: false,
            errorType: 'open-error',
            errorName: 'BlockedError',
            message: '数据库被其他连接阻塞，请关闭其他标签页后重试',
            canRecover: true
          });
        };
        
        // 超时处理
        setTimeout(() => {
          resolve({
            success: false,
            errorType: 'open-error',
            errorName: 'TimeoutError',
            message: '数据库打开超时',
            canRecover: true
          });
        }, 10000);
        
      } catch (error) {
        resolve({
          success: false,
          errorType: 'open-error',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: `数据库打开异常: ${error instanceof Error ? error.message : String(error)}`,
          canRecover: true
        });
      }
    });
  }
  
  /**
   * 检查数据完整性
   */
  private async checkDataIntegrity(db: IDBDatabase): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const config = INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK;
    
    try {
      // 检查 projects store
      const projectIssues = await this.checkStoreIntegrity(
        db,
        DB_CONFIG.stores.projects,
        'project',
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_PROJECT_FIELDS,
        config.SAMPLE_SIZE
      );
      issues.push(...projectIssues);
      
      // 检查 tasks store
      const taskIssues = await this.checkStoreIntegrity(
        db,
        DB_CONFIG.stores.tasks,
        'task',
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_TASK_FIELDS,
        config.SAMPLE_SIZE
      );
      issues.push(...taskIssues);
      
      // 检查 connections store
      const connectionIssues = await this.checkStoreIntegrity(
        db,
        DB_CONFIG.stores.connections,
        'connection',
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_CONNECTION_FIELDS,
        config.SAMPLE_SIZE
      );
      issues.push(...connectionIssues);
      
    } catch (error) {
      issues.push({
        type: 'transaction-abort',
        severity: 'error',
        message: `数据完整性检查失败: ${error instanceof Error ? error.message : String(error)}`,
        canRecover: true
      });
    }
    
    return issues;
  }
  
  /**
   * 检查单个对象存储的完整性
   */
  private async checkStoreIntegrity(
    db: IDBDatabase,
    storeName: string,
    entityType: 'project' | 'task' | 'connection',
    requiredFields: readonly string[],
    sampleSize: number
  ): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const config = INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK;
    
    return new Promise((resolve) => {
      try {
        if (!db.objectStoreNames.contains(storeName)) {
          // 对象存储不存在不算错误，可能是空数据库
          resolve([]);
          return;
        }
        
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.openCursor();
        
        let checkedCount = 0;
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
          
          if (!cursor || checkedCount >= sampleSize) {
            resolve(issues);
            return;
          }
          
          const value = cursor.value;
          checkedCount++;
          
          // 检查 JSON 可解析性（值已经是对象，检查是否有效）
          if (config.CHECK_JSON_PARSE) {
            try {
              // 尝试序列化再解析，检测循环引用等问题
              JSON.parse(JSON.stringify(value));
            } catch (err) {
              issues.push({
                type: 'json-parse-error',
                severity: 'error',
                entityType,
                entityId: value?.id,
                message: `${entityType} 数据序列化失败`,
                canRecover: false,
                details: { error: String(err) }
              });
            }
          }
          
          // 检查必填字段
          if (config.CHECK_REQUIRED_FIELDS) {
            for (const field of requiredFields) {
              if (value[field] === undefined || value[field] === null) {
                issues.push({
                  type: 'schema-mismatch',
                  severity: 'warning',
                  entityType,
                  entityId: value?.id,
                  message: `${entityType} 缺少必填字段 ${field}`,
                  canRecover: true,
                  details: { missingField: field }
                });
              }
            }
          }
          
          // 检查 ID 格式（UUID）
          if (value.id && typeof value.id === 'string') {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(value.id)) {
              issues.push({
                type: 'schema-mismatch',
                severity: 'warning',
                entityType,
                entityId: value.id,
                message: `${entityType} ID 格式无效`,
                canRecover: true,
                details: { invalidId: value.id }
              });
            }
          }
          
          cursor.continue();
        };
        
        request.onerror = () => {
          issues.push({
            type: 'transaction-abort',
            severity: 'error',
            message: `读取 ${storeName} 失败: ${request.error?.message}`,
            canRecover: true
          });
          resolve(issues);
        };
        
        transaction.onerror = () => {
          issues.push({
            type: 'transaction-abort',
            severity: 'error',
            message: `${storeName} 事务失败: ${transaction.error?.message}`,
            canRecover: true
          });
          resolve(issues);
        };
        
      } catch (error) {
        issues.push({
          type: 'unknown-error',
          severity: 'error',
          message: `检查 ${storeName} 时发生异常: ${error instanceof Error ? error.message : String(error)}`,
          canRecover: true
        });
        resolve(issues);
      }
    });
  }
  
  /**
   * 根据问题列表确定整体状态
   */
  private determineStatus(issues: IntegrityIssue[]): DatabaseHealthStatus {
    if (issues.length === 0) {
      return 'healthy';
    }
    
    const hasCritical = issues.some(i => i.severity === 'critical');
    const hasError = issues.some(i => i.severity === 'error');
    
    if (hasCritical) {
      return 'corrupted';
    } else if (hasError) {
      return 'degraded';
    } else {
      return 'healthy'; // 只有 warning 级别的问题
    }
  }
  
  /**
   * 构建检查结果
   */
  private buildResult(status: DatabaseHealthStatus, issues: IntegrityIssue[]): HealthCheckResult {
    const result: HealthCheckResult = {
      status,
      healthy: status === 'healthy',
      timestamp: new Date().toISOString(),
      issues,
      canRecover: issues.every(i => i.canRecover),
      suggestedAction: this.determineSuggestedAction(status, issues)
    };
    
    // 更新信号
    this.healthStatus.set(status);
    this.lastCheckResult.set(result);
    
    // 记录日志
    if (!result.healthy) {
      this.logger.warn('IndexedDB 健康检查发现问题', {
        status,
        issueCount: issues.length,
        suggestedAction: result.suggestedAction
      });
      
      // 上报 Sentry
      Sentry.captureMessage('IndexedDB health check failed', {
        level: status === 'corrupted' ? 'error' : 'warning',
        tags: {
          healthStatus: status,
          issueCount: String(issues.length)
        },
        extra: {
          issues: issues.slice(0, 10) // 最多上报 10 个问题
        }
      });
    } else {
      this.logger.debug('IndexedDB 健康检查通过');
    }
    
    return result;
  }
  
  /**
   * 确定建议的操作
   */
  private determineSuggestedAction(
    status: DatabaseHealthStatus,
    issues: IntegrityIssue[]
  ): HealthCheckResult['suggestedAction'] {
    switch (status) {
      case 'healthy':
        return 'none';
        
      case 'unavailable':
        // 数据库完全不可用
        if (issues.some(i => i.type === 'security-error')) {
          return 'none'; // 安全错误无法恢复
        }
        return 'clear-and-restart';
        
      case 'corrupted':
        // 严重损坏
        if (issues.every(i => i.canRecover)) {
          return 'cloud-recovery';
        }
        return 'export-remaining';
        
      case 'degraded':
        // 部分损坏
        return 'cloud-recovery';
        
      default:
        return 'none';
    }
  }
  
  /**
   * 尝试从云端恢复数据
   * 注意：实际恢复逻辑需要配合 SimpleSyncService 实现
   */
  async attemptCloudRecovery(): Promise<RecoveryResult> {
    this.logger.info('开始从云端恢复数据');
    
    try {
      // 清除本地损坏数据
      await this.clearLocalDatabase();
      
      // 实际的云端恢复需要触发重新同步
      // 这里只做标记，由外部服务处理
      return {
        success: true,
        action: 'cloud-recovery-initiated',
        recoveredRecords: 0,
        remainingIssues: 0,
        message: '已清除本地数据，请刷新页面重新同步'
      };
    } catch (error) {
      return {
        success: false,
        action: 'cloud-recovery-failed',
        recoveredRecords: 0,
        remainingIssues: this.lastCheckResult()?.issues.length ?? 0,
        message: `恢复失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * 清除本地数据库
   */
  async clearLocalDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_CONFIG.name);
      
      request.onsuccess = () => {
        this.logger.info('本地数据库已清除');
        this.healthStatus.set('unknown');
        this.lastCheckResult.set(null);
        resolve();
      };
      
      request.onerror = () => {
        reject(new Error(`清除数据库失败: ${request.error?.message}`));
      };
      
      request.onblocked = () => {
        reject(new Error('清除数据库被阻塞，请关闭其他标签页'));
      };
    });
  }
  
  /**
   * 导出残余数据（尽可能恢复）
   */
  async exportRemainingData(): Promise<{
    success: boolean;
    data: unknown;
    corruptedIds: string[];
  }> {
    const result = {
      success: false,
      data: {} as Record<string, unknown[]>,
      corruptedIds: [] as string[]
    };
    
    try {
      const openResult = await this.checkDatabaseOpen();
      if (!openResult.success || !openResult.db) {
        return result;
      }
      
      const db = openResult.db;
      
      // 尝试导出每个 store
      for (const storeName of [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections]) {
        try {
          const records = await this.exportStore(db, storeName);
          result.data[storeName] = records.valid;
          result.corruptedIds.push(...records.corruptedIds);
        } catch {
          this.logger.warn(`导出 ${storeName} 失败`);
        }
      }
      
      result.success = true;
      return result;
      
    } catch (error) {
      this.logger.error('导出残余数据失败', error);
      return result;
    }
  }
  
  /**
   * 导出单个 store 的数据
   */
  private async exportStore(
    db: IDBDatabase,
    storeName: string
  ): Promise<{ valid: unknown[]; corruptedIds: string[] }> {
    return new Promise((resolve) => {
      const valid: unknown[] = [];
      const corruptedIds: string[] = [];
      
      if (!db.objectStoreNames.contains(storeName)) {
        resolve({ valid, corruptedIds });
        return;
      }
      
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.openCursor();
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
        
        if (!cursor) {
          resolve({ valid, corruptedIds });
          return;
        }
        
        try {
          const value = cursor.value;
          // 验证数据可序列化
          JSON.parse(JSON.stringify(value));
          valid.push(value);
        } catch {
          corruptedIds.push(cursor.key as string);
        }
        
        cursor.continue();
      };
      
      request.onerror = () => {
        resolve({ valid, corruptedIds });
      };
    });
  }
  
  /**
   * 启动定期健康检查
   */
  startPeriodicCheck(): void {
    if (this.periodicCheckTimer) return;
    
    this.periodicCheckTimer = setInterval(async () => {
      const result = await this.performHealthCheck();
      
      if (!result.healthy) {
        // 显示用户提示
        this.toast.warning(
          '存储健康警告',
          '检测到本地存储问题，建议刷新页面同步数据',
          { duration: 10000 }
        );
      }
    }, INDEXEDDB_HEALTH_CONFIG.PERIODIC_CHECK_INTERVAL);
    
    this.logger.debug('定期健康检查已启动');
  }
  
  /**
   * 停止定期健康检查
   */
  stopPeriodicCheck(): void {
    if (this.periodicCheckTimer) {
      clearInterval(this.periodicCheckTimer);
      this.periodicCheckTimer = null;
      this.logger.debug('定期健康检查已停止');
    }
  }
  
  /**
   * 检查是否需要恢复并提示用户
   */
  async checkAndPromptRecovery(): Promise<boolean> {
    const result = await this.performHealthCheck();
    
    if (result.healthy) {
      return false;
    }
    
    // 根据配置决定行为
    switch (INDEXEDDB_HEALTH_CONFIG.ON_CORRUPTION) {
      case 'auto-cloud':
        // 自动从云端恢复
        await this.attemptCloudRecovery();
        return true;
        
      case 'prompt-recovery':
        // 提示用户
        this.toast.error(
          '本地数据问题',
          result.suggestedAction === 'cloud-recovery' 
            ? '检测到本地数据损坏，点击刷新从云端恢复'
            : '检测到严重数据问题，建议导出现有数据',
          { 
            duration: 0, // 持续显示
            action: {
              label: result.suggestedAction === 'cloud-recovery' ? '刷新恢复' : '导出数据',
              onClick: async () => {
                if (result.suggestedAction === 'cloud-recovery') {
                  await this.attemptCloudRecovery();
                  window.location.reload();
                } else {
                  const exported = await this.exportRemainingData();
                  // 下载为 JSON
                  const blob = new Blob([JSON.stringify(exported.data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `nanoflow-recovery-${new Date().toISOString()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }
              }
            }
          }
        );
        return true;
        
      case 'notify-only':
        // 仅通知
        this.toast.warning(
          '存储警告',
          '检测到本地存储问题，数据可能不完整'
        );
        return true;
        
      default:
        return false;
    }
  }
}
