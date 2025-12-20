import { Component, inject, effect, ChangeDetectionStrategy, DestroyRef } from '@angular/core';
import { SyncService } from '../services/sync.service';
import { ToastService } from '../services/toast.service';

/**
 * 离线状态通知组件
 * 
 * 设计理念：
 * - 使用 Toast 通知代替固定横幅，避免界面抖动
 * - 网络状态变化时只弹一次通知：
 *   - 离线时：弹出"网络已断开"
 *   - 恢复时：弹出"网络已恢复"
 * - 不占据固定空间，不影响界面布局
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<!-- 无渲染内容，仅用于监听网络状态变化 -->`,
})
export class OfflineBannerComponent {
  private syncService = inject(SyncService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  
  /** 上一次的网络连接状态（用于检测状态变化） */
  private previousOnlineState: boolean | null = null;
  
  /** 上一次的离线模式状态（服务中断） */
  private previousOfflineMode: boolean | null = null;

  constructor() {
    // 使用 effect 监听网络状态变化
    effect(() => {
      const isOnline = this.syncService.syncState().isOnline;
      const offlineMode = this.syncService.syncState().offlineMode;
      
      // 检测网络连接状态变化
      if (this.previousOnlineState !== null && this.previousOnlineState !== isOnline) {
        if (isOnline) {
          // 从离线恢复到在线
          this.toast.success('网络已恢复', '数据将自动同步到云端');
        } else {
          // 从在线变为离线
          this.toast.warning('网络已断开', '更改将保存到本地，联网后自动同步');
        }
      }
      
      // 检测服务中断状态变化（网络在线但服务不可用）
      if (this.previousOfflineMode !== null && this.previousOfflineMode !== offlineMode) {
        if (offlineMode) {
          // 进入离线模式（服务中断）
          this.toast.warning('服务连接中断', '正在重试连接...更改将保存到本地');
        } else if (isOnline) {
          // 服务恢复
          this.toast.success('服务已恢复', '数据将自动同步');
        }
      }
      
      // 更新状态
      this.previousOnlineState = isOnline;
      this.previousOfflineMode = offlineMode;
    });
  }
}
