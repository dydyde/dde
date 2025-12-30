/**
 * FlowEventService - GoJS 事件处理服务（事件代理模式）
 * 
 * 从 flow-diagram.service.ts (3000+ 行) 提取的事件处理逻辑
 * 
 * 核心设计：事件代理（Event Delegation via Event Bus）
 * - 模板通过 flowTemplateEventHandlers 全局对象发信号
 * - EventService 在 setDiagram 时注册处理器，收信号
 * - 完全解耦：模板不知道回调是谁，EventService 不知道模板长什么样
 * 
 * 职责：
 * - 事件回调注册和分发
 * - Diagram 级别事件监听
 * - 模板事件处理器注册
 * - 事件监听器生命周期管理
 * - 防止内存泄漏
 */

import { Injectable, inject, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import { GOJS_CONFIG } from '../../../../config';
import type { GoJSLinkData } from '../../../../types/gojs-extended';
import * as go from 'gojs';

// ========== 自定义事件名称常量（供向后兼容） ==========
export const FLOW_EVENTS = {
  NODE_CLICKED: 'NodeClicked',
  NODE_DOUBLE_CLICKED: 'NodeDoubleClicked',
  LINK_CLICKED: 'LinkClicked',
  LINK_DOUBLE_CLICKED: 'LinkDoubleClicked',
  LINK_DELETE_REQUESTED: 'LinkDeleteRequested',
  CROSS_TREE_LABEL_CLICKED: 'CrossTreeLabelClicked',
} as const;

/**
 * 节点点击回调
 */
export type NodeClickCallback = (taskId: string, isDoubleClick: boolean) => void;

/**
 * 连接线点击回调
 */
export type LinkClickCallback = (linkData: GoJSLinkData, x: number, y: number, isDoubleClick?: boolean) => void;

/**
 * 连接线删除回调
 */
export type LinkDeleteCallback = (linkData: GoJSLinkData) => void;

/**
 * 连接手势回调
 */
export type LinkGestureCallback = (sourceId: string, targetId: string, x: number, y: number, link: go.Link) => void;

/**
 * 选择移动完成回调
 */
export type SelectionMovedCallback = (movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>) => void;

/**
 * 背景点击回调
 */
export type BackgroundClickCallback = () => void;

/**
 * 连接线重连信息
 */
export interface LinkRelinkInfo {
  changedEnd: 'from' | 'to';
  oldFromId: string;
  oldToId: string;
  newFromId: string;
  newToId: string;
}

/**
 * 连接线重连回调
 */
export type LinkRelinkCallback = (
  linkType: 'parent-child' | 'cross-tree',
  relinkInfo: LinkRelinkInfo,
  x: number,
  y: number,
  gojsLink: go.Link
) => void;

/**
 * 已注册的监听器信息
 */
interface RegisteredListener {
  name: go.DiagramEventName | string;
  handler: (e: go.DiagramEvent) => void;
}

@Injectable({
  providedIn: 'root'
})
export class FlowEventService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowEvent');
  private readonly zone = inject(NgZone);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  
  // ========== Diagram 引用 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  
  // ========== 回调存储 ==========
  private nodeClickCallback: NodeClickCallback | null = null;
  private linkClickCallback: LinkClickCallback | null = null;
  private linkDeleteCallback: LinkDeleteCallback | null = null;
  private linkRelinkCallback: LinkRelinkCallback | null = null;
  private linkGestureCallback: LinkGestureCallback | null = null;
  private selectionMovedCallback: SelectionMovedCallback | null = null;
  private backgroundClickCallback: BackgroundClickCallback | null = null;
  
  // ========== 监听器追踪 ==========
  private registeredListeners: RegisteredListener[] = [];
  
  // ========== 定时器 ==========
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 初始化 ==========
  
  /**
   * 设置 Diagram 引用并初始化事件监听
   */
  setDiagram(diagram: go.Diagram | null, diagramDiv?: HTMLDivElement | null): void {
    // 清理旧的监听器和事件处理器
    if (this.diagram && this.diagram !== diagram) {
      this.removeAllListeners(this.diagram);
      this.clearTemplateEventHandlers();
    }
    
    this.diagram = diagram;
    this.diagramDiv = diagramDiv ?? null;
    
    if (diagram) {
      this.setupEventListeners();
      this.setupTemplateEventHandlers();
    }
  }
  
  /**
   * 注册模板事件处理器
   * 模板通过 flowTemplateEventHandlers 调用这些处理器
   */
  private setupTemplateEventHandlers(): void {
    // 节点点击
    flowTemplateEventHandlers.onNodeClick = (node: go.Node) => {
      this.zone.run(() => {
        this.emitNodeClick(node.data?.key, false);
      });
    };
    
    // 节点双击
    flowTemplateEventHandlers.onNodeDoubleClick = (node: go.Node) => {
      this.zone.run(() => {
        this.emitNodeClick(node.data?.key, true);
      });
    };
    
    // 连接线点击
    flowTemplateEventHandlers.onLinkClick = (link: go.Link) => {
      const viewPoint = this.diagram?.lastInput?.viewPoint;
      const x = viewPoint?.x ?? 0;
      const y = viewPoint?.y ?? 0;
      this.zone.run(() => {
        this.emitLinkClick(link.data, x, y, false);
      });
    };
    
    // 连接线删除请求
    flowTemplateEventHandlers.onLinkDeleteRequest = (link: go.Link) => {
      this.zone.run(() => {
        this.emitLinkDelete(link.data);
      });
    };
    
    // 跨树连接标签点击
    flowTemplateEventHandlers.onCrossTreeLabelClick = (link: go.Link, viewX: number, viewY: number) => {
      this.zone.run(() => {
        // 将 GoJS 视图坐标转换为浏览器窗口坐标
        const { windowX, windowY } = this.convertViewToWindowCoords(viewX, viewY);
        this.emitLinkClick(link.data, windowX, windowY, false);
      });
    };
    
    this.logger.debug('模板事件处理器已注册');
  }
  
  /**
   * 清理模板事件处理器
   */
  private clearTemplateEventHandlers(): void {
    flowTemplateEventHandlers.onNodeClick = undefined;
    flowTemplateEventHandlers.onNodeDoubleClick = undefined;
    flowTemplateEventHandlers.onLinkClick = undefined;
    flowTemplateEventHandlers.onLinkDeleteRequest = undefined;
    flowTemplateEventHandlers.onCrossTreeLabelClick = undefined;
  }

  /**
   * 将 GoJS 视图坐标转换为浏览器窗口坐标
   * @param viewX GoJS 视图坐标 X
   * @param viewY GoJS 视图坐标 Y
   * @returns 浏览器窗口坐标
   */
  private convertViewToWindowCoords(viewX: number, viewY: number): { windowX: number; windowY: number } {
    if (!this.diagram || !this.diagramDiv) {
      // 降级：无法转换时直接返回原坐标
      return { windowX: viewX, windowY: viewY };
    }

    // 获取 diagram div 相对于视口的位置
    const rect = this.diagramDiv.getBoundingClientRect();
    
    // GoJS viewPoint 已经是相对于 canvas 左上角的像素坐标
    // 加上 canvas 相对于视口的偏移即可得到窗口坐标
    const windowX = rect.left + viewX;
    const windowY = rect.top + viewY;

    return { windowX, windowY };
  }
  
  // ========== 回调注册方法 ==========
  
  onNodeClick(callback: NodeClickCallback): void {
    this.nodeClickCallback = callback;
  }
  
  onLinkClick(callback: LinkClickCallback): void {
    this.linkClickCallback = callback;
  }
  
  onLinkDelete(callback: LinkDeleteCallback): void {
    this.linkDeleteCallback = callback;
  }
  
  onLinkRelink(callback: LinkRelinkCallback): void {
    this.linkRelinkCallback = callback;
  }
  
  onLinkGesture(callback: LinkGestureCallback): void {
    this.linkGestureCallback = callback;
  }
  
  onSelectionMoved(callback: SelectionMovedCallback): void {
    this.selectionMovedCallback = callback;
  }
  
  onBackgroundClick(callback: BackgroundClickCallback): void {
    this.backgroundClickCallback = callback;
  }
  
  // ========== 事件监听器设置 ==========
  
  /**
   * 设置所有 Diagram 级别的事件监听器
   * 
   * 注意：自定义事件（NodeClicked 等）通过 flowTemplateEventHandlers 处理，
   * 不需要在这里注册，因为 GoJS 的 addDiagramListener 只接受内置事件名称。
   */
  private setupEventListeners(): void {
    if (!this.diagram) return;
    
    const isMobile = this.uiState.isMobile();
    
    // ========== GoJS 原生事件监听 ==========
    
    // 选择移动完成
    this.addTrackedListener('SelectionMoved', (e: go.DiagramEvent) => {
      this.handleSelectionMoved(e);
    });
    
    // 连接线绘制完成
    this.addTrackedListener('LinkDrawn', (e: go.DiagramEvent) => {
      const link = e.subject;
      if (link && link.data) {
        const model = this.diagram!.model as go.GraphLinksModel;
        model.setDataProperty(link.data, 'fromPortId', '');
        model.setDataProperty(link.data, 'toPortId', '');
        link.invalidateRoute();
      }
      this.handleLinkGesture(e);
    });
    
    // 连接线重连
    this.addTrackedListener('LinkRelinked', (e: go.DiagramEvent) => {
      this.handleLinkRelinked(e);
    });
    
    // 背景点击
    this.addTrackedListener('BackgroundSingleClicked', () => {
      this.emitBackgroundClick();
    });
    
    // 视口变化（用于保存视图状态，由 FlowDiagramService 处理）
    // 这里不处理，保留给 FlowDiagramService
    
    // 移动端特殊处理
    if (isMobile) {
      this.addTrackedListener('ObjectSingleClicked', (e: go.DiagramEvent) => {
        const part = e.subject.part;
        if (part instanceof go.Link && part.data) {
          const { x, y } = this.getLinkClickPosition(part);
          this.emitLinkClick(part.data, x, y, false);
        }
      });
      
      this.addTrackedListener('ObjectDoubleClicked', (e: go.DiagramEvent) => {
        const part = e.subject.part;
        if (part instanceof go.Link && part.data) {
          const { x, y } = this.getLinkClickPosition(part);
          this.emitLinkClick(part.data, x, y, true);
        }
      });
    }
    
    this.logger.debug('事件监听器已设置');
  }
  
  // ========== 事件处理方法 ==========
  
  /**
   * 处理选择移动完成
   */
  private handleSelectionMoved(e: go.DiagramEvent): void {
    const projectIdAtMove = this.projectState.activeProjectId();
    
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
    }
    
    this.positionSaveTimer = setTimeout(() => {
      if (!this.diagram) return;
      if (this.projectState.activeProjectId() !== projectIdAtMove) return;
      
      const movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }> = [];
      
      e.subject.each((part: go.Part) => {
        if (part instanceof go.Node) {
          const loc = part.location;
          const nodeData = part.data;
          
          movedNodes.push({
            key: nodeData.key,
            x: loc.x,
            y: loc.y,
            isUnassigned: nodeData?.isUnassigned || nodeData?.stage === null
          });
        }
      });
      
      if (movedNodes.length > 0) {
        this.emitSelectionMoved(movedNodes);
      }
    }, GOJS_CONFIG.POSITION_SAVE_DEBOUNCE);
  }
  
  /**
   * 处理连接手势
   */
  private handleLinkGesture(e: go.DiagramEvent): void {
    if (!this.diagram || !this.diagramDiv) return;
    
    const link = e.subject;
    const fromNode = link?.fromNode;
    const toNode = link?.toNode;
    const sourceId = fromNode?.data?.key;
    const targetId = toNode?.data?.key;

    if (!sourceId || !targetId) return;

    // 防止自连接
    if (sourceId === targetId) {
      if (link?.data) {
        const model = this.diagram.model as go.GraphLinksModel;
        this.diagram.startTransaction('reject-self-link');
        model.removeLinkData(link.data);
        this.diagram.commitTransaction('reject-self-link');
      } else if (link instanceof go.Link) {
        this.diagram.remove(link);
      }
      return;
    }
    
    const { x, y } = this.getLinkClickPosition(link);
    this.emitLinkGesture(sourceId, targetId, x, y, link);
  }
  
  /**
   * 处理连接线重连
   */
  private handleLinkRelinked(e: go.DiagramEvent): void {
    if (!this.diagram || !this.diagramDiv) return;
    
    const link = e.subject;
    const disconnectedPort = e.parameter;
    const disconnectedNodeId = disconnectedPort?.part?.data?.key;
    
    const fromNode = link?.fromNode;
    const toNode = link?.toNode;
    const newFromId = fromNode?.data?.key;
    const newToId = toNode?.data?.key;
    
    const linkData = link?.data;
    const isCrossTree = linkData?.isCrossTree;
    
    this.logger.debug('LinkRelinked 事件', {
      disconnectedNodeId,
      newFromId,
      newToId,
      isCrossTree
    });
    
    if (!newFromId || !newToId || !disconnectedNodeId) return;
    
    // 防止自连接
    if (newFromId === newToId) {
      if (link?.data) {
        const model = this.diagram.model as go.GraphLinksModel;
        this.diagram.startTransaction('reject-self-link');
        model.removeLinkData(link.data);
        this.diagram.commitTransaction('reject-self-link');
      }
      return;
    }
    
    const { x, y } = this.getLinkClickPosition(link);
    const linkType: 'parent-child' | 'cross-tree' = isCrossTree ? 'cross-tree' : 'parent-child';
    
    // 确定哪一端被改变
    let changedEnd: 'from' | 'to';
    let oldFromId: string;
    let oldToId: string;
    
    if (disconnectedNodeId === newToId) {
      changedEnd = 'from';
      oldFromId = disconnectedNodeId;
      oldToId = newToId;
    } else if (disconnectedNodeId === newFromId) {
      changedEnd = 'to';
      oldFromId = newFromId;
      oldToId = disconnectedNodeId;
    } else {
      const relinkingTool = this.diagram?.toolManager.relinkingTool;
      if (relinkingTool?.isForwards) {
        changedEnd = 'to';
        oldFromId = newFromId;
        oldToId = disconnectedNodeId;
      } else {
        changedEnd = 'from';
        oldFromId = disconnectedNodeId;
        oldToId = newToId;
      }
    }
    
    const relinkInfo: LinkRelinkInfo = {
      changedEnd,
      oldFromId,
      oldToId,
      newFromId,
      newToId
    };
    
    if (this.linkRelinkCallback) {
      this.emitLinkRelink(linkType, relinkInfo, x, y, link);
    } else {
      this.emitLinkGesture(newFromId, newToId, x, y, link);
    }
  }
  
  /**
   * 获取连接线点击位置（屏幕坐标）
   */
  private getLinkClickPosition(link: go.Link): { x: number; y: number } {
    if (!this.diagram || !this.diagramDiv) {
      return { x: 0, y: 0 };
    }
    
    const midPoint = link.midPoint || link.toNode?.location;
    if (!midPoint) {
      return { x: 0, y: 0 };
    }
    
    const viewPt = this.diagram.transformDocToView(midPoint);
    const rect = this.diagramDiv.getBoundingClientRect();
    
    return {
      x: rect.left + viewPt.x,
      y: rect.top + viewPt.y
    };
  }
  
  // ========== 事件分发方法 ==========
  
  emitNodeClick(taskId: string, isDoubleClick: boolean): void {
    if (this.nodeClickCallback) {
      this.zone.run(() => {
        this.nodeClickCallback!(taskId, isDoubleClick);
      });
    }
  }
  
  emitLinkClick(linkData: GoJSLinkData, x: number, y: number, isDoubleClick?: boolean): void {
    if (this.linkClickCallback) {
      this.zone.run(() => {
        this.linkClickCallback!(linkData, x, y, isDoubleClick);
      });
    }
  }
  
  emitLinkDelete(linkData: GoJSLinkData): void {
    if (this.linkDeleteCallback) {
      this.zone.run(() => {
        this.linkDeleteCallback!(linkData);
      });
    }
  }
  
  emitLinkRelink(
    linkType: 'parent-child' | 'cross-tree',
    relinkInfo: LinkRelinkInfo,
    x: number,
    y: number,
    gojsLink: go.Link
  ): void {
    if (this.linkRelinkCallback) {
      this.zone.run(() => {
        this.linkRelinkCallback!(linkType, relinkInfo, x, y, gojsLink);
      });
    }
  }
  
  emitLinkGesture(sourceId: string, targetId: string, x: number, y: number, link: go.Link): void {
    if (this.linkGestureCallback) {
      this.zone.run(() => {
        this.linkGestureCallback!(sourceId, targetId, x, y, link);
      });
    }
  }
  
  emitSelectionMoved(movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>): void {
    if (this.selectionMovedCallback) {
      this.zone.run(() => {
        this.selectionMovedCallback!(movedNodes);
      });
    }
  }
  
  emitBackgroundClick(): void {
    if (this.backgroundClickCallback) {
      this.zone.run(() => {
        this.backgroundClickCallback!();
      });
    }
  }
  
  // ========== 监听器管理 ==========
  
  /**
   * 注册并追踪一个 Diagram 事件监听器
   */
  addTrackedListener(
    name: go.DiagramEventName | string,
    handler: (e: go.DiagramEvent) => void
  ): void {
    if (!this.diagram) return;
    this.diagram.addDiagramListener(name as go.DiagramEventName, handler);
    this.registeredListeners.push({ name, handler });
  }
  
  /**
   * 移除所有已追踪的监听器
   */
  removeAllListeners(diagram: go.Diagram | null): void {
    if (!diagram) return;
    
    for (const listener of this.registeredListeners) {
      try {
        diagram.removeDiagramListener(listener.name as go.DiagramEventName, listener.handler);
      } catch (e) {
        this.logger.warn('移除监听器失败', { name: listener.name, error: e });
      }
    }
    
    this.registeredListeners = [];
    this.logger.debug('已清除所有事件监听器');
  }
  
  /**
   * 清除所有回调
   */
  clearCallbacks(): void {
    this.nodeClickCallback = null;
    this.linkClickCallback = null;
    this.linkDeleteCallback = null;
    this.linkRelinkCallback = null;
    this.linkGestureCallback = null;
    this.selectionMovedCallback = null;
    this.backgroundClickCallback = null;
  }
  
  /**
   * 完全清理
   */
  dispose(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.removeAllListeners(this.diagram);
    this.clearCallbacks();
    this.diagram = null;
    this.diagramDiv = null;
  }
}
