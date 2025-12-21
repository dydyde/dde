import { Injectable } from '@angular/core';

/**
 * 世界空间坐标点
 */
export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * 小地图空间坐标点
 */
export interface MinimapPoint {
  x: number;
  y: number;
}

/**
 * 矩形边界（世界空间）
 */
export interface WorldBounds {
  x: number;      // 左上角 x
  y: number;      // 左上角 y
  width: number;
  height: number;
}

/**
 * 小地图状态
 */
export interface MinimapState {
  /** 缩放比例：世界坐标 -> 小地图坐标 */
  scaleRatio: number;
  /** 小地图中内容的偏移量（用于居中） */
  offsetX: number;
  offsetY: number;
  /** 视口指示器（红框）在小地图中的位置和尺寸 */
  indicator: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 内容边界框在小地图中的位置和尺寸 */
  contentBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * 拖拽会话接口 - 用于优化实时拖拽性能
 * 
 * 通过缓存基础边界和被拖拽节点的初始位置，
 * 避免每帧都遍历所有节点来计算边界框
 */
export interface DragSession {
  /** 被拖拽节点的ID列表 */
  draggedNodeIds: Set<string>;
  /** 被拖拽节点的原始边界（拖拽开始时） */
  draggedNodesBounds: WorldBounds;
  /** 除被拖拽节点外的其他节点边界 */
  staticNodesBounds: WorldBounds;
  /** 上一帧的总边界（用于插值） */
  lastTotalBounds: WorldBounds;
  /** 上一帧的缩放比例（用于插值） */
  lastScaleRatio: number;
  /** 拖拽开始时间戳（用于平滑过渡） */
  startTimestamp: number;
  /** 缩放插值因子（0-1, 越小越平滑） */
  smoothFactor: number;
}

/**
 * 实时缩放结果
 */
export interface RealTimeScaleResult {
  /** 新的缩放比例 */
  scaleRatio: number;
  /** 新的总边界 */
  totalBounds: WorldBounds;
  /** 是否边界发生了扩展 */
  boundsExpanded: boolean;
}

/**
 * 虚拟边界计算结果 - 用于硬实时连续自适应系统
 * 
 * "Virtual Bounds" 是预测性边界：在节点状态更新之前，
 * 基于鼠标增量计算出节点将要到达的位置边界
 */
export interface VirtualBoundsResult {
  /** 虚拟边界（包含预测位置的并集边界） */
  virtualBounds: WorldBounds;
  /** 目标缩放比例（精确值，无插值） */
  targetScale: number;
  /** 锚定变换参数 */
  anchoredTransform: {
    /** 锚定点 X（用于变换原点）*/
    anchorX: number;
    /** 锚定点 Y */
    anchorY: number;
    /** 拖拽方向 (1=正向, -1=负向, 0=无) */
    dragDirectionX: number;
    dragDirectionY: number;
  };
  /** 是否边界发生扩展 */
  boundsExpanded: boolean;
  /** 扩展方向 */
  expansionDirection: {
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
  };
}

/**
 * MinimapMathService - 小地图数学计算服务
 * 
 * 实现无限画布应用的"全局自适应小地图"核心逻辑：
 * 
 * 1. 内容包含（Fit-View 逻辑）：
 *    小地图必须始终渲染全部图表内容，通过计算所有节点的边界框并缩放适配容器
 * 
 * 2. 视口指示器（红框）：
 *    - 尺寸逻辑：指示器尺寸与主视口/总内容的比例成正比
 *    - 缩放行为：用户放大时指示器缩小，放大时指示器增大
 * 
 * 3. 坐标映射：
 *    - 主画布 -> 小地图：平移/缩放时更新指示器位置
 *    - 小地图 -> 主画布：拖拽指示器时更新主画布滚动位置
 * 
 * 约束：小地图内容永不裁剪，节点极度分散时可视化会变得微小
 */
@Injectable({
  providedIn: 'root'
})
export class MinimapMathService {
  
  // ==================== 核心计算：缩放比例 ====================
  
  /**
   * 计算小地图的缩放比例
   * 
   * 核心公式：
   *   scaleRatio = min(minimapWidth / contentWidth, minimapHeight / contentHeight)
   * 
   * 这确保内容完全适配小地图容器，无裁剪
   * 
   * @param contentBounds 世界空间中所有内容的边界框
   * @param minimapWidth 小地图容器宽度（像素）
   * @param minimapHeight 小地图容器高度（像素）
   * @param padding 边距比例（0-0.5），默认 0.1 表示 10% 边距
   * @returns 缩放比例
   */
  calculateScaleRatio(
    contentBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): number {
    // 应用边距后的有效尺寸
    const effectiveWidth = minimapWidth * (1 - padding * 2);
    const effectiveHeight = minimapHeight * (1 - padding * 2);
    
    // 防止除以零
    const contentWidth = Math.max(contentBounds.width, 1);
    const contentHeight = Math.max(contentBounds.height, 1);
    
    // 计算两个方向的缩放比例，取较小值以确保完全适配
    const scaleX = effectiveWidth / contentWidth;
    const scaleY = effectiveHeight / contentHeight;
    
    // 取较小值确保内容完全可见（不裁剪）
    return Math.min(scaleX, scaleY);
  }
  
  // ==================== 坐标变换：世界 -> 小地图 ====================
  
  /**
   * 将世界空间坐标转换为小地图空间坐标
   * 
   * 公式：
   *   miniX = (worldX - contentBounds.x) * scaleRatio + offsetX
   *   miniY = (worldY - contentBounds.y) * scaleRatio + offsetY
   * 
   * @param worldPoint 世界空间中的点
   * @param contentBounds 世界空间中所有内容的边界框
   * @param scaleRatio 缩放比例
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @returns 小地图空间中的点
   */
  worldToMinimap(
    worldPoint: WorldPoint,
    contentBounds: WorldBounds,
    scaleRatio: number,
    minimapWidth: number,
    minimapHeight: number
  ): MinimapPoint {
    // 计算内容在小地图中的尺寸
    const contentWidthInMinimap = contentBounds.width * scaleRatio;
    const contentHeightInMinimap = contentBounds.height * scaleRatio;
    
    // 计算居中偏移量
    const offsetX = (minimapWidth - contentWidthInMinimap) / 2;
    const offsetY = (minimapHeight - contentHeightInMinimap) / 2;
    
    // 转换坐标
    return {
      x: (worldPoint.x - contentBounds.x) * scaleRatio + offsetX,
      y: (worldPoint.y - contentBounds.y) * scaleRatio + offsetY
    };
  }
  
  // ==================== 坐标变换：小地图 -> 世界 ====================
  
  /**
   * 将小地图空间坐标转换为世界空间坐标
   * 
   * 公式（逆变换）：
   *   worldX = (miniX - offsetX) / scaleRatio + contentBounds.x
   *   worldY = (miniY - offsetY) / scaleRatio + contentBounds.y
   * 
   * @param minimapPoint 小地图空间中的点
   * @param contentBounds 世界空间中所有内容的边界框
   * @param scaleRatio 缩放比例
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @returns 世界空间中的点
   */
  minimapToWorld(
    minimapPoint: MinimapPoint,
    contentBounds: WorldBounds,
    scaleRatio: number,
    minimapWidth: number,
    minimapHeight: number
  ): WorldPoint {
    // 计算内容在小地图中的尺寸
    const contentWidthInMinimap = contentBounds.width * scaleRatio;
    const contentHeightInMinimap = contentBounds.height * scaleRatio;
    
    // 计算居中偏移量
    const offsetX = (minimapWidth - contentWidthInMinimap) / 2;
    const offsetY = (minimapHeight - contentHeightInMinimap) / 2;
    
    // 逆变换
    return {
      x: (minimapPoint.x - offsetX) / scaleRatio + contentBounds.x,
      y: (minimapPoint.y - offsetY) / scaleRatio + contentBounds.y
    };
  }
  
  // ==================== 视口指示器计算 ====================
  
  /**
   * 计算视口指示器（红框）的尺寸
   * 
   * 核心公式：
   *   Indicator_Width = (Main_Viewport_Width / Total_Content_Width) * Minimap_Content_Width
   *   Indicator_Height = (Main_Viewport_Height / Total_Content_Height) * Minimap_Content_Height
   * 
   * 缩放行为：
   *   - 用户放大（看到更少内容）-> 指示器变小
   *   - 用户缩小（看到更多内容）-> 指示器变大
   *   - 节点分散（内容边界框增大）-> 指示器相对变小
   * 
   * @param viewportBounds 主视口在世界空间中的边界
   * @param contentBounds 所有内容在世界空间中的边界框
   * @param scaleRatio 小地图缩放比例
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @returns 指示器在小地图中的位置和尺寸
   */
  calculateIndicator(
    viewportBounds: WorldBounds,
    contentBounds: WorldBounds,
    scaleRatio: number,
    minimapWidth: number,
    minimapHeight: number
  ): { x: number; y: number; width: number; height: number } {
    // 视口在世界空间中的尺寸直接乘以缩放比例
    const indicatorWidth = viewportBounds.width * scaleRatio;
    const indicatorHeight = viewportBounds.height * scaleRatio;
    
    // 视口左上角转换到小地图坐标
    const topLeft = this.worldToMinimap(
      { x: viewportBounds.x, y: viewportBounds.y },
      contentBounds,
      scaleRatio,
      minimapWidth,
      minimapHeight
    );
    
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: indicatorWidth,
      height: indicatorHeight
    };
  }
  
  // ==================== 综合状态计算 ====================
  
  /**
   * 计算完整的小地图状态
   * 
   * 这是一个便捷方法，一次性计算所有需要的值
   * 
   * @param contentBounds 世界空间中所有内容的边界框
   * @param viewportBounds 主视口在世界空间中的边界
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @param padding 边距比例（默认 0.1）
   * @returns 完整的小地图状态
   */
  calculateMinimapState(
    contentBounds: WorldBounds,
    viewportBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): MinimapState {
    // 扩展内容边界以包含视口（确保视口指示器始终在小地图内）
    const extendedBounds = this.unionBounds(contentBounds, viewportBounds);
    
    // 计算缩放比例
    const scaleRatio = this.calculateScaleRatio(
      extendedBounds,
      minimapWidth,
      minimapHeight,
      padding
    );
    
    // 计算居中偏移量
    const contentWidthInMinimap = extendedBounds.width * scaleRatio;
    const contentHeightInMinimap = extendedBounds.height * scaleRatio;
    const offsetX = (minimapWidth - contentWidthInMinimap) / 2;
    const offsetY = (minimapHeight - contentHeightInMinimap) / 2;
    
    // 计算视口指示器
    const indicator = this.calculateIndicator(
      viewportBounds,
      extendedBounds,
      scaleRatio,
      minimapWidth,
      minimapHeight
    );
    
    // 计算原始内容边界在小地图中的位置
    const contentTopLeft = this.worldToMinimap(
      { x: contentBounds.x, y: contentBounds.y },
      extendedBounds,
      scaleRatio,
      minimapWidth,
      minimapHeight
    );
    
    return {
      scaleRatio,
      offsetX,
      offsetY,
      indicator,
      contentBounds: {
        x: contentTopLeft.x,
        y: contentTopLeft.y,
        width: contentBounds.width * scaleRatio,
        height: contentBounds.height * scaleRatio
      }
    };
  }
  
  // ==================== 拖拽指示器 -> 主画布滚动 ====================
  
  /**
   * 根据小地图中指示器的新位置计算主画布应该滚动到的位置
   * 
   * 用于处理用户在小地图中拖拽指示器（红框）的交互
   * 
   * @param newIndicatorPosition 指示器在小地图中的新位置（中心点）
   * @param contentBounds 世界空间中所有内容的边界框
   * @param viewportBounds 当前视口边界（用于获取视口尺寸）
   * @param scaleRatio 小地图缩放比例
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @returns 主画布应该滚动到的新位置（左上角）
   */
  indicatorDragToScrollPosition(
    newIndicatorPosition: MinimapPoint,
    contentBounds: WorldBounds,
    viewportBounds: WorldBounds,
    scaleRatio: number,
    minimapWidth: number,
    minimapHeight: number
  ): WorldPoint {
    // 扩展边界（与 calculateMinimapState 保持一致）
    const extendedBounds = this.unionBounds(contentBounds, viewportBounds);
    
    // 将小地图坐标转换回世界坐标（这是视口的中心点）
    const worldCenter = this.minimapToWorld(
      newIndicatorPosition,
      extendedBounds,
      scaleRatio,
      minimapWidth,
      minimapHeight
    );
    
    // 计算视口左上角位置
    return {
      x: worldCenter.x - viewportBounds.width / 2,
      y: worldCenter.y - viewportBounds.height / 2
    };
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 合并两个边界框
   */
  unionBounds(a: WorldBounds, b: WorldBounds): WorldBounds {
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxX = Math.max(a.x + a.width, b.x + b.width);
    const maxY = Math.max(a.y + a.height, b.y + b.height);
    
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }
  
  /**
   * 计算多个点的边界框
   */
  calculateBoundsFromPoints(points: WorldPoint[]): WorldBounds {
    if (points.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }
  
  /**
   * 计算多个节点的边界框
   * @param nodes 节点列表，每个节点需要 x, y, width, height 属性
   */
  calculateBoundsFromNodes<T extends { x: number; y: number; width: number; height: number }>(
    nodes: T[]
  ): WorldBounds {
    if (nodes.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }
  
  /**
   * 限制指示器位置在小地图边界内
   */
  clampIndicatorPosition(
    position: MinimapPoint,
    indicatorWidth: number,
    indicatorHeight: number,
    minimapWidth: number,
    minimapHeight: number
  ): MinimapPoint {
    const halfWidth = indicatorWidth / 2;
    const halfHeight = indicatorHeight / 2;
    
    return {
      x: Math.max(halfWidth, Math.min(minimapWidth - halfWidth, position.x)),
      y: Math.max(halfHeight, Math.min(minimapHeight - halfHeight, position.y))
    };
  }
  
  // ==================== 实时拖拽同步（同步连续缩放） ====================
  
  /**
   * 创建拖拽会话
   * 
   * 性能优化策略：
   * 1. 在拖拽开始时，将节点分为"被拖拽"和"静态"两组
   * 2. 静态节点的边界在整个拖拽过程中不变，只需计算一次
   * 3. 每帧只需更新被拖拽节点的位置贡献
   * 
   * @param allNodes 所有节点
   * @param draggedNodeIds 被拖拽节点的ID
   * @param currentTotalBounds 当前的总边界
   * @param currentScaleRatio 当前的缩放比例
   * @param smoothFactor 平滑因子（0.1-0.3 推荐，越小越平滑）
   */
  createDragSession<T extends { id: string; x: number; y: number; width: number; height: number }>(
    allNodes: T[],
    draggedNodeIds: string[],
    currentTotalBounds: WorldBounds,
    currentScaleRatio: number,
    smoothFactor: number = 0.15
  ): DragSession {
    const draggedSet = new Set(draggedNodeIds);
    
    // 分离被拖拽和静态节点
    const draggedNodes: T[] = [];
    const staticNodes: T[] = [];
    
    for (const node of allNodes) {
      if (draggedSet.has(node.id)) {
        draggedNodes.push(node);
      } else {
        staticNodes.push(node);
      }
    }
    
    // 分别计算边界
    const draggedNodesBounds = this.calculateBoundsFromNodes(draggedNodes);
    const staticNodesBounds = this.calculateBoundsFromNodes(staticNodes);
    
    return {
      draggedNodeIds: draggedSet,
      draggedNodesBounds,
      staticNodesBounds,
      lastTotalBounds: { ...currentTotalBounds },
      lastScaleRatio: currentScaleRatio,
      startTimestamp: performance.now(),
      smoothFactor: Math.max(0.05, Math.min(0.5, smoothFactor))
    };
  }
  
  /**
   * 实时更新拖拽中的边界和缩放比例
   * 
   * 核心算法 - "无限缩放"效果：
   * 1. 根据拖拽增量实时更新被拖拽节点的边界
   * 2. 合并静态节点边界，得到新的总边界
   * 3. 如果新边界超出当前边界，使用平滑插值逐步扩展
   * 4. 缩放比例使用插值过渡，避免突变
   * 
   * @param session 拖拽会话
   * @param dragDelta 拖拽位移 (鼠标当前位置 - 拖拽起点)
   * @param viewportBounds 当前视口边界
   * @param minimapWidth 小地图宽度
   * @param minimapHeight 小地图高度
   * @param padding 边距比例
   */
  updateDragBoundsRealtime(
    session: DragSession,
    dragDelta: WorldPoint,
    viewportBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): RealTimeScaleResult {
    // 1. 计算拖拽后的节点边界
    const currentDraggedBounds: WorldBounds = {
      x: session.draggedNodesBounds.x + dragDelta.x,
      y: session.draggedNodesBounds.y + dragDelta.y,
      width: session.draggedNodesBounds.width,
      height: session.draggedNodesBounds.height
    };
    
    // 2. 合并所有节点边界（静态 + 拖拽中）
    let contentBounds: WorldBounds;
    if (session.staticNodesBounds.width === 0 && session.staticNodesBounds.height === 0) {
      // 只有被拖拽的节点（极端情况）
      contentBounds = currentDraggedBounds;
    } else if (currentDraggedBounds.width === 0 && currentDraggedBounds.height === 0) {
      contentBounds = session.staticNodesBounds;
    } else {
      contentBounds = this.unionBounds(session.staticNodesBounds, currentDraggedBounds);
    }
    
    // 3. 合并视口边界，确保视口始终可见
    const totalBounds = this.unionBounds(contentBounds, viewportBounds);
    
    // 4. 检测边界是否扩展
    const boundsExpanded = 
      totalBounds.x < session.lastTotalBounds.x ||
      totalBounds.y < session.lastTotalBounds.y ||
      (totalBounds.x + totalBounds.width) > (session.lastTotalBounds.x + session.lastTotalBounds.width) ||
      (totalBounds.y + totalBounds.height) > (session.lastTotalBounds.y + session.lastTotalBounds.height);
    
    // 5. 计算目标缩放比例
    const targetScaleRatio = this.calculateScaleRatio(totalBounds, minimapWidth, minimapHeight, padding);
    
    // 6. 使用平滑插值过渡缩放比例
    // 当边界扩展时，使用更慢的插值速度让用户感知到"缩小"过程
    const interpolationFactor = boundsExpanded 
      ? session.smoothFactor * 0.5  // 扩展时更平滑
      : session.smoothFactor;
    
    const smoothedScaleRatio = this.lerp(
      session.lastScaleRatio, 
      targetScaleRatio, 
      interpolationFactor
    );
    
    // 7. 同样对边界使用平滑插值（防止内容跳动）
    const smoothedBounds = boundsExpanded ? this.lerpBounds(
      session.lastTotalBounds,
      totalBounds,
      interpolationFactor
    ) : totalBounds;
    
    // 8. 更新会话状态供下一帧使用
    session.lastTotalBounds = smoothedBounds;
    session.lastScaleRatio = smoothedScaleRatio;
    
    return {
      scaleRatio: smoothedScaleRatio,
      totalBounds: smoothedBounds,
      boundsExpanded
    };
  }
  
  /**
   * 快速更新拖拽边界（无插值版本）
   * 
   * 用于需要立即响应的场景，或作为 updateDragBoundsRealtime 的简化替代
   * 
   * @param session 拖拽会话
   * @param dragDelta 拖拽位移
   * @param viewportBounds 视口边界
   * @param minimapWidth 小地图宽度
   * @param minimapHeight 小地图高度
   * @param padding 边距
   */
  updateDragBoundsImmediate(
    session: DragSession,
    dragDelta: WorldPoint,
    viewportBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): RealTimeScaleResult {
    // 计算拖拽后的节点边界
    const currentDraggedBounds: WorldBounds = {
      x: session.draggedNodesBounds.x + dragDelta.x,
      y: session.draggedNodesBounds.y + dragDelta.y,
      width: session.draggedNodesBounds.width,
      height: session.draggedNodesBounds.height
    };
    
    // 合并边界
    const contentBounds = (session.staticNodesBounds.width === 0 && session.staticNodesBounds.height === 0)
      ? currentDraggedBounds
      : this.unionBounds(session.staticNodesBounds, currentDraggedBounds);
    
    const totalBounds = this.unionBounds(contentBounds, viewportBounds);
    const scaleRatio = this.calculateScaleRatio(totalBounds, minimapWidth, minimapHeight, padding);
    
    const boundsExpanded = 
      totalBounds.width > session.lastTotalBounds.width ||
      totalBounds.height > session.lastTotalBounds.height;
    
    // 更新会话
    session.lastTotalBounds = totalBounds;
    session.lastScaleRatio = scaleRatio;
    
    return { scaleRatio, totalBounds, boundsExpanded };
  }
  
  /**
   * 结束拖拽会话，返回最终状态
   */
  endDragSession(session: DragSession): { finalBounds: WorldBounds; finalScale: number } {
    return {
      finalBounds: session.lastTotalBounds,
      finalScale: session.lastScaleRatio
    };
  }
  
  // ==================== 插值辅助方法 ====================
  
  /**
   * 线性插值
   */
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
  
  /**
   * 边界框线性插值
   */
  private lerpBounds(a: WorldBounds, b: WorldBounds, t: number): WorldBounds {
    return {
      x: this.lerp(a.x, b.x, t),
      y: this.lerp(a.y, b.y, t),
      width: this.lerp(a.width, b.width, t),
      height: this.lerp(a.height, b.height, t)
    };
  }
  
  /**
   * 使用缓动函数的边界插值（更自然的过渡）
   */
  lerpBoundsEased(
    a: WorldBounds, 
    b: WorldBounds, 
    t: number,
    easingFn: (t: number) => number = this.easeOutCubic
  ): WorldBounds {
    const easedT = easingFn(t);
    return this.lerpBounds(a, b, easedT);
  }
  
  /**
   * Ease-out cubic 缓动函数
   * 快速开始，缓慢结束
   */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }
  
  /**
   * Ease-out quad 缓动函数
   * 适度的减速效果
   */
  private easeOutQuad(t: number): number {
    return 1 - (1 - t) * (1 - t);
  }
  
  // ==================== 硬实时连续自适应系统 (Hard-Realtime Continuous Fit) ====================
  
  /**
   * 计算虚拟边界 - "Ghost" Calculation（核心算法）
   * 
   * 这是实现零延迟小地图缩放的关键：
   * 1. 不等待节点状态更新，在 mousemove 事件中立即计算
   * 2. 使用 mouseDelta 预测节点的"幽灵"位置
   * 3. 计算 Virtual_Bounds = Union(Current_World_Bounds, Projected_Node_Pos)
   * 
   * @param session 拖拽会话（包含静态节点边界）
   * @param mouseDelta 鼠标位移增量 { x: currentX - startX, y: currentY - startY }
   * @param viewportBounds 当前视口边界
   * @param minimapWidth 小地图容器宽度
   * @param minimapHeight 小地图容器高度
   * @param padding 边距比例
   * @returns VirtualBoundsResult 包含虚拟边界、目标缩放和锚定变换
   */
  calculateVirtualBounds(
    session: DragSession,
    mouseDelta: WorldPoint,
    viewportBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): VirtualBoundsResult {
    // ========== Step 1: Ghost Calculation ==========
    // 计算被拖拽节点的预测位置（Projected_Node_Pos）
    const projectedDraggedBounds: WorldBounds = {
      x: session.draggedNodesBounds.x + mouseDelta.x,
      y: session.draggedNodesBounds.y + mouseDelta.y,
      width: session.draggedNodesBounds.width,
      height: session.draggedNodesBounds.height
    };
    
    // 当前世界边界 = 静态节点边界
    const currentWorldBounds = session.staticNodesBounds;
    
    // Virtual_Bounds = Union(Current_World_Bounds, Projected_Node_Pos)
    let virtualContentBounds: WorldBounds;
    if (currentWorldBounds.width === 0 && currentWorldBounds.height === 0) {
      virtualContentBounds = projectedDraggedBounds;
    } else if (projectedDraggedBounds.width === 0 && projectedDraggedBounds.height === 0) {
      virtualContentBounds = currentWorldBounds;
    } else {
      virtualContentBounds = this.unionBounds(currentWorldBounds, projectedDraggedBounds);
    }
    
    // 合并视口边界（确保视口始终可见）
    const virtualBounds = this.unionBounds(virtualContentBounds, viewportBounds);
    
    // ========== Step 2: Inverse Scale Formula ==========
    // Target_Scale = min(Minimap_Width / Virtual_Bounds.Width, Minimap_Height / Virtual_Bounds.Height)
    const targetScale = this.calculateScaleRatio(virtualBounds, minimapWidth, minimapHeight, padding);
    
    // ========== Step 3: Origin Stabilization (Anchor Fix) ==========
    // 检测拖拽方向并确定锚定边缘
    const lastBounds = session.lastTotalBounds;
    
    // 检测边界扩展方向
    const expandLeft = virtualBounds.x < lastBounds.x;
    const expandRight = (virtualBounds.x + virtualBounds.width) > (lastBounds.x + lastBounds.width);
    const expandTop = virtualBounds.y < lastBounds.y;
    const expandBottom = (virtualBounds.y + virtualBounds.height) > (lastBounds.y + lastBounds.height);
    
    const boundsExpanded = expandLeft || expandRight || expandTop || expandBottom;
    
    // 确定拖拽方向
    const dragDirectionX = mouseDelta.x > 0 ? 1 : (mouseDelta.x < 0 ? -1 : 0);
    const dragDirectionY = mouseDelta.y > 0 ? 1 : (mouseDelta.y < 0 ? -1 : 0);
    
    // 锚定点选择：
    // - 向右拖拽时锚定左边缘 (anchorX = minX)
    // - 向左拖拽时锚定右边缘 (anchorX = maxX)
    // - 向下拖拽时锚定上边缘 (anchorY = minY)
    // - 向上拖拽时锚定下边缘 (anchorY = maxY)
    let anchorX: number;
    let anchorY: number;
    
    if (dragDirectionX >= 0) {
      // 向右或静止：锚定左边缘
      anchorX = virtualBounds.x;
    } else {
      // 向左：锚定右边缘
      anchorX = virtualBounds.x + virtualBounds.width;
    }
    
    if (dragDirectionY >= 0) {
      // 向下或静止：锚定上边缘
      anchorY = virtualBounds.y;
    } else {
      // 向上：锚定下边缘
      anchorY = virtualBounds.y + virtualBounds.height;
    }
    
    return {
      virtualBounds,
      targetScale,
      anchoredTransform: {
        anchorX,
        anchorY,
        dragDirectionX,
        dragDirectionY
      },
      boundsExpanded,
      expansionDirection: {
        left: expandLeft,
        right: expandRight,
        top: expandTop,
        bottom: expandBottom
      }
    };
  }
  
  /**
   * 计算锚定变换后的小地图节点位置
   * 
   * 使用公式：Minimap_Node_X = (Node_World_X - Virtual_Bounds.minX) * Final_Scale
   * 这确保在缩放变化时，锚定边缘保持稳定不抖动
   * 
   * @param worldPoint 世界空间中的点
   * @param virtualBounds 虚拟边界
   * @param scale 缩放比例
   * @param minimapWidth 小地图宽度
   * @param minimapHeight 小地图高度
   * @returns 小地图空间中的点
   */
  worldToMinimapAnchored(
    worldPoint: WorldPoint,
    virtualBounds: WorldBounds,
    scale: number,
    minimapWidth: number,
    minimapHeight: number
  ): MinimapPoint {
    // 计算内容在小地图中的尺寸
    const contentWidthInMinimap = virtualBounds.width * scale;
    const contentHeightInMinimap = virtualBounds.height * scale;
    
    // 计算居中偏移量
    const offsetX = (minimapWidth - contentWidthInMinimap) / 2;
    const offsetY = (minimapHeight - contentHeightInMinimap) / 2;
    
    // 应用锚定变换公式
    return {
      x: (worldPoint.x - virtualBounds.x) * scale + offsetX,
      y: (worldPoint.y - virtualBounds.y) * scale + offsetY
    };
  }
  
  /**
   * 执行实时小地图更新的完整计算（零延迟版本）
   * 
   * 这是在 onMouseMove 事件回调中直接调用的方法：
   * 1. 计算虚拟边界
   * 2. 计算目标缩放
   * 3. 返回可直接应用于 transform 的值
   * 
   * 严格禁止：
   * - 不使用 setTimeout / requestAnimationFrame
   * - 不使用状态更新触发器
   * - 所有计算在事件回调中同步完成
   * 
   * @param session 拖拽会话
   * @param mouseDelta 鼠标位移
   * @param viewportBounds 视口边界
   * @param minimapWidth 小地图宽度
   * @param minimapHeight 小地图高度
   * @param padding 边距
   * @returns 直接可用的变换结果
   */
  computeRealtimeMinimapTransform(
    session: DragSession,
    mouseDelta: WorldPoint,
    viewportBounds: WorldBounds,
    minimapWidth: number,
    minimapHeight: number,
    padding: number = 0.1
  ): {
    scale: number;
    virtualBounds: WorldBounds;
    anchorX: number;
    anchorY: number;
    boundsExpanded: boolean;
  } {
    // 计算虚拟边界和所有变换参数
    const result = this.calculateVirtualBounds(
      session,
      mouseDelta,
      viewportBounds,
      minimapWidth,
      minimapHeight,
      padding
    );
    
    // 更新会话状态（用于下一帧的边界比较）
    session.lastTotalBounds = result.virtualBounds;
    session.lastScaleRatio = result.targetScale;
    
    return {
      scale: result.targetScale,
      virtualBounds: result.virtualBounds,
      anchorX: result.anchoredTransform.anchorX,
      anchorY: result.anchoredTransform.anchorY,
      boundsExpanded: result.boundsExpanded
    };
  }
}
