/**
 * FlowLinkService 单元测试
 * 
 * 测试策略：
 * - 验证连接模式状态管理
 * - 验证对话框状态管理
 * - 验证连接编辑器状态
 * 
 * 测试覆盖：
 * - 初始状态
 * - 连接模式切换
 * - 连接编辑器状态
 * - 移动端删除提示
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FlowLinkService } from './flow-link.service';
import { LoggerService } from '../../../../services/logger.service';
import { StoreService } from '../../../../services/store.service';
import { ToastService } from '../../../../services/toast.service';

describe('FlowLinkService', () => {
  let service: FlowLinkService;
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
      tasks: signal([]),
      moveTaskToStage: vi.fn(),
      addCrossTreeConnection: vi.fn(),
    };
    
    mockToast = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        FlowLinkService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: StoreService, useValue: mockStore },
        { provide: ToastService, useValue: mockToast },
      ],
    });
    
    service = TestBed.inject(FlowLinkService);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('应成功创建服务', () => {
      expect(service).toBeDefined();
    });

    it('初始时 isLinkMode 应为 false', () => {
      expect(service.isLinkMode()).toBe(false);
    });

    it('初始时 linkSourceTask 应为 null', () => {
      expect(service.linkSourceTask()).toBeNull();
    });

    it('初始时 linkTypeDialog 应为 null', () => {
      expect(service.linkTypeDialog()).toBeNull();
    });

    it('初始时 connectionEditorData 应为 null', () => {
      expect(service.connectionEditorData()).toBeNull();
    });

    it('初始时 linkDeleteHint 应为 null', () => {
      expect(service.linkDeleteHint()).toBeNull();
    });
  });

  describe('连接模式切换', () => {
    it('toggleLinkMode 应切换连接模式', () => {
      expect(service.isLinkMode()).toBe(false);
      service.toggleLinkMode();
      expect(service.isLinkMode()).toBe(true);
      service.toggleLinkMode();
      expect(service.isLinkMode()).toBe(false);
    });

    it('toggleLinkMode 应清除 linkSourceTask', () => {
      // 模拟已选择源任务的状态
      (mockStore.tasks as any).set([
        { id: 'task-1', title: '测试', stage: 1 }
      ]);
      
      service.toggleLinkMode();
      expect(service.linkSourceTask()).toBeNull();
    });

    it('cancelLinkMode 应关闭连接模式并清除源任务', () => {
      service.toggleLinkMode(); // 开启连接模式
      service.cancelLinkMode();
      expect(service.isLinkMode()).toBe(false);
      expect(service.linkSourceTask()).toBeNull();
    });
  });

  describe('handleLinkModeClick', () => {
    it('点击不存在的任务应返回 false', () => {
      (mockStore.tasks as any).set([]);
      
      const result = service.handleLinkModeClick('non-existent');
      expect(result).toBe(false);
    });

    it('第一次点击应设置源任务', () => {
      const task = { id: 'task-1', title: '测试', stage: 1 };
      (mockStore.tasks as any).set([task]);
      
      service.handleLinkModeClick('task-1');
      expect(service.linkSourceTask()).toEqual(task);
    });

    it('点击同一个任务应显示警告并清除源任务', () => {
      const task = { id: 'task-1', title: '测试', stage: 1 };
      (mockStore.tasks as any).set([task]);
      
      // 第一次点击设置源任务
      service.handleLinkModeClick('task-1');
      // 第二次点击同一个任务
      const result = service.handleLinkModeClick('task-1');
      
      expect(result).toBe(false);
      expect(mockToast.warning).toHaveBeenCalledWith('无法连接', '节点不能连接到自身');
      expect(service.linkSourceTask()).toBeNull();
    });

    it('点击不同任务应创建连接并退出连接模式', () => {
      const source = { id: 'task-1', title: '源任务', stage: 1 };
      const target = { id: 'task-2', title: '目标任务', stage: 2 };
      (mockStore.tasks as any).set([source, target]);
      
      service.toggleLinkMode();
      service.handleLinkModeClick('task-1');
      const result = service.handleLinkModeClick('task-2');
      
      expect(result).toBe(true);
      expect(mockStore.addCrossTreeConnection).toHaveBeenCalledWith('task-1', 'task-2');
      expect(service.isLinkMode()).toBe(false);
      expect(service.linkSourceTask()).toBeNull();
    });

    it('目标任务未分配阶段时应先分配阶段再创建连接', () => {
      const source = { id: 'task-1', title: '源任务', stage: 2 };
      const target = { id: 'task-2', title: '目标任务', stage: null };
      (mockStore.tasks as any).set([source, target]);
      
      service.toggleLinkMode();
      service.handleLinkModeClick('task-1');
      service.handleLinkModeClick('task-2');
      
      // 应先分配阶段
      expect(mockStore.moveTaskToStage).toHaveBeenCalledWith('task-2', 2, undefined, null);
      // 再创建连接
      expect(mockStore.addCrossTreeConnection).toHaveBeenCalledWith('task-1', 'task-2');
    });
  });

  describe('连接编辑器位置', () => {
    it('connectionEditorPos 应有默认值', () => {
      const pos = service.connectionEditorPos();
      expect(pos).toEqual({ x: 0, y: 0 });
    });
  });
});
