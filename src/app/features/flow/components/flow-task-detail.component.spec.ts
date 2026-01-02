import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { Task } from '../../../../models';

describe('FlowTaskDetailComponent - Task Switching Fix', () => {
  let component: FlowTaskDetailComponent;
  let fixture: ComponentFixture<FlowTaskDetailComponent>;
  let mockUiState: any;
  let mockProjectState: any;
  let mockUserSession: any;
  let mockChangeTracker: any;

  const createMockTask = (id: string, title: string, content: string): Task => ({
    id,
    title,
    content,
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    displayId: id,
    createdDate: '2025-12-31',
    updatedAt: '2025-12-31T00:00:00Z',
  });

  beforeEach(async () => {
    // Mock services
    mockUiState = {
      markEditing: vi.fn(),
      isMobile: signal(false),
      isFlowDetailOpen: signal(true),
      activeView: signal<'text' | 'flow' | null>('flow'),
    };

    mockProjectState = {
      compressDisplayId: vi.fn((id: string) => id),
      activeProjectId: signal('project-1'),
      activeProject: signal({ 
        id: 'project-1', 
        name: 'Test Project', 
        description: '', 
        tasks: [], 
        connections: [] 
      }),
    };

    mockUserSession = {
      currentUserId: signal('user-1'),
    };

    mockChangeTracker = {
      lockTaskField: vi.fn(),
      unlockTaskField: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [FlowTaskDetailComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(FlowTaskDetailComponent);
    component = fixture.componentInstance;
  });

  describe('任务切换时的状态重置', () => {
    it('应该在任务 ID 变化时强制更新 localTitle 和 localContent', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 手动更新输入信号并触发变更检测
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      expect(component['localTitle']()).toBe('Task A');
      expect(component['localContent']()).toBe('Content A');

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证状态已更新
      expect(component['localTitle']()).toBe('Task B');
      expect(component['localContent']()).toBe('Content B');
    });

    it('应该在任务切换时解锁旧任务的字段', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 重置mock计数
      vi.clearAllMocks();

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证旧任务的字段已解锁
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'title');
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'content');
    });

    it('应该在任务切换时清理解锁定时器', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 模拟聚焦并创建定时器
      component.onInputFocus('title');
      component.onInputBlur('title');

      // 验证定时器已创建
      expect(component['unlockTimers'].size).toBe(1);

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证定时器已清理
      expect(component['unlockTimers'].size).toBe(0);
    });

    it('应该在任务变为 null 时重置所有状态', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      expect(component['localTitle']()).toBe('Task A');
      expect(component['localContent']()).toBe('Content A');

      vi.clearAllMocks();

      // 设置为 null
      (component as any)['task'].set(null);
      fixture.detectChanges();

      // 验证状态已重置
      expect(component['localTitle']()).toBe('');
      expect(component['localContent']()).toBe('');
      expect(component['currentTaskId']).toBeNull();
      
      // 验证字段已解锁
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'title');
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'content');
    });
    
    it('🔴 关键测试：任务切换期间不应发射变更事件（防止数据丢失）', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', '', ''); // 空任务

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 订阅变更事件
      let titleEmitCount = 0;
      let contentEmitCount = 0;
      let lastTitleEvent: any;
      let lastContentEvent: any;
      
      component.titleChange.subscribe((event) => {
        titleEmitCount++;
        lastTitleEvent = event;
      });
      component.contentChange.subscribe((event) => {
        contentEmitCount++;
        lastContentEvent = event;
      });

      // 切换到空任务 B - 这会在 effect 中设置 isTaskSwitching = true
      // 然后设置 localTitle = '' 和 localContent = ''
      // 如果没有保护机制，ngModelChange 会发射 { taskId: 'task-b', title: '' }
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证：在任务切换期间，不应该发射任何变更事件
      // 如果这个测试失败，说明任务切换时空值被错误地发射给了新任务
      expect(titleEmitCount).toBe(0);
      expect(contentEmitCount).toBe(0);
    });
    
    it('🔴 关键测试：任务切换完成后应正常发射变更事件', async () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();
      
      // 等待 queueMicrotask 完成
      await Promise.resolve();

      // 订阅变更事件
      let emittedEvent: any;
      component.titleChange.subscribe((event) => {
        emittedEvent = event;
      });

      // 现在应该可以正常发射事件
      component.onLocalTitleChange('User Input');

      expect(emittedEvent).toEqual({ taskId: 'task-b', title: 'User Input' });
    });
  });

  describe('同一任务的更新', () => {
    it('应该在内容更新且未聚焦时同步 localContent', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');

      // 初始设置
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Content A');

      // 更新任务内容（同一任务 ID）
      const updatedTask = { ...task, content: 'Updated Content A' };
      (component as any)['task'].set(updatedTask);
      fixture.detectChanges();

      // 验证内容已同步（因为未聚焦）
      expect(component['localContent']()).toBe('Updated Content A');
    });

    it('应该在内容更新但已聚焦时保持 localContent 不变', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');

      // 初始设置
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      // 聚焦内容输入框
      component.onInputFocus('content');
      component['localContent'].set('Local Edit');

      // 更新任务内容（模拟远程更新）
      const updatedTask = { ...task, content: 'Remote Update' };
      (component as any)['task'].set(updatedTask);
      fixture.detectChanges();

      // 验证 localContent 保持用户编辑的值（Split-Brain 防护）
      expect(component['localContent']()).toBe('Local Edit');
    });
  });

  describe('编辑模式切换', () => {
    it('应该正确切换编辑模式', async () => {
      // 使用 fake timers 避免等待真实的 350ms
      vi.useFakeTimers();
      
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component.isEditMode()).toBe(false);

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true);

      // 使用 fake timers 快进节流时间（300ms + 余量）
      await vi.advanceTimersByTimeAsync(350);

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(false);
      
      vi.useRealTimers();
    });

    it('应该防止快速连续切换（节流保护）', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true);
      expect(component['isTogglingMode']()).toBe(true);

      // 快速再次点击应被忽略
      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true); // 仍然是 true
    });
  });

  describe('输入处理', () => {
    it('应该在标题变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      component.titleChange.subscribe((event) => {
        emittedEvent = event;
      });

      component.onLocalTitleChange('New Title');

      expect(emittedEvent).toEqual({ taskId: 'task-a', title: 'New Title' });
      expect(component['localTitle']()).toBe('New Title');
    });

    it('应该在内容变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      component.contentChange.subscribe((event) => {
        emittedEvent = event;
      });

      component.onLocalContentChange('New Content');

      expect(emittedEvent).toEqual({ taskId: 'task-a', content: 'New Content' });
      expect(component['localContent']()).toBe('New Content');
    });

    it('应该在聚焦时锁定字段', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('title');

      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-a',
        'project-1',
        'title',
        expect.any(Number)
      );
      expect(component['isTitleFocused']).toBe(true);
    });

    it('应该在失焦时延迟解锁字段', async () => {
      // 使用 fake timers 加速测试
      vi.useFakeTimers();
      
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('title');
      component.onInputBlur('title');

      // 验证定时器已创建
      expect(component['unlockTimers'].size).toBe(1);
      expect(component['isTitleFocused']).toBe(true); // 仍然为 true（延迟解锁）

      // 使用 fake timers 快进 10.1 秒
      await vi.advanceTimersByTimeAsync(10100);
      
      expect(component['isTitleFocused']).toBe(false);
      expect(component['unlockTimers'].size).toBe(0);
      
      vi.useRealTimers();
    });
  });
});
