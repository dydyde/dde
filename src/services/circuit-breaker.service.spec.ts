// ============================================
// CircuitBreakerService 单元测试
// 
// 覆盖范围：
// - 空数据检测
// - 任务数骤降检测（L1/L2/L3 分级）
// - 必填字段校验
// - 熔断触发/恢复
// - 动态阈值计算
// ============================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  CircuitBreakerService, 
  CLIENT_CIRCUIT_BREAKER_CONFIG,
  CircuitBreakerValidation,
  CircuitLevel
} from './circuit-breaker.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Project, Task } from '../models';

// Mock Sentry
vi.mock('@sentry/angular', () => ({
  captureMessage: vi.fn(),
}));

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;
  let mockToast: { warning: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let mockLogger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  
  /**
   * 创建测试项目
   */
  function createProject(overrides: Partial<Project> = {}): Project {
    return {
      id: crypto.randomUUID(),
      name: 'Test Project',
      description: 'Test Description',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
      ...overrides,
    };
  }
  
  /**
   * 创建测试任务
   */
  function createTask(overrides: Partial<Task> = {}): Task {
    return {
      id: crypto.randomUUID(),
      title: 'Test Task',
      content: '',
      stage: 1,
      parentId: null,
      order: 1,
      rank: 10000,
      status: 'active',
      x: 100,
      y: 100,
      displayId: '1',
      createdDate: new Date().toISOString(),
      ...overrides,
    };
  }
  
  /**
   * 创建包含 N 个任务的项目
   */
  function createProjectWithTasks(taskCount: number, overrides: Partial<Project> = {}): Project {
    const tasks: Task[] = [];
    for (let i = 0; i < taskCount; i++) {
      tasks.push(createTask({ title: `Task ${i + 1}` }));
    }
    return createProject({ tasks, ...overrides });
  }
  
  beforeEach(() => {
    mockToast = {
      warning: vi.fn(),
      error: vi.fn(),
    };
    
    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    
    TestBed.configureTestingModule({
      providers: [
        CircuitBreakerService,
        {
          provide: ToastService,
          useValue: mockToast,
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLogger,
          },
        },
      ],
    });
    
    service = TestBed.inject(CircuitBreakerService);
  });
  
  describe('validateBeforeSync - 空数据检测', () => {
    it('新项目允许为空（首次同步）', () => {
      const project = createProject({ tasks: [] });
      // 没有设置 previousTaskCount，模拟首次同步
      const result = service.validateBeforeSync(project);
      
      expect(result.passed).toBe(true);
      expect(result.level).toBe('L0');
    });
    
    it('已有数据变为空时触发 L3 熔断', () => {
      const project = createProject({ tasks: [] });
      
      // 模拟之前有 15 个任务
      service.updateLastKnownTaskCount(project.id, 15);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.passed).toBe(false);
      expect(result.level).toBe('L3');
      expect(result.shouldBlock).toBe(true);
      expect(result.violations.some(v => v.rule === 'zero_task_count_from_existing')).toBe(true);
    });
    
    it('小项目（<10 任务）变为空也触发 L3 熔断', () => {
      const project = createProject({ tasks: [] });
      
      // 小项目只有 5 个任务
      service.updateLastKnownTaskCount(project.id, 5);
      
      const result = service.validateBeforeSync(project);
      
      // 小项目变为空仍然触发 L3（防止数据丢失）
      expect(result.passed).toBe(false);
      expect(result.level).toBe('L3');
    });
  });
  
  describe('validateBeforeSync - 任务数骤降检测', () => {
    it('任务数增加时不触发熔断', () => {
      const project = createProjectWithTasks(20);
      
      // 之前只有 15 个任务
      service.updateLastKnownTaskCount(project.id, 15);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.passed).toBe(true);
      expect(result.level).toBe('L0');
    });
    
    it('任务数下降 25% 触发 L1 警告', () => {
      // 从 20 个任务下降到 15 个（25% 下降）
      const project = createProjectWithTasks(15);
      service.updateLastKnownTaskCount(project.id, 20);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.level).toBe('L1');
      expect(result.passed).toBe(true); // L1 不阻止同步
      expect(result.shouldBlock).toBe(false);
    });
    
    it('任务数下降 60% 触发 L2 软熔断', () => {
      // 从 50 个任务下降到 20 个（60% 下降）
      const project = createProjectWithTasks(20);
      service.updateLastKnownTaskCount(project.id, 50);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.level).toBe('L2');
      expect(result.passed).toBe(false);
      expect(result.shouldBlock).toBe(true);
    });
    
    it('任务数下降 85% 触发 L3 硬熔断', () => {
      // 从 100 个任务下降到 15 个（85% 下降）
      const project = createProjectWithTasks(15);
      service.updateLastKnownTaskCount(project.id, 100);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.level).toBe('L3');
      expect(result.passed).toBe(false);
      expect(result.shouldBlock).toBe(true);
    });
    
    it('小项目使用绝对值阈值', () => {
      // 小项目从 8 个任务下降到 4 个（50% 下降）
      const project = createProjectWithTasks(4);
      service.updateLastKnownTaskCount(project.id, 8);
      
      const result = service.validateBeforeSync(project);
      
      // 小项目不使用比例阈值，应该通过
      expect(result.passed).toBe(true);
    });
    
    it('小项目完全删除触发 L3', () => {
      // 小项目从 8 个任务变为 0
      const project = createProject({ tasks: [] });
      service.updateLastKnownTaskCount(project.id, 8);
      
      const result = service.validateBeforeSync(project);
      
      expect(result.level).toBe('L3');
      expect(result.shouldBlock).toBe(true);
    });
  });
  
  describe('validateBeforeSync - 必填字段校验', () => {
    it('项目缺少名称触发违规', () => {
      const project = createProject({ name: '' });
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.some(v => v.rule === 'empty_project_name')).toBe(true);
    });
    
    it('任务缺少 ID 触发违规', () => {
      const taskWithoutId = createTask();
      (taskWithoutId as unknown as { id: string }).id = '';
      const project = createProject({ tasks: [taskWithoutId] });
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.some(v => v.rule === 'missing_required_field')).toBe(true);
    });
    
    it('任务缺少标题触发违规', () => {
      const taskWithoutTitle = createTask({ title: '' });
      const project = createProject({ tasks: [taskWithoutTitle] });
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.some(v => 
        v.rule === 'missing_required_field' && v.details['field'] === 'title'
      )).toBe(true);
    });
  });
  
  describe('validateBeforeSync - Schema 校验', () => {
    it('无效的项目 ID 格式触发违规', () => {
      const project = createProject();
      (project as unknown as { id: string }).id = 'invalid-id';
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.some(v => v.rule === 'schema_violation')).toBe(true);
    });
    
    it('有效的 UUID 格式通过校验', () => {
      const project = createProject({ tasks: [] });
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.filter(v => v.rule === 'schema_violation')).toHaveLength(0);
    });
  });
  
  describe('validateTask', () => {
    it('有效任务通过校验', () => {
      const task = createTask();
      const violations = service.validateTask(task);
      
      expect(violations).toHaveLength(0);
    });
    
    it('缺少必填字段返回违规', () => {
      const task = createTask({ title: '' });
      const violations = service.validateTask(task);
      
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].rule).toBe('missing_required_field');
    });
    
    it('无效 UUID 格式返回违规', () => {
      const task = createTask();
      (task as unknown as { id: string }).id = 'not-a-uuid';
      
      const violations = service.validateTask(task);
      
      expect(violations.some(v => v.rule === 'schema_violation')).toBe(true);
    });
  });
  
  describe('validateConnection', () => {
    it('有效连接通过校验', () => {
      const connection = {
        id: crypto.randomUUID(),
        source: crypto.randomUUID(),
        target: crypto.randomUUID(),
      };
      
      const violations = service.validateConnection(connection);
      
      expect(violations).toHaveLength(0);
    });
    
    it('缺少 source 返回违规', () => {
      const connection = {
        id: crypto.randomUUID(),
        source: '',
        target: crypto.randomUUID(),
      };
      
      const violations = service.validateConnection(connection);
      
      expect(violations.some(v => v.message.includes('source'))).toBe(true);
    });
    
    it('缺少 target 返回违规', () => {
      const connection = {
        id: crypto.randomUUID(),
        source: crypto.randomUUID(),
        target: '',
      };
      
      const violations = service.validateConnection(connection);
      
      expect(violations.some(v => v.message.includes('target'))).toBe(true);
    });
  });
  
  describe('熔断状态管理', () => {
    it('更新任务数量后记录正确', () => {
      const projectId = crypto.randomUUID();
      
      service.updateLastKnownTaskCount(projectId, 50);
      
      expect(service.getLastKnownTaskCount(projectId)).toBe(50);
    });
    
    it('重置熔断状态后恢复正常', () => {
      const project = createProject({ tasks: [] });
      service.updateLastKnownTaskCount(project.id, 50);
      
      // 触发熔断
      service.validateBeforeSync(project);
      expect(service.isCircuitOpen()).toBe(true);
      
      // 重置状态
      service.resetCircuitState(project.id);
      expect(service.isCircuitOpen()).toBe(false);
    });
    
    it('清除所有状态后完全重置', () => {
      const project = createProject({ tasks: [] });
      service.updateLastKnownTaskCount(project.id, 50);
      service.validateBeforeSync(project);
      
      service.clearAllCircuitStates();
      
      expect(service.isCircuitOpen()).toBe(false);
      expect(service.currentLevel()).toBe('L0');
      expect(service.getLastKnownTaskCount(project.id)).toBeUndefined();
    });
  });
  
  describe('熔断行为执行', () => {
    it('L1 触发 Sentry 警告但不显示 Toast', () => {
      // 从 20 个任务下降到 15 个（25% 下降）
      const project = createProjectWithTasks(15);
      service.updateLastKnownTaskCount(project.id, 20);
      
      service.validateBeforeSync(project);
      
      // L1 不显示 Toast
      expect(mockToast.warning).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });
    
    it('L2 显示 warning Toast', () => {
      // 从 50 个任务下降到 20 个（60% 下降）
      const project = createProjectWithTasks(20);
      service.updateLastKnownTaskCount(project.id, 50);
      
      service.validateBeforeSync(project);
      
      expect(mockToast.warning).toHaveBeenCalledWith(
        '同步已暂停',
        expect.stringContaining('异常数据变更')
      );
    });
    
    it('L3 显示 error Toast', () => {
      // 从 100 个任务变为 0
      const project = createProject({ tasks: [] });
      service.updateLastKnownTaskCount(project.id, 100);
      
      service.validateBeforeSync(project);
      
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('数据保护'),
        expect.stringContaining('导出'),
        expect.objectContaining({ duration: 0 })
      );
    });
  });
  
  describe('全局状态信号', () => {
    it('初始状态为关闭', () => {
      expect(service.isCircuitOpen()).toBe(false);
      expect(service.currentLevel()).toBe('L0');
    });
    
    it('L2 熔断后全局状态打开', () => {
      const project = createProjectWithTasks(20);
      service.updateLastKnownTaskCount(project.id, 50);
      
      service.validateBeforeSync(project);
      
      expect(service.isCircuitOpen()).toBe(true);
      expect(service.currentLevel()).toBe('L2');
    });
    
    it('多项目熔断取最高级别', () => {
      const project1 = createProjectWithTasks(15);
      const project2 = createProjectWithTasks(5);
      
      // project1 触发 L1
      service.updateLastKnownTaskCount(project1.id, 20);
      service.validateBeforeSync(project1);
      
      // project2 触发 L3
      service.updateLastKnownTaskCount(project2.id, 50);
      service.validateBeforeSync(project2);
      
      expect(service.currentLevel()).toBe('L3');
    });
  });
  
  describe('动态阈值计算', () => {
    it('大项目（1000+ 任务）阈值更宽松', () => {
      // 大项目从 1000 个任务下降到 150 个（85% 下降）
      // 由于动态阈值，85% 下降可能不会触发 L3
      const project = createProjectWithTasks(150);
      service.updateLastKnownTaskCount(project.id, 1000);
      
      const result = service.validateBeforeSync(project);
      
      // 动态阈值调整后，仍然应该触发熔断（因为下降太多）
      expect(result.shouldBlock).toBe(true);
    });
  });
  
  describe('边界条件', () => {
    it('previousTaskCount 为 0 时不触发骤降检测', () => {
      const project = createProjectWithTasks(10);
      // 不设置 previousTaskCount，模拟首次同步
      
      const result = service.validateBeforeSync(project);
      
      expect(result.passed).toBe(true);
    });
    
    it('传入 previousTaskCount 参数覆盖内部记录', () => {
      const project = createProjectWithTasks(20);
      
      // 内部记录为 30
      service.updateLastKnownTaskCount(project.id, 30);
      
      // 传入参数为 100，应该使用传入的值
      const result = service.validateBeforeSync(project, 100);
      
      // 从 100 下降到 20（80% 下降）应该触发 L3
      expect(result.level).toBe('L3');
    });
    
    it('空项目但有名称不触发空名称违规', () => {
      const project = createProject({ name: 'Valid Name', tasks: [] });
      
      const result = service.validateBeforeSync(project);
      
      expect(result.violations.filter(v => v.rule === 'empty_project_name')).toHaveLength(0);
    });
  });
});
