import { Component, Output, EventEmitter, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-delete-confirm-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 animate-scale-in" (click)="$event.stopPropagation()">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <svg class="w-5 h-5 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <h3 class="text-lg font-semibold text-stone-800">{{ title() }}</h3>
        </div>
        <p class="text-stone-600 text-sm mb-2">{{ message() }}</p>
        <p class="text-stone-800 font-medium text-sm mb-4 px-3 py-2 bg-stone-50 rounded-lg border border-stone-200 truncate">
          {{ itemName() }}
        </p>
        @if (warning()) {
          <p class="text-red-500 text-xs mb-4">⚠️ {{ warning() }}</p>
        }
        <div class="flex justify-end gap-2">
          <button (click)="close.emit()" class="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm">取消</button>
          <button (click)="confirm.emit()" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium">确认删除</button>
        </div>
      </div>
    </div>
  `
})
export class DeleteConfirmModalComponent {
  /** 对话框标题 */
  title = input('删除确认');
  /** 确认消息 */
  message = input('确定要删除吗？');
  /** 要删除的项目名称 */
  itemName = input('');
  /** 警告信息（可选） */
  warning = input<string | null>(null);
  
  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<void>();
}
