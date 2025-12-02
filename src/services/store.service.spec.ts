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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StoreService } from './store.service';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { ActionQueueService } from './action-queue.service';
import { MigrationService } from './migration.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { AttachmentService } from './attachment.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';

// 模拟依赖服务
const mockAuthService = {
  currentUserId: signal<string | null>(null),
};

const mockSyncService = {
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
  setRemoteChangeCallback: vi.fn(),
  setTaskChangeCallback: vi.fn(),
  loadProjectsFromCloud: vi.fn().mockResolvedValue([]),
  saveProjectToCloud: vi.fn().mockResolvedValue({ success: true }),
  loadOfflineSnapshot: vi.fn().mockReturnValue([]),
  saveOfflineSnapshot: vi.fn(),
  clearOfflineCache: vi.fn(),
  initRealtimeSubscription: vi.fn().mockResolvedValue(undefined),
  teardownRealtimeSubscription: vi.fn(),
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  tryReloadConflictData: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
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
  rebalance: vi.fn((project: Project) => project),
  validateAndFixTree: vi.fn((project: Project) => ({ project, issues: [] })),
  getUnassignedPosition: vi.fn(() => ({ x: 0, y: 0 })),
};

const mockActionQueueService = {
  queueSize: signal(0),
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
  enqueue: vi.fn(),
};

const mockMigrationService = {
  migrateIfNeeded: vi.fn(),
};

const mockConflictService = {
  smartMerge: vi.fn((local: Project, remote: Project) => ({
    project: remote,
    conflictCount: 0,
  })),
  resolveConflict: vi.fn(),
};

const mockAttachmentService = {
  setUrlRefreshCallback: vi.fn(),
  clearUrlRefreshCallback: vi.fn(),
  clearMonitoredAttachments: vi.fn(),
  monitorAttachment: vi.fn(),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
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

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    
    // 重新设置 createProjectSnapshot mock 实现
    mockUndoService.createProjectSnapshot.mockImplementation((project: Project) => ({
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: project.connections.map(c => ({ ...c }))
    }));
    
    // 模拟 rebalance 计算 displayId
    mockLayoutService.rebalance.mockImplementation((project: Project) => {
      // 简单的 displayId 计算逻辑
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let letterIndex = 0;
      
      project.tasks.forEach((task, index) => {
        if (task.stage !== null) {
          task.displayId = letters[letterIndex % 26];
          letterIndex++;
        } else {
          task.displayId = '?';
        }
      });
      
      return project;
    });

    TestBed.configureTestingModule({
      providers: [
        StoreService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: SyncService, useValue: mockSyncService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: MigrationService, useValue: mockMigrationService },
        { provide: ConflictResolutionService, useValue: mockConflictService },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = TestBed.inject(StoreService);
    
    // 清空种子项目，确保测试从空白状态开始
    (service as any).projects.set([]);
    (service as any).activeProjectId.set(null);
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
      
      service.searchQuery.set('test query');
      service.switchActiveProject('proj-2');
      
      expect(service.searchQuery()).toBe('');
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
      service.searchQuery.set('Important');
      
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
      service.searchQuery.set('');
      
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
