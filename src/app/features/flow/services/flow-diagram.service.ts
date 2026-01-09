import { Injectable, inject, signal, NgZone, effect } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import { getFlowStyles, FlowTheme, FlowColorMode } from '../../../../config/flow-styles';
import { MinimapMathService } from '../../../../services/minimap-math.service';
import { Task } from '../../../../models';
import { environment } from '../../../../environments/environment';
import { UI_CONFIG } from '../../../../config';
import * as go from 'gojs';
import * as Sentry from '@sentry/angular';

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
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly themeService = inject(ThemeService);
  
  // ========== 委托的子服务 ==========
  private readonly layoutService = inject(FlowLayoutService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly eventService = inject(FlowEventService);
  private readonly templateService = inject(FlowTemplateService);
  
  // TODO: 后续重构可将 calculateExtendedBounds 等边界计算逻辑迁移到 MinimapMathService
  // 这将提高可维护性和可测试性（可以独立单元测试，无需 DOM/Canvas）
  private readonly minimapMath = inject(MinimapMathService);
  
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
  
  // ========== DiagramListener 引用（用于清理） ==========
  private overviewDocumentBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewViewportBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;

  // ========== Overview 视口轮询兜底（rAF） ==========
  // 某些设备/浏览器下，拖拽 Overview 的 box 时主图 ViewportBoundsChanged 可能被合并/延迟，
  // 导致我们的小地图 fixedBounds/scale 更新出现“停住后突变”。
  // 这里用 rAF 轮询主图 viewportBounds 变化，确保交互期间必定实时驱动 overviewScheduleUpdate。
  private overviewViewportPollRafId: number | null = null;
  private overviewViewportPollLastKey: string = '';

  // 拖拽 Overview 白色视口框（box）时，主图的 viewportBounds 在某些环境下可能不会逐帧更新。
  // 为了让小地图的“节点缩放/位置映射”实时变化，我们在拖拽期间用指针位置推导一个假 viewportBounds。
  private isOverviewBoxDragging = false;
  private overviewBoxViewportBounds: go.Rect | null = null;
  private overviewDragDebugLastLogAt = 0;
  
  // ========== Overview ResizeObserver ==========
  private overviewResizeObserver: ResizeObserver | null = null;
  
  // ========== 节流状态 ==========
  private throttledUpdateBindingsTimer: ReturnType<typeof setTimeout> | null = null;
  private throttledUpdateBindingsPending = false;
  
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
  
  // ========== 主题变化监听 ==========
  private themeChangeEffect = effect(() => {
    // 监听颜色模式变化，触发 GoJS 重绘
    const isDark = this.themeService.isDark();
    const theme = this.themeService.theme();
    
    // 只在 diagram 已初始化时重绘
    if (this.diagram && !this.isDestroyed && !this.isSuspended) {
      this.zone.runOutsideAngular(() => {
        // 重新设置模板并更新绑定
        this.templateService.setupNodeTemplate(this.diagram!);
        this.templateService.setupLinkTemplate(this.diagram!);
        
        // 更新所有节点和连接线的绑定
        this.diagram!.updateAllTargetBindings();
        
        // 更新画布背景色
        const flowStyles = getFlowStyles(theme as FlowTheme, isDark ? 'dark' : 'light');
        this.diagram!.div!.style.backgroundColor = flowStyles.canvas.background;
        
        // 更新 Overview（如果存在）
        if (this.overview && this.overviewContainer) {
          this.overview.updateAllTargetBindings();
          // 更新小地图背景色
          const overviewBackground = this.getOverviewBackgroundColor();
          this.overviewContainer.style.backgroundColor = overviewBackground;
        }
        
        this.logger.debug('主题变化触发 GoJS 重绘', { isDark, theme });
      });
    }
  });
  
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
        (go.Diagram as unknown as { licenseKey: string }).licenseKey = environment.gojsLicenseKey;
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
        // 无限画布：使用 InfiniteScroll 模式，允许视口自由移动到任何位置
        "scrollMode": go.Diagram.InfiniteScroll,
        "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
        "draggingTool.isGridSnapEnabled": false,
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
        "computePixelRatio": () => window.devicePixelRatio || 1,
        // 减少 tooltip 悬停延迟（默认 850ms，改为 200ms）
        "toolManager.hoverDelay": 200
      });

      const isMobile = this.uiState.isMobile();

      // 【关键】在设置模板之前先配置 ToolManager
      // 某些移动端环境（Android 6.0 / Chrome Mobile）在 setupLinkTemplate 创建 contextMenu 时
      // 会内部访问 contextMenuTool.isEnabled，如果此时未初始化会抛出错误
      // 参见 Sentry: "Trying to set undefined property contextMenuTool.isEnabled"
      if (this.diagram.toolManager.contextMenuTool) {
        this.diagram.toolManager.contextMenuTool.isEnabled = false;
      }
      
      // 委托给 FlowTemplateService 设置图层和模板
      this.templateService.ensureDiagramLayers(this.diagram);
      this.templateService.setupNodeTemplate(this.diagram);
      this.templateService.setupLinkTemplate(this.diagram);
      
      // 配置工具行为：桌面端左键平移、右键框选；移动端保持原策略
      if (isMobile) {
        this.diagram.toolManager.dragSelectingTool.isEnabled = false;
        this.diagram.toolManager.panningTool.isEnabled = true;
      } else {
        this.setupDesktopPanAndSelectTools(this.diagram);
      }
      this.setupMultiSelectClickTool(this.diagram);
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId'
      });
      
      // 【关键】拦截 GoJS 默认删除行为，强制单向数据流 (Store -> Signal -> Diagram)
      // 这可以防止“脑裂”——GoJS 认为节点删了，但 Store 还没反应过来
      this.setupDeleteKeyInterception();
      
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
      
      // 初始化时设置正确的画布背景色
      this.applyCanvasBackground();
      
      this.error.set(null);
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'initDiagram' } });
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }

  /**
   * 桌面端交互：左键平移视口、右键框选
   */
  private setupDesktopPanAndSelectTools(diagram: go.Diagram): void {
    const panningTool = diagram.toolManager.panningTool;
    const dragSelectTool = diagram.toolManager.dragSelectingTool;

    // 左键在空白处拖拽视口
    panningTool.isEnabled = true;
    panningTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.left) return false;
      // 允许 Ctrl/Cmd 按下时仍可拖动画布（常见“按住 Ctrl 临时平移/查看”的习惯）
      // 保留 Shift/Alt：避免与其他修饰键交互冲突
      if (e.shift || e.alt) return false;
      if (e.targetDiagram !== this.diagram) return false;

      // 避免拦截节点/连线的拖动
      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return this.diagram.allowHorizontalScroll || this.diagram.allowVerticalScroll;
    };

    // 右键拖拽框选
    dragSelectTool.isEnabled = true;
    dragSelectTool.isPartialInclusion = true;
    dragSelectTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.right) return false;
      if (e.targetDiagram !== this.diagram) return false;

      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return true;
    };
  }

  /**
   * 自定义点击选择行为
   * - 在 GoJS 默认选择逻辑之前处理多选（Shift/Ctrl/Cmd 或移动端框选模式）
   * - 解决默认 ClickSelectingTool 先清空选择、再触发节点 click 导致无法多选的问题
   */
  private setupMultiSelectClickTool(diagram: go.Diagram): void {
    const clickTool = diagram.toolManager.clickSelectingTool;
    const isMobileMode = this.uiState.isMobile();
    // GoJS 类型声明将 standardMouseSelect 定义为无参方法，但实际会以 (e, obj) 调用
    const originalStandardMouseSelect = (clickTool.standardMouseSelect as (e?: go.InputEvent, obj?: go.GraphObject | null) => void).bind(clickTool);
    const originalStandardTouchSelect = ((clickTool as unknown as { standardTouchSelect?: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect)?.bind(clickTool);

    (clickTool as unknown as { standardMouseSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardMouseSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
      // 如果事件已经被模板 click（或其他工具）处理过，避免重复切换导致“选中闪烁/失效”
      if (e?.handled) return;

      const dragSelectTool = diagram.toolManager.dragSelectingTool;
      const lastInput = diagram.lastInput as go.InputEvent | null;
      const domEvent = (e as go.InputEvent & { event?: MouseEvent | PointerEvent | KeyboardEvent })?.event;

      // 移动端框选模式：点击节点时禁用默认单选，交给节点模板或下方逻辑处理
      const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);
      if (isSelectModeActive && obj?.part instanceof go.Node) {
        console.log('[FlowDiagram] standardMouseSelect - 框选模式激活', { nodeKey: obj.part.key, isSelected: obj.part.isSelected });
        if (e) {
          e.handled = true;
        } else {
          console.warn('[FlowDiagram] 事件对象为 undefined，无法标记为已处理');
        }
        // 在事务中切换选中状态
        diagram.startTransaction('toggle-selection');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('toggle-selection');
        // 手动触发 ChangedSelection 事件
        diagram.raiseDiagramEvent('ChangedSelection');
        console.log('[FlowDiagram] 切换选中状态完成', { 
          nodeKey: obj.part.key, 
          newState: obj.part.isSelected,
          totalSelected: diagram.selection.count
        });
        return;
      }

      const shift = Boolean(e?.shift || lastInput?.shift || domEvent?.shiftKey);
      const ctrl = Boolean(e?.control || lastInput?.control || (domEvent as MouseEvent | undefined)?.ctrlKey);
      const meta = Boolean(e?.meta || lastInput?.meta || (domEvent as MouseEvent | undefined)?.metaKey);
      // 桌面端：仅修饰键触发多选；移动端框选模式的点选在模板事件中处理
      const wantsMultiSelect = shift || ctrl || meta;

      if (wantsMultiSelect && obj?.part instanceof go.Node) {
        if (e) {
          e.handled = true;
        } else {
          console.warn('[FlowDiagram] 多选模式下事件对象为 undefined');
        }
        diagram.startTransaction('multi-select');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('multi-select');
        // 显式触发 ChangedSelection，确保 FlowSelectionService 同步（避免某些路径下事件不触发）
        diagram.raiseDiagramEvent('ChangedSelection');
        return;
      }

      // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
      if (e) {
        originalStandardMouseSelect(e, obj);
      } else {
        console.warn('[FlowDiagram] 跳过 originalStandardMouseSelect 调用（事件为 undefined）');
      }
    };

    // 移动端：触摸点击也会走 standardTouchSelect（不重写会导致先清空 selection，从而无法“点击追加多选”）
    if (typeof originalStandardTouchSelect === 'function') {
      (clickTool as unknown as { standardTouchSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
        const dragSelectTool = diagram.toolManager.dragSelectingTool;
        const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

        // 仅在移动端框选模式下启用"点选多选"
        if (isSelectModeActive && obj?.part instanceof go.Node) {
          if (e) {
            e.handled = true;
          } else {
            console.warn('[FlowDiagram] Touch 事件对象为 undefined');
          }
          // 在事务中切换选中状态
          diagram.startTransaction('toggle-selection');
          obj.part.isSelected = !obj.part.isSelected;
          diagram.commitTransaction('toggle-selection');
          // 手动触发 ChangedSelection 事件
          diagram.raiseDiagramEvent('ChangedSelection');
          console.log('[FlowDiagram] Touch 切换完成', { 
            nodeKey: obj.part.key, 
            newState: obj.part.isSelected,
            totalSelected: diagram.selection.count
          });
          return;
        }
        // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
        if (e) {
          originalStandardTouchSelect(e, obj);
        } else {
          console.warn('[FlowDiagram] 跳过 originalStandardTouchSelect 调用（事件为 undefined）');
        }
      };
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
    
    // 使用 requestAnimationFrame 确保 DOM 布局完成后再初始化
    // 修复手机端容器尺寸未就绪导致的渲染问题
    requestAnimationFrame(() => {
      if (this.isDestroyed || !this.diagram) return;
      
      // 检查容器尺寸是否有效
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      
      if (containerWidth <= 0 || containerHeight <= 0) {
        this.logger.warn(`Overview 容器尺寸无效: ${containerWidth}x${containerHeight}，延迟重试`);
        // 延迟重试
        setTimeout(() => this.initializeOverview(container), 100);
        return;
      }
      
      try {
        const $ = go.GraphObject.make;
        const overviewBackground = this.getOverviewBackgroundColor();
        container.style.backgroundColor = overviewBackground;
        
        // 检测是否为移动端
        const isMobile = containerWidth < 768 || 'ontouchstart' in window;
        
        // 记录设备 pixelRatio 用于调试（但不用于 Overview 配置）
        const _devicePixelRatio = window.devicePixelRatio || 1;
        
        // 确保容器有明确的尺寸设置
        container.style.width = `${containerWidth}px`;
        container.style.height = `${containerHeight}px`;
        container.style.position = 'relative';
        container.style.overflow = 'hidden';
        
        // 🔧 修复"小地图模糊"问题
        // 之前为了解决"节点被困在小地图四分之一"问题而禁用了 computePixelRatio
        // 现在重新启用并确保与主图一致，以支持高 DPI 屏幕
        this.overview = $(go.Overview, container, {
          contentAlignment: go.Spot.Center,
          "animationManager.isEnabled": false,
          "computePixelRatio": () => window.devicePixelRatio || 1,
          "initialViewportSpot": go.Spot.Center,
          "initialScale": 0.15
        });
        
        // 委托给 FlowTemplateService 设置 Overview 模板
        this.templateService.setupOverviewNodeTemplate(this.overview);
        this.templateService.setupOverviewLinkTemplate(this.overview);
        
        this.overview.observed = this.diagram;
        
        // 设置视口框样式（传递移动端标识）
        this.templateService.setupOverviewBoxStyle(this.overview, isMobile);
        
        this.overview.scale = 0.15;
        this.lastOverviewScale = 0.15;

        this.attachOverviewPointerListeners(container);
        
        this.setupOverviewAutoScale();
        
        // 顾问建议：为 Overview 容器添加 ResizeObserver
        // 确保窗口 resize 时小地图同步更新，避免视口框错位
        if (this.overviewResizeObserver) {
          this.overviewResizeObserver.disconnect();
        }
        this.overviewResizeObserver = new ResizeObserver(() => {
          // 使用 requestAnimationFrame 防止过于频繁的更新
          window.requestAnimationFrame(() => {
            if (this.isDestroyed || !this.overview) return;
            this.refreshOverview();
          });
        });
        this.overviewResizeObserver.observe(container);
        
        // 强制刷新一次，确保正确渲染
        if (this.diagram) {
          this.diagram.requestUpdate();
        }
        if (this.overview) {
          this.overview.requestUpdate();
        }
        
        const nodeCount = this.diagram.nodes.count;
        const linkCount = this.diagram.links.count;
        this.logger.info(`Overview 初始化成功 - 尺寸: ${containerWidth}x${containerHeight}, 节点数: ${nodeCount}, 连接数: ${linkCount}`);
      } catch (error) {
        this.logger.error('Overview 初始化失败:', error);
      }
    });
  }
  
  private getOverviewBackgroundColor(): string {
    // 深色模式下使用较浅的背景色（与画布背景相反），浅色模式下使用深色背景
    // 这样小地图中的节点才能清晰可见
    const isDark = this.themeService.isDark();
    if (isDark) {
      // 深色模式：使用深色但比画布稍亮的颜色
      return '#1f1f1f';
    } else {
      // 浅色模式：使用深色背景
      const styles = this.configService.currentStyles();
      return this.readCssColorVar('--theme-text-dark') ?? styles.text.titleColor ?? '#292524';
    }
  }
  
  /**
   * 应用画布背景色（根据当前主题）
   */
  private applyCanvasBackground(): void {
    if (!this.diagram || !this.diagram.div) return;
    
    const theme = this.themeService.theme() as FlowTheme;
    const isDark = this.themeService.isDark();
    const flowStyles = getFlowStyles(theme, isDark ? 'dark' : 'light');
    this.diagram.div.style.backgroundColor = flowStyles.canvas.background;
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

    // 缩放范围：1e-4 ~ 0.5
    // 关键修复：降低下限到 1e-4，允许无限拖远时能继续缩小
    // 这解决了"视口框消失"和"回拉时不渐变"的问题
    const clampScale = (scale: number): number => {
      return Math.max(1e-4, Math.min(0.5, scale));
    };
    
    // 线性插值函数 - 用于 scale 平滑过渡
    // 关键修复：解决"视口框从边缘拉到中央时不会逐渐变大"的问题
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    
    // 非对称插值因子：缩小快(0.45)、放大慢(0.18)
    // 这解决了"红框因插值太慢而先跑出画面"的问题
    const SCALE_LERP_FACTOR_SHRINK = 0.45;
    const SCALE_LERP_FACTOR_GROW = 0.18;
    
    // 智能插值：根据缩放方向选择因子，差距过大时直接追
    const smartLerp = (current: number, target: number): number => {
      // 差距超过 2 倍时直接追，避免拖拽太快时跟不上
      if (current / target > 2 || target / current > 2) {
        return target;
      }
      // 非对称插值：缩小快、放大慢
      const t = target < current ? SCALE_LERP_FACTOR_SHRINK : SCALE_LERP_FACTOR_GROW;
      return lerp(current, target, t);
    };
    
    let baseScale = calculateBaseScale();
    let lastNodeDataCount = ((this.diagram.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
    this.lastOverviewScale = clampScale(baseScale);
    this.overview.scale = this.lastOverviewScale;
    
    const nodeBounds = getNodesBounds();
    this.overview.centerRect(nodeBounds);
    
    /**
     * 动态扩展边界 - 无限画布核心
     * 
     * 关键改进（解决拖拽卡死问题）：
     * 1. 移除硬墙 clamp：允许 viewportBounds 继续远离内容边界
     * 2. 动态 maxOverflow：根据超出距离动态扩展，实现"无限画布"效果
     * 3. 分离逻辑/显示位置：逻辑位置不 clamp，scaleRatio 会随边界扩展而变小
     */
    const calculateExtendedBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
      // 动态 maxOverflow：不再硬编码 1200，允许无限扩展
      // 这是实现"视口窗渐缩"的关键：视口越远，extendedBounds 越大，scaleRatio 越小
      const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
      const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
      const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
      const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

      // 不再限制 overflow，允许无限扩展
      const extended = new go.Rect(
        baseBounds.x - overflowLeft,
        baseBounds.y - overflowTop,
        baseBounds.width + overflowLeft + overflowRight,
        baseBounds.height + overflowTop + overflowBottom
      );

      // 确保边界至少能容纳视口（含动态缓冲）
      // 顾问批准：Math.max(400, containerWidth * 0.3) 混合策略
      // 确保 buffer 基于可见视口而非滚动画布尺寸
      const containerW = this.overviewContainer?.clientWidth ?? 200;
      const containerH = this.overviewContainer?.clientHeight ?? 150;
      const dynamicBufferW = Math.max(400, containerW * 0.3);
      const dynamicBufferH = Math.max(400, containerH * 0.3);
      
      const minWidth = viewportBounds.width + dynamicBufferW;
      if (extended.width < minWidth) {
        const pad = (minWidth - extended.width) / 2;
        extended.x -= pad;
        extended.width = minWidth;
      }
      const minHeight = viewportBounds.height + dynamicBufferH;
      if (extended.height < minHeight) {
        const pad = (minHeight - extended.height) / 2;
        extended.y -= pad;
        extended.height = minHeight;
      }

      // 关键：不再 clamp viewportBounds，直接合并
      // 这让视口可以"走出"当前边界，触发 scaleRatio 变小
      return extended.unionRect(viewportBounds);
    };

    let pendingUpdateSource: 'viewport' | 'document' = 'viewport';

    // ========== 视口移动时的 Overview 绑定刷新（关键修复） ==========
    // 现象：主视口平移时，小地图节点不连续移动，1-2s 后才跳变。
    // 根因：我们之前只在 source==='document' 时调用 updateAllTargetBindings，
    // 若 Overview 节点位置/可见性等绑定依赖于 viewport/fixedBounds/scale 的变化，
    // 仅 requestUpdate 可能无法驱动绑定即时刷新。
    // 策略：
    // - 文档变化：立即 updateAllTargetBindings（保持原行为）
    // - 视口变化：自适应节流刷新（节点少 -> 每帧；节点多 -> 约 20fps）
    let viewportBindingsPending = false;
    let viewportBindingsTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleViewportBindingsUpdate = () => {
      if (!this.overview || !this.diagram) return;
      if (viewportBindingsPending) return;

      const nodeCount = this.diagram.nodes.count;
      const preferRaf = nodeCount <= 300; // 节点少：每帧更新更平滑；节点多：避免 O(n) 每帧

      viewportBindingsPending = true;

      const run = () => {
        viewportBindingsPending = false;
        if (!this.overview || !this.diagram || this.isDestroyed) return;
        this.overview.updateAllTargetBindings();
        this.overview.requestUpdate();
      };

      if (preferRaf) {
        requestAnimationFrame(run);
      } else {
        if (viewportBindingsTimer) clearTimeout(viewportBindingsTimer);
        viewportBindingsTimer = setTimeout(run, 50);
      }
    };

    /**
     * 执行视口更新 - 添加性能监控
     * 
     * 当耗时超过 16ms（掉帧）时上报 Sentry，便于后续性能调优
     */
    const runViewportUpdate = (source: 'viewport' | 'document') => {
      if (!this.overview || !this.diagram) return;

      // 性能监控：记录开始时间
      const perfStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

      this.overviewDebugUpdateCalls++;

      const logOverview = (reason: string, details?: Record<string, unknown>) => {
        // 默认关闭：避免日志本身造成卡顿。需要时可在控制台执行：window.__NF_OVERVIEW_DEBUG = true
        const debugEnabled = !!(globalThis as unknown as { __NF_OVERVIEW_DEBUG?: boolean })?.__NF_OVERVIEW_DEBUG;
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

        // 关键修复：不要在交互期间“硬跳过” viewport 更新。
        // 否则会出现：拖拽/平移时小地图内容不动，结束后才突然跳到新位置。
        // 这里继续执行自动缩放/边界更新，并将绑定刷新交给节流逻辑控制频率。

        const fakeViewportBounds = this.overviewBoxViewportBounds;
        const usingFakeViewportBounds = !!(this.isOverviewBoxDragging && fakeViewportBounds && fakeViewportBounds.isReal());
        const viewportBounds: go.Rect = usingFakeViewportBounds
          ? fakeViewportBounds
          : this.diagram.viewportBounds;
        if (!viewportBounds.isReal()) {
          logOverview('skip:viewport-not-real');
          return;
        }
      
        const nodeBounds = getNodesBounds();
        // totalBounds = union(documentBounds, viewportBounds)
        const docBounds = this.diagram.documentBounds;
        let totalBounds: go.Rect;
        if (!docBounds.isReal() || (docBounds.width === 0 && docBounds.height === 0)) {
          totalBounds = viewportBounds.copy();
        } else {
          const minX = Math.min(docBounds.x, viewportBounds.x);
          const minY = Math.min(docBounds.y, viewportBounds.y);
          const maxX = Math.max(docBounds.x + docBounds.width, viewportBounds.x + viewportBounds.width);
          const maxY = Math.max(docBounds.y + docBounds.height, viewportBounds.y + viewportBounds.height);
          totalBounds = new go.Rect(minX, minY, maxX - minX, maxY - minY);
        }
      
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
            // worldBounds：小地图的"世界边界"
            // 关键修复：永远使用 union(nodeBounds, viewportBounds) 做世界边界
            // 这是连续函数，避免 isViewportOutside 二分判断导致的边界跳变
            // 视口离内容越远 → worldBounds 越大 → scale 越小（连续变化）
            const worldBounds = calculateExtendedBounds(nodeBounds.copy().unionRect(viewportBounds), viewportBounds);

            // 取整避免浮点抖动导致 boundsKey 高频变化（尤其在边界拖拽/缩放时）
            const q = (v: number) => Math.round(v);
            const boundsKey = `${q(viewportBounds.x)}|${q(viewportBounds.y)}|${q(viewportBounds.width)}|${q(viewportBounds.height)}`;
            
            // 关键修复：设置 fixedBounds 确保视口框永远在小地图视野内
            // 这解决了"视口框消失/拖出边界"的问题
            this.overview.fixedBounds = worldBounds;
            
            if (boundsKey !== this.overviewBoundsCache) {
              this.overviewBoundsCache = boundsKey;

              logOverview('apply:bounds', {
                usingFakeViewportBounds,
                viewport: {
                  x: q(viewportBounds.x),
                  y: q(viewportBounds.y),
                  w: q(viewportBounds.width),
                  h: q(viewportBounds.height)
                },
                nodeBounds: {
                  x: q(nodeBounds.x),
                  y: q(nodeBounds.y),
                  w: q(nodeBounds.width),
                  h: q(nodeBounds.height)
                }
              });
            }

            const currentScale = this.overview.scale;
            const viewportBoxWidth = viewportBounds.width * currentScale;
            const viewportBoxHeight = viewportBounds.height * currentScale;
          
            // 动态边距：Math.max(20, containerWidth * 0.1)
            // 确保小容器也有最小边距，大容器有更多呼吸空间
            const boxPadding = Math.max(20, Math.min(containerWidth, containerHeight) * 0.1);
            const needsShrinkForBox = 
              viewportBoxWidth > containerWidth - boxPadding ||
              viewportBoxHeight > containerHeight - boxPadding;
          
            if (isViewportOutside || needsShrinkForBox) {
              // 当视口超出边界时，根据 totalBounds （包含节点+视口）计算缩放
              const padding = 0.15;
              const scaleX = (containerWidth * (1 - padding * 2)) / totalBounds.width;
              const scaleY = (containerHeight * (1 - padding * 2)) / totalBounds.height;
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
            
              if (Math.abs(targetScale - this.overview.scale) > 0.002) {
                // 关键修复：使用 smartLerp 非对称插值（缩小快、放大慢）
                const smoothedScale = smartLerp(this.overview.scale, targetScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;

                logOverview('apply:scale', {
                  usingFakeViewportBounds,
                  targetScale: Number(targetScale.toFixed(4)),
                  smoothedScale: Number(smoothedScale.toFixed(4)),
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
            
              // 关键修复：使用 smartLerp 非对称插值
              // 解决视口框从边缘拉到中央时不会逐渐变大的问题
              if (Math.abs(finalScale - currentScale) > 0.002) {
                const smoothedScale = smartLerp(currentScale, finalScale);
                this.overview.scale = clampScale(smoothedScale);
                this.lastOverviewScale = this.overview.scale;

                logOverview('apply:scale', {
                  usingFakeViewportBounds,
                  targetScale: Number(finalScale.toFixed(4)),
                  smoothedScale: Number(smoothedScale.toFixed(4)),
                  mode: 'back-to-base'
                });
              }
            }

            // ✅ 关键补齐：白框拖拽期间，让小地图视图跟随主视口
            // 现象：白框在动，但缩略节点“等 1–2s 才跳”
            // 解释：我们之前主要在改 fixedBounds/scale，但没有持续驱动 Overview 的视图平移，
            // 导致节点的屏幕位置不连续变化。
            // 策略：拖拽白框时，让 viewportBounds 的中心保持在小地图容器中心——
            // 这样白框相对稳定，而节点会连续滑动（符合你描述的“节点应跟随视口窗移动”的预期）。
            if (usingFakeViewportBounds) {
              // 使用 GoJS 原生 API 居中显示当前 viewport rect。
              // 比手动算 position 更稳定：会自动处理 fixedBounds/视口夹取/内部工具状态。
              this.overview.centerRect(viewportBounds);
            }
          }
        }
        
        // 关键优化：分离"视口更新"和"节点绑定更新"
        // 视口变化时只需要 requestUpdate()，不需要每帧 O(n) 的 updateAllTargetBindings
        // updateAllTargetBindings 只在以下情况调用：
        // 1. 内容变化（DocumentBoundsChanged）
        // 2. 拖拽结束（pointerup）
        // 这大幅降低了 CPU 消耗，解决了拖拽卡顿问题
        if (this.overview) {
          if (source === 'document') {
            // 内容变化：立即刷新绑定（原逻辑）
            this.overview.updateAllTargetBindings();
            this.overview.requestUpdate();
          } else {
            // 视口变化：requestUpdate + 节流绑定刷新（修复节点“跃迁”）
            this.overview.requestUpdate();
            scheduleViewportBindingsUpdate();
          }
        }
      } finally {
        this.isApplyingOverviewViewportUpdate = false;
        
        // 性能监控：检查耗时并上报 Sentry
        const perfEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const duration = perfEnd - perfStart;
        
        // 如果耗时超过 16ms（掉帧），上报 Sentry
        if (duration > 16) {
          const nodeCount = this.diagram?.nodes?.count ?? 0;
          Sentry.captureMessage('Overview Lag Detected', {
            level: 'warning',
            extra: {
              duration: Math.round(duration),
              nodeCount,
              source,
              isMobile: this.uiState.isMobile()
            }
          });
          
          // 同时在控制台输出警告
          this.logger.warn('[OverviewPerf] 性能警告', {
            duration: `${Math.round(duration)}ms`,
            nodeCount,
            source
          });
        }
        
        if (this.overviewUpdateQueuedWhileApplying) {
          this.overviewUpdateQueuedWhileApplying = false;
          // 重入期间可能丢掉最后一次状态，这里补一帧
          // 同时记录一次：出现过重入排队
          const debugEnabled = !!(globalThis as unknown as { __NF_OVERVIEW_DEBUG?: boolean })?.__NF_OVERVIEW_DEBUG;
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
        const debugEnabled = !!(globalThis as unknown as { __NF_OVERVIEW_DEBUG?: boolean })?.__NF_OVERVIEW_DEBUG;
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

    // ===== rAF 轮询兜底：确保 box 拖拽时实时同步 =====
    // 注意：这里不直接调用 runViewportUpdate，而是复用 scheduleViewportUpdate 的合帧逻辑。
    const startViewportPoll = () => {
      if (this.overviewViewportPollRafId !== null) return;

      const tick = () => {
        this.overviewViewportPollRafId = null;
        if (this.isDestroyed || !this.diagram || !this.overview) return;

        const vb = this.diagram.viewportBounds;
        if (vb.isReal()) {
          const q = (v: number) => Math.round(v);
          const key = `${q(vb.x)}|${q(vb.y)}|${q(vb.width)}|${q(vb.height)}`;
          if (key !== this.overviewViewportPollLastKey) {
            this.overviewViewportPollLastKey = key;
            this.overviewScheduleUpdate?.('viewport');
          }
        }

        // Overview 存在时持续轮询；scheduleViewportUpdate 内部会合并到每帧一次
        this.overviewViewportPollRafId = requestAnimationFrame(tick);
      };

      this.overviewViewportPollRafId = requestAnimationFrame(tick);
    };

    startViewportPoll();
    
    // 监听文档变化 - 保存 handler 引用用于清理
    this.overviewDocumentBoundsChangedHandler = () => {
      if (!this.overview || !this.diagram) return;

      const currentNodeDataCount = ((this.diagram.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
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
    };
    this.diagram.addDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
    
    // 关键修复：合并两个 ViewportBoundsChanged 监听器为一个
    // 解决同一事件触发两次 scheduleViewportUpdate 的问题
    this.overviewViewportBoundsChangedHandler = (_e: go.DiagramEvent) => {
      if (!this.overview || !this.diagram || this.isNodeDragging) {
        return;
      }
      scheduleViewportUpdate('viewport');
      // 滚动停止后的额外处理已合并到这里
      // 之前的双重监听器会导致性能问题
    };
    this.diagram.addDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
    
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
    // 关键修复：先移除 DiagramListener，防止监听器累积导致性能问题
    if (this.diagram) {
      if (this.overviewDocumentBoundsChangedHandler) {
        this.diagram.removeDiagramListener('DocumentBoundsChanged', this.overviewDocumentBoundsChangedHandler);
        this.overviewDocumentBoundsChangedHandler = null;
      }
      if (this.overviewViewportBoundsChangedHandler) {
        this.diagram.removeDiagramListener('ViewportBoundsChanged', this.overviewViewportBoundsChangedHandler);
        this.overviewViewportBoundsChangedHandler = null;
      }
    }
    
    // 清理 Overview ResizeObserver
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

    // 清理 box 拖拽状态
    this.isOverviewBoxDragging = false;
    this.overviewBoxViewportBounds = null;
    
    // 清理节流定时器
    if (this.throttledUpdateBindingsTimer) {
      clearTimeout(this.throttledUpdateBindingsTimer);
      this.throttledUpdateBindingsTimer = null;
    }
    this.throttledUpdateBindingsPending = false;
    
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
  
  /**
   * 刷新 Overview 渲染
   * 用于处理容器尺寸变化（如屏幕旋转、窗口缩放）
   */
  refreshOverview(): void {
    if (!this.overview || !this.overviewContainer || this.isDestroyed) return;
    
    try {
      // 强制刷新 Overview 的渲染
      this.overview.requestUpdate();
      
      // 重新计算和设置缩放
      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;
      
      if (containerWidth > 0 && containerHeight > 0 && this.diagram) {
        const docBounds = this.diagram.documentBounds;
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
   * 绑定 Overview 的 Pointer 事件监听
   * 
   * 关键改进（解决拖拽卡死问题）：
   * 1. 使用 setPointerCapture：确保拖拽出界后仍能收到事件
   * 2. 移除 500ms 超时保护：该机制在快速拖拽时不可靠
   * 3. 完全跳过交互期间的 viewport 更新：避免事件风暴
   * 4. 区分视口框拖拽和小地图点击：只在点击小地图（非视口框）时触发交互状态
   * 5. 顾问建议：将 pointer 事件放入 zone.runOutsideAngular，避免触发 Angular 变更检测
   * 6. 顾问建议：将 updateAllTargetBindings 改为 100ms 节流
   */
  private attachOverviewPointerListeners(container: HTMLDivElement): void {
    if (this.overviewPointerCleanup) {
      this.overviewPointerCleanup();
      this.overviewPointerCleanup = null;
    }

    // 关键：触摸设备上如果没有 touch-action:none，浏览器会把拖拽当作滚动/手势处理，
    // 从而导致只触发 pointerdown/pointerup，而几乎不触发 pointermove（表现为“拖动中冻结，松手后突变”）。
    const prevTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';

    // 关键修复：统一 capture 参数，确保 removeEventListener 能正确移除监听器
    // addEventListener({ capture: true }) 必须用 removeEventListener(..., true) 才能移除
    // 之前没带 CAPTURE 导致监听器无法移除，每次重新初始化都会叠加新的监听器
    const _CAPTURE = true;

    // 存储当前捕获的 pointerId，用于 releasePointerCapture
    let capturedPointerId: number | null = null;
    // 标记是否真正调用了 setPointerCapture（box 拖拽时不调用）
    let hasPointerCapture = false;
    // 标记是否正在拖拽视口框
    let isDraggingBox = false;
    // 是否由我们接管白框拖拽（绕过 GoJS 内置 box drag，解决“白框动但缩略节点不动/突变”）
    let isManualBoxDrag = false;
    // 指针相对白框中心的偏移（保持抓取点不跳）
    let manualBoxDragOffset: { dx: number; dy: number } | null = null;
    // 记录拖拽开始时的视口尺寸（避免拖拽中 scale/fixedBounds 调整导致宽高漂移）
    let manualDragViewportSize: { w: number; h: number } | null = null;

    // 关键：不要用 offsetX/offsetY（事件冒泡到 container 时可能是相对 canvas 的坐标，导致命中测试错误）
    // 统一用 clientX/clientY + container 的 DOMRect 计算 Overview 视图坐标
    const getOverviewDocPointFromClient = (clientX: number, clientY: number): go.Point | null => {
      if (!this.overview) return null;
      const rect = container.getBoundingClientRect();
      const viewX = clientX - rect.left;
      const viewY = clientY - rect.top;
      return this.overview.transformViewToDoc(new go.Point(viewX, viewY));
    };

    // 仅在 window.__NF_OVERVIEW_DEBUG = true 时输出调试日志（默认关闭）。
    // 目标：确认拖拽白框时 box/假 viewportBounds/fixedBounds/scale 是否持续变化。
    const isOverviewDebugEnabled = () => !!(globalThis as unknown as { __NF_OVERVIEW_DEBUG?: boolean })?.__NF_OVERVIEW_DEBUG;
    const debugDrag = (reason: string, details?: Record<string, unknown>) => {
      if (!isOverviewDebugEnabled()) return;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      // move 日志更高频一些，方便确认拖拽期间事件是否持续触发
      const minIntervalMs = reason.includes(':move') ? 80 : 200;
      if (now - this.overviewDragDebugLastLogAt < minIntervalMs) return;
      this.overviewDragDebugLastLogAt = now;

      const box = this.overview?.box?.actualBounds;
      const fixed = this.overview?.fixedBounds;
      const fake = this.overviewBoxViewportBounds;
      const realVb = this.diagram?.viewportBounds;

      this.logger.warn('[OverviewDragDebug]', {
        reason,
        isDraggingBox,
        isManualBoxDrag,
        isOverviewBoxDragging: this.isOverviewBoxDragging,
        overviewPosition: this.overview ? { x: Math.round(this.overview.position.x), y: Math.round(this.overview.position.y) } : null,
        box: box?.isReal() ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height)
        } : null,
        boxCenter: box?.isReal() ? { x: Math.round(box.center.x), y: Math.round(box.center.y) } : null,
        fakeViewportBounds: fake?.isReal() ? {
          x: Math.round(fake.x),
          y: Math.round(fake.y),
          w: Math.round(fake.width),
          h: Math.round(fake.height)
        } : null,
        realViewportBounds: realVb?.isReal() ? {
          x: Math.round(realVb.x),
          y: Math.round(realVb.y),
          w: Math.round(realVb.width),
          h: Math.round(realVb.height)
        } : null,
        overviewScale: this.overview?.scale,
        overviewFixedBounds: fixed?.isReal() ? {
          x: Math.round(fixed.x),
          y: Math.round(fixed.y),
          w: Math.round(fixed.width),
          h: Math.round(fixed.height)
        } : null,
        ...(details ?? {})
      });
    };

    const stopEventForManualDrag = (ev: Event) => {
      // capture 阶段拦截，尽量阻止 GoJS 内部工具接管拖拽
      try {
        (ev as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
      } catch {
        // ignore
      }
      try {
        ev.stopPropagation();
      } catch {
        // ignore
      }
      try {
        (ev as Event & { preventDefault?: () => void }).preventDefault?.();
      } catch {
        // ignore
      }
    };

    const beginManualBoxDrag = (pt: go.Point) => {
      if (!this.diagram || !this.overview) return;
      const vb = this.diagram.viewportBounds;
      if (!vb.isReal()) return;

      const boxBounds = this.overview.box?.actualBounds;
      const boxCenter = boxBounds?.isReal() ? boxBounds.center : pt;
      manualBoxDragOffset = { dx: pt.x - boxCenter.x, dy: pt.y - boxCenter.y };
      manualDragViewportSize = { w: vb.width, h: vb.height };

      // 关键：不要在拖拽期间开启一个长事务。
      // GoJS 可能会把某些观察/重绘延迟到事务提交，从而出现“拖动中冻结，松手后跳”的现象。
      // 这里只需要跳过 Undo，直接更新 diagram.position 即可。
      try {
        this.diagram.skipsUndoManager = true;
      } catch {
        // ignore
      }

      isManualBoxDrag = true;
      debugDrag('manualDrag:begin', {
        boxCenter: { x: Math.round(boxCenter.x), y: Math.round(boxCenter.y) },
        offset: { dx: Math.round(manualBoxDragOffset.dx), dy: Math.round(manualBoxDragOffset.dy) },
        viewportSize: { w: Math.round(vb.width), h: Math.round(vb.height) }
      });
    };

    const applyManualBoxDrag = (pt: go.Point) => {
      if (!this.diagram || !isManualBoxDrag || !manualBoxDragOffset || !manualDragViewportSize) return;

      const centerX = pt.x - manualBoxDragOffset.dx;
      const centerY = pt.y - manualBoxDragOffset.dy;
      const desiredPos = new go.Point(
        centerX - manualDragViewportSize.w / 2,
        centerY - manualDragViewportSize.h / 2
      );

      // 直接更新主图视口。Overview.box 会随 observed diagram 自动移动。
      if (!this.diagram.position.equals(desiredPos)) {
        this.diagram.position = desiredPos;
        this.diagram.requestUpdate();
      }

      // ✅ 强制立即刷新 Overview：避免出现“日志在变，但画面要等 1–2s 才跳”的现象
      // 只在接管拖拽期间启用（节点数不大时成本可接受）。
      if (this.overview) {
        this.overview.updateAllTargetBindings();
        this.overview.requestUpdate();
      }

      debugDrag('manualDrag:move', {
        desiredPos: { x: Math.round(desiredPos.x), y: Math.round(desiredPos.y) },
        center: { x: Math.round(centerX), y: Math.round(centerY) }
      });
    };

    const endManualBoxDrag = () => {
      if (!this.diagram) return;
      if (!isManualBoxDrag) return;
      isManualBoxDrag = false;
      manualBoxDragOffset = null;
      manualDragViewportSize = null;
      try {
        this.diagram.skipsUndoManager = false;
      } catch {
        // ignore
      }
      debugDrag('manualDrag:end');
    };

    // 根据白色视口框（Overview.box）的中心点，推导一个“假 viewportBounds”，用于拖拽期间实时驱动小地图映射。
    // 重要：不要在这里直接修改主图 position（会与 GoJS Overview 内部拖拽互相打架，反而导致延迟/突变）。
    // 说明：使用 box.center 能严格跟随白框实际位置（用户抓角/抓边时也不会产生偏移）。
    const _updateOverviewBoxViewportBounds = (fallbackDocPt?: go.Point) => {
      if (!this.diagram) return;
      const vb = this.diagram.viewportBounds;
      if (!vb.isReal()) return;

      const boxBounds = this.overview?.box?.actualBounds;
      const center = boxBounds?.isReal() ? boxBounds.center : fallbackDocPt;
      if (!center) return;

      this.overviewBoxViewportBounds = new go.Rect(
        center.x - vb.width / 2,
        center.y - vb.height / 2,
        vb.width,
        vb.height
      );

      debugDrag('updateFakeViewportBounds', {
        center: { x: Math.round(center.x), y: Math.round(center.y) },
        usingBoxCenter: !!(boxBounds?.isReal())
      });
    };

    // 修复节点同步延迟：使用 16ms 节流（约 60fps）实现实时更新
    // 之前 100ms 太慢，用户能感知到明显延迟
    const _throttledUpdateBindings = () => {
      if (this.throttledUpdateBindingsPending || !this.overview) return;
      this.throttledUpdateBindingsPending = true;
      
      // 立即执行一次 updateAllTargetBindings 确保节点位置同步
      this.overview.updateAllTargetBindings();
      this.overview.requestUpdate();
      
      // 16ms 后重置标志，允许下一次更新（约 60fps）
      this.throttledUpdateBindingsTimer = setTimeout(() => {
        this.throttledUpdateBindingsPending = false;
      }, 16);
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (!this.overview) return;
      
      // 检查点击位置是否在视口框上
      // 关键修复：不要依赖 findObjectAt（在 Overview/Canvas 的坐标体系下容易误判），
      // 改为用 box.actualBounds 做命中测试。
      const diagram = this.overview;
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (!pt) return;
      const boxBounds = diagram.box?.actualBounds;

      // 如果点击的是 box（视口框），让 GoJS 内部工具处理拖拽。
      // 但我们需要在拖拽过程中主动驱动一次 overviewScheduleUpdate，
      // 因为主图的 ViewportBoundsChanged 在某些设备/场景下可能不会高频触发，
      // 从而导致“白框动、内容不动，结束后才突变”。
      if (boxBounds?.isReal() && boxBounds.containsPoint(pt)) {
        isDraggingBox = true;
        this.isOverviewBoxDragging = true;
        // ✅ 接管白框拖拽：阻止 GoJS 内部 box drag 工具，改由我们推动主图视口
        stopEventForManualDrag(ev);

        // 使用 PointerCapture 确保拖拽出界后仍能收到事件
        try {
          container.setPointerCapture(ev.pointerId);
          capturedPointerId = ev.pointerId;
          hasPointerCapture = true;
        } catch (e) {
          // ignore
          capturedPointerId = ev.pointerId;
        }

        beginManualBoxDrag(pt);

        // 立即补一次：让拖拽开始时就同步
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');

        debugDrag('pointerDown:hitBox', {
          pointerId: ev.pointerId,
          pt: { x: Math.round(pt.x), y: Math.round(pt.y) }
        });
        return;
      }
      
      // 点击的是小地图的其他区域（节点、空白等），设置交互状态
      isDraggingBox = false;
      this.isOverviewInteracting = true;
      
      // 使用 PointerCapture 确保拖拽出界后仍能收到事件
      // 这是实现"无限拖拽"的关键，解决了鼠标离开小地图后事件丢失的问题
      try {
        container.setPointerCapture(ev.pointerId);
        capturedPointerId = ev.pointerId;
        hasPointerCapture = true;
      } catch (e) {
        // 某些触摸设备可能不支持，忽略错误
        this.logger.debug('setPointerCapture 不可用:', e);
      }
    };
    
    const onPointerMove = (ev: PointerEvent) => {
      // 只在拖拽视口框时处理
      if (!isDraggingBox || !this.overview) return;

      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
      }

      // 关键修复：拖拽视口框期间，主动驱动一次 viewport 同步。
      // 这样即使主图的 ViewportBoundsChanged 事件被 GoJS 合并/延迟，
      // 小地图也能持续更新（scale/fixedBounds/内容缩放位置），避免“突变”。
      if (capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (pt) {
        if (isManualBoxDrag) {
          applyManualBoxDrag(pt);
        }
      }
      // 仍然触发一次 overview 更新（合帧），避免固定边界/缩放落后
      this.overviewScheduleUpdate?.('viewport');

      debugDrag('pointerMove:dragBox', {
        pointerId: ev.pointerId,
        client: { x: Math.round(ev.clientX), y: Math.round(ev.clientY) },
        pt: pt ? { x: Math.round(pt.x), y: Math.round(pt.y) } : null
      });
    };
    
    const onPointerUpLike = () => {
      // 只有在实际调用了 setPointerCapture 时才释放
      if (hasPointerCapture && capturedPointerId !== null) {
        try {
          container.releasePointerCapture(capturedPointerId);
        } catch (e) {
          // 忽略释放错误
        }
      }
      capturedPointerId = null;
      hasPointerCapture = false;
      
      // 如果是拖拽视口框，重置标记并返回
      if (isDraggingBox) {
        isDraggingBox = false;

        // 先更新标记，再输出 manualDrag:end（避免日志里出现 isOverviewBoxDragging 仍为 true 的误导情况）
        this.isOverviewBoxDragging = false;
        endManualBoxDrag();
        this.overviewBoxViewportBounds = null;
        
        // 清理节流定时器
        if (this.throttledUpdateBindingsTimer) {
          clearTimeout(this.throttledUpdateBindingsTimer);
          this.throttledUpdateBindingsTimer = null;
        }
        this.throttledUpdateBindingsPending = false;
        
        // 视口框拖拽结束后，补一次完整同步
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');

        debugDrag('pointerUp:dragBoxEnd');
        
        // 拖拽结束时执行一次完整的绑定更新（顾问建议）
        requestAnimationFrame(() => {
          if (this.isDestroyed || !this.overview) return;
          this.overview.updateAllTargetBindings();
          this.overview.requestUpdate();
        });
        return;
      }
      
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

    // 关键修复：在 window 上兜底 pointermove/pointerup，防止拖出容器后丢失事件
    const onWindowPointerMove = (ev: PointerEvent) => {
      if (!isDraggingBox) return;
      if (capturedPointerId !== null && ev.pointerId !== capturedPointerId) return;
      if (isManualBoxDrag) {
        stopEventForManualDrag(ev);
      }
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (pt && isManualBoxDrag) {
        applyManualBoxDrag(pt);
      }
      this.overviewScheduleUpdate?.('viewport');

      debugDrag('windowPointerMove:dragBox', {
        pointerId: ev.pointerId,
        client: { x: Math.round(ev.clientX), y: Math.round(ev.clientY) },
        pt: pt ? { x: Math.round(pt.x), y: Math.round(pt.y) } : null
      });
    };

    // ========== Mouse 事件兜底（某些环境 pointer 事件不稳定） ==========
    let isMouseDraggingBox = false;
    const onMouseDown = (ev: MouseEvent) => {
      if (!this.overview) return;
      const pt = getOverviewDocPointFromClient(ev.clientX, ev.clientY);
      if (!pt) return;
      const boxBounds = this.overview.box?.actualBounds;
      if (boxBounds?.isReal() && boxBounds.containsPoint(pt)) {
        isMouseDraggingBox = true;
        this.isOverviewBoxDragging = true;
        // mouse 也走“接管拖拽”逻辑
        stopEventForManualDrag(ev);
        beginManualBoxDrag(pt);
        this.overviewBoundsCache = '';
        this.overviewScheduleUpdate?.('viewport');

        debugDrag('mouseDown:hitBox', {
          pt: { x: Math.round(pt.x), y: Math.round(pt.y) }
        });
      }
    };
    const onMouseMove = (_ev: MouseEvent) => {
      if (!isMouseDraggingBox) return;
      const pt = getOverviewDocPointFromClient(_ev.clientX, _ev.clientY);
      if (pt) {
        applyManualBoxDrag(pt);
      }
      this.overviewScheduleUpdate?.('viewport');

      debugDrag('mouseMove:dragBox', {
        client: { x: Math.round(_ev.clientX), y: Math.round(_ev.clientY) },
        pt: pt ? { x: Math.round(pt.x), y: Math.round(pt.y) } : null
      });
    };
    const onMouseUp = () => {
      if (!isMouseDraggingBox) return;
      isMouseDraggingBox = false;
      this.isOverviewBoxDragging = false;
      this.overviewBoxViewportBounds = null;
      endManualBoxDrag();
      // 鼠标拖拽结束也补一次最终同步
      this.overviewBoundsCache = '';
      this.overviewScheduleUpdate?.('viewport');

      debugDrag('mouseUp:dragBoxEnd');
    };

    const onWindowPointerUp = (ev: PointerEvent) => {
      // 只处理我们捕获的 pointerId
      if (capturedPointerId !== null && ev.pointerId === capturedPointerId) {
        onPointerUpLike();
      }
    };

    // 关键修复：将所有 pointer 事件放入 zone.runOutsideAngular
    // 避免每次 pointermove 触发 Angular 变更检测，解决卡顿问题
    this.zone.runOutsideAngular(() => {
      // 注意：pointerdown 不能是 passive，因为可能需要 setPointerCapture
      // 关键：使用 capture 阶段，确保能在 GoJS canvas 之前拦截事件
      container.addEventListener('pointerdown', onPointerDown, { passive: false, capture: true });
      container.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
      container.addEventListener('pointerup', onPointerUpLike, { passive: true, capture: true });
      container.addEventListener('pointercancel', onPointerUpLike, { passive: true, capture: true });
      // 使用 lostpointercapture 替代 pointerleave，更可靠地检测拖拽结束
      container.addEventListener('lostpointercapture', onPointerUpLike, { passive: true, capture: true });
      // 关键修复：window 级别兜底，确保即使 pointer capture 失效也能收到 pointerup
      window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', onWindowPointerUp, { passive: true });
      window.addEventListener('pointercancel', onWindowPointerUp, { passive: true });

      // mouse 兜底
      container.addEventListener('mousedown', onMouseDown, { passive: false, capture: true });
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      window.addEventListener('mouseup', onMouseUp, { passive: true });
    });

    this.overviewPointerCleanup = () => {
      if (hasPointerCapture && capturedPointerId !== null) {
        try {
          container.releasePointerCapture(capturedPointerId);
        } catch (e) {
          // 忽略
        }
      }

      endManualBoxDrag();
      capturedPointerId = null;
      hasPointerCapture = false;

      // 恢复样式，避免影响其他交互
      container.style.touchAction = prevTouchAction;
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUpLike);
      container.removeEventListener('pointercancel', onPointerUpLike);
      container.removeEventListener('lostpointercapture', onPointerUpLike);
      // 清理 window 级别的监听器
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);

      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
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
      Sentry.captureException(error, { tags: { operation: 'exportToPng' } });
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
      Sentry.captureException(error, { tags: { operation: 'exportToSvg' } });
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      return null;
    }
  }
  
  private getExportFileName(): string {
    const project = this.projectState.activeProject();
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
    if (this.uiState.activeView() !== 'flow') return;
    if (!this.pendingAutoFitToContents) return;

    const viewState = this.projectState.getViewState();
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
  
  private detectStructuralChange(currentNodeMap: Map<string, go.ObjectData>, newTasks: Task[]): boolean {
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
    
    const project = this.projectState.activeProject();
    if (project) {
      const model = this.diagram?.model as go.GraphLinksModel;
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
    
    const project = this.projectState.activeProject();
    if (!project) {
      return;
    }
    
    try {
      const lastUpdateType = this.taskOps.getLastUpdateType();
      
      const model = this.diagram.model as go.GraphLinksModel;
      const currentNodeMap = new Map<string, go.ObjectData>();
      (model.nodeDataArray || []).forEach((n: go.ObjectData) => {
        if (n.key) currentNodeMap.set(n.key as string, n);
      });
      
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);
      
      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }
      
      const existingNodeMap = new Map<string, go.ObjectData>();
      (this.diagram.model as go.GraphLinksModel).nodeDataArray.forEach((n: go.ObjectData) => {
        if (n.key) {
          existingNodeMap.set(n.key as string, n);
        }
      });
      
      const searchQuery = this.uiState.searchQuery();
      const diagramData = this.configService.buildDiagramData(
        tasks.filter(t => !t.deletedAt),
        project,
        searchQuery,
        existingNodeMap
      );
      
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: go.Part) => {
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
      
      const nodesToRemove = model.nodeDataArray.filter((n: go.ObjectData) => !nodeKeys.has(n.key as string));
      nodesToRemove.forEach((n: go.ObjectData) => model.removeNodeData(n));
      
      const linksToRemove = model.linkDataArray.filter((l: go.ObjectData) => !linkKeys.has(l.key as string));
      linksToRemove.forEach((l: go.ObjectData) => model.removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      if (selectedKeys.size > 0) {
        this.diagram.nodes.each((node: go.Node) => {
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
          const viewState = this.projectState.getViewState();
          if (!viewState) {
            if (this.uiState.activeView() !== 'flow') {
              this.pendingAutoFitToContents = true;
              return;
            }
            this.zoomService.fitToContents();
          }
        }, 100);
      }
      
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'updateDiagram' } });
      this.handleError('更新流程图失败', error);
    }
  }
  
  // ========== 拖放支持 ==========
  
  setupDropHandler(onDrop: (taskData: Task, docPoint: go.Point) => void): void {
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
      if (!data || !this.diagram || !this.diagramDiv) return;
      
      const trimmed = data.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return;
      }
      
      try {
        const task = JSON.parse(data);
        // 使用 DragEvent 的坐标计算准确的拖放位置
        // diagram.lastInput.viewPoint 在拖放场景下可能不准确
        const rect = this.diagramDiv.getBoundingClientRect();
        const viewX = e.clientX - rect.left;
        const viewY = e.clientY - rect.top;
        const pt = new go.Point(viewX, viewY);
        const loc = this.diagram.transformViewToDoc(pt);
        onDrop(task, loc);
      } catch (err) {
        this.logger.error('Drop error:', err);
        Sentry.captureException(err, { tags: { operation: 'drop' } });
      }
    });
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 【关键】拦截 GoJS 默认删除行为
   * 
   * 设计原则：强制单向数据流 (Store -> Signal -> Diagram)
   * - 禁止 GoJS 直接删除节点，避免"脑裂"问题
   * - Delete/Backspace 键触发自定义事件，由 Angular Service 处理
   * - 所有删除操作必须先更新 Store，再由 Store 变化驱动 GoJS 刷新
   */
  private setupDeleteKeyInterception(): void {
    if (!this.diagram) return;
    
    const diagram = this.diagram;
    const originalDoKeyDown = diagram.commandHandler.doKeyDown.bind(diagram.commandHandler);
    
    // 禁止 GoJS 默认的删除选中项行为
    diagram.commandHandler.canDeleteSelection = () => false;
    
    // 拦截 Delete/Backspace 键
    diagram.commandHandler.doKeyDown = () => {
      const e = diagram.lastInput;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 触发自定义删除事件，由 FlowEventService 处理
        // 通过事件总线解耦，避免循环依赖
        this.logger.debug('拦截 Delete 键，触发自定义删除事件');
        flowTemplateEventHandlers.onDeleteKeyPressed?.();
        return; // 阻止 GoJS 默认删除
      }
      // 其他按键走默认逻辑
      originalDoKeyDown();
    };
    
    this.logger.info('Delete 键拦截已配置，GoJS 默认删除行为已禁用');
  }
  
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
      
      const projectId = this.projectState.activeProjectId();
      if (!projectId) return;
      
      const scale = this.diagram.scale;
      const pos = this.diagram.position;
      
      this.projectState.updateViewState(projectId, {
        scale,
        positionX: pos.x,
        positionY: pos.y
      });
      this.syncCoordinator.schedulePersist();
      
      this.viewStateSaveTimer = null;
    }, 1000);
  }
  
  private restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.projectState.getViewState();
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

      const viewState = this.projectState.getViewState();
      
      if (viewState) {
        this.pendingAutoFitToContents = false;
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        if (this.uiState.activeView() !== 'flow') {
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
    // 使用类型断言绕过严格类型检查
    (this.overview as unknown as { fixedBounds: go.Rect | undefined }).fixedBounds = bounds ?? undefined;
  }
}
