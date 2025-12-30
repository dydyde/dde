import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';


export interface CascadeAssignDialogData {
  show: boolean;
  taskId: string;
  taskTitle: string;
  targetStage: number;
  subtreeCount: number;
  targetParentId: string | null;
  targetParentTitle: string | null;
  /** 子树的最大深度 */
  subtreeDepth: number;
}

/**
 * 级联分配确认对话框组件
 * 
 * 当用户将一个待分配任务树拖拽到已分配区域时，
 * 弹出此对话框确认是否要级联分配整个子树。
 * 
 * 符合 UX 方案 B：自动触发级联分配弹窗确认
 */
@Component({
  selector: 'app-flow-cascade-assign-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (data(); as dialog) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in p-4"
           (click)="cancel.emit()">
        <div class="bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden w-full max-w-sm animate-scale-in"
             (click)="$event.stopPropagation()">
          <div class="px-5 pt-5 pb-4">
            <!-- 标题区域 -->
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <svg class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 class="text-base font-bold text-stone-800">确认级联分配</h3>
                <p class="text-xs text-stone-500">此任务包含子任务树</p>
              </div>
            </div>
            
            <!-- 任务信息 -->
            <div class="mb-4 p-3 bg-stone-50 rounded-lg space-y-2">
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">任务名称</span>
                <span class="font-medium text-stone-700 truncate max-w-[180px]">{{ dialog.taskTitle || '未命名任务' }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">包含任务</span>
                <span class="font-medium text-amber-600">{{ dialog.subtreeCount }} 个任务</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">目标阶段</span>
                <span class="font-medium text-teal-600">阶段 {{ dialog.targetStage }} → {{ dialog.targetStage + dialog.subtreeDepth }}</span>
              </div>
              @if (dialog.targetParentTitle) {
                <div class="flex items-center justify-between text-xs">
                  <span class="text-stone-500">父任务</span>
                  <span class="font-medium text-stone-700 truncate max-w-[180px]">{{ dialog.targetParentTitle }}</span>
                </div>
              }
            </div>
            
            <!-- 说明文字 -->
            <div class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p class="text-xs text-amber-700 leading-relaxed">
                <strong>注意：</strong>分配此任务将会同时分配其所有 {{ dialog.subtreeCount - 1 }} 个子任务。
                子任务将按层级依次分配到后续阶段。
              </p>
            </div>
            
            <!-- 操作按钮 -->
            <div class="flex gap-2">
              <button 
                (click)="cancel.emit()"
                class="flex-1 px-4 py-2.5 text-sm font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-xl transition-colors">
                取消
              </button>
              <button 
                (click)="confirm.emit()"
                class="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-xl transition-colors">
                确认分配
              </button>
            </div>
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
      animation: scaleIn 0.2s ease-out;
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
export class FlowCascadeAssignDialogComponent {
  /** 对话框数据 */
  data = input<CascadeAssignDialogData | null>(null);
  
  /** 确认分配 */
  confirm = output<void>();
  
  /** 取消操作 */
  cancel = output<void>();
}
