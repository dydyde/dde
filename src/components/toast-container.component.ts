import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, ToastMessage } from '../services/toast.service';

/**
 * Toast 通知组件
 * 在应用右上角显示全局通知消息
 */
@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (toast.hasMessages()) {
      <div class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        @for (message of toast.messages(); track message.id) {
          <div 
            class="pointer-events-auto animate-toast-in rounded-lg shadow-lg border backdrop-blur-sm p-4 flex items-start gap-3 transition-all duration-300"
            [attr.data-testid]="message.type === 'error' ? 'error-toast' : null"
            [class.bg-emerald-50]="message.type === 'success'"
            [class.border-emerald-200]="message.type === 'success'"
            [class.bg-red-50]="message.type === 'error'"
            [class.border-red-200]="message.type === 'error'"
            [class.bg-amber-50]="message.type === 'warning'"
            [class.border-amber-200]="message.type === 'warning'"
            [class.bg-blue-50]="message.type === 'info'"
            [class.border-blue-200]="message.type === 'info'"
            role="alert">
            
            <!-- Icon -->
            <div class="flex-shrink-0 mt-0.5">
              @switch (message.type) {
                @case ('success') {
                  <svg class="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                }
                @case ('error') {
                  <svg class="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                }
                @case ('warning') {
                  <svg class="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                }
                @case ('info') {
                  <svg class="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                }
              }
            </div>
            
            <!-- Content -->
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium"
                 [class.text-emerald-800]="message.type === 'success'"
                 [class.text-red-800]="message.type === 'error'"
                 [class.text-amber-800]="message.type === 'warning'"
                 [class.text-blue-800]="message.type === 'info'">
                {{ message.title }}
              </p>
              @if (message.message) {
                <p class="mt-1 text-xs"
                   [class.text-emerald-600]="message.type === 'success'"
                   [class.text-red-600]="message.type === 'error'"
                   [class.text-amber-600]="message.type === 'warning'"
                   [class.text-blue-600]="message.type === 'info'">
                  {{ message.message }}
                </p>
              }
              @if (message.action) {
                <button
                  (click)="handleAction(message)"
                  class="mt-2 text-xs font-medium px-3 py-1 rounded-md transition-colors"
                  [class.bg-emerald-100]="message.type === 'success'"
                  [class.text-emerald-700]="message.type === 'success'"
                  [class.hover:bg-emerald-200]="message.type === 'success'"
                  [class.bg-red-100]="message.type === 'error'"
                  [class.text-red-700]="message.type === 'error'"
                  [class.hover:bg-red-200]="message.type === 'error'"
                  [class.bg-amber-100]="message.type === 'warning'"
                  [class.text-amber-700]="message.type === 'warning'"
                  [class.hover:bg-amber-200]="message.type === 'warning'"
                  [class.bg-blue-100]="message.type === 'info'"
                  [class.text-blue-700]="message.type === 'info'"
                  [class.hover:bg-blue-200]="message.type === 'info'">
                  {{ message.action.label }}
                </button>
              }
            </div>
            
            <!-- Close Button -->
            <button 
              (click)="toast.dismiss(message.id)"
              class="flex-shrink-0 p-1 rounded-full transition-colors"
              [class.text-emerald-400]="message.type === 'success'"
              [class.hover:bg-emerald-100]="message.type === 'success'"
              [class.text-red-400]="message.type === 'error'"
              [class.hover:bg-red-100]="message.type === 'error'"
              [class.text-amber-400]="message.type === 'warning'"
              [class.hover:bg-amber-100]="message.type === 'warning'"
              [class.text-blue-400]="message.type === 'info'"
              [class.hover:bg-blue-100]="message.type === 'info'"
              aria-label="关闭">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    
    .animate-toast-in {
      animation: toast-in 0.3s ease-out;
    }
  `]
})
export class ToastContainerComponent {
  readonly toast = inject(ToastService);
  
  /**
   * 处理 Toast 操作按钮点击
   */
  handleAction(message: ToastMessage): void {
    if (message.action?.onClick) {
      message.action.onClick();
    }
    this.toast.dismiss(message.id);
  }
}
