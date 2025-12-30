/**
 * GoJS 边界类型定义
 * 
 * "边境检查站"策略：
 * - 对外严格：业务数据进入 GoJS 之前必须是强类型接口
 * - 对内宽容：GoJS 内部操作允许使用 any 或简单类型断言
 * 
 * 这个文件定义了业务层与 GoJS 层之间的数据转换接口
 */

import * as go from 'gojs';
import { Task, Connection } from './index';

// ============================================
// 业务层 -> GoJS 层的数据转换接口
// ============================================

/**
 * GoJS 节点数据（用于 nodeDataArray）
 * 这是从业务 Task 转换后的 GoJS 可用格式
 */
export interface GojsNodeData {
  /** 节点唯一标识，对应 Task.id */
  key: string;
  /** 显示标题 */
  title: string;
  /** 显示 ID (如 "1,a") */
  displayId: string;
  /** 阶段编号 */
  stage: number | null;
  /** GoJS 位置字符串 "x y" */
  loc: string;
  /** 节点背景色 */
  color: string;
  /** 边框颜色 */
  borderColor: string;
  /** 边框宽度 */
  borderWidth: number;
  /** 标题文字颜色 */
  titleColor: string;
  /** displayId 文字颜色 */
  displayIdColor: string;
  /** 选中时的边框颜色 */
  selectedBorderColor: string;
  /** 是否为未分配任务 */
  isUnassigned: boolean;
  /** 是否匹配当前搜索 */
  isSearchMatch: boolean;
  /** 选中状态（由 GoJS 管理） */
  isSelected: boolean;
}

/**
 * GoJS 连接线数据（用于 linkDataArray）
 */
export interface GojsLinkData {
  /** 连接唯一标识 */
  key: string;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 是否为跨树连接（虚线显示） */
  isCrossTree: boolean;
  /** 连接描述（仅跨树连接有） */
  description?: string;
}

/**
 * GoJS 图表数据包
 */
export interface GojsDiagramData {
  nodeDataArray: GojsNodeData[];
  linkDataArray: GojsLinkData[];
}

// ============================================
// 数据转换函数
// ============================================

/**
 * 将业务 Task 转换为 GoJS 节点数据
 * 这是"边境检查站"的入口函数
 */
export function taskToGojsNode(
  task: Task,
  config: {
    existingLoc?: string;
    styles: {
      nodeBackground: string;
      borderColor: string;
      borderWidth: number;
      titleColor: string;
      displayIdColor: string;
      selectedBorderColor: string;
    };
    isSearchMatch: boolean;
    compressDisplayId: (id: string) => string;
  }
): GojsNodeData {
  // 计算位置
  let loc: string;
  if (config.existingLoc) {
    loc = config.existingLoc;
  } else if (task.x !== 0 || task.y !== 0) {
    loc = `${task.x} ${task.y}`;
  } else {
    // 默认位置
    const stageX = ((task.stage || 1) - 1) * 150;
    loc = `${stageX} 0`;
  }

  return {
    key: task.id,
    title: task.title || '未命名任务',
    displayId: config.compressDisplayId(task.displayId),
    stage: task.stage,
    loc,
    color: config.styles.nodeBackground,
    borderColor: config.styles.borderColor,
    borderWidth: config.styles.borderWidth,
    titleColor: config.styles.titleColor,
    displayIdColor: config.styles.displayIdColor,
    selectedBorderColor: config.styles.selectedBorderColor,
    isUnassigned: task.stage === null,
    isSearchMatch: config.isSearchMatch,
    isSelected: false
  };
}

/**
 * 将业务 Connection 转换为 GoJS 连接线数据
 */
export function connectionToGojsLink(
  conn: Connection,
  isCrossTree: boolean
): GojsLinkData {
  return {
    key: isCrossTree ? `cross-${conn.source}-${conn.target}` : `${conn.source}-${conn.target}`,
    from: conn.source,
    to: conn.target,
    isCrossTree,
    description: conn.description || ''
  };
}

/**
 * 从父子关系创建 GoJS 连接线数据
 */
export function parentChildToGojsLink(
  parentId: string,
  childId: string
): GojsLinkData {
  return {
    key: `${parentId}-${childId}`,
    from: parentId,
    to: childId,
    isCrossTree: false
  };
}

// ============================================
// GoJS 事件数据类型（从 GoJS 出来的数据）
// ============================================

/**
 * GoJS 节点移动事件数据
 * 从 GoJS 事件中提取的位置信息
 */
export interface GojsNodeMoveData {
  taskId: string;
  x: number;
  y: number;
}

/**
 * 从 GoJS Part 提取移动数据
 * 这是"边境检查站"的出口函数
 * 
 * @param part GoJS Part 对象
 */
export function extractNodeMoveData(part: go.Part): GojsNodeMoveData | null {
  if (!part?.data?.key || !part.location) {
    return null;
  }
  
  const loc = part.location;
  return {
    taskId: part.data.key,
    x: loc.x,
    y: loc.y
  };
}

/**
 * GoJS 连接创建事件数据
 */
export interface GojsLinkCreateData {
  sourceId: string;
  targetId: string;
  midPoint?: { x: number; y: number };
}

/**
 * 从 GoJS Link 提取连接数据
 */
export function extractLinkCreateData(link: go.Link): GojsLinkCreateData | null {
  const fromNode = link?.fromNode;
  const toNode = link?.toNode;
  const sourceId = fromNode?.data?.key;
  const targetId = toNode?.data?.key;
  
  if (!sourceId || !targetId || sourceId === targetId) {
    return null;
  }
  
  const midPoint = link.midPoint;
  
  return {
    sourceId,
    targetId,
    midPoint: midPoint ? { x: midPoint.x, y: midPoint.y } : undefined
  };
}

/**
 * GoJS 选择变更数据
 */
export interface GojsSelectionData {
  selectedNodeIds: string[];
  selectedLinkKeys: string[];
}

/**
 * 从 GoJS Diagram 提取选择数据
 */
export function extractSelectionData(diagram: go.Diagram): GojsSelectionData {
  const selectedNodeIds: string[] = [];
  const selectedLinkKeys: string[] = [];
  
  if (diagram?.selection) {
    const iterator = diagram.selection.iterator;
    while (iterator.next()) {
      const part = iterator.value;
      if (part.data?.key) {
        // 判断是节点还是连接线
        if (part instanceof go.Link) {
          // 是连接线
          selectedLinkKeys.push(part.data.key);
        } else {
          // 是节点
          selectedNodeIds.push(part.data.key);
        }
      }
    }
  }
  
  return { selectedNodeIds, selectedLinkKeys };
}
