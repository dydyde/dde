/**
 * 时钟同步服务
 * 
 * 【v5.10 实现】策划案 4.11 节
 * 
 * 职责：
 * - 检测客户端与服务端的时钟偏移
 * - 在 LWW（Last-Write-Wins）冲突解决时提供校正
 * - 警告用户时钟偏移过大可能导致的数据问题
 * 
 * 问题背景：
 * - LWW 策略依赖 updatedAt 时间戳比较
 * - 如果用户手动调整系统时钟（回拨），可能导致新数据被旧数据覆盖
 * - 需要检测并警告时钟偏移，可选择性使用服务端时间
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SupabaseClientService } from './supabase-client.service';
import * as Sentry from '@sentry/angular';

// ========== 类型定义 ==========

/**
 * 时钟偏移状态
 */
export type ClockDriftStatus =
  | 'unknown'     // 未检测
  | 'synced'      // 同步正常
  | 'warning'     // 偏移较大但可接受
  | 'error';      // 偏移过大，可能影响数据

/**
 * 时钟同步结果
 */
export interface ClockSyncResult {
  status: ClockDriftStatus;
  /** 偏移量（毫秒）- 正数表示客户端快，负数表示客户端慢 */
  driftMs: number;
  /** 服务端时间戳 */
  serverTime: Date;
  /** 客户端时间戳（请求时） */
  clientTime: Date;
  /** 网络往返时间（毫秒） */
  rttMs: number;
  /** 检测时间 */
  checkedAt: Date;
  /** 是否可信（网络延迟过大时不可信） */
  reliable: boolean;
}

/**
 * 时钟同步配置
 */
export const CLOCK_SYNC_CONFIG = {
  /** 是否启用服务端时间校正 */
  USE_SERVER_TIME: true,
  
  /** 时钟偏移警告阈值（毫秒）- 1 分钟 */
  CLOCK_DRIFT_WARNING_THRESHOLD: 60 * 1000,
  
  /** 时钟偏移错误阈值（毫秒）- 5 分钟 */
  CLOCK_DRIFT_ERROR_THRESHOLD: 5 * 60 * 1000,
  
  /** 网络延迟过大阈值（毫秒）- 超过此值认为检测不可信 */
  MAX_RELIABLE_RTT: 5000,
  
  /** 定期检测间隔（毫秒）- 每 10 分钟 */
  CHECK_INTERVAL: 10 * 60 * 1000,
  
  /** 启动时自动检测 */
  CHECK_ON_INIT: true,
  
  /** 同步操作前检测（如果上次检测超过此时间） */
  CHECK_BEFORE_SYNC_INTERVAL: 5 * 60 * 1000,
  
  /** 缓存有效期（毫秒）*/
  CACHE_TTL: 5 * 60 * 1000,
} as const;

@Injectable({
  providedIn: 'root'
})
export class ClockSyncService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ClockSync');
  private readonly toast = inject(ToastService);
  private readonly supabase = inject(SupabaseClientService);
  
  /** 当前时钟偏移状态 */
  readonly driftStatus = signal<ClockDriftStatus>('unknown');
  
  /** 最后一次同步结果 */
  readonly lastSyncResult = signal<ClockSyncResult | null>(null);
  
  /** 当前偏移量（毫秒） */
  readonly currentDriftMs = computed(() => this.lastSyncResult()?.driftMs ?? 0);
  
  /** 是否有时钟问题 */
  readonly hasClockIssue = computed(() => {
    const status = this.driftStatus();
    return status === 'warning' || status === 'error';
  });
  
  /** 定期检测定时器 */
  private periodicCheckTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 是否正在检测 */
  private isChecking = false;
  
  constructor() {
    // 启动时检测
    if (CLOCK_SYNC_CONFIG.CHECK_ON_INIT) {
      // 延迟执行，避免阻塞启动
      setTimeout(() => {
        this.checkClockDrift().catch(err => {
          this.logger.debug('启动时时钟检测失败', err);
        });
      }, 2000);
    }
  }
  
  /**
   * 检测时钟偏移
   * 
   * 通过向 Supabase 发送一个简单请求，比较服务端返回的时间
   */
  async checkClockDrift(): Promise<ClockSyncResult> {
    if (this.isChecking) {
      const last = this.lastSyncResult();
      if (last) return last;
    }
    
    this.isChecking = true;
    
    try {
      const clientTimeStart = new Date();
      
      // 使用 RPC 调用获取服务端时间
      // 如果 RPC 不可用，fallback 到简单的 select
      let serverTime: Date;
      let clientTimeEnd: Date;
      
      try {
        const { data, error } = await this.supabase.client()
          .rpc('get_server_time');
        
        clientTimeEnd = new Date();
        
        if (error || !data) {
          // Fallback: 尝试简单查询
          const fallbackResult = await this.fallbackTimeCheck();
          if (fallbackResult) {
            return fallbackResult;
          }
          throw new Error(error?.message ?? '无法获取服务端时间');
        }
        
        serverTime = new Date(data);
      } catch {
        // Fallback: 使用 HTTP 响应头中的 Date
        const fallbackResult = await this.fallbackTimeCheck();
        if (fallbackResult) {
          return fallbackResult;
        }
        throw new Error('无法获取服务端时间');
      }
      
      // 计算往返时间和偏移
      const rttMs = clientTimeEnd.getTime() - clientTimeStart.getTime();
      const estimatedServerTimeAtRequest = new Date(
        serverTime.getTime() - rttMs / 2
      );
      const driftMs = clientTimeStart.getTime() - estimatedServerTimeAtRequest.getTime();
      
      // 确定状态
      const absDrift = Math.abs(driftMs);
      let status: ClockDriftStatus;
      
      if (absDrift < CLOCK_SYNC_CONFIG.CLOCK_DRIFT_WARNING_THRESHOLD) {
        status = 'synced';
      } else if (absDrift < CLOCK_SYNC_CONFIG.CLOCK_DRIFT_ERROR_THRESHOLD) {
        status = 'warning';
      } else {
        status = 'error';
      }
      
      const result: ClockSyncResult = {
        status,
        driftMs,
        serverTime,
        clientTime: clientTimeStart,
        rttMs,
        checkedAt: new Date(),
        reliable: rttMs < CLOCK_SYNC_CONFIG.MAX_RELIABLE_RTT
      };
      
      // 更新状态
      this.driftStatus.set(status);
      this.lastSyncResult.set(result);
      
      // 记录日志
      if (status !== 'synced') {
        this.logger.warn('检测到时钟偏移', {
          driftMs,
          status,
          reliable: result.reliable
        });
        
        if (status === 'error') {
          // 上报 Sentry
          Sentry.captureMessage('Significant clock drift detected', {
            level: 'warning',
            tags: { driftMs: String(driftMs) },
            extra: { result }
          });
          
          // 提示用户
          this.showClockWarning(driftMs);
        }
      } else {
        this.logger.debug('时钟同步正常', { driftMs });
      }
      
      return result;
      
    } catch (error) {
      this.logger.debug('时钟检测失败', error);
      
      // 返回未知状态
      const result: ClockSyncResult = {
        status: 'unknown',
        driftMs: 0,
        serverTime: new Date(),
        clientTime: new Date(),
        rttMs: 0,
        checkedAt: new Date(),
        reliable: false
      };
      
      this.lastSyncResult.set(result);
      return result;
      
    } finally {
      this.isChecking = false;
    }
  }
  
  /**
   * Fallback 时间检测方法
   * 使用简单的数据库查询获取服务端时间
   */
  private async fallbackTimeCheck(): Promise<ClockSyncResult | null> {
    try {
      const clientTimeStart = new Date();
      
      // 使用 from().select() 获取当前时间
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('id')
        .limit(1);
      
      const clientTimeEnd = new Date();
      
      // 即使查询失败也没关系，我们主要用往返时间
      if (error) {
        this.logger.debug('Fallback 时间检测：查询失败但仍可估算', error);
      }
      
      // 由于无法直接获取服务端时间，只能返回一个基础结果
      // 这个 fallback 主要用于检测网络延迟是否正常
      const rttMs = clientTimeEnd.getTime() - clientTimeStart.getTime();
      
      // 如果有数据说明连接正常，假设时钟同步
      // 这不是准确的检测，但比完全没有检测好
      const result: ClockSyncResult = {
        status: 'unknown',
        driftMs: 0,
        serverTime: new Date(), // 无法获取真实值
        clientTime: clientTimeStart,
        rttMs,
        checkedAt: new Date(),
        reliable: false // 标记为不可信
      };
      
      // 如果连接成功但无法获取时间，只记录 RTT
      if (data !== null) {
        this.logger.debug('Fallback 时间检测完成', { rttMs, dataReceived: true });
      }
      
      return result;
      
    } catch {
      return null;
    }
  }
  
  /**
   * 显示时钟警告
   */
  private showClockWarning(driftMs: number): void {
    const driftSeconds = Math.round(Math.abs(driftMs) / 1000);
    const direction = driftMs > 0 ? '快' : '慢';
    
    this.toast.warning(
      '系统时钟偏移',
      `您的设备时间比服务器${direction}了约 ${driftSeconds} 秒，可能影响数据同步`,
      { 
        duration: 10000,
        action: {
          label: '了解更多',
          onClick: () => {
            // 可以打开帮助页面或显示更多信息
            this.toast.info(
              '时钟偏移说明',
              '请检查设备的日期和时间设置，确保已启用"自动设置时间"'
            );
          }
        }
      }
    );
  }
  
  /**
   * 校正时间戳
   * 在需要发送到服务端的时间戳上应用偏移校正
   * 
   * @param timestamp 原始时间戳（毫秒或 ISO 字符串）
   * @returns 校正后的 ISO 字符串
   */
  correctTimestamp(timestamp: number | string | Date): string {
    if (!CLOCK_SYNC_CONFIG.USE_SERVER_TIME) {
      // 不使用服务端时间校正
      return this.toISOString(timestamp);
    }
    
    const result = this.lastSyncResult();
    if (!result || !result.reliable || result.status === 'unknown') {
      // 无可靠的偏移数据
      return this.toISOString(timestamp);
    }
    
    // 应用偏移校正
    const originalMs = this.toMilliseconds(timestamp);
    const correctedMs = originalMs - result.driftMs;
    
    return new Date(correctedMs).toISOString();
  }
  
  /**
   * 获取当前服务端时间（估算）
   */
  getEstimatedServerTime(): Date {
    const result = this.lastSyncResult();
    if (!result || !result.reliable) {
      return new Date();
    }
    
    // 基于上次同步结果和已过去的时间估算
    const elapsed = Date.now() - result.checkedAt.getTime();
    const estimatedServerMs = result.serverTime.getTime() + elapsed;
    
    return new Date(estimatedServerMs);
  }
  
  /**
   * 检查是否需要重新同步时钟
   */
  needsResync(): boolean {
    const result = this.lastSyncResult();
    if (!result) return true;
    
    const elapsed = Date.now() - result.checkedAt.getTime();
    return elapsed > CLOCK_SYNC_CONFIG.CACHE_TTL;
  }
  
  /**
   * 确保时钟已同步（在同步操作前调用）
   */
  async ensureSynced(): Promise<ClockSyncResult> {
    const result = this.lastSyncResult();
    
    if (result && !this.needsResync()) {
      return result;
    }
    
    return this.checkClockDrift();
  }
  
  /**
   * 启动定期时钟检测
   */
  startPeriodicCheck(): void {
    if (this.periodicCheckTimer) return;
    
    this.periodicCheckTimer = setInterval(() => {
      this.checkClockDrift().catch(err => {
        this.logger.debug('定期时钟检测失败', err);
      });
    }, CLOCK_SYNC_CONFIG.CHECK_INTERVAL);
    
    this.logger.debug('定期时钟检测已启动');
  }
  
  /**
   * 停止定期时钟检测
   */
  stopPeriodicCheck(): void {
    if (this.periodicCheckTimer) {
      clearInterval(this.periodicCheckTimer);
      this.periodicCheckTimer = null;
      this.logger.debug('定期时钟检测已停止');
    }
  }
  
  /**
   * 比较两个时间戳，考虑时钟偏移
   * 
   * @param local 本地时间戳
   * @param remote 远程时间戳
   * @returns 正数表示 local 更新，负数表示 remote 更新，0 表示相等
   */
  compareTimestamps(local: string | Date, remote: string | Date): number {
    const localMs = this.toMilliseconds(local);
    const remoteMs = this.toMilliseconds(remote);
    
    // 如果有可靠的偏移数据，校正本地时间
    const result = this.lastSyncResult();
    let correctedLocalMs = localMs;
    
    if (result?.reliable && CLOCK_SYNC_CONFIG.USE_SERVER_TIME) {
      correctedLocalMs = localMs - result.driftMs;
    }
    
    return correctedLocalMs - remoteMs;
  }
  
  /**
   * 判断本地数据是否比远程数据更新
   */
  isLocalNewer(localUpdatedAt: string | Date, remoteUpdatedAt: string | Date): boolean {
    return this.compareTimestamps(localUpdatedAt, remoteUpdatedAt) > 0;
  }
  
  // ========== 工具方法 ==========
  
  private toMilliseconds(timestamp: number | string | Date): number {
    if (typeof timestamp === 'number') {
      return timestamp;
    }
    if (timestamp instanceof Date) {
      return timestamp.getTime();
    }
    return new Date(timestamp).getTime();
  }
  
  private toISOString(timestamp: number | string | Date): string {
    if (typeof timestamp === 'string') {
      // 验证是否为有效的 ISO 字符串
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) {
        return timestamp;
      }
    }
    return new Date(this.toMilliseconds(timestamp)).toISOString();
  }
}
