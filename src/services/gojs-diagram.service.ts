import { Injectable, inject, signal, NgZone, computed } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { Task } from '../models';
import { environment } from '../environments/environment';
import { GOJS_CONFIG } from '../config/constants';
import { getFlowStyles, FlowStyleConfig, FlowTheme } from '../config/flow-styles';
import * as go from 'gojs';

// ---------------------------------------------------------
// 1. 数学算法：计算矩形边界上离目标点最近的点
// ---------------------------------------------------------
function getClosestPointOnNodeBounds(node: go.Node, p: go.Point): go.Point {
  const b = node.actualBounds;
  
  // 1. 将目标点(p)限制在矩形范围内 (Clamp)
  // 这处理了鼠标在节点外部的情况：直接投影到最近的边上
  let x = Math.max(b.x, Math.min(p.x, b.x + b.width));
  let y = Math.max(b.y, Math.min(p.y, b.y + b.height));

  // 2. 如果点在矩形内部（极少情况，或者鼠标回到了节点内），
  // 强制“推”到最近的边上
  if (x > b.x && x < b.x + b.width && y > b.y && y < b.y + b.height) {
    const distLeft = x - b.x;
    const distRight = (b.x + b.width) - x;
    const distTop = y - b.y;
    const distBottom = (b.y + b.height) - y;
    
    const min = Math.min(distLeft, distRight, distTop, distBottom);
    
    if (min === distLeft) x = b.x;
    else if (min === distRight) x = b.x + b.width;
    else if (min === distTop) y = b.y;
    else y = b.y + b.height;
  }

  return new go.Point(x, y);
}

// ---------------------------------------------------------
// 2. 自定义 LinkingTool
// ---------------------------------------------------------
class DynamicLinkingTool extends go.LinkingTool {
  private _isDynamic: boolean = false;

  constructor() {
    super();
  }

  // 重写：激活工具时检查是否是从“拉出点”开始
  override doActivate() {
    this._isDynamic = false;
    const port = this.findLinkablePort();
    
    // 只有从 ID 为 "T", "B", "L", "R" 的端口拖拽才启用特殊逻辑
    if (port && ["T", "B", "L", "R"].includes(port.portId)) {
      this._isDynamic = true;
    }

    super.doActivate();

    // 关键：如果是动态模式，告诉临时链接不要自动计算 Spot，完全由我们控制坐标
    if (this._isDynamic && this.temporaryLink) {
      this.temporaryLink.fromSpot = go.Spot.None;
    }
  }

  // 重写：鼠标移动时实时计算起点
  override doMouseMove() {
    // 让父类处理目标点（鼠标位置）的更新
    super.doMouseMove();

    if (this._isDynamic && this.isActive && this.temporaryLink) {
      const node = this.originalFromNode;
      if (node) {
        const mousePt = this.diagram.lastInput.documentPoint;
        
        // 计算：基于【节点主体】边界的最近点
        const edgePt = getClosestPointOnNodeBounds(node, mousePt);

        // 设置临时链接的起点（索引0）
        this.temporaryLink.setPointAt(0, edgePt);
      }
    }
  }

  // 重写：链接创建完成时，固定最终位置
  override insertLink(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): go.Link | null {    // 安全检查：防止节点连接到自身
    if (fromNode === toNode) {
      return null;
    }
        // 先让父类创建链接
    const newLink = super.insertLink(fromNode, fromPort, toNode, toPort);

    if (newLink && this._isDynamic) {
      const mousePt = this.diagram.lastInput.documentPoint;
      const edgePt = getClosestPointOnNodeBounds(fromNode, mousePt);
      
      // 将绝对坐标转换为相对 Spot (0-1)，以便适应节点大小变化
      const b = fromNode.actualBounds;
      const spotX = (edgePt.x - b.x) / b.width;
      const spotY = (edgePt.y - b.y) / b.height;

      // 应用 Spot。这样链接就会“记住”它在圆角矩形边上的位置
      newLink.fromSpot = new go.Spot(spotX, spotY);
    }
    return newLink;
  }
}

export interface DiagramCallbacks {
  onNodeClick: (taskId: string) => void;
  onNodeDoubleClick: (taskId: string) => void;
  onLinkModeClick: (taskId: string) => void;
  onConnectionEditorOpen: (sourceId: string, targetId: string, description: string, x: number, y: number) => void;
  onLinkDelete: (link: any, x: number, y: number) => void;
  onError: (message: string) => void;
}

export interface InsertPosition {
  parentId?: string;
  beforeTaskId?: string;
  afterTaskId?: string;
}

/**
 * GoJS 图表服务
 * 封装 GoJS 图表的初始化、更新、布局等核心逻辑
 */
@Injectable({
  providedIn: 'root'
})
export class GoJSDiagramService {
  private readonly store = inject(StoreService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('GoJSDiagram');
  private readonly zone = inject(NgZone);
  
  private diagram: go.Diagram | null = null;
  private callbacks: DiagramCallbacks | null = null;
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 保存监听器引用以便正确移除 */
  private selectionMovedListener: ((e: go.DiagramEvent) => void) | null = null;
  private partResizedListener: ((e: go.DiagramEvent) => void) | null = null;
  
  /** 当前主题样式配置 */
  private readonly currentStyles = computed(() => {
    const theme = this.store.theme() as FlowTheme;
    return getFlowStyles(theme);
  });
  
  /** 图表错误状态 */
  readonly diagramError = signal<string | null>(null);
  
  /** 是否处于连接模式 */
  readonly isLinkMode = signal(false);
  
  /**
   * 初始化图表
   */
  initDiagram(container: HTMLElement, callbacks: DiagramCallbacks): go.Diagram | null {
    this.callbacks = callbacks;
    
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载');
      return null;
    }
    
    try {
      // 注入 GoJS License Key
      if (environment.gojsLicenseKey) {
        (go.Diagram as any).licenseKey = environment.gojsLicenseKey;
      }
      
      const $ = go.GraphObject.make;
      
      this.diagram = $(go.Diagram, container as HTMLDivElement, {
        "undoManager.isEnabled": false,
        "animationManager.isEnabled": false,
        "allowDrop": true,
        layout: $(go.Layout),
        "autoScale": go.Diagram.None,
        "initialAutoScale": go.Diagram.None,
        "scrollMode": go.Diagram.InfiniteScroll, // 无限画布
        "scrollMargin": new go.Margin(500, 500, 500, 500), // 大边距支持无限滚动
        "draggingTool.isGridSnapEnabled": false,
        linkingTool: new DynamicLinkingTool()
      });
      
      // 配置 LinkingTool 样式
      const linkingTool = this.diagram.toolManager.linkingTool;
      (linkingTool as any).temporaryFromSpot = go.Spot.AllSides;
      (linkingTool as any).temporaryToSpot = go.Spot.AllSides;
      linkingTool.temporaryLink = $(go.Link,
        { 
          layerName: "Tool",
          curve: go.Link.Bezier,
          curviness: NaN,  // 让 GoJS 自动计算最佳曲率
          toShortLength: 8
        },
        $(go.Shape, {
          isPanelMain: true,
          stroke: "#78716C", 
          strokeWidth: 3, 
          strokeDashArray: [4, 4],
          strokeCap: "round",
          strokeJoin: "round"
        }),
        $(go.Shape, { 
          toArrow: "Standard", 
          strokeWidth: 0, 
          fill: "#78716C",
          stroke: "#78716C",
          scale: 1.2,
          segmentOrientation: go.Orientation.Along,  // 关键：确保箭头沿线条方向旋转
          segmentIndex: -1  // -1 表示连接线末端
        })
      );
      
      // 设置节点移动监听
      this.setupDiagramListeners();
      
      // 创建节点模板
      this.diagram!.nodeTemplate = this.createNodeTemplate($);
      
      // 创建连接线模板
      this.diagram!.linkTemplate = this.createLinkTemplate($);
      
      this.diagramError.set(null);
      this.logger.info('GoJS 图表初始化成功');
      
      return this.diagram;
    } catch (error) {
      this.handleError('GoJS 图表初始化失败: ' + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }
  
  /**
   * 销毁图表
   * 完全清理图表资源，防止内存泄漏
   */
  destroyDiagram() {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    
    if (this.diagram) {
      // 移除所有事件监听器（使用保存的引用）
      if (this.selectionMovedListener) {
        this.diagram.removeDiagramListener('SelectionMoved', this.selectionMovedListener);
        this.selectionMovedListener = null;
      }
      if (this.partResizedListener) {
        this.diagram.removeDiagramListener('PartResized', this.partResizedListener);
        this.partResizedListener = null;
      }
      
      // 清理图表内容
      this.diagram.clear();
      
      // 断开与 DOM 的连接
      this.diagram.div = null;
      this.diagram = null;
    }
    
    this.callbacks = null;
    this.isLinkMode.set(false);
    this.diagramError.set(null);
  }
  
  /**
   * 清理待执行的位置保存操作
   * 在项目切换时调用，防止旧项目的位置被保存到新项目
   */
  clearPendingPositionSave() {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
  }
  
  /**
   * 获取图表实例
   */
  getDiagram(): go.Diagram | null {
    return this.diagram;
  }
  
  /**
   * 检测是否有结构性变化
   */
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
    
    return false;
  }

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[]) {
    if (this.diagramError() || !this.diagram) {
      return;
    }
    
    const model = this.diagram.model;
    if (!model) return;
    
    const project = this.store.activeProject();
    if (!project) return;
    
    // 位置更新跳过重建（但需要检查结构性变化）
    const lastUpdateType = this.store.getLastUpdateType();
    
    // 检查是否有结构性变化
    const currentNodeMap = new Map<string, any>();
    ((model as any).nodeDataArray || []).forEach((n: any) => {
      if (n.key) currentNodeMap.set(n.key, n);
    });
    
    const activeTasks = tasks.filter(t => !t.deletedAt && t.status !== 'archived');
    const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);
    
    if (lastUpdateType === 'position' && !hasStructuralChange) {
      return;
    }
    
    try {
      // 过滤显示的任务：待分配任务（stage === null）也应该在流程图中显示
      const tasksToShow = tasks.filter(t => t.status !== 'archived');
      
      // 保存当前选中状态
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: any) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });
      
      // 构建节点数据
      const { nodeDataArray, linkDataArray } = this.buildDiagramData(tasksToShow, project);
      
      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;
      
      // 合并数据
      (model as any).mergeNodeDataArray(nodeDataArray);
      (model as any).mergeLinkDataArray(linkDataArray);
      
      // 移除过期节点和连接
      this.removeStaleData(model, nodeDataArray, linkDataArray);
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      // 强制刷新所有链接路由（确保端口 Side Spot 分散计算生效）
      this.diagram.links.each((link: go.Link) => {
        link.invalidateRoute();
      });
      
      // 恢复选中状态
      this.restoreSelection(selectedKeys);
      
    } catch (error) {
      this.logger.error('更新图表失败', error);
    }
  }
  
  /** 最小缩放比例 */
  private readonly MIN_SCALE = 0.1;
  /** 最大缩放比例 */
  private readonly MAX_SCALE = 4.0;
  
  /**
   * 缩放
   */
  zoomIn() {
    if (this.diagram) {
      const newScale = this.diagram.scale * 1.1;
      this.diagram.scale = Math.min(newScale, this.MAX_SCALE);
    }
  }
  
  zoomOut() {
    if (this.diagram) {
      const newScale = this.diagram.scale * 0.9;
      this.diagram.scale = Math.max(newScale, this.MIN_SCALE);
    }
  }
  
  /**
   * 应用自动布局
   */
  applyAutoLayout() {
    if (!this.diagram) return;
    
    const $ = go.GraphObject.make;
    this.diagram.layout = $(go.TreeLayout, {
      angle: 90,
      layerSpacing: 60,
      nodeSpacing: 30
    });
    
    this.diagram.layoutDiagram(true);
    
    // 布局完成后保存所有节点位置
    this.saveAllNodePositions();
    
    // 恢复到手动布局
    this.diagram.layout = $(go.Layout);
  }
  
  /**
   * 定位到节点
   */
  centerOnNode(taskId: string) {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(taskId);
    if (node) {
      this.diagram.centerRect(node.actualBounds);
      this.diagram.select(node);
    }
  }
  
  /**
   * 计算插入位置
   */
  computeInsertPosition(dropPoint: go.Point): InsertPosition {
    if (!this.diagram) return {};
    
    let closestNode: go.Node | null = null;
    let closestDist = Infinity;
    let insertPosition: 'child' | 'before' | 'after' = 'child';
    
    this.diagram.nodes.each((node: go.Node) => {
      const nodeLoc = node.location;
      const dist = Math.sqrt(Math.pow(dropPoint.x - nodeLoc.x, 2) + Math.pow(dropPoint.y - nodeLoc.y, 2));
      
      if (dist < closestDist && dist < 150) {
        closestDist = dist;
        closestNode = node;
        
        const dy = dropPoint.y - nodeLoc.y;
        if (dy > 30) {
          insertPosition = 'child';
        } else if (dy < -30) {
          insertPosition = 'before';
        } else {
          insertPosition = 'after';
        }
      }
    });
    
    if (!closestNode) return {};
    
    const nodeId = (closestNode as any).data.key;
    
    if (insertPosition === 'child') {
      return { parentId: nodeId };
    } else if (insertPosition === 'before') {
      return { beforeTaskId: nodeId };
    } else {
      return { afterTaskId: nodeId };
    }
  }
  
  /**
   * 设置连接模式
   */
  setLinkMode(enabled: boolean) {
    this.isLinkMode.set(enabled);
  }
  
  /**
   * 删除连接线
   */
  deleteLink(link: any) {
    if (!this.diagram || !link) return;
    
    this.diagram.startTransaction('delete link');
    this.diagram.remove(link);
    this.diagram.commitTransaction('delete link');
  }
  
  // ============ 私有方法 ============
  
  private setupDiagramListeners() {
    if (!this.diagram) return;
    
    // 创建并保存监听器引用
    this.selectionMovedListener = (e: go.DiagramEvent) => {
      if (this.positionSaveTimer) {
        clearTimeout(this.positionSaveTimer);
      }
      this.positionSaveTimer = setTimeout(() => {
        e.subject.each((part: any) => {
          if (part instanceof go.Node) {
            const loc = part.location;
            this.zone.run(() => {
              this.store.updateTaskPositionWithRankSync(part.data.key, loc.x, loc.y);
            });
          }
        });
      }, GOJS_CONFIG.POSITION_SAVE_DEBOUNCE);
    };
    
    this.partResizedListener = () => {
      this.saveAllNodePositions();
    };
    
    // 监听节点移动完成
    this.diagram.addDiagramListener('SelectionMoved', this.selectionMovedListener);
    this.diagram.addDiagramListener('PartResized', this.partResizedListener);
  }
  
  private createNodeTemplate($: any): go.Node {
    const self = this;
    const isMobile = this.store.isMobile();
    const portSize = isMobile ? 14 : 10;  // 连接手柄大小
    
    /**
     * 创建边缘连接手柄
     * @param name 端口名称
     * @param spot 位置（Top/Bottom/Left/Right）
     */
    function makePort(name: string, spot: go.Spot): go.Shape {
      return $(go.Shape, "Circle", {
        fill: "transparent",       // 默认透明
        stroke: null,              // 默认无边框
        strokeWidth: 1,
        desiredSize: new go.Size(portSize, portSize),
        alignment: spot,
        alignmentFocus: spot,
        portId: name,
        fromLinkable: true,
        toLinkable: true,
        fromSpot: go.Spot.AllSides, // 允许从任意角度出线
        toSpot: go.Spot.AllSides,   // 允许从任意角度入线
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
    
    return $(go.Node, "Spot", {
      locationSpot: go.Spot.Center,
      selectionAdorned: true,
      click: (e: any, node: any) => {
        if (e.diagram.lastInput.dragging) return;
        self.zone.run(() => {
          if (self.isLinkMode()) {
            self.callbacks?.onLinkModeClick(node.data.key);
          } else {
            self.callbacks?.onNodeClick(node.data.key);
          }
        });
      },
      doubleClick: (e: any, node: any) => {
        self.zone.run(() => {
          self.callbacks?.onNodeDoubleClick(node.data.key);
        });
      }
    },
    new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
    
    // 主内容面板 - 只能拖动，不能拉线
    $(go.Panel, "Auto",
      new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
        isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
      $(go.Shape, "RoundedRectangle", {
        fill: "white",
        stroke: "#78716C",       // retro.muted
        strokeWidth: 1,
        parameter1: 10,
        portId: "",              // 主体端口
        fromLinkable: false,     // 不能从主体拉线
        toLinkable: false,       // 不能连到主体
        cursor: "move",          // 移动光标
        fromLinkable: false,     // 不能从主体拉线
        toLinkable: true,        // 允许连到主体
        fromSpot: go.Spot.AllSides, // 允许从任意角度出线
        toSpot: go.Spot.AllSides    // 允许从任意角度入线
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
    
      // 四个边缘连接手柄（小圆点）
    makePort("T", go.Spot.Top),
    makePort("B", go.Spot.Bottom),
    makePort("L", go.Spot.Left),
    makePort("R", go.Spot.Right)
    );
  }
  
  private createLinkTemplate($: any): go.Link {
    const self = this;
    
    return $(go.Link, {
      routing: go.Link.Normal,
      curve: go.Link.Bezier,
      curviness: NaN,  // 让 GoJS 自动计算最佳曲率，避免固定值导致控制点异常
      toShortLength: 5,  // 减小偏移量，让箭头更贴近目标节点，避免角度计算问题
      fromEndSegmentLength: 22, // 保持曲线曲折感
      toEndSegmentLength: 22,   // 保持曲线曲折感
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
          { click: (e: any, obj: any) => self.deleteLinkFromContext(obj.part) }
        )
      )
    },
    // 透明粗线便于选择
    $(go.Shape, { 
      isPanelMain: true, 
      strokeWidth: self.store.isMobile() ? 24 : 14, 
      stroke: "transparent",
      strokeCap: "round",
      strokeJoin: "round"
    }),
    // 可见线
    $(go.Shape, { 
      isPanelMain: true, 
      strokeWidth: 3.5,
      strokeCap: "round",
      strokeJoin: "round"
    },
      new go.Binding("stroke", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8"),
      new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 3] : null)),
    // 箭头 - 精确配置方向跟随
    $(go.Shape, { 
      toArrow: "Standard", 
      strokeWidth: 0.5, 
      scale: 1.4,
      segmentOrientation: go.Orientation.Along,  // 关键：确保箭头沿线条方向旋转
      segmentIndex: -1,  // -1 表示连接线末端
      alignmentFocus: go.Spot.Right  // 箭头以尖端为对齐基准
    },
      new go.Binding("fill", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8"),
      new go.Binding("stroke", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8")),
    // 联系块标签
    $(go.Panel, "Auto", {
      segmentIndex: NaN,
      segmentFraction: 0.5,
      cursor: "pointer",
      click: (e: any, panel: any) => {
        e.handled = true;
        const link = panel.part;
        if (link?.data) {
          // 获取连接线的起始节点位置
          const fromNode = link.fromNode;
          let x = 0, y = 0;
          if (fromNode) {
            // 使用起始节点的中心位置，而不是连接线中点
            const fromCenter = fromNode.getDocumentPoint(go.Spot.Center);
            x = fromCenter.x;
            y = fromCenter.y;
          } else {
            // 后备方案：使用连接线中点
            const midPoint = link.midPoint;
            x = midPoint.x;
            y = midPoint.y;
          }
          self.zone.run(() => {
            self.callbacks?.onConnectionEditorOpen(
              link.data.from,
              link.data.to,
              link.data.description || '',
              x,
              y
            );
          });
        }
      }
    },
    new go.Binding("visible", "isCrossTree"),
    $(go.Shape, "RoundedRectangle", {
      fill: "#eef2ff",
      stroke: "#a5b4fc",
      strokeWidth: 1,
      parameter1: 4
    }),
    $(go.TextBlock, {
      margin: new go.Margin(2, 4, 2, 4),
      font: "9px \"LXGW WenKai Screen\", sans-serif",
      stroke: "#4f46e5",
      maxSize: new go.Size(80, NaN),
      overflow: go.TextBlock.OverflowEllipsis
    },
    new go.Binding("text", "description", (d: string) => d || "添加备注"))
    )
    );
  }
  
  private buildDiagramData(tasks: Task[], project: any) {
    const existingNodeMap = new Map<string, any>();
    if (this.diagram?.model) {
      (this.diagram.model as any).nodeDataArray.forEach((n: any) => {
        if (n.key) existingNodeMap.set(n.key, n);
      });
    }
    
    const nodeDataArray: any[] = [];
    const linkDataArray: any[] = [];
    
    // 构建父子关系集合
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    let newNodeIndex = 0;
    const searchQuery = this.store.searchQuery().toLowerCase().trim();
    
    tasks.forEach(t => {
      const existingNode = existingNodeMap.get(t.id);
      let loc: string;
      
      if (existingNode?.loc) {
        loc = existingNode.loc;
      } else if (t.x !== 0 || t.y !== 0) {
        loc = `${t.x} ${t.y}`;
      } else {
        const stageX = ((t.stage || 1) - 1) * 150;
        const indexY = newNodeIndex * 100;
        loc = `${stageX} ${indexY}`;
        newNodeIndex++;
      }
      
      // 检查搜索匹配
      const isSearchMatch = searchQuery && (
        t.title.toLowerCase().includes(searchQuery) ||
        t.content.toLowerCase().includes(searchQuery) ||
        t.displayId.toLowerCase().includes(searchQuery) ||
        (t.attachments?.some(a => a.name.toLowerCase().includes(searchQuery)) ?? false) ||
        (t.tags?.some(tag => tag.toLowerCase().includes(searchQuery)) ?? false)
      );
      
      // 节点颜色 - 使用主题配置
      const styles = this.currentStyles();
      let nodeColor: string;
      if (isSearchMatch) {
        nodeColor = styles.node.searchHighlightBackground;
      } else if (t.stage === null) {
        nodeColor = styles.node.unassignedBackground;
      } else if (t.status === 'completed') {
        nodeColor = styles.node.completedBackground;
      } else {
        nodeColor = styles.node.background;
      }
      
      // 边框颜色
      let borderColor: string;
      let borderWidth: number;
      if (isSearchMatch) {
        borderColor = styles.node.searchHighlightBorder;
        borderWidth = 2;
      } else if (t.stage === null) {
        borderColor = styles.node.unassignedBorder;
        borderWidth = 2;
      } else {
        borderColor = styles.node.defaultBorder;
        borderWidth = 1;
      }
      
      // 文字颜色
      const titleColor = t.stage === null ? styles.text.unassignedTitleColor : styles.text.titleColor;
      
      nodeDataArray.push({
        key: t.id,
        title: t.title || '未命名任务',
        displayId: this.store.compressDisplayId(t.displayId),
        stage: t.stage,
        loc: loc,
        color: nodeColor,
        borderColor: borderColor,
        borderWidth: borderWidth,
        titleColor: titleColor,
        displayIdColor: styles.text.displayIdColor,
        selectedBorderColor: styles.node.selectedBorder,
        isUnassigned: t.stage === null,
        isSearchMatch: isSearchMatch,
        isSelected: false
      });
      
      // 父子连接
      if (t.parentId) {
        linkDataArray.push({
          key: `${t.parentId}-${t.id}`,
          from: t.parentId,
          to: t.id,
          isCrossTree: false
        });
      }
    });
    
    // 跨树连接
    project.connections.forEach((conn: any) => {
      const pairKey = `${conn.source}->${conn.target}`;
      if (!parentChildPairs.has(pairKey)) {
        const sourceExists = tasks.some(t => t.id === conn.source);
        const targetExists = tasks.some(t => t.id === conn.target);
        if (sourceExists && targetExists) {
          linkDataArray.push({
            key: `cross-${conn.source}-${conn.target}`,
            from: conn.source,
            to: conn.target,
            isCrossTree: true,
            description: conn.description || ''
          });
        }
      }
    });
    
    return { nodeDataArray, linkDataArray };
  }
  
  private removeStaleData(model: any, nodeDataArray: any[], linkDataArray: any[]) {
    const nodeKeys = new Set(nodeDataArray.map(n => n.key));
    const linkKeys = new Set(linkDataArray.map(l => l.key));
    
    const nodesToRemove = model.nodeDataArray.filter((n: any) => !nodeKeys.has(n.key));
    nodesToRemove.forEach((n: any) => model.removeNodeData(n));
    
    const linksToRemove = model.linkDataArray.filter((l: any) => !linkKeys.has(l.key));
    linksToRemove.forEach((l: any) => model.removeLinkData(l));
  }
  
  private restoreSelection(selectedKeys: Set<string>) {
    if (!this.diagram || selectedKeys.size === 0) return;
    
    this.diagram.clearSelection();
    selectedKeys.forEach(key => {
      const node = this.diagram!.findNodeForKey(key);
      if (node) node.isSelected = true;
    });
  }
  
  private saveAllNodePositions() {
    if (!this.diagram) return;
    
    this.diagram.nodes.each((node: go.Node) => {
      if (node.data?.key) {
        const loc = node.location;
        this.store.updateTaskPosition(node.data.key, loc.x, loc.y);
      }
    });
  }
  
  private deleteLinkFromContext(link: any) {
    if (!link?.data || !this.diagram) return;
    
    const fromId = link.data.from;
    const toId = link.data.to;
    
    this.zone.run(() => {
      if (link.data.isCrossTree) {
        // 移除跨树连接
        this.store.removeConnection(fromId, toId);
      } else {
        // 清除父任务关系 - 通过更新任务移动到未分配
        const task = this.store.tasks().find(t => t.id === toId);
        if (task) {
          this.store.moveTaskToStage(toId, null, null);
        }
      }
    });
    
    this.deleteLink(link);
  }
  
  private handleError(message: string) {
    this.diagramError.set(message);
    this.logger.error(message);
    this.callbacks?.onError(message);
  }
}
