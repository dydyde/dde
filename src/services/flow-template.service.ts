/**
 * FlowTemplateService - GoJS 节点和连接线模板配置
 * 
 * 从 flow-diagram.service.ts (3000+ 行) 提取的模板配置逻辑
 * 
 * 核心设计：事件代理（Event Delegation via Event Bus）
 * - 模板只负责"我长什么样"和"我有点击交互"
 * - 点击时通过 flowTemplateEventHandlers 全局对象发送信号
 * - 不关心"点击后具体调用哪个 Service"
 * - FlowEventService 在初始化时注册处理器
 * 
 * 职责：
 * - 节点模板配置（颜色、大小、端口）
 * - 连接线模板配置（样式、标签、工具）
 * - Overview 模板配置
 * - 图层配置
 * - 周界交点计算算法
 */

import { Injectable, inject } from '@angular/core';
import { GOJS_CONFIG } from '../config/constants';
import { flowTemplateEventHandlers } from './flow-template-events';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import * as go from 'gojs';

/**
 * 节点端口配置
 */
export interface PortConfig {
  name: string;
  spot: go.Spot;
  size: number;
}

/**
 * 节点样式配置
 */
export interface NodeStyleConfig {
  portSize: number;
  assignedWidth: number;
  unassignedWidth: number;
  defaultFill: string;
  defaultStroke: string;
  selectedStroke: string;
  cornerRadius: number;
}

/**
 * 连接线样式配置
 */
export interface LinkStyleConfig {
  defaultStroke: string;
  parentChildStroke: string;
  selectedStroke: string;
  strokeWidth: number;
  captureRadius: number;
}

@Injectable({
  providedIn: 'root'
})
export class FlowTemplateService {
  private readonly store = inject(StoreService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowTemplate');
  
  // ========== 样式配置 ==========
  
  getNodeStyleConfig(isMobile: boolean): NodeStyleConfig {
    return {
      portSize: isMobile ? 24 : 10,
      assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH,
      unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH,
      defaultFill: 'white',
      defaultStroke: '#78716C',
      selectedStroke: '#4A8C8C',
      cornerRadius: 10
    };
  }
  
  getLinkStyleConfig(isMobile: boolean): LinkStyleConfig {
    const rawCaptureRadius = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD ?? 80;
    const captureRadius = isMobile
      ? Math.min(Math.max(rawCaptureRadius, 28), 60)
      : Math.min(Math.max(rawCaptureRadius, 16), 36);
    
    return {
      defaultStroke: '#78716C',
      parentChildStroke: '#A8A29E',
      selectedStroke: '#4A8C8C',
      strokeWidth: 1.5,
      captureRadius
    };
  }
  
  getPortConfigs(): PortConfig[] {
    return [
      { name: 'T', spot: go.Spot.Top, size: 10 },
      { name: 'B', spot: go.Spot.Bottom, size: 10 },
      { name: 'L', spot: go.Spot.Left, size: 10 },
      { name: 'R', spot: go.Spot.Right, size: 10 }
    ];
  }
  
  // ========== 图层配置 ==========
  
  /**
   * 确保图层顺序稳定：Links 永远在 Nodes 下方
   */
  ensureDiagramLayers(diagram: go.Diagram): void {
    const foregroundLayer = diagram.findLayer('Foreground');
    if (!foregroundLayer) return;

    let nodesLayer = diagram.findLayer('Nodes');
    if (!nodesLayer) {
      nodesLayer = new go.Layer();
      nodesLayer.name = 'Nodes';
      diagram.addLayerBefore(nodesLayer, foregroundLayer);
    }

    let linksLayer = diagram.findLayer('Links');
    if (!linksLayer) {
      linksLayer = new go.Layer();
      linksLayer.name = 'Links';
      diagram.addLayerBefore(linksLayer, nodesLayer);
    }
  }
  
  // ========== Perimeter Intersection 算法 ==========
  
  /**
   * 计算从节点中心到目标点的射线与节点边界的交点
   * 效果：连接线端点像水珠一样沿着节点边缘滑动
   */
  computePerimeterIntersection(bounds: go.Rect, targetPoint: go.Point): go.Point {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    
    const dx = targetPoint.x - centerX;
    const dy = targetPoint.y - centerY;
    
    if (dx === 0 && dy === 0) {
      return new go.Point(centerX, bounds.y);
    }
    
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    
    let t = Infinity;
    
    if (dx > 0) {
      const tRight = halfWidth / dx;
      if (tRight < t && Math.abs(dy * tRight) <= halfHeight) {
        t = tRight;
      }
    }
    
    if (dx < 0) {
      const tLeft = -halfWidth / dx;
      if (tLeft < t && Math.abs(dy * tLeft) <= halfHeight) {
        t = tLeft;
      }
    }
    
    if (dy > 0) {
      const tBottom = halfHeight / dy;
      if (tBottom < t && Math.abs(dx * tBottom) <= halfWidth) {
        t = tBottom;
      }
    }
    
    if (dy < 0) {
      const tTop = -halfHeight / dy;
      if (tTop < t && Math.abs(dx * tTop) <= halfWidth) {
        t = tTop;
      }
    }
    
    if (t === Infinity) {
      return new go.Point(centerX, bounds.y);
    }
    
    return new go.Point(centerX + dx * t, centerY + dy * t);
  }
  
  /**
   * 计算节点边界交点（从节点获取）
   */
  private computeNodeEdgePoint(node: go.Node, targetPoint: go.Point): go.Point {
    const bodyPanel = node.findObject("BODY") as go.Panel;
    let bounds: go.Rect;
    
    if (bodyPanel) {
      bounds = bodyPanel.getDocumentBounds();
    } else {
      bounds = node.actualBounds;
      if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
        return node.getDocumentPoint(go.Spot.Center);
      }
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
    
    return this.computePerimeterIntersection(bounds, targetPoint);
  }
  
  // ========== 节点模板 ==========
  
  /**
   * 设置节点模板
   * 
   * 事件代理模式：
   * - click/doubleClick 通过 flowTemplateEventHandlers 发送信号
   * - FlowEventService 统一监听和处理
   */
  setupNodeTemplate(diagram: go.Diagram): void {
    const $ = go.GraphObject.make;
    const isMobile = this.store.isMobile();
    const portSize = isMobile ? 24 : 10;
    
    const _allowedPortIds = ["T", "B", "L", "R"];
    
    /**
     * 创建边缘连接手柄
     * 使用 any 类型避免 GoJS 泛型类型不兼容问题
     */
    const makePort = (name: string, spot: go.Spot): any => {
      return $(go.Shape, "Circle", {
        fill: "transparent",
        stroke: null,
        strokeWidth: isMobile ? 2 : 1,
        desiredSize: new go.Size(portSize, portSize),
        alignment: spot,
        alignmentFocus: go.Spot.Center,
        portId: name,
        fromLinkable: true,
        toLinkable: true,
        fromSpot: go.Spot.None,
        toSpot: go.Spot.None,
        isActionable: false,
        cursor: "crosshair",
        mouseEnter: (e: any, port: any) => {
          if (e.diagram.isReadOnly) return;
          port.fill = "#4A8C8C";
          port.stroke = "#44403C";
        },
        mouseLeave: (_e: any, port: any) => {
          port.fill = "transparent";
          port.stroke = null;
        }
      });
    };
    
    diagram.nodeTemplate = $(go.Node, "Spot",
      {
        locationSpot: go.Spot.Center,
        layerName: 'Nodes',
        selectionAdorned: true,
        movable: true,
        fromLinkable: false,
        toLinkable: true,
        fromLinkableDuplicates: false,
        toLinkableDuplicates: true,
        // 事件代理：通过全局事件总线发送信号
        click: (e: any, node: any) => {
          if (e.diagram.lastInput.dragging) return;
          if (e.diagram.lastInput.clickCount >= 2) return;
          flowTemplateEventHandlers.onNodeClick?.(node);
        },
        doubleClick: (e: any, node: any) => {
          e.handled = true;
          flowTemplateEventHandlers.onNodeDoubleClick?.(node);
        }
      },
      new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
      
      // 主面板
      $(go.Panel, "Auto",
        {
          name: "BODY",
          portId: "",
          fromLinkable: false,
          toLinkable: true,
          fromSpot: go.Spot.AllSides,
          toSpot: go.Spot.AllSides,
          cursor: "move"
        },
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
          isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
        $(go.Shape, "RoundedRectangle", {
          name: "SHAPE",
          fill: "white",
          stroke: "#78716C",
          strokeWidth: 1,
          parameter1: 10,
          isPanelMain: true
        },
        new go.Binding("fill", "color"),
        new go.Binding("stroke", "", (data: any, obj: go.GraphObject) => {
          if ((obj.part as go.Node)?.isSelected) return data.selectedBorderColor || "#4A8C8C";
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
      
      // 边缘连接手柄
      makePort("T", go.Spot.Top),
      makePort("B", go.Spot.Bottom),
      makePort("L", go.Spot.Left),
      makePort("R", go.Spot.Right)
    );
    
    this.logger.debug('节点模板已设置');
  }
  
  // ========== 连接线模板 ==========
  
  /**
   * 设置连接线模板
   * 
   * 包括：
   * - LinkingTool/RelinkingTool 配置
   * - 临时连接线样式
   * - 永久连接线模板
   * - 跨树连接标签面板
   */
  setupLinkTemplate(diagram: go.Diagram): void {
    const $ = go.GraphObject.make;
    const isMobile = this.store.isMobile();
    const allowedPortIds = ["T", "B", "L", "R"];
    const linkStyleConfig = this.getLinkStyleConfig(isMobile);
    const pointerTolerance = isMobile ? 6 : 3;
    
    // 创建 getLinkPoint 函数
    const freeAngleLinkPoint = this.createGetLinkPointFunction(diagram, allowedPortIds);
    
    // 配置 LinkingTool
    this.configureLinkingTool(diagram, allowedPortIds, freeAngleLinkPoint, $);
    
    // 配置 RelinkingTool
    this.configureRelinkingTool(diagram, allowedPortIds, linkStyleConfig, freeAngleLinkPoint, pointerTolerance, $);
    
    // 创建连接线模板
    diagram.linkTemplate = $(go.Link,
      {
        layerName: 'Links',
        routing: go.Link.Normal,
        curve: go.Link.Bezier,
        getLinkPoint: freeAngleLinkPoint,
        toShortLength: this.configService.linkConfig.toShortLength,
        fromEndSegmentLength: 22,
        toEndSegmentLength: 22,
        selectable: true,
        selectionAdorned: true,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: true,
        resegmentable: false,
        // 事件代理：桌面端连接线点击（使用 any 类型避免类型兼容问题）
        click: isMobile
          ? () => { /* 移动端空处理器 */ }
          : (e: any, link: any) => {
              if (e.handled) return;
              e.handled = true;
              flowTemplateEventHandlers.onLinkClick?.(link);
            },
        contextMenu: $(go.Adornment, "Vertical",
          $("ContextMenuButton",
            $(go.TextBlock, "删除连接", { margin: 5 }),
            {
              click: (e: any, obj: any) => {
                const link = obj.part?.adornedPart;
                if (link?.data) {
                  flowTemplateEventHandlers.onLinkDeleteRequest?.(link);
                }
              }
            }
          )
        )
      },
      ...this.configService.getLinkMainShapesConfig($, isMobile),
      this.createConnectionLabelPanel($)
    );
    
    this.logger.debug('连接线模板已设置');
  }
  
  /**
   * 创建 getLinkPoint 函数
   */
  private createGetLinkPointFunction(
    _diagram: go.Diagram,
    _allowedPortIds: string[]
  ): go.Link['getLinkPoint'] {
    const self = this;
    
    return function(this: go.Link, node, port, spot, from, _ortho, otherNode, otherPort) {
      let actualNode: go.Node | null = null;
      
      // 策略1: 从连接线的 fromNode/toNode 获取
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
      
      // 策略3: 从 port.part 获取
      if (!actualNode && port && (port as any).part instanceof go.Node) {
        const partNode = (port as any).part;
        const hasData = !!(partNode as any).data;
        const hasBody = !!(partNode as any).findObject?.('BODY');
        if (hasData || hasBody) {
          actualNode = partNode;
        }
      }
      
      // 策略4: 从工具状态获取
      if (!actualNode && this.diagram) {
        const linkingTool = this.diagram.toolManager.linkingTool;
        const relinkingTool = this.diagram.toolManager.relinkingTool;
        
        if (linkingTool.isActive) {
          const originalPort = from 
            ? ((linkingTool as any).originalFromPort || (linkingTool as any)._tempMainPort)
            : (linkingTool as any).originalToPort;
          
          if (typeof originalPort === 'string') {
            actualNode = this.diagram.findNodeForKey(originalPort);
          } else if (originalPort && originalPort.part instanceof go.Node) {
            actualNode = originalPort.part;
          }
        }
        
        if (!actualNode && relinkingTool.isActive) {
          let adornedLink = (relinkingTool as any).adornedLink || 
                           (relinkingTool as any).adornedObject ||
                           (relinkingTool as any).originalLink;
          
          if (!adornedLink && this.diagram.selection) {
            this.diagram.selection.each((part: go.Part) => {
              if (part instanceof go.Link && !adornedLink) {
                adornedLink = part;
              }
            });
          }
          
          if (adornedLink instanceof go.Link) {
            const isRelinkingFrom = (relinkingTool as any).isForwards === false;
            const isRelinkingTo = (relinkingTool as any).isForwards === true;
            
            if (from) {
              if (!isRelinkingFrom) {
                actualNode = adornedLink.fromNode;
              }
            } else {
              if (!isRelinkingTo) {
                actualNode = adornedLink.toNode;
              }
            }
          }
        }
      }
      
      if (!actualNode) {
        if (this.diagram?.lastInput?.documentPoint) {
          return this.diagram.lastInput.documentPoint;
        }
        return new go.Point();
      }
      
      const doc = actualNode.diagram;
      const target = otherPort?.getDocumentPoint(go.Spot.Center)
        || otherNode?.getDocumentPoint(go.Spot.Center)
        || doc?.lastInput?.documentPoint
        || actualNode.getDocumentPoint(go.Spot.Center);
      
      return self.computeNodeEdgePoint(actualNode, target);
    };
  }
  
  /**
   * 配置 LinkingTool
   */
  private configureLinkingTool(
    diagram: go.Diagram,
    allowedPortIds: string[],
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    $: any
  ): void {
    const linkingTool = diagram.toolManager.linkingTool;
    
    // 只允许从边缘端口开始拉线
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
    
    // 偷梁换柱：激活后替换为主节点端口
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
          (this as any)._originNode = node;
          const mainPort = node.findPort("");
          if (mainPort) {
            (this as any)._tempMainPort = mainPort;
            (this as any)._savedFromLinkable = mainPort.fromLinkable;
            (this as any)._savedToLinkable = mainPort.toLinkable;
            
            mainPort.fromLinkable = true;
            
            (this as any).startPort = mainPort;
            (this as any).originalFromPort = mainPort;
            (this as any).fromPort = mainPort;
            
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

    // 恢复主节点端口状态
    const originalDoDeactivate = linkingTool.doDeactivate;
    linkingTool.doDeactivate = function() {
      const mainPort = (this as any)._tempMainPort;
      if (mainPort) {
        mainPort.fromLinkable = (this as any)._savedFromLinkable;
        mainPort.toLinkable = (this as any)._savedToLinkable;
        (this as any)._tempMainPort = null;
      }
      (this as any)._originNode = null;
      originalDoDeactivate.call(this);
    };
    
    // 禁止自连接
    const originalIsValidLink = linkingTool.isValidLink;
    linkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      if (fromNode === toNode) return false;
      return originalIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };
    
    // 配置临时连接线
    linkingTool.temporaryLink = $(go.Link,
      { 
        layerName: "Tool", 
        getLinkPoint: freeAngleLinkPoint,
        curve: go.Link.Bezier
      },
      $(go.Shape, { 
        stroke: "#78716C", 
        strokeWidth: 6, 
        strokeDashArray: [4, 4],
        strokeCap: "round",
        strokeJoin: "round"
      }),
      $(go.Shape, { 
        toArrow: "Standard",
        fill: "#78716C",
        stroke: "#78716C",
        strokeWidth: 7,
        strokeCap: "round",
        strokeJoin: "round",
        scale: 0.9,
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      })
    );
    
    (linkingTool as any).temporaryFromSpot = go.Spot.AllSides;
    (linkingTool as any).temporaryToSpot = go.Spot.AllSides;
  }
  
  /**
   * 配置 RelinkingTool
   */
  private configureRelinkingTool(
    diagram: go.Diagram,
    allowedPortIds: string[],
    linkStyleConfig: LinkStyleConfig,
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    pointerTolerance: number,
    $: any
  ): void {
    const relinkingTool = diagram.toolManager.relinkingTool;
    const linkingTool = diagram.toolManager.linkingTool;
    const radiusSquared = linkStyleConfig.captureRadius * linkStyleConfig.captureRadius;
    
    // 禁止自连接
    const originalRelinkIsValidLink = relinkingTool.isValidLink;
    relinkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      if (fromNode === toNode) return false;
      return originalRelinkIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };
    
    // 辅助函数
    const getNodeBodyBounds = (node: go.Node): go.Rect | null => {
      const bodyPanel = node.findObject("BODY") as go.Panel;
      if (bodyPanel) {
        const panelBounds = bodyPanel.getDocumentBounds();
        if (panelBounds.isReal()) return panelBounds;
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
      if (mainPort && (mainPort as any).toLinkable) return mainPort;
      return null;
    };

    const normalizePort = (port: go.GraphObject | null): go.GraphObject | null => {
      if (!port) return null;
      const node = port.part;
      if (node instanceof go.Node) {
        const portId = port.portId || '';
        if (portId === "") return (port as any).toLinkable ? port : getMainPort(node);
        if (allowedPortIds.includes(portId)) return getMainPort(node) || port;
      }
      return port;
    };

    const findNodeNearPointer = (tool: go.LinkingTool, fromEnd: boolean): go.Node | null => {
      const dia = tool.diagram;
      const pointer = dia?.lastInput?.documentPoint;
      if (!dia || !pointer) return null;
      const toolAny = tool as any;
      const excludeNode = fromEnd
        ? (toolAny.toNode || toolAny.originalToNode)
        : (toolAny.fromNode || toolAny.originalFromNode || toolAny.temporaryLink?.fromNode || toolAny._originNode);
      
      const directParts = dia.findPartsAt(pointer, true);
      let found: go.Node | null = null;
      directParts.each((part: go.Part) => {
        if (!found && part instanceof go.Node && isRealNode(part, excludeNode) && isPointerNearBody(part, pointer, pointerTolerance)) {
          found = part;
        }
      });
      if (found) return found;
      
      const searchRect = new go.Rect(
        pointer.x - linkStyleConfig.captureRadius,
        pointer.y - linkStyleConfig.captureRadius,
        linkStyleConfig.captureRadius * 2,
        linkStyleConfig.captureRadius * 2
      );
      let closest: go.Node | null = null;
      let closestDist = Number.POSITIVE_INFINITY;
      dia.findPartsIn(searchRect, true, true).each((part: go.Part) => {
        if (!(part instanceof go.Node) || !isRealNode(part, excludeNode)) return;
        if (!isPointerNearBody(part, pointer, pointerTolerance)) return;
        const dist = distanceToBodySquared(part, pointer);
        if (dist <= radiusSquared && dist < closestDist) {
          closestDist = dist;
          closest = part;
        }
      });
      if (closest) return closest;
      
      dia.nodes.each((node: go.Node) => {
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

    // 增强 findTargetPort
    const enhanceTargetFinding = (tool: go.LinkingTool, original: go.LinkingTool['findTargetPort']): void => {
      tool.findTargetPort = function(fromEnd: boolean) {
        const node = findNodeNearPointer(this, fromEnd);
        const directPort = getMainPort(node);
        
        const toolAny = this as any;
        const originNode = toolAny.fromNode || toolAny.originalFromNode || toolAny.temporaryLink?.fromNode || toolAny._originNode;
        if (node && originNode && node === originNode) return null;
        
        if (directPort) return directPort;
        return normalizePort(original.call(this, fromEnd));
      };
    };

    enhanceTargetFinding(linkingTool, linkingTool.findTargetPort);
    enhanceTargetFinding(
      relinkingTool as unknown as go.LinkingTool,
      relinkingTool.findTargetPort as unknown as go.LinkingTool['findTargetPort']
    );
    
    // 端口引力
    const portGravity = Math.max(4, pointerTolerance * 2);
    linkingTool.portGravity = portGravity;
    (relinkingTool as any).portGravity = portGravity;
    
    // 重连手柄
    relinkingTool.fromHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(14, 14),
      fill: "#8b5cf6",
      stroke: "#6d28d9",
      strokeWidth: 2,
      cursor: "pointer",
      segmentIndex: 0
    });
    
    relinkingTool.toHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(14, 14),
      fill: "#8b5cf6",
      stroke: "#6d28d9",
      strokeWidth: 2,
      cursor: "pointer",
      segmentIndex: -1
    });
    
    // 临时连接线
    relinkingTool.temporaryLink = $(go.Link,
      { 
        layerName: "Tool", 
        getLinkPoint: freeAngleLinkPoint,
        curve: go.Link.Bezier
      },
      $(go.Shape, { 
        stroke: "#78716C", 
        strokeWidth: 6, 
        strokeDashArray: [4, 4],
        strokeCap: "round",
        strokeJoin: "round"
      }),
      $(go.Shape, { 
        toArrow: "Standard",
        fill: "#78716C",
        stroke: "#78716C",
        strokeWidth: 7,
        strokeCap: "round",
        strokeJoin: "round",
        scale: 0.9,
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      })
    );
  }
  
  /**
   * 创建跨树连接标签面板
   * 
   * 设计说明（类似维基百科悬浮预览）：
   * - 默认只显示标题（title）或截断的描述
   * - 鼠标悬停时只显示描述内容（不含标题）
   * - 悬停提示位置自动适应，避免遮挡节点
   * - 点击时打开完整编辑器
   */
  private createConnectionLabelPanel($: any): go.Panel {
    const isMobile = this.store.isMobile();
    
    // 创建悬停提示（仅桌面端，移动端不显示 tooltip）
    // 智能定位：基于连接线角度决定 Tooltip 位置（O(1) 操作，无节点遍历）
    const createTooltip = () => {
      if (isMobile) return undefined;
      
      return $(go.Adornment, "Auto",
        {
          background: null,
          isShadowed: true,
          shadowOffset: new go.Point(0, 2),
          shadowColor: "rgba(0, 0, 0, 0.12)"
        },
        // 基于连接线角度智能定位 Tooltip
        // - 水平连接线（0-45° 或 135-180°）：Tooltip 向上偏移
        // - 垂直连接线（45-135°）：Tooltip 向右偏移
        new go.Binding("segmentOffset", "", (_data: unknown, obj: go.GraphObject) => {
          const adornment = obj.part;
          if (!adornment || !(adornment instanceof go.Adornment)) {
            return new go.Point(0, -25);
          }
          const link = adornment.adornedPart;
          if (!link || !(link instanceof go.Link)) {
            return new go.Point(0, -25);
          }
          // 获取连接线中点角度（O(1) 几何计算）
          const midAngle = link.midAngle;
          // 归一化到 0-180° 简化判断
          const normalized = Math.abs(midAngle % 180);
          
          if (normalized > 45 && normalized < 135) {
            // 垂直连接线 → 向右偏移，避免遮挡节点
            return new go.Point(25, 0);
          } else {
            // 水平连接线 → 向上偏移
            return new go.Point(0, -25);
          }
        }).ofObject(),
        $(go.Shape, "RoundedRectangle", {
          fill: "rgba(255, 255, 255, 0.98)",
          stroke: "#a78bfa",
          strokeWidth: 1,
          parameter1: 5
        }),
        $(go.TextBlock, {
          font: "10px \"LXGW WenKai Screen\", sans-serif",
          stroke: "#525252",
          margin: 8,
          maxSize: new go.Size(180, 120),
          overflow: go.TextBlock.OverflowEllipsis,
          wrap: go.TextBlock.WrapFit
        },
        new go.Binding("text", "description", (desc: string) => desc || "暂无描述"))
      );
    };
    
    return $(go.Panel, "Auto",
      {
        segmentIndex: NaN,
        segmentFraction: 0.5,
        cursor: "pointer",
        isActionable: true,
        background: "transparent",
        // 悬停提示 - 只显示描述内容
        toolTip: createTooltip(),
        // 事件代理：点击时通过全局事件总线发送信号（使用 any 类型）
        click: (e: any, obj: any) => {
          const link = obj?.part;
          if (!link?.data?.isCrossTree) return;
          e.handled = true;
          // 获取视图坐标用于定位编辑器
          const viewX = e.viewPoint?.x ?? 0;
          const viewY = e.viewPoint?.y ?? 0;
          flowTemplateEventHandlers.onCrossTreeLabelClick?.(link, viewX, viewY);
        }
      },
      new go.Binding("visible", "isCrossTree"),
      $(go.Shape, "RoundedRectangle", {
        fill: "#f5f3ff",
        stroke: "#8b5cf6",
        strokeWidth: 1,
        parameter1: 4,
        cursor: "pointer",
        isActionable: true
      }),
      $(go.Panel, "Horizontal",
        { margin: isMobile ? 4 : 3, defaultAlignment: go.Spot.Center, cursor: "pointer", isActionable: true },
        $(go.TextBlock, "🔗", { 
          font: `${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`, 
          cursor: "pointer", 
          isActionable: true 
        }),
        $(go.TextBlock, {
          font: `500 ${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`,
          stroke: "#6d28d9",
          maxSize: new go.Size(isMobile ? 60 : 50, 14),
          overflow: go.TextBlock.OverflowEllipsis,
          margin: new go.Margin(0, 0, 0, 2),
          cursor: "pointer",
          isActionable: true
        },
        // 优先显示 title，若无则显示截断的 description
        new go.Binding("text", "", (data: any) => {
          if (data.title) return data.title.substring(0, 8);
          if (data.description) return data.description.substring(0, 6);
          return "...";
        }))
      )
    );
  }
  
  // ========== Overview 模板 ==========
  
  /**
   * 设置 Overview 节点模板（热力图效果）
   */
  setupOverviewNodeTemplate(overview: go.Overview): void {
    const $ = go.GraphObject.make;
    const styles = this.configService.currentStyles();
    
    overview.nodeTemplate = $(go.Node, "Spot",
      {
        locationSpot: go.Spot.Center,
        minSize: new go.Size(4, 4)
      },
      new go.Binding("location", "loc", go.Point.parse),
      $(go.Shape, "Rectangle",
        {
          name: "SHAPE",
          height: 80,
          strokeWidth: 3,
          opacity: 1
        },
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) =>
          isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH
        ),
        new go.Binding("fill", "color", (color: string) => color || "#ffffff"),
        new go.Binding("stroke", "borderColor", (color: string) => color || styles.node.defaultBorder)
      )
    );
    
    this.logger.debug('Overview 节点模板已设置');
  }
  
  /**
   * 设置 Overview 连接线模板
   */
  setupOverviewLinkTemplate(overview: go.Overview): void {
    const $ = go.GraphObject.make;
    const styles = this.configService.currentStyles();
    
    overview.linkTemplate = $(go.Link,
      {
        routing: go.Link.Normal,
        curve: go.Link.None
      },
      $(go.Shape,
        {
          strokeWidth: 12,
          opacity: 0.8
        },
        new go.Binding("stroke", "isCrossTree", (isCrossTree: boolean) =>
          isCrossTree ? styles.link.crossTreeColor : styles.link.parentChildColor
        )
      )
    );
    
    this.logger.debug('Overview 连接线模板已设置');
  }
  
  /**
   * 设置 Overview 视口框样式
   * @param overview Overview 实例
   * @param _isMobile 是否为移动端（保留参数以保持接口兼容性）
   */
  setupOverviewBoxStyle(overview: go.Overview, _isMobile: boolean = false): void {
    const box = overview.box;
    if (box && box.elt(0)) {
      const shape = box.elt(0) as go.Shape;
      
      // 统一使用 2px 边框宽度
      // 由于现在所有设备都使用实际的 devicePixelRatio，边框会自动清晰
      shape.strokeWidth = 2;
      
      // 使用更明显的白色边框
      shape.stroke = "#ffffff";
      
      // 半透明白色填充
      shape.fill = "rgba(255, 255, 255, 0.15)";
    }
  }
  
  getLinkCurveConfig(): { curve: typeof go.Link.Bezier; curviness: number } {
    return {
      curve: go.Link.Bezier,
      curviness: 20
    };
  }
}
