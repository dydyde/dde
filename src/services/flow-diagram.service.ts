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
  
  // ========== 定时器 ==========
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 首次加载标志 ==========
  private isFirstLoad = true;
  
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
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN)
      });
      
      // 设置节点模板
      this.setupNodeTemplate($);
      
      // 设置连接线模板
      this.setupLinkTemplate($);
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key'
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
   * 实现"硬实时连续自适应"：
   * - 当拖动节点到边缘时，小地图实时缩小以适应扩大的世界边界
   * - 零延迟，与鼠标移动同步
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
      
      // 创建 Overview，使用简化的节点模板使节点更明显
      this.overview = $(go.Overview, container, {
        observed: this.diagram,
        contentAlignment: go.Spot.Center,
        "animationManager.isEnabled": false,
        // 让 Overview 完整渲染所有层
        drawsTemporaryLayers: false
      });
      
      // 修改 box（视口框）的视觉样式
      const boxShape = this.overview.box.findObject("BOXSHAPE") as go.Shape;
      if (boxShape) {
        boxShape.stroke = "#4A8C8C";
        boxShape.strokeWidth = 2;
        boxShape.fill = "rgba(74, 140, 140, 0.15)";
      }
      
      // 为 Overview 设置简化的节点模板，使节点在缩小后仍然可见
      // 使用纯色填充，不依赖原始模板的渐变或透明度
      this.overview.nodeTemplate = $(go.Node, "Auto",
        { locationSpot: go.Spot.Center },
        $(go.Shape, "RoundedRectangle",
          {
            fill: "#374151",  // 深灰色，在白色背景上明显
            stroke: "#1F2937",
            strokeWidth: 1,
            minSize: new go.Size(8, 6)  // 最小尺寸，确保可见
          },
          new go.Binding("fill", "status", (status: string) => {
            // 根据状态使用不同颜色
            switch (status) {
              case 'done': return "#059669";     // 绿色
              case 'in-progress': return "#3B82F6"; // 蓝色
              case 'blocked': return "#DC2626";  // 红色
              default: return "#6B7280";         // 灰色
            }
          })
        )
      );
      
      // 简化的连接线模板
      this.overview.linkTemplate = $(go.Link,
        $(go.Shape, { stroke: "#9CA3AF", strokeWidth: 1 })
      );
      
      // 关键：让 Overview 只显示实际的文档内容，不包含 scrollMargin
      // 这样视口框大小才能正确反映主图的缩放
      this.overview.contentAlignment = go.Spot.Center;
      
      // 初始缩放
      this.overview.scale = 0.15;
      this.lastOverviewScale = 0.15;
      
      // 启用自动缩放逻辑
      this.setupOverviewAutoScale();
      
      this.logger.info('Overview 初始化成功（支持实时自适应）');
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
    
    // 计算视口超出节点边界的扩展因子
    const getExpansionFactor = (): number => {
      if (!this.diagram) return 1;
      
      const nodeBounds = getNodesBounds();
      const viewBounds = this.diagram.viewportBounds;
      
      // 检查视口是否完全在节点边界内
      if (viewBounds.x >= nodeBounds.x && 
          viewBounds.y >= nodeBounds.y &&
          viewBounds.right <= nodeBounds.right &&
          viewBounds.bottom <= nodeBounds.bottom) {
        return 1; // 完全在内部，不需要扩展
      }
      
      // 计算需要显示的总范围
      const totalMinX = Math.min(nodeBounds.x, viewBounds.x);
      const totalMinY = Math.min(nodeBounds.y, viewBounds.y);
      const totalMaxX = Math.max(nodeBounds.right, viewBounds.right);
      const totalMaxY = Math.max(nodeBounds.bottom, viewBounds.bottom);
      
      const totalWidth = totalMaxX - totalMinX;
      const totalHeight = totalMaxY - totalMinY;
      
      const widthFactor = totalWidth / nodeBounds.width;
      const heightFactor = totalHeight / nodeBounds.height;
      
      return Math.max(widthFactor, heightFactor);
    };
    
    // 初始化：计算并设置固定的基准缩放
    let baseScale = calculateBaseScale();
    let lastExpansionFactor = 1;
    this.lastOverviewScale = baseScale;
    this.overview.scale = baseScale;
    
    // 监听文档变化：只在节点增删时重新计算基准缩放
    this.addTrackedListener('DocumentBoundsChanged', () => {
      if (!this.overview || !this.diagram) return;
      
      const newBaseScale = calculateBaseScale();
      // 只有变化显著时才更新
      if (Math.abs(newBaseScale - baseScale) > 0.02) {
        baseScale = newBaseScale;
        const factor = getExpansionFactor();
        this.overview.scale = baseScale / factor;
        this.lastOverviewScale = this.overview.scale;
        lastExpansionFactor = factor;
      }
    });
    
    // 监听视口变化：只在超出边界时调整
    this.addTrackedListener('ViewportBoundsChanged', () => {
      if (!this.overview || !this.diagram) return;
      
      const factor = getExpansionFactor();
      
      // 只有扩展因子变化显著时才更新
      if (Math.abs(factor - lastExpansionFactor) > 0.02) {
        const newScale = baseScale / factor;
        this.overview.scale = Math.max(0.01, Math.min(0.5, newScale));
        this.lastOverviewScale = this.overview.scale;
        lastExpansionFactor = factor;
      }
      // 否则保持 scale 不变，让视口框自然变化
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
        background: '#F9F8F6', // 使用流程图背景色
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
        background: '#F9F8F6',
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
      if (lastUpdateType === 'position' && !forceRefresh) {
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
      
      const model = this.diagram.model as any;
      model.mergeNodeDataArray(diagramData.nodeDataArray);
      model.mergeLinkDataArray(diagramData.linkDataArray);
      
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
   */
  private setupNodeTemplate($: any): void {
    if (!this.diagram) return;
    
    const self = this;
    
    this.diagram.nodeTemplate = $(go.Node, "Spot",
      {
        locationSpot: go.Spot.Center,
        selectionAdorned: true,
        click: (e: any, node: any) => {
          if (e.diagram.lastInput.dragging) return;
          self.zone.run(() => {
            self.nodeClickCallback?.(node.data.key, false);
          });
        },
        doubleClick: (e: any, node: any) => {
          self.zone.run(() => {
            self.nodeClickCallback?.(node.data.key, true);
          });
        }
      },
      new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
      
      // 主面板
      this.configService.getNodeMainPanelConfig($),
      
      // 端口
      this.configService.createPort($, "T", go.Spot.Top, true, true),
      this.configService.createPort($, "L", go.Spot.Left, true, true),
      this.configService.createPort($, "R", go.Spot.Right, true, true),
      this.configService.createPort($, "B", go.Spot.Bottom, true, true)
    );
  }
  
  /**
   * 设置连接线模板
   */
  private setupLinkTemplate($: any): void {
    if (!this.diagram) return;
    
    const self = this;
    const isMobile = this.store.isMobile();
    
    this.diagram.linkTemplate = $(go.Link,
      {
        routing: go.Link.AvoidsNodes,
        curve: go.Link.JumpOver,
        corner: 12,
        toShortLength: 4,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: true,
        resegmentable: true,
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
        $(go.TextBlock, "🔗", { font: "8px sans-serif" }),
        $(go.TextBlock, {
          font: "500 8px sans-serif",
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
    this.addTrackedListener('LinkDrawn', (e: any) => this.handleLinkGestureInternal(e));
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
