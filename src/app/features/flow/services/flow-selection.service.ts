/**
 * FlowSelectionService - 流程图选择管理服务
 * 
 * 职责：
 * - 节点选择/取消选择
 * - 多选管理
 * - 选择高亮
 * - 获取选中任务
 * - 暴露选中状态 Signal 供 UI 绑定
 * 
 * 从 FlowDiagramService 拆分
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { flowTemplateEventHandlers } from './flow-template-events';
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
  
  /** ChangedSelection 监听器引用（用于清理） */
  private selectionChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  
  // ========== 公开 Signals ==========
  
  /** 选中的任务 ID 集合（实时同步自 GoJS） */
  readonly selectedTaskIds = signal<Set<string>>(new Set());
  
  /** 选中数量 */
  readonly selectionCount = computed(() => this.selectedTaskIds().size);
  
  /** 是否有多个选中（用于显示批量操作工具栏） */
  readonly hasMultipleSelection = computed(() => this.selectionCount() > 1);
  
  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   */
  setDiagram(diagram: go.Diagram | null): void {
    // 清理旧监听器
    if (this.diagram && this.selectionChangedHandler) {
      this.diagram.removeDiagramListener('ChangedSelection', this.selectionChangedHandler);
      this.selectionChangedHandler = null;
    }
    
    this.diagram = diagram;
    this.selectedTaskIds.set(new Set());
    
    // 注册新监听器
    if (diagram) {
      this.initSelectionListener();
    }
  }
  
  /**
   * 初始化选择变化监听
   * 同步 GoJS 选择状态到 Angular Signal
   */
  private initSelectionListener(): void {
    if (!this.diagram) return;
    
    this.selectionChangedHandler = () => {
      this.syncSelectionState();
    };
    
    this.diagram.addDiagramListener('ChangedSelection', this.selectionChangedHandler);
    this.logger.debug('选择变化监听已初始化');
  }
  
  /**
   * 同步 GoJS 选择状态到 Signal
   * 由 ChangedSelection 事件触发
   */
  private syncSelectionState(): void {
    if (!this.diagram) return;
    
    const keys = new Set<string>();
    this.diagram.selection.each((part: go.Part) => {
      if (part instanceof go.Node && (part.data as { key?: string })?.key) {
        keys.add((part.data as { key: string }).key);
      }
    });
    
    this.selectedTaskIds.set(keys);
    
    // 通过事件总线通知其他服务
    flowTemplateEventHandlers.onSelectionChanged?.(Array.from(keys));
    
    this.logger.debug(`选择变化: ${keys.size} 个节点`, Array.from(keys));
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
