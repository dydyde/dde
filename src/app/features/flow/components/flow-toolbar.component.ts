import { Component, input, output, computed, inject, HostListener, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { Task } from '../../../../models';

/**
 * 流程图工具栏组件
 * 包含缩放、自动布局、连接模式、导出等控制按钮
 * 移动端额外提供侧边栏切换按钮
 */
@Component({
  selector: 'app-flow-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- 移动端顶部工具栏：侧边栏切换按钮 + 返回文本视图 -->
    @if (uiState.isMobile()) {
      <div class="absolute left-2 z-30 flex items-center gap-2 transition-all duration-200"
           [style.top]="mobileTopPosition()">
        <!-- 侧边栏/项目列表切换按钮 -->
        <button 
          (click)="toggleSidebar.emit()"
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center"
          title="打开项目列表">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        
        <!-- 返回文本视图按钮 -->
        <button 
          (click)="goBackToText.emit()"
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center gap-1"
          title="返回文本视图">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          <span class="text-[10px] font-medium">文本</span>
        </button>
      </div>
    }

    <!-- Zoom Controls -->
    <div class="absolute z-10 flex gap-2"
         [class.flex-col]="!uiState.isMobile()"
         [class.flex-row]="uiState.isMobile()"
         [class.bottom-4]="!uiState.isMobile()"
         [class.left-4]="!uiState.isMobile()"
         [class.left-2]="uiState.isMobile()"
         [style.bottom]="mobileBottomPosition()">
        
        <!-- 放大按钮 -->
        <button (click)="zoomIn.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!uiState.isMobile()"
                [class.p-1.5]="uiState.isMobile()"
                title="放大">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!uiState.isMobile()" [class.w-5]="!uiState.isMobile()"
                 [class.h-4]="uiState.isMobile()" [class.w-4]="uiState.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
        </button>
        
        <!-- 缩小按钮 -->
        <button (click)="zoomOut.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!uiState.isMobile()"
                [class.p-1.5]="uiState.isMobile()"
                title="缩小">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!uiState.isMobile()" [class.w-5]="!uiState.isMobile()"
                 [class.h-4]="uiState.isMobile()" [class.w-4]="uiState.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
        </button>
        
        <!-- 自动布局按钮 -->
        <button 
          (click)="autoLayout.emit()" 
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
          [class.p-2]="!uiState.isMobile()"
          [class.p-1.5]="uiState.isMobile()"
          title="自动整理布局">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!uiState.isMobile()" [class.w-5]="!uiState.isMobile()"
                 [class.h-4]="uiState.isMobile()" [class.w-4]="uiState.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
        </button>
        
        <!-- 连接模式按钮 -->
        <button (click)="toggleLinkMode.emit()" 
                class="backdrop-blur rounded-lg shadow-sm border transition-all hover:bg-stone-50" 
                [class.p-2]="!uiState.isMobile()" 
                [class.p-1.5]="uiState.isMobile()" 
                [class.bg-indigo-500]="isLinkMode()" 
                [class.text-white]="isLinkMode()" 
                [class.border-indigo-500]="isLinkMode()" 
                [class.bg-white]="!isLinkMode()" 
                [class.text-stone-600]="!isLinkMode()" 
                [class.border-stone-200]="!isLinkMode()" 
                title="连接模式">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" 
                 [class.h-5]="!uiState.isMobile()" [class.w-5]="!uiState.isMobile()" 
                 [class.h-4]="uiState.isMobile()" [class.w-4]="uiState.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
        </button>
        
        <!-- 移动端：框选模式切换按钮 -->
        @if (uiState.isMobile()) {
          <button
            type="button"
            (pointerdown)="onToggleSelectModePointerDown($event)"
            class="backdrop-blur rounded-lg shadow-sm border transition-all hover:bg-stone-50 p-1.5" 
                  [class.bg-amber-500]="isSelectMode()" 
                  [class.text-white]="isSelectMode()" 
                  [class.border-amber-500]="isSelectMode()" 
                  [class.bg-white]="!isSelectMode()" 
                  [class.text-stone-600]="!isSelectMode()" 
                  [class.border-stone-200]="!isSelectMode()" 
                  title="框选模式">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="h-4 w-4">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 010 2H5a1 1 0 01-1-1zM3 10a1 1 0 011-1h10a1 1 0 110 2H4a1 1 0 01-1-1zM14 14a1 1 0 011-1h5a1 1 0 110 2h-5a1 1 0 01-1-1zM15 19a1 1 0 011-1h4a1 1 0 110 2h-4a1 1 0 01-1-1zM5 14a1 1 0 011-1h5a1 1 0 110 2H6a1 1 0 01-1-1z" />
              </svg>
          </button>
        }
        
        <!-- 导出按钮 -->
        <div class="relative" #exportMenu>
          <button 
            (click)="toggleExportMenu()"
            class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
            [class.p-2]="!uiState.isMobile()"
            [class.p-1.5]="uiState.isMobile()"
            [class.bg-emerald-500]="isExportMenuOpen"
            [class.text-white]="isExportMenuOpen"
            [class.border-emerald-500]="isExportMenuOpen"
            title="导出流程图">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!uiState.isMobile()" [class.w-5]="!uiState.isMobile()"
                 [class.h-4]="uiState.isMobile()" [class.w-4]="uiState.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          
          <!-- 导出菜单 -->
          @if (isExportMenuOpen) {
            <div class="absolute z-20 bg-white rounded-lg shadow-lg border border-stone-200 py-1 min-w-[140px]"
                 [class.bottom-full]="!uiState.isMobile()"
                 [class.mb-2]="!uiState.isMobile()"
                 [class.left-0]="!uiState.isMobile()"
                 [class.top-full]="uiState.isMobile()"
                 [class.mt-2]="uiState.isMobile()"
                 [class.right-0]="uiState.isMobile()">
              <button 
                (click)="onExportPng()"
                class="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 flex items-center gap-2">
                <svg class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                导出 PNG
              </button>
              <button 
                (click)="onExportSvg()"
                class="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 flex items-center gap-2">
                <svg class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                导出 SVG
              </button>
              @if (userSession.currentUserId()) {
                <div class="border-t border-stone-100 my-1"></div>
                <button 
                  (click)="onSaveToCloud()"
                  [disabled]="isUploading"
                  class="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                  @if (isUploading) {
                    <svg class="w-4 h-4 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    上传中...
                  } @else {
                    <svg class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    保存到云端
                  }
                </button>
              }
            </div>
          }
        </div>
    </div>
    
    <!-- 连接模式提示 -->
    @if (isLinkMode()) {
      <div class="absolute z-10 bg-indigo-500 text-white font-medium rounded-lg shadow-lg animate-fade-in flex items-center px-3 py-2 text-xs top-4 left-4" 
           [ngClass]="{'top-2 left-1/2 -translate-x-1/2 px-2 py-1.5 max-w-[90vw]': uiState.isMobile(), 'text-[10px]': uiState.isMobile()}">
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
  // P2-1 迁移：直接注入子服务
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly elementRef = inject(ElementRef);
  
  @ViewChild('exportMenu') exportMenuRef!: ElementRef;
  
  // 输入
  readonly isLinkMode = input<boolean>(false);
  readonly linkSourceTask = input<Task | null>(null);
  readonly isResizingDrawer = input<boolean>(false);
  readonly drawerHeightVh = input<number>(35);
  /** 移动端：是否处于框选模式 */
  readonly isSelectMode = input<boolean>(false);
  
  // 输出事件
  readonly zoomIn = output<void>();
  readonly zoomOut = output<void>();
  readonly autoLayout = output<void>();
  readonly toggleLinkMode = output<void>();
  readonly cancelLinkMode = output<void>();
  readonly toggleSidebar = output<void>();
  readonly goBackToText = output<void>();
  readonly exportPng = output<void>();
  readonly exportSvg = output<void>();
  readonly saveToCloud = output<void>();
  /** 移动端：切换框选模式 */
  readonly toggleSelectMode = output<void>();
  
  // 导出菜单状态
  isExportMenuOpen = false;
  isUploading = false;
  
  // 计算移动端工具栏底部位置
  // 抽屉在顶部，工具栏固定在底部
  readonly mobileBottomPosition = computed(() => {
    return '8px'; // 固定在底部
  });
  
  // 计算移动端顶部按钮位置
  // 当详情栏展开时，按钮紧贴拖动条底部
  readonly mobileTopPosition = computed(() => {
    if (!this.uiState.isFlowDetailOpen()) {
      return '8px'; // 详情栏关闭时，固定在顶部
    }
    // 详情栏开启时，按钮紧贴抽屉底部边缘
    const drawerHeightPx = (this.drawerHeightVh() / 100) * window.innerHeight;
    return `${drawerHeightPx}px`;
  });
  
  toggleExportMenu() {
    this.isExportMenuOpen = !this.isExportMenuOpen;
  }
  
  onExportPng() {
    this.isExportMenuOpen = false;
    this.exportPng.emit();
  }
  
  onExportSvg() {
    this.isExportMenuOpen = false;
    this.exportSvg.emit();
  }
  
  onSaveToCloud() {
    this.isExportMenuOpen = false;
    this.isUploading = true;
    this.saveToCloud.emit();
  }
  
  setUploadComplete() {
    this.isUploading = false;
  }

  onToggleSelectModePointerDown(event: PointerEvent): void {
    // 移动端：避免 GoJS/浏览器默认手势吞掉 click，使用 pointerdown 立即响应
    event.preventDefault();
    event.stopPropagation();
    this.toggleSelectMode.emit();
  }
  
  // 点击外部区域关闭菜单
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    if (this.isExportMenuOpen && this.exportMenuRef) {
      const target = event.target as HTMLElement;
      if (!this.exportMenuRef.nativeElement.contains(target)) {
        this.isExportMenuOpen = false;
      }
    }
  }
}
