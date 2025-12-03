/**
 * StoreService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖不变量：
 * 1. displayId 唯一性不变量
 * 2. 父子关系完整性不变量
 * 3. 连接完整性不变量
 * 4. 撤销/重做正确性不变量
 * 5. 项目隔离不变量
 * 6. Rank 排序不变量
 * 
 * 重构后架构：StoreService 作为纯门面，委托给子服务
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, computed, WritableSignal } from '@angular/core';
import { Subject } from 'rxjs';
import { StoreService } from './store.service';
import { AuthService } from './auth.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { ActionQueueService } from './action-queue.service';
import { AttachmentService } from './attachment.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { SearchService } from './search.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { PreferenceService } from './preference.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { RemoteChangeHandlerService } from './remote-change-handler.service';
import { Project, Task } from '../models';

// ========== 模拟依赖服务 ==========

// 创建项目状态 Signal（用于跨服务共享）
let mockProjectsSignal: WritableSignal<Project[]>;
let mockActiveProjectIdSignal: WritableSignal<string | null>;
let mockSearchQuerySignal: WritableSignal<string>;

const mockAuthService = {
  currentUserId: signal<string | null>(null),
};

const mockUndoService = {
  canUndo: signal(false),
  canRedo: signal(false),
  record: vi.fn(),
  recordDebounced: vi.fn(),
  recordAction: vi.fn(),
  recordActionDebounced: vi.fn(),
  flushPendingAction: vi.fn(),
  undo: vi.fn().mockReturnValue(null),
  redo: vi.fn().mockReturnValue(null),
  clearHistory: vi.fn(),
  onProjectSwitch: vi.fn(),
  clearOutdatedHistory: vi.fn().mockReturnValue(0),
  createProjectSnapshot: vi.fn((project: Project) => ({
    id: project.id,
    tasks: project.tasks.map(t => ({ ...t })),
    connections: project.connections.map(c => ({ ...c }))
  })),
  isProcessing: false,
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockLayoutService = {
  rebalance: vi.fn((project: Project) => {
    // 简单的 displayId 计算逻辑
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let letterIndex = 0;
    
    project.tasks.forEach(task => {
      if (task.stage !== null) {
        task.displayId = letters[letterIndex % 26];
        letterIndex++;
      } else {
        task.displayId = '?';
      }
    });
    
    return project;
  }),
  validateAndFixTree: vi.fn((project: Project) => ({ project, issues: [] })),
  getUnassignedPosition: vi.fn(() => ({ x: 0, y: 0 })),
};

const mockActionQueueService = {
  queueSize: signal(0),
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
  enqueue: vi.fn(),
};

const mockAttachmentService = {
  setUrlRefreshCallback: vi.fn(),
  clearUrlRefreshCallback: vi.fn(),
  clearMonitoredAttachments: vi.fn(),
  monitorAttachment: vi.fn(),
};

// UiStateService mock
const mockUiStateService = {
  isUserEditing: signal(false),
  isEditing: false,
  selectedTaskId: signal<string | null>(null),
  textViewCollapsed: signal(true),
  viewStates: signal<Record<string, any>>({}),
  isLoadingRemote: signal(false),
  isSyncing: signal(false),
  isOnline: signal(true),
  syncError: signal<string | null>(null),
  hasConflict: signal(false),
  searchQuery: signal(''),
  projectSearchQuery: signal(''),
  setUserEditing: vi.fn((value: boolean) => {
    (mockUiStateService.isUserEditing as WritableSignal<boolean>).set(value);
    mockUiStateService.isEditing = value;
  }),
  markEditing: vi.fn(() => {
    mockUiStateService.isEditing = true;
  }),
  setSelectedTask: vi.fn(),
  setTextViewCollapsed: vi.fn(),
  updateViewState: vi.fn((projectId: string, state: any) => {
    const current = mockUiStateService.viewStates();
    (mockUiStateService.viewStates as WritableSignal<Record<string, any>>).set({
      ...current,
      [projectId]: { ...current[projectId], ...state }
    });
  }),
  getViewState: vi.fn((projectId: string) => mockUiStateService.viewStates()[projectId]),
  clearViewState: vi.fn(),
  clearSearch: vi.fn(() => {
    (mockUiStateService.searchQuery as WritableSignal<string>).set('');
  }),
  setSearchQueryDebounced: vi.fn((query: string) => {
    (mockUiStateService.searchQuery as WritableSignal<string>).set(query);
  }),
};

// ProjectStateService mock - 使用共享 signal
const createMockProjectStateService = () => ({
  projects: mockProjectsSignal,
  activeProjectId: mockActiveProjectIdSignal,
  activeProject: computed(() => {
    const id = mockActiveProjectIdSignal();
    return mockProjectsSignal().find(p => p.id === id) || null;
  }),
  tasks: computed(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    return project?.tasks || [];
  }),
  deletedTasks: computed(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    return project?.tasks.filter(t => t.deletedAt) || [];
  }),
  unassignedTasks: computed(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    return project?.tasks.filter(t => t.stage === null && !t.deletedAt) || [];
  }),
  setProjects: vi.fn((projects: Project[]) => mockProjectsSignal.set(projects)),
  addProject: vi.fn((project: Project) => {
    mockProjectsSignal.update(ps => [...ps, project]);
    mockActiveProjectIdSignal.set(project.id);
  }),
  updateProject: vi.fn((projectId: string, updater: (p: Project) => Project) => {
    mockProjectsSignal.update(ps => ps.map(p => p.id === projectId ? updater(p) : p));
  }),
  updateProjects: vi.fn((updater: (ps: Project[]) => Project[]) => {
    mockProjectsSignal.update(updater);
  }),
  deleteProject: vi.fn((projectId: string) => {
    mockProjectsSignal.update(ps => ps.filter(p => p.id !== projectId));
    const remaining = mockProjectsSignal();
    if (mockActiveProjectIdSignal() === projectId && remaining.length > 0) {
      mockActiveProjectIdSignal.set(remaining[0].id);
    } else if (remaining.length === 0) {
      mockActiveProjectIdSignal.set(null);
    }
  }),
  setActiveProjectId: vi.fn((id: string | null) => mockActiveProjectIdSignal.set(id)),
  getViewState: vi.fn(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    return project?.viewState || null;
  }),
  unfinishedItems: computed(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    const items: Array<{ taskId: string; taskDisplayId: string; text: string }> = [];
    project?.tasks.forEach(task => {
      if (task.stage !== null && task.content && !task.deletedAt) {
        const codeBlockRegex = /```[\s\S]*?```/g;
        const contentWithoutCodeBlocks = task.content.replace(codeBlockRegex, '');
        const todoRegex = /-\s*\[ \]\s*(.+)/g;
        let match;
        while ((match = todoRegex.exec(contentWithoutCodeBlocks)) !== null) {
          items.push({
            taskId: task.id,
            taskDisplayId: task.displayId || '?',
            text: match[1].trim()
          });
        }
      }
    });
    return items;
  }),
  compressDisplayId: vi.fn((displayId: string) => displayId),
});

// SearchService mock
const createMockSearchService = () => ({
  searchQuery: mockSearchQuerySignal,
  searchResults: computed(() => {
    const query = mockSearchQuerySignal().toLowerCase();
    if (!query) return [];
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    return project?.tasks.filter(t => 
      t.title.toLowerCase().includes(query) || 
      t.content?.toLowerCase().includes(query)
    ) || [];
  }),
  setSearchQuery: vi.fn((query: string) => mockSearchQuerySignal.set(query)),
  clearSearch: vi.fn(() => mockSearchQuerySignal.set('')),
  unfinishedItems: computed(() => {
    const project = mockProjectsSignal().find(p => p.id === mockActiveProjectIdSignal());
    const items: Array<{ taskId: string; text: string; line: number }> = [];
    project?.tasks.forEach(task => {
      if (task.stage !== null && task.content) {
        // 简单检测 - [ ] 标记
        const lines = task.content.split('\n');
        let inCodeBlock = false;
        lines.forEach((line, idx) => {
          if (line.startsWith('```')) inCodeBlock = !inCodeBlock;
          if (!inCodeBlock && /^\s*-\s*\[\s*\]/.test(line)) {
            items.push({
              taskId: task.id,
              text: line.replace(/^\s*-\s*\[\s*\]\s*/, ''),
              line: idx
            });
          }
        });
      }
    });
    return items;
  }),
});

// SyncCoordinatorService mock
const mockSyncCoordinatorService = {
  syncState: signal({
    isSyncing: false,
    isOnline: true,
    offlineMode: false,
    sessionExpired: false,
    syncError: null,
    hasConflict: false,
    conflictData: null,
  }),
  isLoadingRemote: signal(false),
  isSyncing: computed(() => false),
  isOnline: computed(() => true),
  offlineMode: computed(() => false),
  sessionExpired: computed(() => false),
  syncError: computed(() => null),
  hasConflict: computed(() => false),
  conflictData: computed(() => null),
  pendingActionsCount: computed(() => 0),
  onConflict$: new Subject<{ localProject: Project; remoteProject: Project; projectId: string }>(),
  scheduleSync: vi.fn().mockResolvedValue(undefined),
  scheduleDebouncedSync: vi.fn(),
  schedulePersist: vi.fn(),
  loadFromRemote: vi.fn().mockResolvedValue([]),
  markInitialized: vi.fn(),
  destroy: vi.fn(),
  resolveConflict: vi.fn().mockReturnValue({ success: true, value: null }),
  validateAndRebalance: vi.fn((project: Project) => project),
  saveProjectToCloud: vi.fn().mockResolvedValue({ success: true }),
  deleteProjectFromCloud: vi.fn().mockResolvedValue(true),
  saveOfflineSnapshot: vi.fn(),
};

// UserSessionService mock
const mockUserSessionService = {
  currentUserId: signal<string | null>(null),
  setCurrentUser: vi.fn().mockResolvedValue(undefined),
  switchActiveProject: vi.fn((projectId: string) => {
    const prevId = mockActiveProjectIdSignal();
    mockActiveProjectIdSignal.set(projectId);
    mockSearchQuerySignal.set('');
    // Also clear the UiStateService's searchQuery signal
    (mockUiStateService.searchQuery as WritableSignal<string>).set('');
    mockUndoService.onProjectSwitch(prevId);
  }),
  loadProjects: vi.fn().mockResolvedValue([]),
  clearLocalData: vi.fn(),
};

// PreferenceService mock
const mockPreferenceService = {
  theme: signal<'light' | 'dark' | 'system'>('system'),
  setTheme: vi.fn((theme: 'light' | 'dark' | 'system') => {
    (mockPreferenceService.theme as WritableSignal<'light' | 'dark' | 'system'>).set(theme);
  }),
  loadUserPreferences: vi.fn().mockResolvedValue(undefined),
  loadLocalPreferences: vi.fn(),
};

// TaskOperationAdapterService mock
let mockIsUserEditing = false;
const mockTaskOperationAdapterService = {
  isUserEditing: false,
  markEditing: vi.fn(() => {
    mockTaskOperationAdapterService.isUserEditing = true;
    mockIsUserEditing = true;
  }),
  getLastUpdateType: vi.fn(() => 'content' as const),
  addTask: vi.fn((task: Task, options?: any) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return { ...p, tasks: [...p.tasks, task] };
    }));
  }),
  updateTask: vi.fn((taskId: string, updates: Partial<Task>) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return {
        ...p,
        tasks: p.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t)
      };
    }));
  }),
  deleteTask: vi.fn((taskId: string) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      const deleteTaskAndDescendants = (tasks: Task[], targetId: string): Task[] => {
        const idsToDelete = new Set<string>();
        const findDescendants = (parentId: string) => {
          idsToDelete.add(parentId);
          tasks.filter(t => t.parentId === parentId).forEach(t => findDescendants(t.id));
        };
        findDescendants(targetId);
        return tasks.map(t => 
          idsToDelete.has(t.id) 
            ? { ...t, deletedAt: new Date().toISOString() }
            : t
        );
      };
      return { ...p, tasks: deleteTaskAndDescendants(p.tasks, taskId) };
    }));
  }),
  restoreTask: vi.fn((taskId: string) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return {
        ...p,
        tasks: p.tasks.map(t => t.id === taskId ? { ...t, deletedAt: null } : t)
      };
    }));
  }),
  permanentlyDeleteTask: vi.fn((taskId: string) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return { ...p, tasks: p.tasks.filter(t => t.id !== taskId) };
    }));
  }),
  updateTaskContent: vi.fn((taskId: string, content: string) => {
    mockTaskOperationAdapterService.isUserEditing = true;
    mockUiStateService.markEditing();
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return {
        ...p,
        tasks: p.tasks.map(t => t.id === taskId ? { ...t, content } : t)
      };
    }));
  }),
  updateTaskTitle: vi.fn((taskId: string, title: string) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return {
        ...p,
        tasks: p.tasks.map(t => t.id === taskId ? { ...t, title } : t)
      };
    }));
  }),
  addCrossTreeConnection: vi.fn((source: string, target: string) => {
    if (source === target) return;
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      if (p.connections.some(c => c.source === source && c.target === target)) return p;
      return {
        ...p,
        connections: [...p.connections, { 
          id: `conn-${source}-${target}`,
          source, 
          target 
        }]
      };
    }));
  }),
  removeConnection: vi.fn((source: string, target: string) => {
    mockProjectsSignal.update(ps => ps.map(p => {
      if (p.id !== mockActiveProjectIdSignal()) return p;
      return {
        ...p,
        connections: p.connections.filter(c => !(c.source === source && c.target === target))
      };
    }));
  }),
  cleanupOldTrashItems: vi.fn().mockReturnValue(0),
};

// RemoteChangeHandlerService mock
const mockRemoteChangeHandlerService = {
  handleIncrementalUpdate: vi.fn(),
  handleTaskLevelUpdate: vi.fn(),
  setupCallbacks: vi.fn(),
};

// 辅助函数：创建测试项目
function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides,
  };
}

// 辅助函数：创建测试任务
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}

describe('StoreService', () => {
  let service: StoreService;
  let mockProjectStateService: ReturnType<typeof createMockProjectStateService>;
  let mockSearchService: ReturnType<typeof createMockSearchService>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    
    // 重置 mock 状态
    mockTaskOperationAdapterService.isUserEditing = false;
    mockUiStateService.isEditing = false;
    (mockUiStateService.searchQuery as WritableSignal<string>).set('');
    
    // 初始化共享 signal
    mockProjectsSignal = signal<Project[]>([]);
    mockActiveProjectIdSignal = signal<string | null>(null);
    mockSearchQuerySignal = signal<string>('');
    
    // 创建带有状态的 mock 服务
    mockProjectStateService = createMockProjectStateService();
    mockSearchService = createMockSearchService();
    
    // 重新设置 createProjectSnapshot mock 实现
    mockUndoService.createProjectSnapshot.mockImplementation((project: Project) => ({
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: project.connections.map(c => ({ ...c }))
    }));

    TestBed.configureTestingModule({
      providers: [
        StoreService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: SearchService, useValue: mockSearchService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinatorService },
        { provide: UserSessionService, useValue: mockUserSessionService },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: TaskOperationAdapterService, useValue: mockTaskOperationAdapterService },
        { provide: RemoteChangeHandlerService, useValue: mockRemoteChangeHandlerService },
      ],
    });

    service = TestBed.inject(StoreService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ==================== 项目管理基础测试 ====================
  
  describe('项目管理', () => {
    it('应该能够添加新项目', async () => {
      const project = createTestProject({ name: 'New Project' });
      
      await service.addProject(project);
      
      expect(service.projects().length).toBe(1);
      expect(service.projects()[0].name).toBe('New Project');
    });
    
    it('添加项目后应该自动设为活动项目', async () => {
      const project = createTestProject();
      
      await service.addProject(project);
      
      expect(service.activeProjectId()).toBe(project.id);
    });
    
    it('应该能够删除项目', async () => {
      const project = createTestProject();
      await service.addProject(project);
      expect(service.projects().length).toBe(1);
      
      await service.deleteProject(project.id);
      
      expect(service.projects().length).toBe(0);
    });
    
    it('删除当前活动项目后应该切换到下一个项目', async () => {
      const project1 = createTestProject({ id: 'proj-1', name: 'Project 1' });
      const project2 = createTestProject({ id: 'proj-2', name: 'Project 2' });
      
      await service.addProject(project1);
      await service.addProject(project2);
      service.switchActiveProject('proj-1');
      
      await service.deleteProject('proj-1');
      
      expect(service.activeProjectId()).toBe('proj-2');
    });
  });

  // ==================== displayId 唯一性不变量 ====================
  
  describe('displayId 唯一性不变量', () => {
    it('项目中所有任务的 displayId 应该唯一', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1, displayId: 'A' }),
          createTestTask({ id: 'task-2', stage: 1, displayId: 'B' }),
          createTestTask({ id: 'task-3', stage: 2, displayId: 'C' }),
        ],
      });
      
      await service.addProject(project);
      
      const tasks = service.tasks();
      const displayIds = tasks.map(t => t.displayId);
      const uniqueDisplayIds = new Set(displayIds);
      
      expect(displayIds.length).toBe(uniqueDisplayIds.size);
    });
    
    it('未分配任务的 displayId 应该为 "?"', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: null, displayId: '?' }),
        ],
      });
      
      await service.addProject(project);
      
      const unassigned = service.unassignedTasks();
      expect(unassigned.every(t => t.displayId === '?')).toBe(true);
    });
  });

  // ==================== 父子关系完整性不变量 ====================
  
  describe('父子关系完整性不变量', () => {
    it('子任务的 parentId 必须引用存在的父任务', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'parent', stage: 1, parentId: null }),
          createTestTask({ id: 'child', stage: 2, parentId: 'parent' }),
        ],
      });
      
      await service.addProject(project);
      
      const tasks = service.tasks();
      const child = tasks.find(t => t.id === 'child');
      const parent = tasks.find(t => t.id === child?.parentId);
      
      expect(parent).toBeDefined();
      expect(parent?.id).toBe('parent');
    });
    
    it('软删除父任务时应该级联软删除子任务', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'parent', stage: 1, parentId: null }),
          createTestTask({ id: 'child', stage: 2, parentId: 'parent' }),
          createTestTask({ id: 'grandchild', stage: 3, parentId: 'child' }),
        ],
      });
      
      await service.addProject(project);
      service.deleteTask('parent');
      
      const deletedTasks = service.deletedTasks();
      const deletedIds = deletedTasks.map(t => t.id);
      
      expect(deletedIds).toContain('parent');
      expect(deletedIds).toContain('child');
      expect(deletedIds).toContain('grandchild');
    });
  });

  // ==================== 连接完整性不变量 ====================
  
  describe('连接完整性不变量', () => {
    it('应该能够在两个任务之间创建连接', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1 }),
          createTestTask({ id: 'task-2', stage: 1 }),
        ],
      });
      
      await service.addProject(project);
      service.addCrossTreeConnection('task-1', 'task-2');
      
      const connections = service.activeProject()?.connections || [];
      expect(connections.some(c => c.source === 'task-1' && c.target === 'task-2')).toBe(true);
    });
    
    it('不应该创建重复的连接', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1 }),
          createTestTask({ id: 'task-2', stage: 1 }),
        ],
      });
      
      await service.addProject(project);
      service.addCrossTreeConnection('task-1', 'task-2');
      service.addCrossTreeConnection('task-1', 'task-2'); // 重复添加
      
      const connections = service.activeProject()?.connections || [];
      const matchingConnections = connections.filter(
        c => c.source === 'task-1' && c.target === 'task-2'
      );
      
      expect(matchingConnections.length).toBe(1);
    });
    
    it('不应该创建自连接', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1 }),
        ],
      });
      
      await service.addProject(project);
      service.addCrossTreeConnection('task-1', 'task-1');
      
      const connections = service.activeProject()?.connections || [];
      expect(connections.length).toBe(0);
    });
    
    it('应该能够移除连接', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1 }),
          createTestTask({ id: 'task-2', stage: 1 }),
        ],
      });
      
      await service.addProject(project);
      service.addCrossTreeConnection('task-1', 'task-2');
      
      service.removeConnection('task-1', 'task-2');
      
      const connections = service.activeProject()?.connections || [];
      expect(connections.some(c => c.source === 'task-1' && c.target === 'task-2')).toBe(false);
    });
  });

  // ==================== Rank 排序不变量 ====================
  
  describe('Rank 排序不变量', () => {
    it('同一阶段的任务 rank 应该保持相对顺序', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', stage: 1, rank: 1000 }),
          createTestTask({ id: 'task-2', stage: 1, rank: 2000 }),
          createTestTask({ id: 'task-3', stage: 1, rank: 3000 }),
        ],
      });
      
      await service.addProject(project);
      
      const stage1Tasks = service.tasks()
        .filter(t => t.stage === 1)
        .sort((a, b) => a.rank - b.rank);
      
      expect(stage1Tasks[0].id).toBe('task-1');
      expect(stage1Tasks[1].id).toBe('task-2');
      expect(stage1Tasks[2].id).toBe('task-3');
    });
  });

  // ==================== 项目隔离不变量 ====================
  
  describe('项目隔离不变量', () => {
    it('切换项目时应该调用撤销历史清理', async () => {
      const project1 = createTestProject({ id: 'proj-1' });
      const project2 = createTestProject({ id: 'proj-2' });
      
      await service.addProject(project1);
      await service.addProject(project2);
      
      // 先切换到 proj-1（因为添加 project2 后它会成为活动项目）
      service.switchActiveProject('proj-1');
      vi.clearAllMocks(); // 清除之前的调用记录
      
      service.switchActiveProject('proj-2');
      
      expect(mockUndoService.onProjectSwitch).toHaveBeenCalledWith('proj-1');
    });
    
    it('切换项目时应该清空搜索状态', async () => {
      const project1 = createTestProject({ id: 'proj-1' });
      const project2 = createTestProject({ id: 'proj-2' });
      
      await service.addProject(project1);
      await service.addProject(project2);
      
      // 先切换到 proj-1（因为添加 project2 后它会成为活动项目）
      service.switchActiveProject('proj-1');
      
      mockUiStateService.searchQuery.set('test query');
      service.switchActiveProject('proj-2');
      
      expect(mockUiStateService.searchQuery()).toBe('');
    });
  });

  // ==================== 任务内容操作 ====================
  
  describe('任务内容操作', () => {
    it('更新任务内容应该标记为正在编辑', async () => {
      const project = createTestProject({
        tasks: [createTestTask({ id: 'task-1' })],
      });
      
      await service.addProject(project);
      
      service.updateTaskContent('task-1', 'Updated content');
      
      expect(service.isUserEditing).toBe(true);
    });
    
    it('应该能够更新任务标题', async () => {
      const project = createTestProject({
        tasks: [createTestTask({ id: 'task-1', title: 'Original' })],
      });
      
      await service.addProject(project);
      service.updateTaskTitle('task-1', 'Updated Title');
      
      const task = service.tasks().find(t => t.id === 'task-1');
      expect(task?.title).toBe('Updated Title');
    });
  });

  // ==================== 回收站功能 ====================
  
  describe('回收站功能', () => {
    it('软删除的任务应该出现在 deletedTasks 中', async () => {
      const project = createTestProject({
        tasks: [createTestTask({ id: 'task-1' })],
      });
      
      await service.addProject(project);
      service.deleteTask('task-1');
      
      expect(service.deletedTasks().length).toBe(1);
      expect(service.deletedTasks()[0].id).toBe('task-1');
    });
    
    it('应该能够从回收站恢复任务', async () => {
      const project = createTestProject({
        tasks: [createTestTask({ id: 'task-1' })],
      });
      
      await service.addProject(project);
      service.deleteTask('task-1');
      expect(service.deletedTasks().length).toBe(1);
      
      service.restoreTask('task-1');
      
      expect(service.deletedTasks().length).toBe(0);
      expect(service.tasks().find(t => t.id === 'task-1')?.deletedAt).toBeNull();
    });
    
    it('永久删除应该完全移除任务', async () => {
      const project = createTestProject({
        tasks: [createTestTask({ id: 'task-1' })],
      });
      
      await service.addProject(project);
      service.deleteTask('task-1');
      service.permanentlyDeleteTask('task-1');
      
      expect(service.tasks().length).toBe(0);
      expect(service.deletedTasks().length).toBe(0);
    });
  });

  // ==================== 未完成项目检测 ====================
  
  describe('未完成项目检测', () => {
    it('应该能够检测任务内容中的 TODO 项', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ 
            id: 'task-1', 
            stage: 1,
            content: '- [ ] First todo\n- [ ] Second todo' 
          }),
        ],
      });
      
      await service.addProject(project);
      
      const unfinished = service.unfinishedItems();
      expect(unfinished.length).toBe(2);
    });
    
    it('代码块中的 TODO 标记应该被忽略', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ 
            id: 'task-1', 
            stage: 1,
            content: '```\n- [ ] Fake todo in code\n```\n- [ ] Real todo' 
          }),
        ],
      });
      
      await service.addProject(project);
      
      const unfinished = service.unfinishedItems();
      expect(unfinished.length).toBe(1);
      expect(unfinished[0].text).toBe('Real todo');
    });
  });

  // ==================== 搜索功能 ====================
  
  describe('搜索功能', () => {
    it('应该能够搜索任务标题', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Important Task' }),
          createTestTask({ id: 'task-2', title: 'Another Task' }),
        ],
      });
      
      await service.addProject(project);
      mockSearchQuerySignal.set('important');
      
      const results = service.searchResults();
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Important Task');
    });
    
    it('空搜索查询应该返回空结果', async () => {
      const project = createTestProject({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Task' }),
        ],
      });
      
      await service.addProject(project);
      mockSearchQuerySignal.set('');
      
      expect(service.searchResults().length).toBe(0);
    });
  });

  // ==================== 视图状态管理 ====================
  
  describe('视图状态管理', () => {
    it('应该能够保存和获取视图状态', async () => {
      const project = createTestProject();
      await service.addProject(project);
      
      service.updateViewState(project.id, { scale: 1.5, positionX: 100, positionY: 200 });
      
      const viewState = service.getViewState();
      expect(viewState).toEqual({
        scale: 1.5,
        positionX: 100,
        positionY: 200,
      });
    });
  });
});
