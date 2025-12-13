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
});
