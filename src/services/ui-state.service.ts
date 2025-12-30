import { Injectable, signal, computed, DestroyRef, inject } from '@angular/core';

/**
 * UI 状态服务
 * 从 StoreService 拆分出来，专门管理 UI 状态
 * 
 * 【职责边界】
 * ✓ 侧边栏宽度、展开状态
 * ✓ 视图切换（text/flow）
 * ✓ 搜索查询状态（纯 UI 状态，不包含搜索逻辑）
 * ✓ 移动端检测
 * ✓ 文本视图分栏比例
 * ✓ 筛选器状态
 * ✗ 主题管理 → ThemeService
 * ✗ 搜索逻辑 → SearchService（未来拆分）
 */
@Injectable({
  providedIn: 'root'
})
export class UiStateService {
  private destroyRef = inject(DestroyRef);
  
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
  
  // ========== 筛选器状态 ==========
  
  /** 筛选模式（根任务筛选） */
  readonly filterMode = signal<'all' | string>('all');
  
  /** 阶段视图根筛选 */
  readonly stageViewRootFilter = signal<'all' | string>('all');
  
  /** 阶段筛选 */
  readonly stageFilter = signal<'all' | number>('all');
  
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
  
  // ========== 搜索状态（纯 UI 状态） ==========
  
  /** 统一搜索查询 */
  readonly searchQuery = signal<string>('');
  
  /** 项目列表搜索查询 */
  readonly projectSearchQuery = signal<string>('');
  
  /** 防抖后的搜索查询 */
  readonly debouncedSearchQuery = signal<string>('');
  
  /** 搜索防抖定时器 */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 编辑状态 ==========
  
  /** 是否正在编辑 */
  private _isEditing = false;
  
  /** 编辑状态定时器 */
  private editingTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 
   * 编辑版本号 - 用于解决定时器回调竞态条件
   * 每次 markEditing() 调用都会递增，定时器只有在版本号匹配时才清除编辑状态
   */
  private _editingVersion = 0;
  
  /** 编辑超时时间（毫秒） */
  private static readonly EDITING_TIMEOUT = 5000;
  
  // ========== 计算属性 ==========
  
  /** 是否有活动搜索 */
  readonly hasActiveSearch = computed(() => this.searchQuery().length > 0);
  
  constructor() {
    this.setupResizeListener();
    this.loadLocalPreferences();
    
    this.destroyRef.onDestroy(() => {
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
      }
      if (this.editingTimer) {
        clearTimeout(this.editingTimer);
      }
    });
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
   * 设置阶段筛选
   */
  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
  }
  
  /**
   * 设置筛选模式
   */
  setFilterMode(mode: 'all' | string) {
    this.filterMode.set(mode);
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
   * 重置筛选器状态
   */
  resetFilters(): void {
    this.filterMode.set('all');
    this.stageViewRootFilter.set('all');
    this.stageFilter.set('all');
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
  
  /**
   * 标记正在编辑
   * 用于防止远程更新覆盖用户正在编辑的内容
   * 使用版本号机制解决定时器回调与新调用之间的竞态条件
   */
  markEditing(): void {
    this._isEditing = true;
    
    // 递增版本号，标记这是一个新的编辑会话
    const currentVersion = ++this._editingVersion;
    
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
    }
    
    this.editingTimer = setTimeout(() => {
      // 只有当版本号仍匹配时才清除编辑状态
      // 如果在超时期间又调用了 markEditing()，版本号会不匹配，此回调将被忽略
      if (this._editingVersion === currentVersion) {
        this._isEditing = false;
      }
      this.editingTimer = null;
    }, UiStateService.EDITING_TIMEOUT);
  }
  
  /**
   * 是否正在编辑
   */
  get isEditing(): boolean {
    return this._isEditing;
  }
  
  /**
   * 清除编辑状态
   */
  clearEditingState(): void {
    this._isEditing = false;
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
      this.editingTimer = null;
    }
  }
  
  /**
   * 清空所有 UI 状态
   * 包括重置编辑版本号，防止版本号无限增长
   */
  clearAllState(): void {
    this.clearSearch();
    this.resetFilters();
    this.clearEditingState();
    this.isFlowDetailOpen.set(false);
    
    // 重置编辑版本号（防止跨会话的版本号无限增长）
    this._editingVersion = 0;
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 设置窗口大小监听
   */
  private setupResizeListener() {
    if (typeof window === 'undefined') return;
    
    const handleResize = () => {
      this.isMobile.set(window.innerWidth < 768);
    };
    
    window.addEventListener('resize', handleResize);
    
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('resize', handleResize);
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
