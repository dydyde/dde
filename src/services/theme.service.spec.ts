/**
 * ThemeService 单元测试
 * 
 * 测试覆盖：
 * - 主题设置
 * - 本地存储持久化
 * - DOM 应用
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { ThemeType } from '../models';

describe('ThemeService', () => {
  let service: ThemeService;
  let mockSyncService: any;
  let mockAuthService: any;
  let mockToastService: any;
  
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    
    mockSyncService = {
      saveUserPreferences: vi.fn().mockResolvedValue(true),
      loadUserPreferences: vi.fn().mockResolvedValue(null),
    };
    
    mockAuthService = {
      currentUserId: vi.fn(() => null),
    };
    
    mockToastService = {
      warning: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        ThemeService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });
    
    service = TestBed.inject(ThemeService);
  });
  
  describe('初始化', () => {
    it('默认主题应为 default', () => {
      expect(service.theme()).toBe('default');
    });
    
    it('应从 localStorage 加载保存的主题', () => {
      localStorage.setItem('nanoflow.theme', 'ocean');
      
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          ThemeService,
          { provide: SimpleSyncService, useValue: mockSyncService },
          { provide: AuthService, useValue: mockAuthService },
          { provide: ToastService, useValue: mockToastService },
        ],
      });
      
      const newService = TestBed.inject(ThemeService);
      expect(newService.theme()).toBe('ocean');
    });
  });
  
  describe('setTheme', () => {
    it('应更新主题状态', async () => {
      await service.setTheme('forest');
      expect(service.theme()).toBe('forest');
    });
    
    it('应保存到 localStorage', async () => {
      await service.setTheme('sunset');
      expect(localStorage.getItem('nanoflow.theme')).toBe('sunset');
    });
    
    it('应应用到 DOM', async () => {
      await service.setTheme('lavender');
      expect(document.documentElement.getAttribute('data-theme')).toBe('lavender');
    });
    
    it('default 主题应移除 data-theme 属性', async () => {
      document.documentElement.setAttribute('data-theme', 'ocean');
      await service.setTheme('default');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
    
    it('登录用户应同步到云端', async () => {
      mockAuthService.currentUserId.mockReturnValue('user-123');
      
      await service.setTheme('ocean');
      
      expect(mockSyncService.saveUserPreferences).toHaveBeenCalledWith('user-123', { theme: 'ocean' });
    });
    
    it('未登录用户不应同步到云端', async () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      
      await service.setTheme('forest');
      
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
    });
    
    it('同步失败应显示警告', async () => {
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.saveUserPreferences.mockRejectedValue(new Error('Network error'));
      
      await service.setTheme('sunset');
      
      expect(mockToastService.warning).toHaveBeenCalled();
    });
  });
  
  describe('loadUserTheme', () => {
    it('应从云端加载主题', async () => {
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.loadUserPreferences.mockResolvedValue({ theme: 'lavender' as ThemeType });
      
      await service.loadUserTheme();
      
      expect(service.theme()).toBe('lavender');
      expect(document.documentElement.getAttribute('data-theme')).toBe('lavender');
    });
    
    it('无偏好时应保持当前主题', async () => {
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.loadUserPreferences.mockResolvedValue(null);
      
      const originalTheme = service.theme();
      await service.loadUserTheme();
      
      expect(service.theme()).toBe(originalTheme);
    });
    
    it('未登录用户应直接返回', async () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      
      await service.loadUserTheme();
      
      expect(mockSyncService.loadUserPreferences).not.toHaveBeenCalled();
    });
  });
  
  describe('applyThemeToDOM', () => {
    it('应设置 data-theme 属性', () => {
      service.applyThemeToDOM('ocean');
      expect(document.documentElement.getAttribute('data-theme')).toBe('ocean');
    });
    
    it('default 应移除属性', () => {
      document.documentElement.setAttribute('data-theme', 'forest');
      service.applyThemeToDOM('default');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  });
  
  describe('isSaving', () => {
    it('同步期间应为 true', async () => {
      mockAuthService.currentUserId.mockReturnValue('user-123');
      
      // 使用延迟 promise 检查 isSaving 状态
      let resolveFn: () => void;
      const delayedPromise = new Promise<void>(resolve => { resolveFn = resolve; });
      mockSyncService.saveUserPreferences.mockReturnValue(delayedPromise);
      
      const setThemePromise = service.setTheme('ocean');
      
      // 同步进行中
      expect(service.isSaving()).toBe(true);
      
      // 完成同步
      resolveFn!();
      await setThemePromise;
      
      expect(service.isSaving()).toBe(false);
    });
  });
});
