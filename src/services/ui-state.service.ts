import { Injectable, signal, computed } from '@angular/core';

/**
 * UI 状态服务
 * 从 StoreService 拆分出来，专门管理 UI 状态
 * 职责：
 * - 侧边栏宽度、展开状态
 * - 视图切换（text/flow）
 * - 搜索查询状态
 * - Loading 状态
 * - 移动端检测
 * - 文本视图分栏比例
 */
@Injectable({
  providedIn: 'root'
})
export class UiStateService {
  // ========== 响应式状态 ==========
  
  /** 是否为移动端 */
  readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth < 768);
  
  /** 侧边栏宽度 */
  readonly sidebarWidth = signal(280);
  
  /** 文本视图分栏比例 */
  readonly textColumnRatio = signal(50);
  
  /** 布局方向 */
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  
  /** 浮动窗口偏好 */
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');
  
  /** 当前视图 */
  readonly activeView = signal<'text' | 'flow' | null>('text');
  
  // ========== 面板展开状态 ==========
  
  /** 文本视图 - 未完成任务面板展开 */
  readonly isTextUnfinishedOpen = signal(true);
  
  /** 文本视图 - 未分配任务面板展开 */
  readonly isTextUnassignedOpen = signal(true);
  
  /** 流程图视图 - 未完成任务面板展开 */
  readonly isFlowUnfinishedOpen = signal(true);
  
  /** 流程图视图 - 未分配任务面板展开 */
  readonly isFlowUnassignedOpen = signal(true);
  
  /** 流程图视图 - 详情面板展开 */
  readonly isFlowDetailOpen = signal(false);
  
  // ========== 搜索状态 ==========
  
  /** 统一搜索查询 */
  readonly searchQuery = signal<string>('');
  
  /** 项目列表搜索查询 */
  readonly projectSearchQuery = signal<string>('');
  
  /** 防抖后的搜索查询 */
  private readonly debouncedSearchQuery = signal<string>('');
  
  /** 搜索防抖定时器 */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 计算属性 ==========
  
  /** 是否有活动搜索 */
  readonly hasActiveSearch = computed(() => this.searchQuery().length > 0);
  
  constructor() {
    this.setupResizeListener();
    this.loadLocalPreferences();
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 切换视图
   */
  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }
  
  /**
   * 确保显示指定视图
   */
  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }
  
  /**
   * 设置搜索查询（带防抖）
   */
  setSearchQueryDebounced(query: string, delay: number = 300): void {
    this.searchQuery.set(query);
    
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    
    this.searchDebounceTimer = setTimeout(() => {
      this.debouncedSearchQuery.set(query);
      this.searchDebounceTimer = null;
    }, delay);
  }
  
  /**
   * 清除搜索查询
   */
  clearSearch(): void {
    this.searchQuery.set('');
    this.projectSearchQuery.set('');
    this.debouncedSearchQuery.set('');
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }
  
  /**
   * 设置侧边栏宽度
   */
  setSidebarWidth(width: number) {
    this.sidebarWidth.set(Math.max(200, Math.min(400, width)));
  }
  
  /**
   * 设置文本视图分栏比例
   */
  setTextColumnRatio(ratio: number) {
    this.textColumnRatio.set(Math.max(20, Math.min(80, ratio)));
  }
  
  /**
   * 设置布局方向
   */
  setLayoutDirection(direction: 'ltr' | 'rtl') {
    this.layoutDirection.set(direction);
    localStorage.setItem('nanoflow.layout-direction', direction);
  }
  
  /**
   * 设置浮动窗口偏好
   */
  setFloatingWindowPref(pref: 'auto' | 'fixed') {
    this.floatingWindowPref.set(pref);
    localStorage.setItem('nanoflow.floating-window-pref', pref);
  }
  
  /**
   * 切换流程图详情面板
   */
  toggleFlowDetailPanel() {
    this.isFlowDetailOpen.update(v => !v);
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 设置窗口大小监听
   */
  private setupResizeListener() {
    if (typeof window === 'undefined') return;
    
    window.addEventListener('resize', () => {
      this.isMobile.set(window.innerWidth < 768);
    });
  }
  
  /**
   * 加载本地偏好设置
   */
  private loadLocalPreferences() {
    if (typeof localStorage === 'undefined') return;
    
    const layoutDir = localStorage.getItem('nanoflow.layout-direction') as 'ltr' | 'rtl' | null;
    if (layoutDir) {
      this.layoutDirection.set(layoutDir);
    }
    
    const floatingPref = localStorage.getItem('nanoflow.floating-window-pref') as 'auto' | 'fixed' | null;
    if (floatingPref) {
      this.floatingWindowPref.set(floatingPref);
    }
  }
}
