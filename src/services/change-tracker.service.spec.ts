import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChangeTrackerService } from './change-tracker.service';
import { Task, Connection } from '../models';

describe('ChangeTrackerService', () => {
  let service: ChangeTrackerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ChangeTrackerService]
    });
    service = TestBed.inject(ChangeTrackerService);
  });

  describe('任务变更追踪', () => {
    const mockTask: Task = {
      id: 'task-1',
      title: 'Test Task',
      content: 'Test Content',
      parentId: null,
      stage: 1,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      hasIncompleteTask: false,
      createdDate: new Date().toISOString()
    };

    it('应该追踪任务创建', () => {
      service.trackTaskCreate('project-1', mockTask);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToCreate).toHaveLength(1);
      expect(changes.tasksToCreate[0].id).toBe('task-1');
      expect(changes.hasChanges).toBe(true);
    });

    it('应该追踪任务更新', () => {
      service.trackTaskUpdate('project-1', mockTask, ['title', 'content']);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      expect(changes.tasksToUpdate[0].id).toBe('task-1');
    });

    it('应该追踪任务删除', () => {
      service.trackTaskDelete('project-1', 'task-1');

      const changes = service.getProjectChanges('project-1');
      expect(changes.taskIdsToDelete).toHaveLength(1);
      expect(changes.taskIdsToDelete[0]).toBe('task-1');
    });

    it('创建后删除应该抵消', () => {
      service.trackTaskCreate('project-1', mockTask);
      service.trackTaskDelete('project-1', 'task-1');

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToCreate).toHaveLength(0);
      expect(changes.taskIdsToDelete).toHaveLength(0);
      expect(changes.hasChanges).toBe(false);
    });

    it('删除后创建应该变为更新', () => {
      service.trackTaskDelete('project-1', 'task-1');
      service.trackTaskCreate('project-1', mockTask);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      expect(changes.taskIdsToDelete).toHaveLength(0);
    });

    it('多次更新应该合并字段', () => {
      service.trackTaskUpdate('project-1', mockTask, ['title']);
      service.trackTaskUpdate('project-1', { ...mockTask, content: 'Updated' }, ['content']);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      // 验证最终数据是最新的
      expect(changes.tasksToUpdate[0].content).toBe('Updated');
    });
  });

  describe('连接变更追踪', () => {
    const mockConnection: Connection = {
      id: 'conn-1',
      source: 'task-1',
      target: 'task-2',
      description: 'Test connection'
    };

    it('应该追踪连接创建', () => {
      service.trackConnectionCreate('project-1', mockConnection);

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToCreate).toHaveLength(1);
      expect(changes.connectionsToCreate[0].source).toBe('task-1');
      expect(changes.connectionsToCreate[0].target).toBe('task-2');
    });

    it('应该追踪连接删除', () => {
      service.trackConnectionDelete('project-1', 'task-1', 'task-2');

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToDelete).toHaveLength(1);
      expect(changes.connectionsToDelete[0]).toEqual({ source: 'task-1', target: 'task-2' });
    });

    it('创建后删除应该抵消', () => {
      service.trackConnectionCreate('project-1', mockConnection);
      service.trackConnectionDelete('project-1', 'task-1', 'task-2');

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToCreate).toHaveLength(0);
      expect(changes.connectionsToDelete).toHaveLength(0);
      expect(changes.hasChanges).toBe(false);
    });
  });

  describe('项目级操作', () => {
    it('应该按项目隔离变更', () => {
      const task1: Task = { ...createMockTask(), id: 'task-1' };
      const task2: Task = { ...createMockTask(), id: 'task-2' };

      service.trackTaskCreate('project-1', task1);
      service.trackTaskCreate('project-2', task2);

      const changes1 = service.getProjectChanges('project-1');
      const changes2 = service.getProjectChanges('project-2');

      expect(changes1.tasksToCreate).toHaveLength(1);
      expect(changes1.tasksToCreate[0].id).toBe('task-1');
      expect(changes2.tasksToCreate).toHaveLength(1);
      expect(changes2.tasksToCreate[0].id).toBe('task-2');
    });

    it('应该正确清除项目变更', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskCreate('project-2', { ...createMockTask(), id: 'task-2' });

      service.clearProjectChanges('project-1');

      expect(service.hasProjectChanges('project-1')).toBe(false);
      expect(service.hasProjectChanges('project-2')).toBe(true);
    });

    it('应该返回所有有变更的项目ID', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskCreate('project-2', { ...createMockTask(), id: 'task-2' });
      service.trackTaskCreate('project-3', { ...createMockTask(), id: 'task-3' });

      const projectIds = service.getChangedProjectIds();
      expect(projectIds).toHaveLength(3);
      expect(projectIds).toContain('project-1');
      expect(projectIds).toContain('project-2');
      expect(projectIds).toContain('project-3');
    });
  });

  describe('统计和信号', () => {
    it('应该正确更新待同步变更数量', () => {
      expect(service.pendingChangeCount()).toBe(0);

      service.trackTaskCreate('project-1', createMockTask());
      expect(service.pendingChangeCount()).toBe(1);

      service.trackTaskCreate('project-1', { ...createMockTask(), id: 'task-2' });
      expect(service.pendingChangeCount()).toBe(2);

      service.clearProjectChanges('project-1');
      expect(service.pendingChangeCount()).toBe(0);
    });
  });

  describe('数据完整性验证', () => {
    it('应该检测更新不存在的任务', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(`待更新的任务 ${task.id} 在当前项目中不存在，无法执行更新操作`);
    });

    it('应该检测删除不存在的任务', () => {
      service.trackTaskDelete('project-1', 'non-existent-task');

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(true); // 删除不存在的任务是警告，不是错误
      expect(validation.warnings.length).toBeGreaterThan(0);
    });

    it('应该检测创建已存在的任务', () => {
      const task = createMockTask();
      service.trackTaskCreate('project-1', task);

      const validation = service.validateChanges('project-1', [task], []);
      expect(validation.valid).toBe(true);
      expect(validation.warnings).toContain(`待创建的任务 ${task.id} 已存在，将执行更新操作而非创建`);
    });

    it('应该检测孤儿任务（父任务被删除）', () => {
      const parentTask = { ...createMockTask(), id: 'parent-1' };
      const childTask = { ...createMockTask(), id: 'child-1', parentId: 'parent-1' };

      service.trackTaskDelete('project-1', 'parent-1');

      const validation = service.validateChanges('project-1', [parentTask, childTask], []);
      expect(validation.valid).toBe(true);
      expect(validation.warnings.some(w => w.includes('将变为孤儿任务'))).toBe(true);
      expect(validation.recommendations.length).toBeGreaterThan(0);
    });

    it('应该检测连接引用不存在的任务', () => {
      const conn: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: 'test'
      };

      service.trackConnectionCreate('project-1', conn);

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('不存在'))).toBe(true);
    });

    it('应该在变更比例过高时给出建议', () => {
      // 创建25个任务（超过20个阈值）
      const tasks = Array.from({ length: 25 }, (_, i) => ({
        ...createMockTask(),
        id: `task-${i}`
      }));

      // 标记85%的任务为更新（21个）
      for (let i = 0; i < 21; i++) {
        service.trackTaskUpdate('project-1', tasks[i], ['title']);
      }

      const validation = service.validateChanges('project-1', tasks, []);
      expect(validation.valid).toBe(true);
      expect(validation.recommendations.some(r => r.includes('变更比例过高'))).toBe(true);
    });
  });

  describe('数据丢失风险检测', () => {
    it('应该检测高风险：更新不存在的任务', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const risks = service.detectDataLossRisks('project-1', [], []);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.severity === 'high' && r.type === 'task-missing')).toBe(true);
    });

    it('应该检测中风险：连接孤儿化', () => {
      const task1 = { ...createMockTask(), id: 'task-1' };
      const task2 = { ...createMockTask(), id: 'task-2' };
      const conn: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: 'test'
      };

      service.trackTaskDelete('project-1', 'task-1');

      const risks = service.detectDataLossRisks('project-1', [task1, task2], [conn]);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.severity === 'medium' && r.type === 'connection-orphan')).toBe(true);
    });

    it('应该检测中风险：父子任务不一致', () => {
      const parentTask = { ...createMockTask(), id: 'parent-1' };
      const childTask = { ...createMockTask(), id: 'child-1', parentId: 'parent-1' };

      service.trackTaskDelete('project-1', 'parent-1');

      const risks = service.detectDataLossRisks('project-1', [parentTask, childTask], []);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.type === 'parent-child-inconsistency')).toBe(true);
    });

    it('应该检测低风险：重复操作', () => {
      const task = createMockTask();
      service.trackTaskCreate('project-1', task);

      const risks = service.detectDataLossRisks('project-1', [task], []);
      expect(risks.risks.some(r => r.severity === 'low' && r.type === 'duplicate-operation')).toBe(true);
    });

    it('无风险情况应该返回空风险列表', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const risks = service.detectDataLossRisks('project-1', [task], []);
      expect(risks.hasRisk).toBe(false);
      expect(risks.risks).toHaveLength(0);
    });
  });

  describe('变更报告生成', () => {
    it('应该生成正确的变更报告', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskUpdate('project-1', { ...createMockTask(), id: 'task-2' }, ['title']);
      service.trackTaskDelete('project-1', 'task-3');

      const report = service.generateChangeReport('project-1');
      expect(report).toContain('项目 project-1 变更摘要');
      expect(report).toContain('总变更数: 3');
      expect(report).toContain('待创建: 1');
      expect(report).toContain('待更新: 1');
      expect(report).toContain('待删除: 1');
    });

    it('无变更时应该返回简单消息', () => {
      const report = service.generateChangeReport('project-1');
      expect(report).toContain('无待同步变更');
    });
  });
});

function createMockTask(): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    content: 'Test Content',
    parentId: null,
    stage: 1,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: '1',
    hasIncompleteTask: false,
    createdDate: new Date().toISOString()
  };
}
