/**
 * FlowDragDropService 单元测试
 * 
 * 测试策略：
 * - 验证拖放状态管理
 * - 验证各方法在无 diagram 时的安全性
 * - 验证事件处理逻辑
 * 
 * 测试覆盖：
 * - 初始状态
 * - 拖放操作
 * - 事件处理
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FlowDragDropService } from './flow-drag-drop.service';
import { LoggerService } from '../../../../services/logger.service';
import { StoreService } from '../../../../services/store.service';
import { ToastService } from '../../../../services/toast.service';

describe('FlowDragDropService', () => {
  let service: FlowDragDropService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  let mockStore: Partial<StoreService>;
  let mockToast: Partial<ToastService>;
  
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
    
    mockStore = {
      detachTask: vi.fn(),
    };
    
    mockToast = {
      success: vi.fn(),
      error: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        FlowDragDropService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: StoreService, useValue: mockStore },
        { provide: ToastService, useValue: mockToast },
      ],
    });
    
    service = TestBed.inject(FlowDragDropService);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('应成功创建服务', () => {
      expect(service).toBeDefined();
    });

    it('初始时 isDropTargetActive 应为 false', () => {
      expect(service.isDropTargetActive()).toBe(false);
    });
  });

  describe('拖放状态管理', () => {
    it('startDragFromDiagram 应设置 isDropTargetActive 为 true', () => {
      service.startDragFromDiagram('task-1');
      expect(service.isDropTargetActive()).toBe(true);
    });

    it('endDragFromDiagram 应设置 isDropTargetActive 为 false', () => {
      service.startDragFromDiagram('task-1');
      service.endDragFromDiagram();
      expect(service.isDropTargetActive()).toBe(false);
    });
  });

  describe('事件处理 - dragover/dragleave', () => {
    it('handleDragOver 应设置 isDropTargetActive 为 true', () => {
      const mockEvent = {
        preventDefault: vi.fn(),
        dataTransfer: { dropEffect: '' },
      } as unknown as DragEvent;
      
      service.handleDragOver(mockEvent);
      expect(service.isDropTargetActive()).toBe(true);
      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });

    it('handleDragLeave 应设置 isDropTargetActive 为 false', () => {
      service.handleDragOver({
        preventDefault: vi.fn(),
        dataTransfer: { dropEffect: '' },
      } as unknown as DragEvent);
      
      service.handleDragLeave();
      expect(service.isDropTargetActive()).toBe(false);
    });
  });

  describe('startDrag', () => {
    it('应正确设置 dataTransfer 数据', () => {
      const mockTask = { id: 'task-1', title: '测试任务' };
      const mockDataTransfer = {
        setData: vi.fn(),
        effectAllowed: '',
      };
      const mockEvent = {
        dataTransfer: mockDataTransfer,
      } as unknown as DragEvent;
      
      service.startDrag(mockEvent, mockTask as any);
      
      expect(mockDataTransfer.setData).toHaveBeenCalledWith('text', JSON.stringify(mockTask));
      expect(mockDataTransfer.setData).toHaveBeenCalledWith('application/json', JSON.stringify(mockTask));
      expect(mockDataTransfer.effectAllowed).toBe('move');
    });

    it('无 dataTransfer 时不应抛出异常', () => {
      const mockEvent = {} as DragEvent;
      expect(() => service.startDrag(mockEvent, { id: 'task-1' } as any)).not.toThrow();
    });
  });

  describe('handleDropToUnassigned', () => {
    it('应处理有效的任务数据', () => {
      const task = { id: 'task-1', title: '测试', stage: 1 };
      const mockEvent = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue(JSON.stringify(task)),
        },
      } as unknown as DragEvent;
      
      const result = service.handleDropToUnassigned(mockEvent);
      
      expect(result).toBe(true);
      expect(mockStore.detachTask).toHaveBeenCalledWith('task-1');
      expect(mockToast.success).toHaveBeenCalled();
    });

    it('无数据时应返回 false', () => {
      const mockEvent = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue(''),
        },
      } as unknown as DragEvent;
      
      const result = service.handleDropToUnassigned(mockEvent);
      expect(result).toBe(false);
    });

    it('stage 为 null 的任务应返回 false', () => {
      const task = { id: 'task-1', title: '测试', stage: null };
      const mockEvent = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue(JSON.stringify(task)),
        },
      } as unknown as DragEvent;
      
      const result = service.handleDropToUnassigned(mockEvent);
      expect(result).toBe(false);
    });

    it('无效 JSON 应返回 false', () => {
      const mockEvent = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue('invalid json'),
        },
      } as unknown as DragEvent;
      
      const result = service.handleDropToUnassigned(mockEvent);
      expect(result).toBe(false);
    });
  });
});
