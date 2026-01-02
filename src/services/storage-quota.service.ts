/**
 * 【v5.9】存储配额监控服务
 * 
 * 职责：
 * - 监控 localStorage 和 IndexedDB 使用情况
 * - 在接近配额时发出警告
 * - 提供清理建议和自动清理选项
 * 
 * @see docs/data-protection-plan.md 存储配额保护
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { STORAGE_QUOTA_CONFIG } from '../config/sync.config';
import * as Sentry from '@sentry/angular';

/**
 * 存储使用情况
 */
export interface StorageUsage {
  localStorage: {
    used: number;
    percentage: number;
    status: 'ok' | 'warning' | 'critical';
  };
  indexedDB: {
    used: number;
    quota: number;
    percentage: number;
    status: 'ok' | 'warning' | 'critical';
  };
  lastChecked: number;
}

/**
 * 配额告警事件
 */
export interface QuotaAlert {
  type: 'localStorage' | 'indexedDB';
  level: 'warning' | 'critical';
  usedBytes: number;
  thresholdBytes: number;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class StorageQuotaService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('StorageQuota');
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 当前存储使用情况 */
  readonly storageUsage = signal<StorageUsage | null>(null);
  
  /** 是否有配额警告 */
  readonly hasQuotaWarning = computed(() => {
    const usage = this.storageUsage();
    if (!usage) return false;
    return usage.localStorage.status !== 'ok' || usage.indexedDB.status !== 'ok';
  });
  
  /** 上次警告时间 */
  private lastWarningTime = 0;
  
  /** 检查定时器 */
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  
  constructor() {
    // 启动时检查
    if (STORAGE_QUOTA_CONFIG.CHECK_ON_STARTUP) {
      this.checkStorageQuota();
    }
    
    // 定期检查
    this.startPeriodicCheck();
    
    // 清理定时器
    this.destroyRef.onDestroy(() => {
      if (this.checkTimer) {
        clearInterval(this.checkTimer);
      }
    });
  }
  
  /**
   * 启动定期检查
   */
  private startPeriodicCheck(): void {
    this.checkTimer = setInterval(() => {
      this.checkStorageQuota();
    }, STORAGE_QUOTA_CONFIG.CHECK_INTERVAL);
  }
  
  /**
   * 检查存储配额
   */
  async checkStorageQuota(): Promise<StorageUsage> {
    try {
      const localStorageUsage = this.getLocalStorageUsage();
      const indexedDBUsage = await this.getIndexedDBUsage();
      
      const usage: StorageUsage = {
        localStorage: {
          used: localStorageUsage,
          percentage: this.calculateLocalStoragePercentage(localStorageUsage),
          status: this.getLocalStorageStatus(localStorageUsage)
        },
        indexedDB: {
          used: indexedDBUsage.used,
          quota: indexedDBUsage.quota,
          percentage: indexedDBUsage.quota > 0 
            ? (indexedDBUsage.used / indexedDBUsage.quota) * 100 
            : 0,
          status: this.getIndexedDBStatus(indexedDBUsage.used)
        },
        lastChecked: Date.now()
      };
      
      this.storageUsage.set(usage);
      
      // 检查是否需要发出警告
      this.checkAndWarn(usage);
      
      return usage;
    } catch (err) {
      this.logger.error('存储配额检查失败', err);
      return {
        localStorage: { used: 0, percentage: 0, status: 'ok' },
        indexedDB: { used: 0, quota: 0, percentage: 0, status: 'ok' },
        lastChecked: Date.now()
      };
    }
  }
  
  /**
   * 获取 localStorage 使用量（字节）
   */
  private getLocalStorageUsage(): number {
    if (typeof localStorage === 'undefined') return 0;
    
    let totalSize = 0;
    try {
      for (const key in localStorage) {
        if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
          const value = localStorage.getItem(key);
          if (value) {
            // 估算字符串占用（每个字符约 2 字节 in UTF-16）
            totalSize += (key.length + value.length) * 2;
          }
        }
      }
    } catch {
      // 忽略访问错误
    }
    
    return totalSize;
  }
  
  /**
   * 估算 localStorage 使用百分比
   * 注意：无法精确获取 localStorage 配额，假设 5MB
   */
  private calculateLocalStoragePercentage(usedBytes: number): number {
    const estimatedQuota = 5 * 1024 * 1024; // 5MB
    return (usedBytes / estimatedQuota) * 100;
  }
  
  /**
   * 获取 localStorage 状态
   */
  private getLocalStorageStatus(usedBytes: number): 'ok' | 'warning' | 'critical' {
    if (usedBytes >= STORAGE_QUOTA_CONFIG.LOCALSTORAGE_CRITICAL_THRESHOLD) {
      return 'critical';
    }
    if (usedBytes >= STORAGE_QUOTA_CONFIG.LOCALSTORAGE_WARNING_THRESHOLD) {
      return 'warning';
    }
    return 'ok';
  }
  
  /**
   * 获取 IndexedDB 使用量
   */
  private async getIndexedDBUsage(): Promise<{ used: number; quota: number }> {
    try {
      // 使用 Storage Manager API（现代浏览器支持）
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        return {
          used: estimate.usage ?? 0,
          quota: estimate.quota ?? 0
        };
      }
      
      // 回退：无法估计
      return { used: 0, quota: 0 };
    } catch {
      return { used: 0, quota: 0 };
    }
  }
  
  /**
   * 获取 IndexedDB 状态
   */
  private getIndexedDBStatus(usedBytes: number): 'ok' | 'warning' | 'critical' {
    if (usedBytes >= STORAGE_QUOTA_CONFIG.INDEXEDDB_CRITICAL_THRESHOLD) {
      return 'critical';
    }
    if (usedBytes >= STORAGE_QUOTA_CONFIG.INDEXEDDB_WARNING_THRESHOLD) {
      return 'warning';
    }
    return 'ok';
  }
  
  /**
   * 检查并发出警告
   */
  private checkAndWarn(usage: StorageUsage): void {
    const now = Date.now();
    
    // 冷却期检查
    if (now - this.lastWarningTime < STORAGE_QUOTA_CONFIG.WARNING_COOLDOWN) {
      return;
    }
    
    // localStorage 警告
    if (usage.localStorage.status === 'critical') {
      this.toast.error(
        '本地存储空间不足',
        `localStorage 使用量已达 ${this.formatBytes(usage.localStorage.used)}，请清理浏览器数据或导出项目后删除旧项目`
      );
      this.lastWarningTime = now;
      
      Sentry.captureMessage('localStorage 配额危机', {
        level: 'error',
        tags: { operation: 'checkStorageQuota' },
        extra: { usedBytes: usage.localStorage.used }
      });
    } else if (usage.localStorage.status === 'warning') {
      this.toast.warning(
        '本地存储空间紧张',
        `localStorage 使用量已达 ${this.formatBytes(usage.localStorage.used)}，建议清理旧数据`
      );
      this.lastWarningTime = now;
    }
    
    // IndexedDB 警告
    if (usage.indexedDB.status === 'critical') {
      this.toast.error(
        '浏览器存储空间不足',
        `IndexedDB 使用量已达 ${this.formatBytes(usage.indexedDB.used)}，请导出重要项目后清理缓存`
      );
      this.lastWarningTime = now;
      
      Sentry.captureMessage('IndexedDB 配额危机', {
        level: 'error',
        tags: { operation: 'checkStorageQuota' },
        extra: { usedBytes: usage.indexedDB.used, quota: usage.indexedDB.quota }
      });
    } else if (usage.indexedDB.status === 'warning') {
      this.toast.warning(
        '浏览器存储空间紧张',
        `IndexedDB 使用量已达 ${this.formatBytes(usage.indexedDB.used)}，建议清理旧缓存`
      );
      this.lastWarningTime = now;
    }
  }
  
  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  
  /**
   * 获取可清理的存储项
   */
  getCleanableItems(): Array<{ key: string; size: number; description: string }> {
    const items: Array<{ key: string; size: number; description: string }> = [];
    
    if (typeof localStorage === 'undefined') return items;
    
    try {
      for (const key in localStorage) {
        if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
          const value = localStorage.getItem(key);
          if (value) {
            const size = (key.length + value.length) * 2;
            
            // 识别可清理的项
            if (key.startsWith('nanoflow.') && size > 10 * 1024) { // 大于 10KB
              let description = '未知数据';
              
              if (key.includes('guest-data')) {
                description = '访客数据';
              } else if (key.includes('cache')) {
                description = '缓存数据';
              } else if (key.includes('undo')) {
                description = '撤销历史';
              } else if (key.includes('migration')) {
                description = '迁移快照';
              }
              
              items.push({ key, size, description });
            }
          }
        }
      }
    } catch {
      // 忽略访问错误
    }
    
    // 按大小排序
    return items.sort((a, b) => b.size - a.size);
  }
  
  /**
   * 清理指定的存储项
   */
  cleanupStorageItem(key: string): boolean {
    try {
      localStorage.removeItem(key);
      this.logger.info('已清理存储项', { key });
      return true;
    } catch (err) {
      this.logger.error('清理存储项失败', { key, error: err });
      return false;
    }
  }
  
  /**
   * 检查是否有足够的可用空间
   */
  async hasEnoughSpace(requiredBytes: number): Promise<boolean> {
    const usage = await this.checkStorageQuota();
    
    // 检查 localStorage
    const localStorageQuota = 5 * 1024 * 1024; // 估计 5MB
    const localStorageFree = localStorageQuota - usage.localStorage.used;
    
    if (localStorageFree < requiredBytes + STORAGE_QUOTA_CONFIG.MIN_FREE_SPACE) {
      return false;
    }
    
    // 检查 IndexedDB
    if (usage.indexedDB.quota > 0) {
      const indexedDBFree = usage.indexedDB.quota - usage.indexedDB.used;
      if (indexedDBFree < requiredBytes + STORAGE_QUOTA_CONFIG.MIN_FREE_SPACE) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 尝试写入前检查空间
   * 如果空间不足，返回 false 并显示警告
   */
  async ensureSpaceForWrite(estimatedBytes: number): Promise<boolean> {
    const hasSpace = await this.hasEnoughSpace(estimatedBytes);
    
    if (!hasSpace) {
      this.toast.error(
        '存储空间不足',
        '无法保存数据，请先清理浏览器存储或删除旧项目'
      );
      return false;
    }
    
    return true;
  }
}
