import { Injectable, inject, signal, NgZone, DestroyRef } from '@angular/core';
import { StoreService } from '../../../../services/store.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { 
  LinkTypeDialogData, 
  ConnectionEditorData, 
  LinkDeleteHint,
  PanelPosition,
  DragState,
  createInitialDragState
} from '../../../../models/flow-view-state';
import { UI_CONFIG } from '../../../../config';

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
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLink');
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
  
  /** 流程图容器边界（用于限制关联块编辑器拖动范围） */
  private diagramBounds: { left: number; top: number; right: number; bottom: number } | null = null;
  
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
  ): 'show-dialog' | 'create-cross-tree' | 'create-parent-child' | 'none' {
    // 防止自连接
    if (sourceId === targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'none';
    }
    
    // 检查目标节点是否已有父节点
    const childTask = this.store.tasks().find(t => t.id === targetId);
    const sourceTask = this.store.tasks().find(t => t.id === sourceId);
    
    if (childTask?.parentId) {
      // 🔴 浮动任务树特殊处理：待分配子任务可以被“认领”
      // 如果目标是待分配区的子任务，允许将其分配到已分配区成为新父任务的子任务
      if (sourceTask && childTask.stage === null && sourceTask.stage !== null && sourceTask.stage !== undefined) {
        const targetStage = sourceTask.stage + 1;
        // 将待分配子任务及其子树分配到新父任务下
        const result = this.store.moveTaskToStage(targetId, targetStage, undefined, sourceId);
        if (result.ok) {
          this.toast.success('已分配任务', `"${childTask.title}" 已成为新任务的子任务`);
          return 'create-parent-child';
        } else {
          this.toast.error('分配失败', result.error?.message || '未知错误');
          return 'none';
        }
      }
      
      // 目标已有父节点且已分配，只能创建跨树连接
      this.store.addCrossTreeConnection(sourceId, targetId);
      this.toast.success('已创建关联', '目标任务已有父级，已创建关联连接');
      return 'create-cross-tree';
    }
    
    // 目标没有父节点，显示选择对话框
    this.showLinkTypeDialog(sourceId, targetId, x, y);
    return 'show-dialog';
  }
  
  // ========== 子树迁移处理 ==========
  
  /**
   * 处理父子连接的重连（子树迁移）
   * 当用户拖动父子连接线的终点到新的父节点时调用
   * 
   * @param childTaskId 被迁移的子任务 ID（连接线的目标端）
   * @param oldParentId 原父任务 ID（连接线的原始源端）
   * @param newParentId 新父任务 ID（连接线的新源端）
   * @returns 操作结果：'success' | 'cancelled' | 'error'
   */
  handleParentChildRelink(
    childTaskId: string,
    oldParentId: string,
    newParentId: string
  ): 'success' | 'cancelled' | 'error' {
    // 防止自连接
    if (childTaskId === newParentId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'error';
    }
    
    // 如果新旧父节点相同，无需操作
    if (oldParentId === newParentId) {
      this.logger.debug('父节点未变化，跳过迁移');
      return 'cancelled';
    }
    
    const tasks = this.store.tasks();
    const childTask = tasks.find(t => t.id === childTaskId);
    const newParentTask = tasks.find(t => t.id === newParentId);
    
    if (!childTask) {
      this.toast.error('迁移失败', '找不到要迁移的任务');
      return 'error';
    }
    
    if (!newParentTask) {
      this.toast.error('迁移失败', '找不到目标父任务');
      return 'error';
    }
    
    // 收集子树信息用于提示
    const subtreeIds = this.collectSubtreeIds(childTaskId, tasks);
    const subtreeCount = subtreeIds.size;
    
    this.logger.info('执行子树迁移', {
      childTaskId,
      childTitle: childTask.title,
      oldParentId,
      newParentId,
      newParentTitle: newParentTask.title,
      subtreeCount
    });
    
    // 执行迁移
    const result = this.store.moveSubtreeToNewParent(childTaskId, newParentId);
    
    if (result.ok) {
      if (subtreeCount > 1) {
        this.toast.success(
          '子树迁移成功', 
          `已将 "${childTask.title}" 及其 ${subtreeCount - 1} 个子任务移动到 "${newParentTask.title}" 下`
        );
      } else {
        this.toast.success(
          '任务迁移成功', 
          `已将 "${childTask.title}" 移动到 "${newParentTask.title}" 下`
        );
      }
      return 'success';
    } else {
      const errorMessage = result.error?.message || '未知错误';
      this.toast.error('迁移失败', errorMessage);
      return 'error';
    }
  }
  
  /**
   * 处理跨树连接的重连
   * 当用户拖动跨树连接线的起点或终点到新节点时调用
   * 
   * @param oldSourceId 原始起点节点 ID
   * @param oldTargetId 原始终点节点 ID  
   * @param newSourceId 新的起点节点 ID
   * @param newTargetId 新的终点节点 ID
   * @param changedEnd 'from' | 'to' 哪一端被改变了
   * @returns 操作结果：'success' | 'cancelled' | 'error'
   */
  handleCrossTreeRelink(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string,
    changedEnd: 'from' | 'to'
  ): 'success' | 'cancelled' | 'error' {
    // 防止自连接
    if (newSourceId === newTargetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'error';
    }
    
    // 如果起点终点都没变，无需操作
    if (oldSourceId === newSourceId && oldTargetId === newTargetId) {
      this.logger.debug('跨树连接未变化，跳过');
      return 'cancelled';
    }
    
    const tasks = this.store.tasks();
    const sourceTask = tasks.find(t => t.id === newSourceId);
    const targetTask = tasks.find(t => t.id === newTargetId);
    
    if (!sourceTask) {
      this.toast.error('重连失败', '找不到起点任务');
      return 'error';
    }
    
    if (!targetTask) {
      this.toast.error('重连失败', '找不到终点任务');
      return 'error';
    }
    
    // 检查是否已存在相同的跨树连接（排除已软删除的）
    const project = this.store.activeProject();
    const existingConnection = project?.connections?.find(
      c => c.source === newSourceId && c.target === newTargetId && !c.deletedAt
    );
    
    if (existingConnection) {
      this.toast.warning('连接已存在', `"${sourceTask.title}" 到 "${targetTask.title}" 的关联已存在`);
      return 'cancelled';
    }
    
    this.logger.info('执行跨树连接重连', {
      oldSourceId,
      oldTargetId,
      newSourceId,
      newTargetId,
      changedEnd,
      sourceTitle: sourceTask.title,
      targetTitle: targetTask.title
    });
    
    // 使用原子操作：在一个撤销单元内删除旧连接并创建新连接
    this.store.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
    
    const changedEndText = changedEnd === 'from' ? '起点' : '终点';
    this.toast.success(
      '关联重连成功', 
      `已将关联${changedEndText}从 "${changedEnd === 'from' ? tasks.find(t => t.id === oldSourceId)?.title : tasks.find(t => t.id === oldTargetId)?.title}" 移动到 "${changedEnd === 'from' ? sourceTask.title : targetTask.title}"`
    );
    
    return 'success';
  }
  
  /**
   * 处理将子树迁移到根节点（stage 1）
   * @param childTaskId 被迁移的子任务 ID
   * @param oldParentId 原父任务 ID
   */
  handleMoveSubtreeToRoot(childTaskId: string, oldParentId: string): 'success' | 'cancelled' | 'error' {
    const tasks = this.store.tasks();
    const childTask = tasks.find(t => t.id === childTaskId);
    
    if (!childTask) {
      this.toast.error('迁移失败', '找不到要迁移的任务');
      return 'error';
    }
    
    // 收集子树信息
    const subtreeIds = this.collectSubtreeIds(childTaskId, tasks);
    const subtreeCount = subtreeIds.size;
    
    this.logger.info('执行子树迁移到根节点', {
      childTaskId,
      childTitle: childTask.title,
      oldParentId,
      subtreeCount
    });
    
    // 执行迁移（newParentId = null 表示迁移到根节点）
    const result = this.store.moveSubtreeToNewParent(childTaskId, null);
    
    if (result.ok) {
      if (subtreeCount > 1) {
        this.toast.success(
          '子树迁移成功', 
          `已将 "${childTask.title}" 及其 ${subtreeCount - 1} 个子任务提升为根任务`
        );
      } else {
        this.toast.success(
          '任务迁移成功', 
          `已将 "${childTask.title}" 提升为根任务`
        );
      }
      return 'success';
    } else {
      const errorMessage = result.error?.message || '未知错误';
      this.toast.error('迁移失败', errorMessage);
      return 'error';
    }
  }
  
  /**
   * 收集指定任务及其所有后代的 ID
   */
  private collectSubtreeIds(taskId: string, tasks: Task[]): Set<string> {
    const result = new Set<string>();
    const stack = [taskId];
    
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      result.add(currentId);
      tasks.filter(t => t.parentId === currentId && !t.deletedAt).forEach(child => {
        stack.push(child.id);
      });
    }
    
    return result;
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
    y: number,
    title?: string
  ): void {
    console.log('[FlowLink] openConnectionEditor 被调用', { sourceId, targetId, title, description, x, y });
    
    // 编辑器尺寸
    const editorWidth = 176;  // w-44 = 11rem = 176px
    const editorHeight = 140; // 估算高度
    const padding = 8;
    
    // 将编辑器居中对齐到点击位置，并向上偏移使其显示在关联块正上方
    let adjustedX = x - editorWidth / 2;
    let adjustedY = y - editorHeight - 10; // 向上偏移，留 10px 间距
    
    // 获取流程图容器边界，限制编辑器在流程图区域内
    const diagramDiv = document.querySelector('[data-testid="flow-diagram"]');
    if (diagramDiv) {
      const rect = diagramDiv.getBoundingClientRect();
      const minX = rect.left + padding;
      const minY = rect.top + padding;
      const maxX = rect.right - editorWidth - padding;
      const maxY = rect.bottom - editorHeight - padding;
      
      adjustedX = Math.max(minX, Math.min(maxX, adjustedX));
      adjustedY = Math.max(minY, Math.min(maxY, adjustedY));
    } else {
      // 兜底：保持在视口内
      adjustedX = Math.max(10, adjustedX);
      adjustedY = Math.max(10, adjustedY);
    }
    
    const editorData = {
      sourceId,
      targetId,
      title: title || '',
      description,
      x: adjustedX,
      y: adjustedY
    };
    console.log('[FlowLink] 设置 connectionEditorData', editorData);
    
    this.connectionEditorData.set(editorData);
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
    console.log('[FlowLink] closeConnectionEditor 被调用', new Error().stack);
    this.connectionEditorData.set(null);
  }
  
  /**
   * 保存联系块内容（标题和描述）
   * @param title 标题（外显内容）
   * @param description 描述（悬停显示）
   */
  saveConnectionContent(title: string, description: string): void {
    const data = this.connectionEditorData();
    if (data) {
      this.store.updateConnectionContent(data.sourceId, data.targetId, title, description);
      // 更新本地数据，保持编辑器状态同步
      this.connectionEditorData.set({
        ...data,
        title,
        description
      });
    }
  }
  
  /**
   * 保存联系块描述（兼容旧 API）
   * @deprecated 使用 saveConnectionContent 代替
   */
  saveConnectionDescription(description: string): void {
    const data = this.connectionEditorData();
    if (data) {
      this.store.updateConnectionContent(data.sourceId, data.targetId, data.title, description);
      // 更新本地数据，保持编辑器状态同步
      this.connectionEditorData.set({
        ...data,
        description
      });
    }
  }
  
  /**
   * 删除当前编辑的连接
   * @returns 是否成功删除
   */
  deleteCurrentConnection(): boolean {
    const data = this.connectionEditorData();
    if (!data) {
      this.logger.warn('deleteCurrentConnection: 没有当前编辑的连接数据');
      return false;
    }
    
    this.logger.info('删除跨树连接', { sourceId: data.sourceId, targetId: data.targetId });
    // 删除跨树连接
    this.store.removeConnection(data.sourceId, data.targetId);
    // 关闭编辑器
    this.closeConnectionEditor();
    return true;
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
    
    // 获取流程图容器边界
    this.updateDiagramBounds();
    
    document.addEventListener('mousemove', this.onDragConnEditor);
    document.addEventListener('mouseup', this.stopDragConnEditor);
    document.addEventListener('touchmove', this.onDragConnEditor);
    document.addEventListener('touchend', this.stopDragConnEditor);
  }
  
  /**
   * 更新流程图容器边界
   * 关联块编辑器只能在流程图区域内拖动
   */
  updateDiagramBounds(): void {
    const diagramDiv = document.querySelector('[data-testid="flow-diagram"]');
    if (diagramDiv) {
      const rect = diagramDiv.getBoundingClientRect();
      this.diagramBounds = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
    } else {
      this.diagramBounds = null;
    }
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
    
    // 编辑器尺寸（用于边界计算）
    const editorWidth = 176;  // w-44 = 11rem = 176px
    const editorHeight = 140; // 估算高度
    const padding = 8;        // 边缘内边距
    
    let newX = this.connEditorDragState.offsetX + deltaX;
    let newY = this.connEditorDragState.offsetY + deltaY;
    
    // 如果有流程图边界，限制在流程图区域内
    if (this.diagramBounds) {
      const minX = this.diagramBounds.left + padding;
      const minY = this.diagramBounds.top + padding;
      const maxX = this.diagramBounds.right - editorWidth - padding;
      const maxY = this.diagramBounds.bottom - editorHeight - padding;
      
      newX = Math.max(minX, Math.min(maxX, newX));
      newY = Math.max(minY, Math.min(maxY, newY));
    } else {
      // 兜底：至少保持在视口内
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
    }
    
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
   * @param linkData GoJS 连接线数据对象（包含 from, to, isCrossTree 等属性）
   * @param x 显示位置 X
   * @param y 显示位置 Y
   */
  showLinkDeleteHint(linkData: any, x: number, y: number): void {
    // 注意：linkData 是连接线的数据对象，直接包含属性
    this.linkDeleteHint.set({
      link: { data: linkData }, // 包装成期望的格式
      x,
      y,
      isCrossTree: !!linkData?.isCrossTree
    });
    
    // 3秒后自动隐藏
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
    }
    
    const currentLinkData = linkData;
    this.linkDeleteHintTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      const currentHint = this.linkDeleteHint();
      if (currentHint?.link?.data === currentLinkData) {
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
    this.logger.info('confirmLinkDelete 被调用', { hint });
    
    if (!hint?.link) {
      this.logger.warn('confirmLinkDelete: 没有删除提示数据');
      return null;
    }
    
    const result = this.deleteLinkInternal(hint.link);
    this.logger.info('删除连接线完成', result);
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
    
    this.logger.info('deleteLinkInternal', { fromKey, toKey, isCrossTree, link });
    
    if (!fromKey || !toKey) {
      this.logger.warn('deleteLinkInternal: 缺少 fromKey 或 toKey');
      return null;
    }
    
    if (isCrossTree) {
      this.logger.info('删除跨树连接', { fromKey, toKey });
      this.store.removeConnection(fromKey, toKey);
    } else {
      this.logger.info('解除父子关系', { toKey });
      this.store.detachTask(toKey);
    }
    
    return { fromKey, toKey, isCrossTree };
  }
}
