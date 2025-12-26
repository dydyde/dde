/**
 * FlowEventService 单元测试
 * 
 * 测试策略：
 * - 验证事件回调注册和触发
 * - 验证事件监听器的生命周期管理
 * - 验证节点/连接线点击事件的分发
 * 
 * 测试覆盖：
 * - 回调注册
 * - 事件分发
 * - 生命周期管理
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FlowEventService, NodeClickCallback, LinkClickCallback } from './flow-event.service';
import { StoreService } from '../../../../services/store.service';
import { LoggerService } from '../../../../services/logger.service';

describe('FlowEventService', () => {
  let service: FlowEventService;
  let mockStore: Partial<StoreService>;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  
  beforeEach(() => {
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockLogger = {
      category: vi.fn().mockReturnValue(loggerMock),
    };
    
    mockStore = {
      currentProject: signal(null),
      isMobile: signal(false),
    };
    
    TestBed.configureTestingModule({
      providers: [
        FlowEventService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: StoreService, useValue: mockStore },
      ],
    });
    
    service = TestBed.inject(FlowEventService);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('应成功创建服务', () => {
      expect(service).toBeDefined();
    });
  });

  describe('节点点击回调', () => {
    it('onNodeClick 应能注册回调', () => {
      const callback: NodeClickCallback = vi.fn();
      service.onNodeClick(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('emitNodeClick 应触发已注册的回调', () => {
      const callback: NodeClickCallback = vi.fn();
      service.onNodeClick(callback);
      
      // 手动触发节点点击
      service.emitNodeClick('task-1', false);
      
      expect(callback).toHaveBeenCalledWith('task-1', false);
    });

    it('emitNodeClick 双击应正确传递参数', () => {
      const callback: NodeClickCallback = vi.fn();
      service.onNodeClick(callback);
      
      service.emitNodeClick('task-2', true);
      
      expect(callback).toHaveBeenCalledWith('task-2', true);
    });

    it('后注册的回调应覆盖前一个', () => {
      const callback1: NodeClickCallback = vi.fn();
      const callback2: NodeClickCallback = vi.fn();
      
      service.onNodeClick(callback1);
      service.onNodeClick(callback2);
      
      service.emitNodeClick('task-3', false);
      
      // 只有最后一个回调被调用（单回调模式）
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('连接线点击回调', () => {
    it('onLinkClick 应能注册回调', () => {
      const callback: LinkClickCallback = vi.fn();
      service.onLinkClick(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('emitLinkClick 应触发已注册的回调', () => {
      const callback: LinkClickCallback = vi.fn();
      service.onLinkClick(callback);
      
      const linkData = { key: 'link-1', from: 'a', to: 'b' };
      service.emitLinkClick(linkData, 100, 200, false);
      
      expect(callback).toHaveBeenCalledWith(linkData, 100, 200, false);
    });
  });

  describe('背景点击回调', () => {
    it('onBackgroundClick 应能注册回调', () => {
      const callback = vi.fn();
      service.onBackgroundClick(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('emitBackgroundClick 应触发已注册的回调', () => {
      const callback = vi.fn();
      service.onBackgroundClick(callback);
      
      service.emitBackgroundClick();
      
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('选择移动回调', () => {
    it('onSelectionMoved 应能注册回调', () => {
      const callback = vi.fn();
      service.onSelectionMoved(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('emitSelectionMoved 应触发已注册的回调', () => {
      const callback = vi.fn();
      service.onSelectionMoved(callback);
      
      const movedNodes = [
        { key: 'task-1', x: 100, y: 200, isUnassigned: false },
        { key: 'task-2', x: 300, y: 400, isUnassigned: true },
      ];
      service.emitSelectionMoved(movedNodes);
      
      expect(callback).toHaveBeenCalledWith(movedNodes);
    });
  });

  describe('生命周期', () => {
    it('dispose 应清理所有回调', () => {
      const nodeCallback: NodeClickCallback = vi.fn();
      const linkCallback: LinkClickCallback = vi.fn();
      
      service.onNodeClick(nodeCallback);
      service.onLinkClick(linkCallback);
      
      service.dispose();
      
      // dispose 后触发事件不应调用回调
      service.emitNodeClick('task-1', false);
      service.emitLinkClick({}, 0, 0, false);
      
      expect(nodeCallback).not.toHaveBeenCalled();
      expect(linkCallback).not.toHaveBeenCalled();
    });

    it('dispose 后可以重新注册回调', () => {
      service.dispose();
      
      const callback: NodeClickCallback = vi.fn();
      service.onNodeClick(callback);
      
      service.emitNodeClick('task-1', false);
      
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('连接线删除回调', () => {
    it('onLinkDelete 应能注册回调', () => {
      const callback = vi.fn();
      service.onLinkDelete(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('emitLinkDelete 应触发已注册的回调', () => {
      const callback = vi.fn();
      service.onLinkDelete(callback);
      
      const linkData = { key: 'link-1', from: 'a', to: 'b' };
      service.emitLinkDelete(linkData);
      
      expect(callback).toHaveBeenCalledWith(linkData);
    });
  });
});
