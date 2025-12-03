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
import { Injectable, inject, signal } from '@angular/core';
import { SyncService } from './sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeType, UserPreferences } from '../models';
import { CACHE_CONFIG } from '../config/constants';

@Injectable({
  providedIn: 'root'
})
export class PreferenceService {
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  private authService = inject(AuthService);

  /** 当前主题 */
  readonly theme = signal<ThemeType>('default');

  constructor() {
    this.loadLocalPreferences();
  }

  // ========== 公共方法 ==========

  /**
   * 设置主题
   * 同时更新本地存储和云端
   */
  async setTheme(theme: ThemeType): Promise<void> {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);

    const userId = this.authService.currentUserId();
    if (userId) {
      await this.saveUserPreferences(userId, { theme });
    }
  }

  /**
   * 加载用户偏好（从云端）
   */
  async loadUserPreferences(): Promise<void> {
    const userId = this.authService.currentUserId();
    if (!userId) return;

    try {
      const prefs = await this.syncService.loadUserPreferences(userId);
      if (prefs?.theme) {
        this.theme.set(prefs.theme);
        this.applyThemeToDOM(prefs.theme);
        localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
      }
    } catch (error) {
      console.error('加载用户偏好失败:', error);
    }
  }

  /**
   * 加载本地偏好（从 localStorage）
   */
  loadLocalPreferences(): void {
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
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

  // ========== 私有方法 ==========

  /**
   * 应用主题到 DOM
   */
  private applyThemeToDOM(theme: string): void {
    if (typeof document === 'undefined') return;

    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
}
