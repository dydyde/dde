/**
 * PreferenceService - 用户偏好设置服务
 * 
 * 【职责边界】
 * ✓ 主题管理（theme signal, DOM 应用）
 * ✓ 用户偏好的云端同步
 * ✓ 本地偏好的持久化（localStorage）
 * ✓ 冲突自动解决开关管理
 * ✗ UI 布局状态 → UiStateService
 * ✗ 用户会话 → UserSessionService
 * 
 * 【v5.7 用户偏好键隔离】
 * localStorage 键包含 userId 前缀，避免多用户共享设备时偏好混淆
 * 格式：nanoflow.preference.{userId}.{key}
 */
import { Injectable, inject, signal, effect } from '@angular/core';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { ThemeType, UserPreferences } from '../models';

/** 本地存储键前缀 */
const PREFERENCE_KEY_PREFIX = 'nanoflow.preference';

/** 生成用户特定的存储键 */
function getUserPreferenceKey(userId: string | null, key: string): string {
  // 未登录时使用 'anonymous' 前缀
  const userPart = userId || 'anonymous';
  return `${PREFERENCE_KEY_PREFIX}.${userPart}.${key}`;
}

@Injectable({
  providedIn: 'root'
})
export class PreferenceService {
  private syncService = inject(SimpleSyncService);
  private actionQueue = inject(ActionQueueService);
  private authService = inject(AuthService);
  private themeService = inject(ThemeService);

  /** 当前主题 */
  readonly theme = this.themeService.theme;
  
  /** 
   * 自动解决冲突开关
   * 默认 true：使用 LWW 自动解决冲突
   * false：所有冲突进入仪表盘由用户手动处理
   */
  private _autoResolveConflicts = signal(true);
  readonly autoResolveConflicts = this._autoResolveConflicts.asReadonly();

  constructor() {
    // 当用户登录状态变化时，重新加载该用户的偏好
    effect(() => {
      const userId = this.authService.currentUserId();
      // 每次用户变化时加载对应用户的偏好
      this._autoResolveConflicts.set(this.loadAutoResolveFromStorage(userId));
    });
  }

  // ========== 公共方法 ==========

  /**
   * 设置主题
   * 同时更新本地存储和云端
   */
  async setTheme(theme: ThemeType): Promise<void> {
    await this.themeService.setTheme(theme);
  }
  
  /**
   * 设置自动解决冲突开关
   */
  setAutoResolveConflicts(enabled: boolean): void {
    this._autoResolveConflicts.set(enabled);
    const userId = this.authService.currentUserId();
    this.saveAutoResolveToStorage(userId, enabled);
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
    // 自动解决冲突开关在构造函数中已加载
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
   * 从 localStorage 加载自动解决冲突设置
   * @param userId 当前用户ID，用于生成隔离的存储键
   */
  private loadAutoResolveFromStorage(userId: string | null): boolean {
    try {
      const key = getUserPreferenceKey(userId, 'autoResolveConflicts');
      const stored = localStorage.getItem(key);
      // 默认 true（使用 LWW 自动解决）
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  }
  
  /**
   * 保存自动解决冲突设置到 localStorage
   * @param userId 当前用户ID，用于生成隔离的存储键
   * @param enabled 是否启用自动解决
   */
  private saveAutoResolveToStorage(userId: string | null, enabled: boolean): void {
    try {
      const key = getUserPreferenceKey(userId, 'autoResolveConflicts');
      localStorage.setItem(key, String(enabled));
    } catch {
      // 忽略存储失败
    }
  }
}
