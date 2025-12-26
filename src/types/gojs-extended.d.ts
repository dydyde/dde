/**
 * GoJS 扩展类型定义
 * 
 * GoJS 的官方 TypeScript 类型定义不完整，特别是事件回调和模板配置。
 * 此文件补充常用类型，减少 any 使用。
 * 
 * 使用方式：
 * - 在需要的文件中导入：import type { GoJSNodeData, GoJSLinkData } from '../../types/gojs-extended';
 */

import * as go from 'gojs';

// ========== 节点数据类型 ==========

/**
 * GoJS 节点数据对象（存储在 Model 中）
 */
export interface GoJSNodeData {
  /** 节点唯一标识（对应 Task.id） */
  key: string;
  /** 任务标题 */
  title: string;
  /** 显示 ID（如 "1", "1,a"） */
  displayId: string;
  /** 短 ID（如 "NF-A1B2"） */
  shortId?: string;
  /** 阶段编号 */
  stage: number | null;
  /** 父节点 ID */
  parentId: string | null;
  /** 任务状态 */
  status: 'active' | 'completed' | 'archived';
  /** X 坐标 */
  x: number;
  /** Y 坐标 */
  y: number;
  /** 排序权重 */
  rank: number;
  /** 是否有未完成的子任务 */
  hasIncompleteTask?: boolean;
  /** 是否在未分配区 */
  isUnassigned?: boolean;
  /** 节点宽度（布局计算用） */
  width?: number;
  /** 节点高度（布局计算用） */
  height?: number;
}

/**
 * GoJS 连接线数据对象（存储在 Model 中）
 */
export interface GoJSLinkData {
  /** 连接线唯一标识 */
  key: string;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 连接类型 */
  category?: 'parent-child' | 'cross-tree';
  /** 连接描述（用于联系块） */
  description?: string;
  /** 是否已删除 */
  deletedAt?: string | null;
  /** 是否为跨树连接（运行时计算） */
  isCrossTree?: boolean;
  /** 连接标题（运行时使用） */
  title?: string;
  /** 允许额外属性 */
  [key: string]: unknown;
}

// ========== 事件相关类型 ==========

/**
 * GoJS 节点对象（运行时 Part 实例）
 */
export interface GoJSNode extends go.Part {
  data: GoJSNodeData;
}

/**
 * GoJS 连接线对象（运行时 Link 实例）
 */
export interface GoJSLink extends go.Link {
  data: GoJSLinkData;
}

/**
 * GoJS 输入事件（鼠标/触摸）
 */
export interface GoJSInputEvent {
  /** 事件对应的图表 */
  diagram: go.Diagram;
  /** 文档坐标 */
  documentPoint: go.Point;
  /** 视口坐标 */
  viewPoint: go.Point;
  /** 是否 Shift 键按下 */
  shift: boolean;
  /** 是否 Ctrl 键按下 */
  control: boolean;
  /** 是否 Alt 键按下 */
  alt: boolean;
  /** 点击次数 */
  clickCount: number;
  /** 是否已处理 */
  handled: boolean;
  /** 原始 DOM 事件 */
  event?: MouseEvent | TouchEvent;
}

/**
 * GoJS Diagram 事件对象
 */
export interface GoJSDiagramEvent {
  /** 事件名称 */
  name: string;
  /** 事件对应的图表 */
  diagram: go.Diagram;
  /** 事件主题（可能是 Part、Link、Selection 等） */
  subject: go.Set<go.Part> | go.Part | go.Link | null;
  /** 事件参数 */
  parameter?: unknown;
}

/**
 * 选择变更事件
 */
export interface GoJSSelectionChangedEvent extends GoJSDiagramEvent {
  name: 'ChangedSelection';
  subject: go.Set<go.Part>;
}

/**
 * 视口变更事件
 */
export interface GoJSViewportBoundsChangedEvent extends GoJSDiagramEvent {
  name: 'ViewportBoundsChanged';
  subject: null;
}

/**
 * 文档边界变更事件
 */
export interface GoJSDocumentBoundsChangedEvent extends GoJSDiagramEvent {
  name: 'DocumentBoundsChanged';
  subject: null;
}

// ========== 模板配置类型 ==========

/**
 * 节点模板点击回调
 */
export type NodeClickHandler = (e: GoJSInputEvent, node: GoJSNode) => void;

/**
 * 连接线模板点击回调
 */
export type LinkClickHandler = (e: GoJSInputEvent, link: GoJSLink) => void;

/**
 * 拖拽回调
 */
export type DragHandler = (e: GoJSInputEvent, part: go.Part) => void;

// ========== 工具函数类型 ==========

/**
 * 类型守卫：判断是否为节点数据
 */
export function isGoJSNodeData(data: unknown): data is GoJSNodeData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj['key'] === 'string' && 'title' in obj;
}

/**
 * 类型守卫：判断是否为连接线数据
 */
export function isGoJSLinkData(data: unknown): data is GoJSLinkData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj['key'] === 'string' && 'from' in obj && 'to' in obj;
}

/**
 * 类型守卫：判断是否为节点 Part
 */
export function isGoJSNode(part: go.Part | null): part is GoJSNode {
  if (!part) return false;
  return part instanceof go.Node && isGoJSNodeData(part.data);
}

/**
 * 类型守卫：判断是否为连接线
 */
export function isGoJSLink(part: go.Part | null): part is GoJSLink {
  if (!part) return false;
  return part instanceof go.Link && isGoJSLinkData(part.data);
}

// ========== Model 扩展类型 ==========

/**
 * GoJS GraphLinksModel 扩展（带类型的节点和连接数据）
 */
export interface TypedGraphLinksModel extends go.GraphLinksModel {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}

// ========== 移动数据类型 ==========

/**
 * 节点移动数据（选择移动完成后）
 */
export interface NodeMoveData {
  key: string;
  x: number;
  y: number;
  isUnassigned: boolean;
}

/**
 * 连接线创建数据
 */
export interface LinkCreateData {
  from: string;
  to: string;
  category: 'parent-child' | 'cross-tree';
  x: number;
  y: number;
}

/**
 * 连接线重连数据
 */
export interface LinkRelinkData {
  linkKey: string;
  changedEnd: 'from' | 'to';
  oldFromId: string;
  oldToId: string;
  newFromId: string;
  newToId: string;
}
