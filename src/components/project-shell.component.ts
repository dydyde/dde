import { 
  Component, 
  inject, 
  signal, 
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
import { TabSyncService } from '../services/tab-sync.service';
import { FlowCommandService } from '../services/flow-command.service';
import { TextViewComponent } from '../app/features/text';
import { FlowViewComponent } from '../app/features/flow';

/**
 * 项目视图外壳组件
 * 负责管理 text-view 和 flow-view 的切换显示
 * 对应路由: /projects/:projectId, /projects/:projectId/text, /projects/:projectId/flow
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 好处：
 * - 释放 GoJS canvas 占用的内存
 * - 避免僵尸模式下的 canvas 渲染问题
 * - 简化代码，无需手动 suspend/resume
 * 
 * 【懒加载策略】
 * @defer 需要组件在 imports 中声明才能工作
 * 代码分割依赖于：不使用 ViewChild 直接引用组件
 * 通过 FlowCommandService 实现 Shell 与 FlowView 的解耦通信
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
    <div class="relative flex h-full w-full min-h-0 overflow-hidden" style="background-color: var(--theme-bg);">
      @if (store.activeProjectId()) {
        <!-- Text Column - 允许滑动手势切换 -->
        <div class="flex flex-col min-w-[300px] min-h-0" 
             style="background-color: var(--theme-bg); border-color: var(--theme-border);"
             [class.border-r]="!store.isMobile()"
             [class.absolute]="store.isMobile()"
             [class.inset-0]="store.isMobile()"
             [class.w-full]="store.isMobile()"
             [class.flex-1]="store.isMobile()"
             [class.opacity-0]="store.isMobile() && store.activeView() !== 'text'"
             [class.opacity-100]="store.isMobile() && store.activeView() === 'text'"
             [class.pointer-events-none]="store.isMobile() && store.activeView() !== 'text'"
             [class.z-10]="store.isMobile() && store.activeView() === 'text'"
             [class.z-0]="store.isMobile() && store.activeView() !== 'text'"
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
                                  <span class="truncate">{{root.title || root.displayId || '未命名任务'}}</span>
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
                   <span class="font-bold text-stone-700 text-sm">文本</span>
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
                              <span class="truncate">{{root.title || root.displayId || '未命名任务'}}</span>
                              @if (store.filterMode() === root.id) { <span class="text-indigo-600 font-bold">✓</span> }
                          </div>
                      }
                  </div>
               }
             }
          </div>
          
          <!-- @defer 块用于懒加载视图组件 -->
          @defer (on immediate) {
            <app-text-view class="flex-1 min-h-0 overflow-hidden" (focusFlowNode)="onFocusFlowNode($event)"></app-text-view>
          } @placeholder {
            <div class="flex-1 flex items-center justify-center text-stone-400">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
            </div>
          } @error {
            <div class="flex-1 flex flex-col items-center justify-center text-stone-500 p-4 gap-4">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-center">文本视图加载失败</p>
              <button (click)="reloadPage()" class="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm hover:bg-indigo-600 transition-colors">
                刷新页面
              </button>
            </div>
          }
        </div>

        <!-- Content Resizer -->
        @if(!store.isMobile()) {
          <div class="w-1 hover:w-1.5 bg-transparent hover:bg-stone-300 cursor-col-resize z-20 flex-shrink-0 relative group"
               (mousedown)="startContentResize($event)">
               <div class="absolute inset-y-0 left-0 w-px bg-stone-200 group-hover:bg-stone-400 transition-colors"></div>
          </div>
        }

        <!-- Flow Column - 移动端条件渲染，桌面端始终显示 -->
        <!-- 使用 @defer 实现 GoJS 懒加载，减少首屏加载体积 -->
        @if (!store.isMobile() || store.activeView() === 'flow') {
           <div class="flex-1 flex flex-col min-w-[300px] min-h-0" 
             style="background-color: var(--theme-bg);"
             [class.absolute]="store.isMobile()"
             [class.inset-0]="store.isMobile()"
             [class.w-full]="store.isMobile()"
             [class.z-10]="store.isMobile()">
           <div class="flex items-center justify-between shrink-0 z-10"
                [ngClass]="{'h-14 mx-4 mt-4': !store.isMobile(), 'mx-2 mt-1.5 mb-0.5': store.isMobile()}">
              <span class="text-stone-700" [ngClass]="{'text-base font-bold text-stone-800': !store.isMobile(), 'text-sm font-bold': store.isMobile()}">
                @if (store.isMobile()) { 流程图 } @else { 流程视图 }
              </span>
              @if(store.isMobile()) {
                  <button data-testid="text-view-tab" (click)="switchToText()" class="btn-compact bg-indigo-500 text-white px-2 py-0.5 rounded text-[10px] font-medium active:bg-indigo-600">
                      文本
                  </button>
              }
           </div>
           <!-- @defer 块用于懒加载流程图组件 -->
           @defer (on immediate) {
             <app-flow-view class="flex-1 min-h-0 overflow-hidden relative" (goBackToText)="switchToText()"></app-flow-view>
           } @placeholder {
             <div class="flex-1 flex items-center justify-center text-stone-400">
               <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
             </div>
           } @error {
             <div class="flex-1 flex flex-col items-center justify-center text-stone-500 p-4 gap-4">
               <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
               </svg>
               <p class="text-sm text-center">流程图加载失败</p>
               <button (click)="reloadPage()" class="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm hover:bg-indigo-600 transition-colors">
                 刷新页面
               </button>
             </div>
           }
          </div>
        }
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
  private tabSync = inject(TabSyncService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroy$ = new Subject<void>();
  
  // 使用 FlowCommandService 替代 ViewChild，实现真正的懒加载
  // Shell 通过命令服务发布意图，FlowView 订阅并响应
  private readonly flowCommand = inject(FlowCommandService);
  
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
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  }
  
  ngOnInit() {
    // 监听路由参数变化
    this.route.params
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const projectId = params['projectId'];
        const taskId = params['taskId'];
        
        if (projectId && projectId !== this.store.activeProjectId()) {
          // 路由层已有 projectExistsGuard 负责校验与提示。
          // 这里不应在项目列表尚未加载完成时误判并弹 toast。
          this.store.activeProjectId.set(projectId);

          // 通知其他标签页当前项目已打开（仅在本地已有项目数据时）
          const project = this.store.projects().find(p => p.id === projectId);
          if (project) {
            this.tabSync.notifyProjectOpen(projectId, project.name);
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
      
      if (task) {
        // 任务存在，通过命令服务发送居中请求
        // FlowCommandService 会缓存命令直到 FlowView 就绪
        this.store.activeView.set('flow');
        
        // 等待图表渲染后定位
        this.deepLinkRetryTimer = setTimeout(() => {
          if (this.isDestroyed) return;
          this.flowCommand.centerOnNode(taskId, true);
          
          // 🔥 不再更新 URL - 避免触发路由导航销毁组件
          // 僵尸模式需要组件保持存活
        }, 100);
      } else if (retries < maxRetries && (isLoading || !task)) {
        // 数据尚未加载，继续重试，使用指数退避
        const delay = Math.min(baseDelay * Math.pow(1.5, retries - 1), maxDelay);
        this.deepLinkRetryTimer = setTimeout(tryFocusTask, delay);
      } else {
        // 超时未找到任务，导航到流程图视图并提示用户
        // 🔥 不再更新 URL - 避免触发路由导航销毁组件
        this.store.activeView.set('flow');
        
        // 根据情况显示不同提示，并提供明确的下一步操作
        if (!isLoading && !task) {
          // 任务确实不存在 - 提供创建新任务的选项
          this.toast.warning(
            '任务不存在', 
            '请求的任务可能已被删除或您没有访问权限',
            {
              duration: 10000,
              action: {
                label: '新建任务',
                onClick: () => {
                  // 触发创建新任务
                  this.store.addFloatingTask('新任务', '', 100, 100);
                  this.toast.success('已创建新任务');
                }
              }
            }
          );
        } else if (isLoading) {
          // 加载超时 - 提供重试选项
          this.toast.info(
            '加载超时', 
            '数据仍在加载中',
            {
              duration: 8000,
              action: {
                label: '刷新页面',
                onClick: () => window.location.reload()
              }
            }
          );
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
  
  /**
   * 切换到流程图视图
   * 移动端：使用条件渲染，FlowView 组件会被完全销毁/重建
   */
  switchToFlow() {
    this.store.activeView.set('flow');
  }
  
  switchToText() {
    console.log('[ProjectShell] switchToText 被调用', new Error().stack);
    this.store.activeView.set('text');
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
    if (!this.store.isMobile()) {
      // 通过命令服务发送居中请求，无需检查 flowView 实例
      this.flowCommand.centerOnNode(taskId, false);
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

      // 重要：一旦判断为“切换手势”，立刻阻止默认滚动/事件穿透。
      // 否则在切换到 Flow 后，同一触摸事件的后续阶段可能被 GoJS 捕获，引发画布抖动/跳位。
      e.preventDefault();
      e.stopPropagation();
    }
  }
  
  onTextViewTouchEnd(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (!this.textViewSwipeState.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.textViewSwipeState.startX;
    const threshold = 50; // 滑动阈值
    
    // 向左滑动切换到流程图
    if (deltaX < -threshold) {
      // 只在事件可取消时才阻止默认行为（避免浏览器警告）
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      setTimeout(() => {
        if (this.isDestroyed) return;
        this.switchToFlow();
      }, 0);
    }
    
    this.textViewSwipeState.isSwiping = false;
  }
  
  // ========== 错误边界重试回调 ==========
  
  /**
   * 重试加载文本视图
   */
  retryTextView(): void {
    // 强制刷新当前视图
    this.store.activeView.set('text');
  }
  
  /**
   * 重试加载流程图视图
   * FlowViewComponent 通过 @defer 延迟加载，通过命令服务发送重试命令
   */
  retryFlowView(): void {
    // 触发流程图重新初始化
    this.store.activeView.set('flow');
    // 通过命令服务发送重试命令
    // 命令会被缓存直到 FlowView 就绪
    this.flowCommand.retryDiagram();
  }
  
  /**
   * 刷新页面 - 用于 @defer 加载失败时的恢复
   * 清除可能导致问题的缓存并刷新
   */
  reloadPage(): void {
    // 清除 Service Worker 缓存（如果有）
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    }
    // 强制刷新页面，绕过缓存
    window.location.reload();
  }
}
