import { Component, input, output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';

/**
 * 流程图工具栏组件
 * 包含缩放、自动布局、连接模式等控制按钮
 */
@Component({
  selector: 'app-flow-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- Zoom Controls -->
    <div class="absolute z-10 flex gap-2"
         [class.transition-all]="!isResizingDrawer()"
         [class.duration-200]="!isResizingDrawer()"
         [class.flex-col]="!store.isMobile()"
         [class.flex-row]="store.isMobile()"
         [class.bottom-4]="!store.isMobile()"
         [class.left-4]="!store.isMobile()"
         [class.left-2]="store.isMobile()"
         [style.bottom.px]="store.isMobile() ? (store.isFlowDetailOpen() ? (drawerHeightVh() * windowInnerHeight / 100 + 8) : 8) : 16">
        
        <!-- 放大按钮 -->
        <button (click)="zoomIn.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!store.isMobile()"
                [class.p-1.5]="store.isMobile()"
                title="放大">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
        </button>
        
        <!-- 缩小按钮 -->
        <button (click)="zoomOut.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!store.isMobile()"
                [class.p-1.5]="store.isMobile()"
                title="缩小">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
        </button>
        
        <!-- 自动布局按钮 -->
        <button 
          (click)="autoLayout.emit()" 
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
          [class.p-2]="!store.isMobile()"
          [class.p-1.5]="store.isMobile()"
          title="自动整理布局">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
        </button>
        
        <!-- 连接模式按钮 -->
        <button (click)="toggleLinkMode.emit()" 
                class="backdrop-blur rounded-lg shadow-sm border transition-all hover:bg-stone-50" 
                [class.p-2]="!store.isMobile()" 
                [class.p-1.5]="store.isMobile()" 
                [class.bg-indigo-500]="isLinkMode()" 
                [class.text-white]="isLinkMode()" 
                [class.border-indigo-500]="isLinkMode()" 
                [class.bg-white]="!isLinkMode()" 
                [class.text-stone-600]="!isLinkMode()" 
                [class.border-stone-200]="!isLinkMode()" 
                title="连接模式">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" 
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()" 
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
        </button>
    </div>
    
    <!-- 连接模式提示 -->
    @if (isLinkMode()) {
      <div class="absolute z-10 bg-indigo-500 text-white font-medium rounded-lg shadow-lg animate-fade-in flex items-center px-3 py-2 text-xs top-4 left-4" 
           [ngClass]="{'top-2 left-1/2 -translate-x-1/2 px-2 py-1.5 max-w-[90vw]': store.isMobile(), 'text-[10px]': store.isMobile()}">
        @if (linkSourceTask(); as source) {
          <span class="truncate">已选: <span class="font-bold">{{ source.title }}</span></span>
          <span class="mx-1">&rarr;</span>
          <span>点击目标</span>
        } @else {
          点击源节点
        }
        <button (click)="cancelLinkMode.emit()" class="ml-2 px-1.5 py-0.5 bg-white/20 rounded hover:bg-white/30 transition-colors">取消</button>
      </div>
    }
  `
})
export class FlowToolbarComponent {
  readonly store = inject(StoreService);
  
  // 输入
  readonly isLinkMode = input<boolean>(false);
  readonly linkSourceTask = input<Task | null>(null);
  readonly isResizingDrawer = input<boolean>(false);
  readonly drawerHeightVh = input<number>(35);
  
  // 输出事件
  readonly zoomIn = output<void>();
  readonly zoomOut = output<void>();
  readonly autoLayout = output<void>();
  readonly toggleLinkMode = output<void>();
  readonly cancelLinkMode = output<void>();
  
  // 暴露 window.innerHeight 给模板
  readonly windowInnerHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
}
