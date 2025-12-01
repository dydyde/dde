import { Injectable, inject, signal, NgZone, computed } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { Task } from '../models';
import { environment } from '../environments/environment';
import { GOJS_CONFIG } from '../config/constants';
import { getFlowStyles, FlowStyleConfig, FlowTheme } from '../config/flow-styles';
import * as go from 'gojs';

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
  private readonly logger = inject(LoggerService).category('GoJSDiagram');
  private readonly zone = inject(NgZone);
  
  private diagram: go.Diagram | null = null;
  private callbacks: DiagramCallbacks | null = null;
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
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
        "scrollMargin": GOJS_CONFIG.SCROLL_MARGIN,
        "draggingTool.isGridSnapEnabled": false
      });
      
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
      // 移除所有事件监听器
      this.diagram.removeDiagramListener('SelectionMoved', () => {});
      this.diagram.removeDiagramListener('PartResized', () => {});
      
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
    
    // 位置更新跳过重建
    const lastUpdateType = this.store.getLastUpdateType();
    if (lastUpdateType === 'position') {
      return;
    }
    
    try {
      // 过滤显示的任务
      const tasksToShow = tasks.filter(t => 
        t.status !== 'archived' && (t.stage != null || (t.x !== 0 || t.y !== 0))
      );
      
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
    
    // 监听节点移动完成
    this.diagram.addDiagramListener('SelectionMoved', (e: any) => {
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
    });
    
    this.diagram.addDiagramListener('PartResized', () => {
      this.saveAllNodePositions();
    });
  }
  
  private createNodeTemplate($: any): go.Node {
    const self = this;
    
    function makePort(name: string, spot: any, output: boolean, input: boolean) {
      return $(go.Shape, "Circle", {
        fill: "transparent",
        stroke: null,
        desiredSize: new go.Size(10, 10),
        alignment: spot,
        alignmentFocus: spot,
        portId: name,
        fromLinkable: output,
        toLinkable: input,
        cursor: "pointer",
        fromSpot: spot,
        toSpot: spot,
        mouseEnter: (e: any, port: any) => { if (!e.diagram.isReadOnly) port.fill = "#a8a29e"; },
        mouseLeave: (e: any, port: any) => port.fill = "transparent"
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
    
    // 主内容面板
    $(go.Panel, "Auto",
      new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
        isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
      $(go.Shape, "RoundedRectangle", {
        fill: "white",
        stroke: "#e7e5e4",
        strokeWidth: 1,
        parameter1: 10,
        portId: "",
        fromLinkable: false,
        toLinkable: false,
        cursor: "move"
      },
      new go.Binding("fill", "color"),
      new go.Binding("stroke", "", (data: any, obj: any) => {
        if (obj.part.isSelected) return data.selectedBorderColor || "#0d9488";
        return data.borderColor || "#e7e5e4";
      }).ofObject(),
      new go.Binding("strokeWidth", "borderWidth")),
      
      $(go.Panel, "Vertical",
        new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
        $(go.TextBlock, { font: "bold 9px sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
          new go.Binding("text", "displayId"),
          new go.Binding("stroke", "displayIdColor"),
          new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
        $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px sans-serif", stroke: "#57534e" },
          new go.Binding("text", "title"),
          new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => 
            isUnassigned ? "500 11px sans-serif" : "400 12px sans-serif"),
          new go.Binding("stroke", "titleColor"),
          new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => 
            isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
      )
    ),
    
    // 端口
    makePort("T", go.Spot.Top, true, true),
    makePort("L", go.Spot.Left, true, true),
    makePort("R", go.Spot.Right, true, true),
    makePort("B", go.Spot.Bottom, true, true)
    );
  }
  
  private createLinkTemplate($: any): go.Link {
    const self = this;
    
    return $(go.Link, {
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
          { click: (e: any, obj: any) => self.deleteLinkFromContext(obj.part) }
        )
      )
    },
    // 透明粗线便于选择
    $(go.Shape, { isPanelMain: true, strokeWidth: self.store.isMobile() ? 16 : 8, stroke: "transparent" }),
    // 可见线
    $(go.Shape, { isPanelMain: true, strokeWidth: 2 },
      new go.Binding("stroke", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8"),
      new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 3] : null)),
    // 箭头
    $(go.Shape, { toArrow: "Standard", stroke: null, scale: 1.2 },
      new go.Binding("fill", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8")),
    // 联系块标签
    $(go.Panel, "Auto", {
      segmentIndex: NaN,
      segmentFraction: 0.5,
      cursor: "pointer",
      click: (e: any, panel: any) => {
        e.handled = true;
        const link = panel.part;
        if (link?.data) {
          const midPoint = link.midPoint;
          self.zone.run(() => {
            self.callbacks?.onConnectionEditorOpen(
              link.data.from,
              link.data.to,
              link.data.description || '',
              midPoint.x,
              midPoint.y
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
      font: "9px sans-serif",
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
