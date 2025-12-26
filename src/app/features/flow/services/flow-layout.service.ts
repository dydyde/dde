/**
 * FlowLayoutService - 流程图布局计算服务
 * 
 * 职责：
 * - 自动布局计算
 * - 节点位置更新
 * - Rank 更新
 * - 布局算法应用
 * 
 * 从 FlowDiagramService 拆分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { StoreService } from '../../../../services/store.service';
import { GOJS_CONFIG, UI_CONFIG } from '../../../../config/constants';
import * as go from 'gojs';

/**
 * 节点位置信息
 */
export interface NodePosition {
  key: string;
  x: number;
  y: number;
}

/**
 * 布局选项
 */
export interface LayoutOptions {
  /** 布局方向 (0=从左到右, 90=从上到下, 180=从右到左, 270=从下到上) */
  direction?: number;
  /** 层间距 */
  layerSpacing?: number;
  /** 列间距 */
  columnSpacing?: number;
}

@Injectable({
  providedIn: 'root'
})
export class FlowLayoutService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLayout');
  private readonly store = inject(StoreService);
  
  /** 外部注入的 Diagram 引用 */
  private diagram: go.Diagram | null = null;
  
  /** 位置保存定时器 */
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
  }
  
  /**
   * 应用自动布局（分层有向图布局）
   * @param options 布局选项
   */
  applyAutoLayout(options: LayoutOptions = {}): void {
    if (!this.diagram) return;
    
    const $ = go.GraphObject.make;
    const {
      direction = 0,
      layerSpacing = GOJS_CONFIG.LAYER_SPACING,
      columnSpacing = GOJS_CONFIG.COLUMN_SPACING
    } = options;
    
    this.diagram.startTransaction('auto-layout');
    this.diagram.layout = $(go.LayeredDigraphLayout, {
      direction,
      layerSpacing,
      columnSpacing,
      setsPortSpots: false
    });
    this.diagram.layoutDiagram(true);
    
    // 布局完成后保存位置并恢复无操作布局
    setTimeout(() => {
      if (!this.diagram) return;
      this.saveAllNodePositions();
      this.diagram.layout = $(go.Layout);
      this.diagram.commitTransaction('auto-layout');
    }, UI_CONFIG.SHORT_DELAY);
    
    this.logger.info('自动布局已应用');
  }
  
  /**
   * 应用树形布局
   * @param options 布局选项
   */
  applyTreeLayout(options: LayoutOptions = {}): void {
    if (!this.diagram) return;
    
    const $ = go.GraphObject.make;
    const {
      layerSpacing = GOJS_CONFIG.LAYER_SPACING
    } = options;
    
    this.diagram.startTransaction('tree-layout');
    this.diagram.layout = $(go.TreeLayout, {
      angle: 0,
      layerSpacing,
      nodeSpacing: 20
    });
    this.diagram.layoutDiagram(true);
    
    setTimeout(() => {
      if (!this.diagram) return;
      this.saveAllNodePositions();
      this.diagram.layout = $(go.Layout);
      this.diagram.commitTransaction('tree-layout');
    }, UI_CONFIG.SHORT_DELAY);
    
    this.logger.info('树形布局已应用');
  }
  
  /**
   * 保存所有节点位置到 Store
   */
  saveAllNodePositions(): void {
    if (!this.diagram) return;
    
    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string };
      const loc = node.location;
      if (data?.key && loc.isReal()) {
        this.store.updateTaskPosition(data.key, loc.x, loc.y);
      }
    });
    
    this.logger.debug('所有节点位置已保存');
  }
  
  /**
   * 延迟保存所有节点位置（防抖）
   * 用于拖动操作结束后保存
   */
  scheduleSaveAllPositions(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
    }
    
    this.positionSaveTimer = setTimeout(() => {
      this.saveAllNodePositions();
      this.positionSaveTimer = null;
    }, 300);
  }
  
  /**
   * 获取节点位置
   * @param nodeKey 节点 key
   */
  getNodePosition(nodeKey: string): NodePosition | null {
    if (!this.diagram) return null;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (!node || !node.location.isReal()) return null;
    
    return {
      key: nodeKey,
      x: node.location.x,
      y: node.location.y
    };
  }
  
  /**
   * 设置节点位置
   * @param nodeKey 节点 key
   * @param x X 坐标
   * @param y Y 坐标
   */
  setNodePosition(nodeKey: string, x: number, y: number): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.startTransaction('move-node');
      node.location = new go.Point(x, y);
      this.diagram.commitTransaction('move-node');
    }
  }
  
  /**
   * 批量设置节点位置
   * @param positions 节点位置列表
   */
  setNodePositions(positions: NodePosition[]): void {
    if (!this.diagram || positions.length === 0) return;
    
    this.diagram.startTransaction('move-nodes');
    for (const pos of positions) {
      const node = this.diagram.findNodeForKey(pos.key);
      if (node) {
        node.location = new go.Point(pos.x, pos.y);
      }
    }
    this.diagram.commitTransaction('move-nodes');
  }
  
  /**
   * 获取所有节点位置
   */
  getAllNodePositions(): NodePosition[] {
    const positions: NodePosition[] = [];
    if (!this.diagram) return positions;
    
    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string };
      const loc = node.location;
      if (data?.key && loc.isReal()) {
        positions.push({
          key: data.key,
          x: loc.x,
          y: loc.y
        });
      }
    });
    
    return positions;
  }
  
  /**
   * 使连接线失效（需要重新计算路由）
   */
  invalidateAllLinkRoutes(): void {
    if (!this.diagram) return;
    
    this.diagram.links.each((link: go.Link) => {
      link.invalidateRoute();
    });
  }
  
  /**
   * 使所有节点布局失效
   */
  invalidateAllNodeLayouts(): void {
    if (!this.diagram) return;
    
    this.diagram.nodes.each((node: go.Node) => {
      node.invalidateLayout();
    });
  }
  
  /**
   * 清理资源
   */
  dispose(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.diagram = null;
  }
}
