import { Injectable, signal, computed, inject } from '@angular/core';
import { GoogleGenAI } from '@google/genai';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';

export interface Task {
  id: string;
  title: string;
  content: string; // Markdown
  stage: number | null; // Null if unassigned
  parentId: string | null;
  order: number; // Order within stage/parent
  rank: number; // Gravity-based ordering
  status: 'active' | 'completed';
  x: number; // Flowchart X
  y: number; // Flowchart Y
  createdDate: string;
  displayId: string; // "1", "1,a", "2,b" etc.
  hasIncompleteTask?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: { source: string; target: string }[];
}

export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string; // The text after "- [ ]"
}

interface ProjectRow {
  id: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  data?: {
    tasks?: Task[];
    connections?: { source: string; target: string }[];
  } | null;
  updated_at?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  supabase = inject(SupabaseClientService);
  
  // UI State
  isMobile = signal(false);
  
  // Network status
  isOnline = signal(typeof window !== 'undefined' ? navigator.onLine : true);
  
  // State
  projects = signal<Project[]>([]);
  readonly currentUserId = signal<string | null>(null);
  readonly isLoadingRemote = signal(false);
  readonly isSyncing = signal(false);
  readonly syncError = signal<string | null>(null);
  readonly offlineMode = signal(false);

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offlineCacheKey = 'nanoflow.offline-cache-v1';
  private realtimeChannel: RealtimeChannel | null = null;

  // State
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all'); // 'all' or a root task ID (for To-Do list)
  readonly stageViewRootFilter = signal<'all' | string>('all'); // 'all' or a root task ID (for Stage View)
  readonly stageFilter = signal<'all' | number>('all');
  
  // UI State for Text Column
  readonly isTextUnfinishedOpen = signal(true);
  readonly isTextUnassignedOpen = signal(true);

  // UI State for Flow Column
  readonly isFlowUnfinishedOpen = signal(true);
  readonly isFlowUnassignedOpen = signal(true);
  readonly isFlowDetailOpen = signal(false);
  
  // Layout Dimensions
  readonly sidebarWidth = signal(280); // px
  readonly textColumnRatio = signal(50); // percentage of main content
  
  // Settings
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');
  
  // Theme Settings
  readonly theme = signal<'default' | 'ocean' | 'forest' | 'sunset' | 'lavender'>('default');
  
  // User Preferences (synced to cloud)
  private preferencesKey = 'nanoflow.preferences-v1';

  // AI
  private ai: GoogleGenAI | null = null;
  private letters = 'abcdefghijklmnopqrstuvwxyz';
  private stageSpacing = 260;
  private rowSpacing = 140;
  private rankRootBase = 10000;
  private rankStep = 500;
  private rankMinGap = 50;
  private hasPendingLocalChanges = false; // 用于避免实时同步覆盖正在输入的内容
  private lastPersistAt = 0;
  private isEditing = false; // 用户是否正在输入
  private editingTimer: ReturnType<typeof setTimeout> | null = null;

  private resolveApiKey() {
    const candidate = (globalThis as any).__GENAI_API_KEY__;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    return null;
  }

  private maxParentRank(task: Task | null, tasks: Task[]) {
    if (!task?.parentId) return null;
    const parent = tasks.find(t => t.id === task.parentId);
    return parent ? parent.rank : null;
  }

  private minChildRank(taskId: string, tasks: Task[]) {
    const children = tasks.filter(t => t.parentId === taskId);
    if (children.length === 0) return Infinity;
    return Math.min(...children.map(c => c.rank));
  }

  private applyRefusalStrategy(target: Task, candidateRank: number, parentRank: number | null, minChildRank: number) {
    let nextRank = candidateRank;
    if (parentRank !== null && nextRank <= parentRank) {
      nextRank = parentRank + this.rankStep;
    }
    if (Number.isFinite(minChildRank) && nextRank >= minChildRank) {
      nextRank = minChildRank - this.rankStep;
    }
    const violatesParent = parentRank !== null && nextRank <= parentRank;
    const violatesChild = Number.isFinite(minChildRank) && nextRank >= minChildRank;
    if (violatesParent || violatesChild) {
      console.warn('Refused ordering: violates parent/child constraints', {
        taskId: target.id,
        parentRank,
        minChildRank,
        requested: candidateRank
      });
      return { ok: false, rank: candidateRank };
    }
    return { ok: true, rank: nextRank };
  }

  private updateActiveProject(mutator: (project: Project) => Project) {
    let updated = false;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        updated = true;
        return mutator(p);
      }
      return p;
    }));
    if (updated) {
      this.hasPendingLocalChanges = true;
      this.schedulePersist();
    }
  }

  private gridPosition(stage: number, index: number) {
    return {
      x: (stage - 1) * this.stageSpacing + 120,
      y: 100 + index * this.rowSpacing
    };
  }

  private detectIncomplete(content: string) {
    return /- \[ \]/.test(content || '');
  }

  private stageBase(stage: number) {
    return this.rankRootBase + (stage - 1) * this.rankRootBase;
  }

  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null) {
    const sorted = siblings.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
    const base = parentRank !== null && parentRank !== undefined 
      ? parentRank + this.rankStep 
      : this.stageBase(stage);
    let prev: Task | null = null;
    let next: Task | null = null;
    if (beforeId) {
      const idx = sorted.findIndex(t => t.id === beforeId);
      if (idx >= 0) {
        next = sorted[idx];
        prev = idx > 0 ? sorted[idx - 1] : null;
      }
    }
    if (!beforeId || !next) {
      prev = sorted[sorted.length - 1] || null;
      next = null;
    }

    let rank: number;
    if (prev && next) {
      rank = (prev.rank + next.rank) / 2;
    } else if (prev && !next) {
      rank = prev.rank + this.rankStep;
    } else if (!prev && next) {
      rank = next.rank - this.rankStep;
    } else {
      rank = base;
    }

    return rank;
  }

  private rebalance(project: Project): Project {
    const tasks = project.tasks.map(t => ({ ...t }));
    const byId = new Map<string, Task>();
    tasks.forEach(t => byId.set(t.id, t));

    tasks.forEach(t => {
      if (t.rank === undefined || t.rank === null) {
        const base = t.stage ? this.stageBase(t.stage) : this.rankRootBase;
        t.rank = base + (t.order || 0) * this.rankStep;
      }
      t.hasIncompleteTask = this.detectIncomplete(t.content);
    });

    // Align children with parents for stage/rank monotonicity
    tasks.forEach(t => {
      if (t.parentId) {
        const parent = byId.get(t.parentId);
        if (parent && parent.stage !== null) {
          if (t.stage === null || t.stage <= parent.stage) {
            t.stage = parent.stage + 1;
          }
          if (t.rank <= parent.rank) {
            t.rank = parent.rank + this.rankStep;
          }
        }
      }
    });

    // Group by stage and normalize
    const grouped = new Map<number, Task[]>();
    tasks.forEach(t => {
      if (t.stage !== null) {
        if (!grouped.has(t.stage)) grouped.set(t.stage, []);
        grouped.get(t.stage)!.push(t);
      }
    });

    grouped.forEach((list, stage) => {
      list.sort((a, b) => a.rank - b.rank || a.order - b.order);
      list.forEach((t, idx) => {
        t.order = idx + 1;
        if (t.x === undefined || t.y === undefined) {
          const pos = this.gridPosition(stage, idx);
          t.x = pos.x;
          t.y = pos.y;
        }
      });
    });

    // Unassigned ordering
    const unassigned = tasks.filter(t => t.stage === null).sort((a, b) => a.rank - b.rank || a.order - b.order);
    unassigned.forEach((t, idx) => {
      t.order = idx + 1;
      t.displayId = '?';
    });

    // Build lookup again after mutations
    tasks.forEach(t => byId.set(t.id, t));

    // Stage 1 roots define the leading numbers
    const stage1Roots = tasks
      .filter(t => t.stage === 1 && !t.parentId)
      .sort((a, b) => a.rank - b.rank);

    stage1Roots.forEach((t, idx) => {
      t.displayId = `${idx + 1}`;
    });

    // Children inherit parent's id + letters based on rank order
    const children = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!children.has(t.parentId)) children.set(t.parentId, []);
        children.get(t.parentId)!.push(t);
      }
    });

    const assignChildren = (parentId: string) => {
      const parent = byId.get(parentId);
      if (!parent) return;
      const list = (children.get(parentId) || []).sort((a, b) => a.rank - b.rank);
      list.forEach((child, idx) => {
        if (parent.stage !== null && (child.stage === null || child.stage <= parent.stage)) {
          child.stage = parent.stage + 1;
        }
        const letter = this.letters[idx % this.letters.length];
        child.displayId = `${parent.displayId},${letter}`;
        assignChildren(child.id);
      });
    };

    stage1Roots.forEach(t => assignChildren(t.id));

    tasks.forEach(t => {
      if (!t.displayId) t.displayId = '?';
      if (t.stage === null) {
        t.parentId = null;
        t.displayId = '?';
      }
    });

    // Enforce gravity with cascading push-down
    const childrenMap = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId)!.push(t);
      }
    });

    const cascade = (node: Task) => {
      const kids = (childrenMap.get(node.id) || []).sort((a, b) => a.rank - b.rank);
      let floor = node.rank;
      kids.forEach(child => {
        if (child.rank <= floor) {
          child.rank = floor + this.rankStep;
        }
        floor = child.rank;
        cascade(child);
      });
    };

    stage1Roots.forEach(root => cascade(root));

    // Recompute orders after cascade
    tasks
      .filter(t => t.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || a.rank - b.rank)
      .forEach((t, idx, arr) => {
        const sameStage = arr.filter(s => s.stage === t.stage);
        const position = sameStage.findIndex(s => s.id === t.id);
        t.order = position + 1;
      });

    return { ...project, tasks };
  }

  // Computed
  readonly activeProject = computed(() => 
    this.projects().find(p => p.id === this.activeProjectId()) || null
  );

  readonly tasks = computed(() => this.activeProject()?.tasks || []);

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null);
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    // Sort tasks in stages
    for (const [key, val] of stagesMap.entries()) {
      val.sort((a, b) => a.order - b.order);
    }
    
    // Return sorted array of stage objects
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null);
  });

  readonly unfinishedItems = computed<UnfinishedItem[]>(() => {
    const items: UnfinishedItem[] = [];
    const tasks = this.tasks();
    const filter = this.filterMode();
    
    let rootDisplayId = '';
    if (filter !== 'all') {
        const root = tasks.find(r => r.id === filter);
        if (root) rootDisplayId = root.displayId;
    }

    const regex = /- \[ \]\s*(.+)/g;

    tasks.forEach(t => {
      if (rootDisplayId) {
          const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
          if (!isDescendant) return;
      }

      // Clone regex to reset lastIndex
      const r = new RegExp(regex);
      let match;
      while ((match = r.exec(t.content)) !== null) {
        items.push({
          taskId: t.id,
          taskDisplayId: t.displayId,
          text: match[1].trim()
        });
      }
    });
    return items;
  });

  readonly rootTasks = computed(() => {
    // Used for To-Do filter dropdown (only roots with unfinished tasks)
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => regex.test(t.content || ''));
    
    return tasks.filter(t => t.stage === 1).filter(root => {
        if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
        return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    // Used for Stage View filter dropdown (all roots)
    return this.tasks().filter(t => t.stage === 1).sort((a, b) => a.rank - b.rank);
  });

  constructor() {
    try {
        const key = this.resolveApiKey();
        if (key) {
            this.ai = new GoogleGenAI({ apiKey: key });
        } else {
            console.info('AI not initialized: missing __GENAI_API_KEY__');
        }
    } catch (e) {
        console.warn('AI init failed', e);
    }

    this.loadFromCacheOrSeed();
    
    // Monitor network status
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.isOnline.set(true));
      window.addEventListener('offline', () => this.isOnline.set(false));
    }
  }

  async setCurrentUser(userId: string | null) {
    if (this.currentUserId() === userId) return;
    this.currentUserId.set(userId);
    this.activeProjectId.set(null);
    this.projects.set([]);
    this.syncError.set(null);
    this.teardownRealtimeSubscription();
    if (userId && this.supabase.isConfigured) {
      await this.loadProjects();
      await this.loadUserPreferences(); // 加载用户偏好设置
      await this.initRealtimeSubscription();
    } else {
      this.loadFromCacheOrSeed();
      this.loadLocalPreferences(); // 加载本地偏好设置
    }
  }
  
  // 加载用户偏好设置（从云端）
  private async loadUserPreferences() {
    const userId = this.currentUserId();
    if (!userId || !this.supabase.isConfigured) return;
    
    try {
      const { data, error } = await this.supabase.client()
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        throw error;
      }
      
      if (data?.theme) {
        this.theme.set(data.theme);
        this.applyThemeToDOM(data.theme);
        // 同时保存到本地
        localStorage.setItem('nanoflow.theme', data.theme);
      }
    } catch (e) {
      console.warn('加载用户偏好设置失败', e);
      // 降级到本地设置
      this.loadLocalPreferences();
    }
  }
  
  // 加载本地偏好设置
  private loadLocalPreferences() {
    const savedTheme = localStorage.getItem('nanoflow.theme') as 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender' | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }
  
  // 保存用户偏好设置（到云端）
  async saveUserPreferences() {
    const userId = this.currentUserId();
    const currentTheme = this.theme();
    
    // 始终保存到本地
    localStorage.setItem('nanoflow.theme', currentTheme);
    
    if (!userId || !this.supabase.isConfigured) return;
    
    try {
      const { error } = await this.supabase.client()
        .from('user_preferences')
        .upsert({
          user_id: userId,
          theme: currentTheme,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      
      if (error) throw error;
    } catch (e) {
      console.warn('保存用户偏好设置到云端失败', e);
    }
  }
  
  // 应用主题到 DOM
  private applyThemeToDOM(theme: string) {
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
  
  // 设置主题
  async setTheme(theme: 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender') {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    await this.saveUserPreferences();
  }

  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    return [
      this.rebalance({
        id: 'proj-seed-1',
        name: 'Alpha Protocol',
        description: 'NanoFlow core engine boot plan.',
        createdDate: now,
        tasks: [
          {
            id: 't1',
            title: 'Stage 1: Environment setup',
            content: 'Bootstrap project environment.\n- [ ] Init git repo\n- [ ] Install Node.js deps',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: 't2',
            title: 'Core logic implementation',
            content: 'Deliver core business logic.\n- [ ] Write unit tests',
            stage: 2,
            parentId: 't1',
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { source: 't1', target: 't2' }
        ]
      })
    ];
  }

  private loadFromCacheOrSeed() {
    let projects: Project[] | null = null;
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(this.offlineCacheKey) : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          projects = parsed.projects.map((p: Project) => this.rebalance(p));
        }
      }
    } catch (e) {
      console.warn('Offline cache read failed', e);
    }
    if (!projects || projects.length === 0) {
      projects = this.seedProjects();
    }
    this.projects.set(projects);
    this.activeProjectId.set(projects[0]?.id ?? null);
    this.offlineMode.set(true);
  }

  private saveOfflineSnapshot() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.offlineCacheKey, JSON.stringify({ projects: this.projects() }));
    } catch (e) {
      console.warn('Offline cache write failed', e);
    }
  }

  private teardownRealtimeSubscription() {
    if (this.realtimeChannel && this.supabase.isConfigured) {
      void this.supabase.client().removeChannel(this.realtimeChannel);
    }
    this.realtimeChannel = null;
  }

  async initRealtimeSubscription() {
    if (!this.supabase.isConfigured || !this.currentUserId()) return;
    this.teardownRealtimeSubscription();

    const channel = this.supabase.client()
      .channel('public:projects')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `owner_id=eq.${this.currentUserId()}`
        },
        payload => {
          console.log('收到云端变更:', payload);
          void this.handleRemoteChange(payload);
        }
      );

    this.realtimeChannel = channel;
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.info('Realtime channel ready');
      }
    });
  }

  // 防抖：避免短时间内多次触发同步
  private remoteChangeTimer: ReturnType<typeof setTimeout> | null = null;
  
  private async handleRemoteChange(payload: any) {
    // 先等本地输入/同步完成，避免覆盖正在输入的内容
    const processChange = async () => {
      // 有本地未落盘、正在编辑或刚刚持久化完，延迟处理
      if (this.isEditing || this.hasPendingLocalChanges || this.isSyncing() || Date.now() - this.lastPersistAt < 800) {
        this.remoteChangeTimer = setTimeout(processChange, 800);
        return;
      }
      try {
        await this.loadProjects();
      } catch (e) {
        console.error('处理实时更新失败', e);
      } finally {
        this.remoteChangeTimer = null;
      }
    };

    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
    }
    this.remoteChangeTimer = setTimeout(processChange, 500);
  }

  async loadProjects() {
    const userId = this.currentUserId();
    if (!userId || !this.supabase.isConfigured) {
      this.loadFromCacheOrSeed();
      return;
    }
    const previousActive = this.activeProjectId();
    this.isLoadingRemote.set(true);
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('owner_id', userId)
        .order('created_date', { ascending: true });
      if (error) throw error;
      const mapped = (data || []).map(row => this.mapRowToProject(row as ProjectRow));
      this.projects.set(mapped);
      if (previousActive && mapped.some(p => p.id === previousActive)) {
        this.activeProjectId.set(previousActive);
      } else {
        this.activeProjectId.set(mapped[0]?.id ?? null);
      }
      this.syncError.set(null);
      this.offlineMode.set(false);
      this.saveOfflineSnapshot();
    } catch (e: any) {
      console.error('Loading Supabase failed', e);
      this.syncError.set(e?.message ?? String(e));
      this.loadFromCacheOrSeed();
    } finally {
      this.isLoadingRemote.set(false);
    }
  }

  private mapRowToProject(row: ProjectRow): Project {
    return this.rebalance({
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? new Date().toISOString(),
      tasks: row.data?.tasks ?? [],
      connections: row.data?.connections ?? []
    });
  }

  private schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, 800);
  }

  private async persistActiveProject() {
    const project = this.activeProject();
    this.saveOfflineSnapshot();
    if (!project) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const userId = this.currentUserId();
    if (!userId || !this.supabase.isConfigured) {
      // 无远端配置时，只更新本地缓存并认为已落盘
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
      return;
    }

    this.isSyncing.set(true);
    try {
      const { error } = await this.supabase.client().from('projects').upsert({
        id: project.id,
        owner_id: userId,
        title: project.name,
        description: project.description,
        created_date: project.createdDate || new Date().toISOString(),
        data: {
          tasks: project.tasks,
          connections: project.connections
        }
      });
      if (error) throw error;
      this.syncError.set(null);
      this.offlineMode.set(false);
    } catch (e: any) {
      console.error('Sync project failed', e);
      this.syncError.set(e?.message ?? String(e));
      this.offlineMode.set(true);
    } finally {
      this.isSyncing.set(false);
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
    }
  }

  addProject(project: Project) {
    const balanced = this.rebalance(project);
    this.projects.update(p => [...p, balanced]);
    this.activeProjectId.set(balanced.id);
    this.schedulePersist();
  }

  // 删除项目
  async deleteProject(projectId: string) {
    const userId = this.currentUserId();
    
    // 从本地状态删除
    this.projects.update(p => p.filter(proj => proj.id !== projectId));
    
    // 如果删除的是当前活动项目，切换到其他项目
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.activeProjectId.set(remaining[0]?.id ?? null);
    }
    
    // 如果已登录，从云端删除
    if (userId && this.supabase.isConfigured) {
      try {
        const { error } = await this.supabase.client()
          .from('projects')
          .delete()
          .eq('id', projectId)
          .eq('owner_id', userId);
        if (error) throw error;
      } catch (e: any) {
        console.error('Delete project from cloud failed', e);
        this.syncError.set(e?.message ?? String(e));
      }
    }
    
    this.saveOfflineSnapshot();
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projects.update(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.schedulePersist();
    }
  }

  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }

  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }

  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
  }

  updateTaskContent(taskId: string, newContent: string) {
    // 标记正在编辑状态，防止远程同步覆盖
    this.markEditing();
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent } : t)
    }));
  }
  
  // 标记正在编辑状态
  markEditing() {
    this.isEditing = true;
    this.hasPendingLocalChanges = true;
    
    // 清除之前的定时器
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
    }
    
    // 1.5秒后清除编辑状态
    this.editingTimer = setTimeout(() => {
      this.isEditing = false;
      this.editingTimer = null;
    }, 1500);
  }
  
  // 检查是否正在编辑
  get isUserEditing(): boolean {
    return this.isEditing || this.hasPendingLocalChanges;
  }

  // 添加待办项：自动生成 - [ ] 格式
  addTodoItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const trimmedText = itemText.trim();
    if (!trimmedText) return;
    
    // 在内容末尾添加待办项
    const todoLine = `- [ ] ${trimmedText}`;
    let newContent = task.content || '';
    
    // 如果内容不为空且不以换行结尾，先添加换行
    if (newContent && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    newContent += todoLine;
    
    this.markEditing();
    this.updateTaskContent(taskId, newContent);
  }
  
  // 完成待办项：将 - [ ] 改为 - [x]
  completeUnfinishedItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    // 匹配并替换第一个匹配的未完成项
    const escapedText = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`- \\[ \\]\\s*${escapedText}`);
    const newContent = task.content.replace(regex, `- [x] ${itemText}`);
    
    if (newContent !== task.content) {
      this.updateTaskContent(taskId, newContent);
    }
  }

  updateTaskTitle(taskId: string, title: string) {
    // 标记正在编辑状态，防止远程同步覆盖
    this.markEditing();
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, title } : t)
    }));
  }

  // Update Task Position (for Flowchart)
  updateTaskPosition(taskId: string, x: number, y: number) {
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
    }));
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status } : t)
    }));
  }

  // 删除任务（及其所有子任务和连接）
  deleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    // 收集要删除的所有任务ID（包括子任务）
    const idsToDelete = new Set<string>();
    const collectDescendants = (id: string) => {
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => collectDescendants(child.id));
    };
    collectDescendants(taskId);
    
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): string | null {
    const activeP = this.activeProject();
    if (!activeP) return null;

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null ? this.gridPosition(targetStage, newOrder - 1) : { x: 80 + Math.random() * 120, y: 80 + Math.random() * 120 };
    const parent = parentId ? activeP.tasks.find(t => t.id === parentId) : null;
    const candidateRank = targetStage === null
      ? this.rankRootBase + activeP.tasks.filter(t => t.stage === null).length * this.rankStep
      : this.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title,
      content,
      stage: targetStage,
      parentId: targetStage === null ? null : parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x, 
      y: pos.y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    const placed = this.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) return null;
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.updateActiveProject(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.updateActiveProject(p => this.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
    
    return newTaskId;
  }

  // 添加跨树连接（不改变父子关系，仅添加视觉连接线）
  addCrossTreeConnection(sourceId: string, targetId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    // 检查连接是否已存在
    const exists = activeP.connections.some(
      c => c.source === sourceId && c.target === targetId
    );
    if (exists) return;
    
    // 检查任务是否存在
    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    if (!sourceTask || !targetTask) return;
    
    // 不允许连接到自己
    if (sourceId === targetId) return;
    
    this.updateActiveProject(p => ({
      ...p,
      connections: [...p.connections, { source: sourceId, target: targetId }]
    }));
  }

  // 删除连接
  removeConnection(sourceId: string, targetId: string) {
    this.updateActiveProject(p => ({
      ...p,
      connections: p.connections.filter(
        c => !(c.source === sourceId && c.target === targetId)
      )
    }));
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    const activeP = this.activeProject();
    if (!activeP) return;
    const count = activeP.tasks.filter(t => t.stage === null).length;
    const rank = this.rankRootBase + count * this.rankStep;
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: count + 1,
      rank,
      status: 'active',
      x,
      y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    this.updateActiveProject(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }
  
  moveTaskToStage(taskId: string, newStage: number | null, beforeTaskId?: string | null, newParentId?: string | null) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      target.stage = newStage;
      target.parentId = newStage === null ? null : (newParentId !== undefined ? newParentId : target.parentId);

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
      const parentRank = this.maxParentRank(target, tasks);
      const minChildRank = this.minChildRank(target.id, tasks);
      if (newStage !== null) {
        const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) return p;
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = this.rankRootBase + unassignedCount * this.rankStep;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) return p;
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.rebalance({ ...p, tasks });
    });
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank ?? this.stageBase(stage);
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        const parentRank = this.maxParentRank(task, tasks);
        const minChildRank = this.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + this.rankStep;
      });
      return this.rebalance({ ...p, tasks });
    });
  }

  detachTask(taskId: string) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = tasks.find(t => t.id === parentId);

      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent.stage + 1;
          }
        }
      });

      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = this.rankRootBase + unassignedCount * this.rankStep;
      target.displayId = '?';

      return this.rebalance({ ...p, tasks });
    });
  }

  // AI Capabilities
  async think(prompt: string): Promise<string> {
    if (!this.ai) return "AI not initialized (missing API key)";
    try {
      const result = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          thinkingConfig: { thinkingBudget: 1024 }
        }
      });
      return result.text || "AI returned empty response.";
    } catch (e) {
      return "AI error: " + e;
    }
  }
  
  async generateImage(prompt: string): Promise<string | null> {
    if (!this.ai) return null;
    try {
      const result = await this.ai.models.generateImages({
        model: "imagen-4.0-generate-001",
        prompt: prompt,
        config: { numberOfImages: 1 }
      });
      return result.generatedImages?.[0]?.image?.imageBytes 
        ? `data:image/png;base64,${result.generatedImages[0].image.imageBytes}`
        : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  
  async editImageWithPrompt(imageBase64: string, editInstruction: string): Promise<string | null> {
    if (!this.ai) return null;
    try {
      const analysisResponse = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            { inlineData: { mimeType: "image/png", data: imageBase64.split(',')[1] } },
            { text: `Generate a detailed image prompt that describes the new image resulting from applying this change: "${editInstruction}" to the provided image.` }
          ]
        }
      });
      
      const newPrompt = analysisResponse.text;
      if (!newPrompt) return null;

      const imgResult = await this.ai.models.generateImages({
        model: "imagen-4.0-generate-001",
        prompt: newPrompt,
        config: { numberOfImages: 1 }
      });
      
      return imgResult.generatedImages?.[0]?.image?.imageBytes
        ? `data:image/png;base64,${imgResult.generatedImages[0].image.imageBytes}`
        : null;
    } catch (e) {
      console.error("Edit Image Error", e);
      return null;
    }
  }
}
