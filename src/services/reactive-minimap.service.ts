import { Injectable, inject } from '@angular/core';
import { WorldBounds, WorldPoint, MinimapMathService } from './minimap-math.service';

/**
 * 小地图 DOM 元素配置
 */
export interface MinimapElements {
  /** 容器元素 - 固定大小，overflow: hidden */
  container: HTMLElement;
  /** 内容层 - 包含所有节点缩略图的层 */
  contentLayer: HTMLElement;
  /** 视口框 - 代表当前视野的矩形框 */
  viewportRect: HTMLElement;
}

/**
 * 节点位置信息
 */
export interface NodePosition {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 主画布视口信息
 */
export interface MainCanvasViewport {
  /** 视口宽度 */
  width: number;
  /** 视口高度 */
  height: number;
  /** 滚动位置 X（左上角在世界空间中的位置） */
  scrollX: number;
  /** 滚动位置 Y */
  scrollY: number;
}

/**
 * 拖拽会话状态 - 用于同步更新
 */
export interface ReactiveDragSession {
  /** 被拖拽节点的 ID 列表 */
  movingNodeIds: Set<string>;
  /** 静态节点的边界（拖拽期间不变） */
  staticNodesBounds: WorldBounds;
  /** 被拖拽节点的原始边界（拖拽开始时） */
  movingNodesBounds: WorldBounds;
  /** 拖拽起始鼠标位置（世界坐标） */
  dragStartPos: WorldPoint;
  /** 小地图容器尺寸 */
  containerWidth: number;
  containerHeight: number;
}

/**
 * 小地图变换结果 - 用于直接应用 CSS
 */
export interface MinimapTransform {
  /** 内容层缩放比例 */
  globalScale: number;
  /** 内容层平移 X */
  contentTranslateX: number;
  /** 内容层平移 Y */
  contentTranslateY: number;
  /** 视口框宽度 */
  viewportWidth: number;
  /** 视口框高度 */
  viewportHeight: number;
  /** 视口框位置 Left */
  viewportLeft: number;
  /** 视口框位置 Top */
  viewportTop: number;
  /** 新的世界边界 */
  newWorldBounds: WorldBounds;
}

/**
 * ReactiveMinimapService - 响应式小地图服务
 * 
 * 实现"主动驱动"的小地图逻辑：
 * - 主画布的拖拽事件直接映射到小地图的 DOM 元素
 * - 在 drag handler 中同步更新，不等待主画布重新渲染
 * - 内容层 (ContentLayer) 根据新边界缩放
 * - 视口框 (ViewportRect) 根据新比例重新计算位置和大小
 * 
 * 核心算法："Sync-Shrink" 效果
 * 1. 计算假设边界 (Hypothetical Bounds)
 * 2. 推导 "Fit Ratio"
 * 3. 应用 CSS Transforms
 */
@Injectable({
  providedIn: 'root'
})
export class ReactiveMinimapService {
  
  private currentSession: ReactiveDragSession | null = null;
  private elements: MinimapElements | null = null;
  private readonly minimapMath = inject(MinimapMathService);
  
  // ==================== 初始化 ====================
  
  /**
   * 注册小地图 DOM 元素
   * 
   * 组件结构:
   * - Container: 固定大小 (e.g., 200px * 150px), overflow: hidden
   * - ContentLayer: 内部 div，包含节点缩略图
   * - ViewportRect: 绝对定位 div，代表相机视野
   */
  registerElements(elements: MinimapElements): void {
    this.elements = elements;
    
    // 初始化 CSS 属性
    this.initializeStyles();
  }
  
  /**
   * 初始化样式
   */
  private initializeStyles(): void {
    if (!this.elements) return;
    
    const { container, contentLayer, viewportRect } = this.elements;
    
    // Container 样式
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    
    // ContentLayer 样式 - 使用 CSS transform 进行缩放和平移
    contentLayer.style.position = 'absolute';
    contentLayer.style.left = '0';
    contentLayer.style.top = '0';
    contentLayer.style.transformOrigin = '0 0'; // 左上角为变换原点
    contentLayer.style.willChange = 'transform'; // 优化 GPU 加速
    
    // ViewportRect 样式
    viewportRect.style.position = 'absolute';
    viewportRect.style.pointerEvents = 'none'; // 不阻挡事件
    viewportRect.style.willChange = 'left, top, width, height';
  }
  
  /**
   * 注销小地图元素
   */
  unregisterElements(): void {
    this.endDragSession();
    this.elements = null;
  }
  
  // ==================== 拖拽会话管理 ====================
  
  /**
   * 开始拖拽会话
   * 
   * 在拖拽开始时调用，缓存静态节点边界以避免每帧遍历
   * 
   * @param allNodes 所有节点的位置信息
   * @param movingNodeIds 被拖拽节点的 ID 列表
   * @param dragStartPos 拖拽起始鼠标位置（世界坐标）
   */
  startDragSession(
    allNodes: NodePosition[],
    movingNodeIds: string[],
    dragStartPos: WorldPoint
  ): void {
    if (!this.elements) return;
    
    const movingSet = new Set(movingNodeIds);
    
    // 分离静态节点和被拖拽节点
    const staticNodes: NodePosition[] = [];
    const movingNodes: NodePosition[] = [];
    
    for (const node of allNodes) {
      if (movingSet.has(node.id)) {
        movingNodes.push(node);
      } else {
        staticNodes.push(node);
      }
    }
    
    // 计算边界
    const staticNodesBounds = this.calculateNodesBounds(staticNodes);
    const movingNodesBounds = this.calculateNodesBounds(movingNodes);
    
    this.currentSession = {
      movingNodeIds: movingSet,
      staticNodesBounds,
      movingNodesBounds,
      dragStartPos,
      containerWidth: this.elements.container.clientWidth,
      containerHeight: this.elements.container.clientHeight
    };
  }
  
  /**
   * 结束拖拽会话
   */
  endDragSession(): void {
    this.currentSession = null;
  }
  
  // ==================== 核心方法：同步更新小地图 ====================
  
  /**
   * 在拖拽过程中更新小地图 - 核心方法
   * 
   * 这个方法必须在 drag handler 中直接调用（同步执行）
   * 严格禁止：setTimeout、requestAnimationFrame、setState 触发器
   * 
   * 实现 "Sync-Shrink" 效果：
   * 1. 计算 Hypothetical Bounds（假设边界）
   * 2. 推导 Fit Ratio（适配比例）
   * 3. 应用 CSS Transforms（视觉输出）
   * 
   * @param currentDragDelta 当前拖拽增量 { x: currentX - startX, y: currentY - startY }
   * @param mainCanvasViewport 主画布视口信息
   * @returns MinimapTransform 变换结果（可用于调试或额外处理）
   */
  updateMinimapOnDrag(
    currentDragDelta: WorldPoint,
    mainCanvasViewport: MainCanvasViewport
  ): MinimapTransform | null {
    if (!this.currentSession || !this.elements) {
      return null;
    }
    
    const session = this.currentSession;
    const { container: _container, contentLayer, viewportRect } = this.elements;
    
    // ========== Step 1: Calculate Hypothetical Bounds ==========
    
    // 1a. 获取静态节点边界
    const staticBounds = session.staticNodesBounds;
    
    // 1b. 计算被拖拽节点的假设位置
    // hypotheticalMovingBounds = movingNodesBounds + dragDelta
    const hypotheticalMovingBounds: WorldBounds = {
      x: session.movingNodesBounds.x + currentDragDelta.x,
      y: session.movingNodesBounds.y + currentDragDelta.y,
      width: session.movingNodesBounds.width,
      height: session.movingNodesBounds.height
    };
    
    // 1c. 计算 NewWorldBounds = Union(staticBounds, hypotheticalMovingBounds)
    let newWorldBounds: WorldBounds;
    if (staticBounds.width === 0 && staticBounds.height === 0) {
      newWorldBounds = hypotheticalMovingBounds;
    } else if (hypotheticalMovingBounds.width === 0 && hypotheticalMovingBounds.height === 0) {
      newWorldBounds = staticBounds;
    } else {
      newWorldBounds = this.minimapMath.unionBounds(staticBounds, hypotheticalMovingBounds);
    }
    
    // 1d. 确保边界至少包含视口区域
    const viewportBounds: WorldBounds = {
      x: mainCanvasViewport.scrollX,
      y: mainCanvasViewport.scrollY,
      width: mainCanvasViewport.width,
      height: mainCanvasViewport.height
    };
    newWorldBounds = this.minimapMath.unionBounds(newWorldBounds, viewportBounds);
    
    // ========== Step 2: Derive the "Fit Ratio" ==========
    
    const containerWidth = session.containerWidth;
    const containerHeight = session.containerHeight;
    
    // 防止除以零
    const worldWidth = Math.max(newWorldBounds.width, 1);
    const worldHeight = Math.max(newWorldBounds.height, 1);
    
    // ScaleX = MinimapContainerWidth / NewWorldBounds.width
    // ScaleY = MinimapContainerHeight / NewWorldBounds.height
    // GlobalScale = Math.min(ScaleX, ScaleY) - 保持纵横比
    const scaleX = containerWidth / worldWidth;
    const scaleY = containerHeight / worldHeight;
    const globalScale = Math.min(scaleX, scaleY);
    
    // 应用边距（可选，使内容不贴边）
    const padding = 0.1; // 10% 边距
    const effectiveScale = globalScale * (1 - padding * 2);
    
    // ========== Step 3: Apply CSS Transforms ==========
    
    // 3a. 计算内容层的平移量（使内容居中）
    const scaledWorldWidth = worldWidth * effectiveScale;
    const scaledWorldHeight = worldHeight * effectiveScale;
    
    // 内容层需要平移，使世界原点对齐到正确位置
    // translateX = -newWorldBounds.minX * scale + centeringOffset
    const centeringOffsetX = (containerWidth - scaledWorldWidth) / 2;
    const centeringOffsetY = (containerHeight - scaledWorldHeight) / 2;
    
    const contentTranslateX = -newWorldBounds.x * effectiveScale + centeringOffsetX;
    const contentTranslateY = -newWorldBounds.y * effectiveScale + centeringOffsetY;
    
    // 3b. 应用到 ContentLayer
    // 使用 transform 而非 left/top，以获得 GPU 加速
    contentLayer.style.transform = 
      `scale(${effectiveScale}) translate(${contentTranslateX / effectiveScale}px, ${contentTranslateY / effectiveScale}px)`;
    
    // 3c. 计算视口框的尺寸和位置
    // Width = MainCanvasViewportWidth * GlobalScale
    // Height = MainCanvasViewportHeight * GlobalScale
    const viewportWidth = mainCanvasViewport.width * effectiveScale;
    const viewportHeight = mainCanvasViewport.height * effectiveScale;
    
    // Left = (MainCanvasScrollX - NewWorldBounds.minX) * GlobalScale + centeringOffset
    // Top = (MainCanvasScrollY - NewWorldBounds.minY) * GlobalScale + centeringOffset
    const viewportLeft = (mainCanvasViewport.scrollX - newWorldBounds.x) * effectiveScale + centeringOffsetX;
    const viewportTop = (mainCanvasViewport.scrollY - newWorldBounds.y) * effectiveScale + centeringOffsetY;
    
    // 3d. 应用到 ViewportRect
    viewportRect.style.width = `${viewportWidth}px`;
    viewportRect.style.height = `${viewportHeight}px`;
    viewportRect.style.left = `${viewportLeft}px`;
    viewportRect.style.top = `${viewportTop}px`;
    
    // 返回变换结果（可用于调试）
    return {
      globalScale: effectiveScale,
      contentTranslateX,
      contentTranslateY,
      viewportWidth,
      viewportHeight,
      viewportLeft,
      viewportTop,
      newWorldBounds
    };
  }
  
  /**
   * 使用 CSS 变量的替代方法（更灵活）
   * 
   * 这个方法设置 CSS 变量，然后由 CSS 规则消费这些变量
   * 适用于需要在 CSS 中定义动画或过渡的场景
   */
  updateMinimapOnDragWithCSSVariables(
    currentDragDelta: WorldPoint,
    mainCanvasViewport: MainCanvasViewport
  ): MinimapTransform | null {
    if (!this.currentSession || !this.elements) {
      return null;
    }
    
    const session = this.currentSession;
    const { container } = this.elements;
    
    // 计算变换（与上面相同的逻辑）
    const staticBounds = session.staticNodesBounds;
    const hypotheticalMovingBounds: WorldBounds = {
      x: session.movingNodesBounds.x + currentDragDelta.x,
      y: session.movingNodesBounds.y + currentDragDelta.y,
      width: session.movingNodesBounds.width,
      height: session.movingNodesBounds.height
    };
    
    let newWorldBounds = staticBounds.width === 0 ? hypotheticalMovingBounds :
      hypotheticalMovingBounds.width === 0 ? staticBounds :
      this.minimapMath.unionBounds(staticBounds, hypotheticalMovingBounds);
    
    const viewportBounds: WorldBounds = {
      x: mainCanvasViewport.scrollX,
      y: mainCanvasViewport.scrollY,
      width: mainCanvasViewport.width,
      height: mainCanvasViewport.height
    };
    newWorldBounds = this.minimapMath.unionBounds(newWorldBounds, viewportBounds);
    
    const containerWidth = session.containerWidth;
    const containerHeight = session.containerHeight;
    const worldWidth = Math.max(newWorldBounds.width, 1);
    const worldHeight = Math.max(newWorldBounds.height, 1);
    
    const scaleX = containerWidth / worldWidth;
    const scaleY = containerHeight / worldHeight;
    const globalScale = Math.min(scaleX, scaleY) * 0.8; // 80% 以留边距
    
    const scaledWorldWidth = worldWidth * globalScale;
    const scaledWorldHeight = worldHeight * globalScale;
    const centeringOffsetX = (containerWidth - scaledWorldWidth) / 2;
    const centeringOffsetY = (containerHeight - scaledWorldHeight) / 2;
    
    const contentTranslateX = -newWorldBounds.x * globalScale + centeringOffsetX;
    const contentTranslateY = -newWorldBounds.y * globalScale + centeringOffsetY;
    
    const viewportWidth = mainCanvasViewport.width * globalScale;
    const viewportHeight = mainCanvasViewport.height * globalScale;
    const viewportLeft = (mainCanvasViewport.scrollX - newWorldBounds.x) * globalScale + centeringOffsetX;
    const viewportTop = (mainCanvasViewport.scrollY - newWorldBounds.y) * globalScale + centeringOffsetY;
    
    // 设置 CSS 变量到容器元素
    container.style.setProperty('--minimap-scale', String(globalScale));
    container.style.setProperty('--minimap-translate-x', `${contentTranslateX / globalScale}px`);
    container.style.setProperty('--minimap-translate-y', `${contentTranslateY / globalScale}px`);
    container.style.setProperty('--viewport-width', `${viewportWidth}px`);
    container.style.setProperty('--viewport-height', `${viewportHeight}px`);
    container.style.setProperty('--viewport-left', `${viewportLeft}px`);
    container.style.setProperty('--viewport-top', `${viewportTop}px`);
    
    return {
      globalScale,
      contentTranslateX,
      contentTranslateY,
      viewportWidth,
      viewportHeight,
      viewportLeft,
      viewportTop,
      newWorldBounds
    };
  }
  
  // ==================== 非拖拽时的常规更新 ====================
  
  /**
   * 常规更新小地图（非拖拽时）
   * 
   * 用于：
   * - 初始化渲染
   * - 视口平移/缩放
   * - 节点增删改
   */
  updateMinimap(
    allNodes: NodePosition[],
    mainCanvasViewport: MainCanvasViewport
  ): MinimapTransform | null {
    if (!this.elements) return null;
    
    const { container, contentLayer, viewportRect } = this.elements;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    if (containerWidth <= 0 || containerHeight <= 0) return null;
    
    // 计算所有节点的边界
    const contentBounds = this.calculateNodesBounds(allNodes);
    
    // 合并视口边界
    const viewportBounds: WorldBounds = {
      x: mainCanvasViewport.scrollX,
      y: mainCanvasViewport.scrollY,
      width: mainCanvasViewport.width,
      height: mainCanvasViewport.height
    };
    
    const worldBounds = this.minimapMath.unionBounds(contentBounds, viewportBounds);
    
    // 计算缩放
    const worldWidth = Math.max(worldBounds.width, 1);
    const worldHeight = Math.max(worldBounds.height, 1);
    const scaleX = containerWidth / worldWidth;
    const scaleY = containerHeight / worldHeight;
    const globalScale = Math.min(scaleX, scaleY) * 0.8;
    
    // 计算平移
    const scaledWorldWidth = worldWidth * globalScale;
    const scaledWorldHeight = worldHeight * globalScale;
    const centeringOffsetX = (containerWidth - scaledWorldWidth) / 2;
    const centeringOffsetY = (containerHeight - scaledWorldHeight) / 2;
    const contentTranslateX = -worldBounds.x * globalScale + centeringOffsetX;
    const contentTranslateY = -worldBounds.y * globalScale + centeringOffsetY;
    
    // 应用到内容层
    contentLayer.style.transform = 
      `scale(${globalScale}) translate(${contentTranslateX / globalScale}px, ${contentTranslateY / globalScale}px)`;
    
    // 计算视口框
    const viewportWidth = mainCanvasViewport.width * globalScale;
    const viewportHeight = mainCanvasViewport.height * globalScale;
    const viewportLeft = (mainCanvasViewport.scrollX - worldBounds.x) * globalScale + centeringOffsetX;
    const viewportTop = (mainCanvasViewport.scrollY - worldBounds.y) * globalScale + centeringOffsetY;
    
    // 应用到视口框
    viewportRect.style.width = `${viewportWidth}px`;
    viewportRect.style.height = `${viewportHeight}px`;
    viewportRect.style.left = `${viewportLeft}px`;
    viewportRect.style.top = `${viewportTop}px`;
    
    return {
      globalScale,
      contentTranslateX,
      contentTranslateY,
      viewportWidth,
      viewportHeight,
      viewportLeft,
      viewportTop,
      newWorldBounds: worldBounds
    };
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 计算节点列表的边界框
   */
  private calculateNodesBounds(nodes: NodePosition[]): WorldBounds {
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
   * 获取当前拖拽会话状态
   */
  get isDragging(): boolean {
    return this.currentSession !== null;
  }
  
  /**
   * 获取当前元素引用
   */
  get currentElements(): MinimapElements | null {
    return this.elements;
  }
}
