import { Injectable, inject, signal, NgZone } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { Task } from '../models';
import { environment } from '../environments/environment';
import { UI_CONFIG } from '../config/constants';
import * as go from 'gojs';

/**
 * 视图状态（用于保存/恢复）
 * @internal 仅用于文档目的
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}

/**
 * FlowDiagramService - GoJS 图表核心服务（精简版）
 * 
 * 重构后职责：
 * - GoJS Diagram 实例的生命周期管理
 * - 小地图 (Overview) 管理
 * - 图表数据更新
 * - 视图状态保存/恢复
 * - 导出功能
 * 
 * 已委托的职责：
 * - 模板配置 → FlowTemplateService
 * - 事件处理 → FlowEventService
 * - 布局操作 → FlowLayoutService
 * - 选择管理 → FlowSelectionService
 * - 缩放控制 → FlowZoomService
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramService {
  private readonly store = inject(StoreService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly configService = inject(FlowDiagramConfigService);
  
  // ========== 委托的子服务 ==========
  private readonly layoutService = inject(FlowLayoutService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly eventService = inject(FlowEventService);
  private readonly templateService = inject(FlowTemplateService);
  
  // ========== 内部状态 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;
  
  // ========== 小地图状态 ==========
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private lastOverviewScale: number = 0.1;
  private isNodeDragging: boolean = false;
  private overviewUpdatePending: boolean = false;
  private overviewBoundsCache: string = '';
  private isApplyingOverviewViewportUpdate: boolean = false;
  private overviewUpdateQueuedWhileApplying: boolean = false;
  private overviewScheduleUpdate: ((source: 'viewport' | 'document') => void) | null = null;

  // Overview 交互状态：用户拖拽导航图视口框时会导致主视口高频变化
  // 用于在交互期间进行更强的节流，避免大图时卡顿/卡死
  private isOverviewInteracting: boolean = false;
  private overviewInteractionLastApplyAt = 0;
  private overviewPointerCleanup: (() => void) | null = null;

  // ========== Overview 调试日志（限频，避免刷屏） ==========
  private overviewDebugLastLogAt = 0;
  private overviewDebugSuppressedCount = 0;
  private overviewDebugUpdateCalls = 0;
  
  // ========== 定时器 ==========
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;

  // ========== 视图切换稳定性 ==========
  private pendingAutoFitToContents = false;
  
  // ========== 首次加载标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;
  
  // ========== 僵尸模式 ==========
  private isSuspended = false;
  private suspendedResizeObserver: ResizeObserver | null = null;
  
  // ========== 公开信号 ==========
  readonly error = signal<string | null>(null);
  
  // ========== 公开属性 ==========
  
  get diagramInstance(): go.Diagram | null {
    return this.diagram;
  }
  
  get isInitialized(): boolean {
    return this.diagram !== null && !this.isDestroyed;
  }
  
  get isSuspendedMode(): boolean {
    return this.isSuspended;
  }
  
  // ========== 生命周期方法 ==========
  
  /**
   * 初始化 GoJS Diagram
   */
  initialize(container: HTMLDivElement): boolean {
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载', 'GoJS library not loaded');
      return false;
    }
    
    try {
      this.isDestroyed = false;
      this.isFirstLoad = true;
      this.diagramDiv = container;
      
      if (environment.gojsLicenseKey) {
        (go.Diagram as any).licenseKey = environment.gojsLicenseKey;
      }
      
      const $ = go.GraphObject.make;
      
      // 创建 Diagram 实例
      this.diagram = $(go.Diagram, container, {
        "undoManager.isEnabled": false,
        "animationManager.isEnabled": false,
        "allowDrop": true,
        layout: $(go.Layout),
        "autoScale": go.Diagram.None,
        "initialAutoScale": go.Diagram.None,
        "scrollMargin": new go.Margin(5000, 5000, 5000, 5000),
        "draggingTool.isGridSnapEnabled": false,
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
        "computePixelRatio": () => window.devicePixelRatio || 1
      });

      // 委托给 FlowTemplateService 设置图层和模板
      this.templateService.ensureDiagramLayers(this.diagram);
      this.templateService.setupNodeTemplate(this.diagram);
      this.templateService.setupLinkTemplate(this.diagram);
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId'
      });
      
      // 委托给 FlowEventService 设置事件监听
      this.eventService.setDiagram(this.diagram, this.diagramDiv);
      
      // 添加视口变化监听（用于保存视图状态）
      this.diagram.addDiagramListener('ViewportBoundsChanged', () => {
        this.saveViewState();
      });
      
      // 设置 ResizeObserver
      this.setupResizeObserver();
      
      // 恢复视图状态
      this.restoreViewState();
      
      // 将 diagram 实例传递给其他子服务
      this.layoutService.setDiagram(this.diagram);
      this.selectionService.setDiagram(this.diagram);
      this.zoomService.setDiagram(this.diagram);
      
      this.error.set(null);
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }
  
  /**
   * 暂停图表（僵尸模式）
   */
  suspend(): void {
    if (!this.diagram || this.isSuspended) return;
    
    try {
      this.logger.info('进入僵尸模式');
      
      this.diagram.isReadOnly = true;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.resizeObserver) {
        this.suspendedResizeObserver = this.resizeObserver;
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      
      this.clearAllTimers();
      
      if (this.overview) {
        this.overview.animationManager.isEnabled = false;
      }
      
      this.isSuspended = true;
    } catch (error) {
      this.logger.error('暂停图表失败:', error);
    }
  }
  
  /**
   * 恢复图表
   */
  resume(): void {
    if (!this.diagram || !this.isSuspended) return;
    
    try {
      this.logger.info('退出僵尸模式');
      
      this.isSuspended = false;
      this.diagram.isReadOnly = false;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.suspendedResizeObserver && this.diagramDiv) {
        this.resizeObserver = this.suspendedResizeObserver;
        this.resizeObserver.observe(this.diagramDiv);
        this.suspendedResizeObserver = null;
      } else if (!this.resizeObserver && this.diagramDiv) {
        this.setupResizeObserver();
      }
      
      if (this.overview) {
        this.overview.animationManager.isEnabled = false;
        this.overview.requestUpdate();
      }
      
      this.diagram.requestUpdate();
      
      requestAnimationFrame(() => {
        if (!this.diagram || this.isDestroyed) return;
        
        this.diagram.nodes.each((node: go.Node) => {
          node.invalidateLayout();
        });
        this.diagram.links.each((link: go.Link) => {
          link.invalidateRoute();
        });
        
        this.diagram.requestUpdate();
        
        if (this.overview) {
          this.overview.requestUpdate();
        }
      });
    } catch (error) {
      this.logger.error('恢复图表失败:', error);
    }
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图
   */
  initializeOverview(container: HTMLDivElement): void {
    if (!this.diagram || this.isDestroyed) return;
    
    if (this.overview) {
      this.disposeOverview();
    }
    
    this.overviewContainer = container;
    this.overviewBoundsCache = '';
    this.isOverviewInteracting = false;
    this.overviewInteractionLastApplyAt = 0;
    this.overviewScheduleUpdate = null;
    
    try {
      const $ = go.GraphObject.make;
      const overviewBackground = this.getOverviewBackgroundColor();
      container.style.backgroundColor = overviewBackground;
      
      this.overview = $(go.Overview, container, {
        contentAlignment: go.Spot.Center,
        "animationManager.isEnabled": false,
        "computePixelRatio": () => window.devicePixelRatio || 1
      });
      
      // 委托给 FlowTemplateService 设置 Overview 模板
      this.templateService.setupOverviewNodeTemplate(this.overview);
      this.templateService.setupOverviewLinkTemplate(this.overview);
      
      this.overview.observed = this.diagram;
      
      if (this.diagram) {
        this.diagram.requestUpdate();
      }
      if (this.overview) {
        this.overview.requestUpdate();
      }
      
      // 设置视口框样式
      this.templateService.setupOverviewBoxStyle(this.overview);
      
      this.overview.scale = 0.15;
      this.lastOverviewScale = 0.15;

      this.attachOverviewPointerListeners(container);
      
      this.setupOverviewAutoScale();
      
      const nodeCount = this.diagram.nodes.count;
      const linkCount = this.diagram.links.count;
      this.logger.info(`Overview 初始化成功 - 节点数: ${nodeCount}, 连接数: ${linkCount}`);
    } catch (error) {
      this.logger.error('Overview 初始化失败:', error);
    }
  }
  
  private getOverviewBackgroundColor(): string {
    const styles = this.configService.currentStyles();
    return this.readCssColorVar('--theme-text-dark') ?? styles.text.titleColor ?? '#292524';
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
   * 设置小地图自动缩放
   */
  private setupOverviewAutoScale(): void {
    if (!this.diagram || !this.overview) return;
    
    // ✅ 性能优化：使用 documentBounds（O(1)）替代遍历所有节点（O(n)）
    // GoJS 内部已维护 documentBounds，无需手动计算
    const getNodesBounds = (): go.Rect => {
      if (!this.diagram) return new go.Rect(0, 0, 500, 500);
      
      const docBounds = this.diagram.documentBounds;
      
      // 如果没有节点或边界无效，返回默认值
      if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
        return new go.Rect(-250, -250, 500, 500);
      }
      
      // 添加 padding 与原逻辑一致
      const padding = 80;
      return new go.Rect(
        docBounds.x - padding,
        docBounds.y - padding,
        docBounds.width + padding * 2,
        docBounds.height + padding * 2
      );
    };
    
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
      return Math.max(0.02, Math.min(0.5, scale));
    };
    
    let baseScale = calculateBaseScale();
    let lastNodeDataCount = ((this.diagram.model as any)?.nodeDataArray?.length ?? 0);
    this.lastOverviewScale = clampScale(baseScale);
    this.overview.scale = this.lastOverviewScale;
    
    const nodeBounds = getNodesBounds();
    this.overview.centerRect(nodeBounds);
    
    const limitDisplayBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
      const maxOverflow = 1200; // 限制空白区域对缩放的影响，防止视口远离内容时过度缩小
      const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
      const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
      const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
      const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

      const expandLeft = Math.min(overflowLeft, maxOverflow);
      const expandRight = Math.min(overflowRight, maxOverflow);
      const expandTop = Math.min(overflowTop, maxOverflow);
      const expandBottom = Math.min(overflowBottom, maxOverflow);

      const limited = new go.Rect(
        baseBounds.x - expandLeft,
        baseBounds.y - expandTop,
        baseBounds.width + expandLeft + expandRight,
        baseBounds.height + expandTop + expandBottom
      );

      // 确保限制后的边界至少能容纳视口（含缓冲），避免视口高度大于限制框时上下越界
      const minWidth = viewportBounds.width + 200;
      if (limited.width < minWidth) {
        const pad = (minWidth - limited.width) / 2;
        limited.x -= pad;
        limited.width = minWidth;
      }
      const minHeight = viewportBounds.height + 200;
      if (limited.height < minHeight) {
        const pad = (minHeight - limited.height) / 2;
        limited.y -= pad;
        limited.height = minHeight;
      }

      // 将视口位置限制在限制框内，再合并，确保视口框不会被拉到无限远
      const clampedViewportX = Math.max(limited.x, Math.min(viewportBounds.x, limited.right - viewportBounds.width));
      const clampedViewportY = Math.max(limited.y, Math.min(viewportBounds.y, limited.bottom - viewportBounds.height));
      const clampedViewport = new go.Rect(
        clampedViewportX,
        clampedViewportY,
        viewportBounds.width,
        viewportBounds.height
      );

      return limited.unionRect(clampedViewport);
    };

    let pendingUpdateSource: 'viewport' | 'document' = 'viewport';

    const runViewportUpdate = (source: 'viewport' | 'document') => {
      if (!this.overview || !this.diagram) return;

      this.overviewDebugUpdateCalls++;

      const logOverview = (reason: string, details?: Record<string, unknown>) => {
        // 默认关闭：避免日志本身造成卡顿。需要时可在控制台执行：window.__NF_OVERVIEW_DEBUG = true
        const debugEnabled = !!(globalThis as any)?.__NF_OVERVIEW_DEBUG;
        if (!debugEnabled) return;

        // 日志限频：默认 1000ms 一次（避免生产环境刷屏）
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const minIntervalMs = 1000;
        if (now - this.overviewDebugLastLogAt < minIntervalMs) {
          this.overviewDebugSuppressedCount++;
          return;
        }
        const suppressed = this.overviewDebugSuppressedCount;
        this.overviewDebugSuppressedCount = 0;
        this.overviewDebugLastLogAt = now;

        // debugEnabled=true 时才输出，用 warn 方便用户直接看到
        this.logger.warn('[OverviewPerf]', {
          reason,
          calls: this.overviewDebugUpdateCalls,
          suppressed,
          pending: this.overviewUpdatePending,
          applying: this.isApplyingOverviewViewportUpdate,
          queuedWhileApplying: this.overviewUpdateQueuedWhileApplying,
          source,
          ...(details ?? {})
        });
      };

      // 防止 scale/centerRect 等操作引起 ViewportBoundsChanged 递归触发导致卡顿/卡死
      if (this.isApplyingOverviewViewportUpdate) {
        logOverview('skip:reentrant');
        return;
      }
      this.isApplyingOverviewViewportUpdate = true;

      try {

        // 用户正在拖拽导航图（视口框）时：完全不做 viewport 驱动的自动缩放/边界更新
        // 否则会与用户拖拽产生“拉扯”，并在节点多时触发卡死。
        if (this.isOverviewInteracting && source === 'viewport') {
          return;
        }

        const viewportBounds = this.diagram.viewportBounds;
        if (!viewportBounds.isReal()) {
          logOverview('skip:viewport-not-real');
          return;
        }
      
        const nodeBounds = getNodesBounds();
        const totalBounds = this.calculateTotalBounds();
      
        const isViewportOutside = 
          viewportBounds.x < nodeBounds.x - 50 ||
          viewportBounds.y < nodeBounds.y - 50 ||
          viewportBounds.right > nodeBounds.right + 50 ||
          viewportBounds.bottom > nodeBounds.bottom + 50;

        // 关键场景打点：你描述的“向下拖到很远”通常是 Y 方向超界
        if (isViewportOutside) {
          logOverview('state:viewport-outside', {
            viewport: {
              x: Math.round(viewportBounds.x),
              y: Math.round(viewportBounds.y),
              w: Math.round(viewportBounds.width),
              h: Math.round(viewportBounds.height)
            },
            nodeBounds: {
              x: Math.round(nodeBounds.x),
              y: Math.round(nodeBounds.y),
              w: Math.round(nodeBounds.width),
              h: Math.round(nodeBounds.height)
            }
          });
        }
      
        if (this.overviewContainer) {
          const containerWidth = this.overviewContainer.clientWidth;
          const containerHeight = this.overviewContainer.clientHeight;
        
          if (containerWidth > 0 && containerHeight > 0 && totalBounds.width > 0 && totalBounds.height > 0) {
            // rawBounds：真实内容 + 真实视口（保证视口框始终在导航图“世界范围”内）
            const rawBounds = isViewportOutside
              ? nodeBounds.copy().unionRect(viewportBounds)
              : nodeBounds;
            // scaleBounds：用于缩放计算的“展示边界”（限幅以避免过度缩小）
            const scaleBounds = isViewportOutside
              ? limitDisplayBounds(rawBounds, viewportBounds)
              : rawBounds;

            // 取整避免浮点抖动导致 boundsKey 高频变化（尤其在边界拖拽/缩放时）
            const q = (v: number) => Math.round(v);
            const boundsKey = `${q(rawBounds.x)}|${q(rawBounds.y)}|${q(rawBounds.width)}|${q(rawBounds.height)}`;
            if (boundsKey !== this.overviewBoundsCache) {
              this.overviewBoundsCache = boundsKey;
              this.setOverviewFixedBounds(rawBounds);
              // 重要：不要在 viewport 变化时频繁 centerRect，否则会抵消用户拖动造成“看起来不动/卡住”
              // Overview 自身会根据 observed 内容 + contentAlignment 进行呈现。

              logOverview('apply:bounds', {
                rawBounds: {
                  x: q(rawBounds.x),
                  y: q(rawBounds.y),
                  w: q(rawBounds.width),
                  h: q(rawBounds.height)
                },
                scaleBounds: {
                  x: q(scaleBounds.x),
                  y: q(scaleBounds.y),
                  w: q(scaleBounds.width),
                  h: q(scaleBounds.height)
                }
              });
            }

            const currentScale = this.overview.scale;
            const viewportBoxWidth = viewportBounds.width * currentScale;
            const viewportBoxHeight = viewportBounds.height * currentScale;
          
            const boxPadding = 20;
            const needsShrinkForBox = 
              viewportBoxWidth > containerWidth - boxPadding ||
              viewportBoxHeight > containerHeight - boxPadding;
          
            if (isViewportOutside || needsShrinkForBox) {
              const padding = 0.15;
              const scaleX = (containerWidth * (1 - padding * 2)) / scaleBounds.width;
              const scaleY = (containerHeight * (1 - padding * 2)) / scaleBounds.height;
              let targetScale = clampScale(Math.min(scaleX, scaleY, 0.5));
            
              const newViewportBoxWidth = viewportBounds.width * targetScale;
              const newViewportBoxHeight = viewportBounds.height * targetScale;
            
              if (newViewportBoxWidth > containerWidth - boxPadding) {
                targetScale = Math.min(targetScale, (containerWidth - boxPadding) / viewportBounds.width);
              }
              if (newViewportBoxHeight > containerHeight - boxPadding) {
                targetScale = Math.min(targetScale, (containerHeight - boxPadding) / viewportBounds.height);
              }
            
              targetScale = clampScale(targetScale);
            
              if (Math.abs(targetScale - this.overview.scale) > 0.005) {
                this.overview.scale = targetScale;
                this.lastOverviewScale = targetScale;

                logOverview('apply:scale', {
                  targetScale: Number(targetScale.toFixed(4)),
                  mode: isViewportOutside ? 'outside' : 'shrink-for-box'
                });
              }
            } else {
              const targetScale = clampScale(baseScale);
            
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
            
              if (currentScale < finalScale - 0.01) {
                this.overview.scale = finalScale;
                this.lastOverviewScale = finalScale;

                logOverview('apply:scale', {
                  targetScale: Number(finalScale.toFixed(4)),
                  mode: 'back-to-base'
                });
              }
            }
          }
        }
      } finally {
        this.isApplyingOverviewViewportUpdate = false;
        if (this.overviewUpdateQueuedWhileApplying) {
          this.overviewUpdateQueuedWhileApplying = false;
          // 重入期间可能丢掉最后一次状态，这里补一帧
          // 同时记录一次：出现过重入排队
          const debugEnabled = !!(globalThis as any)?.__NF_OVERVIEW_DEBUG;
          if (debugEnabled) {
            this.logger.warn('[OverviewPerf]', { reason: 'flush:queued-while-applying' });
          }
          scheduleViewportUpdate(pendingUpdateSource);
        }
      }
    };

    const scheduleViewportUpdate = (source: 'viewport' | 'document') => {
      // 同一帧内若既有 document 又有 viewport 更新，以 document 为准
      pendingUpdateSource = pendingUpdateSource === 'document' ? 'document' : source;
      if (this.isApplyingOverviewViewportUpdate) {
        this.overviewUpdateQueuedWhileApplying = true;
        const debugEnabled = !!(globalThis as any)?.__NF_OVERVIEW_DEBUG;
        if (debugEnabled && !this.overviewUpdatePending) {
          this.logger.warn('[OverviewPerf]', { reason: 'schedule:queued-while-applying' });
        }
        return;
      }
      if (this.overviewUpdatePending) return;
      this.overviewUpdatePending = true;
      requestAnimationFrame(() => {
        this.overviewUpdatePending = false;
        const src = pendingUpdateSource;
        pendingUpdateSource = 'viewport';
        runViewportUpdate(src);
      });
    };

    // 允许外部（例如导航图 pointerup）触发一次同步
    this.overviewScheduleUpdate = scheduleViewportUpdate;
    
    // 监听文档变化
    this.diagram.addDiagramListener('DocumentBoundsChanged', () => {
      if (!this.overview || !this.diagram) return;

      const currentNodeDataCount = ((this.diagram.model as any)?.nodeDataArray?.length ?? 0);
      const nodeCountChanged = currentNodeDataCount !== lastNodeDataCount;
      
      const newBaseScale = calculateBaseScale();
      if (nodeCountChanged || Math.abs(newBaseScale - baseScale) > 0.02) {
        baseScale = newBaseScale;
        this.overview.scale = clampScale(baseScale);
        this.lastOverviewScale = this.overview.scale;

        if (nodeCountChanged) {
          const bounds = getNodesBounds();
          this.overview.centerRect(bounds);
          lastNodeDataCount = currentNodeDataCount;
        }
      }

      scheduleViewportUpdate('document');
    });
    
    // 监听视口变化
    this.diagram.addDiagramListener('ViewportBoundsChanged', () => {
      if (!this.overview || !this.diagram || this.isNodeDragging) {
        return;
      }
      scheduleViewportUpdate('viewport');
    });
    
    // 监听滚动结束，确保 fixedBounds 清理（避免缩放被锁在极值）
    this.diagram.addDiagramListener('ViewportBoundsChanged', (e: go.DiagramEvent) => {
      if (!this.overview || !this.diagram || this.isNodeDragging) return;
      if (e.diagram.lastInput.up) {
        // 滚动停止后，如果视口重新进入内容区域，释放 fixedBounds
        const viewport = this.diagram.viewportBounds;
        const nodes = getNodesBounds();
        const backInContent =
          viewport.x >= nodes.x - 50 &&
          viewport.y >= nodes.y - 50 &&
          viewport.right <= nodes.right + 50 &&
          viewport.bottom <= nodes.bottom + 50;
        if (backInContent) {
          this.overviewBoundsCache = '';
          this.setOverviewFixedBounds(null);
        }
      }
    });
    
    this.logger.debug('Overview 自动缩放已启用');
  }
  
  private calculateTotalBounds(): go.Rect {
    if (!this.diagram) return new go.Rect(0, 0, 100, 100);
    
    const docBounds = this.diagram.documentBounds;
    const viewBounds = this.diagram.viewportBounds;
    
    if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
      return viewBounds.copy();
    }
    
    const minX = Math.min(docBounds.x, viewBounds.x);
    const minY = Math.min(docBounds.y, viewBounds.y);
    const maxX = Math.max(docBounds.x + docBounds.width, viewBounds.x + viewBounds.width);
    const maxY = Math.max(docBounds.y + docBounds.height, viewBounds.y + viewBounds.height);
    
    return new go.Rect(minX, minY, maxX - minX, maxY - minY);
  }
  
  disposeOverview(): void {
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
  }

  private attachOverviewPointerListeners(container: HTMLDivElement): void {
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }

    const onPointerDown = () => {
      this.isOverviewInteracting = true;
    };
    const onPointerUpLike = () => {
      if (!this.isOverviewInteracting) return;
      this.isOverviewInteracting = false;
      this.overviewInteractionLastApplyAt = 0;

      // 交互结束后强制补一次同步：让 Overview 的缩放/边界跟上最新主视口
      this.overviewBoundsCache = '';
      this.overviewScheduleUpdate?.('viewport');

      // 交互结束后补一帧更新：避免出现“视口框能动但缩略块不跟随/像卡住”的最终状态
      requestAnimationFrame(() => {
        if (this.isDestroyed || !this.diagram || !this.overview) return;
        this.overview.requestUpdate();
        this.diagram.requestUpdate();
      });
    };

    container.addEventListener('pointerdown', onPointerDown, { passive: true });
    container.addEventListener('pointerup', onPointerUpLike, { passive: true });
    container.addEventListener('pointercancel', onPointerUpLike, { passive: true });
    container.addEventListener('pointerleave', onPointerUpLike, { passive: true });

    this.overviewPointerCleanup = () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointerup', onPointerUpLike);
      container.removeEventListener('pointercancel', onPointerUpLike);
      container.removeEventListener('pointerleave', onPointerUpLike);
    };
  }
  
  /**
   * 销毁 Diagram 实例
   */
  dispose(): void {
    this.isDestroyed = true;
    this.isFirstLoad = true;
    
    this.disposeOverview();
    this.clearAllTimers();
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // 清理事件服务
    this.eventService.dispose();
    
    if (this.diagram) {
      this.diagram.div = null;
      this.diagram.clear();
      this.diagram = null;
    }
    
    this.diagramDiv = null;
    
    // 清理子服务
    this.layoutService.dispose();
    this.selectionService.setDiagram(null);
    this.zoomService.dispose();
    
    this.logger.info('GoJS Diagram 已销毁');
  }
  
  // ========== 导出功能 ==========
  
  async exportToPng(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      const imgData = this.diagram.makeImageData({
        scale: 2,
        background: '#F5F2E9',
        type: 'image/png',
        maxSize: new go.Size(4096, 4096)
      }) as string;
      
      if (!imgData) {
        this.toast.error('导出失败', '无法生成图片');
        return null;
      }
      
      const response = await fetch(imgData);
      const blob = await response.blob();
      
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.toast.success('导出成功', 'PNG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 PNG 失败', error);
      this.toast.error('导出失败', '生成图片时发生错误');
      return null;
    }
  }
  
  async exportToSvg(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      const svg = this.diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096)
      });
      
      if (!svg) {
        this.toast.error('导出失败', '无法生成 SVG');
        return null;
      }
      
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.toast.success('导出成功', 'SVG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 SVG 失败', error);
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      return null;
    }
  }
  
  private getExportFileName(): string {
    const project = this.store.activeProject();
    const projectName = project?.name || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
  }
  
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
  
  // ========== 图表操作 ==========
  
  /**
   * 移除连接线
   */
  removeLink(link: go.Link): void {
    if (this.diagram && link) {
      const model = this.diagram.model as go.GraphLinksModel;
      if (link.data && model.linkDataArray) {
        this.diagram.startTransaction('remove-link');
        model.removeLinkData(link.data);
        this.diagram.commitTransaction('remove-link');
      } else {
        this.diagram.remove(link);
      }
    }
  }
  
  /**
   * 选中指定节点
   */
  selectNode(nodeKey: string): void {
    this.selectionService.selectNode(nodeKey, true);
  }
  
  /**
   * 获取最后的输入点
   */
  getLastInputViewPoint(): go.Point | null {
    return this.diagram?.lastInput?.viewPoint || null;
  }
  
  /**
   * 由外部在 Flow 视图激活时调用
   */
  onFlowActivated(): void {
    if (this.isDestroyed || !this.diagram) return;
    if (this.store.activeView() !== 'flow') return;
    if (!this.pendingAutoFitToContents) return;

    const viewState = this.store.getViewState();
    if (viewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = viewState.scale;
      this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      return;
    }

    this.pendingAutoFitToContents = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.isDestroyed || !this.diagram) return;
        this.zoomService.fitToContents();
      });
    });
  }
  
  // ========== 图表数据更新 ==========
  
  private detectStructuralChange(currentNodeMap: Map<string, any>, newTasks: Task[]): boolean {
    if (currentNodeMap.size !== newTasks.length) {
      return true;
    }
    
    for (const task of newTasks) {
      const existing = currentNodeMap.get(task.id);
      if (!existing) {
        return true;
      }
      
      if (existing.stage !== task.stage ||
          existing.status !== task.status ||
          existing.parentId !== task.parentId) {
        return true;
      }
    }
    
    const newTaskIds = new Set(newTasks.map(t => t.id));
    for (const key of currentNodeMap.keys()) {
      if (!newTaskIds.has(key)) {
        return true;
      }
    }
    
    const project = this.store.activeProject();
    if (project) {
      const model = this.diagram?.model as any;
      if (model) {
        const currentLinkCount = (model.linkDataArray || []).length;
        const parentChildCount = newTasks.filter(t => t.parentId).length;
        const crossTreeCount = project.connections?.length || 0;
        const expectedLinkCount = parentChildCount + crossTreeCount;
        if (currentLinkCount !== expectedLinkCount) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * 更新图表数据
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
      const lastUpdateType = this.store.getLastUpdateType();
      
      const model = this.diagram.model as any;
      const currentNodeMap = new Map<string, any>();
      (model.nodeDataArray || []).forEach((n: any) => {
        if (n.key) currentNodeMap.set(n.key, n);
      });
      
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);
      
      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }
      
      const existingNodeMap = new Map<string, any>();
      (this.diagram.model as any).nodeDataArray.forEach((n: any) => {
        if (n.key) {
          existingNodeMap.set(n.key, n);
        }
      });
      
      const searchQuery = this.store.searchQuery();
      const diagramData = this.configService.buildDiagramData(
        tasks.filter(t => !t.deletedAt),
        project,
        searchQuery,
        existingNodeMap
      );
      
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: any) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });
      
      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;
      
      model.mergeNodeDataArray(diagramData.nodeDataArray);
      
      const linkDataWithPorts = diagramData.linkDataArray.map(link => ({
        ...link,
        fromPortId: "",
        toPortId: ""
      }));
      
      model.mergeLinkDataArray(linkDataWithPorts);
      
      const nodeKeys = new Set(diagramData.nodeDataArray.map(n => n.key));
      const linkKeys = new Set(diagramData.linkDataArray.map(l => l.key));
      
      const nodesToRemove = model.nodeDataArray.filter((n: any) => !nodeKeys.has(n.key));
      nodesToRemove.forEach((n: any) => model.removeNodeData(n));
      
      const linksToRemove = model.linkDataArray.filter((l: any) => !linkKeys.has(l.key));
      linksToRemove.forEach((l: any) => model.removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      if (selectedKeys.size > 0) {
        this.diagram.nodes.each((node: any) => {
          if (selectedKeys.has(node.data?.key)) {
            node.isSelected = true;
          }
        });
      }
      
      this.diagram.links.each((link: go.Link) => {
        link.invalidateRoute();
      });
      
      // Debug 日志
      const linkData = model.linkDataArray;
      if (linkData?.length > 0 && !this._familyColorLogged) {
        this._familyColorLogged = true;
        this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
      }
      
      if (this.overview?.observed) {
        this.overview.updateAllTargetBindings();
      }
      
      if (this.isFirstLoad && diagramData.nodeDataArray.length > 0) {
        this.isFirstLoad = false;
        setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          const viewState = this.store.getViewState();
          if (!viewState) {
            if (this.store.activeView() !== 'flow') {
              this.pendingAutoFitToContents = true;
              return;
            }
            this.zoomService.fitToContents();
          }
        }, 100);
      }
      
    } catch (error) {
      this.handleError('更新流程图失败', error);
    }
  }
  
  // ========== 拖放支持 ==========
  
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
      const jsonData = e.dataTransfer?.getData("application/json");
      const textData = e.dataTransfer?.getData("text");
      const data = jsonData || textData;
      if (!data || !this.diagram) return;
      
      const trimmed = data.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return;
      }
      
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
          this.diagram.requestUpdate();
        }
      }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
    });
    
    this.resizeObserver.observe(this.diagramDiv);
  }
  
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
  
  private restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.store.getViewState();
    if (immediateViewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = immediateViewState.scale;
      this.diagram.position = new go.Point(immediateViewState.positionX, immediateViewState.positionY);
      return;
    }
    
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }

    this.restoreViewStateTimer = setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;

      const viewState = this.store.getViewState();
      
      if (viewState) {
        this.pendingAutoFitToContents = false;
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        if (this.store.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }

        if (this.autoFitTimer) {
          clearTimeout(this.autoFitTimer);
          this.autoFitTimer = null;
        }

        this.autoFitTimer = setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          this.zoomService.fitToContents();
          this.autoFitTimer = null;
        }, 300);
      }
      this.restoreViewStateTimer = null;
    }, 200);
  }
  
  private clearAllTimers(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }
    if (this.autoFitTimer) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }
  }
  
  private handleError(userMessage: string, error: unknown): void {
    const _errorStr = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
    this.error.set(userMessage);
    this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }

  // TS 类型定义不允许 null，这里集中处理为 any 写入
  private setOverviewFixedBounds(bounds: go.Rect | null): void {
    if (!this.overview) return;
    // GoJS 要求 fixedBounds 必须是 Rect 实例或 undefined，不能是 null
    (this.overview as any).fixedBounds = bounds || undefined;
  }
}
