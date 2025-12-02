/**
 * 模态框基类
 * 
 * 提供统一的模态框行为和样式基础：
 * - 自动注入 MODAL_DATA 和 MODAL_REF
 * - 统一的关闭逻辑
 * - 遮罩层点击关闭支持
 * - 键盘快捷键支持
 * 
 * 使用方式：
 * ```typescript
 * @Component({...})
 * export class MyModalComponent extends BaseModalComponent<MyData, MyResult> {
 *   handleConfirm() {
 *     this.closeWithResult({ success: true });
 *   }
 * }
 * ```
 */
import { 
  Directive, 
  inject, 
  Output, 
  EventEmitter,
  HostListener,
  OnInit
} from '@angular/core';
import { MODAL_DATA, MODAL_REF } from './dynamic-modal.service';

/**
 * 模态框基类指令
 * 使用 @Directive 而非 @Component 以便被组件继承
 */
@Directive()
export abstract class BaseModalComponent<TData = unknown, TResult = void> implements OnInit {
  /** 注入的模态框数据（动态渲染模式） */
  protected injectedData: TData | null = null;
  
  /** 注入的模态框引用（动态渲染模式） */
  protected modalRef: { close: (result?: TResult) => void } | null = null;
  
  /** 关闭事件（模板渲染模式兼容） */
  @Output() close = new EventEmitter<TResult | void>();
  
  constructor() {
    // 尝试注入动态模态框数据
    try {
      this.injectedData = inject(MODAL_DATA as any, { optional: true }) as TData;
      this.modalRef = inject(MODAL_REF as any, { optional: true });
    } catch {
      // 非动态模式，忽略注入错误
    }
  }
  
  ngOnInit(): void {
    // 子类可以覆盖此方法进行初始化
  }
  
  /**
   * 获取模态框数据
   * 优先使用注入的数据，否则子类应该通过 @Input() 提供
   */
  protected get data(): TData | null {
    return this.injectedData;
  }
  
  /**
   * 关闭模态框（无结果）
   */
  protected dismiss(): void {
    if (this.modalRef) {
      this.modalRef.close();
    } else {
      this.close.emit();
    }
  }
  
  /**
   * 关闭模态框并返回结果
   */
  protected closeWithResult(result: TResult): void {
    if (this.modalRef) {
      this.modalRef.close(result);
    } else {
      this.close.emit(result);
    }
  }
  
  /**
   * ESC 键关闭（备用处理，DynamicModalService 已处理）
   */
  @HostListener('document:keydown.escape', ['$event'])
  protected onEscapeKey(event: KeyboardEvent): void {
    // 动态模式下由 DynamicModalService 处理
    // 模板模式下由此方法处理
    if (!this.modalRef) {
      event.preventDefault();
      this.dismiss();
    }
  }
}

/**
 * 确认型模态框基类
 * 提供确认/取消的标准模式
 */
@Directive()
export abstract class ConfirmModalComponent<TData = unknown, TResult = { confirmed: boolean }> 
  extends BaseModalComponent<TData, TResult> {
  
  /** 确认事件（模板模式兼容） */
  @Output() confirm = new EventEmitter<TResult>();
  
  /**
   * 处理确认操作
   */
  protected handleConfirm(result?: Partial<TResult>): void {
    const fullResult = { confirmed: true, ...result } as TResult;
    this.closeWithResult(fullResult);
    this.confirm.emit(fullResult);
  }
  
  /**
   * 处理取消操作
   */
  protected handleCancel(): void {
    const cancelResult = { confirmed: false } as TResult;
    this.closeWithResult(cancelResult);
  }
}
