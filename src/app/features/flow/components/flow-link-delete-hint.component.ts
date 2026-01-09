import { Component, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

import type { LinkDeleteHint } from '../../../../models/flow-view-state';

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
           [style.left.px]="clampedX()"
           [style.top.px]="clampedY()">
        <div class="bg-white dark:bg-stone-900 rounded-lg shadow-xl border border-stone-200 dark:border-stone-700 p-2 flex gap-2">
          <button 
            (click)="confirm.emit()"
            class="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-all">
            {{ h.isCrossTree ? '删除连接' : '解除关系' }}
          </button>
          <button 
            (click)="cancel.emit()"
            class="px-3 py-1.5 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 text-xs font-medium rounded hover:bg-stone-200 dark:hover:bg-stone-700 transition-all">
            取消
          </button>
        </div>

        @if (!h.isCrossTree) {
          <div class="mt-1 text-[10px] text-stone-500 dark:text-stone-400 bg-white/90 dark:bg-stone-800/90 rounded px-2 py-1 border border-stone-100 dark:border-stone-700">
            提示：解除父子关系会把子任务移到“待分配”
          </div>
        }
      </div>
    }
  `
})
export class FlowLinkDeleteHintComponent {
  readonly hint = input<LinkDeleteHint | null>(null);

  readonly confirm = output<void>();
  readonly cancel = output<void>();
  
  // 计算限制在视口内的位置
  readonly clampedX = computed(() => {
    const h = this.hint();
    if (!h) return 0;
    const hintWidth = 180; // 估算宽度
    const padding = 16;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 400;
    const rawX = h.x - 60;
    return Math.max(padding, Math.min(rawX, viewportWidth - hintWidth - padding));
  });
  
  readonly clampedY = computed(() => {
    const h = this.hint();
    if (!h) return 0;
    const hintHeight = 50; // 估算高度
    const padding = 16;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 600;
    const rawY = h.y - 50;
    return Math.max(padding, Math.min(rawY, viewportHeight - hintHeight - padding));
  });
}
