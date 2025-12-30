import { Injectable, inject, ElementRef } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment } from '../../../../models';
import { isFailure, getErrorMessage } from '../../../../utils/result';
import { UI_CONFIG } from '../../../../config';

/**
 * FlowTaskOperationsService - 任务操作代理服务
 * 
 * 职责：
 * - 代理任务详情面板的各种操作
 * - 任务属性更新（标题、内容、优先级、截止日期）
 * - 标签管理
 * - 附件管理
 * - 任务状态切换
 * - 添加同级/子任务
 * 
 * 设计原则：
 * - 简化 FlowViewComponent 的代码
 * - 统一任务操作的入口
 * - 处理操作结果和错误提示
 */
@Injectable({
  providedIn: 'root'
})
export class FlowTaskOperationsService {
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly toast = inject(ToastService);
  
  // ========== 任务属性更新 ==========
  
  /**
   * 更新任务标题
   */
  updateTaskTitle(taskId: string, title: string): void {
    this.taskOps.updateTaskTitle(taskId, title);
  }
  
  /**
   * 更新任务内容
   */
  updateTaskContent(taskId: string, content: string): void {
    this.taskOps.updateTaskContent(taskId, content);
  }
  
  /**
   * 更新任务优先级
   */
  updateTaskPriority(taskId: string, priority: string | undefined): void {
    const validPriority = priority as 'low' | 'medium' | 'high' | 'urgent' | undefined;
    this.taskOps.updateTaskPriority(taskId, validPriority);
  }
  
  /**
   * 更新任务截止日期
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    this.taskOps.updateTaskDueDate(taskId, dueDate);
  }
  
  // ========== 标签管理 ==========
  
  /**
   * 添加标签
   */
  addTaskTag(taskId: string, tag: string): void {
    if (tag?.trim()) {
      this.taskOps.addTaskTag(taskId, tag.trim());
    }
  }
  
  /**
   * 移除标签
   */
  removeTaskTag(taskId: string, tag: string): void {
    this.taskOps.removeTaskTag(taskId, tag);
  }
  
  // ========== 待办事项 ==========
  
  /**
   * 快速添加待办
   */
  addQuickTodo(taskId: string, text: string): void {
    if (!text?.trim()) return;
    this.taskOps.addTodoItem(taskId, text.trim());
  }
  
  // ========== 任务层级操作 ==========
  
  /**
   * 添加同级任务
   * 
   * 【浮动任务树支持】
   * - 待分配任务也可以添加同级任务，共享相同的 parentId
   * - 新任务将继承当前任务的 stage 和 parentId
   * 
   * @returns 新任务ID，如果失败返回 null
   */
  addSiblingTask(task: Task): string | null {
    const result = this.taskOps.addTask('', '', task.stage, task.parentId, true);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
      return null;
    }
    return result.value;
  }
  
  /**
   * 添加子任务
   * 
   * 【浮动任务树支持】
   * - 待分配任务也可以添加子任务，形成待分配区的任务树
   * - 待分配任务的子任务 stage 保持为 null
   * - 已分配任务的子任务 stage = 父任务 stage + 1
   * 
   * @returns 新任务ID，如果失败返回 null
   */
  addChildTask(task: Task): string | null {
    // 如果父任务是待分配的，子任务也保持待分配状态
    // 否则子任务的 stage = 父任务 stage + 1
    const childStage = task.stage === null ? null : task.stage + 1;
    
    const result = this.taskOps.addTask('', '', childStage, task.id, false);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
      return null;
    }
    
    return result.value;
  }
  
  /**
   * 聚焦到标题输入框
   * 用于添加任务后自动聚焦
   */
  focusTitleInput(containerElement: ElementRef | HTMLElement): void {
    const element = containerElement instanceof ElementRef 
      ? containerElement.nativeElement 
      : containerElement;
    
    setTimeout(() => {
      const panel = element.querySelector('.detail-panel-content, .mobile-drawer-content');
      if (panel) {
        const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
        if (input) {
          input.focus();
          input.select();
        }
      }
    }, UI_CONFIG.INPUT_FOCUS_DELAY);
  }
  
  // ========== 任务状态操作 ==========
  
  /**
   * 切换任务状态
   */
  toggleTaskStatus(task: Task): void {
    const newStatus = task.status === 'completed' ? 'active' : 'completed';
    this.taskOps.updateTaskStatus(task.id, newStatus);
  }
  
  /**
   * 归档/取消归档任务
   * @returns 新状态
   */
  archiveTask(task: Task): 'active' | 'archived' {
    const newStatus = task.status === 'archived' ? 'active' : 'archived';
    this.taskOps.updateTaskStatus(task.id, newStatus);
    return newStatus;
  }
  
  /**
   * 删除任务
   * @param keepChildren 是否保留子任务
   */
  deleteTask(taskId: string, keepChildren: boolean = false): void {
    if (keepChildren) {
      this.taskOps.deleteTaskKeepChildren(taskId);
    } else {
      this.taskOps.deleteTask(taskId);
    }
  }
  
  /**
   * 批量删除任务（原子操作）
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns 实际删除的任务数量（含级联子任务）
   */
  deleteTasksBatch(explicitIds: string[]): number {
    return this.taskOps.deleteTasksBatch(explicitIds);
  }
  
  /**
   * 计算批量删除将影响的任务数量（含级联子任务）
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.taskOps.calculateBatchDeleteImpact(explicitIds);
  }
  
  /**
   * 检查任务是否有子任务
   */
  hasChildren(task: Task): boolean {
    return this.projectState.tasks().some(t => t.parentId === task.id && !t.deletedAt);
  }
  
  // ========== 附件管理 ==========
  
  /**
   * 附件变更处理（全量替换）
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    this.taskOps.updateTaskAttachments(taskId, attachments);
  }
  
  /**
   * 添加单个附件
   */
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    this.taskOps.addTaskAttachment(taskId, attachment);
  }
  
  /**
   * 移除单个附件
   */
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    this.taskOps.removeTaskAttachment(taskId, attachmentId);
  }
  
  /**
   * 处理附件错误
   */
  handleAttachmentError(error: string): void {
    this.toast.error('附件操作失败', error);
  }
  
  // ========== 未分配任务操作 ==========
  
  /**
   * 创建未分配任务
   * @returns 新任务ID，如果失败返回 null
   */
  createUnassignedTask(title: string = '新任务'): string | null {
    const result = this.taskOps.addTask(title, '', null, null, false);
    if (isFailure(result)) {
      this.toast.error('创建任务失败', getErrorMessage(result.error));
      return null;
    }
    return result.value;
  }
  
  /**
   * 解除任务分配（移回待分配区域）
   */
  detachTask(taskId: string): void {
    const task = this.projectState.tasks().find(t => t.id === taskId);
    this.taskOps.detachTask(taskId);
    if (task) {
      this.toast.success('已移至待分配', `任务 "${task.title}" 已解除分配`);
    }
  }
  
  /**
   * 释放资源
   * 服务本身是无状态的代理，无需清理，但提供统一接口
   */
  dispose(): void {
    // 无状态服务，无需清理
  }
}
