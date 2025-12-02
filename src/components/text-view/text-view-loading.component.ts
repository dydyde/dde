import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * 加载骨架屏组件
 * 在数据加载时显示占位UI
 */
@Component({
  selector: 'app-text-view-loading',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="loading-indicator" 
         class="flex-none animate-pulse" 
         [ngClass]="{'mx-4 mt-4 space-y-4': !isMobile, 'mx-2 mt-2 space-y-2': isMobile}">
      
      <!-- 骨架屏：待办事项区域 -->
      <div class="rounded-xl bg-stone-100 border border-stone-200/50" 
           [ngClass]="{'h-20': !isMobile, 'h-14': isMobile}">
        <div class="p-3 flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full bg-stone-300"></div>
          <div class="h-3 bg-stone-200 rounded w-20"></div>
        </div>
      </div>
      
      <!-- 骨架屏：待分配区域 -->
      <div class="rounded-xl bg-stone-100 border border-stone-200/50" 
           [ngClass]="{'h-16': !isMobile, 'h-12': isMobile}">
        <div class="p-3 flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full bg-stone-300"></div>
          <div class="h-3 bg-stone-200 rounded w-16"></div>
        </div>
      </div>
      
      <!-- 骨架屏：阶段区域 -->
      <div class="flex-1 rounded-xl bg-stone-100/60 border border-stone-200/30" 
           [ngClass]="{'h-64': !isMobile, 'h-48': isMobile}">
        <div class="p-4 space-y-3">
          <div class="flex items-center gap-2">
            <div class="w-1 h-4 bg-stone-300 rounded"></div>
            <div class="h-4 bg-stone-200 rounded w-24"></div>
          </div>
          <div class="space-y-2">
            <div class="h-16 bg-stone-200/60 rounded-lg"></div>
            <div class="h-16 bg-stone-200/40 rounded-lg"></div>
          </div>
        </div>
      </div>
      
      <!-- 加载提示文字 -->
      <div class="text-center py-2">
        <span class="text-xs text-stone-400 font-light">正在加载数据...</span>
      </div>
    </div>
  `
})
export class TextViewLoadingComponent {
  @Input() isMobile = false;
}
