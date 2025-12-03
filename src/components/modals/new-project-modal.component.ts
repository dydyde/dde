import { Component, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-new-project-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div data-testid="new-project-modal" class="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 animate-scale-in" (click)="$event.stopPropagation()">
        <h2 class="text-xl font-bold mb-4 text-stone-800">新建项目</h2>
        <input 
          #projName
          data-testid="project-name-input"
          placeholder="项目名称" 
          class="w-full border border-stone-200 p-3 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-300 text-stone-700" 
          maxlength="50"
          (keydown.enter)="onConfirm()"
          [disabled]="isSubmitting()">
        <textarea 
          #projDesc 
          placeholder="项目描述（可选）" 
          class="w-full border border-stone-200 p-3 rounded-lg mb-4 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 text-stone-600" 
          maxlength="500"
          [disabled]="isSubmitting()"></textarea>
        <div class="flex justify-end gap-2">
          <button 
            (click)="close.emit()" 
            [disabled]="isSubmitting()"
            class="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors disabled:opacity-50">
            取消
          </button>
          <button 
            data-testid="create-project-confirm"
            (click)="onConfirm()"
            [disabled]="!projName.value.trim() || isSubmitting()"
            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            @if (isSubmitting()) {
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              创建中...
            } @else {
              创建
            }
          </button>
        </div>
      </div>
    </div>
  `
})
export class NewProjectModalComponent implements AfterViewInit {
  @ViewChild('projName') projNameInput!: ElementRef<HTMLInputElement>;
  @ViewChild('projDesc') projDescInput!: ElementRef<HTMLTextAreaElement>;
  
  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<{ name: string; description: string }>();
  
  /** 是否正在提交（防止重复点击） */
  isSubmitting = signal(false);
  
  ngAfterViewInit() {
    // 自动聚焦到名称输入框
    setTimeout(() => this.projNameInput?.nativeElement?.focus(), 100);
  }
  
  onConfirm() {
    // 防止重复提交
    if (this.isSubmitting()) return;
    
    const name = this.projNameInput?.nativeElement?.value?.trim();
    const description = this.projDescInput?.nativeElement?.value?.trim() || '';
    
    if (name) {
      this.isSubmitting.set(true);
      this.confirm.emit({ name, description });
      // 注意：isSubmitting 状态会在模态框关闭时自动重置
      // 如果创建失败，父组件应该调用 resetSubmitting() 或关闭模态框
    }
  }
  
  /**
   * 重置提交状态（供父组件在创建失败时调用）
   */
  resetSubmitting() {
    this.isSubmitting.set(false);
  }
}
