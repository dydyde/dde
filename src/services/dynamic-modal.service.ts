/**
 * DynamicModalService - 指令式动态模态框渲染服务
 * 
 * 核心设计理念：
 * - 不再使用 *ngIf 触发模板显隐（"开关式"的陈旧思维）
 * - 调用 open(ComponentType) 直接渲染内容到 DOM
 * - 关闭时销毁组件，DOM 树保持干净
 * - 弹窗存在时才渲染节点，关闭即销毁
 * 
 * 使用示例：
 * ```typescript
 * const result = await dynamicModal.open(DeleteConfirmModalComponent, {
 *   title: '删除项目',
 *   itemName: 'My Project'
 * });
 * if (result.confirmed) {
 *   await deleteProject(projectId);
 * }
 * ```
 */
import {
  Injectable,
  ApplicationRef,
  createComponent,
  EnvironmentInjector,
  Type,
  ComponentRef,
  inject,
  signal,
  computed,
  Injector,
  DestroyRef
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Subscription } from 'rxjs';

/** 模态框配置接口 */
export interface ModalConfig<T = unknown> {
  /** 传递给组件的数据 */
  data?: T;
  /** 是否显示遮罩层 */
  hasBackdrop?: boolean;
  /** 点击遮罩层是否关闭 */
  closeOnBackdropClick?: boolean;
  /** 按 ESC 是否关闭 */
  closeOnEscape?: boolean;
  /** 自定义容器选择器（默认 body） */
  containerSelector?: string;
  /** 模态框 z-index 层级 */
  zIndex?: number;
}

/** 模态框引用，用于控制已打开的模态框 */
export interface ModalRef<R = unknown> {
  /** 关闭模态框并返回结果 */
  close: (result?: R) => void;
  /** 获取模态框结果的 Promise */
  result: Promise<R>;
  /** 组件实例 */
  componentRef: ComponentRef<unknown>;
}

/** 模态框栈项 */
interface ModalStackItem {
  id: string;
  componentRef: ComponentRef<unknown>;
  backdropElement?: HTMLElement;
  containerElement: HTMLElement;
  resolve: (result: unknown) => void;
  config: ModalConfig;
  escapeListener?: (e: KeyboardEvent) => void;
  /** 订阅清理数组 */
  subscriptions: Subscription[];
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<Omit<ModalConfig, 'data' | 'containerSelector'>> = {
  hasBackdrop: true,
  closeOnBackdropClick: true,
  closeOnEscape: true,
  zIndex: 1000
};

/**
 * 动态模态框服务
 * 
 * 职责：
 * - 动态创建和销毁模态框组件
 * - 管理模态框栈（支持多层嵌套）
 * - 处理遮罩层、键盘事件、焦点管理
 */
@Injectable({
  providedIn: 'root'
})
export class DynamicModalService {
  private appRef = inject(ApplicationRef);
  private injector = inject(EnvironmentInjector);
  private document = inject(DOCUMENT);
  private destroyRef = inject(DestroyRef);
  
  /** 模态框栈 */
  private modalStack = signal<ModalStackItem[]>([]);
  
  /** 当前打开的模态框数量 */
  readonly stackDepth = computed(() => this.modalStack().length);
  
  /** 是否有任何模态框打开 */
  readonly hasOpenModal = computed(() => this.modalStack().length > 0);
  
  /** 模态框 ID 计数器 */
  private idCounter = 0;
  
  constructor() {
    // 清理：服务销毁时关闭所有模态框
    this.destroyRef.onDestroy(() => {
      this.closeAll();
    });
  }
  
  /**
   * 打开模态框（指令式 API）
   * 
   * @param component 要渲染的组件类型
   * @param config 模态框配置（包含传递给组件的数据）
   * @returns ModalRef 包含 close 方法和 result Promise
   * 
   * 组件约定：
   * - 组件应该注入 MODAL_DATA 获取传入数据
   * - 组件应该注入 ModalRef 来关闭自身
   * - 或者组件可以 emit close 事件
   */
  open<C, D = unknown, R = unknown>(
    component: Type<C>,
    config: ModalConfig<D> = {}
  ): ModalRef<R> {
    const mergedConfig: Required<Omit<ModalConfig<D>, 'data' | 'containerSelector'>> & Pick<ModalConfig<D>, 'data' | 'containerSelector'> = {
      ...DEFAULT_CONFIG,
      ...config
    };
    
    const modalId = `modal-${++this.idCounter}`;
    
    // 创建结果 Promise
    let resolvePromise: (result: R) => void;
    const resultPromise = new Promise<R>((resolve) => {
      resolvePromise = resolve;
    });
    
    // 获取或创建容器
    const container = this.getOrCreateContainer(mergedConfig.containerSelector);
    
    // 创建模态框容器元素
    const modalContainer = this.document.createElement('div');
    modalContainer.id = modalId;
    modalContainer.className = 'dynamic-modal-container';
    modalContainer.style.cssText = `
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: ${mergedConfig.zIndex + this.modalStack().length};
    `;
    
    // 创建遮罩层
    let backdropElement: HTMLElement | undefined;
    if (mergedConfig.hasBackdrop) {
      backdropElement = this.document.createElement('div');
      backdropElement.className = 'dynamic-modal-backdrop';
      backdropElement.style.cssText = `
        position: absolute;
        inset: 0;
        background-color: rgba(0, 0, 0, 0.5);
        transition: opacity 150ms ease-out;
      `;
      
      if (mergedConfig.closeOnBackdropClick) {
        backdropElement.addEventListener('click', () => {
          this.closeById(modalId);
        });
      }
      
      modalContainer.appendChild(backdropElement);
    }
    
    // 创建内容包装器
    const contentWrapper = this.document.createElement('div');
    contentWrapper.className = 'dynamic-modal-content';
    contentWrapper.style.cssText = `
      position: relative;
      z-index: 1;
    `;
    modalContainer.appendChild(contentWrapper);
    
    // 将容器添加到 DOM
    container.appendChild(modalContainer);
    
    // 创建关闭函数
    const closeModal = (result?: R) => {
      this.closeById(modalId, result);
    };
    
    // 创建自定义注入器，注入数据和 ModalRef
    const modalRefToken = {
      close: closeModal,
      result: resultPromise,
      componentRef: null as unknown as ComponentRef<C>
    };
    
    const customInjector = Injector.create({
      providers: [
        { provide: MODAL_DATA, useValue: config.data },
        { provide: MODAL_REF, useValue: modalRefToken }
      ],
      parent: this.injector
    });
    
    // 动态创建组件
    const componentRef = createComponent(component, {
      environmentInjector: this.injector,
      elementInjector: customInjector,
      hostElement: contentWrapper
    });
    
    // 更新 modalRefToken 的 componentRef
    modalRefToken.componentRef = componentRef;
    
    // 订阅收集器
    const subscriptions: Subscription[] = [];
    
    // 监听组件的 close 事件（如果存在）
    const instance = componentRef.instance as any;
    if (instance.close && typeof instance.close.subscribe === 'function') {
      const sub = instance.close.subscribe((result: R) => {
        closeModal(result);
      });
      subscriptions.push(sub);
    }
    // 也支持 confirm/cancel 事件模式
    if (instance.confirm && typeof instance.confirm.subscribe === 'function') {
      const sub = instance.confirm.subscribe((data: any) => {
        closeModal(data as R);
      });
      subscriptions.push(sub);
    }
    
    // 附加到 Angular 应用
    this.appRef.attachView(componentRef.hostView);
    
    // ESC 键处理
    let escapeListener: ((e: KeyboardEvent) => void) | undefined;
    if (mergedConfig.closeOnEscape) {
      escapeListener = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          // 只关闭栈顶的模态框
          const stack = this.modalStack();
          if (stack.length > 0 && stack[stack.length - 1].id === modalId) {
            closeModal();
          }
        }
      };
      this.document.addEventListener('keydown', escapeListener);
    }
    
    // 添加到栈
    this.modalStack.update(stack => [...stack, {
      id: modalId,
      componentRef,
      backdropElement,
      containerElement: modalContainer,
      resolve: resolvePromise! as (result: unknown) => void,
      config: mergedConfig,
      escapeListener,
      subscriptions
    }]);
    
    // 焦点管理：聚焦到模态框内第一个可聚焦元素
    requestAnimationFrame(() => {
      const focusable = contentWrapper.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    });
    
    return {
      close: closeModal,
      result: resultPromise,
      componentRef
    };
  }
  
  /**
   * 通过 ID 关闭模态框
   */
  private closeById(modalId: string, result?: unknown): void {
    const stack = this.modalStack();
    const index = stack.findIndex(item => item.id === modalId);
    
    if (index === -1) return;
    
    const item = stack[index];
    
    // 清理所有订阅
    for (const sub of item.subscriptions) {
      sub.unsubscribe();
    }
    
    // 清理 ESC 监听器
    if (item.escapeListener) {
      this.document.removeEventListener('keydown', item.escapeListener);
    }
    
    // 销毁组件
    this.appRef.detachView(item.componentRef.hostView);
    item.componentRef.destroy();
    
    // 移除 DOM 元素
    item.containerElement.remove();
    
    // 返回结果
    item.resolve(result);
    
    // 从栈中移除
    this.modalStack.update(s => s.filter(m => m.id !== modalId));
  }
  
  /**
   * 关闭栈顶模态框
   */
  close<R = unknown>(result?: R): void {
    const stack = this.modalStack();
    if (stack.length === 0) return;
    
    const topModal = stack[stack.length - 1];
    this.closeById(topModal.id, result);
  }
  
  /**
   * 关闭所有模态框
   */
  closeAll(): void {
    const stack = this.modalStack();
    // 从栈顶开始关闭，确保正确的销毁顺序
    for (let i = stack.length - 1; i >= 0; i--) {
      this.closeById(stack[i].id);
    }
  }
  
  /**
   * 获取或创建容器元素
   */
  private getOrCreateContainer(selector?: string): HTMLElement {
    if (selector) {
      const container = this.document.querySelector<HTMLElement>(selector);
      if (container) return container;
    }
    return this.document.body;
  }
}

/**
 * 注入令牌：模态框数据
 * 组件使用 inject(MODAL_DATA) 获取传入的数据
 */
export const MODAL_DATA = Symbol('MODAL_DATA');

/**
 * 注入令牌：模态框引用
 * 组件使用 inject(MODAL_REF) 获取关闭模态框的能力
 */
export const MODAL_REF = Symbol('MODAL_REF');

/**
 * 类型辅助：从组件类型推断数据类型
 */
export type InferModalData<C> = C extends { data: infer D } ? D : unknown;

/**
 * 类型辅助：从组件类型推断结果类型
 */
export type InferModalResult<C> = C extends { close: { emit: (result: infer R) => void } } ? R : unknown;
