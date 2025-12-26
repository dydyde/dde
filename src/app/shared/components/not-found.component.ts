import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

/**
 * 404 页面组件
 * 当用户访问不存在的路由时显示
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="min-h-screen bg-gradient-to-br from-stone-100 to-stone-200 flex items-center justify-center p-4">
      <div class="text-center max-w-md">
        <!-- 404 图标 -->
        <div class="mb-8">
          <div class="w-32 h-32 mx-auto bg-stone-200 rounded-full flex items-center justify-center">
            <svg class="w-16 h-16 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
        
        <!-- 标题 -->
        <h1 class="text-6xl font-bold text-stone-300 mb-4">404</h1>
        <h2 class="text-xl font-semibold text-stone-700 mb-2">页面未找到</h2>
        <p class="text-stone-500 mb-8">
          您访问的页面不存在或已被移动。
        </p>
        
        <!-- 操作按钮 -->
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <button 
            (click)="goBack()"
            class="px-6 py-2.5 bg-white border border-stone-300 rounded-lg text-stone-700 font-medium hover:bg-stone-50 transition-colors shadow-sm">
            返回上一页
          </button>
          <a 
            routerLink="/projects"
            class="px-6 py-2.5 bg-teal-600 rounded-lg text-white font-medium hover:bg-teal-700 transition-colors shadow-sm">
            前往首页
          </a>
        </div>
        
        <!-- 提示信息 -->
        <div class="mt-12 text-xs text-stone-400">
          <p>如果您认为这是一个错误，请联系管理员。</p>
          <p class="mt-1">NanoFlow © {{ currentYear }}</p>
        </div>
      </div>
    </div>
  `
})
export class NotFoundComponent {
  private router = inject(Router);
  
  readonly currentYear = new Date().getFullYear();
  
  goBack() {
    // 如果有历史记录，返回上一页；否则去首页
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void this.router.navigate(['/projects']);
    }
  }
}
