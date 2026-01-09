import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../../../models';

export interface LinkTypeDialogData {
  show: boolean;
  sourceId: string;
  targetId: string;
  sourceTask: Task | null;
  targetTask: Task | null;
  x: number;
  y: number;
}

/**
 * 连接类型选择对话框组件
 * 用于选择创建父子关系还是关联引用
 */
@Component({
  selector: 'app-flow-link-type-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (data(); as dialog) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in p-4"
           (click)="cancel.emit()">
        <div class="bg-white dark:bg-stone-900 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-700 overflow-hidden w-full max-w-xs animate-scale-in"
             (click)="$event.stopPropagation()">
          <div class="px-5 pt-5 pb-4">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
                <svg class="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <div>
                <h3 class="text-base font-bold text-stone-800 dark:text-stone-100">选择连接类型</h3>
                <p class="text-xs text-stone-500 dark:text-stone-400">请选择要创建的连接方式</p>
              </div>
            </div>
            
            <!-- 任务信息 -->
            <div class="mb-4 p-3 bg-stone-50 dark:bg-stone-800 rounded-lg">
              <div class="flex items-center gap-2 text-xs">
                <span class="font-medium text-stone-600 dark:text-stone-300 truncate max-w-[100px]">{{ dialog.sourceTask?.title || '源任务' }}</span>
                <svg class="w-4 h-4 text-stone-400 dark:text-stone-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
                <span class="font-medium text-stone-600 dark:text-stone-300 truncate max-w-[100px]">{{ dialog.targetTask?.title || '目标任务' }}</span>
              </div>
            </div>
            
            <!-- 连接类型选项 -->
            <div class="space-y-2">
              <button 
                (click)="parentChildLink.emit()"
                class="w-full p-3 border-2 border-teal-200 dark:border-teal-700 bg-teal-50/50 dark:bg-teal-900/30 rounded-xl hover:border-teal-400 dark:hover:border-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/50 transition-all text-left group">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg bg-teal-100 dark:bg-teal-800/50 flex items-center justify-center group-hover:bg-teal-200 dark:group-hover:bg-teal-700/50 transition-colors">
                    <svg class="w-4 h-4 text-teal-600 dark:text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <div>
                    <div class="font-semibold text-sm text-teal-800 dark:text-teal-200">父子关系</div>
                    <div class="text-[10px] text-teal-600 dark:text-teal-400">目标任务成为子任务，移动到下一阶段</div>
                  </div>
                </div>
              </button>
              
              <button 
                (click)="crossTreeLink.emit()"
                class="w-full p-3 border-2 border-indigo-200 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-900/30 rounded-xl hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/50 transition-all text-left group">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-800/50 flex items-center justify-center group-hover:bg-indigo-200 dark:group-hover:bg-indigo-700/50 transition-colors">
                    <svg class="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                  <div>
                    <div class="font-semibold text-sm text-indigo-800 dark:text-indigo-200">关联引用</div>
                    <div class="text-[10px] text-indigo-600 dark:text-indigo-400">创建虚线连接，表示任务间的关联关系</div>
                  </div>
                </div>
              </button>
            </div>
          </div>
          
          <div class="flex border-t border-stone-100 dark:border-stone-700">
            <button 
              (click)="cancel.emit()"
              class="flex-1 px-4 py-3 text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors">
              取消
            </button>
          </div>
        </div>
      </div>
    }
  `
})
export class FlowLinkTypeDialogComponent {
  readonly data = input<LinkTypeDialogData | null>(null);

  readonly cancel = output<void>();
  readonly parentChildLink = output<void>();
  readonly crossTreeLink = output<void>();
}
