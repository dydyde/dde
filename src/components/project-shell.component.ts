import { 
  Component, 
  inject, 
  signal, 
  ViewChild, 
  OnInit, 
  OnDestroy,
  HostListener 
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { StoreService } from '../services/store.service';
import { ToastService } from '../services/toast.service';
import { TextViewComponent } from './text-view.component';
import { FlowViewComponent } from './flow-view.component';

/**
 * 项目视图外壳组件
 * 负责管理 text-view 和 flow-view 的切换显示
 * 对应路由: /projects/:projectId, /projects/:projectId/text, /projects/:projectId/flow
 */
@Component({
  selector: 'app-project-shell',
  standalone: true,
  imports: [CommonModule, TextViewComponent, FlowViewComponent],
  styles: [`
    :host {
      display: flex;
      flex: 1;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
  `],
  template: `
    <div class="flex h-full w-full overflow-hidden" style="background-color: var(--theme-bg);">
      @if (store.activeProjectId()) {
        <!-- Text Column - 允许滑动手势切换 -->
        <div class="flex flex-col border-r min-w-[300px]" 
             style="background-color: var(--theme-bg); border-color: var(--theme-border);"
             [class.hidden]="store.isMobile() && store.activeView() !== 'text'"
             [class.w-full]="store.isMobile()"
             [class.flex-1]="store.isMobile()"
             [class.min-h-0]="store.isMobile()"
             [style.width.%]="store.isMobile() ? 100 : store.textColumnRatio()"
             (touchstart)="onTextViewTouchStart($event)"
             (touchmove)="onTextViewTouchMove($event)"
             (touchend)="onTextViewTouchEnd($event)">
          
          <!-- Header for Text Column -->
          <div class="shrink-0 z-10"
               [ngClass]="{'h-16 mx-6 mt-6': !store.isMobile(), 'mx-2 mt-2 mb-1': store.isMobile()}">
             
             <!-- Desktop Layout -->
             @if (!store.isMobile()) {
               <div class="h-full flex items-center justify-between">
                 <div class="flex items-center gap-3">
                   <button (click)="toggleSidebar()" 
                           class="text-stone-400 hover:text-stone-600 transition-colors p-2 hover:bg-stone-200/50 rounded-full" 
                           aria-label="切换侧边栏">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                   </button>
                   <span class="font-bold text-stone-800 text-lg tracking-tight">文本视图</span>
                 </div>
                 
                 <!-- Filter -->
                 <div class="relative flex items-center gap-2">
                   <button 
                      (click)="isFilterOpen.set(!isFilterOpen()); $event.stopPropagation()"
                      class="flex items-center gap-2 bg-transparent text-xs font-medium text-stone-500 hover:text-indigo-800 transition-colors py-1.5 px-3 rounded-lg hover:bg-indigo-50 border border-transparent active:bg-indigo-100">
                       <span>{{ currentFilterLabel() }}</span>
                       <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 transition-transform duration-200" [class.rotate-180]="isFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                       </svg>
                   </button>
                   
                   @if (isFilterOpen()) {
                      <div class="fixed inset-0 z-40" (click)="isFilterOpen.set(false)"></div>
                      <div class="absolute right-0 top-full mt-1 w-48 bg-white/90 backdrop-blur-xl border border-stone-100 rounded-xl shadow-lg z-50 py-1 animate-dropdown overflow-hidden">
                          <div 
                              (click)="store.filterMode.set('all'); isFilterOpen.set(false)"
                              class="px-4 py-2.5 text-xs text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between group transition-colors">
                              <span>全部任务</span>
                              @if (store.filterMode() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                          </div>
                          <div class="h-px bg-stone-100 my-1"></div>
                          @for(root of store.rootTasks(); track root.id) {
                              <div 
                                  (click)="store.filterMode.set(root.id); isFilterOpen.set(false)"
                                  class="px-4 py-2.5 text-xs text-stone-600 hover:bg-indigo-50 hover:text-indigo-900 cursor-pointer flex items-center justify-between group transition-colors">
                                  <span class="truncate">{{root.title}}</span>
                                  @if (store.filterMode() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                              </div>
                          }
                      </div>
                   }
                 </div>
               </div>
             }
             
             <!-- Mobile Layout: Compact -->
             @if (store.isMobile()) {
               <div class="flex items-center justify-between gap-2">
                 <div class="flex items-center gap-2 min-w-0">
                   <button (click)="toggleSidebar()" class="btn-compact text-stone-400 p-1 rounded-lg active:bg-stone-200/50 shrink-0" aria-label="菜单">
                      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                   </button>
                   <span class="font-medium text-stone-700 text-xs">文本</span>
                 </div>
                 
                 <div class="flex items-center gap-1 shrink-0">
                   <button 
                      (click)="isFilterOpen.set(!isFilterOpen()); $event.stopPropagation()"
                      class="btn-compact flex items-center gap-1 text-[10px] text-stone-500 py-0.5 px-1.5 rounded bg-stone-100/80 active:bg-stone-200 max-w-[80px]">
                       <span class="truncate">{{ currentFilterLabel() }}</span>
                       <svg class="h-2 w-2 shrink-0" [class.rotate-180]="isFilterOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                       </svg>
                   </button>
                   
                   <button data-testid="flow-view-tab" (click)="switchToFlow()" class="btn-compact bg-indigo-500 text-white px-2 py-0.5 rounded text-[10px] font-medium active:bg-indigo-600">
                      流程图
                   </button>
                 </div>
               </div>
               
               @if (isFilterOpen()) {
                  <div class="fixed inset-0 z-40" (click)="isFilterOpen.set(false)"></div>
                  <div class="absolute right-3 top-12 w-44 bg-white/95 backdrop-blur-xl border border-stone-200 rounded-lg shadow-xl z-50 py-1 animate-dropdown overflow-hidden">
                      <div 
                          (click)="store.filterMode.set('all'); isFilterOpen.set(false)"
                          class="px-3 py-2 text-xs text-stone-600 active:bg-indigo-50 cursor-pointer flex items-center justify-between">
                          <span>全部任务</span>
                          @if (store.filterMode() === 'all') { <span class="text-indigo-600 font-bold">✓</span> }
                      </div>
                      <div class="h-px bg-stone-100"></div>
                      @for(root of store.rootTasks(); track root.id) {
                          <div 
                              (click)="store.filterMode.set(root.id); isFilterOpen.set(false)"
                              class="px-3 py-2 text-xs text-stone-600 active:bg-indigo-50 cursor-pointer flex items-center justify-between">
                              <span class="truncate">{{root.title}}</span>
                              @if (store.filterMode() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                          </div>
                      }
                  </div>
               }
             }
          </div>
          
          <app-text-view class="flex-1 min-h-0 overflow-hidden" (focusFlowNode)="onFocusFlowNode($event)"></app-text-view>
        </div>

        <!-- Content Resizer -->
        @if(!store.isMobile()) {
          <div class="w-1 hover:w-1.5 bg-transparent hover:bg-stone-300 cursor-col-resize z-20 flex-shrink-0 relative group"
               (mousedown)="startContentResize($event)">
               <div class="absolute inset-y-0 left-0 w-px bg-stone-200 group-hover:bg-stone-400 transition-colors"></div>
          </div>
        }

        <!-- Flow Column -->
        <div class="flex-1 flex flex-col min-w-[300px] relative" 
             style="background-color: var(--theme-bg);"
             [class.hidden]="store.isMobile() && store.activeView() !== 'flow'"
             [class.w-full]="store.isMobile()">
           <div class="flex items-center justify-between shrink-0 z-10"
                [ngClass]="{'h-16 mx-6 mt-6': !store.isMobile(), 'mx-2 mt-2 mb-1': store.isMobile()}">
              <span class="font-medium text-stone-700" [ngClass]="{'text-lg font-bold text-stone-800': !store.isMobile(), 'text-xs': store.isMobile()}">
                @if (store.isMobile()) { 流程图 } @else { 流程视图 }
              </span>
              @if(store.isMobile()) {
                  <button data-testid="text-view-tab" (click)="switchToText()" class="btn-compact bg-indigo-500 text-white px-2 py-0.5 rounded text-[10px] font-medium active:bg-indigo-600">
                      文本
                  </button>
              }
           </div>
           <app-flow-view class="flex-1 overflow-hidden" (goBackToText)="switchToText()"></app-flow-view>
        </div>
      } @else {
        <!-- 无活动项目时的占位 -->
        <div class="flex-1 flex items-center justify-center text-stone-300 flex-col gap-6 p-4">
          <div class="w-24 h-24 rounded-full bg-stone-100 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
          </div>
          <p class="font-light tracking-widest text-sm text-center">请选择或创建一个项目</p>
        </div>
      }
    </div>
  `
})
export class ProjectShellComponent implements OnInit, OnDestroy {
  store = inject(StoreService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroy$ = new Subject<void>();
  
  @ViewChild(FlowViewComponent) flowView?: FlowViewComponent;
  
  // UI 状态
  isFilterOpen = signal(false);
  // 使用 store.activeView 代替本地的 mobileActiveView，使其他组件可以访问当前视图状态
  
  // 内容调整状态
  private isResizingContent = false;
  private startX = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  
  // 手机端滑动手势状态 - 用于文本视图切换到流程图
  private textViewSwipeState = {
    startX: 0,
    startY: 0,
    isSwiping: false
  };
  
  // 组件销毁标志 - 用于取消待执行的递归 setTimeout
  private isDestroyed = false;
  // 任务深链接重试定时器 - 用于组件销毁时取消
  private deepLinkRetryTimer: ReturnType<typeof setTimeout> | null = null;
  
  // 计算属性
  currentFilterLabel() {
    const filterId = this.store.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.store.rootTasks().find(t => t.id === filterId);
    return task ? task.title : '全部任务';
  }
  
  ngOnInit() {
    // 监听路由参数变化
    this.route.params
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const projectId = params['projectId'];
        const taskId = params['taskId'];
        
        if (projectId && projectId !== this.store.activeProjectId()) {
          const projectExists = this.store.projects().some(p => p.id === projectId);
          if (projectExists) {
            this.store.activeProjectId.set(projectId);
          } else {
            // 项目不存在，显示提示并重定向到项目列表
            this.toast.warning('项目不存在', '请求的项目可能已被删除或您没有访问权限');
            void this.router.navigate(['/projects']);
            return;
          }
        }
        
        // 处理任务深链接定位
        if (taskId) {
          // 延迟执行以确保项目和任务数据已加载
          this.handleTaskDeepLink(taskId);
        }
      });
    
    // 监听子路由变化来确定视图模式
    this.route.url
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        const currentUrl = this.router.url;
        if (currentUrl.endsWith('/flow')) {
          this.store.activeView.set('flow');
        } else if (currentUrl.endsWith('/text')) {
          this.store.activeView.set('text');
        } else if (currentUrl.includes('/task/')) {
          // 任务深链接默认使用流程图视图
          this.store.activeView.set('flow');
        }
      });
  }
  
  /**
   * 处理任务深链接定位
   * 等待任务数据加载后定位到指定任务
   * 使用指数退避策略减少不必要的等待
   */
  private handleTaskDeepLink(taskId: string) {
    const maxRetries = 10;
    const baseDelay = 100;
    const maxDelay = 2000;
    let retries = 0;
    
    const tryFocusTask = () => {
      // 检查组件是否已销毁，停止递归
      if (this.isDestroyed) return;
      
      retries++;
      const tasks = this.store.tasks();
      const task = tasks.find(t => t.id === taskId);
      const isLoading = this.store.isLoadingRemote?.() ?? (tasks.length === 0);
      
      if (task && this.flowView) {
        // 任务存在且 flowView 已初始化
        // 切换到流程图视图
        this.store.activeView.set('flow');
        
        // 等待图表渲染后定位
        this.deepLinkRetryTimer = setTimeout(() => {
          if (this.isDestroyed) return;
          this.flowView?.centerOnNode(taskId, true);
          
          // 更新 URL 为常规流程图 URL（移除 task 路径）
          const projectId = this.store.activeProjectId();
          if (projectId) {
            void this.router.navigate(['/projects', projectId, 'flow'], { replaceUrl: true });
          }
        }, 100);
      } else if (retries < maxRetries && (isLoading || !task)) {
        // 数据尚未加载，继续重试，使用指数退避
        const delay = Math.min(baseDelay * Math.pow(1.5, retries - 1), maxDelay);
        this.deepLinkRetryTimer = setTimeout(tryFocusTask, delay);
      } else {
        // 超时未找到任务，导航到流程图视图并提示用户
        const projectId = this.store.activeProjectId();
        if (projectId) {
          void this.router.navigate(['/projects', projectId, 'flow'], { replaceUrl: true });
          
          // 如果任务确实不存在（而不是加载超时），显示提示
          if (!isLoading && !task) {
            this.toast.warning('任务不存在', '请求的任务可能已被删除或您没有访问权限');
          }
        }
      }
    };
    
    // 开始尝试定位
    this.deepLinkRetryTimer = setTimeout(tryFocusTask, 100);
  }
  
  ngOnDestroy() {
    // 设置销毁标志，停止所有递归 setTimeout
    this.isDestroyed = true;
    
    // 清理待执行的定时器
    if (this.deepLinkRetryTimer) {
      clearTimeout(this.deepLinkRetryTimer);
      this.deepLinkRetryTimer = null;
    }
    
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  // ========== 视图切换 ==========
  
  switchToFlow() {
    this.store.activeView.set('flow');
    // 更新 URL
    const projectId = this.store.activeProjectId();
    if (projectId) {
      void this.router.navigate(['/projects', projectId, 'flow'], { replaceUrl: true });
    }
    setTimeout(() => {
      if (this.isDestroyed) return;
      this.flowView?.refreshLayout();
    }, 100);
  }
  
  switchToText() {
    this.store.activeView.set('text');
    // 更新 URL
    const projectId = this.store.activeProjectId();
    if (projectId) {
      void this.router.navigate(['/projects', projectId, 'text'], { replaceUrl: true });
    }
  }
  
  // ========== 侧边栏控制 ==========
  
  toggleSidebar() {
    // 通过事件通知父组件切换侧边栏
    // 移动端和桌面端都使用全局事件来控制侧边栏
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }
  
  private navigateToProjectList() {
    void this.router.navigate(['/projects']);
  }
  
  // ========== 流程图节点定位 ==========
  
  onFocusFlowNode(taskId: string) {
    if (!this.store.isMobile() && this.flowView) {
      this.flowView.centerOnNode(taskId, false);
    }
  }
  
  // ========== 内容区域调整 ==========
  
  startContentResize(e: MouseEvent) {
    e.preventDefault();
    this.isResizingContent = true;
    this.startX = e.clientX;
    this.startRatio = this.store.textColumnRatio();
    
    const mainEl = document.querySelector('main');
    this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
    
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }
  
  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
    if (this.isResizingContent) {
      e.preventDefault();
      const delta = e.clientX - this.startX;
      const deltaPercent = (delta / this.mainContentWidth) * 100;
      const newRatio = Math.max(25, Math.min(75, this.startRatio + deltaPercent));
      this.store.textColumnRatio.set(newRatio);
    }
  }
  
  @HostListener('document:mouseup')
  onMouseUp() {
    if (this.isResizingContent) {
      this.isResizingContent = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }
  
  // ========== 文本视图滑动手势 ==========
  // 允许从文本视图向左滑动切换到流程图
  // 流程图视图不处理滑动手势，避免与画布操作冲突
  
  onTextViewTouchStart(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.textViewSwipeState = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      isSwiping: false
    };
  }
  
  onTextViewTouchMove(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.textViewSwipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - this.textViewSwipeState.startY);
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势
    // 向左滑动（deltaX < 0）切换到流程图
    if (deltaX < -30 && Math.abs(deltaX) > deltaY * 1.5) {
      this.textViewSwipeState.isSwiping = true;
    }
  }
  
  onTextViewTouchEnd(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (!this.textViewSwipeState.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.textViewSwipeState.startX;
    const threshold = 50; // 滑动阈值
    
    // 向左滑动切换到流程图
    if (deltaX < -threshold) {
      this.switchToFlow();
    }
    
    this.textViewSwipeState.isSwiping = false;
  }
}
