import { TestBed } from '@angular/core/testing';
import { MinimapMathService, WorldBounds, WorldPoint, MinimapPoint, DragSession, VirtualBoundsResult } from './minimap-math.service';

describe('MinimapMathService', () => {
  let service: MinimapMathService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MinimapMathService]
    });
    service = TestBed.inject(MinimapMathService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // ==================== 缩放比例计算测试 ====================
  
  describe('calculateScaleRatio', () => {
    it('should calculate correct scale for square content in square minimap', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const scale = service.calculateScaleRatio(contentBounds, 100, 100, 0);
      expect(scale).toBe(0.1); // 100 / 1000 = 0.1
    });

    it('should use smaller scale when content is wider than tall', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 2000, height: 1000 };
      const scale = service.calculateScaleRatio(contentBounds, 100, 100, 0);
      expect(scale).toBe(0.05); // 100 / 2000 = 0.05 (取较小值)
    });

    it('should use smaller scale when content is taller than wide', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 2000 };
      const scale = service.calculateScaleRatio(contentBounds, 100, 100, 0);
      expect(scale).toBe(0.05); // 100 / 2000 = 0.05 (取较小值)
    });

    it('should apply padding correctly', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      // padding 0.1 means effective size is 80x80 (100 * 0.8)
      const scale = service.calculateScaleRatio(contentBounds, 100, 100, 0.1);
      expect(scale).toBe(0.08); // 80 / 1000 = 0.08
    });

    it('should handle zero-size content gracefully', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
      const scale = service.calculateScaleRatio(contentBounds, 100, 100, 0);
      expect(scale).toBe(100); // 100 / 1 = 100 (minimum content size is 1)
    });
  });

  // ==================== 世界 -> 小地图坐标变换测试 ====================
  
  describe('worldToMinimap', () => {
    it('should convert origin point correctly', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const result = service.worldToMinimap(
        { x: 0, y: 0 },
        contentBounds,
        0.1, // scale
        100, // minimap width
        100  // minimap height
      );
      // Content is 100x100 in minimap (1000 * 0.1), centered in 100x100 container
      // Offset is 0 (perfectly fits)
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('should convert center point correctly', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const result = service.worldToMinimap(
        { x: 500, y: 500 },
        contentBounds,
        0.1,
        100,
        100
      );
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });

    it('should handle offset content bounds', () => {
      const contentBounds: WorldBounds = { x: 100, y: 100, width: 1000, height: 1000 };
      const result = service.worldToMinimap(
        { x: 100, y: 100 }, // Top-left of content
        contentBounds,
        0.1,
        100,
        100
      );
      // After translation: (100-100) * 0.1 = 0, plus offset 0
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('should apply centering offset for smaller content', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      const result = service.worldToMinimap(
        { x: 0, y: 0 },
        contentBounds,
        0.1,
        100,
        100
      );
      // Content is 50x50 in minimap (500 * 0.1), offset is (100-50)/2 = 25
      expect(result.x).toBe(25);
      expect(result.y).toBe(25);
    });
  });

  // ==================== 小地图 -> 世界坐标变换测试 ====================
  
  describe('minimapToWorld', () => {
    it('should be inverse of worldToMinimap', () => {
      const contentBounds: WorldBounds = { x: 100, y: 200, width: 1000, height: 800 };
      const originalPoint: WorldPoint = { x: 350, y: 450 };
      
      // World -> Minimap
      const minimapPoint = service.worldToMinimap(
        originalPoint,
        contentBounds,
        0.1,
        150,
        120
      );
      
      // Minimap -> World (should recover original)
      const recoveredPoint = service.minimapToWorld(
        minimapPoint,
        contentBounds,
        0.1,
        150,
        120
      );
      
      expect(recoveredPoint.x).toBeCloseTo(originalPoint.x, 5);
      expect(recoveredPoint.y).toBeCloseTo(originalPoint.y, 5);
    });
  });

  // ==================== 视口指示器计算测试 ====================
  
  describe('calculateIndicator', () => {
    it('should calculate indicator size proportional to viewport', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 2000, height: 2000 };
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      const indicator = service.calculateIndicator(
        viewportBounds,
        contentBounds,
        0.05, // scale: 100 / 2000
        100,
        100
      );
      
      // Indicator width = 500 * 0.05 = 25
      // Indicator height = 500 * 0.05 = 25
      expect(indicator.width).toBe(25);
      expect(indicator.height).toBe(25);
    });

    it('should grow indicator when viewport grows (zooming out)', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 2000, height: 2000 };
      
      // Smaller viewport (zoomed in)
      const smallViewport: WorldBounds = { x: 0, y: 0, width: 400, height: 400 };
      const smallIndicator = service.calculateIndicator(
        smallViewport, contentBounds, 0.05, 100, 100
      );
      
      // Larger viewport (zoomed out)
      const largeViewport: WorldBounds = { x: 0, y: 0, width: 800, height: 800 };
      const largeIndicator = service.calculateIndicator(
        largeViewport, contentBounds, 0.05, 100, 100
      );
      
      // Larger viewport should have larger indicator
      expect(largeIndicator.width).toBeGreaterThan(smallIndicator.width);
      expect(largeIndicator.height).toBeGreaterThan(smallIndicator.height);
    });
  });

  // ==================== 综合状态计算测试 ====================
  
  describe('calculateMinimapState', () => {
    it('should calculate complete state correctly', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const viewportBounds: WorldBounds = { x: 100, y: 100, width: 300, height: 300 };
      
      const state = service.calculateMinimapState(
        contentBounds,
        viewportBounds,
        100,
        100,
        0 // no padding for easier calculation
      );
      
      expect(state.scaleRatio).toBe(0.1);
      expect(state.indicator).toBeDefined();
      expect(state.contentBounds).toBeDefined();
    });

    it('should extend bounds to include viewport', () => {
      // Viewport extends beyond content
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      const viewportBounds: WorldBounds = { x: 400, y: 400, width: 300, height: 300 };
      
      const state = service.calculateMinimapState(
        contentBounds,
        viewportBounds,
        100,
        100,
        0
      );
      
      // Extended bounds should be 700x700 (0 to 700)
      // Scale should be 100/700 ≈ 0.143
      expect(state.scaleRatio).toBeCloseTo(100 / 700, 3);
    });
  });

  // ==================== 拖拽指示器 -> 滚动位置测试 ====================
  
  describe('indicatorDragToScrollPosition', () => {
    it('should calculate scroll position from indicator center', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 2000, height: 2000 };
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 400, height: 400 };
      
      // Drag indicator to center of minimap
      const newPosition: MinimapPoint = { x: 50, y: 50 };
      
      const scrollPos = service.indicatorDragToScrollPosition(
        newPosition,
        contentBounds,
        viewportBounds,
        0.05,
        100,
        100
      );
      
      // Center of minimap corresponds to center of world (1000, 1000)
      // Scroll position should be center - half viewport = (1000-200, 1000-200) = (800, 800)
      expect(scrollPos.x).toBeCloseTo(800, 0);
      expect(scrollPos.y).toBeCloseTo(800, 0);
    });
  });

  // ==================== 辅助方法测试 ====================
  
  describe('unionBounds', () => {
    it('should merge overlapping bounds', () => {
      const a: WorldBounds = { x: 0, y: 0, width: 100, height: 100 };
      const b: WorldBounds = { x: 50, y: 50, width: 100, height: 100 };
      
      const result = service.unionBounds(a, b);
      
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.width).toBe(150);
      expect(result.height).toBe(150);
    });

    it('should merge non-overlapping bounds', () => {
      const a: WorldBounds = { x: 0, y: 0, width: 50, height: 50 };
      const b: WorldBounds = { x: 100, y: 100, width: 50, height: 50 };
      
      const result = service.unionBounds(a, b);
      
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.width).toBe(150);
      expect(result.height).toBe(150);
    });
  });

  describe('calculateBoundsFromPoints', () => {
    it('should calculate bounds from multiple points', () => {
      const points: WorldPoint[] = [
        { x: 10, y: 20 },
        { x: 100, y: 50 },
        { x: 30, y: 200 }
      ];
      
      const result = service.calculateBoundsFromPoints(points);
      
      expect(result.x).toBe(10);
      expect(result.y).toBe(20);
      expect(result.width).toBe(90); // 100 - 10
      expect(result.height).toBe(180); // 200 - 20
    });

    it('should return zero bounds for empty array', () => {
      const result = service.calculateBoundsFromPoints([]);
      
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });
  });

  describe('clampIndicatorPosition', () => {
    it('should keep position within bounds', () => {
      const result = service.clampIndicatorPosition(
        { x: 50, y: 50 },
        20, // indicator width
        20, // indicator height
        100,
        100
      );
      
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });

    it('should clamp position at left edge', () => {
      const result = service.clampIndicatorPosition(
        { x: 5, y: 50 },
        20,
        20,
        100,
        100
      );
      
      // Minimum x is halfWidth = 10
      expect(result.x).toBe(10);
      expect(result.y).toBe(50);
    });

    it('should clamp position at right edge', () => {
      const result = service.clampIndicatorPosition(
        { x: 95, y: 50 },
        20,
        20,
        100,
        100
      );
      
      // Maximum x is 100 - halfWidth = 90
      expect(result.x).toBe(90);
      expect(result.y).toBe(50);
    });
  });

  // ==================== 实时拖拽同步测试 ====================
  
  describe('createDragSession', () => {
    it('should create session with separated static and dragged nodes', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
        { id: 'node2', x: 200, y: 0, width: 100, height: 100 },
        { id: 'node3', x: 0, y: 200, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 300, height: 300 },
        0.1,
        0.15
      );
      
      expect(session.draggedNodeIds.has('node1')).toBe(true);
      expect(session.draggedNodeIds.has('node2')).toBe(false);
      // 被拖拽节点的边界
      expect(session.draggedNodesBounds.width).toBe(100);
      expect(session.draggedNodesBounds.height).toBe(100);
      // 静态节点的边界
      expect(session.staticNodesBounds.x).toBe(0);
      expect(session.staticNodesBounds.y).toBe(0);
    });

    it('should handle multiple dragged nodes', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
        { id: 'node2', x: 200, y: 0, width: 100, height: 100 },
        { id: 'node3', x: 400, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1', 'node2'],
        { x: 0, y: 0, width: 500, height: 100 },
        0.1,
        0.15
      );
      
      expect(session.draggedNodeIds.size).toBe(2);
      // 被拖拽节点边界应该包含 node1 和 node2
      expect(session.draggedNodesBounds.width).toBe(300); // 0 到 300
    });
  });

  describe('updateDragBoundsRealtime', () => {
    it('should update bounds when node is dragged to the right', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
        { id: 'node2', x: 200, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 300, height: 100 },
        0.1,
        1.0 // 使用最大平滑因子（即时响应）以便测试
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 向右拖拽 200 单位
      const result = service.updateDragBoundsRealtime(
        session,
        { x: 200, y: 0 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 边界应该扩展以包含新位置
      expect(result.boundsExpanded).toBe(true);
      // 总边界宽度应该增加（由于插值可能不会立即达到最终值）
      expect(result.totalBounds.width).toBeGreaterThan(300);
    });

    it('should shrink scale when bounds expand', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const initialScale = 0.2;
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 500, height: 500 },
        initialScale,
        1.0 // 即时响应以便测试
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 向右拖拽很远
      const result = service.updateDragBoundsRealtime(
        session,
        { x: 1000, y: 0 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 缩放比例应该减小
      expect(result.scaleRatio).toBeLessThan(initialScale);
    });

    it('should not expand bounds when dragging within existing bounds', () => {
      const allNodes = [
        { id: 'node1', x: 100, y: 100, width: 100, height: 100 },
        { id: 'node2', x: 300, y: 300, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 500, height: 500 },
        0.2,
        0.5
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 400, height: 400 };
      
      // 小幅移动，保持在边界内
      const result = service.updateDragBoundsRealtime(
        session,
        { x: 50, y: 50 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 边界不应扩展
      expect(result.boundsExpanded).toBe(false);
    });
  });

  describe('updateDragBoundsImmediate', () => {
    it('should update bounds without interpolation', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        1.0,
        0.15
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 拖拽并检查即时响应
      const result = service.updateDragBoundsImmediate(
        session,
        { x: 500, y: 0 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 应该立即反映新边界
      expect(result.totalBounds.width).toBeGreaterThanOrEqual(600);
    });
  });

  describe('endDragSession', () => {
    it('should return final state', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        0.15
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 执行一些更新
      service.updateDragBoundsRealtime(
        session,
        { x: 200, y: 0 },
        viewportBounds,
        100,
        100,
        0
      );
      
      const finalState = service.endDragSession(session);
      
      expect(finalState.finalBounds).toBeDefined();
      expect(finalState.finalScale).toBeGreaterThan(0);
    });
  });

  describe('smooth interpolation behavior', () => {
    it('should detect bounds expansion correctly', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      // 创建会话
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 大幅拖拽导致边界扩展
      const result1 = service.updateDragBoundsRealtime(
        session,
        { x: 1000, y: 0 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 边界应该扩展
      expect(result1.boundsExpanded).toBe(true);
      // 由于平滑插值，边界宽度会逐渐增加（而非立即到达最终值）
      // 原始边界宽度是100，视口是500，所以初始总边界至少是500
      // 拖拽后节点移动到1000，所以最终边界应该是1100（0到1100）
      // 但由于插值，第一帧只会部分接近目标值
      expect(result1.totalBounds.width).toBeGreaterThan(100);
    });

    it('should preserve session state across multiple updates', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        0.5
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      // 多次更新
      const result1 = service.updateDragBoundsRealtime(
        session, { x: 100, y: 0 }, viewportBounds, 100, 100, 0
      );
      
      const result2 = service.updateDragBoundsRealtime(
        session, { x: 200, y: 0 }, viewportBounds, 100, 100, 0
      );
      
      const result3 = service.updateDragBoundsRealtime(
        session, { x: 300, y: 0 }, viewportBounds, 100, 100, 0
      );
      
      // 缩放应该逐步减小
      expect(result1.scaleRatio).toBeGreaterThanOrEqual(result2.scaleRatio);
      expect(result2.scaleRatio).toBeGreaterThanOrEqual(result3.scaleRatio);
    });
  });

  // ==================== 硬实时连续自适应（Virtual Bounds）测试 ====================
  
  describe('calculateVirtualBounds (Hard-Realtime Continuous Fit)', () => {
    it('should calculate virtual bounds using ghost position', () => {
      // 设置：一个静态节点和一个被拖拽节点
      const allNodes = [
        { id: 'static', x: 0, y: 0, width: 100, height: 100 },
        { id: 'dragged', x: 200, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['dragged'],
        { x: 0, y: 0, width: 300, height: 100 },
        0.2,
        1.0 // 无插值
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 400, height: 400 };
      const mouseDelta = { x: 500, y: 0 }; // 向右拖拽 500 像素
      
      const result = service.calculateVirtualBounds(
        session,
        mouseDelta,
        viewportBounds,
        100, // minimap width
        100, // minimap height
        0    // no padding
      );
      
      // 虚拟边界应该包含预测的节点位置
      // 静态节点: [0, 100]
      // 预测拖拽节点位置: [200+500, 200+500+100] = [700, 800]
      // 合并后: [0, 800]
      expect(result.virtualBounds.x).toBe(0);
      expect(result.virtualBounds.width).toBeGreaterThanOrEqual(800);
      expect(result.boundsExpanded).toBe(true);
      expect(result.expansionDirection.right).toBe(true);
    });

    it('should anchor to left edge when dragging right', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 200, height: 200 };
      const mouseDelta = { x: 300, y: 0 }; // 向右拖拽
      
      const result = service.calculateVirtualBounds(
        session,
        mouseDelta,
        viewportBounds,
        100,
        100,
        0
      );
      
      // 向右拖拽时，锚定点应该是左边缘 (minX)
      expect(result.anchoredTransform.dragDirectionX).toBe(1);
      expect(result.anchoredTransform.anchorX).toBe(result.virtualBounds.x);
    });

    it('should anchor to right edge when dragging left', () => {
      const allNodes = [
        { id: 'node1', x: 500, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 600, height: 100 },
        0.1,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 200, height: 200 };
      const mouseDelta = { x: -300, y: 0 }; // 向左拖拽
      
      const result = service.calculateVirtualBounds(
        session,
        mouseDelta,
        viewportBounds,
        100,
        100,
        0
      );
      
      // 向左拖拽时，锚定点应该是右边缘 (maxX)
      expect(result.anchoredTransform.dragDirectionX).toBe(-1);
      expect(result.anchoredTransform.anchorX).toBe(
        result.virtualBounds.x + result.virtualBounds.width
      );
    });

    it('should anchor to top edge when dragging down', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 200, height: 200 };
      const mouseDelta = { x: 0, y: 400 }; // 向下拖拽
      
      const result = service.calculateVirtualBounds(
        session,
        mouseDelta,
        viewportBounds,
        100,
        100,
        0
      );
      
      // 向下拖拽时，锚定点应该是上边缘 (minY)
      expect(result.anchoredTransform.dragDirectionY).toBe(1);
      expect(result.anchoredTransform.anchorY).toBe(result.virtualBounds.y);
    });

    it('should calculate correct inverse scale', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 200, height: 200 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 200, height: 200 },
        0.5,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 100, height: 100 };
      const mouseDelta = { x: 800, y: 0 }; // 大幅拖拽
      
      const result = service.calculateVirtualBounds(
        session,
        mouseDelta,
        viewportBounds,
        100, // minimap width
        100, // minimap height
        0
      );
      
      // 逆向缩放公式验证
      // Virtual_Bounds.Width ≈ 1000 (0 to 800+200)
      // Target_Scale = min(100/1000, 100/?) = 0.1
      expect(result.targetScale).toBeLessThanOrEqual(0.2);
      expect(result.targetScale).toBeGreaterThan(0);
    });
  });

  describe('computeRealtimeMinimapTransform', () => {
    it('should compute transform with zero latency', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 },
        { id: 'node2', x: 200, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node2'],
        { x: 0, y: 0, width: 300, height: 100 },
        0.2,
        1.0
      );
      
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 300, height: 300 };
      
      // 模拟 mousemove 事件中的同步调用
      const startTime = performance.now();
      const result = service.computeRealtimeMinimapTransform(
        session,
        { x: 500, y: 0 },
        viewportBounds,
        100,
        100,
        0.1
      );
      const endTime = performance.now();
      
      // 验证结果
      expect(result.scale).toBeGreaterThan(0);
      expect(result.scale).toBeLessThan(1);
      expect(result.virtualBounds).toBeDefined();
      expect(result.anchorX).toBeDefined();
      expect(result.anchorY).toBeDefined();
      
      // 验证计算时间（应该非常快，< 1ms）
      expect(endTime - startTime).toBeLessThan(5);
    });

    it('should update session state after computation', () => {
      const allNodes = [
        { id: 'node1', x: 0, y: 0, width: 100, height: 100 }
      ];
      
      const session = service.createDragSession(
        allNodes,
        ['node1'],
        { x: 0, y: 0, width: 100, height: 100 },
        0.5,
        1.0
      );
      
      const initialBounds = { ...session.lastTotalBounds };
      const viewportBounds: WorldBounds = { x: 0, y: 0, width: 200, height: 200 };
      
      service.computeRealtimeMinimapTransform(
        session,
        { x: 500, y: 500 },
        viewportBounds,
        100,
        100,
        0
      );
      
      // 会话状态应该已更新
      expect(session.lastTotalBounds).not.toEqual(initialBounds);
      expect(session.lastScaleRatio).not.toBe(0.5);
    });
  });

  describe('worldToMinimapAnchored', () => {
    it('should apply anchored transform correctly', () => {
      const virtualBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const scale = 0.1;
      
      const result = service.worldToMinimapAnchored(
        { x: 0, y: 0 },
        virtualBounds,
        scale,
        100,
        100
      );
      
      // 世界坐标 (0,0) 应该映射到小地图的左上角（考虑居中偏移）
      // 内容尺寸 = 1000 * 0.1 = 100
      // 偏移 = (100 - 100) / 2 = 0
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('should center smaller content', () => {
      const virtualBounds: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      const scale = 0.1;
      
      const result = service.worldToMinimapAnchored(
        { x: 0, y: 0 },
        virtualBounds,
        scale,
        100,
        100
      );
      
      // 内容尺寸 = 500 * 0.1 = 50
      // 偏移 = (100 - 50) / 2 = 25
      expect(result.x).toBe(25);
      expect(result.y).toBe(25);
    });
  });
});
