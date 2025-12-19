import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { TaskOperationService } from './task-operation.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { Project, Task, Connection } from '../models';

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    shortId: overrides.shortId,
    hasIncompleteTask: overrides.hasIncompleteTask,
    deletedAt: overrides.deletedAt,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project>): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'P',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
    flowchartUrl: overrides.flowchartUrl,
    flowchartThumbnailUrl: overrides.flowchartThumbnailUrl,
  };
}

describe('TaskOperationService (deletedMeta restore)', () => {
  let service: TaskOperationService;
  let project: Project;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TaskOperationService, LayoutService, ToastService],
    });

    service = TestBed.inject(TaskOperationService);

    // 默认项目会在每个测试里初始化
    project = createProject({});

    service.setCallbacks({
      getActiveProject: () => project,
      onProjectUpdate: (mutator) => {
        project = mutator(project);
      },
      onProjectUpdateDebounced: (mutator) => {
        project = mutator(project);
      },
    });
  });

  it('deleteTask() 会写入 deletedMeta，restoreTask() 会消费并清除 deletedMeta', () => {
    const parent = createTask({
      id: 'parent',
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
      parentId: null,
      displayId: '1,a',
      shortId: 'NF-PARENT',
      deletedAt: null,
    });

    const child = createTask({
      id: 'child',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
      parentId: 'parent',
      displayId: '1,a.1',
      shortId: 'NF-CHILD',
      deletedAt: null,
    });

    const other = createTask({
      id: 'other',
      stage: 1,
      order: 3,
      rank: 1300,
      x: 50,
      y: 60,
      parentId: null,
      displayId: '1,b',
      shortId: 'NF-OTHER',
      deletedAt: null,
    });

    const connections: Connection[] = [
      { id: 'c-parent-child', source: 'parent', target: 'child' },
      { id: 'c-parent-other', source: 'parent', target: 'other' },
      { id: 'c-child-other', source: 'child', target: 'other' },
    ];

    project = createProject({
      tasks: [parent, child, other],
      connections,
    });

    service.deleteTask('parent');

    const afterDeleteParent = project.tasks.find(t => t.id === 'parent')!;
    const afterDeleteChild = project.tasks.find(t => t.id === 'child')!;
    const afterDeleteOther = project.tasks.find(t => t.id === 'other')!;

    expect(afterDeleteParent.deletedAt).toBeTruthy();
    expect(afterDeleteParent.stage).toBeNull();
    expect(afterDeleteParent.deletedMeta).toEqual({
      parentId: null,
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
    });
    expect(afterDeleteParent.deletedConnections?.length).toBe(3);

    expect(afterDeleteChild.deletedAt).toBeTruthy();
    expect(afterDeleteChild.stage).toBeNull();
    expect(afterDeleteChild.deletedMeta).toEqual({
      parentId: 'parent',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
    });

    // 未删除任务不应受影响
    expect(afterDeleteOther.deletedAt ?? null).toBeNull();

    // 连接应从项目中移除（避免引用已删除任务）
    expect(project.connections.length).toBe(0);

    service.restoreTask('parent');

    const afterRestoreParent = project.tasks.find(t => t.id === 'parent')!;
    const afterRestoreChild = project.tasks.find(t => t.id === 'child')!;

    expect(afterRestoreParent.deletedAt ?? null).toBeNull();
    expect(afterRestoreParent.deletedMeta).toBeUndefined();
    expect(afterRestoreParent.parentId).toBeNull();
    expect(afterRestoreParent.stage).toBe(1);

    expect(afterRestoreChild.deletedAt ?? null).toBeNull();
    expect(afterRestoreChild.deletedMeta).toBeUndefined();
    expect(afterRestoreChild.parentId).toBe('parent');
    // rebalance 会强制子任务 stage = parent.stage + 1
    expect(afterRestoreChild.stage).toBe(2);

    // 删除时保存的连接应被恢复（包含父子连线）
    const connKeys = new Set(project.connections.map(c => `${c.source}->${c.target}`));
    expect(connKeys.has('parent->child')).toBe(true);
    expect(connKeys.has('parent->other')).toBe(true);
    expect(connKeys.has('child->other')).toBe(true);
  });
});

describe('TaskOperationService (moveTaskToStage parentId validation)', () => {
  let service: TaskOperationService;
  let project: Project;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TaskOperationService, LayoutService, ToastService],
    });

    service = TestBed.inject(TaskOperationService);
    project = createProject({});

    service.setCallbacks({
      getActiveProject: () => project,
      onProjectUpdate: (mutator) => {
        project = mutator(project);
      },
      onProjectUpdateDebounced: (mutator) => {
        project = mutator(project);
      },
    });
  });

  it('移动任务到远距离阶段时应清除无效的 parentId', () => {
    // 场景：root 在 stage=1，child 在 stage=2 且 parentId=root
    // 当 child 移动到 stage=5 时，parentId 应被清除（因为 root 不在 stage=4）
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
      displayId: '1',
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
      displayId: '1,a',
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到 stage=5，不提供 newParentId
    service.moveTaskToStage({ taskId: 'child', newStage: 5 });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBe(5);
    // parentId 应被清除，因为 root 在 stage=1，不是 stage=4
    expect(movedChild.parentId).toBeNull();
  });

  it('移动任务到相邻阶段时应保留有效的 parentId', () => {
    // 场景：root 在 stage=1，child 在 stage=2 且 parentId=root
    // 由于 rebalance 会强制子任务 stage = parent.stage + 1，
    // 移动到 stage=2 应保留 parentId
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到 stage=2（相邻阶段），不提供 newParentId
    service.moveTaskToStage({ taskId: 'child', newStage: 2 });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBe(2);
    // parentId 应保留，因为 root 在 stage=1 = newStage - 1
    expect(movedChild.parentId).toBe('root');
  });

  it('移动父任务时应级联更新所有子任务的 stage', () => {
    // 场景：root 在 stage=1，child 在 stage=2，grandchild 在 stage=3
    // 当 root 移动到 stage=3 时，child 应变为 stage=4，grandchild 应变为 stage=5
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });
    const grandchild = createTask({
      id: 'grandchild',
      stage: 3,
      parentId: 'child',
      rank: 30000,
    });

    project = createProject({ tasks: [root, child, grandchild] });

    // 移动 root 到 stage=3
    service.moveTaskToStage({ taskId: 'root', newStage: 3 });

    const movedRoot = project.tasks.find(t => t.id === 'root')!;
    const movedChild = project.tasks.find(t => t.id === 'child')!;
    const movedGrandchild = project.tasks.find(t => t.id === 'grandchild')!;

    expect(movedRoot.stage).toBe(3);
    // 子任务应级联更新到 stage=4
    expect(movedChild.stage).toBe(4);
    // 孙任务应级联更新到 stage=5
    expect(movedGrandchild.stage).toBe(5);
  });

  it('移动任务到未分配区域应清除 parentId', () => {
    const root = createTask({
      id: 'root',
      stage: 1,
      parentId: null,
      rank: 10000,
    });
    const child = createTask({
      id: 'child',
      stage: 2,
      parentId: 'root',
      rank: 20000,
    });

    project = createProject({ tasks: [root, child] });

    // 移动 child 到未分配区域（stage=null）
    service.moveTaskToStage({ taskId: 'child', newStage: null });

    const movedChild = project.tasks.find(t => t.id === 'child')!;
    expect(movedChild.stage).toBeNull();
    expect(movedChild.parentId).toBeNull();
  });
});
