import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, ToastMessage } from '../../../services/toast.service';

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
            [ngClass]="{
              'bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800': message.type === 'success',
              'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800': message.type === 'error',
              'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800': message.type === 'warning',
              'bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800': message.type === 'info'
            }"
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
                 [ngClass]="{
                   'text-emerald-800 dark:text-emerald-200': message.type === 'success',
                   'text-red-800 dark:text-red-200': message.type === 'error',
                   'text-amber-800 dark:text-amber-200': message.type === 'warning',
                   'text-blue-800 dark:text-blue-200': message.type === 'info'
                 }">
                {{ message.title }}
              </p>
              @if (message.message) {
                <p class="mt-1 text-xs"
                   [ngClass]="{
                     'text-emerald-600 dark:text-emerald-300': message.type === 'success',
                     'text-red-600 dark:text-red-300': message.type === 'error',
                     'text-amber-600 dark:text-amber-300': message.type === 'warning',
                     'text-blue-600 dark:text-blue-300': message.type === 'info'
                   }">
                  {{ message.message }}
                </p>
              }
              @if (message.action) {
                <button
                  (click)="handleAction(message)"
                  class="mt-2 text-xs font-medium px-3 py-1 rounded-md transition-colors"
                  [ngClass]="{
                    'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800': message.type === 'success',
                    'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800': message.type === 'error',
                    'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800': message.type === 'warning',
                    'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800': message.type === 'info'
                  }">
                  {{ message.action.label }}
                </button>
              }
            </div>
            
            <!-- Close Button -->
            <button 
              (click)="toast.dismiss(message.id)"
              class="flex-shrink-0 p-1 rounded-full transition-colors"
              [ngClass]="{
                'text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900': message.type === 'success',
                'text-red-400 hover:bg-red-100 dark:hover:bg-red-900': message.type === 'error',
                'text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900': message.type === 'warning',
                'text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900': message.type === 'info'
              }"
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
