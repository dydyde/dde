import { Injectable, signal, computed } from '@angular/core';
import { Project, Task } from '../models';

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
  | 'connectionEditor'
  | 'linkTypeDialog';

/**
 * 模态框状态
 */
export interface ModalState {
  type: ModalType;
  data?: ModalData;
}

/**
 * 模态框数据联合类型
 */
export type ModalData = 
  | DeleteProjectData
  | DeleteTaskData
  | ConflictData
  | ConnectionEditorData
  | LinkTypeData;

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

/**
 * 统一模态框管理服务
 * 
 * 提供集中化的模态框状态管理，避免在各组件中分散管理多个模态框状态
 * 
 * 使用方式：
 * ```typescript
 * // 打开模态框
 * modalService.open('deleteProject', { projectId: '123', projectName: 'My Project' });
 * 
 * // 关闭模态框
 * modalService.close();
 * 
 * // 检查是否打开
 * if (modalService.isOpen('deleteProject')) { ... }
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
  
  /**
   * 打开模态框
   * @param type 模态框类型
   * @param data 可选的模态框数据
   */
  open<T extends ModalType>(type: T, data?: ModalDataForType<T>): void {
    // 检查是否已经打开同类型的模态框
    const existing = this.modalStack().find(m => m.type === type);
    if (existing) {
      console.warn(`Modal of type "${type}" is already open`);
      return;
    }
    
    this.modalStack.update(stack => [...stack, { type, data }]);
  }
  
  /**
   * 关闭当前模态框
   */
  close(): void {
    this.modalStack.update(stack => stack.slice(0, -1));
  }
  
  /**
   * 关闭特定类型的模态框
   */
  closeByType(type: ModalType): void {
    this.modalStack.update(stack => stack.filter(m => m.type !== type));
  }
  
  /**
   * 关闭所有模态框
   */
  closeAll(): void {
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
      newStack[lastIndex] = {
        ...newStack[lastIndex],
        data: { ...newStack[lastIndex].data, ...data } as ModalData
      };
      return newStack;
    });
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
  undefined;
