import { Component, inject, signal, HostListener, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, NavigationEnd, RouterOutlet } from '@angular/router';
import { StoreService } from './services/store.service';
import { AuthService } from './services/auth.service';
import { UndoService } from './services/undo.service';
import { ToastService } from './services/toast.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { MigrationService } from './services/migration.service';
import { ToastContainerComponent } from './components/toast-container.component';
import { SyncStatusComponent } from './components/sync-status.component';
import { 
  SettingsModalComponent, 
  LoginModalComponent, 
  ConflictModalComponent, 
  NewProjectModalComponent, 
  DeleteConfirmModalComponent,
  ConfigHelpModalComponent,
  TrashModalComponent,
  MigrationModalComponent
} from './components/modals';
import { FormsModule } from '@angular/forms';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, takeUntil } from 'rxjs/operators';
import { Subject } from 'rxjs';
import { getErrorMessage } from './utils/result';
import { ThemeType, Project } from './models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    SettingsModalComponent,
    LoginModalComponent,
    ConflictModalComponent,
    NewProjectModalComponent,
    DeleteConfirmModalComponent,
    ConfigHelpModalComponent,
    TrashModalComponent,
    MigrationModalComponent
  ],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  store = inject(StoreService);
  auth = inject(AuthService);
  undoService = inject(UndoService);
  swUpdate = inject(SwUpdate);
  toast = inject(ToastService);
  supabaseClient = inject(SupabaseClientService);
  migrationService = inject(MigrationService);
  
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
  sessionEmail = signal<string | null>(null);
  isReloginMode = signal(false);
  
  // 配置错误提示对话框
  showConfigHelp = signal(false);
  
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
    
    // 向左滑动且水平距离大于垂直距离
    if (deltaX < -30 && Math.abs(deltaX) > deltaY * 1.5) {
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
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势
    if (Math.abs(deltaX) > 30 && Math.abs(deltaX) > deltaY * 1.5) {
      this.isSwiping = true;
    }
  }
  
  onMainTouchEnd(e: TouchEvent) {
    if (!this.store.isMobile()) return;
    if (!this.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.touchStartX;
    const threshold = 50; // 滑动阈值
    
    // 向右滑动打开侧边栏
    if (deltaX > threshold) {
      this.isSidebarOpen.set(true);
    }
    
    this.isSwiping = false;
  }

  readonly showSettingsAuthForm = computed(() => !this.store.currentUserId() || this.isReloginMode());
  
  // 冲突解决相关
  showConflictModal = signal(false);
  conflictData = signal<{
    localProject: Project;
    remoteProject: Project;
    projectId: string;
  } | null>(null);
  
  currentFilterLabel = computed(() => {
    const filterId = this.store.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.store.rootTasks().find(t => t.id === filterId);
    return task ? task.title : '全部任务';
  });

  showSettings = signal(false);
  showNewProjectModal = signal(false);
  showLoginModal = signal(false);
  
  // 删除项目确认对话框
  showDeleteProjectModal = signal(false);
  deleteProjectTarget = signal<{ id: string; name: string } | null>(null);
  
  // 回收站模态框
  showTrashModal = signal(false);
  
  // 数据迁移对话框
  showMigrationModal = signal(false);
  
  // 项目重命名状态
  renamingProjectId = signal<string | null>(null);
  renameProjectName = signal('');

  constructor() {
    void this.bootstrapSession();
    this.checkMobile();
    this.setupSwUpdateListener();
    // 主题初始化在 StoreService 构造函数中完成
    // 不再在此重复应用主题
    this.setupConflictHandler();
    this.setupSidebarToggleListener();
  }
  
  ngOnInit() {
    this.setupRouteSync();
  }
  
  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    
    // 确保待处理的撤销操作被保存
    this.undoService.flushPendingAction();
    
    // 移除全局事件监听器
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
  }
  
  /**
   * 监听子组件发出的 toggle-sidebar 事件
   */
  private handleToggleSidebar = () => {
    this.isSidebarOpen.update(v => !v);
  };
  
  private setupSidebarToggleListener() {
    window.addEventListener('toggle-sidebar', this.handleToggleSidebar);
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
    // 监听冲突事件
    this.store.onConflict = (local, remote, projectId) => {
      this.conflictData.set({ localProject: local, remoteProject: remote, projectId });
      this.showConflictModal.set(true);
    };
  }
  
  // 解决冲突：使用本地版本
  resolveConflictLocal() {
    const data = this.conflictData();
    if (data) {
      this.store.resolveConflict(data.projectId, 'local');
      this.toast.success('已使用本地版本');
    }
    this.showConflictModal.set(false);
    this.conflictData.set(null);
  }
  
  // 解决冲突：使用远程版本
  resolveConflictRemote() {
    const data = this.conflictData();
    if (data) {
      this.store.resolveConflict(data.projectId, 'remote');
      this.toast.success('已使用云端版本');
    }
    this.showConflictModal.set(false);
    this.conflictData.set(null);
  }
  
  // 解决冲突：智能合并
  resolveConflictMerge() {
    const data = this.conflictData();
    if (data) {
      this.store.resolveConflict(data.projectId, 'merge');
      this.toast.success('智能合并完成');
    }
    this.showConflictModal.set(false);
    this.conflictData.set(null);
  }
  
  // 取消冲突解决（稍后处理）
  cancelConflictResolution() {
    this.showConflictModal.set(false);
    // 不清除 conflictData，以便稍后可以重新打开
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
          if (confirm('软件有更新，是否刷新以获取最新功能？')) {
            window.location.reload();
          }
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
      this.isCheckingSession.set(false);
      return;
    }
    this.isCheckingSession.set(true);
    try {
      const result = await this.auth.checkSession();
      if (result.userId) {
        this.sessionEmail.set(result.email);
        await this.store.setCurrentUser(result.userId);
      }
    } catch (e: any) {
      this.authError.set(e?.message ?? String(e));
    } finally {
      this.isCheckingSession.set(false);
    }
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
      if (result.error || !result.success) {
        throw new Error(result.error || 'Login failed');
      }
      this.sessionEmail.set(this.auth.sessionEmail());
      
      // 保存用户ID用于迁移
      const userId = this.auth.currentUserId();
      if (userId) {
        localStorage.setItem('currentUserId', userId);
      }
      
      await this.store.setCurrentUser(userId);
      
      // 登录成功后检查是否需要数据迁移
      await this.checkMigrationAfterLogin();
      
      this.isReloginMode.set(false);
      this.showLoginModal.set(false);
      if (opts?.closeSettings) {
        this.showSettings.set(false);
      }
    } catch (e: any) {
      this.authError.set(e?.message ?? String(e));
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
    
    // 密码强度检查
    if (this.authPassword().length < 6) {
      this.authError.set('密码长度至少6位');
      return;
    }
    
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.signUp(this.authEmail(), this.authPassword());
      if (result.error) {
        throw new Error(result.error);
      }
      if (result.needsConfirmation) {
        // 需要邮箱验证
        this.authError.set('注册成功！请查收邮件并点击验证链接完成注册。');
      } else if (result.success && this.auth.currentUserId()) {
        // 注册成功且自动登录
        this.sessionEmail.set(this.auth.sessionEmail());
        await this.store.setCurrentUser(this.auth.currentUserId());
        this.showLoginModal.set(false);
        this.isSignupMode.set(false);
      }
    } catch (e: any) {
      this.authError.set(e?.message ?? String(e));
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
      if (result.error) {
        throw new Error(result.error);
      }
      this.resetPasswordSent.set(true);
    } catch (e: any) {
      this.authError.set(e?.message ?? String(e));
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
    // 先清空本地敏感数据，防止数据泄露
    this.store.clearLocalData();
    
    if (this.auth.isConfigured) {
      await this.auth.signOut();
    }
    this.sessionEmail.set(null);
    this.authPassword.set('');
    this.isReloginMode.set(false);
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
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
    if (this.expandedProjectId() === id) {
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
    } else {
      this.store.activeProjectId.set(id);
      this.expandedProjectId.set(id);
      this.ensureProjectDraft(id);
      this.isEditingDescription.set(false);
      // 导航到项目视图
      void this.router.navigate(['/projects', id, 'text']);
    }
  }

  handleProjectDoubleClick(id: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    // Ensure it's expanded and active
    this.store.activeProjectId.set(id);
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    // Enter edit mode
    this.isEditingDescription.set(true);
    // 导航到项目视图
    void this.router.navigate(['/projects', id, 'text']);
  }
  
  // 开始重命名项目
  startRenameProject(projectId: string, currentName: string, event: Event) {
    event.stopPropagation();
    this.renamingProjectId.set(projectId);
    this.renameProjectName.set(currentName);
  }
  
  // 执行重命名
  executeRenameProject() {
    const projectId = this.renamingProjectId();
    const newName = this.renameProjectName().trim();
    if (projectId && newName) {
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
    this.showNewProjectModal.set(true);
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
        this.showNewProjectModal.set(false);
      }
      // 如果失败，模态框保持打开，错误消息由 store 通过 toast 显示
  }

  // 确认删除项目
  confirmDeleteProject(projectId: string, projectName: string, event: Event) {
    event.stopPropagation();
    this.deleteProjectTarget.set({ id: projectId, name: projectName });
    this.showDeleteProjectModal.set(true);
  }
  
  // 执行删除项目
  async executeDeleteProject() {
    const target = this.deleteProjectTarget();
    if (target) {
      const result = await this.store.deleteProject(target.id);
      if (result.success) {
        this.expandedProjectId.set(null);
        this.showDeleteProjectModal.set(false);
        this.deleteProjectTarget.set(null);
      }
      // 如果失败，模态框保持打开，错误消息由 store 通过 toast 显示
    } else {
      this.showDeleteProjectModal.set(false);
      this.deleteProjectTarget.set(null);
    }
  }
  
  // 取消删除项目
  cancelDeleteProject() {
    this.showDeleteProjectModal.set(false);
    this.deleteProjectTarget.set(null);
  }

  openSettings() {
    this.showSettings.set(true);
  }

  closeSettings() {
    this.showSettings.set(false);
    this.isReloginMode.set(false);
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
      this.showMigrationModal.set(true);
    }
  }
  
  /**
   * 迁移完成后的处理
   */
  handleMigrationComplete() {
    this.showMigrationModal.set(false);
    // 刷新项目列表
    void this.store.loadProjects();
    this.toast.success('数据迁移完成');
  }
  
  /**
   * 关闭迁移对话框（稍后处理）
   */
  closeMigrationModal() {
    this.showMigrationModal.set(false);
    this.toast.info('您可以稍后在设置中处理数据迁移');
  }

  @HostListener('window:resize')
  checkMobile() {
    this.store.isMobile.set(window.innerWidth < 768); // Tailwind md breakpoint
    if (this.store.isMobile()) {
      this.isSidebarOpen.set(false); // Auto-close sidebar on mobile
    }
  }
}
