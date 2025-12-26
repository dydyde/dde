/**
 * FlowSelectionService - 流程图选择管理服务
 * 
 * 职责：
 * - 节点选择/取消选择
 * - 多选管理
 * - 选择高亮
 * - 获取选中任务
 * 
 * 从 FlowDiagramService 拆分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import * as go from 'gojs';

/**
 * 选中节点信息
 */
export interface SelectedNodeInfo {
  key: string;
  x: number;
  y: number;
  isUnassigned: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class FlowSelectionService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowSelection');
  
  /** 外部注入的 Diagram 引用 */
  private diagram: go.Diagram | null = null;
  
  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
  }
  
  /**
   * 选中指定节点
   * @param nodeKey 节点 key
   * @param centerIfHidden 如果节点不在视口中是否居中
   */
  selectNode(nodeKey: string, centerIfHidden: boolean = true): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.select(node);
      
      // 如果节点不在视图中，滚动到节点位置
      if (centerIfHidden && !this.diagram.viewportBounds.containsRect(node.actualBounds)) {
        this.diagram.centerRect(node.actualBounds);
      }
    }
  }
  
  /**
   * 选中多个节点
   * @param nodeKeys 节点 key 列表
   */
  selectMultiple(nodeKeys: string[]): void {
    if (!this.diagram) return;
    
    this.diagram.clearSelection();
    
    for (const key of nodeKeys) {
      const node = this.diagram.findNodeForKey(key);
      if (node) {
        node.isSelected = true;
      }
    }
  }
  
  /**
   * 清除所有选择
   */
  clearSelection(): void {
    if (this.diagram) {
      this.diagram.clearSelection();
    }
  }
  
  /**
   * 获取选中节点的 key 列表
   */
  getSelectedNodeKeys(): string[] {
    const keys: string[] = [];
    if (this.diagram) {
      this.diagram.selection.each((part: go.Part) => {
        if (part instanceof go.Node && (part.data as { key?: string })?.key) {
          keys.push((part.data as { key: string }).key);
        }
      });
    }
    return keys;
  }
  
  /**
   * 获取选中节点的详细信息
   */
  getSelectedNodesInfo(): SelectedNodeInfo[] {
    const nodes: SelectedNodeInfo[] = [];
    if (this.diagram) {
      this.diagram.selection.each((part: go.Part) => {
        if (part instanceof go.Node && (part.data as { key?: string })?.key) {
          const data = part.data as { key: string; isUnassigned?: boolean };
          const loc = part.location;
          nodes.push({
            key: data.key,
            x: loc.x,
            y: loc.y,
            isUnassigned: data.isUnassigned ?? false
          });
        }
      });
    }
    return nodes;
  }
  
  /**
   * 检查节点是否被选中
   */
  isNodeSelected(nodeKey: string): boolean {
    if (!this.diagram) return false;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    return node?.isSelected ?? false;
  }
  
  /**
   * 切换节点选中状态
   */
  toggleNodeSelection(nodeKey: string): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      node.isSelected = !node.isSelected;
    }
  }
  
  /**
   * 获取选中节点数量
   */
  getSelectionCount(): number {
    if (!this.diagram) return 0;
    
    let count = 0;
    this.diagram.selection.each((part: go.Part) => {
      if (part instanceof go.Node) {
        count++;
      }
    });
    return count;
  }
  
  /**
   * 全选所有节点
   */
  selectAll(): void {
    if (!this.diagram) return;
    
    this.diagram.selectCollection(this.diagram.nodes);
  }
  
  /**
   * 保存当前选中状态
   * @returns 选中节点的 key 集合
   */
  saveSelectionState(): Set<string> {
    const selectedKeys = new Set<string>();
    if (this.diagram) {
      this.diagram.selection.each((part: go.Part) => {
        if ((part.data as { key?: string })?.key) {
          selectedKeys.add((part.data as { key: string }).key);
        }
      });
    }
    return selectedKeys;
  }
  
  /**
   * 恢复选中状态
   * @param selectedKeys 选中节点的 key 集合
   */
  restoreSelectionState(selectedKeys: Set<string>): void {
    if (!this.diagram || selectedKeys.size === 0) return;
    
    this.diagram.nodes.each((node: go.Node) => {
      if (selectedKeys.has((node.data as { key?: string })?.key ?? '')) {
        node.isSelected = true;
      }
    });
  }
}
