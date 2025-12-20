/**
 * PreferenceService - 用户偏好设置服务
 * 
 * 【职责边界】
 * ✓ 主题管理（theme signal, DOM 应用）
 * ✓ 用户偏好的云端同步
 * ✓ 本地偏好的持久化（localStorage）
 * ✗ UI 布局状态 → UiStateService
 * ✗ 用户会话 → UserSessionService
 */
import { Injectable, inject } from '@angular/core';
import { SyncService } from './sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { ThemeType, UserPreferences } from '../models';

@Injectable({
  providedIn: 'root'
})
export class PreferenceService {
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  private authService = inject(AuthService);
  private themeService = inject(ThemeService);

  /** 当前主题 */
  readonly theme = this.themeService.theme;

  constructor() {}

  // ========== 公共方法 ==========

  /**
   * 设置主题
   * 同时更新本地存储和云端
   */
  async setTheme(theme: ThemeType): Promise<void> {
    await this.themeService.setTheme(theme);
  }

  /**
   * 加载用户偏好（从云端）
   */
  async loadUserPreferences(): Promise<void> {
    await this.themeService.loadUserTheme();
  }

  /**
   * 加载本地偏好（从 localStorage）
   */
  loadLocalPreferences(): void {
    // ThemeService 构造函数会自动加载本地主题
  }

  /**
   * 保存用户偏好到云端
   */
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    try {
      const success = await this.syncService.saveUserPreferences(userId, preferences);
      if (!success) {
        // 离线时加入队列
        this.actionQueue.enqueue({
          type: 'update',
          entityType: 'preference',
          entityId: userId,
          payload: { preferences, userId }
        });
      }
      return success;
    } catch (error) {
      console.error('保存用户偏好失败:', error);
      this.actionQueue.enqueue({
        type: 'update',
        entityType: 'preference',
        entityId: userId,
        payload: { preferences, userId }
      });
      return false;
    }
  }
}
