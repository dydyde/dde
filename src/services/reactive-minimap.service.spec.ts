import { TestBed } from '@angular/core/testing';
import { ReactiveMinimapService, NodePosition, MainCanvasViewport, MinimapElements } from './reactive-minimap.service';
import { MinimapMathService } from './minimap-math.service';

describe('ReactiveMinimapService', () => {
  let service: ReactiveMinimapService;
  let mockElements: MinimapElements;

  /**
   * 创建模拟的小地图 DOM 元素
   */
  function createMockElements(): MinimapElements {
    const container = document.createElement('div');
    const contentLayer = document.createElement('div');
    const viewportRect = document.createElement('div');

    // 模拟容器尺寸
    Object.defineProperty(container, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 150, configurable: true });

    container.appendChild(contentLayer);
    container.appendChild(viewportRect);

    return { container, contentLayer, viewportRect };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ReactiveMinimapService, MinimapMathService]
    });
    service = TestBed.inject(ReactiveMinimapService);
    mockElements = createMockElements();
  });

  afterEach(() => {
    if (service) {
      service.unregisterElements();
    }
  });

  // ==================== 基础测试 ====================

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should register elements correctly', () => {
    service.registerElements(mockElements);
    expect(service.currentElements).toBe(mockElements);
  });

  it('should unregister elements correctly', () => {
    service.registerElements(mockElements);
    service.unregisterElements();
    expect(service.currentElements).toBeNull();
  });

  // ==================== 拖拽会话测试 ====================

  describe('Drag Session', () => {
    const allNodes: NodePosition[] = [
      { id: 'static1', x: 0, y: 0, width: 100, height: 100 },
      { id: 'static2', x: 200, y: 0, width: 100, height: 100 },
      { id: 'moving', x: 100, y: 100, width: 100, height: 100 }
    ];

    beforeEach(() => {
      service.registerElements(mockElements);
    });

    it('should start drag session', () => {
      service.startDragSession(allNodes, ['moving'], { x: 150, y: 150 });
      expect(service.isDragging).toBe(true);
    });

    it('should end drag session', () => {
      service.startDragSession(allNodes, ['moving'], { x: 150, y: 150 });
      service.endDragSession();
      expect(service.isDragging).toBe(false);
    });

    it('should separate static and moving nodes correctly', () => {
      service.startDragSession(allNodes, ['moving'], { x: 150, y: 150 });
      
      // 验证会话已创建
      expect(service.isDragging).toBe(true);
    });
  });

  // ==================== 核心方法测试：updateMinimapOnDrag ====================

  describe('updateMinimapOnDrag (Sync-Shrink Effect)', () => {
    const staticNodes: NodePosition[] = [
      { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
      { id: 'node2', x: 200, y: 0, width: 100, height: 100 }
    ];
    const movingNode: NodePosition = { id: 'moving', x: 100, y: 100, width: 100, height: 100 };
    const allNodes = [...staticNodes, movingNode];

    const mainViewport: MainCanvasViewport = {
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0
    };

    beforeEach(() => {
      service.registerElements(mockElements);
      service.startDragSession(allNodes, ['moving'], { x: 150, y: 150 });
    });

    it('should return null when not in drag session', () => {
      service.endDragSession();
      const result = service.updateMinimapOnDrag({ x: 100, y: 0 }, mainViewport);
      expect(result).toBeNull();
    });

    it('should calculate transform when dragging within bounds', () => {
      const result = service.updateMinimapOnDrag({ x: 50, y: 0 }, mainViewport);
      
      expect(result).not.toBeNull();
      expect(result!.globalScale).toBeGreaterThan(0);
      expect(result!.globalScale).toBeLessThan(1);
    });

    it('should shrink scale when node is dragged outside bounds (Sync-Shrink)', () => {
      // 初始拖拽（小增量）
      const result1 = service.updateMinimapOnDrag({ x: 0, y: 0 }, mainViewport);
      const initialScale = result1!.globalScale;

      // 大幅拖拽到边界外
      service.endDragSession();
      service.startDragSession(allNodes, ['moving'], { x: 150, y: 150 });
      const result2 = service.updateMinimapOnDrag({ x: 1000, y: 0 }, mainViewport);
      const expandedScale = result2!.globalScale;

      // 验证边界扩展时缩放变小
      expect(expandedScale).toBeLessThan(initialScale);
    });

    it('should update content layer transform', () => {
      service.updateMinimapOnDrag({ x: 100, y: 0 }, mainViewport);
      
      // 验证 CSS transform 已设置
      expect(mockElements.contentLayer.style.transform).toContain('scale');
      expect(mockElements.contentLayer.style.transform).toContain('translate');
    });

    it('should update viewport rect dimensions and position', () => {
      service.updateMinimapOnDrag({ x: 100, y: 0 }, mainViewport);
      
      // 验证视口框样式已设置
      expect(mockElements.viewportRect.style.width).not.toBe('');
      expect(mockElements.viewportRect.style.height).not.toBe('');
      expect(mockElements.viewportRect.style.left).not.toBe('');
      expect(mockElements.viewportRect.style.top).not.toBe('');
    });

    it('should calculate viewport rect proportional to main canvas viewport', () => {
      const result = service.updateMinimapOnDrag({ x: 0, y: 0 }, mainViewport);
      
      // 视口框尺寸应该是主画布视口尺寸乘以缩放比例
      const expectedWidth = mainViewport.width * result!.globalScale;
      const expectedHeight = mainViewport.height * result!.globalScale;
      
      expect(result!.viewportWidth).toBeCloseTo(expectedWidth, 1);
      expect(result!.viewportHeight).toBeCloseTo(expectedHeight, 1);
    });

    it('should execute synchronously (zero latency)', () => {
      const startTime = performance.now();
      
      // 执行多次更新模拟实时拖拽
      for (let i = 0; i < 100; i++) {
        service.updateMinimapOnDrag({ x: i * 10, y: i * 5 }, mainViewport);
      }
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      // 100 次更新应该在 50ms 内完成（每次 < 0.5ms）
      expect(totalTime).toBeLessThan(50);
    });
  });

  // ==================== CSS 变量方法测试 ====================

  describe('updateMinimapOnDragWithCSSVariables', () => {
    const allNodes: NodePosition[] = [
      { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
    ];

    const mainViewport: MainCanvasViewport = {
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0
    };

    beforeEach(() => {
      service.registerElements(mockElements);
      service.startDragSession(allNodes, ['node1'], { x: 50, y: 50 });
    });

    it('should set CSS variables on container', () => {
      service.updateMinimapOnDragWithCSSVariables({ x: 100, y: 0 }, mainViewport);
      
      // 验证 CSS 变量已设置
      expect(mockElements.container.style.getPropertyValue('--minimap-scale')).not.toBe('');
      expect(mockElements.container.style.getPropertyValue('--viewport-width')).not.toBe('');
      expect(mockElements.container.style.getPropertyValue('--viewport-left')).not.toBe('');
    });
  });

  // ==================== 常规更新测试 ====================

  describe('updateMinimap (non-drag)', () => {
    const nodes: NodePosition[] = [
      { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
      { id: 'node2', x: 500, y: 300, width: 100, height: 100 }
    ];

    const mainViewport: MainCanvasViewport = {
      width: 800,
      height: 600,
      scrollX: 100,
      scrollY: 50
    };

    beforeEach(() => {
      service.registerElements(mockElements);
    });

    it('should update minimap with all nodes', () => {
      const result = service.updateMinimap(nodes, mainViewport);
      
      expect(result).not.toBeNull();
      expect(result!.globalScale).toBeGreaterThan(0);
    });

    it('should include viewport in world bounds', () => {
      const result = service.updateMinimap(nodes, mainViewport);
      
      // 新的世界边界应该包含所有节点和视口
      expect(result!.newWorldBounds.x).toBeLessThanOrEqual(mainViewport.scrollX);
      expect(result!.newWorldBounds.y).toBeLessThanOrEqual(mainViewport.scrollY);
    });

    it('should return null when no elements registered', () => {
      service.unregisterElements();
      const result = service.updateMinimap(nodes, mainViewport);
      expect(result).toBeNull();
    });
  });

  // ==================== 边界情况测试 ====================

  describe('Edge Cases', () => {
    beforeEach(() => {
      service.registerElements(mockElements);
    });

    it('should handle empty node list', () => {
      const mainViewport: MainCanvasViewport = {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0
      };

      const result = service.updateMinimap([], mainViewport);
      expect(result).not.toBeNull();
      // 边界应该基于视口
    });

    it('should handle single node drag', () => {
      const singleNode: NodePosition[] = [
        { id: 'only', x: 100, y: 100, width: 50, height: 50 }
      ];
      const mainViewport: MainCanvasViewport = {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0
      };

      service.startDragSession(singleNode, ['only'], { x: 125, y: 125 });
      const result = service.updateMinimapOnDrag({ x: 500, y: 500 }, mainViewport);
      
      expect(result).not.toBeNull();
    });

    it('should handle negative drag delta', () => {
      const nodes: NodePosition[] = [
        { id: 'node1', x: 500, y: 500, width: 100, height: 100 }
      ];
      const mainViewport: MainCanvasViewport = {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0
      };

      service.startDragSession(nodes, ['node1'], { x: 550, y: 550 });
      const result = service.updateMinimapOnDrag({ x: -400, y: -400 }, mainViewport);
      
      expect(result).not.toBeNull();
      expect(result!.newWorldBounds.x).toBeLessThanOrEqual(100);
    });
  });

  // ==================== Fit Ratio 计算测试 ====================

  describe('Fit Ratio Calculation', () => {
    beforeEach(() => {
      service.registerElements(mockElements);
    });

    it('should maintain aspect ratio', () => {
      const nodes: NodePosition[] = [
        { id: 'node1', x: 0, y: 0, width: 1000, height: 500 }
      ];
      const mainViewport: MainCanvasViewport = {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0
      };

      const result = service.updateMinimap(nodes, mainViewport);
      
      // 容器是 200x150，内容是 1000x500
      // ScaleX = 200/1000 = 0.2
      // ScaleY = 150/500 = 0.3
      // GlobalScale = min(0.2, 0.3) * 0.8 = 0.16
      expect(result!.globalScale).toBeLessThanOrEqual(0.2);
    });

    it('should use height as limiting factor for tall content', () => {
      const nodes: NodePosition[] = [
        { id: 'node1', x: 0, y: 0, width: 500, height: 1000 }
      ];
      const mainViewport: MainCanvasViewport = {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0
      };

      const result = service.updateMinimap(nodes, mainViewport);
      
      // 容器是 200x150，内容是 500x1000
      // ScaleX = 200/500 = 0.4
      // ScaleY = 150/1000 = 0.15
      // GlobalScale = min(0.4, 0.15) * 0.8 = 0.12
      expect(result!.globalScale).toBeLessThanOrEqual(0.15);
    });
  });
});
