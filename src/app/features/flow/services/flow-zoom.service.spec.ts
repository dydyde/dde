/**
 * FlowZoomService 单元测试
 * 
 * 测试策略：
 * - 验证缩放操作在无 diagram 时的安全性
 * - 验证视图状态管理
 * - 验证坐标转换
 * 
 * 测试覆盖：
 * - 初始状态
 * - 缩放操作（无 diagram）
 * - 视图状态
 * - 资源清理
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FlowZoomService } from './flow-zoom.service';
import { LoggerService } from '../../../../services/logger.service';
import { StoreService } from '../../../../services/store.service';

describe('FlowZoomService', () => {
  let service: FlowZoomService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  let mockStore: Partial<StoreService>;
  
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
      activeProjectId: vi.fn().mockReturnValue('project-1'),
      updateViewState: vi.fn(),
      getViewState: vi.fn().mockReturnValue(null),
    };
    
    TestBed.configureTestingModule({
      providers: [
        FlowZoomService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: StoreService, useValue: mockStore },
      ],
    });
    
    service = TestBed.inject(FlowZoomService);
  });
  
  afterEach(() => {
    service.dispose();
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('应成功创建服务', () => {
      expect(service).toBeDefined();
    });

    it('无 diagram 时 getZoom 应返回默认值 1.0', () => {
      expect(service.getZoom()).toBe(1.0);
    });

    it('无 diagram 时 getCurrentViewState 应返回 null', () => {
      expect(service.getCurrentViewState()).toBeNull();
    });

    it('无 diagram 时 getViewportBounds 应返回 null', () => {
      expect(service.getViewportBounds()).toBeNull();
    });

    it('无 diagram 时 getDocumentBounds 应返回 null', () => {
      expect(service.getDocumentBounds()).toBeNull();
    });
  });

  describe('缩放操作安全性（无 diagram）', () => {
    it('zoomIn 在无 diagram 时不应抛出异常', () => {
      expect(() => service.zoomIn()).not.toThrow();
    });

    it('zoomOut 在无 diagram 时不应抛出异常', () => {
      expect(() => service.zoomOut()).not.toThrow();
    });

    it('setZoom 在无 diagram 时不应抛出异常', () => {
      expect(() => service.setZoom(1.5)).not.toThrow();
    });

    it('resetZoom 在无 diagram 时不应抛出异常', () => {
      expect(() => service.resetZoom()).not.toThrow();
    });
  });

  describe('导航操作安全性（无 diagram）', () => {
    it('centerOnNode 在无 diagram 时不应抛出异常', () => {
      expect(() => service.centerOnNode('task-1')).not.toThrow();
    });

    it('fitToContents 在无 diagram 时不应抛出异常', () => {
      expect(() => service.fitToContents()).not.toThrow();
    });

    it('scrollTo 在无 diagram 时不应抛出异常', () => {
      expect(() => service.scrollTo(100, 200)).not.toThrow();
    });
  });

  describe('坐标转换（无 diagram）', () => {
    it('transformViewToDoc 在无 diagram 时应返回原始点', () => {
      const mockPoint = { x: 100, y: 200 } as any;
      const result = service.transformViewToDoc(mockPoint);
      expect(result).toBe(mockPoint);
    });

    it('transformDocToView 在无 diagram 时应返回原始点', () => {
      const mockPoint = { x: 100, y: 200 } as any;
      const result = service.transformDocToView(mockPoint);
      expect(result).toBe(mockPoint);
    });
  });

  describe('视图状态保存/恢复（无 diagram）', () => {
    it('saveViewState 在无 diagram 时应安全执行', () => {
      expect(() => service.saveViewState()).not.toThrow();
      // 由于没有 viewState，不应调用 updateViewState
    });

    it('restoreViewState 在无 diagram 时不应抛出异常', () => {
      expect(() => service.restoreViewState()).not.toThrow();
    });
  });

  describe('资源管理', () => {
    it('setDiagram(null) 不应抛出异常', () => {
      expect(() => service.setDiagram(null)).not.toThrow();
    });

    it('dispose 应安全清理资源', () => {
      expect(() => service.dispose()).not.toThrow();
    });

    it('requestUpdate 在无 diagram 时不应抛出异常', () => {
      expect(() => service.requestUpdate()).not.toThrow();
    });
  });
});
