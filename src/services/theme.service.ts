import { Injectable, signal, inject, effect, computed, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Meta } from '@angular/platform-browser';
import { ThemeType, ColorMode } from '../models';
import { CACHE_CONFIG } from '../config';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

/** 本地颜色模式覆盖的存储键 */
const LOCAL_COLOR_MODE_KEY = 'nanoflow.colorMode.local';

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 1000;

/**
 * 主题服务
 * 从 StoreService 拆分出来，专门管理主题相关逻辑
 * 职责：
 * - 主题状态管理（色调 + 明暗）
 * - 主题持久化（本地 + 云端）
 * - DOM 主题应用
 * - 系统偏好监听
 * - PWA theme-color 动态更新
 */
@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private syncService = inject(SimpleSyncService);
  private authService = inject(AuthService);
  private toast = inject(ToastService);
  private meta = inject(Meta);
  private platformId = inject(PLATFORM_ID);
  
  /** 当前色调主题 */
  readonly theme = signal<ThemeType>('default');
  
  /** 当前颜色模式（用户选择，可能是 'system'） */
  readonly colorMode = signal<ColorMode>('system');
  
  /** 系统偏好的颜色模式 */
  readonly systemColorMode = signal<'light' | 'dark'>('light');
  
  /** 实际生效的颜色模式（解析 system 后的结果） */
  readonly effectiveColorMode = computed<'light' | 'dark'>(() => {
    const mode = this.colorMode();
    if (mode === 'system') {
      return this.systemColorMode();
    }
    return mode;
  });
  
  /** 是否为深色模式（便捷 getter） */
  readonly isDark = computed(() => this.effectiveColorMode() === 'dark');
  
  /** 主题保存状态 */
  readonly isSaving = signal(false);
  
  /** 防抖计时器 */
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 系统偏好媒体查询 */
  private systemPreferenceQuery: MediaQueryList | null = null;
  
  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.initializeFromDOM();
      this.setupSystemPreferenceListener();
      this.setupEffects();
    }
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 设置色调主题
   */
  async setTheme(theme: ThemeType) {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    
    // 防抖同步到云端
    this.debouncedSyncPreferences();
  }
  
  /**
   * 设置颜色模式
   */
  setColorMode(mode: ColorMode) {
    this.colorMode.set(mode);
    
    // 保存到本地（设备级覆盖）
    localStorage.setItem(LOCAL_COLOR_MODE_KEY, JSON.stringify(mode));
    
    // 应用到 DOM
    this.applyColorModeToDOM(this.effectiveColorMode());
    
    // 更新 PWA theme-color
    this.updateThemeColorMeta();
    
    // 防抖同步到云端（作为默认值）
    this.debouncedSyncPreferences();
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
    
    // 如果没有本地覆盖，使用云端的 colorMode 作为默认值
    const localOverride = localStorage.getItem(LOCAL_COLOR_MODE_KEY);
    if (!localOverride && prefs?.colorMode) {
      this.colorMode.set(prefs.colorMode);
      this.applyColorModeToDOM(this.effectiveColorMode());
      this.updateThemeColorMeta();
    }
  }
  
  /**
   * 应用色调主题到 DOM
   */
  applyThemeToDOM(theme: string) {
    if (typeof document === 'undefined') return;
    
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
  
  /**
   * 应用颜色模式到 DOM
   */
  applyColorModeToDOM(mode: 'light' | 'dark') {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-color-mode', mode);
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 从 DOM 初始化状态（读取防闪屏脚本设置的值）
   */
  private initializeFromDOM() {
    // 读取防闪屏脚本设置的初始值
    const initialMode = (window as unknown as { __NANOFLOW_INITIAL_COLOR_MODE__?: string }).__NANOFLOW_INITIAL_COLOR_MODE__;
    const systemMode = (window as unknown as { __NANOFLOW_SYSTEM_COLOR_MODE__?: string }).__NANOFLOW_SYSTEM_COLOR_MODE__;
    
    if (systemMode === 'dark' || systemMode === 'light') {
      this.systemColorMode.set(systemMode);
    }
    
    // 读取本地存储的用户选择
    const localPref = localStorage.getItem(LOCAL_COLOR_MODE_KEY);
    if (localPref) {
      try {
        const parsed = JSON.parse(localPref) as ColorMode;
        if (parsed === 'light' || parsed === 'dark' || parsed === 'system') {
          this.colorMode.set(parsed);
        }
      } catch { /* ignore */ }
    } else if (initialMode === 'dark' || initialMode === 'light') {
      // 如果没有明确选择，保持 'system'
      // 但确保 DOM 状态一致
    }
    
    // 加载色调主题
    this.loadLocalTheme();
  }
  
  /**
   * 设置系统偏好监听
   */
  private setupSystemPreferenceListener() {
    if (typeof window === 'undefined') return;
    
    this.systemPreferenceQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handler = (e: MediaQueryListEvent) => {
      this.systemColorMode.set(e.matches ? 'dark' : 'light');
      
      // 如果用户选择了 'system'，需要更新 DOM
      if (this.colorMode() === 'system') {
        this.applyColorModeToDOM(this.effectiveColorMode());
        this.updateThemeColorMeta();
      }
    };
    
    // 使用 addEventListener（现代浏览器）
    this.systemPreferenceQuery.addEventListener('change', handler);
  }
  
  /**
   * 设置响应式效果
   */
  private setupEffects() {
    // 当 effectiveColorMode 变化时触发外部通知（用于 GoJS 等）
    effect(() => {
      const mode = this.effectiveColorMode();
      // 这个 effect 主要用于触发依赖 isDark 的组件重新渲染
      // GoJS 服务会监听 isDark signal 来重绘图表
    });
  }
  
  /**
   * 更新 PWA theme-color meta 标签
   */
  private updateThemeColorMeta() {
    const isDark = this.effectiveColorMode() === 'dark';
    const color = isDark ? '#1a1a1a' : '#f5f5f4';
    
    // 更新 meta 标签
    this.meta.updateTag({ name: 'theme-color', content: color });
  }
  
  /**
   * 防抖同步偏好到云端
   */
  private debouncedSyncPreferences() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    
    this.saveDebounceTimer = setTimeout(async () => {
      const userId = this.authService.currentUserId();
      if (!userId) return;
      
      this.isSaving.set(true);
      try {
        await this.syncService.saveUserPreferences(userId, {
          theme: this.theme(),
          colorMode: this.colorMode(),
        });
      } catch (_error) {
        this.toast.warning('主题保存失败', '将在下次联网时同步');
      } finally {
        this.isSaving.set(false);
      }
    }, DEBOUNCE_DELAY);
  }
  
  /**
   * 从本地存储加载色调主题
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
