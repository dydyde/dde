/**
 * ToastService 单元测试
 * 
 * 测试覆盖：
 * - 显示不同类型的 Toast (success/error/warning/info)
 * - 错误去重机制
 * - Toast 自动消失
 * - 消息合并
 * - 手动关闭
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToastService, ToastMessage } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;
  
  beforeEach(() => {
    vi.useFakeTimers();
    
    TestBed.configureTestingModule({
      providers: [ToastService],
    });
    
    service = TestBed.inject(ToastService);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  describe('初始状态', () => {
    it('消息列表应为空', () => {
      expect(service.messages()).toHaveLength(0);
      expect(service.hasMessages()).toBe(false);
    });
  });
  
  describe('显示消息', () => {
    it('success 应添加成功类型消息', () => {
      service.success('操作成功');
      
      expect(service.hasMessages()).toBe(true);
      expect(service.messages()).toHaveLength(1);
      expect(service.messages()[0].type).toBe('success');
      expect(service.messages()[0].title).toBe('操作成功');
    });
    
    it('error 应添加错误类型消息', () => {
      service.error('操作失败', '请重试');
      
      expect(service.messages()).toHaveLength(1);
      expect(service.messages()[0].type).toBe('error');
      expect(service.messages()[0].title).toBe('操作失败');
      expect(service.messages()[0].message).toBe('请重试');
    });
    
    it('warning 应添加警告类型消息', () => {
      service.warning('注意');
      
      expect(service.messages()[0].type).toBe('warning');
    });
    
    it('info 应添加信息类型消息', () => {
      service.info('提示信息');
      
      expect(service.messages()[0].type).toBe('info');
    });
    
    it('可以指定自定义持续时间', () => {
      service.success('快速消息', undefined, 1000);
      
      expect(service.messages()[0].duration).toBe(1000);
    });
    
    it('可以通过 options 对象指定持续时间', () => {
      service.success('自定义时长', undefined, { duration: 2000 });
      
      expect(service.messages()[0].duration).toBe(2000);
    });
  });
  
  describe('自动消失', () => {
    it('消息应在指定时间后自动消失', () => {
      service.success('临时消息', undefined, 3000);
      expect(service.hasMessages()).toBe(true);
      
      // 推进时间
      vi.advanceTimersByTime(3000);
      
      expect(service.hasMessages()).toBe(false);
    });
    
    it('多个消息应分别在各自的时间后消失', () => {
      service.success('消息1', undefined, 1000);
      service.success('消息2', undefined, 2000);
      expect(service.messages()).toHaveLength(2);
      
      vi.advanceTimersByTime(1000);
      expect(service.messages()).toHaveLength(1);
      
      vi.advanceTimersByTime(1000);
      expect(service.messages()).toHaveLength(0);
    });
  });
  
  describe('错误去重', () => {
    it('相同错误在短时间内不应重复显示', () => {
      service.error('相同错误');
      service.error('相同错误');
      service.error('相同错误');
      
      // 由于消息合并和去重，只应有一个消息
      expect(service.messages()).toHaveLength(1);
    });
    
    it('不同错误应分别显示', () => {
      service.error('错误1');
      service.error('错误2');
      
      expect(service.messages()).toHaveLength(2);
    });
    
    it('相同标题但不同消息应视为不同错误', () => {
      service.error('错误', '详情1');
      service.error('错误', '详情2');
      
      expect(service.messages()).toHaveLength(2);
    });
  });
  
  describe('消息合并', () => {
    it('相同的消息应合并而不是重复添加', () => {
      service.success('相同消息');
      service.success('相同消息');
      
      expect(service.messages()).toHaveLength(1);
    });
    
    it('不同类型的相同消息不应合并', () => {
      service.success('消息');
      service.warning('消息');
      
      expect(service.messages()).toHaveLength(2);
    });
  });
  
  describe('手动关闭', () => {
    it('dismiss 应移除指定的消息', () => {
      service.success('消息1');
      service.success('消息2');
      
      const firstMessageId = service.messages()[0].id;
      service.dismiss(firstMessageId);
      
      expect(service.messages()).toHaveLength(1);
      expect(service.messages()[0].title).toBe('消息2');
    });
    
    it('dismissAll 应移除所有消息', () => {
      service.success('消息1');
      service.error('消息2');
      service.warning('消息3');
      expect(service.messages()).toHaveLength(3);
      
      service.dismissAll();
      
      expect(service.messages()).toHaveLength(0);
    });
  });
  
  describe('操作按钮', () => {
    it('可以添加操作按钮', () => {
      const mockAction = vi.fn();
      
      service.error('可操作消息', undefined, {
        action: {
          label: '重试',
          onClick: mockAction,
        },
      });
      
      const toast = service.messages()[0];
      expect(toast.action).toBeDefined();
      expect(toast.action?.label).toBe('重试');
      
      // 模拟点击
      toast.action?.onClick();
      expect(mockAction).toHaveBeenCalled();
    });
  });
});
