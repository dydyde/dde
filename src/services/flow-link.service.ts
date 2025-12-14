import { Injectable, inject, signal, NgZone, DestroyRef } from '@angular/core';
import { StoreService } from './store.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Task } from '../models';
import { 
  LinkTypeDialogData, 
  ConnectionEditorData, 
  LinkDeleteHint,
  PanelPosition,
  DragState,
  createInitialDragState
} from '../models/flow-view-state';
import { UI_CONFIG } from '../config/constants';

/**
 * 连接类型
 */
export type LinkType = 'parent-child' | 'cross-tree';

/**
 * FlowLinkService - 连接线管理服务
 * 
 * 职责：
 * - 连接模式状态管理
 * - 连接类型选择对话框
 * - 连接线CRUD操作
 * - 联系块编辑器管理
 * 
 * 设计原则：
 * - 封装所有连接相关逻辑
 * - 管理连接相关的UI状态
 * - 与 store 交互进行数据操作
 */
@Injectable({
  providedIn: 'root'
})
export class FlowLinkService {
  private readonly store = inject(StoreService);
  private readonly logger = inject(LoggerService).category('FlowLink');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  
  // ========== 连接模式状态 ==========
  
  /** 是否处于连接模式 */
  readonly isLinkMode = signal(false);
  
  /** 连接模式下选中的源任务 */
  readonly linkSourceTask = signal<Task | null>(null);
  
  constructor() {
    // 注册自动清理
    this.destroyRef.onDestroy(() => this.dispose());
  }
  
  // ========== 连接类型对话框状态 ==========
  
  /** 连接类型选择对话框数据 */
  readonly linkTypeDialog = signal<LinkTypeDialogData | null>(null);
  
  // ========== 联系块编辑器状态 ==========
  
  /** 联系块编辑器数据 */
  readonly connectionEditorData = signal<ConnectionEditorData | null>(null);
  
  /** 联系块编辑器位置 */
  readonly connectionEditorPos = signal<PanelPosition>({ x: 0, y: 0 });
  
  /** 拖动状态 */
  private connEditorDragState: DragState = createInitialDragState();
  
  // ========== 移动端连接线删除提示 ==========
  
  /** 连接线删除提示数据 */
  readonly linkDeleteHint = signal<LinkDeleteHint | null>(null);
  
  /** 删除提示定时器 */
  private linkDeleteHintTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 销毁标志 ==========
  private isDestroyed = false;
  
  // ========== 连接模式方法 ==========
  
  /**
   * 切换连接模式
   */
  toggleLinkMode(): void {
    this.isLinkMode.update(v => !v);
    this.linkSourceTask.set(null);
  }
  
  /**
   * 取消连接模式
   */
  cancelLinkMode(): void {
    this.isLinkMode.set(false);
    this.linkSourceTask.set(null);
  }
  
  /**
   * 处理连接模式下的节点点击
   * @param taskId 被点击的任务ID
   * @returns 是否已创建连接
   */
  handleLinkModeClick(taskId: string): boolean {
    const task = this.store.tasks().find(t => t.id === taskId);
    if (!task) return false;
    
    const source = this.linkSourceTask();
    if (!source) {
      // 选择源节点
      this.linkSourceTask.set(task);
      return false;
    } else if (source.id === taskId) {
      // 点击的是同一个任务，显示提示并取消选择
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkSourceTask.set(null);
      return false;
    } else {
      // 选择目标节点，创建连接
      // 场景二：若目标是“待分配块”，先将其任务化（赋予阶段/序号），再创建连接
      if (task.stage === null) {
        const inferredStage = source.stage ?? 1;
        this.store.moveTaskToStage(taskId, inferredStage, undefined, null);
      }
      this.store.addCrossTreeConnection(source.id, taskId);
      this.linkSourceTask.set(null);
      this.isLinkMode.set(false);
      return true;
    }
    
    return false;
  }
  
  // ========== 连接类型对话框方法 ==========
  
  /**
   * 显示连接类型选择对话框
   */
  showLinkTypeDialog(
    sourceId: string,
    targetId: string,
    x: number,
    y: number
  ): void {
    // 防止自连接
    if (sourceId === targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return;
    }
    
    const tasks = this.store.tasks();
    const sourceTask = tasks.find(t => t.id === sourceId) || null;
    const targetTask = tasks.find(t => t.id === targetId) || null;
    
    this.linkTypeDialog.set({
      show: true,
      sourceId,
      targetId,
      sourceTask,
      targetTask,
      x,
      y
    });
  }
  
  /**
   * 确认创建父子关系连接
   */
  confirmParentChildLink(): void {
    const dialog = this.linkTypeDialog();
    if (!dialog) return;
    
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return;
    }
    
    const parentTask = dialog.sourceTask;
    const parentStage = parentTask?.stage ?? null;
    const nextStage = parentStage !== null ? parentStage + 1 : 1;
    
    this.store.moveTaskToStage(dialog.targetId, nextStage, undefined, dialog.sourceId);
    this.linkTypeDialog.set(null);
  }
  
  /**
   * 确认创建关联连接（跨树）
   */
  confirmCrossTreeLink(): void {
    const dialog = this.linkTypeDialog();
    if (!dialog) return;
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return;
    }
    // 场景二：若目标是“待分配块”，在创建关联连接前先任务化（否则不会从待分配区消失）
    if (dialog.targetTask?.stage === null) {
      const inferredStage = dialog.sourceTask?.stage ?? 1;
      this.store.moveTaskToStage(dialog.targetId, inferredStage, undefined, null);
    }

    this.store.addCrossTreeConnection(dialog.sourceId, dialog.targetId);
    this.linkTypeDialog.set(null);
  }
  
  /**
   * 取消连接创建
   */
  cancelLinkCreate(): void {
    this.linkTypeDialog.set(null);
  }
  
  // ========== 连接手势处理 ==========
  
  /**
   * 处理连接手势（绘制/重连连接线）
   * @param sourceId 源节点ID
   * @param targetId 目标节点ID
   * @param x 对话框X位置
   * @param y 对话框Y位置
   * @returns 需要执行的动作
   */
  handleLinkGesture(
    sourceId: string,
    targetId: string,
    x: number,
    y: number
  ): 'show-dialog' | 'create-cross-tree' | 'none' {
    // 防止自连接
    if (sourceId === targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'none';
    }
    
    // 检查目标节点是否已有父节点
    const childTask = this.store.tasks().find(t => t.id === targetId);
    const sourceTask = this.store.tasks().find(t => t.id === sourceId);
    
    if (childTask?.parentId) {
      // 目标已有父节点，只能创建跨树连接
      // 场景二：若目标是"待分配块"，先将其任务化
      if (childTask.stage === null) {
        const inferredStage = sourceTask?.stage ?? 1;
        this.store.moveTaskToStage(targetId, inferredStage, undefined, null);
      }
      
      this.store.addCrossTreeConnection(sourceId, targetId);
      this.toast.success('已创建关联', '目标任务已有父级，已创建关联连接');
      return 'create-cross-tree';
    }
    
    // 目标没有父节点，显示选择对话框
    this.showLinkTypeDialog(sourceId, targetId, x, y);
    return 'show-dialog';
  }
  
  // ========== 联系块编辑器方法 ==========
  
  /**
   * 打开联系块编辑器
   */
  openConnectionEditor(
    sourceId: string,
    targetId: string,
    description: string,
    x: number,
    y: number
  ): void {
    // 调整位置
    const adjustedX = Math.max(10, x - 100);
    const adjustedY = Math.max(10, y - 20);
    
    this.connectionEditorData.set({
      sourceId,
      targetId,
      description,
      x: adjustedX,
      y: adjustedY
    });
    this.connectionEditorPos.set({ x: adjustedX, y: adjustedY });
    
    // 自动调整 textarea 高度
    setTimeout(() => {
      if (this.isDestroyed) return;
      const textarea = document.querySelector('#connectionDescTextarea') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
      }
    }, UI_CONFIG.SHORT_DELAY);
  }
  
  /**
   * 关闭联系块编辑器
   */
  closeConnectionEditor(): void {
    this.connectionEditorData.set(null);
  }
  
  /**
   * 保存联系块描述
   */
  saveConnectionDescription(description: string): void {
    const data = this.connectionEditorData();
    if (data) {
      this.store.updateConnectionDescription(data.sourceId, data.targetId, description);
      this.closeConnectionEditor();
    }
  }
  
  /**
   * 获取连接的源任务和目标任务
   */
  getConnectionTasks(): { source: Task | null; target: Task | null } {
    const data = this.connectionEditorData();
    if (!data) return { source: null, target: null };
    
    const tasks = this.store.tasks();
    return {
      source: tasks.find(t => t.id === data.sourceId) || null,
      target: tasks.find(t => t.id === data.targetId) || null
    };
  }
  
  /**
   * 开始拖动联系块编辑器
   */
  startDragConnEditor(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    const pos = this.connectionEditorPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    this.connEditorDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: pos.x,
      offsetY: pos.y
    };
    
    document.addEventListener('mousemove', this.onDragConnEditor);
    document.addEventListener('mouseup', this.stopDragConnEditor);
    document.addEventListener('touchmove', this.onDragConnEditor);
    document.addEventListener('touchend', this.stopDragConnEditor);
  }
  
  /**
   * 拖动中
   */
  private onDragConnEditor = (event: MouseEvent | TouchEvent): void => {
    if (!this.connEditorDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.connEditorDragState.startX;
    const deltaY = clientY - this.connEditorDragState.startY;
    
    const newX = Math.max(0, this.connEditorDragState.offsetX + deltaX);
    const newY = Math.max(0, this.connEditorDragState.offsetY + deltaY);
    
    this.zone.run(() => {
      this.connectionEditorPos.set({ x: newX, y: newY });
    });
  };
  
  /**
   * 停止拖动
   */
  private stopDragConnEditor = (): void => {
    this.connEditorDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  };
  
  // ========== 连接线删除方法 ==========
  
  /**
   * 显示连接线删除提示（移动端）
   */
  showLinkDeleteHint(link: any, x: number, y: number): void {
    this.linkDeleteHint.set({
      link,
      x,
      y,
      isCrossTree: !!link?.data?.isCrossTree
    });
    
    // 3秒后自动隐藏
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
    }
    
    const currentLink = link;
    this.linkDeleteHintTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      if (this.linkDeleteHint()?.link === currentLink) {
        this.linkDeleteHint.set(null);
      }
      this.linkDeleteHintTimer = null;
    }, 3000);
  }
  
  /**
   * 确认删除连接线
   * @returns 删除的连接线数据，如果没有则返回 null
   */
  confirmLinkDelete(): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const hint = this.linkDeleteHint();
    if (!hint?.link) return null;
    
    const result = this.deleteLinkInternal(hint.link);
    this.linkDeleteHint.set(null);
    return result;
  }
  
  /**
   * 取消删除提示
   */
  cancelLinkDelete(): void {
    this.linkDeleteHint.set(null);
  }
  
  /**
   * 从右键菜单删除连接
   */
  deleteLink(linkData: any): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const fromKey = linkData?.from;
    const toKey = linkData?.to;
    const isCrossTree = linkData?.isCrossTree;
    
    if (!fromKey || !toKey) return null;
    
    if (isCrossTree) {
      this.store.removeConnection(fromKey, toKey);
    } else {
      this.store.detachTask(toKey);
    }
    
    return { fromKey, toKey, isCrossTree };
  }
  
  // ========== 快捷键处理 ==========
  
  /**
   * 处理 Alt+X 快捷键删除选中的跨树连接
   * @param selectedLinks 选中的连接线数据列表
   */
  handleDeleteCrossTreeLinks(selectedLinks: any[]): void {
    selectedLinks.forEach(linkData => {
      if (linkData?.isCrossTree) {
        const fromKey = linkData.from;
        const toKey = linkData.to;
        if (fromKey && toKey) {
          this.store.removeConnection(fromKey, toKey);
        }
      }
    });
  }
  
  // ========== 清理方法 ==========
  
  /**
   * 清理资源
   */
  dispose(): void {
    this.isDestroyed = true;
    
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
      this.linkDeleteHintTimer = null;
    }
    
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  }
  
  /**
   * 重置状态（重新激活）
   */
  activate(): void {
    this.isDestroyed = false;
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 内部删除连接线方法
   */
  private deleteLinkInternal(link: any): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const fromKey = link.data?.from;
    const toKey = link.data?.to;
    const isCrossTree = link.data?.isCrossTree;
    
    if (!fromKey || !toKey) return null;
    
    if (isCrossTree) {
      this.store.removeConnection(fromKey, toKey);
    } else {
      this.store.detachTask(toKey);
    }
    
    return { fromKey, toKey, isCrossTree };
  }
}
