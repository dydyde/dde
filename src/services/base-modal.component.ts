/**
 * 模态框基类
 * 
 * 提供统一的模态框行为和样式基础：
 * - 自动注入 MODAL_DATA 和 MODAL_REF
 * - 统一的关闭逻辑
 * - 遮罩层点击关闭支持
 * - 键盘快捷键支持
 * - 脏数据检测与自动保存支持
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
 * 
 * 带脏检查的使用方式：
 * ```typescript
 * @Component({...})
 * export class EditModalComponent extends EditableModalComponent<MyData, MyResult> {
 *   protected override isDirty(): boolean {
 *     return this.originalValue !== this.currentValue;
 *   }
 *   
 *   protected override autoSave(): void {
 *     this.store.updateData(this.currentValue);
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
  OnInit,
  signal
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

/**
 * 可编辑模态框基类
 * 
 * 提供脏数据检测和自动保存支持：
 * - 精准的脏检查（基于实际数据变化，而非 focus 事件）
 * - 关闭时自动保存（默认行为，可覆盖）
 * - 仅对破坏性操作（如删除）弹出确认
 * 
 * 【设计理念】
 * 作为个人工具，采用"默认保存"策略替代"总是确认"：
 * - 当模态框关闭时，如果检测到脏数据，直接触发保存逻辑
 * - 不弹窗询问"是否保存"，减少心智负担
 * - 除非是破坏性操作，否则默认保存用户的改动
 */
@Directive()
export abstract class EditableModalComponent<TData = unknown, TResult = void> 
  extends BaseModalComponent<TData, TResult> {
  
  /** 是否正在提交（防止重复提交） */
  protected isSubmitting = signal(false);
  
  /**
   * 检查数据是否已修改（脏检查）
   * 
   * 【实现建议】
   * 子类应实现精准的脏检查逻辑：
   * - 对比原始数据和当前数据
   * - 使用深比较或 Hash 值比较
   * - 避免基于 focus/blur 事件的误判
   * 
   * @returns 如果数据已修改返回 true
   */
  protected isDirty(): boolean {
    // 默认实现：不脏
    // 子类应覆盖此方法实现精准的脏检查
    return false;
  }
  
  /**
   * 自动保存数据
   * 
   * 【实现建议】
   * 子类应实现此方法来保存修改：
   * - 调用相应的 store 方法
   * - 不需要显示额外的 toast（除非失败）
   * 
   * @returns 返回 Promise 以支持异步保存
   */
  protected async autoSave(): Promise<void> {
    // 默认实现：什么都不做
    // 子类应覆盖此方法实现自动保存逻辑
  }
  
  /**
   * 是否应该在关闭前确认
   * 
   * 仅用于破坏性操作（如删除）
   * 普通编辑操作应使用自动保存，不需要确认
   * 
   * @returns 如果需要确认返回 true
   */
  protected shouldConfirmBeforeClose(): boolean {
    // 默认：不需要确认（使用自动保存）
    return false;
  }
  
  /**
   * 增强的关闭逻辑
   * 
   * 关闭前检查脏数据：
   * 1. 如果有脏数据且启用自动保存，则自动保存
   * 2. 如果需要确认（破坏性操作），则提示用户
   * 3. 否则直接关闭
   */
  protected override dismiss(): void {
    this.handleClose();
  }
  
  /**
   * 处理关闭逻辑
   */
  protected async handleClose(): Promise<void> {
    // 如果正在提交，忽略关闭请求
    if (this.isSubmitting()) return;
    
    // 检查是否有脏数据
    if (this.isDirty()) {
      // 如果需要确认（破坏性操作场景），子类应覆盖处理
      if (this.shouldConfirmBeforeClose()) {
        // 子类应覆盖此方法显示确认对话框
        return;
      }
      
      // 默认行为：自动保存
      this.isSubmitting.set(true);
      try {
        await this.autoSave();
      } finally {
        this.isSubmitting.set(false);
      }
    }
    
    // 执行关闭
    super.dismiss();
  }
  
  /**
   * 强制关闭（不保存）
   * 用于用户明确选择"放弃修改"的场景
   */
  protected forceClose(): void {
    super.dismiss();
  }
}
