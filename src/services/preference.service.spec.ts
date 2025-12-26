/**
 * PreferenceService 单元测试
 * 
 * 测试覆盖：
 * - 自动解决冲突开关
 * - 本地存储持久化
 * - 用户偏好云端同步
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PreferenceService } from './preference.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';

describe('PreferenceService', () => {
  let service: PreferenceService;
  let mockSyncService: any;
  let mockActionQueue: any;
  let mockThemeService: any;
  
  beforeEach(() => {
    // 清理 localStorage
    localStorage.clear();
    
    mockSyncService = {
      saveUserPreferences: vi.fn().mockResolvedValue(true),
    };
    
    mockActionQueue = {
      enqueue: vi.fn(),
    };
    
    mockThemeService = {
      theme: vi.fn(() => 'default'),
      setTheme: vi.fn().mockResolvedValue(undefined),
      loadUserTheme: vi.fn().mockResolvedValue(undefined),
    };
    
    TestBed.configureTestingModule({
      providers: [
        PreferenceService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: AuthService, useValue: {} },
        { provide: ThemeService, useValue: mockThemeService },
      ],
    });
    
    service = TestBed.inject(PreferenceService);
  });
  
  describe('autoResolveConflicts', () => {
    it('默认应启用自动解决冲突', () => {
      expect(service.autoResolveConflicts()).toBe(true);
    });
    
    it('应能切换自动解决冲突', () => {
      service.setAutoResolveConflicts(false);
      expect(service.autoResolveConflicts()).toBe(false);
      
      service.setAutoResolveConflicts(true);
      expect(service.autoResolveConflicts()).toBe(true);
    });
    
    it('应持久化到 localStorage', () => {
      service.setAutoResolveConflicts(false);
      
      const stored = localStorage.getItem('nanoflow.autoResolveConflicts');
      expect(stored).toBe('false');
    });
    
    it('应从 localStorage 加载设置', () => {
      localStorage.setItem('nanoflow.autoResolveConflicts', 'false');
      
      // 重新创建服务以测试加载
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          PreferenceService,
          { provide: SimpleSyncService, useValue: mockSyncService },
          { provide: ActionQueueService, useValue: mockActionQueue },
          { provide: AuthService, useValue: {} },
          { provide: ThemeService, useValue: mockThemeService },
        ],
      });
      
      const newService = TestBed.inject(PreferenceService);
      expect(newService.autoResolveConflicts()).toBe(false);
    });
  });
  
  describe('setTheme', () => {
    it('应调用 ThemeService.setTheme', async () => {
      await service.setTheme('ocean');
      
      expect(mockThemeService.setTheme).toHaveBeenCalledWith('ocean');
    });
  });
  
  describe('loadUserPreferences', () => {
    it('应调用 ThemeService.loadUserTheme', async () => {
      await service.loadUserPreferences();
      
      expect(mockThemeService.loadUserTheme).toHaveBeenCalled();
    });
  });
  
  describe('saveUserPreferences', () => {
    it('成功时应返回 true', async () => {
      const result = await service.saveUserPreferences('user-1', { theme: 'forest' });
      
      expect(result).toBe(true);
      expect(mockSyncService.saveUserPreferences).toHaveBeenCalledWith('user-1', { theme: 'forest' });
    });
    
    it('失败时应加入队列并返回 false', async () => {
      mockSyncService.saveUserPreferences.mockResolvedValue(false);
      
      const result = await service.saveUserPreferences('user-1', { theme: 'sunset' });
      
      expect(result).toBe(false);
      expect(mockActionQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
      }));
    });
    
    it('异常时应加入队列并返回 false', async () => {
      mockSyncService.saveUserPreferences.mockRejectedValue(new Error('Network error'));
      
      const result = await service.saveUserPreferences('user-1', { theme: 'lavender' });
      
      expect(result).toBe(false);
      expect(mockActionQueue.enqueue).toHaveBeenCalled();
    });
  });
});
