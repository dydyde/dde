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
