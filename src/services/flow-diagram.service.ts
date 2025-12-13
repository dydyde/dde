import { Injectable, inject, signal, NgZone, ElementRef } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { Task, Project } from '../models';
import { environment } from '../environments/environment';
import { GOJS_CONFIG, UI_CONFIG } from '../config/constants';
import * as go from 'gojs';

/**
 * GoJS Diagram 监听器信息
 */
interface DiagramListener {
  name: go.DiagramEventName;
  handler: (e: any) => void;
}

/**
 * 视图状态（用于保存/恢复）
 */
interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}

/**
 * 节点点击回调
 */
export interface NodeClickCallback {
  (taskId: string, isDoubleClick: boolean): void;
}

/**
 * 连接线点击回调
 */
export interface LinkClickCallback {
  (linkData: any, x: number, y: number): void;
}

/**
 * 连接手势回调
 */
export interface LinkGestureCallback {
  (sourceId: string, targetId: string, x: number, y: number, link: any): void;
}

/**
 * 选择移动完成回调
 */
export interface SelectionMovedCallback {
  (movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>): void;
}

/**
 * FlowDiagramService - GoJS 图表核心服务
 * 
 * 职责：
 * - GoJS Diagram 实例的生命周期管理
 * - 节点和连接线模板配置
 * - 缩放、平移、布局操作
 * - 图表数据更新
 * - 事件监听器管理
 * 
 * 设计原则：
 * - 封装所有 GoJS 相关操作
 * - 通过回调与组件通信，保持解耦
 * - 统一管理事件监听器，防止内存泄漏
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramService {
  private readonly store = inject(StoreService);
  private readonly logger = inject(LoggerService).category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly configService = inject(FlowDiagramConfigService);
  
  // ========== 内部状态 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  private diagramListeners: DiagramListener[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;
  
  // ========== 小地图状态 ==========
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private lastOverviewScale: number = 0.1;
  private isNodeDragging: boolean = false;

  private readCssColorVar(varName: string): string | null {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;
      const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private getOverviewBackgroundColor(): string {
    const styles = this.configService.currentStyles();
    // 概览图需要让“白色/浅色任务块”清晰可见，因此背景使用更深的主题色。
    return this.readCssColorVar('--theme-text-dark') ?? styles.text.titleColor ?? '#292524';
  }
  
  // ========== 定时器 ==========
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 首次加载标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;  // 避免重复打印日志
  
  // ========== 回调函数 ==========
  private nodeClickCallback: NodeClickCallback | null = null;
  private linkClickCallback: LinkClickCallback | null = null;
  private linkGestureCallback: LinkGestureCallback | null = null;
  private selectionMovedCallback: SelectionMovedCallback | null = null;
  private backgroundClickCallback: (() => void) | null = null;
  
  // ========== 公开信号 ==========
  /** 初始化错误信息 */
  readonly error = signal<string | null>(null);
  
  // ========== 公开属性 ==========
  
  /** 获取 GoJS Diagram 实例（只读访问） */
  get diagramInstance(): go.Diagram | null {
    return this.diagram;
  }
  
  /** 是否已初始化 */
  get isInitialized(): boolean {
    return this.diagram !== null && !this.isDestroyed;
  }
  
  // ========== 回调注册 ==========
  
  /** 注册节点点击回调 */
  onNodeClick(callback: NodeClickCallback): void {
    this.nodeClickCallback = callback;
  }
  
  /** 注册连接线点击回调 */
  onLinkClick(callback: LinkClickCallback): void {
    this.linkClickCallback = callback;
  }
  
  /** 注册连接手势回调（绘制/重连连接线） */
  onLinkGesture(callback: LinkGestureCallback): void {
    this.linkGestureCallback = callback;
  }
  
  /** 注册选择移动完成回调 */
  onSelectionMoved(callback: SelectionMovedCallback): void {
    this.selectionMovedCallback = callback;
  }
  
  /** 注册背景点击回调 */
  onBackgroundClick(callback: () => void): void {
    this.backgroundClickCallback = callback;
  }
  
  // ========== 生命周期方法 ==========
  
  /**
   * 初始化 GoJS Diagram
   * @param container 图表容器元素
   * @returns 是否初始化成功
   */
  initialize(container: HTMLDivElement): boolean {
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载', 'GoJS library not loaded');
      return false;
    }
    
    try {
      this.isDestroyed = false;
      this.isFirstLoad = true; // 重置首次加载标志
      this.diagramDiv = container;
      
      // 注入 GoJS License Key
      if (environment.gojsLicenseKey) {
        (go.Diagram as any).licenseKey = environment.gojsLicenseKey;
      }
      
      const $ = go.GraphObject.make;
      
      // 创建 Diagram 实例
      this.diagram = $(go.Diagram, container, {
        "undoManager.isEnabled": false,
        "animationManager.isEnabled": false,
        "allowDrop": true,
        layout: $(go.Layout), // 无操作布局，保持用户位置
        "autoScale": go.Diagram.None,
        "initialAutoScale": go.Diagram.None,
        // 关键：设置非常大的滚动边距，实现"无限画布"效果
        "scrollMargin": new go.Margin(5000, 5000, 5000, 5000),
        "draggingTool.isGridSnapEnabled": false,
        // 禁用固定边界，允许无限滚动
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
        // 高 DPI 屏幕优化：使用设备像素比确保清晰渲染
        "computePixelRatio": () => window.devicePixelRatio || 1
      });
      
      // 设置节点模板
      this.setupNodeTemplate($);
      
      // 设置连接线模板
      this.setupLinkTemplate($);
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',  // ⚠️ 关键：告诉 GoJS 我们用 fromPortId 存储端口信息
        linkToPortIdProperty: 'toPortId'       // ⚠️ 关键：告诉 GoJS 我们用 toPortId 存储端口信息
      });
      
      // 设置事件监听器
      this.setupEventListeners();
      
      // 设置 ResizeObserver
      this.setupResizeObserver();
      
      // 恢复视图状态
      this.restoreViewState();
      
      // 清除错误状态
      this.error.set(null);
      
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图 (Overview)
   * 
   * ========== 核心设计理念：热力图效果 ==========
   * 
   * GoJS Overview 支持自定义模板！虽然它共享主图的 Model 数据，
   * 但可以使用独立的模板来渲染，实现"热力图"视觉效果。
   * 
   * 方案：
   * - 为 Overview 定义"特供版"节点模板：去掉文字，只留彩色色块
   * - 为 Overview 定义"特供版"连线模板：极粗线条，形成"路网"感
   * - 保留原生视口框交互功能（拖动框 -> 主图滚动）
   * 
   * 【关键】：模板必须在设置 observed 之前定义！
   */
  initializeOverview(container: HTMLDivElement): void {
    if (!this.diagram || this.isDestroyed) return;
    
    // 如果已经有 Overview，先销毁它
    if (this.overview) {
      this.disposeOverview();
    }
    
    this.overviewContainer = container;
    
    try {
      const $ = go.GraphObject.make;

      const overviewBackground = this.getOverviewBackgroundColor();
      const styles = this.configService.currentStyles();
      // 保底：即使 GoJS canvas 透明，也能有一致的背景。
      container.style.backgroundColor = overviewBackground;
      
      
      // ========== 1. 创建 Overview（先不设置 observed）==========
      this.overview = $(go.Overview, container, {
        contentAlignment: go.Spot.Center,
        "animationManager.isEnabled": false,
        // 高 DPI 屏幕优化：使用设备像素比确保清晰渲染，解决模糊问题
        "computePixelRatio": () => window.devicePixelRatio || 1
      });
      
      // 注意：GoJS Overview 不支持 background 属性
      // 背景色已经通过 container.style.backgroundColor 设置，这就足够了
      
      // ========== 2.【关键】先定义模板，再设置 observed ==========
      // Overview 专用节点模板：去掉文字，只留色块
      this.overview.nodeTemplate = $(go.Node, "Spot",
        {
          locationSpot: go.Spot.Center,
          // 确保节点在概览图中有最小可见尺寸
          minSize: new go.Size(4, 4)
        },
        new go.Binding("location", "loc", go.Point.parse),
        $(go.Shape, "Rectangle",
          {
            name: "SHAPE",
            // 注意：Overview 会整体缩放；如果这里使用太小的固定尺寸，
            // 当图的边界很大/Overview 缩放很小时，节点会缩小到不可见。
            // 使用更大的固定尺寸以确保在缩放后仍然可见
            height: 80,
            strokeWidth: 3,  // 增加描边宽度，确保在小缩放下仍可见
            opacity: 1
          },
          // 宽度与主图保持一致（更利于在小缩放下保持可见）
          new go.Binding("width", "isUnassigned", (isUnassigned: boolean) =>
            isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH
          ),
          // 绑定任务节点颜色（白色/已完成色等），提高与深背景的对比度
          new go.Binding("fill", "color", (color: string) => color || "#ffffff"),
          new go.Binding("stroke", "borderColor", (color: string) => color || styles.node.defaultBorder)
        )
      );
      
      // Overview 专用连线模板：加粗线条，形成"路网"感
      this.overview.linkTemplate = $(go.Link,
        {
          routing: go.Link.Normal,  // 简化路由，提升性能
          curve: go.Link.None       // 直线，减少计算
        },
        $(go.Shape,
          {
            strokeWidth: 12,        // 增加线宽，确保在概览图中清晰可见
            opacity: 0.8            // 适当增加不透明度，提高可见性
          },
          // 连线用类型色（父子/跨树）
          new go.Binding("stroke", "isCrossTree", (isCrossTree: boolean) =>
            isCrossTree ? styles.link.crossTreeColor : styles.link.parentChildColor
          )
        )
      );
      
      // ========== 3.【关键】模板设置完成后，再绑定观察的图表 ==========
      this.overview.observed = this.diagram;
      
      // 强制更新概览图以确保所有节点正确渲染
      // 某些情况下 GoJS 可能需要手动触发更新才能正确显示节点
      if (this.diagram) {
        this.diagram.requestUpdate();
      }
      if (this.overview) {
        this.overview.requestUpdate();
      }
      
      // ========== 4. 自定义视口框样式 ==========
      // 原生的视口框依然存在且可用，只是改变样式
      const box = this.overview.box;
      if (box && box.elt(0)) {
        (box.elt(0) as go.Shape).stroke = "#ffffff";
        (box.elt(0) as go.Shape).strokeWidth = 2;
        (box.elt(0) as go.Shape).fill = "rgba(255, 255, 255, 0.15)";
      }
      
      // 设置初始缩放
      this.overview.scale = 0.15;
      this.lastOverviewScale = 0.15;
      
      // 启用自动缩放逻辑
      this.setupOverviewAutoScale();
      
      // 记录概览图初始化的调试信息
      const nodeCount = this.diagram.nodes.count;
      const linkCount = this.diagram.links.count;
      this.logger.info(`Overview 热力图模式初始化成功 - 节点数: ${nodeCount}, 连接数: ${linkCount}, 初始缩放: ${this.overview.scale}`);
    } catch (error) {
      this.logger.error('Overview 初始化失败:', error);
    }
  }
  
  /**
   * 设置小地图自动缩放
   * 
   * 核心逻辑：
   * 1. 初始化时计算一个固定的基准缩放（baseScale）
   * 2. 在节点范围内缩放时，保持 baseScale 不变，视口框自然变化
   * 3. 只在视口超出节点边界时，才按比例缩小 overview.scale
   */
  private setupOverviewAutoScale(): void {
    if (!this.diagram || !this.overview) return;
    
    // 获取实际节点边界
    const getNodesBounds = (): go.Rect => {
      if (!this.diagram) return new go.Rect(0, 0, 500, 500);
      
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let hasNodes = false;
      
      this.diagram.nodes.each((node: go.Node) => {
        if (node.actualBounds.isReal()) {
          hasNodes = true;
          minX = Math.min(minX, node.actualBounds.x);
          minY = Math.min(minY, node.actualBounds.y);
          maxX = Math.max(maxX, node.actualBounds.right);
          maxY = Math.max(maxY, node.actualBounds.bottom);
        }
      });
      
      if (!hasNodes) {
        return new go.Rect(-250, -250, 500, 500);
      }
      
      const padding = 80;
      return new go.Rect(minX - padding, minY - padding, 
                         maxX - minX + padding * 2, maxY - minY + padding * 2);
    };
    
    // 计算基准缩放（只在初始化和节点变化时调用）
    const calculateBaseScale = (): number => {
      if (!this.overviewContainer || !this.diagram) return 0.15;
      
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
      // 保证最小可见性：避免用户把主视口拖到很远的空白区域时，把概览图缩到“全黑看不到块”。
      return Math.max(0.02, Math.min(0.5, scale));
    };
    
    // 初始化：计算并设置固定的基准缩放
    let baseScale = calculateBaseScale();
    let lastNodeDataCount = ((this.diagram.model as any)?.nodeDataArray?.length ?? 0);
    this.lastOverviewScale = clampScale(baseScale);
    this.overview.scale = this.lastOverviewScale;
    
    // 确保初始时 Overview 正确居中到文档内容
    const nodeBounds = getNodesBounds();
    this.overview.centerRect(nodeBounds);
    
    // 记录初始化信息用于调试
    this.logger.debug(`Overview 自动缩放初始化 - 节点数: ${lastNodeDataCount}, 基准缩放: ${baseScale.toFixed(3)}, 实际缩放: ${this.lastOverviewScale.toFixed(3)}, 节点边界: ${nodeBounds.toString()}`);
    
    // 监听文档变化：只在节点增删时重新计算基准缩放
    this.addTrackedListener('DocumentBoundsChanged', () => {
      if (!this.overview || !this.diagram) return;

      const currentNodeDataCount = ((this.diagram.model as any)?.nodeDataArray?.length ?? 0);
      const nodeCountChanged = currentNodeDataCount !== lastNodeDataCount;
      
      const newBaseScale = calculateBaseScale();
      // 只有变化显著、或节点数量发生变化（新增/删除）时才更新。
      if (nodeCountChanged || Math.abs(newBaseScale - baseScale) > 0.02) {
        baseScale = newBaseScale;
        this.overview.scale = clampScale(baseScale);
        this.lastOverviewScale = this.overview.scale;

        // 关键：节点结构变化后，重新居中到所有节点边界，避免“新任务块在概览图里看不到”。
        if (nodeCountChanged) {
          const bounds = getNodesBounds();
          this.overview.centerRect(bounds);
          lastNodeDataCount = currentNodeDataCount;
        }
      }
    });
    
    // 监听视口变化：实现丝滑的自动缩放效果
    // 当用户缩放或移动主视图时，如果视口超出节点边界，概览图会自动缩小以显示完整范围
    this.addTrackedListener('ViewportBoundsChanged', () => {
      if (!this.overview || !this.diagram || this.isNodeDragging) return;
      
      const viewportBounds = this.diagram.viewportBounds;
      if (!viewportBounds.isReal()) return;
      
      // 计算总边界（文档 + 视口的并集）
      const totalBounds = this.calculateTotalBounds();
      const nodeBounds = getNodesBounds();
      
      // 检查视口是否超出节点边界
      const isViewportOutside = 
        viewportBounds.x < nodeBounds.x - 50 ||
        viewportBounds.y < nodeBounds.y - 50 ||
        viewportBounds.right > nodeBounds.right + 50 ||
        viewportBounds.bottom > nodeBounds.bottom + 50;
      
      if (this.overviewContainer) {
        const containerWidth = this.overviewContainer.clientWidth;
        const containerHeight = this.overviewContainer.clientHeight;
        
        if (containerWidth > 0 && containerHeight > 0 && totalBounds.width > 0 && totalBounds.height > 0) {
          // 计算需要显示的范围：取节点边界和总边界中较大的
          // 这确保了即使视口在节点范围内，视口框也不会超出容器
          const displayBounds = isViewportOutside ? totalBounds : nodeBounds;
          
          // 额外检查：确保视口框本身不会超出容器
          // 计算视口框在当前缩放下的尺寸
          const currentScale = this.overview.scale;
          const viewportBoxWidth = viewportBounds.width * currentScale;
          const viewportBoxHeight = viewportBounds.height * currentScale;
          
          // 如果视口框接近或超出容器尺寸，强制缩小
          const boxPadding = 20; // 视口框距离容器边缘的最小距离
          const needsShrinkForBox = 
            viewportBoxWidth > containerWidth - boxPadding ||
            viewportBoxHeight > containerHeight - boxPadding;
          
          if (isViewportOutside || needsShrinkForBox) {
            // 计算合适的缩放比例
            const padding = 0.15; // 增加边距以确保视口框有足够空间
            const scaleX = (containerWidth * (1 - padding * 2)) / displayBounds.width;
            const scaleY = (containerHeight * (1 - padding * 2)) / displayBounds.height;
            let targetScale = clampScale(Math.min(scaleX, scaleY, 0.5));
            
            // 二次检查：确保在新缩放下，视口框不会超出
            const newViewportBoxWidth = viewportBounds.width * targetScale;
            const newViewportBoxHeight = viewportBounds.height * targetScale;
            
            if (newViewportBoxWidth > containerWidth - boxPadding) {
              targetScale = Math.min(targetScale, (containerWidth - boxPadding) / viewportBounds.width);
            }
            if (newViewportBoxHeight > containerHeight - boxPadding) {
              targetScale = Math.min(targetScale, (containerHeight - boxPadding) / viewportBounds.height);
            }
            
            targetScale = clampScale(targetScale);
            
            // 丝滑过渡：如果缩放变化超过阈值，才更新
            if (Math.abs(targetScale - this.overview.scale) > 0.005) {
              this.overview.scale = targetScale;
              this.lastOverviewScale = targetScale;
            }
          } else {
            // 视口在节点范围内且视口框不会超出，恢复基准缩放
            const currentScale = this.overview.scale;
            const targetScale = clampScale(baseScale);
            
            // 但仍需确保视口框不超出
            const testBoxWidth = viewportBounds.width * targetScale;
            const testBoxHeight = viewportBounds.height * targetScale;
            
            let finalScale = targetScale;
            if (testBoxWidth > containerWidth - boxPadding) {
              finalScale = Math.min(finalScale, (containerWidth - boxPadding) / viewportBounds.width);
            }
            if (testBoxHeight > containerHeight - boxPadding) {
              finalScale = Math.min(finalScale, (containerHeight - boxPadding) / viewportBounds.height);
            }
            
            finalScale = clampScale(finalScale);
            
            // 如果当前缩放小于目标缩放，逐渐恢复
            if (currentScale < finalScale - 0.01) {
              this.overview.scale = finalScale;
              this.lastOverviewScale = finalScale;
            }
          }
        }
      }
    });
    
    this.logger.debug('Overview 自动缩放已启用');
  }
  
  /**
   * 计算仅基于文档边界的缩放比例（不考虑视口超出部分）
   */
  private calculateDocumentOnlyScale(): number | null {
    if (!this.overview || !this.diagram || !this.overviewContainer) return null;
    
    const container = this.overviewContainer;
    const minimapWidth = container.clientWidth;
    const minimapHeight = container.clientHeight;
    
    if (minimapWidth <= 0 || minimapHeight <= 0) return null;
    
    const docBounds = this.diagram.documentBounds;
    if (!docBounds.isReal() || docBounds.width <= 0 || docBounds.height <= 0) {
      return 0.1; // 默认值
    }
    
    // 计算合适的缩放比例（留出 10% 边距）
    const padding = 0.1;
    const effectiveWidth = minimapWidth * (1 - padding * 2);
    const effectiveHeight = minimapHeight * (1 - padding * 2);
    
    const scaleX = effectiveWidth / docBounds.width;
    const scaleY = effectiveHeight / docBounds.height;
    
    const scale = Math.min(scaleX, scaleY, 0.5);
    return Math.max(0.005, scale);
  }
  
  /**
   * 计算目标缩放比例
   */
  private calculateTargetScale(): number | null {
    if (!this.overview || !this.diagram || !this.overviewContainer) return null;
    
    const container = this.overviewContainer;
    const minimapWidth = container.clientWidth;
    const minimapHeight = container.clientHeight;
    
    if (minimapWidth <= 0 || minimapHeight <= 0) return null;
    
    // 计算总边界（文档 + 视口的并集）
    const totalBounds = this.calculateTotalBounds();
    if (totalBounds.width <= 0 || totalBounds.height <= 0) return null;
    
    // 计算合适的缩放比例（留出 10% 边距）
    const padding = 0.1;
    const effectiveWidth = minimapWidth * (1 - padding * 2);
    const effectiveHeight = minimapHeight * (1 - padding * 2);
    
    const scaleX = effectiveWidth / totalBounds.width;
    const scaleY = effectiveHeight / totalBounds.height;
    const scale = Math.min(scaleX, scaleY, 0.5); // 最大 0.5
    
    return Math.max(0.005, scale); // 最小 0.005
  }
  
  /**
   * 更新小地图缩放比例（保留用于直接调用）
   */
  private updateOverviewScale(): void {
    const scale = this.calculateTargetScale();
    if (scale !== null && this.overview) {
      this.overview.scale = scale;
      this.lastOverviewScale = scale;
    }
  }
  
  /**
   * 计算总边界（文档边界 + 视口边界的并集）
   * 
   * 这确保了当视口拖到文档外部时，小地图会扩大显示范围
   */
  private calculateTotalBounds(): go.Rect {
    if (!this.diagram) return new go.Rect(0, 0, 100, 100);
    
    const docBounds = this.diagram.documentBounds;
    const viewBounds = this.diagram.viewportBounds;
    
    // 如果文档为空，使用视口边界
    if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
      return viewBounds.copy();
    }
    
    // 计算并集
    const minX = Math.min(docBounds.x, viewBounds.x);
    const minY = Math.min(docBounds.y, viewBounds.y);
    const maxX = Math.max(docBounds.x + docBounds.width, viewBounds.x + viewBounds.width);
    const maxY = Math.max(docBounds.y + docBounds.height, viewBounds.y + viewBounds.height);
    
    return new go.Rect(minX, minY, maxX - minX, maxY - minY);
  }
  
  /**
   * 销毁小地图
   */
  disposeOverview(): void {
    if (this.overview) {
      this.overview.div = null;
      this.overview = null;
    }
    this.overviewContainer = null;
  }
  
  /**
   * 销毁 Diagram 实例和相关资源
   */
  dispose(): void {
    this.isDestroyed = true;
    this.isFirstLoad = true; // 重置首次加载标志
    
    // 清理小地图
    this.disposeOverview();
    
    // 清理定时器
    this.clearAllTimers();
    
    // 清理 ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // 清理事件监听器
    if (this.diagram) {
      for (const listener of this.diagramListeners) {
        try {
          this.diagram.removeDiagramListener(listener.name, listener.handler);
        } catch (e) {
          // 忽略移除失败的错误
        }
      }
      this.diagramListeners = [];
      
      // 清理 Diagram
      this.diagram.div = null;
      this.diagram.clear();
      this.diagram = null;
    }
    
    this.diagramDiv = null;
    
    // 清理回调
    this.nodeClickCallback = null;
    this.linkClickCallback = null;
    this.linkGestureCallback = null;
    this.selectionMovedCallback = null;
    this.backgroundClickCallback = null;
    
    this.logger.info('GoJS Diagram 已销毁');
  }
  
  // ========== 图表操作方法 ==========
  
  /**
   * 放大
   */
  zoomIn(): void {
    if (this.diagram) {
      this.diagram.commandHandler.increaseZoom();
    }
  }
  
  /**
   * 缩小
   */
  zoomOut(): void {
    if (this.diagram) {
      this.diagram.commandHandler.decreaseZoom();
    }
  }
  
  /**
   * 导出为 PNG 图片
   * @returns Promise<Blob | null> 图片 Blob 或 null
   */
  async exportToPng(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      // 使用 GoJS 的 makeImageData 方法生成 base64 图片
      const imgData = this.diagram.makeImageData({
        scale: 2, // 2x 分辨率，更清晰
        background: '#F5F2E9', // 使用流程图背景色
        type: 'image/png',
        maxSize: new go.Size(4096, 4096) // 限制最大尺寸
      }) as string;
      
      if (!imgData) {
        this.toast.error('导出失败', '无法生成图片');
        return null;
      }
      
      // 将 base64 转换为 Blob
      const response = await fetch(imgData);
      const blob = await response.blob();
      
      // 触发下载
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.toast.success('导出成功', 'PNG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 PNG 失败', error);
      this.toast.error('导出失败', '生成图片时发生错误');
      return null;
    }
  }
  
  /**
   * 导出为 SVG 图片
   * @returns Promise<Blob | null> SVG Blob 或 null
   */
  async exportToSvg(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      // 使用 GoJS 的 makeSvg 方法生成 SVG
      const svg = this.diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096)
      });
      
      if (!svg) {
        this.toast.error('导出失败', '无法生成 SVG');
        return null;
      }
      
      // 序列化 SVG 为字符串
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      
      // 创建 Blob
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      
      // 触发下载
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.toast.success('导出成功', 'SVG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 SVG 失败', error);
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      return null;
    }
  }
  
  /**
   * 生成导出文件名
   */
  private getExportFileName(): string {
    const project = this.store.activeProject();
    const projectName = project?.name || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
  }
  
  /**
   * 触发 Blob 文件下载
   */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
  
  /**
   * 设置缩放级别
   */
  setZoom(scale: number): void {
    if (this.diagram) {
      this.diagram.scale = scale;
    }
  }
  
  /**
   * 应用自动布局
   */
  applyAutoLayout(): void {
    if (!this.diagram) return;
    
    const $ = go.GraphObject.make;
    
    this.diagram.startTransaction('auto-layout');
    this.diagram.layout = $(go.LayeredDigraphLayout, {
      direction: 0,
      layerSpacing: GOJS_CONFIG.LAYER_SPACING,
      columnSpacing: GOJS_CONFIG.COLUMN_SPACING,
      setsPortSpots: false
    });
    this.diagram.layoutDiagram(true);
    
    // 布局完成后保存位置并恢复无操作布局
    setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;
      this.saveAllNodePositions();
      this.diagram.layout = $(go.Layout);
      this.diagram.commitTransaction('auto-layout');
    }, UI_CONFIG.SHORT_DELAY);
  }
  
  /**
   * 定位到指定节点
   * @param nodeKey 节点 key
   * @param select 是否选中节点
   */
  centerOnNode(nodeKey: string, select: boolean = true): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.centerRect(node.actualBounds);
      if (select) {
        this.diagram.select(node);
      }
    }
  }
  
  /**
   * 选中指定节点
   */
  selectNode(nodeKey: string): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.select(node);
      // 如果节点不在视图中，滚动到节点位置
      if (!this.diagram.viewportBounds.containsRect(node.actualBounds)) {
        this.diagram.centerRect(node.actualBounds);
      }
    }
  }
  
  /**
   * 适应内容：将所有节点缩放并居中显示在视口中
   * 主要用于移动端首次加载时确保节点可见
   */
  fitToContents(): void {
    if (!this.diagram) return;
    
    // 获取所有节点的边界
    const bounds = this.diagram.documentBounds;
    if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
      // 如果没有有效的边界，尝试滚动到原点
      this.diagram.scrollToRect(new go.Rect(0, 0, 100, 100));
      return;
    }
    
    // 添加一些内边距
    const padding = 50;
    const paddedBounds = bounds.copy().inflate(padding, padding);
    
    // 计算需要的缩放比例
    const viewportWidth = this.diagram.viewportBounds.width;
    const viewportHeight = this.diagram.viewportBounds.height;
    
    if (viewportWidth <= 0 || viewportHeight <= 0) {
      return; // 视口无效
    }
    
    const scaleX = viewportWidth / paddedBounds.width;
    const scaleY = viewportHeight / paddedBounds.height;
    let scale = Math.min(scaleX, scaleY);
    
    // 限制缩放范围：不要太小也不要太大
    scale = Math.max(0.3, Math.min(1.5, scale));
    
    // 应用缩放
    this.diagram.scale = scale;
    
    // 居中显示
    this.diagram.centerRect(bounds);
  }
  
  /**
   * 清除选择
   */
  clearSelection(): void {
    if (this.diagram) {
      this.diagram.clearSelection();
    }
  }
  
  /**
   * 请求重新渲染
   */
  requestUpdate(): void {
    if (this.diagram) {
      this.diagram.requestUpdate();
    }
  }
  
  /**
   * 保存所有节点位置到 store
   */
  saveAllNodePositions(): void {
    if (!this.diagram) return;
    
    this.diagram.nodes.each((node: any) => {
      const loc = node.location;
      if (node.data && node.data.key && loc.isReal()) {
        this.store.updateTaskPosition(node.data.key, loc.x, loc.y);
      }
    });
  }
  
  /**
   * 获取选中节点的 key 列表
   */
  getSelectedNodeKeys(): string[] {
    const keys: string[] = [];
    if (this.diagram) {
      this.diagram.selection.each((part: any) => {
        if (part instanceof go.Node && part.data?.key) {
          keys.push(part.data.key);
        }
      });
    }
    return keys;
  }
  
  /**
   * 移除连接线
   */
  removeLink(link: go.Link): void {
    if (this.diagram && link) {
      this.diagram.remove(link);
    }
  }
  
  /**
   * 将视口坐标转换为文档坐标
   */
  transformViewToDoc(viewPoint: go.Point): go.Point {
    if (this.diagram) {
      return this.diagram.transformViewToDoc(viewPoint);
    }
    return viewPoint;
  }
  
  /**
   * 将文档坐标转换为视口坐标
   */
  transformDocToView(docPoint: go.Point): go.Point {
    if (this.diagram) {
      return this.diagram.transformDocToView(docPoint);
    }
    return docPoint;
  }
  
  /**
   * 获取最后的输入点（视口坐标）
   */
  getLastInputViewPoint(): go.Point | null {
    return this.diagram?.lastInput?.viewPoint || null;
  }
  
  // ========== 图表数据更新 ==========
  
  /**
   * 检测是否有结构性变化
   * 用于判断是否需要完整重建图表数据（包括 familyColor 重新计算）
   * 
   * @param currentNodeMap 当前图表中的节点映射
   * @param newTasks 新的任务列表
   * @returns 是否有结构性变化
   */
  private detectStructuralChange(currentNodeMap: Map<string, any>, newTasks: Task[]): boolean {
    // 1. 检查节点数量变化
    if (currentNodeMap.size !== newTasks.length) {
      return true;
    }
    
    // 2. 检查每个任务的关键属性是否变化
    for (const task of newTasks) {
      const existing = currentNodeMap.get(task.id);
      if (!existing) {
        // 新任务
        return true;
      }
      
      // 检查影响显示的关键属性
      // stage 变化会影响任务在图表中的位置和可见性
      // status 变化会影响节点颜色
      // parentId 变化会影响连线和 familyColor
      if (existing.stage !== task.stage ||
          existing.status !== task.status ||
          existing.parentId !== task.parentId) {
        return true;
      }
    }
    
    // 3. 检查是否有任务被删除（在 currentNodeMap 中存在但在 newTasks 中不存在）
    const newTaskIds = new Set(newTasks.map(t => t.id));
    for (const key of currentNodeMap.keys()) {
      if (!newTaskIds.has(key)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 更新图表数据
   * @param tasks 任务列表
   * @param forceRefresh 是否强制刷新
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    if (this.error() || !this.diagram) {
      return;
    }
    
    const project = this.store.activeProject();
    if (!project) {
      return;
    }
    
    try {
      // 检查更新类型
      const lastUpdateType = this.store.getLastUpdateType();
      
      // 检查是否有结构性变化
      // 这对于远程同步更新尤其重要，因为 lastUpdateType 可能是上次本地操作的状态
      const model = this.diagram.model as any;
      const currentNodeMap = new Map<string, any>();
      (model.nodeDataArray || []).forEach((n: any) => {
        if (n.key) currentNodeMap.set(n.key, n);
      });
      
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);
      
      // 如果仅是位置更新且没有结构性变化，跳过更新（优化拖动性能）
      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }
      
      // 构建图表数据
      const existingNodeMap = new Map<string, any>();
      (this.diagram.model as any).nodeDataArray.forEach((n: any) => {
        if (n.key) {
          existingNodeMap.set(n.key, n);
        }
      });
      
      const searchQuery = this.store.searchQuery();
      const diagramData = this.configService.buildDiagramData(
        tasks.filter(t => !t.deletedAt), // 排除软删除的任务
        project,
        searchQuery,
        existingNodeMap
      );
      
      // 保存当前选中状态
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: any) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });
      
      // 更新模型
      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;
      
      // 重用之前获取的 model 引用
      model.mergeNodeDataArray(diagramData.nodeDataArray);
      
      // ========== 确保所有连接线使用主端口（空字符串）==========
      // 这样才能启用 Perimeter Intersection（边界滑动）效果
      const linkDataWithPorts = diagramData.linkDataArray.map(link => ({
        ...link,
        fromPortId: "",  // 空字符串 = 主节点端口
        toPortId: ""     // 空字符串 = 主节点端口
      }));
      model.mergeLinkDataArray(linkDataWithPorts);
      
      // 移除不存在的节点和连接线
      const nodeKeys = new Set(diagramData.nodeDataArray.map(n => n.key));
      const linkKeys = new Set(diagramData.linkDataArray.map(l => l.key));
      
      const nodesToRemove = model.nodeDataArray.filter((n: any) => !nodeKeys.has(n.key));
      nodesToRemove.forEach((n: any) => model.removeNodeData(n));
      
      const linksToRemove = model.linkDataArray.filter((l: any) => !linkKeys.has(l.key));
      linksToRemove.forEach((l: any) => model.removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      // 恢复选中状态
      if (selectedKeys.size > 0) {
        this.diagram.nodes.each((node: any) => {
          if (selectedKeys.has(node.data?.key)) {
            node.isSelected = true;
          }
        });
      }
      
      // 强制刷新所有链接路由（确保端口 Side Spot 分散计算生效）
      this.diagram.links.each((link: go.Link) => {
        link.invalidateRoute();
      });
      
      // ========== Debug: 检查 familyColor ==========
      const linkData = model.linkDataArray;
      if (linkData?.length > 0 && !this._familyColorLogged) {
        this._familyColorLogged = true;
        this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
        if (model.nodeDataArray?.length > 0) {
          this.logger.info(`[LineageColor] 首个节点数据: familyColor=${model.nodeDataArray[0].familyColor}`);
        }
      }
      
      // ========== Overview 数据同步调试 ==========
      if (this.overview?.observed) {
        const ovModel = this.overview.observed.model;
        console.log('[Overview] Main diagram nodes:', ovModel.nodeDataArray?.length || 0);
        console.log('[Overview] Main diagram links:', (ovModel as any).linkDataArray?.length || 0);
        if (ovModel.nodeDataArray?.length > 0) {
          console.log('[Overview] First node familyColor:', (ovModel.nodeDataArray[0] as any).familyColor);
        }
        // 尝试强制刷新 Overview
        this.overview.updateAllTargetBindings();
      }
      
      // 首次加载完成后，在移动端自动适应内容
      if (this.isFirstLoad && diagramData.nodeDataArray.length > 0) {
        this.isFirstLoad = false;
        // 延迟执行，确保节点布局完成
        setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          // 检查是否有保存的视图状态
          const viewState = this.store.getViewState();
          if (!viewState) {
            this.fitToContents();
          }
        }, 100);
      }
      
    } catch (error) {
      this.handleError('更新流程图失败', error);
    }
  }
  
  // ========== 拖放支持 ==========
  
  /**
   * 设置拖放事件处理
   * @param onDrop 拖放回调
   */
  setupDropHandler(onDrop: (taskData: any, docPoint: go.Point) => void): void {
    if (!this.diagramDiv) return;
    
    this.diagramDiv.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    this.diagramDiv.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      const data = e.dataTransfer?.getData("application/json") || e.dataTransfer?.getData("text");
      if (!data || !this.diagram) return;
      
      try {
        const task = JSON.parse(data);
        const pt = this.diagram.lastInput.viewPoint;
        const loc = this.diagram.transformViewToDoc(pt);
        onDrop(task, loc);
      } catch (err) {
        this.logger.error('Drop error:', err);
      }
    });
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 设置节点模板
   * 
   * 设计：
   * - 主体区域只能拖动，不能拉线
   * - 四边有明确可见的"连接手柄"（小方块），只有点击手柄才能拉线
   * - 连接线分散到各边（使用 Side spots）
   */
  private setupNodeTemplate($: any): void {
    if (!this.diagram) return;
    
    const self = this;
    const isMobile = this.store.isMobile();
    const portSize = isMobile ? 14 : 10;  // 连接手柄大小
    
    /**
     * 创建边缘连接手柄
     * @param name 端口名称
     * @param spot 位置（Top/Bottom/Left/Right）
     */
    /**
     * 获取边缘 Spot（用于连接线方向）
     */
    function makePort(name: string, spot: go.Spot): go.Shape {
      // ========== 边缘触发端口（紫色小圆点）==========
      // 作用：仅作为 UI 交互手柄，用户点击它触发 LinkingTool
      // 
      // 关键设计：
      // - 这个端口 **不参与** 连接线的视觉锚点计算
      // - fromSpot/toSpot 设为 None，避免在小圆点边界上打转
      // - 实际连接点由主节点（portId: ""）+ getLinkPoint 计算
      // - 结果：点击紫色小框，线在整个圆角矩形边界上滑动
      return $(go.Shape, "Circle", {
        fill: "transparent",       // 默认透明
        stroke: null,              // 默认无边框
        strokeWidth: 1,
        desiredSize: new go.Size(portSize, portSize),
        alignment: spot,
        alignmentFocus: go.Spot.Center,  // 关键修复：端口中心对齐到节点边缘，而不是端口边缘
        portId: name,              // T, B, L, R - 仅用于识别点击位置
        fromLinkable: true,        // 允许触发连线（作为起点）
        toLinkable: true,          // 也允许作为终点（findTargetPort 会重定向到主端口）
        fromSpot: go.Spot.None,    // 不在端口边界计算
        toSpot: go.Spot.None,      // 不在端口边界计算
        isActionable: false,       // 关键：让端口不阻挡其他操作，仅响应 LinkingTool
        cursor: "crosshair",       // 十字光标表示可连接
        // 鼠标悬停效果
        mouseEnter: (e: any, port: go.Shape) => {
          if (e.diagram.isReadOnly) return;
          port.fill = "#4A8C8C";   // retro.teal
          port.stroke = "#44403C"; // retro.dark
        },
        mouseLeave: (e: any, port: go.Shape) => {
          port.fill = "transparent";
          port.stroke = null;
        }
      });
    }
    
    this.diagram.nodeTemplate = $(go.Node, "Spot",
      {
        locationSpot: go.Spot.Center,
        selectionAdorned: true,
        // ========== 关键：让节点本身可以作为连接目标 ==========
        // 即使鼠标在节点的任何位置，都能被 LinkingTool 检测到
        fromLinkable: false,       // 不从节点本身拉线（从边缘端口拉）
        toLinkable: true,          // 允许连接到节点（任何位置）
        fromLinkableDuplicates: false,
        toLinkableDuplicates: true,
        click: (e: any, node: any) => {
          if (e.diagram.lastInput.dragging) return;
          // 防止双击时触发单击事件
          if (e.diagram.lastInput.clickCount >= 2) return;
          self.zone.run(() => {
            self.nodeClickCallback?.(node.data.key, false);
          });
        },
        doubleClick: (e: any, node: any) => {
          e.handled = true; // 标记事件已处理，防止触发单击
          self.zone.run(() => {
            self.nodeClickCallback?.(node.data.key, true);
          });
        }
      },
      new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
      
      // ========== 主面板（蓝色大背景框）==========
      // 作用：作为连线的真正起点/终点，配合 getLinkPoint 实现边界滑动
      $(go.Panel, "Auto",
        {
          name: "BODY",
          // 关键：让整个 Panel 可以接受连接
          portId: "",              // 主体端口（空字符串）- 真正的连线计算端口
          fromLinkable: false,     // 默认不能从主体拉线（由 doActivate 临时启用）
          toLinkable: true,        // 允许连接到主体（整个节点区域都可接受连接）
          fromSpot: go.Spot.AllSides, // 出线动态寻找离目标最近的边界点
          toSpot: go.Spot.AllSides,   // 入线动态寻找离源头最近的边界点
          cursor: "move"           // 移动光标
        },
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
          isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
        $(go.Shape, "RoundedRectangle", {
          name: "SHAPE",
          fill: "white",
          stroke: "#78716C",       // retro.muted
          strokeWidth: 1,
          parameter1: 10,
          isPanelMain: true        // 标记为主元素，不阻挡其他元素的鼠标事件
          // ========== go.Spot.AllSides - 核心配置 ==========
          // 这就是你描述的"水珠在玻璃边缘滑动"的效果
          // 算法名称：Perimeter Intersection（周界交点计算）
          // 原理：连接线不死死定在一个坐标点，而是动态计算与节点边界的交点
        },
        new go.Binding("fill", "color"),
        new go.Binding("stroke", "", (data: any, obj: any) => {
          if (obj.part.isSelected) return data.selectedBorderColor || "#4A8C8C";
          return data.borderColor || "#78716C";
        }).ofObject(),
        new go.Binding("strokeWidth", "borderWidth")),
        
        $(go.Panel, "Vertical",
          new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
          $(go.TextBlock, { font: "bold 9px \"LXGW WenKai Screen\", sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
            new go.Binding("text", "displayId"),
            new go.Binding("stroke", "displayIdColor"),
            new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
          $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px \"LXGW WenKai Screen\", sans-serif", stroke: "#44403C" },
            new go.Binding("text", "title"),
            new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => 
              isUnassigned ? "500 11px \"LXGW WenKai Screen\", sans-serif" : "400 12px \"LXGW WenKai Screen\", sans-serif"),
            new go.Binding("stroke", "titleColor"),
            new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => 
              isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
        )
      ),
      
      // ========== 边缘连接手柄（小圆点）==========
      makePort("T", go.Spot.Top),
      makePort("B", go.Spot.Bottom),
      makePort("L", go.Spot.Left),
      makePort("R", go.Spot.Right)
    );
  }
  
  /**
   * 设置连接线模板
   */
  private setupLinkTemplate($: any): void {
    if (!this.diagram) return;
    
    const self = this;
    const isMobile = this.store.isMobile();
    const allowedPortIds = ["T", "B", "L", "R"];
    const rawCaptureRadius = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD ?? 80;
    const TARGET_CAPTURE_RADIUS = this.store.isMobile()
      ? Math.min(Math.max(rawCaptureRadius, 28), 60)
      : Math.min(Math.max(rawCaptureRadius, 16), 36);
    const pointerTolerance = this.store.isMobile() ? 6 : 3;
    
    /**
     * ========== Perimeter Intersection（周界交点计算）算法 ==========
     * 
     * 这就是你看到的"水珠在玻璃边缘滑动"的核心实现
     * 
     * 原理：
     * 1. 射线：从节点中心指向目标点（鼠标位置）画一条虚拟射线
     * 2. 求交：计算这条射线与节点矩形边界的交点
     * 3. 渲染：将交点作为连接线的实际起点/终点
     * 
     * 效果：当你移动鼠标时，交点会沿着矩形边框自动移动，
     *      就像水珠在玻璃边缘滑动一样，总是寻找离鼠标最近的那个点
     * 
     * @param node - 节点对象
     * @param targetPoint - 目标点（通常是鼠标位置或对方节点位置）
     * @returns 节点边界上的交点坐标
     */
    const computeNodeEdgePoint = (node: go.Node, targetPoint: go.Point): go.Point => {
      // 获取节点主体面板（BODY）的边界
      // 关键：我们要计算的是整个蓝色大框的边界，而不是紫色小圆点的边界
      const bodyPanel = node.findObject("BODY") as go.Panel;
      
      // 后备方案：如果 BODY 面板不存在，尝试使用节点的实际边界
      let bounds: go.Rect;
      
      if (bodyPanel) {
        bounds = bodyPanel.getDocumentBounds();
        // 调试：验证我们使用的是主节点边界，而不是端口边界
      } else {
        // 使用节点自身的边界作为后备
        bounds = node.actualBounds;
        if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
          // 如果连边界都没有，返回节点中心
          return node.getDocumentPoint(go.Spot.Center);
        }
        // 转换为文档坐标
        const loc = node.location;
        bounds = new go.Rect(
          loc.x - bounds.width / 2,
          loc.y - bounds.height / 2,
          bounds.width,
          bounds.height
        );
      }
      
      if (!bounds.isReal()) {
        return node.getDocumentPoint(go.Spot.Center);
      }
      
      // 计算从节点中心指向目标点的方向向量
      const center = new go.Point(bounds.centerX, bounds.centerY);
      const dx = targetPoint.x - center.x;
      const dy = targetPoint.y - center.y;
      
      if (dx === 0 && dy === 0) return center;
      
      // ========== 射线与矩形边界求交算法 ==========
      // 计算射线 (center + t * direction) 与矩形边界的交点
      const halfWidth = bounds.width / 2;
      const halfHeight = bounds.height / 2;
      
      // 计算到达各边所需的参数 t（射线参数方程的参数）
      // 射线方程：Point = center + t * (dx, dy)
      // 当射线到达矩形边界时，找到最小的 t 值
      let t = Number.POSITIVE_INFINITY;
      
      if (dx !== 0) {
        const tRight = halfWidth / Math.abs(dx);
        const tLeft = halfWidth / Math.abs(dx);
        t = Math.min(t, dx > 0 ? tRight : tLeft);
      }
      
      if (dy !== 0) {
        const tBottom = halfHeight / Math.abs(dy);
        const tTop = halfHeight / Math.abs(dy);
        t = Math.min(t, dy > 0 ? tBottom : tTop);
      }
      
      // 计算边界上的交点：这就是连接线的实际起点/终点
      // 这个点会随着目标位置（鼠标）的移动而沿边界滑动
      return new go.Point(center.x + dx * t, center.y + dy * t);
    };

    const getNodeBodyBounds = (node: go.Node): go.Rect | null => {
      const bodyPanel = node.findObject("BODY") as go.Panel;
      if (bodyPanel) {
        const panelBounds = bodyPanel.getDocumentBounds();
        if (panelBounds.isReal()) {
          return panelBounds;
        }
      }
      const bounds = node.actualBounds;
      return bounds.isReal() ? bounds : null;
    };

    const isPointerNearBody = (node: go.Node, pointer: go.Point, tolerance: number): boolean => {
      const bounds = getNodeBodyBounds(node);
      if (!bounds) return false;
      const expanded = bounds.copy();
      expanded.inflate(tolerance, tolerance);
      return expanded.containsPoint(pointer);
    };

    const distanceToBodySquared = (node: go.Node, pointer: go.Point): number => {
      const bounds = getNodeBodyBounds(node);
      if (!bounds) return Number.POSITIVE_INFINITY;
      const clampedX = Math.min(Math.max(pointer.x, bounds.x), bounds.right);
      const clampedY = Math.min(Math.max(pointer.y, bounds.y), bounds.bottom);
      const dx = pointer.x - clampedX;
      const dy = pointer.y - clampedY;
      return dx * dx + dy * dy;
    };

    // ========== getLinkPoint - 连接线端点计算函数 ==========
    // 这是 GoJS 每次渲染连接线时调用的回调函数
    // 配合 go.Spot.AllSides 使用，实现动态边界滑动效果
    // 
    // 关键修复：传入的 node 参数可能是端口对象，我们需要获取真正的 Node
    // ========== getLinkPoint - 连接线端点计算函数 ==========
    // 这是 GoJS 每次渲染连接线时调用的回调函数
    // 配合 go.Spot.AllSides 使用，实现动态边界滑动效果
    // 
    // 关键：需要处理两种情况
    // 1. 临时连接线（拖动时）：fromNode/toNode 可能是 undefined，需要从 port 向上查找
    // 2. 永久连接线：fromNode/toNode 是实际节点
    const freeAngleLinkPoint: go.Link['getLinkPoint'] = function(this: go.Link, node, port, spot, from, _ortho, otherNode, otherPort) {
      // ========== 多重策略查找实际节点 ==========
      let actualNode: go.Node | null = null;
      
      // 策略1: 从连接线的 fromNode/toNode 获取（永久连接线）
      // 注意：需要验证节点是否有效（有 data 或有 BODY 面板）
      if (from) {
        if (this.fromNode) {
          const hasData = !!(this.fromNode as any).data;
          const hasBody = !!(this.fromNode as any).findObject?.('BODY');
          if (hasData || hasBody) {
            actualNode = this.fromNode;
          }
        }
      } else {
        if (this.toNode) {
          const hasData = !!(this.toNode as any).data;
          const hasBody = !!(this.toNode as any).findObject?.('BODY');
          if (hasData || hasBody) {
            actualNode = this.toNode;
          }
        }
      }
      
      // 策略2: 使用传入的 node 参数
      if (!actualNode && node instanceof go.Node) {
        const hasData = !!(node as any).data;
        const hasBody = !!(node as any).findObject?.('BODY');
        if (hasData || hasBody) {
          actualNode = node;
        }
      }
      
      // 策略3: 从 port.part 获取节点（port 是节点的一部分）
      if (!actualNode && port && (port as any).part instanceof go.Node) {
        const partNode = (port as any).part;
        const hasData = !!(partNode as any).data;
        const hasBody = !!(partNode as any).findObject?.('BODY');
        if (hasData || hasBody) {
          actualNode = partNode;
        }
      }
      
      // 策略4: 临时连接线的特殊处理 - 从 LinkingTool 获取原始节点
      if (!actualNode && this.diagram) {
        const linkingTool = this.diagram.toolManager.linkingTool;
        if (linkingTool.isActive) {
          // 根据是起点还是终点，选择不同的端口
          let originalPort = from 
            ? ((linkingTool as any).originalFromPort || (linkingTool as any)._tempMainPort)
            : (linkingTool as any).originalToPort;
          
          // 如果 originalPort 是字符串（节点key），需要查找节点
          if (typeof originalPort === 'string') {
            const foundNode = this.diagram.findNodeForKey(originalPort);
            actualNode = foundNode;
          } else if (originalPort && originalPort.part instanceof go.Node) {
            // 如果是端口对象，获取其所属节点
            actualNode = originalPort.part;
          }
        }
      }
      
      if (!actualNode) {
        // 后备方案：如果是终点且还在拖动，使用鼠标位置作为目标
        if (!from && this.diagram?.lastInput?.documentPoint) {
          return this.diagram.lastInput.documentPoint;
        }
        // 最终后备：返回默认点
        return new go.Point();
      }
      
      const doc = actualNode.diagram;
      
      // 获取目标点（可能是鼠标位置、对方端口或对方节点中心）
      const target = otherPort?.getDocumentPoint(go.Spot.Center)
        || otherNode?.getDocumentPoint(go.Spot.Center)
        || doc?.lastInput?.documentPoint
        || actualNode.getDocumentPoint(go.Spot.Center);
      
      // 调用 Perimeter Intersection 算法计算边界交点
      return computeNodeEdgePoint(actualNode, target);
    };
    
    // 配置拖动时的临时连接线样式
    const linkingTool = this.diagram.toolManager.linkingTool;
    const relinkingTool = this.diagram.toolManager.relinkingTool;

    // 只允许从四个边缘小圆点开始拉线，避免从主体区域误触导致无法拖动节点
    const originalCanStart = linkingTool.canStart;
    linkingTool.canStart = function() {
      if (!originalCanStart.call(this)) return false;
      const dia = this.diagram;
      if (!dia) return false;
      const input = dia.lastInput;
      if (!input) return false;
      const port = dia.findObjectAt(input.documentPoint, (obj: any) => {
        if (obj && typeof obj.portId === "string" && obj.portId.length > 0 && allowedPortIds.includes(obj.portId)) {
          return obj;
        }
        return null;
      }, null) as any;
      if (!port) return false;
      return allowedPortIds.includes(port.portId);
    };
    
    // ========== "偷梁换柱"技术：解决触发者与表现者分离问题 ==========
    // 
    // 问题：用户期望的交互逻辑
    //   - 触发：点击紫色小圆点（边缘端口）开始拖拽
    //   - 表现：连接线沿着蓝色大框（主节点）的边界滑动
    // 
    // 矛盾：如果直接从紫色小圆点拉线
    //   - 线只会绕着小圆点自己的微小边界转，而不是绕着整个节点转
    // 
    // 解决方案：偷梁换柱
    //   1. 用户点击紫色小圆点 → 触发 LinkingTool（触发器）
    //   2. 激活后立即替换起点 → 改用主节点端口（portId: ""）作为真正起点
    //   3. 主节点配合 getLinkPoint → 计算边界交点，实现沿边滑动效果
    // 
    // 这样就实现了："点击紫色小框，但线绕着蓝色大框转"
    
    const originalDoActivate = linkingTool.doActivate;
    linkingTool.doActivate = function() {
      originalDoActivate.call(this);
      
      const startPort = (this as any).startPort 
        || (this as any).originalFromPort 
        || (this as any).fromPort;
      
      let edgePortObj: any = null;
      
      if (startPort && typeof startPort === 'object' && startPort.portId) {
        edgePortObj = startPort;
      } else if (startPort && typeof startPort === 'string' && allowedPortIds.includes(startPort)) {
        const originalNode = (this as any).originalFromNode || (this as any).fromNode;
        if (originalNode instanceof go.Node) {
          edgePortObj = originalNode.findPort(startPort);
        }
      }
      
      if (edgePortObj && allowedPortIds.includes(edgePortObj.portId)) {
        const node = edgePortObj.part;
        if (node instanceof go.Node) {
          const mainPort = node.findPort("");
          if (mainPort) {
            (this as any)._tempMainPort = mainPort;
            (this as any)._savedFromLinkable = mainPort.fromLinkable;
            (this as any)._savedToLinkable = mainPort.toLinkable;
            
            mainPort.fromLinkable = true;
            // 保持 toLinkable = true，允许其他连接线连接到此节点
            
            (this as any).startPort = mainPort;
            (this as any).originalFromPort = mainPort;
            (this as any).fromPort = mainPort;
            
            // 修改临时连接线，使用主节点端口
            if (this.temporaryLink) {
              (this.temporaryLink as any).fromNode = node;
              this.temporaryLink.fromPortId = "";
              this.temporaryLink.fromSpot = go.Spot.AllSides;
              this.temporaryLink.toSpot = go.Spot.AllSides;
              this.temporaryLink.invalidateRoute();
            }
          }
        }
      }
    };

    // 重写 doDeactivate：恢复主节点端口状态
    const originalDoDeactivate = linkingTool.doDeactivate;
    linkingTool.doDeactivate = function() {
      // 恢复主体端口的原始配置（fromLinkable = false）
      const mainPort = (this as any)._tempMainPort;
      if (mainPort) {
        mainPort.fromLinkable = (this as any)._savedFromLinkable;
        mainPort.toLinkable = (this as any)._savedToLinkable;
        (this as any)._tempMainPort = null;
      }
      originalDoDeactivate.call(this);
    };
    
    // ========== 连接验证：禁止节点连接到自身 ==========
    const originalIsValidLink = linkingTool.isValidLink;
    linkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      // 阻止节点连接到自身
      if (fromNode === toNode) {
        return false;
      }
      // 调用原始验证逻辑
      return originalIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };
    
    // 同样为 relinkingTool 添加验证
    const originalRelinkIsValidLink = relinkingTool.isValidLink;
    relinkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      // 阻止节点连接到自身
      if (fromNode === toNode) {
        return false;
      }
      // 调用原始验证逻辑
      return originalRelinkIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };

    // ========== findTargetPort 重写：解决边缘端口阻挡连接问题 ==========
    // 问题：边缘端口或节点边界可能形成"透明墙"阻挡连接
    // 解决：为 LinkingTool / RelinkingTool 提供统一的智能捕获逻辑
    const radiusSquared = TARGET_CAPTURE_RADIUS * TARGET_CAPTURE_RADIUS;
    const isRealNode = (node: go.Node | null, excludeNode: go.Node | null): node is go.Node => {
      if (!node || node === excludeNode) return false;
      const hasData = !!(node as any).data;
      const hasBody = !!node.findObject?.('BODY');
      if (!hasData && !hasBody) return false;
      const mainPort = node.findPort("");
      return !!(mainPort && (mainPort as any).toLinkable);
    };
    const getMainPort = (node: go.Node | null): go.GraphObject | null => {
      if (!node) return null;
      const mainPort = node.findPort("");
      if (mainPort && (mainPort as any).toLinkable) {
        return mainPort;
      }
      return null;
    };
    const normalizePort = (port: go.GraphObject | null): go.GraphObject | null => {
      if (!port) return null;
      const node = port.part;
      if (node instanceof go.Node) {
        const portId = port.portId || '';
        if (portId === "") {
          return (port as any).toLinkable ? port : getMainPort(node);
        }
        if (allowedPortIds.includes(portId)) {
          return getMainPort(node) || port;
        }
      }
      return port;
    };
    const findNodeNearPointer = (tool: go.LinkingTool, fromEnd: boolean): go.Node | null => {
      const diagram = tool.diagram;
      const pointer = diagram?.lastInput?.documentPoint;
      if (!diagram || !pointer) return null;
      const toolAny = tool as any;
      const excludeNode = fromEnd ? toolAny.toNode : toolAny.fromNode;
      const directParts = diagram.findPartsAt(pointer, true);
      let found: go.Node | null = null;
      directParts.each((part: go.Part) => {
        if (!found && part instanceof go.Node && isRealNode(part, excludeNode) && isPointerNearBody(part, pointer, pointerTolerance)) {
          found = part;
        }
      });
      if (found) return found;
      const searchRect = new go.Rect(
        pointer.x - TARGET_CAPTURE_RADIUS,
        pointer.y - TARGET_CAPTURE_RADIUS,
        TARGET_CAPTURE_RADIUS * 2,
        TARGET_CAPTURE_RADIUS * 2
      );
      let closest: go.Node | null = null;
      let closestDist = Number.POSITIVE_INFINITY;
      diagram.findPartsIn(searchRect, true, true).each((part: go.Part) => {
        if (!(part instanceof go.Node) || !isRealNode(part, excludeNode)) return;
        if (!isPointerNearBody(part, pointer, pointerTolerance)) return;
        const dist = distanceToBodySquared(part, pointer);
        if (dist <= radiusSquared && dist < closestDist) {
          closestDist = dist;
          closest = part;
        }
      });
      if (closest) return closest;
      diagram.nodes.each((node: go.Node) => {
        if (!isRealNode(node, excludeNode)) return;
        if (!isPointerNearBody(node, pointer, pointerTolerance)) return;
        const dist = distanceToBodySquared(node, pointer);
        if (dist <= radiusSquared && dist < closestDist) {
          closestDist = dist;
          closest = node;
        }
      });
      return closest;
    };
    const enhanceTargetFinding = (
      tool: go.LinkingTool,
      original: go.LinkingTool['findTargetPort']
    ): void => {
      tool.findTargetPort = function(fromEnd: boolean) {
        const node = findNodeNearPointer(this, fromEnd);
        const directPort = getMainPort(node);
        if (directPort) {
          return directPort;
        }
        return normalizePort(original.call(this, fromEnd));
      };
    };
    const originalFindTargetPort = linkingTool.findTargetPort;
    enhanceTargetFinding(linkingTool, originalFindTargetPort);
    const originalRelinkingFindTargetPort = relinkingTool.findTargetPort;
    enhanceTargetFinding(
      relinkingTool as unknown as go.LinkingTool,
      originalRelinkingFindTargetPort as unknown as go.LinkingTool['findTargetPort']
    );
    
    // ========== 关键配置：扩大端口检测范围 ==========
    // portGravity: 端口的"引力"范围，数值越大越容易被检测到
    const portGravity = Math.max(4, pointerTolerance * 2);
    linkingTool.portGravity = portGravity;
    (relinkingTool as any).portGravity = portGravity;
    
    // 优化拖拽体验：解除端口方向限制
    (linkingTool as any).temporaryFromSpot = go.Spot.AllSides;
    (linkingTool as any).temporaryToSpot = go.Spot.AllSides;

    // ========== 配置临时连接线 ==========
    // 拖拽过程中显示的虚线，配合 getLinkPoint 实现动态边界滑动
    linkingTool.temporaryLink = $(go.Link,
      { 
        layerName: "Tool", 
        getLinkPoint: freeAngleLinkPoint,  // 关键：使用自定义的边界交点计算
        curve: go.Link.Bezier
      },
      $(go.Shape, { stroke: "#78716C", strokeWidth: 2, strokeDashArray: [4, 4] }),
      $(go.Shape, { toArrow: "Standard", stroke: null, fill: "#78716C" })
    );
    
    // ========== 配置 RelinkingTool（重连工具）==========
    // 确保重新连接时也使用相同的动态边界滑动逻辑
    (relinkingTool as any).fromHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(10, 10),
      fill: "#4A8C8C",
      stroke: "#44403C",
      cursor: "crosshair"
    });
    (relinkingTool as any).toHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(10, 10),
      fill: "#4A8C8C",
      stroke: "#44403C",
      cursor: "crosshair"
    });
    
    // 重连时使用相同的临时线配置（带边界滑动）
    relinkingTool.temporaryLink = $(go.Link,
      { 
        layerName: "Tool", 
        getLinkPoint: freeAngleLinkPoint,  // 重连时也启用边界滑动
        curve: go.Link.Bezier
      },
      $(go.Shape, { stroke: "#78716C", strokeWidth: 2, strokeDashArray: [4, 4] }),
      $(go.Shape, { toArrow: "Standard", stroke: null, fill: "#78716C" })
    );
    
    // ========== 最终连接线模板 ==========
    // 创建连接后的永久连接线，同样使用 getLinkPoint 保持边界滑动效果
    this.diagram.linkTemplate = $(go.Link,
      {
        routing: go.Link.Normal,
        curve: go.Link.Bezier,
        getLinkPoint: freeAngleLinkPoint,  // 关键：永久连接线也使用边界滑动算法
        toShortLength: 4,
        fromEndSegmentLength: GOJS_CONFIG.LINK_END_SEGMENT_LENGTH,
        toEndSegmentLength: GOJS_CONFIG.LINK_END_SEGMENT_LENGTH,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: true,
        resegmentable: false,
        click: (e: any, link: any) => {
          e.diagram.select(link);
        },
        contextMenu: $(go.Adornment, "Vertical",
          $("ContextMenuButton",
            $(go.TextBlock, "删除连接", { margin: 5 }),
            {
              click: (e: any, obj: any) => {
                const link = obj.part?.adornedPart;
                if (link?.data) {
                  self.zone.run(() => {
                    self.linkClickCallback?.(link.data, 0, 0);
                  });
                }
              }
            }
          )
        )
      },
      ...this.configService.getLinkMainShapesConfig($, isMobile),
      this.createConnectionLabelPanel($, self)
    );
  }
  
  /**
   * 创建联系块标签面板
   */
  private createConnectionLabelPanel($: any, self: FlowDiagramService): go.Panel {
    return $(go.Panel, "Auto",
      {
        segmentIndex: NaN,
        segmentFraction: 0.5,
        cursor: "pointer",
        click: (e: any, panel: any) => {
          e.handled = true;
          const linkData = panel.part?.data;
          if (linkData?.isCrossTree && self.diagramDiv) {
            const rect = self.diagramDiv.getBoundingClientRect();
            const clickX = e.event.pageX - rect.left;
            const clickY = e.event.pageY - rect.top;
            self.zone.run(() => {
              self.linkClickCallback?.(linkData, clickX, clickY);
            });
          }
        }
      },
      new go.Binding("visible", "isCrossTree"),
      $(go.Shape, "RoundedRectangle", {
        fill: "#f5f3ff",
        stroke: "#8b5cf6",
        strokeWidth: 1,
        parameter1: 4
      }),
      $(go.Panel, "Horizontal",
        { margin: 3, defaultAlignment: go.Spot.Center },
        $(go.TextBlock, "🔗", { font: "8px \"LXGW WenKai Screen\", sans-serif" }),
        $(go.TextBlock, {
          font: "500 8px \"LXGW WenKai Screen\", sans-serif",
          stroke: "#6d28d9",
          maxSize: new go.Size(50, 14),
          overflow: go.TextBlock.OverflowEllipsis,
          margin: new go.Margin(0, 0, 0, 2)
        },
        new go.Binding("text", "description", (desc: string) => desc ? desc.substring(0, 6) : "..."))
      )
    );
  }
  
  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (!this.diagram) return;
    
    const self = this;
    
    // 选择移动完成
    this.addTrackedListener('SelectionMoved', (e: any) => {
      const projectIdAtMove = self.store.activeProjectId();
      
      if (self.positionSaveTimer) {
        clearTimeout(self.positionSaveTimer);
      }
      
      self.positionSaveTimer = setTimeout(() => {
        if (self.isDestroyed) return;
        if (self.store.activeProjectId() !== projectIdAtMove) return;
        
        const movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }> = [];
        
        e.subject.each((part: any) => {
          if (part instanceof go.Node) {
            const loc = part.location;
            const nodeData = part.data;
            
            movedNodes.push({
              key: nodeData.key,
              x: loc.x,
              y: loc.y,
              isUnassigned: nodeData?.isUnassigned || nodeData?.stage === null
            });
          }
        });
        
        if (movedNodes.length > 0) {
          self.zone.run(() => {
            self.selectionMovedCallback?.(movedNodes);
          });
        }
      }, GOJS_CONFIG.POSITION_SAVE_DEBOUNCE);
    });
    
    // 连接线绘制/重连
    this.addTrackedListener('LinkDrawn', (e: any) => {
      const link = e.subject;
      
      if (!environment.production) {
        console.log('🔗 LinkDrawn 事件', {
          link存在: !!link,
          linkData存在: !!link?.data,
          fromNode: link?.fromNode?.data?.key,
          toNode: link?.toNode?.data?.key,
          fromPortId: link?.fromPortId,
          toPortId: link?.toPortId
        });
      }
      
      if (link && link.data) {
        const model = this.diagram!.model as go.GraphLinksModel;
        model.setDataProperty(link.data, 'fromPortId', '');
        model.setDataProperty(link.data, 'toPortId', '');
        link.invalidateRoute();
      }
      this.handleLinkGestureInternal(e);
    });
    this.addTrackedListener('LinkRelinked', (e: any) => this.handleLinkGestureInternal(e));
    
    // 背景点击
    this.addTrackedListener('BackgroundSingleClicked', () => {
      self.zone.run(() => {
        self.backgroundClickCallback?.();
      });
    });
    
    // 视口变化
    this.addTrackedListener('ViewportBoundsChanged', () => {
      self.saveViewState();
    });
    
    // 移动端连接线点击
    if (this.store.isMobile()) {
      this.addTrackedListener('ObjectSingleClicked', (e: any) => {
        const part = e.subject.part;
        if (part instanceof go.Link && part.data) {
          const midPoint = part.midPoint;
          if (midPoint && self.diagramDiv) {
            const viewPt = self.diagram!.transformDocToView(midPoint);
            const rect = self.diagramDiv.getBoundingClientRect();
            self.zone.run(() => {
              self.linkClickCallback?.(part.data, rect.left + viewPt.x, rect.top + viewPt.y);
            });
          }
        }
      });
    }
  }
  
  /**
   * 处理连接手势（内部）
   */
  private handleLinkGestureInternal(e: any): void {
    if (!this.diagram || !this.diagramDiv) return;
    
    const link = e.subject;
    const fromNode = link?.fromNode;
    const toNode = link?.toNode;
    const sourceId = fromNode?.data?.key;
    const targetId = toNode?.data?.key;
    
    if (!sourceId || !targetId || sourceId === targetId) return;
    
    // 获取连接终点位置
    const midPoint = link.midPoint || toNode.location;
    const viewPt = this.diagram.transformDocToView(midPoint);
    const diagramRect = this.diagramDiv.getBoundingClientRect();
    const x = diagramRect.left + viewPt.x;
    const y = diagramRect.top + viewPt.y;
    
    this.zone.run(() => {
      this.linkGestureCallback?.(sourceId, targetId, x, y, link);
    });
  }
  
  /**
   * 添加追踪的事件监听器
   */
  private addTrackedListener(name: go.DiagramEventName, handler: (e: any) => void): void {
    if (!this.diagram) return;
    this.diagram.addDiagramListener(name, handler);
    this.diagramListeners.push({ name, handler });
  }
  
  /**
   * 设置 ResizeObserver
   */
  private setupResizeObserver(): void {
    if (!this.diagramDiv) return;
    
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      
      this.resizeDebounceTimer = setTimeout(() => {
        if (this.isDestroyed || !this.diagram || !this.diagramDiv) return;
        
        const width = this.diagramDiv.clientWidth;
        const height = this.diagramDiv.clientHeight;
        
        if (width > 0 && height > 0) {
          this.diagram.div = null;
          this.diagram.div = this.diagramDiv;
          this.diagram.requestUpdate();
        }
      }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
    });
    
    this.resizeObserver.observe(this.diagramDiv);
  }
  
  /**
   * 保存视图状态（防抖）
   */
  private saveViewState(): void {
    if (!this.diagram) return;
    
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }
    
    this.viewStateSaveTimer = setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;
      
      const projectId = this.store.activeProjectId();
      if (!projectId) return;
      
      const scale = this.diagram.scale;
      const pos = this.diagram.position;
      
      this.store.updateViewState(projectId, {
        scale,
        positionX: pos.x,
        positionY: pos.y
      });
      
      this.viewStateSaveTimer = null;
    }, 1000);
  }
  
  /**
   * 恢复视图状态
   * 如果没有保存的视图状态，则自动适应内容
   */
  private restoreViewState(): void {
    if (!this.diagram) return;
    
    const viewState = this.store.getViewState();
    
    setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;
      
      if (viewState) {
        // 恢复保存的视图状态
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        // 没有保存的视图状态，自动适应内容
        // 稍后执行，确保节点已经加载
        setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          this.fitToContents();
        }, 300);
      }
    }, 200);
  }
  
  /**
   * 清理所有定时器
   */
  private clearAllTimers(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
  }
  
  /**
   * 处理错误
   */
  private handleError(userMessage: string, error: unknown): void {
    const errorStr = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
    this.error.set(userMessage);
    this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }
}
