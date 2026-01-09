import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../../../models';

/**
 * 删除确认弹窗组件
 * 用于确认删除任务，支持保留子任务选项
 */
@Component({
  selector: 'app-flow-delete-confirm',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (task(); as t) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4"
           (click)="cancel.emit()">
        <div class="bg-white dark:bg-stone-900 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-700 overflow-hidden animate-scale-in w-full"
             [ngClass]="{'max-w-xs': isMobile(), 'max-w-sm': !isMobile()}"
             (click)="$event.stopPropagation()">
          <div class="px-5 pt-5 pb-4">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 class="text-lg font-bold text-stone-800 dark:text-stone-100">删除任务</h3>
                <p class="text-xs text-stone-500 dark:text-stone-400">此操作不可撤销</p>
              </div>
            </div>
            <p class="text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
              确定删除任务 <span class="font-semibold text-stone-800 dark:text-stone-100">"{{ t.title }}"</span> 吗？
            </p>
            
            <!-- 保留子任务选项 -->
            @if (hasChildren()) {
              @if (isMobile()) {
                <div class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800/50 rounded-lg">
                  <p class="text-xs font-medium text-amber-800 dark:text-amber-200">该任务包含子任务</p>
                  <p class="text-[10px] text-amber-600 dark:text-amber-300 mt-0.5">请选择是否保留子任务（保留时子任务会提升到父级）</p>
                </div>
              } @else {
                <div class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800/50 rounded-lg">
                  <label class="flex items-start gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      [checked]="keepChildren()"
                      (change)="keepChildrenChange.emit(!keepChildren())"
                      class="mt-0.5 w-4 h-4 rounded border-amber-300 dark:border-amber-600 text-amber-600 focus:ring-amber-500">
                    <div>
                      <span class="text-xs font-medium text-amber-800 dark:text-amber-200">保留子任务</span>
                      <p class="text-[10px] text-amber-600 dark:text-amber-300 mt-0.5">子任务将提升到当前任务的父级</p>
                    </div>
                  </label>
                </div>
              }
            } @else {
              <p class="text-xs text-stone-400 dark:text-stone-500 mt-1">这将同时删除其所有子任务。</p>
            }
          </div>

          @if (isMobile() && hasChildren()) {
            <div class="border-t border-stone-100 dark:border-stone-700 p-3 space-y-2">
              <button
                (click)="confirm.emit(false)"
                class="w-full px-4 py-3 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors rounded-xl">
                删除（同时删除子任务）
              </button>
              <button
                (click)="confirm.emit(true)"
                class="w-full px-4 py-3 text-sm font-medium text-amber-900 dark:text-amber-100 bg-amber-100 dark:bg-amber-900/50 hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors rounded-xl border border-amber-200 dark:border-amber-700">
                删除（保留子任务）
              </button>
              <button
                (click)="cancel.emit()"
                class="w-full px-4 py-2 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors rounded-xl">
                取消
              </button>
            </div>
          } @else {
            <div class="flex border-t border-stone-100 dark:border-stone-700">
              <button 
                (click)="cancel.emit()"
                class="flex-1 px-4 py-3 text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors">
                取消
              </button>
              <button 
                (click)="confirm.emit(keepChildren())"
                class="flex-1 px-4 py-3 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors">
                删除
              </button>
            </div>
          }
        </div>
      </div>
    }
  `
})
export class FlowDeleteConfirmComponent {
  readonly task = input<Task | null>(null);
  readonly keepChildren = input(false);
  readonly hasChildren = input(false);
  readonly isMobile = input(false);

  readonly cancel = output<void>();
  /**
   * 确认删除。
   * 参数表示是否“保留子任务”（true=保留子任务；false=连同子任务一起删除）
   */
  readonly confirm = output<boolean>();
  readonly keepChildrenChange = output<boolean>();
}
