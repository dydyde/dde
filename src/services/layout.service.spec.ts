import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import type { Project, Task } from '../models';

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'T',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: now,
    updatedAt: now,
    displayId: '?',
    shortId: undefined,
    hasIncompleteTask: false,
    deletedAt: null,
    attachments: [],
    tags: [],
    priority: undefined,
    dueDate: null,
    ...overrides,
  };
}

function createProject(tasks: Task[]): Project {
  const now = new Date().toISOString();
  return {
    id: 'p1',
    name: 'P',
    description: '',
    createdDate: now,
    updatedAt: now,
    version: 1,
    tasks,
    connections: [],
  };
}

describe('LayoutService.rebalance displayId visibility rules', () => {
  let service: LayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        LayoutService,
        { provide: ToastService, useValue: { warning: vi.fn() } },
      ],
    });
    service = TestBed.inject(LayoutService);
  });

  it('deleting a sibling should compact letters (1,b -> 1,a)', () => {
    const root = createTask({ id: 'root', stage: 1, parentId: null, rank: 10000 });
    const childA = createTask({
      id: 'a',
      stage: 2,
      parentId: 'root',
      rank: 11000,
      deletedAt: new Date().toISOString(),
    });
    const childB = createTask({ id: 'b', stage: 2, parentId: 'root', rank: 12000 });

    const project = createProject([root, childA, childB]);
    const rebalanced = service.rebalance(project);

    const b = rebalanced.tasks.find(t => t.id === 'b')!;
    expect(b.displayId).toBe('1,a');
  });

  it('archived tasks should not occupy numbering', () => {
    const root1 = createTask({ id: 'r1', stage: 1, parentId: null, rank: 10000, status: 'archived' });
    const root2 = createTask({ id: 'r2', stage: 1, parentId: null, rank: 11000, status: 'active' });

    const project = createProject([root1, root2]);
    const rebalanced = service.rebalance(project);

    const r2 = rebalanced.tasks.find(t => t.id === 'r2')!;
    expect(r2.displayId).toBe('1');
  });

  it('rebalance 应强制修正子任务的 stage 为 parent.stage + 1', () => {
    // 场景：子任务的 stage > parent.stage + 1，应被强制修正
    const root = createTask({ id: 'root', stage: 1, parentId: null, rank: 10000 });
    const child = createTask({ id: 'child', stage: 5, parentId: 'root', rank: 20000 });

    const project = createProject([root, child]);
    const rebalanced = service.rebalance(project);

    const rebalancedChild = rebalanced.tasks.find(t => t.id === 'child')!;
    // 子任务 stage 应被强制修正为 parent.stage + 1 = 2
    expect(rebalancedChild.stage).toBe(2);
    // displayId 应为正确的子任务格式
    expect(rebalancedChild.displayId).toBe('1,a');
  });

  it('rebalance 应强制修正所有嵌套子任务的 stage', () => {
    // 场景：root(stage=1) -> child(stage=5) -> grandchild(stage=8)
    // 应被修正为 root(1) -> child(2) -> grandchild(3)
    const root = createTask({ id: 'root', stage: 1, parentId: null, rank: 10000 });
    const child = createTask({ id: 'child', stage: 5, parentId: 'root', rank: 20000 });
    const grandchild = createTask({ id: 'grandchild', stage: 8, parentId: 'child', rank: 30000 });

    const project = createProject([root, child, grandchild]);
    const rebalanced = service.rebalance(project);

    const rebalancedChild = rebalanced.tasks.find(t => t.id === 'child')!;
    const rebalancedGrandchild = rebalanced.tasks.find(t => t.id === 'grandchild')!;

    expect(rebalancedChild.stage).toBe(2);
    expect(rebalancedGrandchild.stage).toBe(3);
    expect(rebalancedChild.displayId).toBe('1,a');
    expect(rebalancedGrandchild.displayId).toBe('1,a,a');
  });
});

describe('LayoutService.getSmartPosition', () => {
  let service: LayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        LayoutService,
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }
      ]
    });
    service = TestBed.inject(LayoutService);
  });

  it('应该为未分配任务返回网格位置', () => {
    const tasks: Task[] = [];
    const pos = service.getSmartPosition(null, 0, tasks);
    
    // 第一个未分配任务应该在 (80, 80)
    expect(pos.x).toBe(80);
    expect(pos.y).toBe(80);
  });

  it('应该在父节点右侧创建子节点', () => {
    const parent = createTask({ id: 'parent', stage: 1, x: 300, y: 200 });
    const tasks: Task[] = [parent];
    
    const pos = service.getSmartPosition(2, 0, tasks, 'parent');
    
    // 子节点应该在父节点右侧（stage spacing = 260）
    expect(pos.x).toBe(300 + 260);
    expect(pos.y).toBe(200); // 第一个子节点 y 偏移 0
  });

  it('应该在同一阶段最后一个节点下方创建新节点', () => {
    const task1 = createTask({ id: 't1', stage: 1, x: 120, y: 100 });
    const task2 = createTask({ id: 't2', stage: 1, x: 120, y: 240 });
    const task3 = createTask({ id: 't3', stage: 1, x: 120, y: 380 });
    const tasks: Task[] = [task1, task2, task3];
    
    // 创建第4个节点
    const pos = service.getSmartPosition(1, 3, tasks);
    
    // 应该在最后一个节点下方（row spacing = 140）
    expect(pos.x).toBe(120);
    expect(pos.y).toBe(380 + 140);
  });

  it('应该基于前一阶段的平均高度创建新阶段的第一个节点', () => {
    const stage1task1 = createTask({ id: 't1', stage: 1, x: 120, y: 100 });
    const stage1task2 = createTask({ id: 't2', stage: 1, x: 120, y: 300 });
    const tasks: Task[] = [stage1task1, stage1task2];
    
    // 创建 stage 2 的第一个节点
    const pos = service.getSmartPosition(2, 0, tasks);
    
    // 平均 y 坐标 = (100 + 300) / 2 = 200
    expect(pos.x).toBe(380); // (2-1) * 260 + 120
    expect(pos.y).toBe(200); // 平均高度
  });

  it('应该忽略已删除和已归档的任务', () => {
    const activeTask = createTask({ id: 't1', stage: 1, x: 120, y: 100 });
    const deletedTask = createTask({ id: 't2', stage: 1, x: 120, y: 240, deletedAt: '2024-01-01' });
    const archivedTask = createTask({ id: 't3', stage: 1, x: 120, y: 380, status: 'archived' });
    const tasks: Task[] = [activeTask, deletedTask, archivedTask];
    
    // 创建新节点应该基于 activeTask 的位置
    const pos = service.getSmartPosition(1, 1, tasks);
    
    // 应该在 activeTask 下方，忽略 deleted 和 archived
    expect(pos.x).toBe(120);
    expect(pos.y).toBe(100 + 140); // activeTask.y + ROW_SPACING
  });

  it('当阶段没有任何节点时应该使用固定网格位置', () => {
    const tasks: Task[] = [];
    
    // 创建 stage 1 的第一个节点
    const pos = service.getSmartPosition(1, 0, tasks);
    
    // 应该使用固定的网格位置
    expect(pos.x).toBe(120); // (1-1) * 260 + 120
    expect(pos.y).toBe(100); // 100 + 0 * 140
  });
});
