import { Component, inject, signal, HostListener, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, NavigationEnd, RouterOutlet } from '@angular/router';
import { StoreService } from './services/store.service';
import { AuthService } from './services/auth.service';
import { UndoService } from './services/undo.service';
import { ToastService } from './services/toast.service';
import { ActionQueueService } from './services/action-queue.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { MigrationService } from './services/migration.service';
import { GlobalErrorHandler } from './services/global-error-handler.service';
import { ModalService, type DeleteProjectData, type ConflictData, type LoginData } from './services/modal.service';
import { DynamicModalService } from './services/dynamic-modal.service';
import { SyncCoordinatorService } from './services/sync-coordinator.service';
import { ModalLoaderService } from './app/core/services/modal-loader.service';
import { enableLocalMode, disableLocalMode } from './services/guards';
import { ToastContainerComponent } from './components/toast-container.component';
import { SyncStatusComponent } from './components/sync-status.component';
import { OfflineBannerComponent } from './components/offline-banner.component';
import { 
  SettingsModalComponent, 
  LoginModalComponent, 
  ConflictModalComponent, 
  NewProjectModalComponent, 
  ConfigHelpModalComponent,
  TrashModalComponent,
  MigrationModalComponent,
  ErrorRecoveryModalComponent,
  StorageEscapeModalComponent,
  StorageEscapeData,
  DashboardModalComponent
} from './components/modals';
import { ErrorBoundaryComponent } from './components/error-boundary.component';
import { FormsModule } from '@angular/forms';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, takeUntil } from 'rxjs/operators';
import { Subject } from 'rxjs';
import { getErrorMessage, isFailure, humanizeErrorMessage } from './utils/result';
import { ThemeType } from './models';
import { UI_CONFIG, AUTH_CONFIG } from './config/constants';

/**
 * 应用根组件
 * 
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ 技术债务说明：模态框静态导入                                                  │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ 当前 AppComponent 直接导入了 10+ 个模态框组件，这是有意为之的设计取舍：       │
 * │                                                                             │
 * │ 为什么不立即重构为动态加载？                                                 │
 * │ - 把它拆分成动态加载会引入显著的复杂度（Injector 层级、生命周期销毁等）       │
 * │ - 除非 main.js 体积大到影响首屏加载速度（对于个人工具几乎不可能），          │
 * │   或者代码行数已超过鼠标滚轮舒适区，否则现在重构就是"磨洋工"                 │
 * │ - AppComponent 本就是合法的"全局容器"，在应用初期完全可以接受                │
 * │                                                                             │
 * │ 后续迭代触发条件：                                                           │
 * │ 1. main.js 体积 > 500KB 且影响首屏 LCP                                       │
 * │ 2. 本文件行数 > 1000 行                                                      │
 * │ 3. 需要支持模态框插件化/第三方扩展                                           │
 * │                                                                             │
 * │ 先让功能跑起来，代码丑一点没关系，它是你的私有领地。                          │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    OfflineBannerComponent,
    ErrorBoundaryComponent,
    SettingsModalComponent,
    LoginModalComponent,
    ConflictModalComponent,
    NewProjectModalComponent,
    ConfigHelpModalComponent,
    TrashModalComponent,
    MigrationModalComponent,
    ErrorRecoveryModalComponent,
    StorageEscapeModalComponent,
    DashboardModalComponent
  ],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {

  store = inject(StoreService);
  auth = inject(AuthService);
  undoService = inject(UndoService);
  swUpdate = inject(SwUpdate);
  toast = inject(ToastService);
  actionQueue = inject(ActionQueueService);
  supabaseClient = inject(SupabaseClientService);
  migrationService = inject(MigrationService);
  errorHandler = inject(GlobalErrorHandler);
  modal = inject(ModalService);
  modalLoader = inject(ModalLoaderService);
  dynamicModal = inject(DynamicModalService);
  private syncCoordinator = inject(SyncCoordinatorService);
  
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroy$ = new Subject<void>();

  isSidebarOpen = signal(true);
  isFilterOpen = signal(false); // Add this line
  expandedProjectId = signal<string | null>(null);
  isEditingDescription = signal(false);
  projectDrafts = signal<Record<string, { description: string; createdDate: string }>>({});
  authEmail = signal('');
  authPassword = signal('');
  authError = signal<string | null>(null);
  isAuthLoading = signal(false);
  isCheckingSession = signal(true);
  
  /** 启动失败状态 - 用于阻断性显式反馈 */
  bootstrapFailed = signal(false);
  bootstrapErrorMessage = signal<string | null>(null);
  sessionEmail = signal<string | null>(null);
  isReloginMode = signal(false);
  
  /** 存储失败逃生数据 */
  storageEscapeData = signal<StorageEscapeData | null>(null);
  showStorageEscapeModal = signal(false);
  
  /** 项目删除中状态 - 防止重复点击 */
  isDeleting = signal(false);
  
  // 注册模式
  isSignupMode = signal(false);
  authConfirmPassword = signal('');
  
  // 密码重置模式
  isResetPasswordMode = signal(false);
  resetPasswordSent = signal(false);
  
  // 手机端滑动切换状态
  private touchStartX = 0;
  private touchStartY = 0;
  private isSwiping = false;
  
  // 侧边栏滑动状态
  private sidebarTouchStartX = 0;
  private sidebarTouchStartY = 0;
  private isSidebarSwiping = false;
  
  // 侧边栏滑动手势处理
  onSidebarTouchStart(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.sidebarTouchStartX = e.touches[0].clientX;
    this.sidebarTouchStartY = e.touches[0].clientY;
    this.isSidebarSwiping = false;
  }
  
  onSidebarTouchMove(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.sidebarTouchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.sidebarTouchStartY);
    
    // 向左滑动且水平距离大于垂直距离（使用配置常量）
    if (deltaX < -UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSidebarSwiping = true;
    }
  }
  
  onSidebarTouchEnd(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (!this.isSidebarSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.sidebarTouchStartX;
    const threshold = 50; // 滑动阈值（从60减小到50）
    
    // 向左滑动关闭侧边栏
    if (deltaX < -threshold) {
      this.isSidebarOpen.set(false);
    }
    
    this.isSidebarSwiping = false;
  }
  
  // 手机端滑动手势处理
  onMainTouchStart(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.touchStartX = e.touches[0].clientX;
    this.touchStartY = e.touches[0].clientY;
    this.isSwiping = false;
  }
  
  onMainTouchMove(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.touchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.touchStartY);
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势（使用配置常量）
    if (Math.abs(deltaX) > UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSwiping = true;
    }
  }
  
  onMainTouchEnd(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (!this.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.touchStartX;
    const threshold = 50; // 滑动阈值
    
    // 向右滑动打开侧边栏
    // 但在流程图视图中不响应，避免与画布操作冲突
    if (deltaX > threshold && this.store.activeView() !== 'flow') {
      this.isSidebarOpen.set(true);
    }
    
    this.isSwiping = false;
  }

  readonly showSettingsAuthForm = computed(() => !this.store.currentUserId() || this.isReloginMode());
  
  // ========== 模态框状态（代理到 ModalService）==========
  // 使用 ModalService 统一管理，以下为便捷访问器
  
  /** 冲突数据 - 从 ModalService 获取 */
  readonly conflictData = computed(() => 
    this.modal.getData('conflict') as ConflictData | undefined
  );
  
  currentFilterLabel = computed(() => {
    const filterId = this.store.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.store.rootTasks().find(t => t.id === filterId);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });

  // 模态框开关状态 - 便捷访问器（代理到 ModalService）
  readonly showSettings = computed(() => this.modal.isOpen('settings'));
  readonly showNewProjectModal = computed(() => this.modal.isOpen('newProject'));
  readonly showLoginModal = computed(() => this.modal.isOpen('login'));
  readonly showDeleteProjectModal = computed(() => this.modal.isOpen('deleteProject'));
  readonly showTrashModal = computed(() => this.modal.isOpen('trash'));
  readonly showMigrationModal = computed(() => this.modal.isOpen('migration'));
  readonly showConflictModal = computed(() => this.modal.isOpen('conflict'));
  
  /** 
   * 显示未登录提示界面
   * 条件：Supabase 已配置 + 用户未登录 + 登录模态框未打开 + 会话检查完成
   * 用于解决移动端关闭登录模态框后白屏的问题
   */
  readonly showLoginRequired = computed(() => {
    return this.auth.isConfigured && 
           !this.store.currentUserId() && 
           !this.modal.isOpen('login') && 
           !this.isCheckingSession() &&
           !this.bootstrapFailed();
  });
  
  /** 删除项目目标 - 从 ModalService 获取 */
  readonly deleteProjectTarget = computed(() => {
    const data = this.modal.getData('deleteProject') as DeleteProjectData | undefined;
    return data ? { id: data.projectId, name: data.projectName } : null;
  });
  
  // 项目重命名状态
  renamingProjectId = signal<string | null>(null);
  renameProjectName = signal('');
  private originalProjectName = '';
  
  // 统一搜索查询
  unifiedSearchQuery = signal<string>('');
  
  // 搜索防抖定时器
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SEARCH_DEBOUNCE_DELAY = 300; // 300ms 搜索防抖
  
  /** beforeunload 监听器引用 */
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  constructor() {
    // 启动流程：先执行必要的同步初始化，再异步恢复会话
    // 关键：bootstrapSession 失败不应阻止基础 UI 运行，但应阻止某些功能
    this.checkMobile();
    this.setupSwUpdateListener();
    // 主题初始化在 StoreService 构造函数中完成
    // 不再在此重复应用主题
    this.setupConflictHandler();
    this.setupSidebarToggleListener();
    this.setupStorageFailureHandler();
    this.setupBeforeUnloadHandler();
    
    // 异步恢复会话 - 失败会设置 bootstrapFailed 状态，模板层负责显示错误 UI
    this.bootstrapSession().catch(_e => {
      // 错误已在 bootstrapSession 内部处理并设置 bootstrapFailed 状态
      // 不再静默处理，确保用户感知启动失败
    });
  }
  
  ngOnInit() {
    this.setupRouteSync();
    
    // 标记应用已加载完成，用于隐藏初始加载指示器
    (window as any).__NANOFLOW_READY__ = true;
    // console.log('[NanoFlow] ✅ ngOnInit 完成，应用已就绪');
    
    // 🔍 调试：输出关键状态
    // console.log('[NanoFlow] 📊 初始状态:', {
    //   isCheckingSession: this.isCheckingSession(),
    //   bootstrapFailed: this.bootstrapFailed(),
    //   currentUserId: this.store.currentUserId(),
    //   authConfigured: this.auth.isConfigured
    // });
  }
  
  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    
    // 确保待处理的撤销操作被保存
    this.undoService.flushPendingAction();
    
    // 移除全局事件监听器
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    
    // 移除 beforeunload 监听器
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    
    // 清理搜索防抖定时器
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }
  
  /**
   * 设置页面卸载前的数据保存处理器
   * 确保用户刷新或关闭页面时，待处理的数据能够保存到本地
   */
  private setupBeforeUnloadHandler(): void {
    if (typeof window === 'undefined') return;
    
    this.beforeUnloadHandler = () => {
      // 立即刷新待处理的持久化数据到本地缓存
      this.syncCoordinator.flushPendingPersist();
      // 同时刷新撤销服务的待处理操作
      this.undoService.flushPendingAction();
    };
    
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }
  
  /**
   * 监听子组件发出的 toggle-sidebar 事件
   * 箭头函数确保 this 绑定正确
   */
  private handleToggleSidebar = () => {
    this.isSidebarOpen.update(v => !v);
  };
  
  /**
   * 全局 WeakMap 用于追踪监听器实例，避免 HMR 时累积多个监听器
   * 使用 WeakMap 以实例为键，确保每个组件实例独立追踪
   */
  private static listenerRegistry = new WeakMap<AppComponent, boolean>();
  
  private setupSidebarToggleListener() {
    // 防止 HMR 时累积监听器：先移除可能存在的旧监听器
    // 由于箭头函数是实例级别的，直接移除不会有问题
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    window.addEventListener('toggle-sidebar', this.handleToggleSidebar);
    AppComponent.listenerRegistry.set(this, true);
  }
  
  /**
   * 设置存储失败处理器
   * 
   * 当 localStorage 和 IndexedDB 都失败时，显示逃生模态框
   * 让用户手动复制数据进行备份
   */
  private setupStorageFailureHandler(): void {
    this.actionQueue.onStorageFailure((data) => {
      // 构造逃生数据
      const escapeData: StorageEscapeData = {
        queue: data.queue,
        deadLetter: data.deadLetter,
        projects: this.store.projects(), // 附加当前项目数据
        timestamp: new Date().toISOString()
      };
      
      this.storageEscapeData.set(escapeData);
      this.showStorageEscapeModal.set(true);
    });
  }
  
  /**
   * 关闭存储逃生模态框
   */
  closeStorageEscapeModal(): void {
    this.showStorageEscapeModal.set(false);
  }
  
  /**
   * 设置路由参数与状态的同步
   * 监听 URL 变化并更新 activeProjectId
   */
  private setupRouteSync() {
    // 监听路由参数变化
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      takeUntil(this.destroy$)
    ).subscribe(() => {
      this.syncStateFromRoute();
    });
    
    // 初始同步
    this.syncStateFromRoute();
    
    // 监听 activeProjectId 变化，更新 URL
    // 使用 effect 或手动订阅
  }
  
  /**
   * 从路由参数同步状态
   */
  private syncStateFromRoute() {
    // 获取当前完整路由
    let currentRoute = this.route;
    while (currentRoute.firstChild) {
      currentRoute = currentRoute.firstChild;
    }
    
    const params = currentRoute.snapshot.params;
    const projectId = params['projectId'];
    
    if (projectId && projectId !== this.store.activeProjectId()) {
      // 项目列表尚未加载完成时，不要基于空列表做重定向，避免深链接被误判。
      if (this.store.projects().length === 0) {
        return;
      }

      // 检查项目是否存在
      const projectExists = this.store.projects().some(p => p.id === projectId);
      if (projectExists) {
        this.store.activeProjectId.set(projectId);
      } else {
        // 项目不存在，重定向到默认路由
        void this.router.navigate(['/projects']);
      }
    }
    
    // taskId 的定位由 ProjectShellComponent 处理
  }
  
  /**
   * 更新 URL 以反映当前状态（可选调用）
   */
  updateUrlForProject(projectId: string) {
    void this.router.navigate(['/projects', projectId], { 
      replaceUrl: true,
      queryParamsHandling: 'preserve'
    });
  }
  
  private setupConflictHandler() {
    // 订阅冲突事件流 - 使用发布-订阅模式
    this.store.onConflict$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(({ localProject, remoteProject, projectId }) => {
      this.modal.show('conflict', { 
        localProject, 
        remoteProject, 
        projectId 
      });
    });
  }
  
  // 解决冲突：使用本地版本
  async resolveConflictLocal() {
    const data = this.conflictData();
    if (data) {
      await this.store.resolveConflict(data.projectId, 'local');
      // store.resolveConflict 内部已有错误处理和 toast 显示
      // 冲突解决成功的反馈由 store 内部处理
    }
    this.modal.closeByType('conflict', { choice: 'local' });
  }
  
  // 解决冲突：使用远程版本
  async resolveConflictRemote() {
    const data = this.conflictData();
    if (data) {
      await this.store.resolveConflict(data.projectId, 'remote');
    }
    this.modal.closeByType('conflict', { choice: 'remote' });
  }
  
  // 解决冲突：智能合并
  async resolveConflictMerge() {
    const data = this.conflictData();
    if (data) {
      await this.store.resolveConflict(data.projectId, 'merge');
    }
    this.modal.closeByType('conflict', { choice: 'merge' });
  }
  
  // 取消冲突解决（稍后处理）
  cancelConflictResolution() {
    this.modal.closeByType('conflict', { choice: 'cancel' });
    this.toast.info('冲突待解决，下次同步时会再次提示');
  }
  
  // 撤销/重做快捷键
  @HostListener('document:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent) {
    // Ctrl+Z / Cmd+Z: 撤销
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undoService.undo();
    }
    // Ctrl+Shift+Z / Cmd+Shift+Z: 重做
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && event.shiftKey) {
      event.preventDefault();
      this.undoService.redo();
    }
    // Ctrl+Y / Cmd+Y: 重做（Windows 风格）
    if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
      event.preventDefault();
      this.undoService.redo();
    }
  }
  
  private setupSwUpdateListener() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntil(this.destroy$)
        )
        .subscribe(() => {
          // 使用 ToastService 显示更新通知，带操作按钮
          this.toast.info(
            '🚀 发现新版本', 
            '软件有更新可用，点击刷新获取最新功能',
            {
              duration: 0, // 不自动关闭
              action: {
                label: '立即刷新',
                onClick: () => window.location.reload()
              }
            }
          );
        });
    }
  }

  // Resizing State
  isResizingSidebar = false;
  isResizingContent = false;
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  // --- Resizing Logic ---

  startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingSidebar = true;
      this.startX = e.clientX;
      this.startWidth = this.store.sidebarWidth();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  startContentResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingContent = true;
      this.startX = e.clientX;
      this.startRatio = this.store.textColumnRatio();
      
      // Get current main content width
      const mainEl = document.querySelector('main');
      this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
      
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
      if (this.isResizingSidebar) {
          e.preventDefault();
          const delta = e.clientX - this.startX;
          const newWidth = Math.max(200, Math.min(600, this.startWidth + delta));
          this.store.sidebarWidth.set(newWidth);
      } else if (this.isResizingContent) {
          e.preventDefault();
          const delta = e.clientX - this.startX;
          // Convert delta pixels to percentage
          const deltaPercent = (delta / this.mainContentWidth) * 100;
          // 限制在 25-75% 之间，避免极端情况
          const newRatio = Math.max(25, Math.min(75, this.startRatio + deltaPercent));
          this.store.textColumnRatio.set(newRatio);
      }
  }

  @HostListener('document:mouseup')
  onMouseUp() {
      if (this.isResizingSidebar || this.isResizingContent) {
          this.isResizingSidebar = false;
          this.isResizingContent = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
      }
  }

  private async bootstrapSession() {
    if (!this.auth.isConfigured) {
      console.log('[Bootstrap] Supabase 未配置，启用离线模式');
      this.isCheckingSession.set(false);
      // 离线模式：加载本地数据（种子数据或缓存数据）
      await this.store.setCurrentUser(null);
      return;
    }
    
    console.log('[Bootstrap] ========== 启动会话检查 ==========');
    const totalStartTime = Date.now(); // 移到 try 外部以便 finally 访问
    this.isCheckingSession.set(true);
    this.bootstrapFailed.set(false);
    this.bootstrapErrorMessage.set(null);
    
    try {
      console.log('[Bootstrap] 步骤 1/3: 调用 auth.checkSession()...');
      const startTime = Date.now();
      const result = await this.auth.checkSession();
      const elapsed = Date.now() - startTime;
      console.log(`[Bootstrap] 步骤 1/3: checkSession 完成 (耗时 ${elapsed}ms)`, { 
        userId: result.userId, 
        hasEmail: !!result.email 
      });
      
      if (result.userId) {
        this.sessionEmail.set(result.email);
        console.log('[Bootstrap] 步骤 2/3: 用户已登录，开始加载数据...');
        const loadStartTime = Date.now();
        
        // setCurrentUser 不会抛出异常，内部已处理所有错误
        await this.store.setCurrentUser(result.userId);
        
        const loadElapsed = Date.now() - loadStartTime;
        console.log(`[Bootstrap] 步骤 2/3: 数据加载完成 (耗时 ${loadElapsed}ms)`);
        console.log('[Bootstrap] 步骤 3/3: 检查项目数据...', {
          projectCount: this.store.projects().length,
          activeProjectId: this.store.activeProjectId()
        });
      } else {
        console.log('[Bootstrap] 步骤 2/3: 无现有会话，跳过数据加载');
      }
      
      console.log('[Bootstrap] ========== 启动成功 ==========');
    } catch (e: any) {
      // 只有会话检查失败才算启动失败
      console.error('[Bootstrap] ========== 启动失败 ==========');
      console.error('[Bootstrap] 错误详情:', {
        message: e?.message,
        stack: e?.stack,
        name: e?.name,
        cause: e?.cause
      });
      
      const errorMsg = humanizeErrorMessage(e?.message ?? String(e));
      console.error('[Bootstrap] 转换后的用户消息:', errorMsg);
      
      this.bootstrapFailed.set(true);
      this.bootstrapErrorMessage.set(errorMsg);
      this.authError.set(errorMsg);
    } finally {
      const totalElapsed = Date.now() - totalStartTime;
      console.log(`[Bootstrap] 完成，设置 isCheckingSession = false (总耗时 ${totalElapsed}ms)`);
      this.isCheckingSession.set(false);
    }
  }
  
  /** 重试启动会话 - 用于启动失败后的重试按钮 */
  retryBootstrap() {
    this.bootstrapSession().catch(_e => {
      // 重试失败已在 bootstrapSession 内部处理
    });
  }

  async handleLogin(event?: Event, opts?: { closeSettings?: boolean }) {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing. Set NG_APP_SUPABASE_URL/NG_APP_SUPABASE_ANON_KEY.');
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.signIn(this.authEmail(), this.authPassword());
      if (isFailure(result)) {
        throw new Error(getErrorMessage(result.error));
      }
      
      // 登录成功后禁用本地模式
      disableLocalMode();
      
      this.sessionEmail.set(this.auth.sessionEmail());
      
      // 保存用户ID用于迁移
      const userId = this.auth.currentUserId();
      if (userId) {
        localStorage.setItem('currentUserId', userId);
      }
      
      await this.store.setCurrentUser(userId);
      
      // 手动登录成功反馈（自动登录/会话恢复保持静默）
      this.toast.success('登录成功', `欢迎回来`);
      
      // 登录成功后检查是否需要数据迁移
      await this.checkMigrationAfterLogin();
      
      this.isReloginMode.set(false);
      
      // 获取 returnUrl（如果有）并导航
      const loginData = this.modal.getData('login') as LoginData | undefined;
      const returnUrl = loginData?.returnUrl;
      
      this.modal.closeByType('login', { success: true, userId: userId ?? undefined });
      if (opts?.closeSettings) {
        this.modal.closeByType('settings');
      }
      
      // 如果有 returnUrl，导航到该 URL
      if (returnUrl && returnUrl !== '/') {
        void this.router.navigateByUrl(returnUrl);
      }
    } catch (e: any) {
      this.authError.set(humanizeErrorMessage(e?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
      this.isCheckingSession.set(false);
    }
  }
  
  // 新增：注册功能
  async handleSignup(event?: Event) {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing.');
      return;
    }
    
    // 验证密码匹配
    if (this.authPassword() !== this.authConfirmPassword()) {
      this.authError.set('两次输入的密码不一致');
      return;
    }
    
    // 密码强度检查（使用统一配置）
    const minLen = 8; // AUTH_CONFIG.MIN_PASSWORD_LENGTH
    if (this.authPassword().length < minLen) {
      this.authError.set(`密码长度至少${minLen}位`);
      return;
    }
    
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.signUp(this.authEmail(), this.authPassword());
      if (isFailure(result)) {
        throw new Error(getErrorMessage(result.error));
      }
      if (result.value.needsConfirmation) {
        // 需要邮箱验证
        this.authError.set('注册成功！请查收邮件并点击验证链接完成注册。');
      } else if (this.auth.currentUserId()) {
        // 注册成功且自动登录
        this.sessionEmail.set(this.auth.sessionEmail());
        await this.store.setCurrentUser(this.auth.currentUserId());
        this.toast.success('注册成功', '欢迎使用');
        this.modal.closeByType('login', { success: true, userId: this.auth.currentUserId() ?? undefined });
        this.isSignupMode.set(false);
      }
    } catch (e: any) {
      this.authError.set(humanizeErrorMessage(e?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
    }
  }
  
  // 新增：密码重置
  async handleResetPassword(event?: Event) {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing.');
      return;
    }
    
    if (!this.authEmail()) {
      this.authError.set('请输入邮箱地址');
      return;
    }
    
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.resetPassword(this.authEmail());
      if (isFailure(result)) {
        throw new Error(getErrorMessage(result.error));
      }
      this.resetPasswordSent.set(true);
    } catch (e: any) {
      this.authError.set(humanizeErrorMessage(e?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
    }
  }
  
  // 切换到注册模式
  switchToSignup() {
    this.isSignupMode.set(true);
    this.isResetPasswordMode.set(false);
    this.authError.set(null);
    this.authPassword.set('');
    this.authConfirmPassword.set('');
  }
  
  // 切换到登录模式
  switchToLogin() {
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
    this.resetPasswordSent.set(false);
    this.authError.set(null);
  }
  
  // 切换到密码重置模式
  switchToResetPassword() {
    this.isResetPasswordMode.set(true);
    this.isSignupMode.set(false);
    this.resetPasswordSent.set(false);
    this.authError.set(null);
  }

async signOut() {
    // 先清空本地敏感数据，防止数据泄漏
    this.store.clearLocalData();
    
    if (this.auth.isConfigured) {
      await this.auth.signOut();
    }
    
    // 清除所有用户相关的 signals
    this.sessionEmail.set(null);
    this.authEmail.set('');
    this.authPassword.set('');
    this.authConfirmPassword.set('');
    this.authError.set(null);
    this.isReloginMode.set(false);
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
    this.resetPasswordSent.set(false);
    
    // 清除项目相关状态
    this.expandedProjectId.set(null);
    this.isEditingDescription.set(false);
    this.projectDrafts.set({});
    this.unifiedSearchQuery.set('');
    
    await this.store.setCurrentUser(null);
  }

  startRelogin() {
    this.isReloginMode.set(true);
    this.authPassword.set('');
    this.authError.set(null);
    if (this.sessionEmail()) {
      this.authEmail.set(this.sessionEmail()!);
    }
  }

  selectProject(id: string) {
    // 如果点击的是当前展开的项目，则收起详情
    if (this.expandedProjectId() === id) {
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
      return;
    }
    
    // 展开新项目的详情
    this.store.activeProjectId.set(id);
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    this.isEditingDescription.set(false);
    
    // 移动端流程图视图下：切换项目时直接导航（用于快速对比不同项目的流程图）
    const currentView = this.store.activeView() || 'text';
    if (this.store.isMobile() && currentView === 'flow') {
      void this.router.navigate(['/projects', id, currentView]);
    }
    // 其他情况：只展开详情，不自动导航，让用户可以先看项目简介
  }
  
  // 进入项目视图（双击或点击进入按钮）
  enterProject(id: string) {
    this.store.activeProjectId.set(id);
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    const currentView = this.store.activeView() || 'text';
    void this.router.navigate(['/projects', id, currentView]);
    // 移动端自动关闭侧边栏
    if (this.store.isMobile()) {
      this.isSidebarOpen.set(false);
    }
  }

  handleProjectDoubleClick(id: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    // 双击进入项目并开启简介编辑模式
    this.isEditingDescription.set(true);
    this.enterProject(id);
  }
  
  // 开始重命名项目
  startRenameProject(projectId: string, currentName: string, event: Event) {
    event.stopPropagation();
    this.renamingProjectId.set(projectId);
    this.renameProjectName.set(currentName);
    this.originalProjectName = currentName;
  }
  
  // 执行重命名
  executeRenameProject() {
    const projectId = this.renamingProjectId();
    const newName = this.renameProjectName().trim();
    if (projectId && newName && newName !== this.originalProjectName) {
      this.store.renameProject(projectId, newName);
      this.toast.success('项目重命名成功');
    }
    this.cancelRenameProject();
  }
  
  // 取消重命名
  cancelRenameProject() {
    this.renamingProjectId.set(null);
    this.renameProjectName.set('');
  }
  
  // 重命名输入框键盘事件
  onRenameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.executeRenameProject();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRenameProject();
    }
  }

  projectDraft(projectId: string) {
    return this.projectDrafts()[projectId] ?? null;
  }

  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string) {
    const base = this.projectDraft(projectId) ?? { description: '', createdDate: '' };
    const next = { ...base, [field]: value };
    this.projectDrafts.update(drafts => ({ ...drafts, [projectId]: next }));
  }

  saveProjectDetails(projectId: string) {
    const draft = this.projectDraft(projectId);
    if (!draft) return;
    // Only update description, createdDate is read-only in UI logic now
    this.store.updateProjectMetadata(projectId, {
      description: draft.description
    });
    // Exit edit mode
    this.isEditingDescription.set(false);
  }

  private ensureProjectDraft(projectId: string) {
    const drafts = this.projectDrafts();
    if (drafts[projectId]) return drafts[projectId];
    const project = this.store.projects().find(p => p.id === projectId);
    if (!project) return null;
    const draft = {
      description: project.description ?? '',
      createdDate: this.formatDateInput(project.createdDate)
    };
    this.projectDrafts.update(curr => ({ ...curr, [projectId]: draft }));
    return draft;
  }

  private formatDateInput(value?: string) {
    if (!value) return '';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  private isoOrNow(value: string) {
    if (!value) return new Date().toISOString();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
    return parsed.toISOString();
  }

  createNewProject() {
    this.modal.show('newProject');
  }
  
  /**
   * 聚焦到流程图节点
   * 导航到包含该任务的项目并打开流程图视图
   */
  onFocusFlowNode(taskId: string) {
    const task = this.store.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    // 导航到任务所在项目的流程图视图
    const projectId = this.store.activeProjectId();
    if (projectId) {
      void this.router.navigate(['/projects', projectId, 'task', taskId]);
    }
  }
  
  async confirmCreateProject(name: string, desc: string) {
      if (!name) return;
      const result = await this.store.addProject({
          id: crypto.randomUUID(),
          name,
          description: desc,
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: []
      });
      if (result.success) {
        this.modal.closeByType('newProject', { name, description: desc });
      }
      // 如果失败，模态框保持打开，错误消息由 store 通过 toast 显示
  }

  // 确认删除项目（使用动态模态框 - 推荐方式）
  async confirmDeleteProject(projectId: string, projectName: string, event: Event) {
    event.stopPropagation();
    
    // 防止重复点击
    if (this.isDeleting()) return;
    
    // 使用 ModalLoaderService 加载模态框（内置重试和错误处理）
    const modalRef = await this.modalLoader.openDeleteConfirmModal({
      title: '删除项目',
      message: '确定要删除项目吗？',
      itemName: projectName,
      warning: '此操作将删除项目及其所有任务，且无法撤销！'
    });
    
    const result = await modalRef.result as { confirmed: boolean } | undefined;
    
    if (result?.confirmed) {
      this.isDeleting.set(true);
      try {
        const deleteResult = await this.store.deleteProject(projectId);
        if (deleteResult.success) {
          this.expandedProjectId.set(null);
          // 破坏性操作的成功反馈：让用户明确知道删除已完成
          this.toast.success('项目已删除', `「${projectName}」已永久删除`);
        }
      } finally {
        this.isDeleting.set(false);
      }
    }
  }
  
  // 以下方法已废弃，保留用于兼容（如果仍有模板使用旧方式）
  // 执行删除项目
  async executeDeleteProject() {
    const target = this.deleteProjectTarget();
    if (target) {
      const projectName = target.name;
      const result = await this.store.deleteProject(target.id);
      if (result.success) {
        this.expandedProjectId.set(null);
        this.modal.closeByType('deleteProject', { confirmed: true });
        // 破坏性操作的成功反馈：让用户明确知道删除已完成
        this.toast.success('项目已删除', `「${projectName}」已永久删除`);
      }
      // 如果失败，模态框保持打开，错误消息由 store 通过 toast 显示
    } else {
      this.modal.closeByType('deleteProject', { confirmed: false });
    }
  }
  
  // 取消删除项目
  cancelDeleteProject() {
    this.modal.closeByType('deleteProject', { confirmed: false });
  }

  openSettings() {
    this.modal.show('settings');
  }

  closeSettings() {
    this.modal.closeByType('settings');
    this.isReloginMode.set(false);
  }
  
  /**
   * 从设置页打开仪表盘
   */
  openDashboardFromSettings() {
    this.modal.closeByType('settings'); // 先关闭设置
    this.modal.show('dashboard');       // 再打开仪表盘
  }
  
  /**
   * 从仪表盘打开冲突解决中心
   */
  openConflictCenterFromDashboard() {
    this.modal.closeByType('dashboard'); // 先关闭仪表盘
    // 注意：冲突数据需要在外部准备，这里只是示例打开方式
    // 实际应该检查是否有冲突，然后展示冲突列表让用户选择
    this.toast.info('冲突解决中心', '请从项目列表中选择有冲突的项目进行处理');
  }

  updateLayoutDirection(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl';
    this.store.layoutDirection.set(val);
  }
  
  updateFloatPref(e: Event) {
      const val = (e.target as HTMLSelectElement).value as 'auto' | 'fixed';
      this.store.floatingWindowPref.set(val);
  }
  
  updateTheme(theme: ThemeType) {
    // 使用 store 的 setTheme 方法，统一主题管理和云端同步
    void this.store.setTheme(theme);
  }

  updateFilter(e: Event) {
      this.store.filterMode.set((e.target as HTMLSelectElement).value);
  }
  
  // 以下方法用于适配 LoginModalComponent 的事件
  async handleLoginFromModal(data: { email: string; password: string }) {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    await this.handleLogin();
  }
  
  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }) {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    this.authConfirmPassword.set(data.confirmPassword);
    await this.handleSignup();
  }
  
  async handleResetPasswordFromModal(email: string) {
    this.authEmail.set(email);
    await this.handleResetPassword();
    // 通知 LoginModalComponent 更新重置邮件发送状态
    // resetPasswordSent 状态已在 handleResetPassword 中设置
  }
  
  /**
   * 处理本地模式选择
   * 用户选择跳过登录，使用本地存储模式
   */
  handleLocalModeFromModal() {
    // 启用本地模式
    enableLocalMode();
    
    // 设置本地用户 ID
    this.auth.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    
    // 关闭登录模态框
    this.modal.closeByType('login', { success: true, userId: AUTH_CONFIG.LOCAL_MODE_USER_ID });
    
    // 加载本地数据
    void this.store.loadProjects();
    
    // 提示用户
    this.toast.info('本地模式', '数据仅保存在本地，不会同步到云端');
    
    // 导航到项目页面
    const loginData = this.modal.getData('login') as LoginData | undefined;
    const returnUrl = loginData?.returnUrl || '/projects';
    void this.router.navigateByUrl(returnUrl);
  }
  
  /**
   * 登录后检查是否需要数据迁移
   */
  private async checkMigrationAfterLogin() {
    // 获取云端项目列表
    const remoteProjects = this.store.projects();
    
    // 检查是否需要迁移
    const needsMigration = this.migrationService.checkMigrationNeeded(remoteProjects);
    
    if (needsMigration) {
      this.modal.show('migration');
    }
  }
  
  /**
   * 迁移完成后的处理
   */
  handleMigrationComplete() {
    this.modal.closeByType('migration');
    // 刷新项目列表
    void this.store.loadProjects();
    this.toast.success('数据迁移完成');
  }
  
  /**
   * 关闭迁移对话框（稍后处理）
   */
  closeMigrationModal() {
    this.modal.closeByType('migration');
    this.toast.info('您可以稍后在设置中处理数据迁移');
  }

  @HostListener('window:resize')
  checkMobile() {
    this.store.isMobile.set(window.innerWidth < 768); // Tailwind md breakpoint
    if (this.store.isMobile()) {
      this.isSidebarOpen.set(false); // Auto-close sidebar on mobile
    }
  }
  
  // ========== 统一搜索方法 ==========
  
  /**
   * 处理统一搜索输入变化
   * 同时更新项目和任务搜索（带防抖）
   */
  onUnifiedSearchChange(query: string) {
    // 立即更新显示值
    this.unifiedSearchQuery.set(query);
    
    // 防抖更新实际搜索
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    
    this.searchDebounceTimer = setTimeout(() => {
      // 同步到两个搜索 signal
      this.store.projectSearchQuery.set(query);
      this.store.searchQuery.set(query);
      this.searchDebounceTimer = null;
    }, this.SEARCH_DEBOUNCE_DELAY);
  }
  
  /**
   * 清除统一搜索
   */
  clearUnifiedSearch() {
    this.unifiedSearchQuery.set('');
    this.store.clearSearch();
  }
}
