/**
 * 备份恢复服务
 * 
 * 功能：
 * 1. 列出可用的恢复点
 * 2. 预览恢复内容
 * 3. 执行恢复操作
 * 
 * 位置: src/services/recovery.service.ts
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

// ===========================================
// 类型定义
// ===========================================

/** 恢复点信息 */
export interface RecoveryPoint {
  id: string;
  type: 'full' | 'incremental';
  timestamp: string;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  size: number;
  encrypted: boolean;
  validationPassed: boolean;
}

/** 恢复预览信息 */
export interface RecoveryPreview {
  backupId: string;
  type: 'full' | 'incremental';
  timestamp: string;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  projects: Array<{ id: string; name: string }>;
}

/** 恢复选项 */
export interface RecoveryOptions {
  /** 恢复模式：replace=替换现有数据，merge=合并 */
  mode: 'replace' | 'merge';
  /** 恢复范围：all=全部，project=单个项目 */
  scope: 'all' | 'project';
  /** 如果 scope=project，指定项目 ID */
  projectId?: string;
  /** 是否在恢复前创建快照 */
  createSnapshot?: boolean;
}

/** 恢复结果 */
export interface RecoveryResult {
  success: boolean;
  restoreId: string;
  projectsRestored: number;
  tasksRestored: number;
  connectionsRestored: number;
  preRestoreSnapshotId?: string;
  durationMs: number;
  error?: string;
}

/** 恢复状态 */
export type RecoveryStatus = 'idle' | 'loading' | 'previewing' | 'restoring' | 'success' | 'error';

// ===========================================
// 配置
// ===========================================

export const RECOVERY_CONFIG = {
  /** Edge Function URL 路径 */
  FUNCTION_PATH: '/functions/v1/backup-restore',
  /** 请求超时（毫秒） */
  REQUEST_TIMEOUT: 5 * 60 * 1000, // 5 分钟
  /** 默认恢复选项 */
  DEFAULT_OPTIONS: {
    mode: 'replace' as const,
    scope: 'all' as const,
    createSnapshot: true,
  },
} as const;

// ===========================================
// 服务实现
// ===========================================

@Injectable({
  providedIn: 'root',
})
export class RecoveryService {
  private readonly supabaseClient = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService);

  // ===========================================
  // 状态
  // ===========================================

  /** 恢复点列表 */
  readonly recoveryPoints = signal<RecoveryPoint[]>([]);

  /** 当前状态 */
  readonly status = signal<RecoveryStatus>('idle');

  /** 错误信息 */
  readonly error = signal<string | null>(null);

  /** 最后一次恢复结果 */
  readonly lastResult = signal<RecoveryResult | null>(null);

  /** 当前预览 */
  readonly currentPreview = signal<RecoveryPreview | null>(null);

  /** 是否正在加载 */
  readonly isLoading = computed(() => 
    this.status() === 'loading' || 
    this.status() === 'previewing' || 
    this.status() === 'restoring'
  );

  /** 是否可以执行恢复 */
  readonly canRestore = computed(() => 
    this.status() === 'idle' && 
    !!this.auth.currentUserId()
  );

  // ===========================================
  // 公共方法
  // ===========================================

  /**
   * 获取可用的恢复点列表
   */
  async listRecoveryPoints(): Promise<RecoveryPoint[]> {
    const userId = this.auth.currentUserId();
    if (!userId) {
      this.error.set('用户未登录');
      return [];
    }

    this.status.set('loading');
    this.error.set(null);

    try {
      const response = await this.callFunction<{ recoveryPoints: RecoveryPoint[] }>({
        action: 'list',
        userId,
      });

      if (response.recoveryPoints) {
        this.recoveryPoints.set(response.recoveryPoints);
        this.logger.info('RecoveryService', `Loaded ${response.recoveryPoints.length} recovery points`);
      }

      this.status.set('idle');
      return response.recoveryPoints || [];

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '获取恢复点失败';
      this.error.set(errorMsg);
      this.status.set('error');
      this.logger.error('RecoveryService', 'listRecoveryPoints failed', err);
      return [];
    }
  }

  /**
   * 预览恢复内容
   */
  async previewRecovery(backupId: string): Promise<RecoveryPreview | null> {
    const userId = this.auth.currentUserId();
    if (!userId) {
      this.error.set('用户未登录');
      return null;
    }

    this.status.set('previewing');
    this.error.set(null);
    this.currentPreview.set(null);

    try {
      const response = await this.callFunction<RecoveryPreview>({
        action: 'preview',
        backupId,
        userId,
      });

      this.currentPreview.set(response);
      this.status.set('idle');
      this.logger.info('RecoveryService', 'Preview loaded', { backupId });
      return response;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '预览恢复内容失败';
      this.error.set(errorMsg);
      this.status.set('error');
      this.logger.error('RecoveryService', 'previewRecovery failed', err);
      return null;
    }
  }

  /**
   * 执行恢复操作
   */
  async executeRecovery(backupId: string, options?: Partial<RecoveryOptions>): Promise<RecoveryResult | null> {
    const userId = this.auth.currentUserId();
    if (!userId) {
      this.error.set('用户未登录');
      return null;
    }

    const finalOptions: RecoveryOptions = {
      ...RECOVERY_CONFIG.DEFAULT_OPTIONS,
      ...options,
    };

    this.status.set('restoring');
    this.error.set(null);
    this.lastResult.set(null);

    // 显示确认 Toast
    this.toast.warning('正在恢复数据，请勿关闭页面...');

    try {
      const response = await this.callFunction<RecoveryResult>({
        action: 'restore',
        backupId,
        userId,
        options: finalOptions,
      });

      this.lastResult.set(response);

      if (response.success) {
        this.status.set('success');
        this.toast.success(`恢复完成：${response.projectsRestored} 个项目，${response.tasksRestored} 个任务`);
        this.logger.info('RecoveryService', 'Recovery completed', response);

        // 通知用户刷新页面
        setTimeout(() => {
          if (confirm('数据恢复完成，是否刷新页面以加载恢复的数据？')) {
            window.location.reload();
          }
        }, 500);
      } else {
        this.status.set('error');
        this.error.set(response.error || '恢复失败');
        this.toast.error(`恢复失败：${response.error}`);
      }

      return response;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '执行恢复操作失败';
      this.error.set(errorMsg);
      this.status.set('error');
      this.toast.error(`恢复失败：${errorMsg}`);
      this.logger.error('RecoveryService', 'executeRecovery failed', err);
      return null;
    }
  }

  /**
   * 获取备份统计信息
   */
  async getBackupStats(): Promise<{
    totalBackups: number;
    completedBackups: number;
    failedBackups: number;
    totalSizeBytes: number;
    latestFullBackup: string | null;
    latestIncrementalBackup: string | null;
  } | null> {
    try {
      if (!this.supabaseClient.isConfigured) {
        return null;
      }

      const { data, error } = await this.supabaseClient.client().rpc('get_backup_stats');

      if (error) {
        this.logger.error('RecoveryService', 'getBackupStats failed', error);
        return null;
      }

      return data?.[0] || null;

    } catch (err) {
      this.logger.error('RecoveryService', 'getBackupStats exception', err);
      return null;
    }
  }

  /**
   * 格式化文件大小
   */
  formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化时间戳
   */
  formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * 获取备份类型显示文本
   */
  getTypeLabel(type: 'full' | 'incremental'): string {
    return type === 'full' ? '全量备份' : '增量备份';
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.status.set('idle');
    this.error.set(null);
    this.currentPreview.set(null);
  }

  // ===========================================
  // 私有方法
  // ===========================================

  private async callFunction<T>(body: Record<string, unknown>): Promise<T> {
    if (!this.supabaseClient.isConfigured) {
      throw new Error('Supabase 客户端未初始化');
    }

    const { data, error } = await this.supabaseClient.client().functions.invoke('backup-restore', {
      body: JSON.stringify(body),
    });

    if (error) {
      throw new Error(error.message || '调用备份恢复服务失败');
    }

    return data as T;
  }
}
