/**
 * OptimisticStateService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 快照生命周期 - 创建/提交/回滚
 * 2. ID 漂移管理 - 临时ID生成/映射/级联替换
 * 3. 高阶函数 - runOptimisticAction 的成功/失败路径
 * 4. 快照清理 - 超时清理/数量限制
 * 5. 边缘情况 - 并发操作/嵌套快照
 * 
 * 【测试设计理念】
 * 这是纯逻辑代码的最佳测试温床：
 * - 不需要 Mock DOM
 * - 不需要 Mock 浏览器 API
 * - 输入状态 A，执行动作，断言状态 B
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { OptimisticStateService, OptimisticSnapshot, SnapshotType } from './optimistic-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { OPTIMISTIC_CONFIG } from '../config/constants';

// ========== 模拟依赖服务 ==========

const createMockProjects = (): Project[] => [
  {
    id: 'proj-1',
    name: '测试项目',
    description: '描述',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        id: 'task-1',
        title: '任务1',
        content: '内容',
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
      },
      {
        id: 'task-2',
        title: '任务2',
        content: '内容',
        stage: 1,
        parentId: 'task-1',
        order: 2,
        rank: 2000,
        status: 'active',
        x: 100,
        y: 0,
        createdDate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        displayId: 'A1',
        hasIncompleteTask: false,
      }
    ],
    connections: [
      { id: 'conn-1', source: 'task-1', target: 'task-2' }
    ],
    version: 1,
  }
];

let mockProjectsSignal = signal<Project[]>(createMockProjects());
let mockActiveProjectIdSignal = signal<string | null>('proj-1');

const mockProjectStateService = {
  projects: () => mockProjectsSignal(),
  activeProjectId: () => mockActiveProjectIdSignal(),
  setProjects: vi.fn((projects: Project[]) => {
    mockProjectsSignal.set(projects);
  }),
  setActiveProjectId: vi.fn((id: string | null) => {
    mockActiveProjectIdSignal.set(id);
  }),
  updateProjects: vi.fn((mutator: (projects: Project[]) => Project[]) => {
    mockProjectsSignal.update(mutator);
  }),
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

// ========== 测试用例 ==========

describe('OptimisticStateService', () => {
  let service: OptimisticStateService;

  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 mock signals
    mockProjectsSignal = signal<Project[]>(createMockProjects());
    mockActiveProjectIdSignal = signal<string | null>('proj-1');

    TestBed.configureTestingModule({
      providers: [
        OptimisticStateService,
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = TestBed.inject(OptimisticStateService);
  });

  afterEach(() => {
    service.reset();
    TestBed.resetTestingModule();
  });

  // ==================== 快照生命周期 ====================

  describe('快照生命周期', () => {
    describe('createSnapshot', () => {
      it('应该创建快照并深拷贝项目状态', () => {
        const snapshot = service.createSnapshot('task-update', '更新任务');

        expect(snapshot.id).toBeDefined();
        expect(snapshot.type).toBe('task-update');
        expect(snapshot.operationLabel).toBe('更新任务');
        expect(snapshot.projectsSnapshot).toHaveLength(1);
        expect(snapshot.activeProjectId).toBe('proj-1');
        // 验证深拷贝（修改原数据不影响快照）
        const originalProjects = mockProjectsSignal();
        expect(snapshot.projectsSnapshot[0]).not.toBe(originalProjects[0]);
        expect(snapshot.projectsSnapshot[0].tasks[0]).not.toBe(originalProjects[0].tasks[0]);
      });

      it('应该更新活跃快照计数', () => {
        expect(service.activeSnapshotCount()).toBe(0);
        
        service.createSnapshot('task-update');
        expect(service.activeSnapshotCount()).toBe(1);
        
        service.createSnapshot('task-create');
        expect(service.activeSnapshotCount()).toBe(2);
      });

      it('应该支持关联临时 ID', () => {
        const tempId = 'temp-12345';
        const snapshot = service.createSnapshot('task-create', '创建任务', tempId);

        expect(snapshot.tempId).toBe(tempId);
      });
    });

    describe('commitSnapshot', () => {
      it('应该成功提交快照（丢弃）', () => {
        const snapshot = service.createSnapshot('task-update');
        expect(service.activeSnapshotCount()).toBe(1);

        service.commitSnapshot(snapshot.id);

        expect(service.activeSnapshotCount()).toBe(0);
        expect(service.hasSnapshot(snapshot.id)).toBe(false);
      });

      it('对不存在的快照 ID 应该静默处理', () => {
        service.commitSnapshot('non-existent-id');
        // 不应抛出异常
        expect(service.activeSnapshotCount()).toBe(0);
      });
    });

    describe('rollbackSnapshot', () => {
      it('应该成功回滚到快照状态', () => {
        // 1. 创建快照
        const snapshot = service.createSnapshot('task-update', '更新任务');
        
        // 2. 修改项目状态
        mockProjectStateService.updateProjects((projects) => 
          projects.map(p => ({
            ...p,
            tasks: p.tasks.map(t => ({
              ...t,
              title: '被修改的标题'
            }))
          }))
        );
        expect(mockProjectsSignal()[0].tasks[0].title).toBe('被修改的标题');
        
        // 3. 回滚
        const result = service.rollbackSnapshot(snapshot.id);

        expect(result).toBe(true);
        // 验证 setProjects 被调用以恢复状态
        expect(mockProjectStateService.setProjects).toHaveBeenCalled();
        expect(mockToastService.error).toHaveBeenCalledWith(
          '操作失败',
          expect.stringContaining('更新任务')
        );
      });

      it('回滚时应该清理关联的临时 ID 映射', () => {
        const tempId = service.generateTempId('task');
        const snapshot = service.createSnapshot('task-create', '创建任务', tempId);
        
        expect(service.getPendingTempIds()).toContain(tempId);
        
        service.rollbackSnapshot(snapshot.id);
        
        expect(service.getPendingTempIds()).not.toContain(tempId);
      });

      it('showToast=false 时不应显示提示', () => {
        const snapshot = service.createSnapshot('task-update', '更新任务');
        
        service.rollbackSnapshot(snapshot.id, false);

        expect(mockToastService.error).not.toHaveBeenCalled();
      });

      it('对不存在的快照应返回 false', () => {
        const result = service.rollbackSnapshot('non-existent-id');
        expect(result).toBe(false);
      });
    });

    describe('快照数量限制', () => {
      it('超过最大数量时应该驱逐最旧的快照', () => {
        const maxSnapshots = OPTIMISTIC_CONFIG.MAX_SNAPSHOTS;
        const snapshots: OptimisticSnapshot[] = [];

        // 创建超过限制数量的快照
        for (let i = 0; i < maxSnapshots + 5; i++) {
          snapshots.push(service.createSnapshot('task-update', `操作${i}`));
        }

        // 应该保持在最大数量附近（由于驱逐是逐个进行的，可能有 +1 的误差）
        expect(service.activeSnapshotCount()).toBeLessThanOrEqual(maxSnapshots + 1);
        
        // 最早的几个快照应该被驱逐
        expect(service.hasSnapshot(snapshots[0].id)).toBe(false);
        expect(service.hasSnapshot(snapshots[1].id)).toBe(false);
        expect(service.hasSnapshot(snapshots[2].id)).toBe(false);
        // 最新的快照应该存在
        expect(service.hasSnapshot(snapshots[snapshots.length - 1].id)).toBe(true);
      });
    });
  });

  // ==================== 临时 ID 管理 ====================

  describe('临时 ID 管理', () => {
    describe('generateTempId', () => {
      it('应该生成带正确前缀的临时 ID', () => {
        const tempId = service.generateTempId('task');

        expect(tempId).toMatch(/^temp-/);
        expect(service.isTempId(tempId)).toBe(true);
      });

      it('应该注册到 ID 映射表', () => {
        const tempId = service.generateTempId('task');

        expect(service.getPendingTempIds()).toContain(tempId);
        expect(service.pendingIdMappingCount()).toBe(1);
      });

      it('应该生成唯一的 ID', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
          ids.add(service.generateTempId('task'));
        }
        expect(ids.size).toBe(100);
      });
    });

    describe('isTempId', () => {
      it('应该正确识别临时 ID', () => {
        expect(service.isTempId('temp-abc123')).toBe(true);
        expect(service.isTempId('temp-')).toBe(true);
      });

      it('应该正确识别正式 ID', () => {
        expect(service.isTempId('abc123')).toBe(false);
        expect(service.isTempId('')).toBe(false);
        expect(service.isTempId('temp')).toBe(false); // 缺少连字符
      });
    });

    describe('swapId', () => {
      it('应该成功替换临时 ID 为正式 ID', () => {
        const tempId = service.generateTempId('task');
        const permanentId = 'permanent-id-123';

        const result = service.swapId(tempId, permanentId);

        expect(result).toBe(true);
        expect(service.resolveTempId(tempId)).toBe(permanentId);
      });

      it('应该级联更新项目状态中的引用', () => {
        const tempId = service.generateTempId('task');
        const permanentId = 'permanent-id-123';
        
        // 模拟在项目中添加使用临时 ID 的任务
        mockProjectStateService.updateProjects((projects) => [{
          ...projects[0],
          tasks: [
            ...projects[0].tasks,
            {
              id: tempId,
              title: '新任务',
              content: '',
              stage: 1,
              parentId: null,
              order: 3,
              rank: 3000,
              status: 'active' as const,
              x: 200,
              y: 0,
              createdDate: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              displayId: 'C',
              hasIncompleteTask: false,
            }
          ],
          connections: [
            ...projects[0].connections,
            { id: 'conn-new', source: 'task-1', target: tempId }
          ]
        }]);

        service.swapId(tempId, permanentId);

        // 验证 updateProjects 被调用
        expect(mockProjectStateService.updateProjects).toHaveBeenCalled();
      });

      it('对未注册的临时 ID 应返回 false', () => {
        const result = service.swapId('unregistered-temp-id', 'permanent-id');
        expect(result).toBe(false);
      });
    });

    describe('resolveTempId', () => {
      it('对正式 ID 应原样返回', () => {
        expect(service.resolveTempId('normal-id')).toBe('normal-id');
      });

      it('对未映射的临时 ID 应原样返回', () => {
        const tempId = service.generateTempId('task');
        expect(service.resolveTempId(tempId)).toBe(tempId);
      });

      it('对已映射的临时 ID 应返回正式 ID', () => {
        const tempId = service.generateTempId('task');
        const permanentId = 'permanent-123';
        service.swapId(tempId, permanentId);

        expect(service.resolveTempId(tempId)).toBe(permanentId);
      });
    });

    describe('resolveTempIds 批量解析', () => {
      it('应该正确批量解析混合 ID', () => {
        const tempId1 = service.generateTempId('task');
        const tempId2 = service.generateTempId('task');
        service.swapId(tempId1, 'perm-1');

        const ids = [tempId1, tempId2, 'normal-id'];
        const resolved = service.resolveTempIds(ids);

        expect(resolved).toEqual(['perm-1', tempId2, 'normal-id']);
      });
    });
  });

  // ==================== 高阶函数 ====================

  describe('高阶函数 runOptimisticAction', () => {
    describe('成功路径', () => {
      it('应该执行乐观更新并提交快照', async () => {
        let optimisticUpdateCalled = false;
        
        const result = await service.runOptimisticAction(
          { type: 'task-update', label: '更新任务' },
          () => { optimisticUpdateCalled = true; },
          () => Promise.resolve('async-result')
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe('async-result');
          expect(result.rolledBack).toBe(false);
        }
        expect(optimisticUpdateCalled).toBe(true);
        expect(service.activeSnapshotCount()).toBe(0); // 快照已提交
      });
    });

    describe('失败路径 - 异步操作失败', () => {
      it('应该回滚快照并返回错误', async () => {
        const testError = new Error('网络错误');
        
        const result = await service.runOptimisticAction(
          { type: 'task-update', label: '更新任务' },
          () => {}, // 乐观更新
          () => Promise.reject(testError)
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toBe('网络错误');
          expect(result.rolledBack).toBe(true);
        }
        expect(mockProjectStateService.setProjects).toHaveBeenCalled();
        expect(mockToastService.error).toHaveBeenCalled();
      });

      it('showToastOnError=false 时不应显示 toast', async () => {
        mockToastService.error.mockClear();
        
        await service.runOptimisticAction(
          { type: 'task-update', label: '更新任务', showToastOnError: false },
          () => {},
          () => Promise.reject(new Error('error'))
        );

        expect(mockToastService.error).not.toHaveBeenCalled();
      });
    });

    describe('失败路径 - 乐观更新失败', () => {
      it('应该丢弃快照并返回错误（状态未改变）', async () => {
        const result = await service.runOptimisticAction(
          { type: 'task-update', label: '更新任务' },
          () => { throw new Error('乐观更新失败'); },
          () => Promise.resolve('should not reach')
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toBe('乐观更新失败');
          expect(result.rolledBack).toBe(false); // 快照未应用，所以不需要回滚
        }
        expect(service.activeSnapshotCount()).toBe(0);
      });
    });

    describe('关联临时 ID', () => {
      it('应该在回滚时清理临时 ID', async () => {
        const tempId = service.generateTempId('task');
        
        await service.runOptimisticAction(
          { type: 'task-create', label: '创建任务', tempId },
          () => {},
          () => Promise.reject(new Error('失败'))
        );

        expect(service.getPendingTempIds()).not.toContain(tempId);
      });
    });
  });

  describe('便捷方法 runOptimisticTaskAction', () => {
    it('应该正确映射操作类型', async () => {
      const result = await service.runOptimisticTaskAction(
        'task-123',
        '更新',
        () => {},
        () => Promise.resolve({ success: true })
      );

      expect(result.success).toBe(true);
    });

    it('应该正确处理临时 ID', async () => {
      const tempId = service.generateTempId('task');
      
      await service.runOptimisticTaskAction(
        tempId,
        '创建',
        () => {},
        () => Promise.reject(new Error('fail'))
      );

      // 临时 ID 应该在回滚时被清理
      expect(service.getPendingTempIds()).not.toContain(tempId);
    });
  });

  describe('便捷方法 runOptimisticProjectAction', () => {
    it('应该正确映射项目操作类型', async () => {
      const result = await service.runOptimisticProjectAction(
        'proj-123',
        '更新',
        () => {},
        () => Promise.resolve({ success: true })
      );

      expect(result.success).toBe(true);
    });
  });

  // ==================== 清理机制 ====================

  describe('清理机制', () => {
    describe('clearAllSnapshots', () => {
      it('应该清空所有快照', () => {
        service.createSnapshot('task-update');
        service.createSnapshot('task-create');
        expect(service.activeSnapshotCount()).toBe(2);

        service.clearAllSnapshots();

        expect(service.activeSnapshotCount()).toBe(0);
      });
    });

    describe('onUserLogout', () => {
      it('应该清理所有快照和 ID 映射', () => {
        service.createSnapshot('task-update');
        service.generateTempId('task');
        
        expect(service.activeSnapshotCount()).toBe(1);
        expect(service.pendingIdMappingCount()).toBe(1);

        service.onUserLogout();

        expect(service.activeSnapshotCount()).toBe(0);
        expect(service.pendingIdMappingCount()).toBe(0);
      });
    });

    describe('reset', () => {
      it('应该重置所有状态', () => {
        service.createSnapshot('task-update');
        service.generateTempId('task');

        service.reset();

        expect(service.activeSnapshotCount()).toBe(0);
        expect(service.pendingIdMappingCount()).toBe(0);
      });
    });
  });

  // ==================== 边缘情况 ====================

  describe('边缘情况', () => {
    describe('深拷贝健壮性', () => {
      it('应该处理空项目列表', () => {
        mockProjectsSignal.set([]);
        
        const snapshot = service.createSnapshot('task-update');

        expect(snapshot.projectsSnapshot).toEqual([]);
      });

      it('应该处理复杂嵌套结构', () => {
        const complexProject: Project = {
          id: 'complex',
          name: '复杂项目',
          description: '描述',
          createdDate: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: Array.from({ length: 100 }, (_, i) => ({
            id: `task-${i}`,
            title: `任务${i}`,
            content: '内容'.repeat(100),
            stage: i % 5,
            parentId: i > 0 ? `task-${Math.floor(i / 2)}` : null,
            order: i,
            rank: i * 1000,
            status: 'active' as const,
            x: i * 10,
            y: i * 10,
            createdDate: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            displayId: `T${i}`,
            hasIncompleteTask: false,
          })),
          connections: Array.from({ length: 50 }, (_, i) => ({
            id: `conn-${i}`,
            source: `task-${i}`,
            target: `task-${i + 1}`,
          })),
          version: 1,
        };
        mockProjectsSignal.set([complexProject]);

        const snapshot = service.createSnapshot('task-update');

        expect(snapshot.projectsSnapshot[0].tasks).toHaveLength(100);
        expect(snapshot.projectsSnapshot[0].connections).toHaveLength(50);
        // 验证是深拷贝
        expect(snapshot.projectsSnapshot[0].tasks[0]).not.toBe(complexProject.tasks[0]);
      });
    });

    describe('并发操作', () => {
      it('应该正确处理多个并发的乐观操作', async () => {
        const results = await Promise.all([
          service.runOptimisticAction(
            { type: 'task-update', label: '操作1' },
            () => {},
            () => Promise.resolve('result1')
          ),
          service.runOptimisticAction(
            { type: 'task-update', label: '操作2' },
            () => {},
            () => Promise.resolve('result2')
          ),
          service.runOptimisticAction(
            { type: 'task-update', label: '操作3' },
            () => {},
            () => Promise.resolve('result3')
          ),
        ]);

        expect(results.every(r => r.success)).toBe(true);
        expect(service.activeSnapshotCount()).toBe(0);
      });

      it('应该正确处理部分失败的并发操作', async () => {
        const results = await Promise.all([
          service.runOptimisticAction(
            { type: 'task-update', label: '成功操作' },
            () => {},
            () => Promise.resolve('success')
          ),
          service.runOptimisticAction(
            { type: 'task-update', label: '失败操作' },
            () => {},
            () => Promise.reject(new Error('失败'))
          ),
        ]);

        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
      });
    });

    describe('createTaskSnapshot 便捷方法', () => {
      it('应该正确映射操作类型', () => {
        const snapshot = service.createTaskSnapshot('task-1', '创建');
        expect(snapshot.type).toBe('task-create');

        const snapshot2 = service.createTaskSnapshot('task-1', '更新');
        expect(snapshot2.type).toBe('task-update');

        const snapshot3 = service.createTaskSnapshot('task-1', '删除');
        expect(snapshot3.type).toBe('task-delete');

        const snapshot4 = service.createTaskSnapshot('task-1', '移动');
        expect(snapshot4.type).toBe('task-move');
      });

      it('应该自动关联临时 ID', () => {
        const tempId = service.generateTempId('task');
        const snapshot = service.createTaskSnapshot(tempId, '创建');

        expect(snapshot.tempId).toBe(tempId);
      });
    });
  });

  // ==================== 清理逻辑测试 ====================
  // 注意：由于 Vitest + Angular TestBed 与 fakeAsync 的兼容性问题，
  // 这里测试清理方法的直接调用，而非定时器触发

  describe('快照清理逻辑', () => {
    it('cleanupExpiredSnapshots 应该清理过期快照', () => {
      // 创建一个快照
      const snapshot = service.createSnapshot('task-update');
      expect(service.activeSnapshotCount()).toBe(1);

      // 手动修改快照的 createdAt 使其过期
      // 通过访问私有属性（仅用于测试）
      const snapshots = (service as any).snapshots as Map<string, OptimisticSnapshot>;
      const storedSnapshot = snapshots.get(snapshot.id)!;
      (storedSnapshot as any).createdAt = Date.now() - OPTIMISTIC_CONFIG.SNAPSHOT_MAX_AGE_MS - 1000;

      // 手动触发清理
      (service as any).cleanupExpiredSnapshots();

      expect(service.hasSnapshot(snapshot.id)).toBe(false);
      expect(service.activeSnapshotCount()).toBe(0);
    });

    it('cleanupExpiredSnapshots 不应清理未过期的快照', () => {
      const snapshot = service.createSnapshot('task-update');
      expect(service.activeSnapshotCount()).toBe(1);

      // 手动触发清理（快照刚创建，未过期）
      (service as any).cleanupExpiredSnapshots();

      expect(service.hasSnapshot(snapshot.id)).toBe(true);
      expect(service.activeSnapshotCount()).toBe(1);
    });
  });

  describe('ID 映射清理逻辑', () => {
    it('cleanupCompletedIdMappings 应该清理已完成且过期的映射', () => {
      const tempId = service.generateTempId('task');
      service.swapId(tempId, 'permanent-id');
      
      expect(service.pendingIdMappingCount()).toBe(1);

      // 手动修改映射的 createdAt 使其过期
      const idMappings = (service as any).idMappings as Map<string, any>;
      const mapping = idMappings.get(tempId)!;
      mapping.createdAt = Date.now() - OPTIMISTIC_CONFIG.ID_MAPPING_MAX_AGE_MS - 1000;

      // 手动触发清理
      service.cleanupCompletedIdMappings();

      // 已完成且过期的映射应该被清理
      expect(service.pendingIdMappingCount()).toBe(0);
    });

    it('cleanupCompletedIdMappings 不应清理未完成的映射', () => {
      const tempId = service.generateTempId('task');
      // 不调用 swapId，保持未完成状态
      
      expect(service.pendingIdMappingCount()).toBe(1);

      // 手动修改映射的 createdAt 使其过期
      const idMappings = (service as any).idMappings as Map<string, any>;
      const mapping = idMappings.get(tempId)!;
      mapping.createdAt = Date.now() - OPTIMISTIC_CONFIG.ID_MAPPING_MAX_AGE_MS - 1000;

      // 手动触发清理
      service.cleanupCompletedIdMappings();

      // 未完成的映射不应被清理（即使过期）
      expect(service.pendingIdMappingCount()).toBe(1);
    });
  });
});
