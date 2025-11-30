import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../models';

/**
 * 删除确认模态框组件
 */
@Component({
  selector: 'app-text-delete-confirm-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (task()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
           (click)="onCancel()">
        <div class="bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden animate-scale-in"
             [ngClass]="{'w-80 mx-4': isMobile(), 'w-96': !isMobile()}"
             (click)="$event.stopPropagation()">
          <div class="px-5 pt-5 pb-4">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 class="text-lg font-bold text-stone-800">删除任务</h3>
                <p class="text-xs text-stone-500">此操作不可撤销</p>
              </div>
            </div>
            <p class="text-sm text-stone-600 leading-relaxed">
              确定删除任务 <span class="font-semibold text-stone-800">"{{ task()?.title }}"</span> 吗？
            </p>
            
            <!-- 保留子任务选项 -->
            @if (hasChildren()) {
              <div class="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
                <label class="flex items-start gap-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    [checked]="keepChildren()"
                    (change)="keepChildrenChange.emit(!keepChildren())"
                    class="mt-0.5 w-4 h-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500">
                  <div>
                    <span class="text-xs font-medium text-amber-800">保留子任务</span>
                    <p class="text-[10px] text-amber-600 mt-0.5">子任务将提升到当前任务的父级</p>
                  </div>
                </label>
              </div>
            } @else {
              <p class="text-xs text-stone-400 mt-1">这将同时删除其所有子任务。</p>
            }
          </div>
          <div class="flex border-t border-stone-100">
            <button 
              (click)="onCancel()"
              class="flex-1 px-4 py-3 text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors">
              取消
            </button>
            <button 
              (click)="confirm.emit()"
              class="flex-1 px-4 py-3 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors">
              删除
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .animate-fade-in {
      animation: fadeIn 0.15s ease-out;
    }
    .animate-scale-in {
      animation: scaleIn 0.15s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
  `]
})
export class DeleteConfirmModalComponent {
  /** 要删除的任务 */
  readonly task = input<Task | null>(null);
  
  /** 是否移动端 */
  readonly isMobile = input<boolean>(false);
  
  /** 是否有子任务 */
  readonly hasChildren = input<boolean>(false);
  
  /** 是否保留子任务 */
  readonly keepChildren = input<boolean>(false);
  
  /** 保留子任务选项变更 */
  readonly keepChildrenChange = output<boolean>();
  
  /** 取消事件 */
  readonly cancel = output<void>();
  
  /** 确认删除事件 */
  readonly confirm = output<void>();
  
  onCancel() {
    this.cancel.emit();
  }
}
