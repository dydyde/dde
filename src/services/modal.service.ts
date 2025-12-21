import { Injectable, signal, computed } from '@angular/core';
import { Project } from '../models';

/**
 * 模态框类型
 */
export type ModalType = 
  | 'settings'
  | 'login'
  | 'newProject'
  | 'deleteProject'
  | 'deleteTask'
  | 'conflict'
  | 'configHelp'
  | 'trash'
  | 'migration'
  | 'connectionEditor'
  | 'linkTypeDialog'
  | 'dashboard';

/**
 * 模态框状态
 */
export interface ModalState<T = unknown> {
  type: ModalType;
  data?: T;
  /** Promise 的 resolve 函数，用于返回结果 */
  resolve?: (result: unknown) => void;
}

/**
 * 模态框数据联合类型
 */
export type ModalData = 
  | DeleteProjectData
  | DeleteTaskData
  | ConflictData
  | ConnectionEditorData
  | LinkTypeData
  | LoginData
  | undefined;

export interface DeleteProjectData {
  projectId: string;
  projectName: string;
}

export interface DeleteTaskData {
  taskId: string;
  taskTitle: string;
  projectId: string;
}

export interface ConflictData {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
}

export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  currentDescription?: string;
}

export interface LinkTypeData {
  connectionId: string;
  currentType?: string;
}

export interface LoginData {
  returnUrl?: string;
  message?: string;
}

/**
 * 模态框结果类型
 */
export type ModalResult<T extends ModalType> = 
  T extends 'deleteProject' ? { confirmed: boolean } :
  T extends 'deleteTask' ? { confirmed: boolean; keepChildren?: boolean } :
  T extends 'conflict' ? { choice: 'local' | 'remote' | 'merge' | 'cancel' } :
  T extends 'login' ? { success: boolean; userId?: string } :
  T extends 'newProject' ? { name: string; description: string } | null :
  T extends 'connectionEditor' ? { description: string } | null :
  T extends 'linkTypeDialog' ? { linkType: string } | null :
  void;

/**
 * 统一模态框管理服务
 * 
 * 提供命令式 API 来管理模态框：
 * - open<T>(): Promise<Result> - 打开模态框并等待结果
 * - close(result?) - 关闭模态框并返回结果
 * - isOpen(type) - 检查特定类型的模态框是否打开
 * 
 * 使用示例：
 * ```typescript
 * // 打开删除确认并等待结果
 * const result = await modalService.open('deleteProject', { 
 *   projectId: '123', 
 *   projectName: 'My Project' 
 * });
 * if (result.confirmed) {
 *   await deleteProject('123');
 * }
 * 
 * // 打开登录模态框
 * const loginResult = await modalService.open('login', { returnUrl: '/projects/123' });
 * if (loginResult.success) {
 *   router.navigate([loginResult.returnUrl]);
 * }
 * ```
 */
@Injectable({
  providedIn: 'root'
})
export class ModalService {
  /** 当前打开的模态框栈 */
  private modalStack = signal<ModalState[]>([]);
  
  /** 当前最顶层的模态框 */
  readonly currentModal = computed(() => {
    const stack = this.modalStack();
    return stack.length > 0 ? stack[stack.length - 1] : null;
  });
  
  /** 是否有任何模态框打开 */
  readonly hasOpenModal = computed(() => this.modalStack().length > 0);
  
  /** 模态框栈深度 */
  readonly stackDepth = computed(() => this.modalStack().length);
  
  /** 用于触发模态框闪烁效果的 signal */
  readonly flashModalType = signal<ModalType | null>(null);
  
  /**
   * 打开模态框（命令式 API）
   * @param type 模态框类型
   * @param data 可选的模态框数据
   * @returns Promise 包含模态框关闭时的结果
   */
  open<T extends ModalType>(type: T, data?: ModalDataForType<T>): Promise<ModalResult<T>> {
    return new Promise((resolve) => {
      // 检查是否已经打开同类型的模态框
      const existing = this.modalStack().find(m => m.type === type);
      if (existing) {
        // 触发闪烁效果提示用户该模态框已打开
        this.flashModalType.set(type);
        setTimeout(() => this.flashModalType.set(null), 300);
        
        // 返回默认的取消结果
        resolve(this.getDefaultResult(type) as ModalResult<T>);
        return;
      }
      
      this.modalStack.update(stack => [...stack, { 
        type, 
        data, 
        resolve: resolve as (result: unknown) => void 
      }]);
    });
  }
  
  /**
   * 打开模态框（不等待结果，传统用法）
   * @param type 模态框类型
   * @param data 可选的模态框数据
   */
  show<T extends ModalType>(type: T, data?: ModalDataForType<T>): void {
    // 检查是否已经打开同类型的模态框
    const existing = this.modalStack().find(m => m.type === type);
    if (existing) {
      // 触发闪烁效果提示用户该模态框已打开
      this.flashModalType.set(type);
      setTimeout(() => this.flashModalType.set(null), 300);
      return;
    }
    
    this.modalStack.update(stack => [...stack, { type, data }]);
  }
  
  /**
   * 关闭当前模态框并返回结果
   * @param result 模态框的返回结果
   */
  close<T = unknown>(result?: T): void {
    const stack = this.modalStack();
    if (stack.length === 0) return;
    
    const current = stack[stack.length - 1];
    
    // 如果有 resolve 函数（Promise 模式），调用它
    if (current.resolve) {
      current.resolve(result ?? this.getDefaultResult(current.type));
    }
    
    this.modalStack.update(s => s.slice(0, -1));
  }
  
  /**
   * 关闭特定类型的模态框
   * @param type 模态框类型
   * @param result 可选的返回结果
   */
  closeByType<T extends ModalType>(type: T, result?: ModalResult<T>): void {
    const stack = this.modalStack();
    const modal = stack.find(m => m.type === type);
    
    if (modal?.resolve) {
      modal.resolve(result ?? this.getDefaultResult(type));
    }
    
    this.modalStack.update(s => s.filter(m => m.type !== type));
  }
  
  /**
   * 关闭所有模态框
   */
  closeAll(): void {
    const stack = this.modalStack();
    
    // 为所有有 Promise 的模态框返回默认结果
    for (const modal of stack) {
      if (modal.resolve) {
        modal.resolve(this.getDefaultResult(modal.type));
      }
    }
    
    this.modalStack.set([]);
  }
  
  /**
   * 检查特定类型的模态框是否打开
   */
  isOpen(type: ModalType): boolean {
    return this.modalStack().some(m => m.type === type);
  }
  
  /**
   * 获取特定类型模态框的数据
   */
  getData<T extends ModalType>(type: T): ModalDataForType<T> | undefined {
    const modal = this.modalStack().find(m => m.type === type);
    return modal?.data as ModalDataForType<T> | undefined;
  }
  
  /**
   * 更新当前模态框的数据
   */
  updateData(data: Partial<ModalData>): void {
    this.modalStack.update(stack => {
      if (stack.length === 0) return stack;
      const newStack = [...stack];
      const lastIndex = newStack.length - 1;
      const currentData = newStack[lastIndex].data;
      newStack[lastIndex] = {
        ...newStack[lastIndex],
        data: typeof currentData === 'object' && currentData !== null
          ? { ...currentData, ...data }
          : data
      };
      return newStack;
    });
  }
  
  /**
   * 获取模态框类型的默认返回结果
   */
  private getDefaultResult(type: ModalType): unknown {
    switch (type) {
      case 'deleteProject':
      case 'deleteTask':
        return { confirmed: false };
      case 'conflict':
        return { choice: 'cancel' };
      case 'login':
        return { success: false };
      case 'newProject':
      case 'connectionEditor':
      case 'linkTypeDialog':
        return null;
      default:
        return undefined;
    }
  }
}

/**
 * 类型辅助：根据模态框类型获取对应的数据类型
 */
type ModalDataForType<T extends ModalType> = 
  T extends 'deleteProject' ? DeleteProjectData :
  T extends 'deleteTask' ? DeleteTaskData :
  T extends 'conflict' ? ConflictData :
  T extends 'connectionEditor' ? ConnectionEditorData :
  T extends 'linkTypeDialog' ? LinkTypeData :
  T extends 'login' ? LoginData :
  undefined;
