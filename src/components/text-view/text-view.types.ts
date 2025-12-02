/**
 * TextView 组件共享类型定义
 */
import { Task } from '../../models';

/** 拖拽状态 */
export interface DragState {
  task: Task | null;
  isDragging: boolean;
  targetStage: number | null;
  targetBeforeId: string | null;
}

/** 触摸拖拽状态 */
export interface TouchDragState extends DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  dragGhost: HTMLElement | null;
  previousHoverStage: number | null;
  expandedDuringDrag: Set<number>;
}

/** 拖拽展开状态（鼠标） */
export interface DragExpandState {
  previousHoverStage: number | null;
  expandedDuringDrag: Set<number>;
}

/** 自动滚动状态 */
export interface AutoScrollState {
  animationId: number | null;
  scrollContainer: HTMLElement | null;
  lastClientY: number;
}

/** 放置目标信息 */
export interface DropTargetInfo {
  stageNumber: number;
  beforeTaskId: string | null;
}

/** 未完成项 */
export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string;
}

/** 阶段数据 */
export interface StageData {
  stageNumber: number;
  tasks: Task[];
}

/** 任务关联 */
export interface TaskConnection {
  sourceId: string;
  targetId: string;
  description?: string;
  sourceTask?: Task;
  targetTask?: Task;
}

/** 任务关联集合 */
export interface TaskConnections {
  outgoing: TaskConnection[];
  incoming: TaskConnection[];
}
