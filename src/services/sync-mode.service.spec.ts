/**
 * SyncModeService 单元测试
 * 
 * 测试覆盖：
 * - 同步模式切换
 * - 配置持久化
 * - 自动同步定时器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SyncModeService, SyncMode } from './sync-mode.service';
import { LoggerService } from './logger.service';

describe('SyncModeService', () => {
  let service: SyncModeService;
  let mockLoggerService: any;
  
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    
    mockLoggerService = {
      category: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    };
    
    TestBed.configureTestingModule({
      providers: [
        SyncModeService,
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });
    
    service = TestBed.inject(SyncModeService);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  describe('初始化', () => {
    it('默认应为 automatic 模式', () => {
      expect(service.mode()).toBe('automatic');
    });
    
    it('应从 localStorage 加载配置', () => {
      const config = {
        mode: 'manual' as SyncMode,
        interval: 60,
        perceptionEnabled: true,
        syncOnBoot: true,
        syncOnExit: true,
        generateConflictDoc: true,
      };
      localStorage.setItem('nanoflow.sync-mode-config', JSON.stringify(config));
      
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          SyncModeService,
          { provide: LoggerService, useValue: mockLoggerService },
        ],
      });
      
      const newService = TestBed.inject(SyncModeService);
      expect(newService.mode()).toBe('manual');
      expect(newService.interval()).toBe(60);
    });
  });
  
  describe('setMode', () => {
    it('应切换到手动模式', () => {
      service.setMode('manual');
      expect(service.mode()).toBe('manual');
      expect(service.isManual()).toBe(true);
      expect(service.isAutomatic()).toBe(false);
    });
    
    it('应切换到完全手动模式', () => {
      service.setMode('completely-manual');
      expect(service.mode()).toBe('completely-manual');
      expect(service.isCompletelyManual()).toBe(true);
    });
    
    it('应持久化到 localStorage', () => {
      service.setMode('manual');
      
      const stored = JSON.parse(localStorage.getItem('nanoflow.sync-mode-config') || '{}');
      expect(stored.mode).toBe('manual');
    });
  });
  
  describe('setInterval', () => {
    it('应更新同步间隔', () => {
      service.setInterval(120);
      expect(service.interval()).toBe(120);
    });
    
    it('应限制最小间隔为 10 秒', () => {
      service.setInterval(5);
      expect(service.interval()).toBe(10);
    });
    
    it('应限制最大间隔为 43200 秒', () => {
      service.setInterval(50000);
      expect(service.interval()).toBe(43200);
    });
  });
  
  describe('计算属性', () => {
    it('isAutomatic 应正确计算', () => {
      service.setMode('automatic');
      expect(service.isAutomatic()).toBe(true);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(false);
    });
    
    it('isManual 应正确计算', () => {
      service.setMode('manual');
      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(true);
      expect(service.isCompletelyManual()).toBe(false);
    });
    
    it('isCompletelyManual 应正确计算', () => {
      service.setMode('completely-manual');
      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(true);
    });
  });
  
  describe('setSyncCallback', () => {
    it('应注册同步回调', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(callback);
      
      // 通过 triggerSync 测试回调是否被调用
      await service.triggerSync('upload');
      
      expect(callback).toHaveBeenCalledWith('upload');
    });
  });
  
  describe('triggerSync', () => {
    it('应调用同步回调', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(callback);
      
      await service.triggerSync('download');
      
      expect(callback).toHaveBeenCalledWith('download');
    });
    
    it('无回调时应静默返回', async () => {
      // 不注册回调
      await expect(service.triggerSync('both')).resolves.not.toThrow();
    });
  });
  
  describe('currentConfig', () => {
    it('应返回完整配置', () => {
      const config = service.currentConfig();
      
      expect(config).toHaveProperty('mode');
      expect(config).toHaveProperty('interval');
      expect(config).toHaveProperty('perceptionEnabled');
      expect(config).toHaveProperty('syncOnBoot');
      expect(config).toHaveProperty('syncOnExit');
      expect(config).toHaveProperty('generateConflictDoc');
    });
  });
});
