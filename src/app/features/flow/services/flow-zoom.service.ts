/**
 * FlowZoomService - 流程图缩放与视口控制服务
 * 
 * 职责：
 * - 缩放操作（放大/缩小/设置级别）
 * - 视口控制（居中到节点/适应内容）
 * - 视图状态保存/恢复
 * - 坐标转换
 * 
 * 从 FlowDiagramService 拆分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { StoreService } from '../../../../services/store.service';
import * as go from 'gojs';

/**
 * 视图状态（用于保存/恢复）
 */
export interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}

@Injectable({
  providedIn: 'root'
})
export class FlowZoomService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowZoom');
  private readonly store = inject(StoreService);
  
  /** 外部注入的 Diagram 引用 */
  private diagram: go.Diagram | null = null;
  
  /** 视图状态保存定时器 */
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 默认缩放范围 */
  private readonly MIN_SCALE = 0.1;
  private readonly MAX_SCALE = 3.0;
  private readonly DEFAULT_SCALE = 1.0;
  
  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
  }
  
  /**
   * 放大
   */
  zoomIn(): void {
    if (this.diagram) {
      this.diagram.commandHandler.increaseZoom();
      this.scheduleSaveViewState();
    }
  }
  
  /**
   * 缩小
   */
  zoomOut(): void {
    if (this.diagram) {
      this.diagram.commandHandler.decreaseZoom();
      this.scheduleSaveViewState();
    }
  }
  
  /**
   * 设置缩放级别
   * @param scale 缩放比例 (0.1 - 3.0)
   */
  setZoom(scale: number): void {
    if (this.diagram) {
      const clampedScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, scale));
      this.diagram.scale = clampedScale;
      this.scheduleSaveViewState();
    }
  }
  
  /**
   * 重置缩放到默认级别
   */
  resetZoom(): void {
    this.setZoom(this.DEFAULT_SCALE);
  }
  
  /**
   * 获取当前缩放级别
   */
  getZoom(): number {
    return this.diagram?.scale ?? this.DEFAULT_SCALE;
  }
  
  /**
   * 定位到指定节点并居中
   * @param nodeKey 节点 key
   * @param select 是否选中节点
   */
  centerOnNode(nodeKey: string, select: boolean = true): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.centerRect(node.actualBounds);
      if (select) {
        this.diagram.select(node);
      }
    }
  }
  
  /**
   * 适应内容：将所有节点缩放并居中显示在视口中
   * 主要用于移动端首次加载时确保节点可见
   */
  fitToContents(): void {
    if (!this.diagram) return;
    
    // 获取所有节点的边界
    const bounds = this.diagram.documentBounds;
    if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
      // 如果没有有效的边界，尝试滚动到原点
      this.diagram.scrollToRect(new go.Rect(0, 0, 100, 100));
      return;
    }
    
    // 添加一些内边距
    const padding = 50;
    const paddedBounds = bounds.copy().inflate(padding, padding);
    
    // 计算需要的缩放比例
    const viewportWidth = this.diagram.viewportBounds.width;
    const viewportHeight = this.diagram.viewportBounds.height;
    
    if (viewportWidth <= 0 || viewportHeight <= 0) {
      return; // 视口无效
    }
    
    const scaleX = viewportWidth / paddedBounds.width;
    const scaleY = viewportHeight / paddedBounds.height;
    let scale = Math.min(scaleX, scaleY);
    
    // 限制缩放范围：不要太小也不要太大
    scale = Math.max(0.3, Math.min(1.5, scale));
    
    // 应用缩放
    this.diagram.scale = scale;
    
    // 居中显示
    this.diagram.centerRect(bounds);
    
    this.scheduleSaveViewState();
  }
  
  /**
   * 滚动到指定位置
   * @param x X 坐标
   * @param y Y 坐标
   */
  scrollTo(x: number, y: number): void {
    if (this.diagram) {
      this.diagram.position = new go.Point(x, y);
      this.scheduleSaveViewState();
    }
  }
  
  /**
   * 将视口坐标转换为文档坐标
   */
  transformViewToDoc(viewPoint: go.Point): go.Point {
    if (this.diagram) {
      return this.diagram.transformViewToDoc(viewPoint);
    }
    return viewPoint;
  }
  
  /**
   * 将文档坐标转换为视口坐标
   */
  transformDocToView(docPoint: go.Point): go.Point {
    if (this.diagram) {
      return this.diagram.transformDocToView(docPoint);
    }
    return docPoint;
  }
  
  /**
   * 获取当前视图状态
   */
  getCurrentViewState(): ViewState | null {
    if (!this.diagram) return null;
    
    return {
      scale: this.diagram.scale,
      positionX: this.diagram.position.x,
      positionY: this.diagram.position.y
    };
  }
  
  /**
   * 保存视图状态到 Store
   */
  saveViewState(): void {
    const viewState = this.getCurrentViewState();
    const projectId = this.store.activeProjectId();
    if (viewState && projectId) {
      this.store.updateViewState(projectId, viewState);
      this.logger.debug('视图状态已保存', viewState);
    }
  }
  
  /**
   * 从 Store 恢复视图状态
   */
  restoreViewState(): void {
    if (!this.diagram) return;
    
    const viewState = this.store.getViewState();
    if (viewState) {
      this.diagram.scale = viewState.scale;
      this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      this.logger.debug('视图状态已恢复', viewState);
    }
  }
  
  /**
   * 延迟保存视图状态（防抖）
   */
  private scheduleSaveViewState(): void {
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }
    
    this.viewStateSaveTimer = setTimeout(() => {
      this.saveViewState();
      this.viewStateSaveTimer = null;
    }, 300);
  }
  
  /**
   * 请求重新渲染
   */
  requestUpdate(): void {
    if (this.diagram) {
      this.diagram.requestUpdate();
    }
  }
  
  /**
   * 获取视口边界
   */
  getViewportBounds(): go.Rect | null {
    return this.diagram?.viewportBounds.copy() ?? null;
  }
  
  /**
   * 获取文档边界（所有节点的边界）
   */
  getDocumentBounds(): go.Rect | null {
    return this.diagram?.documentBounds.copy() ?? null;
  }
  
  /**
   * 清理资源
   */
  dispose(): void {
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    this.diagram = null;
  }
}
