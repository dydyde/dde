/**
 * FlowSelectionService 单元测试
 * 
 * 测试策略：
 * - 验证选择状态管理
 * - 验证多选/单选逻辑
 * - 验证选择操作在无 diagram 时的安全性
 * 
 * 测试覆盖：
 * - 初始状态
 * - 选择操作（无 diagram 时的安全性）
 * - 选择计数
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FlowSelectionService } from './flow-selection.service';
import { LoggerService } from '../../../../services/logger.service';

describe('FlowSelectionService', () => {
  let service: FlowSelectionService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  
  beforeEach(() => {
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockLogger = {
      category: vi.fn().mockReturnValue(loggerMock),
    };
    
    TestBed.configureTestingModule({
      providers: [
        FlowSelectionService,
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    service = TestBed.inject(FlowSelectionService);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('应成功创建服务', () => {
      expect(service).toBeDefined();
    });

    it('无 diagram 时 getSelectedNodeKeys 应返回空数组', () => {
      expect(service.getSelectedNodeKeys()).toEqual([]);
    });

    it('无 diagram 时 getSelectedNodesInfo 应返回空数组', () => {
      expect(service.getSelectedNodesInfo()).toEqual([]);
    });

    it('无 diagram 时 getSelectionCount 应返回 0', () => {
      expect(service.getSelectionCount()).toBe(0);
    });
  });

  describe('选择操作安全性（无 diagram）', () => {
    it('selectNode 在无 diagram 时不应抛出异常', () => {
      expect(() => service.selectNode('task-1')).not.toThrow();
    });

    it('selectMultiple 在无 diagram 时不应抛出异常', () => {
      expect(() => service.selectMultiple(['task-1', 'task-2'])).not.toThrow();
    });

    it('clearSelection 在无 diagram 时不应抛出异常', () => {
      expect(() => service.clearSelection()).not.toThrow();
    });

    it('toggleNodeSelection 在无 diagram 时不应抛出异常', () => {
      expect(() => service.toggleNodeSelection('task-1')).not.toThrow();
    });

    it('selectAll 在无 diagram 时不应抛出异常', () => {
      expect(() => service.selectAll()).not.toThrow();
    });
  });

  describe('节点选中状态检查', () => {
    it('isNodeSelected 在无 diagram 时应返回 false', () => {
      expect(service.isNodeSelected('task-1')).toBe(false);
    });
  });

  describe('选择状态保存/恢复', () => {
    it('saveSelectionState 在无 diagram 时应返回空 Set', () => {
      const state = service.saveSelectionState();
      expect(state.size).toBe(0);
    });

    it('restoreSelectionState 在无 diagram 时不应抛出异常', () => {
      const state = new Set(['task-1', 'task-2']);
      expect(() => service.restoreSelectionState(state)).not.toThrow();
    });

    it('restoreSelectionState 空 Set 时不应抛出异常', () => {
      expect(() => service.restoreSelectionState(new Set())).not.toThrow();
    });
  });

  describe('setDiagram', () => {
    it('setDiagram(null) 不应抛出异常', () => {
      expect(() => service.setDiagram(null)).not.toThrow();
    });
  });
});
