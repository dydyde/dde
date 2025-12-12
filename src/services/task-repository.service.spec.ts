import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TaskRepositoryService } from './task-repository.service';
import { SupabaseClientService } from './supabase-client.service';
import type { Task } from '../models';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Title',
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: undefined,
    displayId: '1',
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

describe('TaskRepositoryService.saveTasksIncremental tombstone-wins', () => {
  let service: TaskRepositoryService;

  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ upsert }));
  const mockSupabaseClientService = {
    get isConfigured() {
      return true;
    },
    client: () => ({ from }),
  } as unknown as SupabaseClientService;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        TaskRepositoryService,
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
      ],
    });
    service = TestBed.inject(TaskRepositoryService);
  });

  it('does not send deleted_at when deletedAt is null and not explicitly changed', async () => {
    const task = createTask({ id: 'task-1', deletedAt: null });

    await service.saveTasksIncremental(
      'project-1',
      [],
      [task],
      [],
      { 'task-1': ['title'] }
    );

    expect(from).toHaveBeenCalledWith('tasks');
    expect(upsert).toHaveBeenCalledTimes(1);

    const payload = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(payload[0], 'deleted_at')).toBe(false);
  });

  it('sends deleted_at null when deletedAt is null but explicitly changed (restore)', async () => {
    const task = createTask({ id: 'task-2', deletedAt: null });

    await service.saveTasksIncremental(
      'project-1',
      [],
      [task],
      [],
      { 'task-2': ['deletedAt'] }
    );

    const payload = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toHaveProperty('deleted_at', null);
  });

  it('always sends deleted_at when deletedAt is set (tombstone)', async () => {
    const ts = new Date().toISOString();
    const task = createTask({ id: 'task-3', deletedAt: ts });

    await service.saveTasksIncremental(
      'project-1',
      [],
      [task],
      [],
      { 'task-3': ['title'] }
    );

    const payload = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toHaveProperty('deleted_at', ts);
  });
});
