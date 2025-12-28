/**
 * FlowOverviewService - 小地图 (Overview) 管理服务
 * 
 * 从 FlowDiagramService 拆分出的职责：
 * - 小地图实例的创建和销毁
 * - 小地图自动缩放逻辑
 * - 小地图交互事件处理
 * - 视口框拖拽和点击导航
 * 
 * 设计原则：
 * - 依赖 FlowDiagramService 提供主图实例
 * - 依赖 FlowTemplateService 提供模板配置
 * - 保持与 FlowDiagramService 的低耦合
 */

import { Injectable, inject, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { FlowTemplateService } from './flow-template.service';
import { MinimapMathService } from '../../../../services/minimap-math.service';
import * as go from 'gojs';

/**
 * Overview 配置选项
 */
export interface OverviewOptions {
  /** 是否为移动端 */
  isMobile: boolean;
  /** 初始缩放比例 */
  initialScale?: number;
}

/**
 * Overview 状态
 */
export interface OverviewState {
  /** 当前缩放比例 */
  scale: number;
  /** 是否正在交互（拖拽视口框） */
  isInteracting: boolean;
  /** 是否正在拖拽视口框 */
  isBoxDragging: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class FlowOverviewService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowOverview');
  private readonly zone = inject(NgZone);
  private readonly templateService = inject(FlowTemplateService);
  private readonly minimapMath = inject(MinimapMathService);

  // ========== Overview 核心实例 ==========
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private observedDiagram: go.Diagram | null = null;
  
  // ========== Overview 缩放状态 ==========
  private lastOverviewScale: number = 0.1;
  private overviewUpdatePending: boolean = false;
  private overviewBoundsCache: string = '';
  private isApplyingOverviewViewportUpdate: boolean = false;
  private overviewUpdateQueuedWhileApplying: boolean = false;
  private overviewScheduleUpdate: ((source: 'viewport' | 'document') => void) | null = null;
  
  // ========== Overview 交互状态 ==========
  private isOverviewInteracting: boolean = false;
  private overviewInteractionLastApplyAt = 0;
  private overviewPointerCleanup: (() => void) | null = null;
  
  // ========== Overview 调试日志 ==========
  private overviewDebugLastLogAt = 0;
  private overviewDebugSuppressedCount = 0;
  private overviewDebugUpdateCalls = 0;
  
  // ========== Overview 事件监听器引用 ==========
  private overviewDocumentBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewViewportBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  
  // ========== Overview 视口轮询 ==========
  private overviewViewportPollRafId: number | null = null;
  private overviewViewportPollLastKey: string = '';
  
  // ========== Overview 拖拽状态 ==========
  private isOverviewBoxDragging = false;
  private overviewBoxViewportBounds: go.Rect | null = null;
  private overviewDragDebugLastLogAt = 0;
  
  // ========== ResizeObserver ==========
  private overviewResizeObserver: ResizeObserver | null = null;
  
  // ========== 节流定时器 ==========
  private throttledUpdateBindingsTimer: ReturnType<typeof setTimeout> | null = null;
  private throttledUpdateBindingsPending = false;
  
  // ========== 销毁标记 ==========
  private isDestroyed = false;

  // ========== 公开属性 ==========
  
  get overviewInstance(): go.Overview | null {
    return this.overview;
  }
  
  get isInitialized(): boolean {
    return this.overview !== null && !this.isDestroyed;
  }
  
  get state(): OverviewState {
    return {
      scale: this.lastOverviewScale,
      isInteracting: this.isOverviewInteracting,
      isBoxDragging: this.isOverviewBoxDragging
    };
  }

  // ========== 生命周期方法 ==========
  
  /**
   * 初始化小地图
   * @param container 小地图容器 DOM 元素
   * @param diagram 主图实例
   * @param options 配置选项
   */
  initialize(container: HTMLDivElement, diagram: go.Diagram, options: OverviewOptions): void {
    if (!diagram) {
      this.logger.error('初始化 Overview 失败：主图实例为空');
      return;
    }
    
    this.isDestroyed = false;
    this.observedDiagram = diagram;
    
    if (this.overview) {
      this.dispose();
    }
    
    this.overviewContainer = container;
    this.overviewBoundsCache = '';
    this.isOverviewInteracting = false;
    this.overviewInteractionLastApplyAt = 0;
    this.overviewScheduleUpdate = null;
    
    // 使用 requestAnimationFrame 确保 DOM 布局完成后再初始化
    requestAnimationFrame(() => {
      if (this.isDestroyed || !this.observedDiagram) return;
      
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      
      if (containerWidth <= 0 || containerHeight <= 0) {
        this.logger.warn(`Overview 容器尺寸无效: ${containerWidth}x${containerHeight}，延迟重试`);
        setTimeout(() => this.initialize(container, diagram, options), 100);
        return;
      }
      
      try {
        const overviewBackground = this.getOverviewBackgroundColor();
        container.style.backgroundColor = overviewBackground;
        
        container.style.width = `${containerWidth}px`;
        container.style.height = `${containerHeight}px`;
        container.style.position = 'relative';
        container.style.overflow = 'hidden';
        
        const $ = go.GraphObject.make;
        this.overview = $(go.Overview, container, {
          contentAlignment: go.Spot.Center,
          "animationManager.isEnabled": false,
          "computePixelRatio": () => window.devicePixelRatio || 1,
          "initialViewportSpot": go.Spot.Center,
          "initialScale": options.initialScale ?? 0.15
        });
        
        // 委托给 FlowTemplateService 设置 Overview 模板
        this.templateService.setupOverviewNodeTemplate(this.overview);
        this.templateService.setupOverviewLinkTemplate(this.overview);
        
        this.overview.observed = diagram;
        
        // 设置视口框样式
        this.templateService.setupOverviewBoxStyle(this.overview, options.isMobile);
        
        this.overview.scale = options.initialScale ?? 0.15;
        this.lastOverviewScale = options.initialScale ?? 0.15;
        
        this.attachPointerListeners(container);
        this.setupAutoScale();
        this.setupResizeObserver(container);
        
        // 强制刷新
        diagram.requestUpdate();
        this.overview.requestUpdate();
        
        const nodeCount = diagram.nodes.count;
        const linkCount = diagram.links.count;
        this.logger.info(`Overview 初始化成功 - 尺寸: ${containerWidth}x${containerHeight}, 节点数: ${nodeCount}, 连接数: ${linkCount}`);
        
      } catch (error) {
        this.logger.error('Overview 初始化失败:', error);
      }
    });
  }
  
  /**
   * 销毁小地图
   */
  dispose(): void {
    this.isDestroyed = true;
    
    // 移除 DiagramListener
    if (this.observedDiagram) {
      if (this.overviewDocumentBoundsChangedHandler) {
        this.observedDiagram.removeDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
        this.overviewDocumentBoundsChangedHandler = null;
      }
      if (this.overviewViewportBoundsChangedHandler) {
        this.observedDiagram.removeDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
        this.overviewViewportBoundsChangedHandler = null;
      }
    }
    
    // 清理 ResizeObserver
    if (this.overviewResizeObserver) {
      this.overviewResizeObserver.disconnect();
      this.overviewResizeObserver = null;
    }
    
    // 清理 rAF 轮询
    if (this.overviewViewportPollRafId !== null) {
      cancelAnimationFrame(this.overviewViewportPollRafId);
      this.overviewViewportPollRafId = null;
    }
    this.overviewViewportPollLastKey = '';
    
    // 清理拖拽状态
    this.isOverviewBoxDragging = false;
    this.overviewBoxViewportBounds = null;
    
    // 清理节流定时器
    if (this.throttledUpdateBindingsTimer) {
      clearTimeout(this.throttledUpdateBindingsTimer);
      this.throttledUpdateBindingsTimer = null;
    }
    this.throttledUpdateBindingsPending = false;
    
    // 清理 Pointer 监听器
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }
    
    this.overviewScheduleUpdate = null;
    
    if (this.overview) {
      this.overview.div = null;
      this.overview = null;
    }
    
    this.overviewContainer = null;
    this.observedDiagram = null;
  }
  
  /**
   * 刷新 Overview 渲染
   */
  refresh(): void {
    if (!this.overview || !this.overviewContainer || this.isDestroyed) return;
    
    try {
      this.overview.requestUpdate();
      
      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;
      
      if (containerWidth > 0 && containerHeight > 0 && this.observedDiagram) {
        const docBounds = this.observedDiagram.documentBounds;
        if (docBounds.isReal() && docBounds.width > 0 && docBounds.height > 0) {
          const padding = 0.1;
          const scaleX = (containerWidth * (1 - padding * 2)) / docBounds.width;
          const scaleY = (containerHeight * (1 - padding * 2)) / docBounds.height;
          const newScale = Math.max(0.02, Math.min(0.5, Math.min(scaleX, scaleY)));
          
          this.overview.scale = newScale;
          this.lastOverviewScale = newScale;
          
          this.logger.debug(`Overview 已刷新 - 容器尺寸: ${containerWidth}x${containerHeight}, scale: ${newScale}`);
        }
      }
    } catch (error) {
      this.logger.error('刷新 Overview 失败:', error);
    }
  }
  
  /**
   * 设置 Overview 的固定边界
   */
  setFixedBounds(bounds: go.Rect | null): void {
    if (!this.overview) return;
    (this.overview as any).fixedBounds = bounds ?? new go.Rect(NaN, NaN, NaN, NaN);
  }

  // ========== 私有方法 ==========
  
  private getOverviewBackgroundColor(): string {
    return this.readCssColorVar('--theme-text-dark') ?? '#292524';
  }
  
  private readCssColorVar(varName: string): string | null {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;
      const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return value || null;
    } catch {
      return null;
    }
  }
  
  /**
   * 设置自动缩放
   */
  private setupAutoScale(): void {
    if (!this.observedDiagram || !this.overview) return;
    
    const diagram = this.observedDiagram;
    const overview = this.overview;
    
    const getNodesBounds = (): go.Rect => {
      const docBounds = diagram.documentBounds;
      if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
        return new go.Rect(-250, -250, 500, 500);
      }
      const padding = 80;
      return new go.Rect(
        docBounds.x - padding,
        docBounds.y - padding,
        docBounds.width + padding * 2,
        docBounds.height + padding * 2
      );
    };
    
    const calculateBaseScale = (): number => {
      if (!this.overviewContainer) return 0.15;
      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;
      const nodeBounds = getNodesBounds();
      if (containerWidth <= 0 || containerHeight <= 0) return 0.15;
      const padding = 0.1;
      const scaleX = (containerWidth * (1 - padding * 2)) / nodeBounds.width;
      const scaleY = (containerHeight * (1 - padding * 2)) / nodeBounds.height;
      return Math.min(scaleX, scaleY, 0.35);
    };
    
    const clampScale = (scale: number): number => {
      return Math.max(1e-4, Math.min(0.5, scale));
    };
    
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    
    const SCALE_LERP_FACTOR_SHRINK = 0.45;
    const SCALE_LERP_FACTOR_GROW = 0.18;
    
    const smartLerp = (current: number, target: number): number => {
      if (current / target > 2 || target / current > 2) {
        return target;
      }
      const t = target < current ? SCALE_LERP_FACTOR_SHRINK : SCALE_LERP_FACTOR_GROW;
      return lerp(current, target, t);
    };
    
    const baseScale = calculateBaseScale();
    this.lastOverviewScale = clampScale(baseScale);
    overview.scale = this.lastOverviewScale;
    
    const nodeBounds = getNodesBounds();
    overview.centerRect(nodeBounds);
    
    // 简化版 - 详细逻辑保留在 FlowDiagramService 中过渡
    // TODO: 后续迭代将完整的 calculateExtendedBounds 和 scheduleUpdate 逻辑迁移至此
  }
  
  private setupResizeObserver(container: HTMLDivElement): void {
    if (this.overviewResizeObserver) {
      this.overviewResizeObserver.disconnect();
    }
    
    this.overviewResizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (this.isDestroyed || !this.overview) return;
        this.refresh();
      });
    });
    
    this.overviewResizeObserver.observe(container);
  }
  
  /**
   * 绑定 Pointer 事件监听
   */
  private attachPointerListeners(container: HTMLDivElement): void {
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }
    
    // 简化版 - 核心交互逻辑保留在 FlowDiagramService 过渡
    // TODO: 后续迭代将完整的指针事件处理迁移至此
    
    const handlePointerDown = (e: PointerEvent) => {
      this.isOverviewInteracting = true;
      this.overviewInteractionLastApplyAt = Date.now();
    };
    
    const handlePointerUp = () => {
      this.isOverviewInteracting = false;
    };
    
    this.zone.runOutsideAngular(() => {
      container.addEventListener('pointerdown', handlePointerDown);
      container.addEventListener('pointerup', handlePointerUp);
      container.addEventListener('pointercancel', handlePointerUp);
    });
    
    this.overviewPointerCleanup = () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointerup', handlePointerUp);
      container.removeEventListener('pointercancel', handlePointerUp);
    };
  }
}
