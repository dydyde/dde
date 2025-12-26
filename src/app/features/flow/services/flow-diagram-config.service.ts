import { Injectable, inject, computed } from '@angular/core';
import { ThemeService } from '../../../../services/theme.service';
import { getFlowStyles, FlowStyleConfig, FlowTheme } from '../../../../config/flow-styles';
import { GOJS_CONFIG, SUPERSCRIPT_DIGITS } from '../../../../config/constants';
import { Task, Project } from '../../../../models';
import { LineageColorService } from '../../../../services/lineage-color.service';
import * as go from 'gojs';

/**
 * GoJS 节点数据结构
 */
export interface GoJSNodeData {
  key: string;
  title: string;
  displayId: string;
  stage: number | null;
  loc: string;
  color: string;
  borderColor: string;
  borderWidth: number;
  titleColor: string;
  displayIdColor: string;
  selectedBorderColor: string;
  isUnassigned: boolean;
  isSearchMatch: boolean;
  isSelected: boolean;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
}

/**
 * GoJS 连接数据结构
 */
export interface GoJSLinkData {
  key: string;
  from: string;
  to: string;
  isCrossTree: boolean;
  /** 联系块标题（外显内容） */
  title?: string;
  /** 联系块详细描述 */
  description?: string;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
}

/**
 * GoJS 图表数据
 */
export interface GoJSDiagramData {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}

/**
 * 流程图配置服务
 * 
 * 职责：
 * - 提供 GoJS 节点和连接线模板配置
 * - 构建图表数据（从任务数据转换为 GoJS 数据）
 * - 管理主题样式
 * 
 * 设计原则：
 * - 纯配置和数据转换逻辑，不持有 GoJS Diagram 实例
 * - 所有配置集中在此处，FlowViewComponent 只负责视图交互
 * - 可独立测试
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramConfigService {
  private readonly themeService = inject(ThemeService);
  private readonly lineageColorService = inject(LineageColorService);
  
  /** 当前主题样式配置（响应式） */
  readonly currentStyles = computed(() => {
    const theme = this.themeService.theme() as FlowTheme;
    return getFlowStyles(theme);
  });
  
  // ========== 图表配置常量 ==========
  
  /** 布局配置 */
  readonly layoutConfig = {
    layerSpacing: GOJS_CONFIG.LAYER_SPACING,
    columnSpacing: GOJS_CONFIG.COLUMN_SPACING,
    scrollMargin: GOJS_CONFIG.SCROLL_MARGIN
  } as const;
  
  /** 节点配置 */
  readonly nodeConfig = {
    unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH,
    assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH,
    cornerRadius: 10,
    portSize: GOJS_CONFIG.PORT_SIZE
  } as const;
  
  /** 连接线配置 */
  readonly linkConfig = {
    cornerRadius: 20,  // 增加圆角
    toShortLength: 5,  // 减小偏移量，让箭头更贴近目标节点（之前 10 太大会导致箭头角度计算问题）
    curviness: NaN,    // NaN = 让 GoJS 自动计算最佳曲率，避免固定值导致控制点异常
    mobileStrokeWidth: 24,   // 移动端透明触控区域
    desktopStrokeWidth: 14,  // 桌面端透明触控区域
    visibleStrokeWidth: 6,   // 可见线条粗度：增加至6使其更明显
    arrowType: "Standard",   // 实心三角箭头
    arrowScale: 0.9,         // 调小补偿粗描边带来的视觉膨胀
    arrowStrokeWidth: 7      // 粗描边让 strokeJoin: round 生效，呈现圆角效果
  } as const;

  // ========== 数据构建方法 ==========
  
  /**
   * 从任务列表构建 GoJS 图表数据
   * @param tasks 任务列表
   * @param project 当前项目（用于获取连接信息）
   * @param searchQuery 搜索关键词（用于高亮）
   * @param existingNodeMap 现有节点数据映射（用于保持位置）
   */
  buildDiagramData(
    tasks: Task[],
    project: Project,
    searchQuery: string,
    existingNodeMap: Map<string, any>
  ): GoJSDiagramData {
    const styles = this.currentStyles();
    const nodeDataArray: GoJSNodeData[] = [];
    const linkDataArray: GoJSLinkData[] = [];
    
    // 构建父子关系集合
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    // 过滤显示的任务：只排除已归档的任务
    // 待分配任务（stage === null）也应该显示，不应该因为坐标为(0,0)而被过滤
    const tasksToShow = tasks.filter(t => t.status !== 'archived');
    
    let newNodeIndex = 0;
    const searchLower = searchQuery.toLowerCase().trim();
    
    for (const task of tasksToShow) {
      // 计算节点位置
      const loc = this.computeNodeLocation(task, existingNodeMap, newNodeIndex);
      if (!existingNodeMap.has(task.id) && task.x === 0 && task.y === 0) {
        newNodeIndex++;
      }
      
      // 检查是否匹配搜索
      const isSearchMatch = this.isTaskSearchMatch(task, searchLower);
      
      // 计算节点颜色
      const { nodeColor, borderColor, borderWidth, titleColor } = 
        this.computeNodeColors(task, isSearchMatch, styles);
      
      nodeDataArray.push({
        key: task.id,
        title: task.title || '未命名任务',
        displayId: this.compressDisplayId(task.displayId),
        stage: task.stage,
        loc,
        color: nodeColor,
        borderColor,
        borderWidth,
        titleColor,
        displayIdColor: styles.text.displayIdColor,
        selectedBorderColor: styles.node.selectedBorder,
        isUnassigned: task.stage === null,
        isSearchMatch,
        isSelected: false
      });
      
      // 添加父子连接
      if (task.parentId) {
        linkDataArray.push({
          key: `${task.parentId}-${task.id}`,
          from: task.parentId,
          to: task.id,
          isCrossTree: false
        });
      }
    }
    
    // 添加跨树连接（过滤掉已软删除的连接）
    for (const conn of project.connections) {
      // 跳过已软删除的连接
      if (conn.deletedAt) continue;
      
      const pairKey = `${conn.source}->${conn.target}`;
      if (!parentChildPairs.has(pairKey)) {
        const sourceExists = tasksToShow.some(t => t.id === conn.source);
        const targetExists = tasksToShow.some(t => t.id === conn.target);
        if (sourceExists && targetExists) {
          linkDataArray.push({
            key: `cross-${conn.source}-${conn.target}`,
            from: conn.source,
            to: conn.target,
            isCrossTree: true,
            title: conn.title || '',
            description: conn.description || ''
          });
        }
      }
    }
    
    // ========== 血缘追溯预处理 ==========
    // 在数据加载进 GoJS Model 之前，为每个节点和连线注入始祖信息和家族颜色
    // 这是"领地热力图"效果的数据基础
    const enhancedData = this.lineageColorService.preprocessDiagramData(
      nodeDataArray,
      linkDataArray,
      tasksToShow
    );
    
    return enhancedData;
  }
  
  /**
   * 计算节点位置
   */
  private computeNodeLocation(
    task: Task,
    existingNodeMap: Map<string, any>,
    newNodeIndex: number
  ): string {
    const existingNode = existingNodeMap.get(task.id);
    
    if (existingNode?.loc) {
      // 优先保持现有位置
      return existingNode.loc;
    } else if (task.x !== 0 || task.y !== 0) {
      // 使用 store 中保存的位置
      return `${task.x} ${task.y}`;
    } else {
      // 新节点：根据阶段和顺序计算初始位置
      const stageX = ((task.stage || 1) - 1) * 150;
      const indexY = newNodeIndex * 100;
      return `${stageX} ${indexY}`;
    }
  }
  
  /**
   * 检查任务是否匹配搜索
   */
  private isTaskSearchMatch(task: Task, searchLower: string): boolean {
    if (!searchLower) return false;
    
    return (
      task.title.toLowerCase().includes(searchLower) ||
      task.content.toLowerCase().includes(searchLower) ||
      task.displayId.toLowerCase().includes(searchLower) ||
      (task.attachments?.some(a => a.name.toLowerCase().includes(searchLower)) ?? false) ||
      (task.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ?? false)
    );
  }
  
  /**
   * 计算节点颜色
   */
  private computeNodeColors(
    task: Task,
    isSearchMatch: boolean,
    styles: FlowStyleConfig
  ): {
    nodeColor: string;
    borderColor: string;
    borderWidth: number;
    titleColor: string;
  } {
    if (isSearchMatch) {
      return {
        nodeColor: styles.node.searchHighlightBackground,
        borderColor: styles.node.searchHighlightBorder,
        borderWidth: 2,
        titleColor: styles.text.titleColor
      };
    } else if (task.stage === null) {
      return {
        nodeColor: styles.node.unassignedBackground,
        borderColor: styles.node.unassignedBorder,
        borderWidth: 2,
        titleColor: styles.text.unassignedTitleColor
      };
    } else if (task.status === 'completed') {
      return {
        nodeColor: styles.node.completedBackground,
        borderColor: styles.node.defaultBorder,
        borderWidth: 1,
        titleColor: styles.text.titleColor
      };
    } else {
      return {
        nodeColor: styles.node.background,
        borderColor: styles.node.defaultBorder,
        borderWidth: 1,
        titleColor: styles.text.titleColor
      };
    }
  }
  
  /**
   * 压缩 displayId 显示（如 A,A,A,A,A → A⁵）
   */
  private compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;
    
    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;
    
    while (i < parts.length) {
      const current = parts[i];
      let count = 1;
      
      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }
      
      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d] || d).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }
      
      i += count;
    }
    
    return result.join(',');
  }
  
  // ========== 模板工厂方法 ==========

  /**
   * 创建端口
   * 使用圆点端口，悬停时显示边框发光效果
   * 
   * 设计原则：
   * - 端口仅作为交互手柄（UI Handle），不参与连接线锚点计算
   * - fromSpot/toSpot 设为 None，避免在端口微小边界上计算
   * - 实际锚点由主节点 + getLinkPoint 在节点边界（Perimeter）上计算
   */
  createPort($: any, name: string, spot: go.Spot, output: boolean, input: boolean, isMobile: boolean = false): go.Shape {
    const portSize = isMobile ? 24 : 8;  // 移动端增大到 24px 便于触摸
    
    return $(go.Shape, "Circle", {
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: isMobile ? 3 : 2,  // 移动端加粗边框
      desiredSize: new go.Size(portSize, portSize),
      alignment: spot,
      alignmentFocus: spot,
      portId: name,
      fromLinkable: output,
      toLinkable: input,
      cursor: "pointer",
      // ========== 关键：端口不设置 Spot ==========
      // 让连接线锚点在主节点边界计算，而不是在端口边界
      fromSpot: go.Spot.None,
      toSpot: go.Spot.None,
      // 鼠标悬停时显示边框发光
      mouseEnter: (e: any, port: go.Shape) => {
        if (e.diagram.isReadOnly) return;
        port.stroke = "#6366f1";
        port.fill = "rgba(99, 102, 241, 0.15)";
      },
      mouseLeave: (e: any, port: go.Shape) => {
        port.stroke = "transparent";
        port.fill = "transparent";
      }
    });
  }
  
  /**
   * 获取节点主面板配置
   */
  getNodeMainPanelConfig($: any): go.Panel {
    return $(go.Panel, "Auto",
      new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
        isUnassigned ? this.nodeConfig.unassignedWidth : this.nodeConfig.assignedWidth),
      $(go.Shape, "RoundedRectangle", {
        fill: "white",
        stroke: "#e7e5e4",
        strokeWidth: 1,
        parameter1: this.nodeConfig.cornerRadius,
        portId: "",              // 主体端口（用于连接线终点计算）
        fromLinkable: false,     // 不直接从主体拉线（由边缘小圆点触发后切换）
        toLinkable: true,        // 允许连接到主体（配合 findTargetPort 实现边界吸附）
        cursor: "move",
        fromSpot: go.Spot.AllSides,  // Perimeter Intersection：动态计算边界交点
        toSpot: go.Spot.AllSides     // 让连接线像水珠一样沿边界滑动
      },
      new go.Binding("fill", "color"),
      new go.Binding("stroke", "", (data: any, obj: any) => {
        if (obj.part.isSelected) return data.selectedBorderColor || "#0d9488";
        return data.borderColor || "#e7e5e4";
      }).ofObject(),
      new go.Binding("strokeWidth", "borderWidth")),
      
      $(go.Panel, "Vertical",
        new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
        $(go.TextBlock, { font: "bold 9px 'LXGW WenKai Screen', sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
          new go.Binding("text", "displayId"),
          new go.Binding("stroke", "displayIdColor"),
          new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
        $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px 'LXGW WenKai Screen', sans-serif", stroke: "#57534e" },
          new go.Binding("text", "title"),
          new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => 
            isUnassigned ? "500 11px 'LXGW WenKai Screen', sans-serif" : "400 12px 'LXGW WenKai Screen', sans-serif"),
          new go.Binding("stroke", "titleColor"),
          new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => 
            isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
      )
    );
  }
  
  /**
   * 获取连接线主体配置
   * 
   * 视觉设计：
   * - 父子连线使用血缘追溯的家族颜色（familyColor）
   * - 跨树连线保持紫色虚线样式以区分
   * - 颜色来源于数据预处理阶段注入的 familyColor 属性
   */
  getLinkMainShapesConfig($: any, isMobile: boolean): go.Shape[] {
    const styles = this.currentStyles();
    
    return [
      // 透明粗线便于选择（触控区域）
      $(go.Shape, { 
        isPanelMain: true, 
        strokeWidth: isMobile ? this.linkConfig.mobileStrokeWidth : this.linkConfig.desktopStrokeWidth, 
        stroke: "transparent",
        strokeCap: "round",
        strokeJoin: "round"
      }),
      // 可见线 - 使用家族颜色（血缘聚类）
      $(go.Shape, { 
        isPanelMain: true,   // 标记为主路径线，让 GoJS 正确计算曲线路径
        strokeWidth: this.linkConfig.visibleStrokeWidth,
        strokeCap: "round",  // 线端圆润（解决锐度问题）
        strokeJoin: "round"  // 拐角圆润
      },
        // 绑定血缘家族颜色，跨树连线保持紫色
        new go.Binding("stroke", "", (data: any) => {
          if (data.isCrossTree) return styles.link.crossTreeColor; // 使用主题定义的跨树连线颜色
          return data.familyColor || styles.link.parentChildColor; // 优先使用血缘颜色，否则使用主题定义的父子颜色
        }),
        new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 10] : null)),
      // 箭头 - 使用粗描边 + strokeJoin: round 实现圆角效果
      // ========== 圆角箭头核心原理 ==========
      // 1. toArrow: "Standard" 是实心三角的几何基础
      // 2. fill 和 stroke 必须一致，才能看起来是纯色填充
      // 3. strokeWidth 要足够大（3-5），让 strokeJoin: round 有足够空间画出圆弧
      // 4. scale 调小补偿粗描边带来的视觉膨胀
      $(go.Shape, { 
        toArrow: this.linkConfig.arrowType,
        scale: this.linkConfig.arrowScale,
        strokeWidth: this.linkConfig.arrowStrokeWidth,
        strokeCap: "round",
        strokeJoin: "round",                  // 关键：让箭头三角顶点变圆润
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      },
        // 箭头填充色
        new go.Binding("fill", "", (data: any) => {
          if (data.isCrossTree) return styles.link.crossTreeColor;
          return data.familyColor || styles.link.parentChildColor;
        }),
        // 箭头描边色 - 必须与 fill 一致才能形成完整的圆角填充效果
        new go.Binding("stroke", "", (data: any) => {
          if (data.isCrossTree) return styles.link.crossTreeColor;
          return data.familyColor || styles.link.parentChildColor;
        }))
    ];
  }
  
  /**
   * 获取联系块标签配置
   */
  getConnectionLabelConfig($: any): go.Panel {
    return $(go.Panel, "Auto", {
      segmentIndex: NaN,
      segmentFraction: 0.5,
      cursor: "pointer"
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
      $(go.TextBlock, "🔗", { font: "8px 'LXGW WenKai Screen', sans-serif" }),
      $(go.TextBlock, {
        font: "500 8px 'LXGW WenKai Screen', sans-serif",
        stroke: "#6d28d9",
        maxSize: new go.Size(50, 14),
        overflow: go.TextBlock.OverflowEllipsis,
        margin: new go.Margin(0, 0, 0, 2)
      },
      new go.Binding("text", "description", (desc: string) => desc ? desc.substring(0, 6) : "..."))
    ));
  }
}
