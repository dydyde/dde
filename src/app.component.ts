import { Component, inject, signal, HostListener, computed, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from './services/store.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { TextViewComponent } from './components/text-view.component';
import { FlowViewComponent } from './components/flow-view.component';
import { FormsModule } from '@angular/forms';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, FormsModule],
  templateUrl: './app.component.html',
})
export class AppComponent {
  store = inject(StoreService);
  supabase = inject(SupabaseClientService);
  swUpdate = inject(SwUpdate);
  
  @ViewChild(FlowViewComponent) flowView?: FlowViewComponent;

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

  // Mobile Support
  mobileActiveView = signal<'text' | 'flow'>('text');
  
  // 手机端滑动切换状态
  private touchStartX = 0;
  private touchStartY = 0;
  private isSwiping = false;
  
  // 侧边栏滑动状态
  private sidebarTouchStartX = 0;
  private sidebarTouchStartY = 0;
  private isSidebarSwiping = false;

  switchToFlow() {
      this.mobileActiveView.set('flow');
      setTimeout(() => {
          this.flowView?.refreshLayout();
      }, 100);
  }
  
  switchToText() {
      this.mobileActiveView.set('text');
  }
  
  // 文本栏点击任务时，流程图定位到对应节点（仅桌面端，不打开详情面板）
  onFocusFlowNode(taskId: string) {
    if (!this.store.isMobile() && this.flowView) {
      this.flowView.centerOnNode(taskId, false);
    }
  }
  
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
    
    if (deltaX < -threshold) {
      // 向左滑动
      if (this.mobileActiveView() === 'text') {
        // 文本视图 -> 流程图
        this.switchToFlow();
      }
      // 流程图界面不响应滑动切换（防止拖动图表时误触发）
    } else if (deltaX > threshold) {
      // 向右滑动
      if (this.mobileActiveView() === 'text') {
        // 文本视图 -> 打开侧边栏
        this.isSidebarOpen.set(true);
      }
      // 流程图界面不响应滑动切换（防止拖动图表时误触发）
    }
    
    this.isSwiping = false;
  }

  readonly showSettingsAuthForm = computed(() => !this.store.currentUserId() || this.isReloginMode());
  
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

  constructor() {
    void this.bootstrapSession();
    this.checkMobile();
    this.setupSwUpdateListener();
    this.applyStoredTheme();
  }
  
  private applyStoredTheme() {
    // 从 localStorage 恢复主题（作为初始值，登录后会被云端覆盖）
    const savedTheme = localStorage.getItem('nanoflow.theme') as 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender' | null;
    if (savedTheme && savedTheme !== 'default') {
      this.store.theme.set(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  }

  private setupSwUpdateListener() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'))
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
    if (!this.supabase.isConfigured) {
      this.isCheckingSession.set(false);
      return;
    }
    this.isCheckingSession.set(true);
    try {
      const { data, error } = await this.supabase.getSession();
      if (error) throw error;
      const session = data?.session;
      if (session?.user) {
        this.sessionEmail.set(session.user.email ?? null);
        await this.store.setCurrentUser(session.user.id);
      }
    } catch (e: any) {
      this.authError.set(e?.message ?? String(e));
    } finally {
      this.isCheckingSession.set(false);
    }
  }

  async handleLogin(event?: Event, opts?: { closeSettings?: boolean }) {
    event?.preventDefault();
    if (!this.supabase.isConfigured) {
      this.authError.set('Supabase keys missing. Set NG_APP_SUPABASE_URL/NG_APP_SUPABASE_ANON_KEY.');
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const { data, error } = await this.supabase.signInWithPassword(this.authEmail(), this.authPassword());
      if (error || !data.session?.user) {
        throw new Error(error?.message || 'Login failed');
      }
      this.sessionEmail.set(data.session.user.email ?? null);
      await this.store.setCurrentUser(data.session.user.id);
      this.isReloginMode.set(false);
      this.showLoginModal.set(false); // 关闭登录模态框
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

  async signOut() {
    if (this.supabase.isConfigured) {
      await this.supabase.signOut();
    }
    this.sessionEmail.set(null);
    this.authPassword.set('');
    this.isReloginMode.set(false);
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
  
  confirmCreateProject(name: string, desc: string) {
      if (!name) return;
      this.store.addProject({
          id: crypto.randomUUID(),
          name,
          description: desc,
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: []
      });
      this.showNewProjectModal.set(false);
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
      await this.store.deleteProject(target.id);
      this.expandedProjectId.set(null);
    }
    this.showDeleteProjectModal.set(false);
    this.deleteProjectTarget.set(null);
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
  
  updateTheme(theme: 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender') {
    // 使用 store 的 setTheme 方法，会自动同步到云端
    void this.store.setTheme(theme);
  }

  updateFilter(e: Event) {
      this.store.filterMode.set((e.target as HTMLSelectElement).value);
  }

  @HostListener('window:resize')
  checkMobile() {
    this.store.isMobile.set(window.innerWidth < 768); // Tailwind md breakpoint
    if (this.store.isMobile()) {
      this.isSidebarOpen.set(false); // Auto-close sidebar on mobile
    }
  }
}
