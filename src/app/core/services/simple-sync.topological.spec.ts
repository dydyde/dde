/**
 * 拓扑排序单元测试
 * 测试 SimpleSyncService.topologicalSortTasks 方法
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SimpleSyncService } from './simple-sync.service';
import { Task } from '../../../models';

describe('SimpleSyncService - topologicalSortTasks', () => {
  let service: SimpleSyncService;

  // 创建测试任务的辅助函数
  const createTask = (id: string, parentId: string | null = null): Task => ({
    id,
    title: `Task ${id}`,
    content: '',
    stage: null,
    parentId,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    displayId: id,
    createdDate: new Date().toISOString()
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SimpleSyncService]
    });
    service = TestBed.inject(SimpleSyncService);
  });

  describe('基础功能', () => {
    it('应该返回空数组当输入为空', () => {
      const result = (service as any).topologicalSortTasks([]);
      expect(result).toEqual([]);
    });

    it('应该保持单个任务不变', () => {
      const task = createTask('task-1');
      const result = (service as any).topologicalSortTasks([task]);
      
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('task-1');
    });

    it('应该保留所有任务（无数据丢失）', () => {
      const tasks = [
        createTask('task-1'),
        createTask('task-2'),
        createTask('task-3')
      ];
      
      const result = (service as any).topologicalSortTasks(tasks);
      
      expect(result).toHaveLength(3);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['task-1', 'task-2', 'task-3']);
    });
  });

  describe('父子依赖排序', () => {
    it('应该将父任务排在子任务之前', () => {
      const parent = createTask('parent');
      const child = createTask('child', 'parent');
      
      const result = (service as any).topologicalSortTasks([child, parent]);
      
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('parent');
      expect(result[1].id).toBe('child');
    });

    it('应该正确处理多层嵌套 (A → B → C → D)', () => {
      const taskA = createTask('A');
      const taskB = createTask('B', 'A');
      const taskC = createTask('C', 'B');
      const taskD = createTask('D', 'C');
      
      // 乱序输入
      const result = (service as any).topologicalSortTasks([taskD, taskB, taskA, taskC]);
      
      expect(result).toHaveLength(4);
      // 验证顺序：A 在 B 前，B 在 C 前，C 在 D 前
      const ids = result.map((t: Task) => t.id);
      expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
      expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'));
      expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('D'));
    });

    it('应该处理多个独立的父子链', () => {
      const parent1 = createTask('parent-1');
      const child1 = createTask('child-1', 'parent-1');
      const parent2 = createTask('parent-2');
      const child2 = createTask('child-2', 'parent-2');
      
      const result = (service as any).topologicalSortTasks([
        child2, child1, parent2, parent1
      ]);
      
      expect(result).toHaveLength(4);
      const ids = result.map((t: Task) => t.id);
      
      // parent-1 应该在 child-1 之前
      expect(ids.indexOf('parent-1')).toBeLessThan(ids.indexOf('child-1'));
      // parent-2 应该在 child-2 之前
      expect(ids.indexOf('parent-2')).toBeLessThan(ids.indexOf('child-2'));
    });
  });

  describe('循环依赖处理', () => {
    it('应该处理循环依赖而不丢失数据', () => {
      // 创建循环：A → B → A
      const taskA = createTask('A', 'B');
      const taskB = createTask('B', 'A');
      
      const result = (service as any).topologicalSortTasks([taskA, taskB]);
      
      // 关键：确保没有数据丢失
      expect(result).toHaveLength(2);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['A', 'B']);
    });

    it('应该处理自引用循环', () => {
      const taskA = createTask('A', 'A'); // 自己引用自己
      
      const result = (service as any).topologicalSortTasks([taskA]);
      
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('A');
    });

    it('应该处理三节点循环 (A → B → C → A)', () => {
      const taskA = createTask('A', 'C');
      const taskB = createTask('B', 'A');
      const taskC = createTask('C', 'B');
      
      const result = (service as any).topologicalSortTasks([taskA, taskB, taskC]);
      
      // 确保所有任务都在结果中
      expect(result).toHaveLength(3);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['A', 'B', 'C']);
    });
  });

  describe('孤立任务处理', () => {
    it('应该保留引用不存在父任务的孤立任务', () => {
      const orphan = createTask('orphan', 'non-existent-parent');
      const normal = createTask('normal');
      
      const result = (service as any).topologicalSortTasks([orphan, normal]);
      
      expect(result).toHaveLength(2);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['normal', 'orphan']);
    });

    it('应该处理混合场景：正常依赖 + 孤立任务 + 循环', () => {
      const parent = createTask('parent');
      const child = createTask('child', 'parent');
      const orphan = createTask('orphan', 'missing');
      const cyclicA = createTask('cyclic-A', 'cyclic-B');
      const cyclicB = createTask('cyclic-B', 'cyclic-A');
      
      const result = (service as any).topologicalSortTasks([
        cyclicB, child, orphan, cyclicA, parent
      ]);
      
      // 确保所有任务都在结果中
      expect(result).toHaveLength(5);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['child', 'cyclic-A', 'cyclic-B', 'orphan', 'parent']);
      
      // 验证正常依赖的顺序
      const ids = result.map((t: Task) => t.id);
      expect(ids.indexOf('parent')).toBeLessThan(ids.indexOf('child'));
    });
  });

  describe('边界情况', () => {
    it('应该处理大量任务', () => {
      const tasks: Task[] = [];
      for (let i = 0; i < 1000; i++) {
        tasks.push(createTask(`task-${i}`, i > 0 ? `task-${i - 1}` : null));
      }
      
      const result = (service as any).topologicalSortTasks(tasks);
      
      expect(result).toHaveLength(1000);
      // 验证链式顺序
      for (let i = 0; i < 999; i++) {
        const current = result[i];
        const next = result[i + 1];
        if (next.parentId) {
          expect(current.id).toBe(next.parentId);
        }
      }
    });

    it('应该处理所有任务都是根任务的情况', () => {
      const tasks = [
        createTask('root-1'),
        createTask('root-2'),
        createTask('root-3')
      ];
      
      const result = (service as any).topologicalSortTasks(tasks);
      
      expect(result).toHaveLength(3);
      const resultIds = result.map((t: Task) => t.id).sort();
      expect(resultIds).toEqual(['root-1', 'root-2', 'root-3']);
    });
  });
});
