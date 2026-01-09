import { Component, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-new-project-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div data-testid="new-project-modal" class="bg-white dark:bg-stone-900 rounded-xl shadow-2xl w-full max-w-md p-6 animate-scale-in" (click)="$event.stopPropagation()">
        <h2 class="text-xl font-bold mb-4 text-stone-800 dark:text-stone-200">新建项目</h2>
        <input 
          #projName
          data-testid="project-name-input"
          placeholder="项目名称" 
          class="w-full border border-stone-200 dark:border-stone-600 p-3 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500 text-stone-700 dark:text-stone-200 bg-white dark:bg-stone-800" 
          maxlength="50"
          spellcheck="false"
          (keydown.enter)="onConfirm()">
        <textarea 
          #projDesc 
          placeholder="项目描述（可选）" 
          class="w-full border border-stone-200 dark:border-stone-600 p-3 rounded-lg mb-4 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500 text-stone-600 dark:text-stone-300 bg-white dark:bg-stone-800" 
          maxlength="500"
          spellcheck="false"></textarea>
        <div class="flex justify-end gap-2">
          <button 
            (click)="close.emit()" 
            class="px-4 py-2 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-lg transition-colors">
            取消
          </button>
          <button 
            data-testid="create-project-confirm"
            (click)="onConfirm()"
            [disabled]="!projName.value.trim()"
            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            创建
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
  
  ngAfterViewInit() {
    // 自动聚焦到名称输入框
    setTimeout(() => this.projNameInput?.nativeElement?.focus(), 100);
  }
  
  onConfirm() {
    const name = this.projNameInput?.nativeElement?.value?.trim();
    const description = this.projDescInput?.nativeElement?.value?.trim() || '';
    
    if (name) {
      this.confirm.emit({ name, description });
    }
  }
}
