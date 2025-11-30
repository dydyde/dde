import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface LinkDeleteHint {
  /** GoJS Link 对象 - 由于 GoJS 类型定义复杂，使用 unknown */
  link: unknown;
  x: number;
  y: number;
}

/**
 * 移动端连接线删除提示组件
 */
@Component({
  selector: 'app-flow-link-delete-hint',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (hint(); as h) {
      <div class="fixed z-50 animate-scale-in"
           [style.left.px]="h.x - 60"
           [style.top.px]="h.y - 50">
        <div class="bg-white rounded-lg shadow-xl border border-stone-200 p-2 flex gap-2">
          <button 
            (click)="confirm.emit()"
            class="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-all">
            删除连接
          </button>
          <button 
            (click)="cancel.emit()"
            class="px-3 py-1.5 bg-stone-100 text-stone-600 text-xs font-medium rounded hover:bg-stone-200 transition-all">
            取消
          </button>
        </div>
      </div>
    }
  `
})
export class FlowLinkDeleteHintComponent {
  readonly hint = input<LinkDeleteHint | null>(null);

  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
