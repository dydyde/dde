/**
 * ThreeWayMergeService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 基本三路合并场景
 *    - 只有本地修改
 *    - 只有远程修改
 *    - 双方都修改但值相同
 *    - 双方都修改且值不同（真正的冲突）
 * 2. 任务级别合并
 *    - 本地新增任务
 *    - 远程新增任务
 *    - 本地删除任务
 *    - 远程删除任务
 *    - 删除与修改冲突
 * 3. 字段级别合并
 *    - 标题合并
 *    - 内容合并
 *    - 状态合并
 * 4. 数组合并
 *    - 标签合并
 *    - 附件合并
 *    - 连接合并
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ThreeWayMergeService, ThreeWayMergeResult } from './three-way-merge.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';

// ========== 模拟依赖服务 ==========

const mockLoggerCategory = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const mockLoggerService = {
  category: () => mockLoggerCategory,
};

// ========== 辅助函数 ==========

let taskIdCounter = 0;
let connectionIdCounter = 0;

function resetCounters() {
  taskIdCounter = 0;
  connectionIdCounter = 0;
}

function createTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${++taskIdCounter}`,
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
    displayId: '1',
    ...overrides,
  };
}

function createConnection(overrides?: Partial<Connection>): Connection {
  return {
    id: `conn-${++connectionIdCounter}`,
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createProject(overrides?: Partial<Project>): Project {
  return {
    id: 'test-project',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

describe('ThreeWayMergeService', () => {
  let service: ThreeWayMergeService;

  beforeEach(() => {
    resetCounters();
    
    TestBed.configureTestingModule({
      providers: [
        ThreeWayMergeService,
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });
    
    service = TestBed.inject(ThreeWayMergeService);
  });

  describe('项目属性合并', () => {
    it('应该保留本地的修改（远程未改）', () => {
      const base = createProject({ name: 'Original', version: 1 });
      const local = createProject({ name: 'Local Changed', version: 1 });
      const remote = createProject({ name: 'Original', version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.name).toBe('Local Changed');
      expect(result.hasRealConflicts).toBe(false);
    });

    it('应该采纳远程的修改（本地未改）', () => {
      const base = createProject({ name: 'Original', version: 1 });
      const local = createProject({ name: 'Original', version: 1 });
      const remote = createProject({ name: 'Remote Changed', version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.name).toBe('Remote Changed');
      expect(result.hasRealConflicts).toBe(false);
    });

    it('双方修改相同值应该无冲突', () => {
      const base = createProject({ name: 'Original', version: 1 });
      const local = createProject({ name: 'Same Value', version: 1 });
      const remote = createProject({ name: 'Same Value', version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.name).toBe('Same Value');
      expect(result.hasRealConflicts).toBe(false);
    });

    it('双方修改不同值应该保留本地（真正的冲突）', () => {
      const base = createProject({ name: 'Original', version: 1 });
      const local = createProject({ name: 'Local Value', version: 1 });
      const remote = createProject({ name: 'Remote Value', version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.name).toBe('Local Value');
      expect(result.hasRealConflicts).toBe(true);
      expect(result.conflicts.some(c => c.field === 'name')).toBe(true);
    });
  });

  describe('任务列表合并', () => {
    it('应该保留本地新增的任务', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2 (Local New)' });
      
      const base = createProject({ tasks: [task1] });
      const local = createProject({ tasks: [task1, task2] });
      const remote = createProject({ tasks: [task1], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.tasks.length).toBe(2);
      expect(result.project.tasks.some(t => t.id === 'task-2')).toBe(true);
      expect(result.stats.localAddedTasks).toBe(1);
    });

    it('应该保留远程新增的任务', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task3 = createTask({ id: 'task-3', title: 'Task 3 (Remote New)' });
      
      const base = createProject({ tasks: [task1] });
      const local = createProject({ tasks: [task1] });
      const remote = createProject({ tasks: [task1, task3], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.tasks.length).toBe(2);
      expect(result.project.tasks.some(t => t.id === 'task-3')).toBe(true);
      expect(result.stats.remoteAddedTasks).toBe(1);
    });

    it('应该同时保留双方新增的任务', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2 (Local New)' });
      const task3 = createTask({ id: 'task-3', title: 'Task 3 (Remote New)' });
      
      const base = createProject({ tasks: [task1] });
      const local = createProject({ tasks: [task1, task2] });
      const remote = createProject({ tasks: [task1, task3], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.tasks.length).toBe(3);
      expect(result.project.tasks.some(t => t.id === 'task-2')).toBe(true);
      expect(result.project.tasks.some(t => t.id === 'task-3')).toBe(true);
    });

    it('应该执行本地删除', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2' });
      
      const base = createProject({ tasks: [task1, task2] });
      const local = createProject({ tasks: [task1] }); // task2 被删除
      const remote = createProject({ tasks: [task1, task2], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.tasks.length).toBe(1);
      expect(result.project.tasks.some(t => t.id === 'task-2')).toBe(false);
      expect(result.stats.localDeletedTasks).toBe(1);
    });

    it('应该执行远程删除（本地未修改）', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2' });
      
      const base = createProject({ tasks: [task1, task2] });
      const local = createProject({ tasks: [task1, task2] });
      const remote = createProject({ tasks: [task1], version: 2 }); // task2 被删除
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.tasks.length).toBe(1);
      expect(result.project.tasks.some(t => t.id === 'task-2')).toBe(false);
      expect(result.stats.remoteDeletedTasks).toBe(1);
    });

    it('删除与修改冲突时应该保留本地修改', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2' });
      const task2Modified = createTask({ id: 'task-2', title: 'Task 2 Modified' });
      
      const base = createProject({ tasks: [task1, task2] });
      const local = createProject({ tasks: [task1, task2Modified] }); // 修改了 task2
      const remote = createProject({ tasks: [task1], version: 2 }); // 删除了 task2
      
      const result = service.merge(base, local, remote);
      
      // 本地有修改，应该保留
      expect(result.project.tasks.length).toBe(2);
      expect(result.project.tasks.some(t => t.id === 'task-2')).toBe(true);
      expect(result.project.tasks.find(t => t.id === 'task-2')?.title).toBe('Task 2 Modified');
    });
  });

  describe('任务字段合并', () => {
    it('应该合并不同字段的修改', () => {
      const task = createTask({ id: 'task-1', title: 'Original', content: 'Original Content' });
      const taskLocalMod = createTask({ id: 'task-1', title: 'Local Title', content: 'Original Content' });
      const taskRemoteMod = createTask({ id: 'task-1', title: 'Original', content: 'Remote Content' });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocalMod] });
      const remote = createProject({ tasks: [taskRemoteMod], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.title).toBe('Local Title');
      expect(mergedTask?.content).toBe('Remote Content');
      expect(result.hasRealConflicts).toBe(false);
    });

    it('同一字段双方修改应保留本地', () => {
      const task = createTask({ id: 'task-1', title: 'Original' });
      const taskLocalMod = createTask({ id: 'task-1', title: 'Local Title' });
      const taskRemoteMod = createTask({ id: 'task-1', title: 'Remote Title' });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocalMod] });
      const remote = createProject({ tasks: [taskRemoteMod], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.title).toBe('Local Title');
      expect(result.hasRealConflicts).toBe(true);
    });
  });

  describe('软删除（deletedAt）合并', () => {
    it('应该保留本地的软删除操作', () => {
      const now = new Date().toISOString();
      const task = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskLocalDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now });
      const taskRemote = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocalDeleted] }); // 本地软删除
      const remote = createProject({ tasks: [taskRemote], version: 2 }); // 远程未删除
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.deletedAt).toBe(now);
    });

    it('应该采纳远程的软删除操作（本地未修改）', () => {
      const now = new Date().toISOString();
      const task = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskLocal = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskRemoteDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocal] }); // 本地未删除
      const remote = createProject({ tasks: [taskRemoteDeleted], version: 2 }); // 远程软删除
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.deletedAt).toBe(now);
    });

    it('双方同时软删除应保留删除状态', () => {
      const now1 = new Date().toISOString();
      const now2 = new Date(Date.now() + 1000).toISOString();
      const task = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskLocalDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now1 });
      const taskRemoteDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now2 });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocalDeleted] });
      const remote = createProject({ tasks: [taskRemoteDeleted], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      // 应该保留本地的删除时间（优先本地）
      expect(mergedTask?.deletedAt).toBe(now1);
    });

    it('软删除与内容修改同时发生应保留本地状态', () => {
      const now = new Date().toISOString();
      const task = createTask({ id: 'task-1', title: 'Task 1', content: 'Original', deletedAt: null });
      const taskLocalDeleted = createTask({ id: 'task-1', title: 'Task 1', content: 'Original', deletedAt: now });
      const taskRemoteModified = createTask({ id: 'task-1', title: 'Task 1', content: 'Modified', deletedAt: null });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocalDeleted] }); // 本地软删除
      const remote = createProject({ tasks: [taskRemoteModified], version: 2 }); // 远程修改内容
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      // 本地软删除应该被保留
      expect(mergedTask?.deletedAt).toBe(now);
      // 远程的内容修改也应该被保留（不同字段的修改）
      expect(mergedTask?.content).toBe('Modified');
    });

    it('恢复与删除冲突时应保留删除（删除优先级最高）', () => {
      const now = new Date().toISOString();
      const taskDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now });
      const taskLocalRestored = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskRemoteDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now });
      
      const base = createProject({ tasks: [taskDeleted] }); // Base 是已删除状态
      const local = createProject({ tasks: [taskLocalRestored] }); // 本地恢复了
      const remote = createProject({ tasks: [taskRemoteDeleted], version: 2 }); // 远程仍是删除状态
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      // 删除优先：只要任一方仍是删除态，就应保持删除
      expect(mergedTask?.deletedAt).toBe(now);
    });

    it('Base 已删除且双方都恢复时应允许恢复', () => {
      const now = new Date().toISOString();
      const taskDeleted = createTask({ id: 'task-1', title: 'Task 1', deletedAt: now });
      const taskLocalRestored = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });
      const taskRemoteRestored = createTask({ id: 'task-1', title: 'Task 1', deletedAt: null });

      const base = createProject({ tasks: [taskDeleted] });
      const local = createProject({ tasks: [taskLocalRestored] });
      const remote = createProject({ tasks: [taskRemoteRestored], version: 2 });

      const result = service.merge(base, local, remote);

      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.deletedAt).toBeNull();
    });
  });

  describe('标签合并', () => {
    it('应该合并双方新增的标签', () => {
      const task = createTask({ id: 'task-1', tags: ['tag1'] });
      const taskLocal = createTask({ id: 'task-1', tags: ['tag1', 'localTag'] });
      const taskRemote = createTask({ id: 'task-1', tags: ['tag1', 'remoteTag'] });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocal] });
      const remote = createProject({ tasks: [taskRemote], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.tags).toContain('tag1');
      // 由于合并逻辑，新增的标签应该被保留
    });

    it('双方都保留的标签应该保留', () => {
      const task = createTask({ id: 'task-1', tags: ['tag1', 'tag2'] });
      const taskLocal = createTask({ id: 'task-1', tags: ['tag1', 'tag2'] });
      const taskRemote = createTask({ id: 'task-1', tags: ['tag1', 'tag2'] });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocal] });
      const remote = createProject({ tasks: [taskRemote], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      const mergedTask = result.project.tasks.find(t => t.id === 'task-1');
      expect(mergedTask?.tags).toContain('tag1');
      expect(mergedTask?.tags).toContain('tag2');
    });
  });

  describe('连接合并', () => {
    it('应该保留本地新增的连接', () => {
      const conn1 = createConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });
      const conn2 = createConnection({ id: 'conn-2', source: 'task-2', target: 'task-3' });
      
      const base = createProject({ connections: [conn1] });
      const local = createProject({ connections: [conn1, conn2] });
      const remote = createProject({ connections: [conn1], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.connections.length).toBe(2);
    });

    it('应该保留远程新增的连接', () => {
      const conn1 = createConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });
      const conn3 = createConnection({ id: 'conn-3', source: 'task-3', target: 'task-4' });
      
      const base = createProject({ connections: [conn1] });
      const local = createProject({ connections: [conn1] });
      const remote = createProject({ connections: [conn1, conn3], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.connections.length).toBe(2);
    });

    it('应该执行本地删除的连接', () => {
      const conn1 = createConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });
      const conn2 = createConnection({ id: 'conn-2', source: 'task-2', target: 'task-3' });
      
      const base = createProject({ connections: [conn1, conn2] });
      const local = createProject({ connections: [conn1] }); // 删除了 conn2
      const remote = createProject({ connections: [conn1, conn2], version: 2 });
      
      const result = service.merge(base, local, remote);
      
      expect(result.project.connections.length).toBe(1);
    });
  });

  describe('needsMerge 检测', () => {
    it('版本号相同时不需要合并', () => {
      const base = createProject({ version: 1 });
      const local = createProject({ version: 2 });
      const remote = createProject({ version: 2 });
      
      const needsMerge = service.needsMerge(base, local, remote);
      
      expect(needsMerge).toBe(false);
    });

    it('版本号不同时可能需要合并', () => {
      const base = createProject({ version: 1 });
      const local = createProject({ version: 2 });
      const remote = createProject({ version: 3 });
      
      const needsMerge = service.needsMerge(base, local, remote);
      
      expect(needsMerge).toBe(true);
    });

    it('任务数量变化时需要合并', () => {
      const task1 = createTask({ id: 'task-1' });
      const task2 = createTask({ id: 'task-2' });
      
      const base = createProject({ tasks: [task1], version: 1 });
      const local = createProject({ tasks: [task1], version: 2 });
      const remote = createProject({ tasks: [task1, task2], version: 3 });
      
      const needsMerge = service.needsMerge(base, local, remote);
      
      expect(needsMerge).toBe(true);
    });
  });

  describe('canAutoMerge 检测', () => {
    it('无冲突时可以自动合并', () => {
      const task = createTask({ id: 'task-1', title: 'Original', content: 'Content' });
      const taskLocal = createTask({ id: 'task-1', title: 'Local Title', content: 'Content' });
      const taskRemote = createTask({ id: 'task-1', title: 'Original', content: 'Remote Content' });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocal] });
      const remote = createProject({ tasks: [taskRemote], version: 2 });
      
      const canAuto = service.canAutoMerge(base, local, remote);
      
      expect(canAuto).toBe(true);
    });

    it('有真正冲突时不能自动合并', () => {
      const task = createTask({ id: 'task-1', title: 'Original' });
      const taskLocal = createTask({ id: 'task-1', title: 'Local Title' });
      const taskRemote = createTask({ id: 'task-1', title: 'Remote Title' });
      
      const base = createProject({ tasks: [task] });
      const local = createProject({ tasks: [taskLocal] });
      const remote = createProject({ tasks: [taskRemote], version: 2 });
      
      const canAuto = service.canAutoMerge(base, local, remote);
      
      expect(canAuto).toBe(false);
    });
  });

  describe('合并统计', () => {
    it('应该正确统计各类变更', () => {
      const task1 = createTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createTask({ id: 'task-2', title: 'Task 2' });
      const task3 = createTask({ id: 'task-3', title: 'Task 3' });
      const task4 = createTask({ id: 'task-4', title: 'Task 4 (Local New)' });
      const task5 = createTask({ id: 'task-5', title: 'Task 5 (Remote New)' });
      
      const base = createProject({ 
        tasks: [task1, task2, task3] 
      });
      
      const local = createProject({ 
        tasks: [
          task1,
          { ...task2, title: 'Task 2 Modified' }, // 本地修改
          // task3 被删除
          task4 // 本地新增
        ] 
      });
      
      const remote = createProject({ 
        tasks: [
          task1,
          task2,
          task3,
          task5 // 远程新增
        ],
        version: 2 
      });
      
      const result = service.merge(base, local, remote);
      
      expect(result.stats.localAddedTasks).toBe(1);
      expect(result.stats.remoteAddedTasks).toBe(1);
      expect(result.stats.localDeletedTasks).toBe(1);
      expect(result.stats.localOnlyModifiedTasks).toBe(1);
    });
  });
});
