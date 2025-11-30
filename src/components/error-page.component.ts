import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { GlobalErrorHandler } from '../services/global-error-handler.service';

/**
 * 致命错误信息接口
 */
interface FatalErrorInfo {
  message: string;
  userMessage: string;
  timestamp: string;
  stack?: string;
}

/**
 * 致命错误页面组件
 * 当应用发生无法恢复的错误时显示
 * 提供重载应用和返回首页的选项
 */
@Component({
  selector: 'app-error-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="min-h-screen bg-gradient-to-br from-red-50 to-stone-100 flex items-center justify-center p-4">
      <div class="text-center max-w-lg">
        <!-- 错误图标 -->
        <div class="mb-8">
          <div class="w-32 h-32 mx-auto bg-red-100 rounded-full flex items-center justify-center animate-pulse">
            <svg class="w-16 h-16 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        
        <!-- 标题 -->
        <h1 class="text-3xl font-bold text-stone-800 mb-4">应用出错了</h1>
        <p class="text-stone-600 mb-2 text-lg">
          {{ errorInfo?.userMessage || '抱歉，应用遇到了一个严重错误。' }}
        </p>
        <p class="text-stone-400 text-sm mb-8">
          我们已记录此问题，正在努力修复中。
        </p>
        
        <!-- 操作按钮 -->
        <div class="flex flex-col sm:flex-row gap-3 justify-center mb-8">
          <button 
            (click)="reloadApp()"
            class="px-6 py-3 bg-teal-600 rounded-lg text-white font-medium hover:bg-teal-700 transition-colors shadow-md hover:shadow-lg flex items-center justify-center gap-2">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            重新加载应用
          </button>
          <button 
            (click)="goHome()"
            class="px-6 py-3 bg-white border border-stone-300 rounded-lg text-stone-700 font-medium hover:bg-stone-50 transition-colors shadow-sm">
            返回首页
          </button>
        </div>
        
        <!-- 错误详情（可折叠） -->
        @if (errorInfo) {
          <details class="text-left bg-white/50 rounded-lg p-4 border border-stone-200">
            <summary class="text-sm text-stone-500 cursor-pointer hover:text-stone-700 select-none">
              查看错误详情
            </summary>
            <div class="mt-4 text-xs text-stone-400 font-mono overflow-auto max-h-48">
              <p class="mb-2"><strong>时间：</strong>{{ errorInfo.timestamp | date:'yyyy-MM-dd HH:mm:ss' }}</p>
              <p class="mb-2"><strong>错误：</strong>{{ errorInfo.message }}</p>
              @if (errorInfo.stack) {
                <pre class="whitespace-pre-wrap break-all bg-stone-100 p-2 rounded mt-2">{{ errorInfo.stack }}</pre>
              }
            </div>
          </details>
        }
        
        <!-- 帮助信息 -->
        <div class="mt-8 text-xs text-stone-400">
          <p>如果问题持续存在，请尝试：</p>
          <ul class="mt-2 space-y-1">
            <li>• 清除浏览器缓存后重试</li>
            <li>• 检查网络连接</li>
            <li>• 使用其他浏览器访问</li>
          </ul>
          <p class="mt-4">NanoFlow © {{ currentYear }}</p>
        </div>
      </div>
    </div>
  `
})
export class ErrorPageComponent implements OnInit {
  private router = inject(Router);
  private errorHandler = inject(GlobalErrorHandler);
  
  readonly currentYear = new Date().getFullYear();
  errorInfo: FatalErrorInfo | null = null;
  
  ngOnInit() {
    // 尝试从 sessionStorage 获取错误信息
    this.loadErrorInfo();
  }
  
  /**
   * 加载错误信息
   */
  private loadErrorInfo() {
    try {
      const stored = sessionStorage.getItem('nanoflow.fatal-error');
      if (stored) {
        this.errorInfo = JSON.parse(stored);
      }
    } catch {
      // 忽略解析错误
    }
    
    // 也尝试从路由状态获取
    const navState = this.router.getCurrentNavigation()?.extras?.state as any;
    if (navState?.errorMessage && !this.errorInfo) {
      this.errorInfo = {
        message: navState.errorMessage,
        userMessage: navState.userMessage || '应用遇到了一个错误',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * 重新加载应用
   */
  reloadApp() {
    // 清除错误状态
    this.clearErrorState();
    
    // 强制刷新页面
    window.location.href = '/';
  }
  
  /**
   * 返回首页（不刷新）
   */
  goHome() {
    // 清除错误状态
    this.clearErrorState();
    
    // 重置错误处理器状态
    this.errorHandler.resetFatalState();
    
    // 导航到首页
    void this.router.navigate(['/projects']);
  }
  
  /**
   * 清除错误状态
   */
  private clearErrorState() {
    try {
      sessionStorage.removeItem('nanoflow.fatal-error');
    } catch {
      // 忽略
    }
  }
}
