import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { 
  OfflineIntegrityService, 
  IntegrityReport,
  OFFLINE_INTEGRITY_CONFIG 
} from './offline-integrity.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';

describe('OfflineIntegrityService', () => {
  let service: OfflineIntegrityService;
  let mockToast: { warning: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  
  beforeEach(() => {
    mockToast = {
      warning: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    
    const loggerMethods = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const mockLogger = {
      category: () => loggerMethods
    };
    
    TestBed.configureTestingModule({
      providers: [
        OfflineIntegrityService,
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLogger },
      ]
    });
    
    service = TestBed.inject(OfflineIntegrityService);
  });
  
  // 辅助函数：创建测试项目
  function createTestProject(overrides: Partial<Project> = {}): Project {
    return {
      id: 'project-1',
      name: 'Test Project',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
      ...overrides,
    };
  }
  
  // 辅助函数：创建测试任务
  function createTestTask(overrides: Partial<Task> = {}): Task {
    return {
      id: crypto.randomUUID(),
      title: 'Test Task',
      content: '',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: new Date().toISOString(),
      ...overrides,
    };
  }
  
  // 辅助函数：创建测试连接
  function createTestConnection(overrides: Partial<Connection> = {}): Connection {
    return {
      id: crypto.randomUUID(),
      source: 'task-1',
      target: 'task-2',
      ...overrides,
    };
  }
  
  describe('validateLocalData', () => {
    it('空项目列表应返回有效报告', async () => {
      const report = await service.validateLocalData([]);
      
      expect(report.valid).toBe(true);
      expect(report.projectCount).toBe(0);
      expect(report.taskCount).toBe(0);
      expect(report.issues).toHaveLength(0);
    });
    
    it('有效项目应返回无问题报告', async () => {
      const task1 = createTestTask({ id: 'task-1' });
      const task2 = createTestTask({ id: 'task-2', parentId: 'task-1' });
      const project = createTestProject({
        tasks: [task1, task2],
        connections: [],
      });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(true);
      expect(report.taskCount).toBe(2);
      expect(report.issues).toHaveLength(0);
    });
    
    it('应检测孤儿任务（parentId 指向不存在的任务）', async () => {
      const task = createTestTask({ 
        id: 'task-1', 
        parentId: 'nonexistent-parent' 
      });
      const project = createTestProject({ tasks: [task] });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      expect(report.issues).toHaveLength(1);
      expect(report.issues[0].type).toBe('orphan_task');
      expect(report.issues[0].autoRepairable).toBe(true);
    });
    
    it('应检测孤儿连接（source 不存在）', async () => {
      const task = createTestTask({ id: 'task-1' });
      const conn = createTestConnection({ 
        source: 'nonexistent', 
        target: 'task-1' 
      });
      const project = createTestProject({ 
        tasks: [task], 
        connections: [conn] 
      });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      const orphanIssues = report.issues.filter(i => i.type === 'orphan_connection');
      expect(orphanIssues.length).toBeGreaterThan(0);
    });
    
    it('应检测孤儿连接（target 不存在）', async () => {
      const task = createTestTask({ id: 'task-1' });
      const conn = createTestConnection({ 
        source: 'task-1', 
        target: 'nonexistent' 
      });
      const project = createTestProject({ 
        tasks: [task], 
        connections: [conn] 
      });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      const orphanIssues = report.issues.filter(i => i.type === 'orphan_connection');
      expect(orphanIssues.length).toBeGreaterThan(0);
    });
    
    it('应跳过已删除的连接', async () => {
      const task = createTestTask({ id: 'task-1' });
      const conn = createTestConnection({ 
        source: 'nonexistent', 
        target: 'task-1',
        deletedAt: new Date().toISOString(),
      });
      const project = createTestProject({ 
        tasks: [task], 
        connections: [conn] 
      });
      
      const report = await service.validateLocalData([project]);
      
      // 已删除的连接不应报告问题
      const orphanIssues = report.issues.filter(i => i.type === 'orphan_connection');
      expect(orphanIssues).toHaveLength(0);
    });
    
    it('应检测循环引用', async () => {
      const task1 = createTestTask({ id: 'task-1', parentId: 'task-2' });
      const task2 = createTestTask({ id: 'task-2', parentId: 'task-1' });
      const project = createTestProject({ tasks: [task1, task2] });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      const circularIssues = report.issues.filter(i => i.type === 'circular_reference');
      expect(circularIssues.length).toBeGreaterThan(0);
    });
    
    it('应检测无效的 stage 值', async () => {
      const task = createTestTask({ id: 'task-1', stage: -5 });
      const project = createTestProject({ tasks: [task] });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      const stageIssues = report.issues.filter(i => i.type === 'invalid_stage');
      expect(stageIssues).toHaveLength(1);
    });
    
    it('应检测重复的任务 ID', async () => {
      const task1 = createTestTask({ id: 'duplicate-id' });
      const task2 = createTestTask({ id: 'duplicate-id' });
      const project = createTestProject({ tasks: [task1, task2] });
      
      const report = await service.validateLocalData([project]);
      
      expect(report.valid).toBe(false);
      const duplicateIssues = report.issues.filter(i => i.type === 'duplicate_id');
      expect(duplicateIssues).toHaveLength(1);
    });
  });
  
  describe('generateChecksum', () => {
    it('应为相同数据生成相同的 checksum', () => {
      const project = createTestProject({ id: 'proj-1' });
      
      const checksum1 = service.generateChecksum([project]);
      const checksum2 = service.generateChecksum([project]);
      
      expect(checksum1).toBe(checksum2);
    });
    
    it('应为不同数据生成不同的 checksum', () => {
      const project1 = createTestProject({ id: 'proj-1' });
      const project2 = createTestProject({ id: 'proj-2' });
      
      const checksum1 = service.generateChecksum([project1]);
      const checksum2 = service.generateChecksum([project2]);
      
      expect(checksum1).not.toBe(checksum2);
    });
    
    it('checksum 应以 "chk-" 前缀开头', () => {
      const project = createTestProject();
      const checksum = service.generateChecksum([project]);
      
      expect(checksum).toMatch(/^chk-[0-9a-f]+$/);
    });
  });
  
  describe('repairLocalData', () => {
    it('应修复孤儿任务（清除 parentId）', async () => {
      const task = createTestTask({ 
        id: 'task-1', 
        parentId: 'nonexistent' 
      });
      const project = createTestProject({ tasks: [task] });
      
      const report = await service.validateLocalData([project]);
      expect(report.issues).toHaveLength(1);
      
      const result = await service.repairLocalData([project], report);
      
      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(1);
      expect(task.parentId).toBeNull();
    });
    
    it('应修复孤儿连接（软删除）', async () => {
      const task = createTestTask({ id: 'task-1' });
      const conn = createTestConnection({ 
        id: 'conn-1',
        source: 'nonexistent', 
        target: 'task-1' 
      });
      const project = createTestProject({ 
        tasks: [task], 
        connections: [conn] 
      });
      
      const report = await service.validateLocalData([project]);
      const result = await service.repairLocalData([project], report);
      
      expect(result.repairedCount).toBeGreaterThan(0);
      expect(conn.deletedAt).toBeDefined();
    });
    
    it('应修复无效的 stage', async () => {
      const task = createTestTask({ id: 'task-1', stage: -10 });
      const project = createTestProject({ tasks: [task] });
      
      const report = await service.validateLocalData([project]);
      const result = await service.repairLocalData([project], report);
      
      expect(result.repairedCount).toBe(1);
      expect(task.stage).toBeNull();
    });
    
    it('不可修复的问题应报告失败', async () => {
      // 创建一个不可自动修复的报告
      const report: IntegrityReport = {
        valid: false,
        projectCount: 1,
        taskCount: 1,
        connectionCount: 0,
        issues: [{
          type: 'duplicate_id',
          severity: 'critical',
          entityType: 'task',
          entityId: 'task-1',
          projectId: 'project-1',
          message: '重复 ID',
          autoRepairable: false,
        }],
        checksum: 'test',
        timestamp: new Date().toISOString(),
        durationMs: 0,
      };
      
      const result = await service.repairLocalData([], report);
      
      // 不可修复的问题不应该被计入 repairedCount
      expect(result.repairedCount).toBe(0);
    });
  });
  
  describe('状态信号', () => {
    it('初始状态应无问题', () => {
      expect(service.hasIssues()).toBe(false);
      expect(service.criticalIssueCount()).toBe(0);
      expect(service.isValidating()).toBe(false);
    });
    
    it('校验后应更新 lastReport', async () => {
      const project = createTestProject();
      
      await service.validateLocalData([project]);
      
      expect(service.lastReport()).not.toBeNull();
      expect(service.lastReport()?.projectCount).toBe(1);
    });
  });
  
  describe('定期校验', () => {
    it('应能启动和停止定期校验', () => {
      expect(() => service.startPeriodicCheck()).not.toThrow();
      expect(() => service.stopPeriodicCheck()).not.toThrow();
    });
    
    it('多次启动应该是安全的', () => {
      service.startPeriodicCheck();
      service.startPeriodicCheck();
      service.stopPeriodicCheck();
    });
  });
});
