/**
 * UndoService 单元测试
 * 
 * 测试覆盖：
 * - 记录操作到撤销栈
 * - 撤销/重做功能
 * - 防抖机制
 * - 版本冲突检测
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UndoService } from './undo.service';
import { UndoAction } from '../models';

describe('UndoService', () => {
  let service: UndoService;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [UndoService],
    });
    service = TestBed.inject(UndoService);
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  // 创建测试用的操作
  function createAction(overrides: Partial<Omit<UndoAction, 'timestamp'>> = {}): Omit<UndoAction, 'timestamp'> {
    return {
      projectId: 'project-1',
      type: 'task-update',
      data: {
        before: { id: 'task-1', title: 'Before' },
        after: { id: 'task-1', title: 'After' },
      },
      ...overrides,
    };
  }
  
  describe('初始状态', () => {
    it('撤销和重做栈应为空', () => {
      expect(service.canUndo()).toBe(false);
      expect(service.canRedo()).toBe(false);
      expect(service.undoCount()).toBe(0);
      expect(service.redoCount()).toBe(0);
    });
  });
  
  describe('记录操作', () => {
    it('recordAction 应添加操作到撤销栈', () => {
      service.recordAction(createAction());
      
      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBeGreaterThanOrEqual(1);
    });
    
    it('不同类型的操作应分别添加', () => {
      service.recordAction(createAction({ type: 'task-create' }));
      service.recordAction(createAction({ type: 'task-delete' }));
      
      expect(service.undoCount()).toBe(2);
    });
    
    it('记录操作应清空重做栈', () => {
      // 先记录一个操作
      service.recordAction(createAction({ type: 'task-create' }));
      // 撤销它
      service.undo();
      expect(service.canRedo()).toBe(true);
      
      // 记录新操作
      service.recordAction(createAction({ type: 'task-delete' }));
      
      // 重做栈应被清空
      expect(service.canRedo()).toBe(false);
    });
  });
  
  describe('撤销操作', () => {
    it('undo 应返回操作的数据', () => {
      const action = createAction({ 
        type: 'task-create',
        data: { before: { title: 'Original' }, after: { title: 'Modified' } }
      });
      service.recordAction(action);
      
      const result = service.undo();
      
      expect(result).toBeDefined();
      expect((result as UndoAction).data.before).toEqual({ title: 'Original' });
    });
    
    it('undo 应将操作移动到重做栈', () => {
      service.recordAction(createAction({ type: 'task-create' }));
      
      service.undo();
      
      expect(service.undoCount()).toBe(0);
      expect(service.redoCount()).toBe(1);
    });
    
    it('空栈时 undo 应返回 null', () => {
      const result = service.undo();
      
      expect(result).toBeNull();
    });
  });
  
  describe('重做操作', () => {
    it('redo 应返回撤销的操作', () => {
      service.recordAction(createAction({ type: 'task-create' }));
      service.undo();
      
      const result = service.redo();
      
      expect(result).toBeDefined();
      expect((result as UndoAction).type).toBe('task-create');
    });
    
    it('redo 应将操作移回撤销栈', () => {
      service.recordAction(createAction({ type: 'task-create' }));
      service.undo();
      expect(service.canRedo()).toBe(true);
      expect(service.canUndo()).toBe(false);
      
      service.redo();
      
      expect(service.canRedo()).toBe(false);
      expect(service.canUndo()).toBe(true);
    });
    
    it('空重做栈时应返回 null', () => {
      const result = service.redo();
      
      expect(result).toBeNull();
    });
  });
  
  describe('清空操作', () => {
    it('clearHistory 应清除指定项目的操作', () => {
      service.recordAction(createAction({ projectId: 'project-1', type: 'task-create' }));
      service.recordAction(createAction({ projectId: 'project-2', type: 'task-delete' }));
      
      service.clearHistory('project-1');
      
      expect(service.undoCount()).toBe(1);
    });
    
    it('clearHistory 无参数应清除所有操作', () => {
      service.recordAction(createAction({ projectId: 'project-1', type: 'task-create' }));
      service.recordAction(createAction({ projectId: 'project-2', type: 'task-delete' }));
      service.undo();
      
      service.clearHistory();
      
      expect(service.undoCount()).toBe(0);
      expect(service.redoCount()).toBe(0);
    });
  });
  
  describe('版本冲突检测', () => {
    it('版本匹配时应正常撤销', () => {
      service.recordAction(createAction({ type: 'task-create' }), 1);
      
      const result = service.undo(1);
      
      expect(result).not.toBe('version-mismatch');
      expect(result).toBeDefined();
    });
    
    it('版本差距过大时应返回版本不匹配', () => {
      service.recordAction(createAction({ type: 'task-create' }), 1);
      
      // 假设远程版本跳到了很高的值
      const result = service.undo(100);
      
      // 应该返回版本不匹配或可强制撤销结果
      expect(
        result === 'version-mismatch' || 
        (typeof result === 'object' && result !== null && 'type' in result && result.type === 'version-mismatch-forceable')
      ).toBe(true);
    });
    
    it('无版本号时应正常撤销', () => {
      service.recordAction(createAction({ type: 'task-create' }));
      
      const result = service.undo();
      
      expect(result).not.toBe('version-mismatch');
    });
  });
  
  describe('防抖操作', () => {
    it('flushPendingAction 应提交待处理的操作', () => {
      service.recordActionDebounced(createAction({ type: 'task-create' }));
      
      // 立即刷新
      service.flushPendingAction();
      
      expect(service.canUndo()).toBe(true);
    });
  });
});
