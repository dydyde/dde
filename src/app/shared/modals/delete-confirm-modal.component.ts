import { Component, Output, EventEmitter, input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MODAL_DATA, MODAL_REF } from '../../../services/dynamic-modal.service';

/**
 * 删除确认模态框数据接口
 * 用于动态渲染模式
 */
export interface DeleteConfirmData {
  title?: string;
  message?: string;
  itemName: string;
  warning?: string;
}

/**
 * 删除确认模态框结果接口
 */
export interface DeleteConfirmResult {
  confirmed: boolean;
}

/**
 * 删除确认模态框
 * 
 * 支持两种使用方式：
 * 1. 动态渲染（推荐）：通过 DynamicModalService.open() 调用
 * 2. 模板渲染（兼容）：通过 @if 条件渲染
 * 
 * 动态渲染示例：
 * ```typescript
 * const result = await dynamicModal.open(DeleteConfirmModalComponent, {
 *   data: { title: '删除项目', itemName: 'My Project', warning: '此操作不可撤销' }
 * });
 * if (result.confirmed) {
 *   await deleteProject(projectId);
 * }
 * ```
 */
@Component({
  selector: 'app-delete-confirm-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- 动态模式不需要遮罩层，由 DynamicModalService 提供 -->
    <div 
      class="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 animate-scale-in"
      [class.modal-standalone]="!isDynamicMode"
      (click)="$event.stopPropagation()">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
          <svg class="w-5 h-5 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>
        <h3 class="text-lg font-semibold text-stone-800">{{ displayTitle }}</h3>
      </div>
      <p class="text-stone-600 text-sm mb-2">{{ displayMessage }}</p>
      <p class="text-stone-800 font-medium text-sm mb-4 px-3 py-2 bg-stone-50 rounded-lg border border-stone-200 truncate">
        {{ displayItemName }}
      </p>
      @if (displayWarning) {
        <p class="text-red-500 text-xs mb-4">⚠️ {{ displayWarning }}</p>
      }
      <div class="flex justify-end gap-2">
        <button 
          (click)="handleCancel()" 
          class="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm">
          取消
        </button>
        <button 
          (click)="handleConfirm()" 
          class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium">
          确认删除
        </button>
      </div>
    </div>
  `,
  styles: [`
    /* 仅在非动态模式下显示完整模态框样式 */
    :host-context(.modal-standalone) {
      position: fixed;
      inset: 0;
      background-color: rgba(0, 0, 0, 0.4);
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
  `]
})
export class DeleteConfirmModalComponent {
  // ========== 模板渲染模式的 Inputs ==========
  /** 对话框标题 */
  title = input('删除确认');
  /** 确认消息 */
  message = input('确定要删除吗？');
  /** 要删除的项目名称 */
  itemName = input('');
  /** 警告信息（可选） */
  warning = input<string | null>(null);
  
  // ========== 模板渲染模式的 Outputs ==========
  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<void>();
  
  // ========== 动态渲染模式的注入 ==========
  private injectedData: DeleteConfirmData | null = null;
  private modalRef: { close: (result?: DeleteConfirmResult) => void } | null = null;
  
  /** 是否为动态渲染模式 */
  isDynamicMode = false;
  
  constructor() {
    // 尝试注入动态模态框数据
    try {
      this.injectedData = inject(MODAL_DATA as any, { optional: true }) as DeleteConfirmData | null;
      this.modalRef = inject(MODAL_REF as any, { optional: true });
      this.isDynamicMode = !!this.modalRef;
    } catch {
      // 非动态模式
    }
  }
  
  // ========== 统一的数据访问器 ==========
  get displayTitle(): string {
    return this.injectedData?.title ?? this.title();
  }
  
  get displayMessage(): string {
    return this.injectedData?.message ?? this.message();
  }
  
  get displayItemName(): string {
    return this.injectedData?.itemName ?? this.itemName();
  }
  
  get displayWarning(): string | null {
    return this.injectedData?.warning ?? this.warning();
  }
  
  // ========== 统一的事件处理 ==========
  handleConfirm(): void {
    if (this.modalRef) {
      // 动态模式：通过 ModalRef 关闭并返回结果
      this.modalRef.close({ confirmed: true });
    } else {
      // 模板模式：触发事件
      this.confirm.emit();
    }
  }
  
  handleCancel(): void {
    if (this.modalRef) {
      // 动态模式：关闭并返回取消结果
      this.modalRef.close({ confirmed: false });
    } else {
      // 模板模式：触发关闭事件
      this.close.emit();
    }
  }
}
