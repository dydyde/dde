/**
 * FlowViewState - 流程图视图状态定义
 * 
 * 集中管理 FlowViewComponent 的所有状态，便于：
 * - 状态类型检查
 * - 状态初始化
 * - 状态重置
 */

import { Task } from './index';

/**
 * 连接类型选择对话框数据
 */
export interface LinkTypeDialogData {
  show: boolean;
  sourceId: string;
  targetId: string;
  sourceTask: Task | null;
  targetTask: Task | null;
  x: number;
  y: number;
}

/**
 * 联系块编辑器数据
 */
export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  description: string;
  x: number;
  y: number;
}

/**
 * 连接线删除提示数据（移动端）
 */
export interface LinkDeleteHint {
  link: any; // GoJS Link 对象
  x: number;
  y: number;
  /** 是否跨树连接（用于 UI 文案区分） */
  isCrossTree: boolean;
}

/**
 * 面板位置
 */
export interface PanelPosition {
  x: number;
  y: number;
}

/**
 * 拖动状态
 */
export interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 待分配块触摸拖动状态
 */
export interface UnassignedTouchState {
  task: Task | null;
  startX: number;
  startY: number;
  isDragging: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  ghost: HTMLElement | null;
}

/**
 * 流程图视图完整状态
 */
export interface FlowViewState {
  // ========== 选中状态 ==========
  /** 当前选中的任务ID */
  selectedTaskId: string | null;
  
  // ========== 连接模式 ==========
  /** 是否处于连接模式 */
  isLinkMode: boolean;
  /** 连接模式下选中的源任务 */
  linkSourceTask: Task | null;
  /** 连接类型选择对话框数据 */
  linkTypeDialog: LinkTypeDialogData | null;
  
  // ========== 编辑器状态 ==========
  /** 联系块编辑器数据 */
  connectionEditorData: ConnectionEditorData | null;
  /** 联系块编辑器位置（可拖动） */
  connectionEditorPos: PanelPosition;
  
  // ========== 面板状态 ==========
  /** 任务详情面板位置（桌面端可拖动） */
  taskDetailPos: PanelPosition;
  /** 底部抽屉高度（vh 单位，移动端） */
  drawerHeight: number;
  /** 是否正在调整抽屉高度 */
  isResizingDrawer: boolean;
  
  // ========== 调色板状态 ==========
  /** 调色板区域高度（px） */
  paletteHeight: number;
  /** 拖放目标是否激活（高亮待分配区域） */
  isDropTargetActive: boolean;
  /** 当前正在拖动的待分配任务ID */
  unassignedDraggingId: string | null;
  
  // ========== 删除确认 ==========
  /** 待删除确认的任务 */
  deleteConfirmTask: Task | null;
  /** 删除时是否保留子任务 */
  deleteKeepChildren: boolean;
  
  // ========== 移动端提示 ==========
  /** 连接线删除提示（移动端） */
  linkDeleteHint: LinkDeleteHint | null;
  
  // ========== 错误状态 ==========
  /** 流程图初始化错误信息 */
  diagramError: string | null;
}

/**
 * 创建初始状态
 */
export function createInitialFlowViewState(): FlowViewState {
  return {
    // 选中状态
    selectedTaskId: null,
    
    // 连接模式
    isLinkMode: false,
    linkSourceTask: null,
    linkTypeDialog: null,
    
    // 编辑器状态
    connectionEditorData: null,
    connectionEditorPos: { x: 0, y: 0 },
    
    // 面板状态
    taskDetailPos: { x: -1, y: -1 }, // -1 表示使用默认位置
    drawerHeight: 35, // 35vh
    isResizingDrawer: false,
    
    // 调色板状态
    paletteHeight: 200,
    isDropTargetActive: false,
    unassignedDraggingId: null,
    
    // 删除确认
    deleteConfirmTask: null,
    deleteKeepChildren: false,
    
    // 移动端提示
    linkDeleteHint: null,
    
    // 错误状态
    diagramError: null
  };
}

/**
 * 创建初始拖动状态
 */
export function createInitialDragState(): DragState {
  return {
    isDragging: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0
  };
}

/**
 * 创建初始触摸状态
 */
export function createInitialUnassignedTouchState(): UnassignedTouchState {
  return {
    task: null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null,
    ghost: null
  };
}
