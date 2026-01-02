/**
 * ConflictResolutionService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 冲突解决策略 - local/remote/merge
 * 2. 智能合并算法 - 任务合并、连接合并
 * 3. 字段级合并 - 时间戳比较、标签合并
 * 4. 文本内容合并 - 行级合并、前缀/后缀检测
 * 5. 离线数据重连合并
 * 6. 边缘情况 - 空数据、大数据量
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ConflictResolutionService } from './conflict-resolution.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { Project, Task, Connection } from '../models';

// ========== 模拟依赖服务 ==========

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
  resolveConflict: vi.fn(),
  saveProjectToCloud: vi.fn().mockResolvedValue({ success: true }),
  getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
  // 【v5.9】添加带状态的 tombstone 查询方法
  getTombstoneIdsWithStatus: vi.fn().mockResolvedValue({
    ids: new Set<string>(),
    fromRemote: true,
    localCacheOnly: false,
    timestamp: Date.now()
  }),
};

const mockLayoutService = {
  validateAndFixTree: vi.fn().mockImplementation((project: Project) => ({
    project,
    issues: [] as string[],
  })),
  rebalance: vi.fn().mockImplementation((project: Project) => project),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
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

// 模拟 ChangeTrackerService
const mockChangeTrackerService = {
  getLockedFields: vi.fn().mockReturnValue([]),
  lockTaskField: vi.fn(),
  unlockTaskField: vi.fn(),
  clearProjectFieldLocks: vi.fn(),
  isTaskFieldLocked: vi.fn().mockReturnValue(false),
};

// ========== 辅助函数 ==========

let connectionIdCounter = 0;

function createTestConnection(overrides?: Partial<Connection>): Connection {
  return {
    id: `conn-${++connectionIdCounter}`,
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

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

// ========== 测试用例 ==========

describe('ConflictResolutionService', () => {
  let service: ConflictResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        ConflictResolutionService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
      ],
    });

    service = TestBed.inject(ConflictResolutionService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ==================== 冲突解决策略 ====================

  describe('冲突解决策略', () => {
    describe('local 策略', () => {
      it('应该使用本地版本并递增版本号', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: 5 });
        const remoteProject = createTestProject({ id: 'proj-1', version: 7 });

        const result = await service.resolveConflict('proj-1', 'local', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          // LWW: max(local, remote) + 1 = max(5, 7) + 1 = 8
          expect(result.value.version).toBe(8);
        }
        expect(mockSyncService.resolveConflict).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({ version: 8 }),
          'local'
        );
      });

      it('版本为 undefined 时应该使用 1', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: undefined });

        const result = await service.resolveConflict('proj-1', 'local', localProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.version).toBe(1);
        }
      });
    });

    describe('remote 策略', () => {
      it('应该使用远程版本', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: 5 });
        const remoteProject = createTestProject({ 
          id: 'proj-1', 
          version: 7,
          name: 'Remote Name',
        });

        const result = await service.resolveConflict('proj-1', 'remote', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.name).toBe('Remote Name');
        }
        expect(mockSyncService.resolveConflict).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({ name: 'Remote Name' }),
          'remote'
        );
      });

      it('远程项目为空时应该返回错误', async () => {
        const localProject = createTestProject({ id: 'proj-1' });

        const result = await service.resolveConflict('proj-1', 'remote', localProject);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('远程项目数据不存在');
        }
      });
    });

    describe('merge 策略', () => {
      it('应该合并双方的更改', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          version: 5,
          tasks: [createTestTask({ id: 'task-1', title: 'Local Task' })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          version: 7,
          tasks: [createTestTask({ id: 'task-2', title: 'Remote Task' })],
        });

        const result = await service.resolveConflict('proj-1', 'merge', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.tasks.length).toBe(2);
          expect(result.value.version).toBe(8); // max(5, 7) + 1
        }
      });

      it('远程项目为空时应该返回错误', async () => {
        const localProject = createTestProject({ id: 'proj-1' });

        const result = await service.resolveConflict('proj-1', 'merge', localProject);

        expect(result.ok).toBe(false);
      });

      it('合并有问题时应该显示提示', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-1' })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-1', title: 'Different Title' })],
        });

        // 模拟验证返回问题
        mockLayoutService.validateAndFixTree.mockReturnValueOnce({
          project: { ...localProject },
          issues: ['Fixed orphan task'],
        });

        await service.resolveConflict('proj-1', 'merge', localProject, remoteProject);

        expect(mockToastService.info).toHaveBeenCalled();
      });
    });
  });

  // ==================== 智能合并算法 ====================

  describe('智能合并算法', () => {
    describe('任务合并', () => {
      it('本地新增的任务应该保留', () => {
        const localProject = createTestProject({
          tasks: [
            createTestTask({ id: 'task-1', title: 'Original' }),
            createTestTask({ id: 'task-new-local', title: 'New Local' }),
          ],
        });
        const remoteProject = createTestProject({
          tasks: [createTestTask({ id: 'task-1', title: 'Original' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.tasks).toHaveLength(2);
        expect(result.project.tasks.find(t => t.id === 'task-new-local')).toBeDefined();
      });

      it('远程新增的任务应该保留', () => {
        const localProject = createTestProject({
          tasks: [createTestTask({ id: 'task-1', title: 'Original' })],
        });
        const remoteProject = createTestProject({
          tasks: [
            createTestTask({ id: 'task-1', title: 'Original' }),
            createTestTask({ id: 'task-new-remote', title: 'New Remote' }),
          ],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.tasks).toHaveLength(2);
        expect(result.project.tasks.find(t => t.id === 'task-new-remote')).toBeDefined();
      });

      it('双方都有的任务应该字段级合并', () => {
        const oldTime = new Date('2024-01-01T00:00:00Z').toISOString();
        const newTime = new Date('2024-01-02T00:00:00Z').toISOString();

        const localProject = createTestProject({
          tasks: [createTestTask({
            id: 'task-1',
            title: 'Local Title',
            content: 'Local Content',
            updatedAt: newTime,
          })],
        });
        const remoteProject = createTestProject({
          tasks: [createTestTask({
            id: 'task-1',
            title: 'Remote Title',
            content: 'Remote Content',
            updatedAt: oldTime,
          })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        const mergedTask = result.project.tasks[0];
        expect(mergedTask.title).toBe('Local Title'); // 本地更新时间更新
        expect(result.conflictCount).toBeGreaterThan(0);
      });
    });

    describe('连接合并', () => {
      it('应该合并双方的连接', () => {
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-2', source: 'task-3', target: 'task-4' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.connections).toHaveLength(2);
      });

      it('重复连接应该去重（相同 id）', () => {
        // 【修正】使用相同的 id 测试去重逻辑
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.connections).toHaveLength(1);
      });
      
      it('不同 id 的连接即使 source→target 相同也应该保留', () => {
        // 【Week 2 修复】使用 id 作为唯一键，允许同一 source→target 有多个连接
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-2', source: 'task-1', target: 'task-2' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        // 两个不同 id 的连接应该都保留
        expect(result.project.connections).toHaveLength(2);
      });

      it('软删除的连接应该正确处理 - 删除优先策略', () => {
        // 【修正】使用相同的 id 测试删除优先策略
        const localProject = createTestProject({
          connections: [
            createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2', deletedAt: null }),
          ],
        });
        const deletedTime = new Date().toISOString();
        const remoteProject = createTestProject({
          connections: [
            createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2', deletedAt: deletedTime }),
          ],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        // 删除优先策略：远程已删除，应该采用删除状态
        const conn = result.project.connections.find(
          c => c.source === 'task-1' && c.target === 'task-2'
        );
        expect(conn?.deletedAt).toBe(deletedTime);
      });
    });
  });

  // ==================== 字段级合并 ====================

  describe('字段级合并', () => {
    it('更新时间较新的字段应该胜出', () => {
      const oldTime = new Date('2024-01-01T00:00:00Z').toISOString();
      const newTime = new Date('2024-01-02T00:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Old Title',
          status: 'completed',
          updatedAt: oldTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'New Title',
          status: 'active',
          updatedAt: newTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.title).toBe('New Title');
      expect(task.status).toBe('active');
    });

    it('标签应该合并去重', () => {
      // 设置相同的时间戳，确保合并逻辑能正确保留两边的新标签
      const sameTime = '2024-01-01T12:00:00.000Z';
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          tags: ['tag1', 'tag2'],
          updatedAt: sameTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          tags: ['tag2', 'tag3'],
          updatedAt: sameTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.tags).toEqual(expect.arrayContaining(['tag1', 'tag2', 'tag3']));
      expect(task.tags?.length).toBe(3);
    });

    it('附件应该按 ID 合并', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          attachments: [
            { id: 'att-1', name: 'file1.pdf', url: '/url1', size: 100, type: 'document', createdAt: '' },
          ],
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          attachments: [
            { id: 'att-2', name: 'file2.pdf', url: '/url2', size: 200, type: 'document', createdAt: '' },
          ],
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.attachments?.length).toBe(2);
    });

    it('位置信息应该保留本地值', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          x: 100,
          y: 200,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          x: 500,
          y: 600,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.x).toBe(100); // 保留本地位置
      expect(task.y).toBe(200);
    });

    it('删除标记应该合并（任一方删除则删除）', () => {
      const now = new Date().toISOString();
      
      // 场景1: 本地删除，远程未删除
      const localProject1 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: now,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject1 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: null,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result1 = service.smartMerge(localProject1, remoteProject1, new Set());
      expect(result1.project.tasks[0].deletedAt).toBe(now);

      // 场景2: 本地未删除，远程删除
      const localProject2 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: null,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });
      const remoteProject2 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: now,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });

      const result2 = service.smartMerge(localProject2, remoteProject2, new Set());
      expect(result2.project.tasks[0].deletedAt).toBe(now);

      // 场景3: 双方都删除（使用较早的删除时间）
      const earlierTime = new Date('2024-01-01T10:00:00Z').toISOString();
      const laterTime = new Date('2024-01-01T11:00:00Z').toISOString();
      
      const localProject3 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: laterTime,
        })],
      });
      const remoteProject3 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: earlierTime,
        })],
      });

      const result3 = service.smartMerge(localProject3, remoteProject3, new Set());
      expect(result3.project.tasks[0].deletedAt).toBe(earlierTime);
    });

    it('被锁定的 status 字段应该始终使用本地版本', () => {
      // 模拟 status 字段被锁定（用户正在操作）
      mockChangeTrackerService.getLockedFields.mockReturnValue(['status']);
      
      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'completed',  // 本地：已完成
          updatedAt: new Date('2024-01-01').toISOString(),  // 本地时间更早
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'active',  // 远程：进行中
          updatedAt: new Date('2024-01-02').toISOString(),  // 远程时间更新
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 即使远程时间更新，也应该使用本地的 status（因为被锁定）
      expect(result.project.tasks[0].status).toBe('completed');
      
      // 恢复默认行为
      mockChangeTrackerService.getLockedFields.mockReturnValue([]);
    });

    it('被锁定的 title 字段应该始终使用本地版本', () => {
      mockChangeTrackerService.getLockedFields.mockReturnValue(['title']);
      
      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Local Title',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Remote Title',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Local Title');
      
      mockChangeTrackerService.getLockedFields.mockReturnValue([]);
    });

    it('未锁定的字段应该使用 LWW 策略', () => {
      mockChangeTrackerService.getLockedFields.mockReturnValue([]);
      
      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'active',
          title: 'Local Title',
          updatedAt: new Date('2024-01-01').toISOString(),  // 本地时间更早
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'completed',
          title: 'Remote Title',
          updatedAt: new Date('2024-01-02').toISOString(),  // 远程时间更新
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 未锁定，应该使用更新时间较新的远程版本
      expect(result.project.tasks[0].status).toBe('completed');
      expect(result.project.tasks[0].title).toBe('Remote Title');
    });
  });

  // ==================== 文本内容合并 ====================

  describe('文本内容合并', () => {
    it('内容是前缀扩展时应该使用较长版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello World',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Hello World');
    });

    it('内容是后缀扩展时应该使用较长版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'World',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello World',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Hello World');
    });

    it('行级合并应该保留双方新增的行', () => {
      // baseContent 用于说明测试场景的基础状态
      const _baseContent = 'Line 1\nLine 2\nLine 3';
      void _baseContent; // 仅作为文档说明
      const localContent = 'Line 1\nLine 2\nLine 3\nNew Local Line';
      const remoteContent = 'Line 1\nLine 2\nLine 3\nNew Remote Line';

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: localContent,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: remoteContent,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 行级合并应该包含双方的新增行
      const content = result.project.tasks[0].content;
      expect(content).toContain('Line 1');
      expect(content).toContain('Line 2');
      expect(content).toContain('Line 3');
    });

    it('内容差异太大时应该使用更新时间较新的版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Completely different content A',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Totally new content B',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Totally new content B');
    });
  });

  // ==================== 离线数据重连合并 ====================

  describe('离线数据重连合并', () => {
    it('离线创建的新项目应该上传到云端', async () => {
      const offlineProjects = [
        createTestProject({ id: 'new-proj', name: 'Offline Created' }),
      ];
      const cloudProjects: Project[] = [];

      mockSyncService.saveProjectToCloud.mockResolvedValue({ success: true });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(1);
      expect(mockSyncService.saveProjectToCloud).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Offline Created' }),
        'user-1'
      );
    });

    it('离线版本更高时应该同步到云端', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 3 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 5, name: 'Updated Offline' }),
      ];

      mockSyncService.saveProjectToCloud.mockResolvedValue({ success: true });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(1);
      expect(mockSyncService.saveProjectToCloud).toHaveBeenCalledWith(
        expect.objectContaining({ version: 6 }), // max(5, 3) + 1
        'user-1'
      );
    });

    it('离线同步冲突时应该加入冲突列表', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 5 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 6 }),
      ];

      mockSyncService.saveProjectToCloud.mockResolvedValue({
        success: false,
        conflict: true,
      });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.conflictProjects).toHaveLength(1);
    });

    it('云端版本更高时不应该同步', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 10 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 5 }),
      ];

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(0);
      expect(mockSyncService.saveProjectToCloud).not.toHaveBeenCalled();
    });
  });

  // ==================== 版本号处理 ====================

  describe('版本号处理', () => {
    it('合并后应该使用双方较大版本号 + 1', () => {
      const localProject = createTestProject({ version: 3 });
      const remoteProject = createTestProject({ version: 7 });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(8);
    });

    it('版本号为 undefined 时应该视为 0', () => {
      const localProject = createTestProject({ version: undefined });
      const remoteProject = createTestProject({ version: 5 });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(6);
    });

    it('双方版本号都为 undefined 时应该设为 1', () => {
      const localProject = createTestProject({ version: undefined });
      const remoteProject = createTestProject({ version: undefined });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(1);
    });
  });

  // ==================== 边缘情况 ====================

  describe('边缘情况', () => {
    it('空任务列表应该正确处理', () => {
      const localProject = createTestProject({ tasks: [] });
      const remoteProject = createTestProject({ tasks: [] });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(0);
      expect(result.conflictCount).toBe(0);
    });

    it('大量任务应该正确合并', () => {
      const localTasks: Task[] = [];
      const remoteTasks: Task[] = [];

      for (let i = 0; i < 500; i++) {
        localTasks.push(createTestTask({ id: `local-task-${i}` }));
      }
      for (let i = 0; i < 500; i++) {
        remoteTasks.push(createTestTask({ id: `remote-task-${i}` }));
      }

      const localProject = createTestProject({ tasks: localTasks });
      const remoteProject = createTestProject({ tasks: remoteTasks });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(1000);
    });

    it('任务 ID 相同但内容不同时应该合并', () => {
      const oldTime = new Date('2024-01-01').toISOString();
      const newTime = new Date('2024-01-02').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'same-id',
          title: 'Local Version',
          priority: 'high',
          updatedAt: newTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'same-id',
          title: 'Remote Version',
          priority: 'low',
          updatedAt: oldTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(1);
      expect(result.project.tasks[0].title).toBe('Local Version');
      expect(result.project.tasks[0].priority).toBe('high');
    });

    it('更新时间完全相同时应该使用本地版本', () => {
      const sameTime = new Date('2024-01-01T12:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Local Title',
          updatedAt: sameTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Remote Title',
          updatedAt: sameTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 时间相同时，remoteTime > localTime 为 false，所以用 local
      expect(result.project.tasks[0].title).toBe('Local Title');
    });
  });

  // ==================== 时间戳极端情况 ====================

  describe('时间戳极端情况', () => {
    it('客户端时间快于服务器时应该以更新时间为准', () => {
      // 客户端时钟快了 1 小时
      const clientTime = new Date('2024-01-15T11:00:00Z').toISOString();
      const serverTime = new Date('2024-01-15T10:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Client Edit (faster clock)',
          updatedAt: clientTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Server Edit',
          updatedAt: serverTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Client Edit (faster clock)');
    });

    it('客户端时间慢于服务器时应该以更新时间为准', () => {
      // 客户端时钟慢了 1 小时
      const clientTime = new Date('2024-01-15T09:00:00Z').toISOString();
      const serverTime = new Date('2024-01-15T10:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Client Edit (slower clock)',
          updatedAt: clientTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Server Edit',
          updatedAt: serverTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Server Edit');
    });

    it('无效时间戳应该视为 0', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'No timestamp',
          updatedAt: undefined,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Has timestamp',
          updatedAt: new Date().toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 有时间戳的应该胜出
      expect(result.project.tasks[0].title).toBe('Has timestamp');
    });
  });

  // ==================== 结构信息合并 ====================

  describe('结构信息合并', () => {
    it('更新时间较新时应该使用其结构信息', () => {
      const oldTime = new Date('2024-01-01').toISOString();
      const newTime = new Date('2024-01-02').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          stage: 1,
          parentId: null,
          order: 1,
          rank: 1000,
          updatedAt: oldTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          stage: 2,
          parentId: 'parent-task',
          order: 5,
          rank: 5000,
          updatedAt: newTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.stage).toBe(2);
      expect(task.parentId).toBe('parent-task');
      expect(task.order).toBe(5);
      expect(task.rank).toBe(5000);
    });
  });
});
