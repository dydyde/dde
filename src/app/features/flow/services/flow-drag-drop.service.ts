import { Injectable, inject, signal, NgZone } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { GOJS_CONFIG, UI_CONFIG } from '../../../../config';
import * as go from 'gojs';

/**
 * 插入位置信息
 */
export interface InsertPositionInfo {
  /** 作为子节点插入的父节点ID */
  parentId?: string;
  /** 插入到该节点之前（同级） */
  beforeTaskId?: string;
  /** 插入到该节点之后（同级） */
  afterTaskId?: string;
  /** 插入到连接线上（两个节点之间） */
  insertOnLink?: {
    sourceId: string;
    targetId: string;
  };
}

/**
 * 拖放结果回调
 */
export interface DropResultCallback {
  (task: Task, position: InsertPositionInfo, docPoint: go.Point): void;
}

/**
 * FlowDragDropService - 拖放处理服务
 * 
 * 职责：
 * - 从待分配区域拖放到画布
 * - 从画布拖回待分配区域
 * - 拖放插入位置计算
 * - 连接线上的插入检测
 * 
 * 设计原则：
 * - 纯逻辑服务，不持有 DOM 引用
 * - 通过回调与组件通信
 * - 依赖 GoJS Diagram 实例通过参数传入
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDragDropService {
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDragDrop');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  
  // ========== 状态 ==========
  
  /** 拖放目标是否激活（高亮待分配区域） */
  readonly isDropTargetActive = signal(false);
  
  /** 当前从流程图拖动的任务ID */
  private draggingFromDiagramId: string | null = null;
  
  // ========== 公开方法 ==========
  
  /**
   * 开始拖动（从待分配区域）
   * @param event 拖动事件
   * @param task 被拖动的任务
   */
  startDrag(event: DragEvent, task: Task): void {
    if (event.dataTransfer) {
      const data = JSON.stringify(task);
      event.dataTransfer.setData("text", data);
      event.dataTransfer.setData("application/json", data);
      event.dataTransfer.effectAllowed = "move";
    }
  }
  
  /**
   * 开始从流程图拖动节点（用于拖回待分配区域）
   */
  startDragFromDiagram(taskId: string): void {
    this.draggingFromDiagramId = taskId;
    this.isDropTargetActive.set(true);
  }
  
  /**
   * 结束从流程图拖动
   */
  endDragFromDiagram(): void {
    this.draggingFromDiagramId = null;
    this.isDropTargetActive.set(false);
  }
  
  /**
   * 待分配区域 dragover 事件处理
   */
  handleDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.isDropTargetActive.set(true);
  }
  
  /**
   * 待分配区域 dragleave 事件处理
   */
  handleDragLeave(): void {
    this.isDropTargetActive.set(false);
  }
  
  /**
   * 待分配区域 drop 事件处理
   * 将任务从流程图解除分配
   * @returns 是否成功处理
   */
  handleDropToUnassigned(event: DragEvent): boolean {
    event.preventDefault();
    this.isDropTargetActive.set(false);
    
    const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
    if (!data) return false;
    
    try {
      const task = JSON.parse(data);
      if (task?.id && task.stage !== null) {
        this.taskOps.detachTask(task.id);
        this.toast.success('已移至待分配', `任务 "${task.title}" 已解除分配`);
        return true;
      }
    } catch (err) {
      this.logger.error('Drop to unassigned error:', err);
    }
    
    return false;
  }
  
  /**
   * 处理拖放到流程图画布
   * @param event 拖放事件
   * @param diagram GoJS Diagram 实例
   * @param callback 处理结果回调
   */
  handleDropToDiagram(
    event: DragEvent,
    diagram: go.Diagram,
    callback: DropResultCallback
  ): void {
    event.preventDefault();
    
    const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
    if (!data) return;
    
    try {
      const task = JSON.parse(data) as Task;
      const pt = diagram.lastInput.viewPoint;
      const loc = diagram.transformViewToDoc(pt);
      
      // 查找插入位置
      const insertInfo = this.findInsertPosition(loc, diagram);
      
      callback(task, insertInfo, loc);
    } catch (err) {
      this.logger.error('Drop to diagram error:', err);
    }
  }
  
  /**
   * 根据位置查找插入点
   * 支持插入到连接线上（两个节点之间）
   */
  findInsertPosition(loc: go.Point, diagram: go.Diagram): InsertPositionInfo {
    const threshold = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD;
    
    // 优先检测是否拖放到连接线上
    const linkInsertInfo = this.findLinkAtPosition(loc, diagram);
    if (linkInsertInfo) {
      this.logger.info('拖放位置匹配连接线', linkInsertInfo);
      return { insertOnLink: linkInsertInfo };
    }
    
    // 检测节点附近
    let closestNode = null as go.Node | null;
    let closestDistance = Infinity;
    let insertPosition: string = 'after';
    
    diagram.nodes.each((node: go.Node) => {
      // 跳过待分配节点
      const nodeData = node.data as go.ObjectData;
      if (nodeData?.isUnassigned || nodeData?.stage === null) {
        return;
      }
      
      const nodeLoc = node.location;
      const dx = loc.x - nodeLoc.x;
      const dy = loc.y - nodeLoc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < threshold && distance < closestDistance) {
        closestDistance = distance;
        closestNode = node;
        
        // 根据相对位置判断插入方式
        if (dx > 100) {
          insertPosition = 'child';
        } else if (dy < -30) {
          insertPosition = 'before';
        } else {
          insertPosition = 'after';
        }
      }
    });
    
    if (!closestNode) return {};
    
    const closestNodeData = closestNode.data as go.ObjectData;
    const nodeId = closestNodeData.key as string;
    
    if (insertPosition === 'child') {
      return { parentId: nodeId };
    } else if (insertPosition === 'before') {
      return { beforeTaskId: nodeId };
    } else {
      return { afterTaskId: nodeId };
    }
  }
  
  /**
   * 将任务插入到两个节点之间（连接线上）
   * @param taskId 要插入的任务ID
   * @param sourceId 原父节点ID
   * @param targetId 原子节点ID
   * @param loc 拖放位置
   */
  insertTaskBetweenNodes(
    taskId: string,
    sourceId: string,
    targetId: string,
    loc: go.Point
  ): boolean {
    const tasks = this.projectState.tasks();
    const sourceTask = tasks.find(t => t.id === sourceId);
    const targetTask = tasks.find(t => t.id === targetId);
    
    if (!sourceTask || !targetTask) {
      this.logger.warn('insertTaskBetweenNodes: 找不到源或目标任务', { sourceId, targetId });
      return false;
    }
    
    // 确保 source 是 target 的直接父节点
    if (targetTask.parentId !== sourceId) {
      this.logger.warn('insertTaskBetweenNodes: 目标任务的父节点不是源节点', {
        targetParentId: targetTask.parentId,
        sourceId
      });
      return false;
    }
    
    this.logger.info('插入任务到连接线', { taskId, sourceId, targetId });
    
    // 使用 taskOps 的方法完成插入
    this.taskOps.insertTaskBetween(taskId, sourceId, targetId);
    
    // 更新拖放位置
    setTimeout(() => {
      this.taskOps.updateTaskPosition(taskId, loc.x, loc.y);
    }, UI_CONFIG.MEDIUM_DELAY);
    
    this.toast.success('任务已插入', '任务已插入到两个节点之间');
    return true;
  }
  
  /**
   * 处理节点移动（从待分配到已分配区域）
   */
  handleNodeMoved(
    nodeKey: string,
    loc: go.Point,
    _isUnassigned: boolean,
    _diagram: go.Diagram
  ): void {
    // 场景二：待分配节点在流程图内移动，仅更新位置。
    // 不再支持“拖到连接线上立即插入并任务化”，任务化只在“拉线”确认时发生。
    this.taskOps.updateTaskPositionWithRankSync(nodeKey, loc.x, loc.y);
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 检测指定位置是否靠近某条父子连接线
   */
  private findLinkAtPosition(
    loc: go.Point,
    diagram: go.Diagram
  ): { sourceId: string; targetId: string } | null {
    const linkThreshold = 50;
    let closestLink = null as go.Link | null;
    let closestDistance = Infinity;
    
    diagram.links.each((link: go.Link) => {
      // 只处理父子连接线（非跨树连接）
      const linkData = link.data as go.ObjectData;
      if (linkData?.isCrossTree) return;
      
      // 确保连接线有有效数据
      if (!linkData?.from || !linkData?.to) return;
      
      // 计算点到连接线的距离
      const distance = this.pointToLinkDistance(loc, link);
      
      if (distance < linkThreshold && distance < closestDistance) {
        closestDistance = distance;
        closestLink = link;
      }
    });
    
    if (closestLink && closestLink.data) {
      const data = closestLink.data as go.ObjectData & { from?: string; to?: string };
      if (!data.from || !data.to) return null;
      this.logger.info('检测到靠近连接线', {
        from: data.from,
        to: data.to,
        distance: closestDistance
      });
      return {
        sourceId: data.from,
        targetId: data.to
      };
    }
    
    return null;
  }
  
  /**
   * 计算点到连接线的最近距离
   */
  private pointToLinkDistance(point: go.Point, link: go.Link): number {
    const fromNode = link.fromNode;
    const toNode = link.toNode;
    if (!fromNode || !toNode) return Infinity;
    
    const startPoint = fromNode.location;
    const endPoint = toNode.location;
    
    if (!startPoint || !endPoint) return Infinity;
    
    return this.pointToSegmentDistance(
      point.x, point.y,
      startPoint.x, startPoint.y,
      endPoint.x, endPoint.y
    );
  }
  
  /**
   * 计算点到线段的最短距离
   */
  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    
    if (lengthSquared === 0) {
      return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    }
    
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    
    return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
  }
  
  /**
   * 释放资源
   */
  dispose(): void {
    this.isDropTargetActive.set(false);
    this.draggingFromDiagramId = null;
  }
}
