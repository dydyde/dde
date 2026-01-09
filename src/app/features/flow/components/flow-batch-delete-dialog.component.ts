import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * 批量删除影响统计
 */
export interface BatchDeleteImpact {
  /** 将被删除的总任务数（含级联子任务） */
  total: number;
  /** 用户显式选中的任务数 */
  explicit: number;
  /** 级联删除的子任务数 */
  cascaded: number;
}

/**
 * 批量删除确认弹窗数据
 */
export interface BatchDeleteDialogData {
  /** 选中的任务 ID 列表 */
  selectedIds: string[];
  /** 删除影响统计 */
  impact: BatchDeleteImpact;
}

/**
 * 批量删除确认弹窗组件
 * 
 * 用于确认批量删除多个任务，显示：
 * - 选中任务数量
 * - 级联子任务数量
 * - 总删除数量
 * 
 * 设计原则：
 * - 多选删除必须弹窗确认，误触 Delete 键删除整棵树是灾难性的
 * - 移动端适配更大的点击区域
 */
@Component({
  selector: 'app-flow-batch-delete-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (data(); as d) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4"
           (click)="cancel.emit()">
        <div class="bg-white dark:bg-stone-900 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-700 overflow-hidden animate-scale-in w-full"
             [ngClass]="{'max-w-xs': isMobile(), 'max-w-sm': !isMobile()}"
             (click)="$event.stopPropagation()">
          <div class="px-5 pt-5 pb-4">
            <!-- 标题区域 -->
            <div class="flex items-center gap-3 mb-4">
              <div class="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                <svg class="w-6 h-6 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 class="text-lg font-bold text-stone-800 dark:text-stone-100">批量删除任务</h3>
                <p class="text-xs text-stone-500 dark:text-stone-400">此操作将移动到回收站</p>
              </div>
            </div>
            
            <!-- 删除统计 -->
            <div class="bg-stone-50 dark:bg-stone-800 rounded-xl p-4 space-y-2">
              <div class="flex justify-between items-center">
                <span class="text-sm text-stone-600 dark:text-stone-300">选中任务</span>
                <span class="text-sm font-semibold text-stone-800 dark:text-stone-100">{{ d.impact.explicit }} 个</span>
              </div>
              @if (d.impact.cascaded > 0) {
                <div class="flex justify-between items-center">
                  <span class="text-sm text-amber-600 dark:text-amber-400">级联子任务</span>
                  <span class="text-sm font-semibold text-amber-700 dark:text-amber-300">+ {{ d.impact.cascaded }} 个</span>
                </div>
              }
              <div class="border-t border-stone-200 dark:border-stone-700 pt-2 flex justify-between items-center">
                <span class="text-sm font-medium text-stone-700 dark:text-stone-200">总计删除</span>
                <span class="text-base font-bold text-red-600 dark:text-red-400">{{ d.impact.total }} 个任务</span>
              </div>
            </div>
            
            <!-- 警告提示 -->
            @if (d.impact.cascaded > 0) {
              <div class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800/50 rounded-lg">
                <div class="flex gap-2">
                  <svg class="w-4 h-4 text-amber-500 dark:text-amber-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p class="text-xs text-amber-700 dark:text-amber-300">
                    选中的任务包含子任务，删除后子任务也会一并移入回收站
                  </p>
                </div>
              </div>
            }
          </div>

          <!-- 操作按钮 -->
          <div class="flex border-t border-stone-100 dark:border-stone-700">
            <button 
              (click)="cancel.emit()"
              class="flex-1 px-4 py-3.5 text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors">
              取消
            </button>
            <button 
              (click)="confirm.emit()"
              class="flex-1 px-4 py-3.5 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors">
              确认删除
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    @keyframes scale-in {
      from { 
        opacity: 0;
        transform: scale(0.95);
      }
      to { 
        opacity: 1;
        transform: scale(1);
      }
    }
    
    .animate-fade-in {
      animation: fade-in 0.15s ease-out;
    }
    
    .animate-scale-in {
      animation: scale-in 0.2s ease-out;
    }
  `]
})
export class FlowBatchDeleteDialogComponent {
  /** 弹窗数据，null 时不显示 */
  readonly data = input<BatchDeleteDialogData | null>(null);
  
  /** 是否移动端 */
  readonly isMobile = input<boolean>(false);
  
  /** 取消事件 */
  readonly cancel = output<void>();
  
  /** 确认删除事件 */
  readonly confirm = output<void>();
}
