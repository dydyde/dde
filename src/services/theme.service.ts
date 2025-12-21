import { Injectable, signal, inject } from '@angular/core';
import { ThemeType } from '../models';
import { CACHE_CONFIG } from '../config/constants';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

/**
 * 主题服务
 * 从 StoreService 拆分出来，专门管理主题相关逻辑
 * 职责：
 * - 主题状态管理
 * - 主题持久化（本地 + 云端）
 * - DOM 主题应用
 */
@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private syncService = inject(SimpleSyncService);
  private authService = inject(AuthService);
  private toast = inject(ToastService);
  
  /** 当前主题 */
  readonly theme = signal<ThemeType>('default');
  
  /** 主题保存状态 */
  readonly isSaving = signal(false);
  
  constructor() {
    this.loadLocalTheme();
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 设置主题
   */
  async setTheme(theme: ThemeType) {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    
    // 同步到云端
    const userId = this.authService.currentUserId();
    if (userId) {
      this.isSaving.set(true);
      try {
        await this.syncService.saveUserPreferences(userId, { theme });
        // 主题保存成功不需要 Toast 提示（避免频繁打扰）
      } catch (_error) {
        // 只在失败时提示
        this.toast.warning('主题保存失败', '将在下次联网时同步');
      } finally {
        this.isSaving.set(false);
      }
    }
  }
  
  /**
   * 从云端加载主题偏好
   */
  async loadUserTheme() {
    const userId = this.authService.currentUserId();
    if (!userId) return;
    
    const prefs = await this.syncService.loadUserPreferences(userId);
    if (prefs?.theme) {
      this.theme.set(prefs.theme);
      this.applyThemeToDOM(prefs.theme);
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
  }
  
  /**
   * 应用主题到 DOM
   */
  applyThemeToDOM(theme: string) {
    if (typeof document === 'undefined') return;
    
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 从本地存储加载主题
   */
  private loadLocalTheme() {
    if (typeof localStorage === 'undefined') return;
    
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }
}
