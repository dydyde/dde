/**
 * 数据丢失检测集成测试
 * 
 * 演示增量同步系统如何在以下场景中保护数据：
 * 1. 更新不存在的任务时中止同步
 * 2. 检测孤儿连接并发出警告
 * 3. 检测父子任务不一致
 * 4. 高风险场景强制使用全量同步
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChangeTrackerService } from './change-tracker.service';
import { Task, Connection, Project } from '../models';

describe('数据丢失检测集成测试', () => {
  let changeTracker: ChangeTrackerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ChangeTrackerService]
    });
    changeTracker = TestBed.inject(ChangeTrackerService);
  });

  describe('场景1: 更新不存在的任务（高风险）', () => {
    it('应该阻止同步并保护数据', () => {
      // 模拟场景：用户在A设备删除了任务，在B设备尝试更新同一任务
      const projectId = 'project-1';
      const taskId = 'task-deleted-on-device-a';

      // B设备上的变更追踪记录了更新操作
      const updatedTask: Task = {
        id: taskId,
        title: '已更新的标题',
        content: '已更新的内容',
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

      changeTracker.trackTaskUpdate(projectId, updatedTask, ['title', 'content']);

      // B设备当前项目中没有这个任务（已在A设备删除）
      const currentTasks: Task[] = [];

      // 数据一致性验证
      const validation = changeTracker.validateChanges(projectId, currentTasks, []);

      // 应该检测到错误并阻止同步
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(
        `待更新的任务 ${taskId} 在当前项目中不存在，无法执行更新操作`
      );

      // 风险检测
      const risks = changeTracker.detectDataLossRisks(projectId, currentTasks, []);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.severity === 'high')).toBe(true);

      console.log('✓ 数据丢失已阻止：检测到更新不存在的任务');
    });
  });

  describe('场景2: 删除任务导致连接孤儿化（中风险）', () => {
    it('应该警告但允许同步', () => {
      const projectId = 'project-1';
      const task1: Task = {
        id: 'task-1',
        title: 'Task 1',
        content: '',
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

      const task2: Task = {
        id: 'task-2',
        title: 'Task 2',
        content: '',
        parentId: null,
        stage: 1,
        order: 1,
        rank: 20000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: '2',
        hasIncompleteTask: false,
        createdDate: new Date().toISOString()
      };

      const connection: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: '依赖关系'
      };

      // 用户删除了 task-1，但连接仍然存在
      changeTracker.trackTaskDelete(projectId, 'task-1');

      const validation = changeTracker.validateChanges(
        projectId,
        [task1, task2],
        [connection]
      );

      // 应该通过验证（只是警告）
      expect(validation.valid).toBe(true);

      // 风险检测应该发现中等风险
      const risks = changeTracker.detectDataLossRisks(
        projectId,
        [task1, task2],
        [connection]
      );

      expect(risks.hasRisk).toBe(true);
      const orphanRisk = risks.risks.find(r => r.type === 'connection-orphan');
      expect(orphanRisk).toBeDefined();
      expect(orphanRisk?.severity).toBe('medium');
      expect(orphanRisk?.affectedEntities).toContain('task-1->task-2');

      console.log('✓ 孤儿连接已检测：发出警告但允许同步');
    });
  });

  describe('场景3: 父子任务层级结构破坏（中风险）', () => {
    it('应该发出警告和建议', () => {
      const projectId = 'project-1';
      const parentTask: Task = {
        id: 'parent-task',
        title: '父任务',
        content: '',
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

      const childTask: Task = {
        id: 'child-task',
        title: '子任务',
        content: '',
        parentId: 'parent-task',
        stage: 1,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: '1.1',
        hasIncompleteTask: false,
        createdDate: new Date().toISOString()
      };

      // 删除父任务但保留子任务
      changeTracker.trackTaskDelete(projectId, 'parent-task');

      const validation = changeTracker.validateChanges(
        projectId,
        [parentTask, childTask],
        []
      );

      expect(validation.valid).toBe(true);
      expect(validation.warnings.some(w => w.includes('孤儿任务'))).toBe(true);
      expect(validation.recommendations.length).toBeGreaterThan(0);

      const risks = changeTracker.detectDataLossRisks(
        projectId,
        [parentTask, childTask],
        []
      );

      const hierarchyRisk = risks.risks.find(r => r.type === 'parent-child-inconsistency');
      expect(hierarchyRisk).toBeDefined();
      expect(hierarchyRisk?.severity).toBe('medium');

      console.log('✓ 层级结构问题已检测：提供修复建议');
    });
  });

  describe('场景4: 大批量变更的性能优化决策', () => {
    it('应该在变更比例过高时建议全量同步', () => {
      const projectId = 'project-1';
      const taskCount = 100;

      // 创建100个任务
      const tasks: Task[] = Array.from({ length: taskCount }, (_, i) => ({
        id: `task-${i}`,
        title: `Task ${i}`,
        content: '',
        parentId: null,
        stage: 1,
        order: i,
        rank: (i + 1) * 10000,
        status: 'active' as const,
        x: 0,
        y: 0,
        displayId: `${i + 1}`,
        hasIncompleteTask: false,
        createdDate: new Date().toISOString()
      }));

      // 标记90个任务为更新（90%变更率）
      for (let i = 0; i < 90; i++) {
        changeTracker.trackTaskUpdate(projectId, tasks[i], ['title']);
      }

      const validation = changeTracker.validateChanges(projectId, tasks, []);

      expect(validation.valid).toBe(true);
      expect(validation.recommendations.some(r => r.includes('变更比例过高'))).toBe(true);
      expect(validation.recommendations.some(r => r.includes('全量同步'))).toBe(true);

      const changes = changeTracker.getProjectChanges(projectId);
      const changeRatio = changes.totalChanges / taskCount;
      expect(changeRatio).toBeGreaterThan(0.8);

      console.log(`✓ 变更比例 ${(changeRatio * 100).toFixed(1)}%：建议使用全量同步`);
    });
  });

  describe('场景5: 变更报告生成', () => {
    it('应该生成详细的变更摘要', () => {
      const projectId = 'project-1';

      // 模拟混合操作
      const task1: Task = createTask('task-1', 'New Task');
      const task2: Task = createTask('task-2', 'Updated Task');

      changeTracker.trackTaskCreate(projectId, task1);
      changeTracker.trackTaskUpdate(projectId, task2, ['title', 'content']);
      changeTracker.trackTaskDelete(projectId, 'task-3');

      const conn: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: 'test'
      };
      changeTracker.trackConnectionCreate(projectId, conn);

      const report = changeTracker.generateChangeReport(projectId);

      expect(report).toContain('项目 project-1 变更摘要');
      expect(report).toContain('总变更数: 4');
      expect(report).toContain('待创建: 1');
      expect(report).toContain('待更新: 1');
      expect(report).toContain('待删除: 1');

      console.log('\n变更报告示例：');
      console.log(report);
    });
  });

  describe('场景6: 完整的同步前检查流程', () => {
    it('应该执行完整的数据保护流程', () => {
      const projectId = 'project-1';

      // 1. 准备项目数据
      const tasks: Task[] = [
        createTask('task-1', 'Task 1'),
        createTask('task-2', 'Task 2'),
        createTask('task-3', 'Task 3', 'task-1'), // 子任务
      ];

      const connections: Connection[] = [
        { id: 'conn-1', source: 'task-1', target: 'task-2', description: 'link' }
      ];

      // 2. 记录一系列变更
      changeTracker.trackTaskUpdate(projectId, tasks[0], ['title']);
      changeTracker.trackTaskDelete(projectId, 'task-2'); // 删除被连接引用的任务
      changeTracker.trackConnectionCreate(projectId, connections[0]);

      // 3. 执行数据一致性验证
      const validation = changeTracker.validateChanges(projectId, tasks, connections);

      console.log('\n=== 同步前数据检查 ===');
      console.log('验证结果:', validation.valid ? '通过' : '失败');
      
      if (validation.warnings.length > 0) {
        console.log('\n警告:');
        validation.warnings.forEach(w => console.log(`  - ${w}`));
      }

      if (validation.errors.length > 0) {
        console.log('\n错误:');
        validation.errors.forEach(e => console.log(`  - ${e}`));
      }

      if (validation.recommendations.length > 0) {
        console.log('\n建议:');
        validation.recommendations.forEach(r => console.log(`  - ${r}`));
      }

      // 4. 风险评估
      const risks = changeTracker.detectDataLossRisks(projectId, tasks, connections);

      console.log('\n=== 风险评估 ===');
      console.log('是否有风险:', risks.hasRisk ? '是' : '否');
      
      if (risks.risks.length > 0) {
        console.log('\n检测到的风险:');
        risks.risks.forEach(risk => {
          console.log(`  [${risk.severity.toUpperCase()}] ${risk.description}`);
          console.log(`    受影响实体: ${risk.affectedEntities.join(', ')}`);
        });
      }

      // 5. 生成变更报告
      const report = changeTracker.generateChangeReport(projectId);
      console.log('\n=== 变更摘要 ===');
      console.log(report);

      // 断言：应该检测到连接孤儿化风险
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.type === 'connection-orphan')).toBe(true);
    });
  });
});

function createTask(id: string, title: string, parentId?: string): Task {
  return {
    id,
    title,
    content: '',
    parentId: parentId || null,
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
