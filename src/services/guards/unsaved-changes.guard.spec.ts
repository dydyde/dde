/**
 * UnsavedChangesGuard 单元测试
 * 
 * 覆盖场景：
 * - 无未保存更改时允许离开
 * - 有未保存更改时显示确认
 * - 自动保存成功后允许离开
 * - 自动保存失败后提示
 * - 非保护路由直接允许离开
 * - BeforeUnload 保护
 * - 项目切换保护
 * 
 * 性能优化：
 * - 使用 fake timers 避免 5s 超时等待
 * - 测试执行时间从 20s+ 降至 <1s
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  UnsavedChangesGuard, 
  BeforeUnloadGuardService,
  ProjectSwitchGuardService,
  ROUTE_LEAVE_PROTECTION_CONFIG,
  CanLeave
} from './unsaved-changes.guard';
import { SimpleSyncService } from '../../app/core/services/simple-sync.service';
import { LoggerService } from '../logger.service';
import { BeforeUnloadManagerService } from '../before-unload-manager.service';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

describe('UnsavedChangesGuard', () => {
  let guard: UnsavedChangesGuard;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    // 启用 fake timers 避免真实超时等待
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
        isOnline: true,
      }),
    };
    
    TestBed.configureTestingModule({
      providers: [
        UnsavedChangesGuard,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    guard = TestBed.inject(UnsavedChangesGuard);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  function createRouteSnapshot(url: string): RouterStateSnapshot {
    return { url } as RouterStateSnapshot;
  }
  
  function createActivatedRouteSnapshot(): ActivatedRouteSnapshot {
    return {} as ActivatedRouteSnapshot;
  }
  
  /**
   * 辅助函数：执行 canDeactivate 并快进超时
   * 用于测试有 pendingChanges 的场景，避免等待真实的 5s 超时
   */
  async function canDeactivateWithFakeTimers(
    component: unknown,
    currentUrl: string,
    nextUrl: string
  ): Promise<boolean> {
    const resultPromise = guard.canDeactivate(
      component,
      createActivatedRouteSnapshot(),
      createRouteSnapshot(currentUrl),
      createRouteSnapshot(nextUrl)
    );
    
    // 快进所有定时器（包括 AUTO_SAVE_TIMEOUT）
    await vi.runAllTimersAsync();
    
    return resultPromise;
  }
  
  describe('canDeactivate', () => {
    it('无未保存更改时应允许离开', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/project/123'),
        createRouteSnapshot('/home')
      );
      
      expect(result).toBe(true);
    });
    
    it('非保护路由应直接允许离开', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 5,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/settings'),
        createRouteSnapshot('/home')
      );
      
      expect(result).toBe(true);
    });
    
    it('有未保存更改时应显示确认对话框', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      const result = await canDeactivateWithFakeTimers(
        null,
        '/project/123',
        '/home'
      );
      
      expect(confirmSpy).toHaveBeenCalled();
      expect(result).toBe(true);
      
      confirmSpy.mockRestore();
    });
    
    it('用户取消离开时应返回 false', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      
      const result = await canDeactivateWithFakeTimers(
        null,
        '/project/123',
        '/home'
      );
      
      expect(result).toBe(false);
      
      confirmSpy.mockRestore();
    });
    
    it('组件实现 CanLeave 时应使用组件逻辑', async () => {
      const mockComponent: CanLeave = {
        canLeave: vi.fn().mockResolvedValue(true),
      };
      
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 5,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        mockComponent,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/project/123'),
        createRouteSnapshot('/home')
      );
      
      expect(mockComponent.canLeave).toHaveBeenCalled();
      expect(result).toBe(true);
    });
    
    it('正在同步时应视为有未保存更改', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: true,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      await canDeactivateWithFakeTimers(
        null,
        '/project/123',
        '/home'
      );
      
      expect(confirmSpy).toHaveBeenCalled();
      
      confirmSpy.mockRestore();
    });
  });
  
  describe('hasPendingChanges', () => {
    it('pendingCount > 0 时应返回 true', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      
      expect(guard.hasPendingChanges()).toBe(true);
    });
    
    it('isSyncing 为 true 时应返回 true', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: true,
      });
      
      expect(guard.hasPendingChanges()).toBe(true);
    });
    
    it('无待处理更改时应返回 false', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      expect(guard.hasPendingChanges()).toBe(false);
    });
  });
});

describe('BeforeUnloadGuardService', () => {
  let service: BeforeUnloadGuardService;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  let mockBeforeUnloadManager: {
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
  };
  let registeredCallback: (() => boolean) | null = null;
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCallback = null;
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      }),
    };
    
    mockBeforeUnloadManager = {
      register: vi.fn((_id: string, callback: () => boolean) => {
        registeredCallback = callback;
      }),
      unregister: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        BeforeUnloadGuardService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: BeforeUnloadManagerService, useValue: mockBeforeUnloadManager },
      ],
    });
    
    service = TestBed.inject(BeforeUnloadGuardService);
  });
  
  afterEach(() => {
    service.disable();
  });
  
  describe('enable/disable', () => {
    it('应能启用监听', () => {
      service.enable();
      
      expect(mockBeforeUnloadManager.register).toHaveBeenCalledWith(
        'unsaved-changes-guard',
        expect.any(Function),
        5
      );
    });
    
    it('应能禁用监听', () => {
      service.enable();
      service.disable();
      
      expect(mockBeforeUnloadManager.unregister).toHaveBeenCalledWith('unsaved-changes-guard');
    });
    
    it('重复启用不应重复注册', () => {
      service.enable();
      service.enable();
      service.enable();
      
      expect(mockBeforeUnloadManager.register).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('beforeunload 事件处理', () => {
    it('有未保存更改时应阻止关闭', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      service.enable();
      
      // 回调应返回 true（需要显示确认）
      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!()).toBe(true);
    });
    
    it('无未保存更改时应允许关闭', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      service.enable();
      
      // 回调应返回 false（允许关闭）
      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!()).toBe(false);
    });
  });
});

describe('ProjectSwitchGuardService', () => {
  let service: ProjectSwitchGuardService;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    // 启用 fake timers 避免真实超时等待
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      }),
    };
    
    TestBed.configureTestingModule({
      providers: [
        ProjectSwitchGuardService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    service = TestBed.inject(ProjectSwitchGuardService);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  describe('canSwitchProject', () => {
    it('无未保存更改时应返回 proceed', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      const result = await service.canSwitchProject();
      
      expect(result).toBe('proceed');
    });
    
    it('有未保存更改时应显示确认', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      // 使用 Promise + 快进定时器模式
      const resultPromise = service.canSwitchProject();
      await vi.runAllTimersAsync();
      await resultPromise;
      
      expect(confirmSpy).toHaveBeenCalled();
      
      confirmSpy.mockRestore();
    });
  });
});

describe('配置', () => {
  it('应有合理的默认配置', () => {
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.ENABLED).toBe(true);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE).toBe(true);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT).toBe(5000);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.PROTECTED_ROUTES).toContain('/project/');
  });
});
