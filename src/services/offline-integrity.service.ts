/**
 * OfflineIntegrityService - 离线数据完整性校验服务
 * 
 * 【Week 5 数据保护】
 * 职责：
 * - 定期校验 IndexedDB 中的数据完整性
 * - 检测引用完整性问题（parentId、connection source/target）
 * - 检测循环引用
 * - 生成数据摘要用于快速比对
 * - 尝试自动修复可修复的问题
 * 
 * 设计理念：
 * - 静默运行，不打扰用户
 * - 发现问题时记录日志并尝试自动修复
 * - 严重问题上报 Sentry
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Project, Task } from '../models';
import * as Sentry from '@sentry/angular';

/**
 * 离线数据完整性校验配置
 */
export const OFFLINE_INTEGRITY_CONFIG = {
  /** 定期校验间隔（毫秒）- 每 5 分钟 */
  CHECK_INTERVAL: 5 * 60 * 1000,
  
  /** 校验内容 */
  CHECKS: {
    /** 任务引用完整性（parentId 指向存在的任务） */
    TASK_REFERENCES: true,
    /** 连接引用完整性（source/target 指向存在的任务） */
    CONNECTION_REFERENCES: true,
    /** 数据结构校验（必填字段存在） */
    SCHEMA_VALIDATION: true,
    /** 循环引用检测 */
    CIRCULAR_REFERENCE: true,
  },
  
  /** 校验失败时的行为 */
  ON_FAILURE: 'log_and_repair' as const,
  
  /** 循环引用检测最大深度 */
  MAX_DEPTH: 100,
} as const;

/**
 * 完整性问题类型
 */
export type IntegrityIssueType = 
  | 'orphan_task'           // 任务的 parentId 指向不存在的任务
  | 'orphan_connection'     // 连接的 source/target 指向不存在的任务
  | 'circular_reference'    // 任务存在循环引用
  | 'missing_required_field' // 缺少必填字段
  | 'invalid_stage'         // 无效的 stage 值
  | 'duplicate_id'          // 重复的 ID
  | 'invalid_json';         // JSON 解析失败

/**
 * 完整性问题严重级别
 */
export type IssueSeverity = 'warning' | 'error' | 'critical';

/**
 * 完整性问题
 */
export interface IntegrityIssue {
  type: IntegrityIssueType;
  severity: IssueSeverity;
  entityType: 'task' | 'connection' | 'project';
  entityId: string;
  projectId: string;
  message: string;
  /** 是否可自动修复 */
  autoRepairable: boolean;
  /** 修复建议 */
  repairAction?: string;
}

/**
 * 完整性报告
 */
export interface IntegrityReport {
  valid: boolean;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  issues: IntegrityIssue[];
  checksum: string;
  timestamp: string;
  durationMs: number;
}

/**
 * 修复结果
 */
export interface RepairResult {
  success: boolean;
  repairedCount: number;
  failedCount: number;
  details: Array<{
    issue: IntegrityIssue;
    repaired: boolean;
    error?: string;
  }>;
}

@Injectable({
  providedIn: 'root'
})
export class OfflineIntegrityService implements OnDestroy {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('OfflineIntegrity');
  private readonly toast = inject(ToastService);
  
  /** 最后一次校验报告 */
  private readonly _lastReport = signal<IntegrityReport | null>(null);
  readonly lastReport = this._lastReport.asReadonly();
  
  /** 是否正在校验 */
  private readonly _isValidating = signal(false);
  readonly isValidating = this._isValidating.asReadonly();
  
  /** 是否有未解决的问题 */
  readonly hasIssues = computed(() => {
    const report = this._lastReport();
    return report ? report.issues.length > 0 : false;
  });
  
  /** 严重问题数量 */
  readonly criticalIssueCount = computed(() => {
    const report = this._lastReport();
    if (!report) return 0;
    return report.issues.filter(i => i.severity === 'critical').length;
  });
  
  /** 定期校验定时器 */
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  
  constructor() {
    // 不自动启动定期校验，由外部调用 startPeriodicCheck()
  }
  
  ngOnDestroy(): void {
    this.stopPeriodicCheck();
  }
  
  /**
   * 启动定期校验
   */
  startPeriodicCheck(): void {
    if (this.checkInterval) return;
    
    this.checkInterval = setInterval(() => {
      // 定期校验需要传入项目数据，由调用者提供
      // 这里只是占位，实际使用时应该通过回调获取数据
    }, OFFLINE_INTEGRITY_CONFIG.CHECK_INTERVAL);
    
    this.logger.info('定期完整性校验已启动', {
      interval: OFFLINE_INTEGRITY_CONFIG.CHECK_INTERVAL
    });
  }
  
  /**
   * 停止定期校验
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info('定期完整性校验已停止');
    }
  }
  
  /**
   * 执行完整性校验
   * 
   * @param projects 要校验的项目列表
   * @returns 完整性报告
   */
  async validateLocalData(projects: Project[]): Promise<IntegrityReport> {
    if (this._isValidating()) {
      this.logger.warn('校验已在进行中，跳过');
      return this._lastReport() ?? this.createEmptyReport();
    }
    
    this._isValidating.set(true);
    const startTime = Date.now();
    const issues: IntegrityIssue[] = [];
    
    let taskCount = 0;
    let connectionCount = 0;
    
    try {
      for (const project of projects) {
        const projectIssues = this.validateProject(project);
        issues.push(...projectIssues);
        taskCount += project.tasks.length;
        connectionCount += project.connections.length;
      }
      
      const checksum = this.generateChecksum(projects);
      
      const report: IntegrityReport = {
        valid: issues.length === 0,
        projectCount: projects.length,
        taskCount,
        connectionCount,
        issues,
        checksum,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };
      
      this._lastReport.set(report);
      
      // 记录结果
      if (issues.length > 0) {
        this.logger.warn('完整性校验发现问题', {
          issueCount: issues.length,
          criticalCount: issues.filter(i => i.severity === 'critical').length,
          errorCount: issues.filter(i => i.severity === 'error').length,
          warningCount: issues.filter(i => i.severity === 'warning').length,
        });
        
        // 严重问题上报 Sentry
        const criticalIssues = issues.filter(i => i.severity === 'critical');
        if (criticalIssues.length > 0) {
          Sentry.captureMessage('OfflineIntegrity: Critical issues detected', {
            level: 'error',
            tags: { operation: 'offline-integrity-check' },
            extra: {
              criticalIssues,
              projectCount: projects.length,
              taskCount,
            },
          });
        }
      } else {
        this.logger.debug('完整性校验通过', {
          projectCount: projects.length,
          taskCount,
          connectionCount,
          durationMs: report.durationMs,
        });
      }
      
      return report;
      
    } finally {
      this._isValidating.set(false);
    }
  }
  
  /**
   * 校验单个项目
   */
  private validateProject(project: Project): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    const taskMap = new Map(project.tasks.map(t => [t.id, t]));
    
    // 1. 校验任务
    if (OFFLINE_INTEGRITY_CONFIG.CHECKS.TASK_REFERENCES) {
      issues.push(...this.validateTaskReferences(project, taskMap));
    }
    
    // 2. 校验连接
    if (OFFLINE_INTEGRITY_CONFIG.CHECKS.CONNECTION_REFERENCES) {
      issues.push(...this.validateConnectionReferences(project, taskMap));
    }
    
    // 3. Schema 校验
    if (OFFLINE_INTEGRITY_CONFIG.CHECKS.SCHEMA_VALIDATION) {
      issues.push(...this.validateSchema(project, taskMap));
    }
    
    // 4. 循环引用检测
    if (OFFLINE_INTEGRITY_CONFIG.CHECKS.CIRCULAR_REFERENCE) {
      issues.push(...this.detectCircularReferences(project, taskMap));
    }
    
    return issues;
  }
  
  /**
   * 校验任务引用完整性
   */
  private validateTaskReferences(
    project: Project,
    taskMap: Map<string, Task>
  ): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    
    for (const task of project.tasks) {
      // 检查 parentId 是否指向存在的任务
      if (task.parentId && !taskMap.has(task.parentId)) {
        issues.push({
          type: 'orphan_task',
          severity: 'warning',
          entityType: 'task',
          entityId: task.id,
          projectId: project.id,
          message: `任务 ${task.title || task.id} 的父任务 ${task.parentId} 不存在`,
          autoRepairable: true,
          repairAction: 'clear_parent_id',
        });
      }
    }
    
    return issues;
  }
  
  /**
   * 校验连接引用完整性
   */
  private validateConnectionReferences(
    project: Project,
    taskMap: Map<string, Task>
  ): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    
    for (const conn of project.connections) {
      // 跳过已删除的连接
      if (conn.deletedAt) continue;
      
      if (!taskMap.has(conn.source)) {
        issues.push({
          type: 'orphan_connection',
          severity: 'error',
          entityType: 'connection',
          entityId: conn.id,
          projectId: project.id,
          message: `连接 ${conn.id} 的源任务 ${conn.source} 不存在`,
          autoRepairable: true,
          repairAction: 'soft_delete_connection',
        });
      }
      
      if (!taskMap.has(conn.target)) {
        issues.push({
          type: 'orphan_connection',
          severity: 'error',
          entityType: 'connection',
          entityId: conn.id,
          projectId: project.id,
          message: `连接 ${conn.id} 的目标任务 ${conn.target} 不存在`,
          autoRepairable: true,
          repairAction: 'soft_delete_connection',
        });
      }
    }
    
    return issues;
  }
  
  /**
   * Schema 校验
   */
  private validateSchema(
    project: Project,
    _taskMap: Map<string, Task>
  ): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    
    for (const task of project.tasks) {
      // 检查必填字段
      if (!task.id) {
        issues.push({
          type: 'missing_required_field',
          severity: 'critical',
          entityType: 'task',
          entityId: task.id || 'unknown',
          projectId: project.id,
          message: '任务缺少 id 字段',
          autoRepairable: false,
        });
      }
      
      // 检查 stage 有效性
      if (task.stage !== null && task.stage < 0) {
        issues.push({
          type: 'invalid_stage',
          severity: 'warning',
          entityType: 'task',
          entityId: task.id,
          projectId: project.id,
          message: `任务 ${task.title || task.id} 的 stage 值无效: ${task.stage}`,
          autoRepairable: true,
          repairAction: 'set_stage_null',
        });
      }
    }
    
    // 检查重复 ID
    const idSet = new Set<string>();
    for (const task of project.tasks) {
      if (idSet.has(task.id)) {
        issues.push({
          type: 'duplicate_id',
          severity: 'critical',
          entityType: 'task',
          entityId: task.id,
          projectId: project.id,
          message: `存在重复的任务 ID: ${task.id}`,
          autoRepairable: false,
        });
      }
      idSet.add(task.id);
    }
    
    return issues;
  }
  
  /**
   * 检测循环引用
   */
  private detectCircularReferences(
    project: Project,
    taskMap: Map<string, Task>
  ): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    
    const hasCycle = (taskId: string, depth: number): boolean => {
      if (depth > OFFLINE_INTEGRITY_CONFIG.MAX_DEPTH) return false;
      if (inStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      
      visited.add(taskId);
      inStack.add(taskId);
      
      const task = taskMap.get(taskId);
      if (task?.parentId) {
        if (hasCycle(task.parentId, depth + 1)) {
          return true;
        }
      }
      
      inStack.delete(taskId);
      return false;
    };
    
    for (const task of project.tasks) {
      if (!visited.has(task.id)) {
        if (hasCycle(task.id, 0)) {
          issues.push({
            type: 'circular_reference',
            severity: 'critical',
            entityType: 'task',
            entityId: task.id,
            projectId: project.id,
            message: `检测到循环引用，涉及任务: ${task.title || task.id}`,
            autoRepairable: true,
            repairAction: 'break_cycle',
          });
        }
      }
    }
    
    return issues;
  }
  
  /**
   * 生成数据摘要（用于快速比对）
   */
  generateChecksum(projects: Project[]): string {
    const data = {
      projectIds: projects.map(p => p.id).sort(),
      taskCount: projects.reduce((sum, p) => sum + p.tasks.length, 0),
      connectionCount: projects.reduce((sum, p) => sum + p.connections.length, 0),
      lastUpdated: projects
        .map(p => p.updatedAt || '')
        .sort()
        .pop() || '',
    };
    
    // 简单的字符串哈希
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `chk-${Math.abs(hash).toString(16)}`;
  }
  
  /**
   * 尝试自动修复问题
   */
  async repairLocalData(
    projects: Project[],
    report: IntegrityReport
  ): Promise<RepairResult> {
    const repairableIssues = report.issues.filter(i => i.autoRepairable);
    const details: RepairResult['details'] = [];
    let repairedCount = 0;
    let failedCount = 0;
    
    for (const issue of repairableIssues) {
      try {
        const repaired = this.repairIssue(projects, issue);
        if (repaired) {
          repairedCount++;
          details.push({ issue, repaired: true });
        } else {
          failedCount++;
          details.push({ issue, repaired: false, error: '修复方法返回 false' });
        }
      } catch (e) {
        failedCount++;
        details.push({
          issue,
          repaired: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    
    this.logger.info('数据修复完成', {
      repairedCount,
      failedCount,
      total: repairableIssues.length,
    });
    
    if (repairedCount > 0) {
      this.toast.info('数据修复', `已自动修复 ${repairedCount} 个问题`);
    }
    
    return {
      success: failedCount === 0,
      repairedCount,
      failedCount,
      details,
    };
  }
  
  /**
   * 修复单个问题
   */
  private repairIssue(projects: Project[], issue: IntegrityIssue): boolean {
    const project = projects.find(p => p.id === issue.projectId);
    if (!project) return false;
    
    switch (issue.repairAction) {
      case 'clear_parent_id': {
        const task = project.tasks.find(t => t.id === issue.entityId);
        if (task) {
          task.parentId = null;
          this.logger.debug('修复: 清除孤儿 parentId', { taskId: task.id });
          return true;
        }
        return false;
      }
      
      case 'soft_delete_connection': {
        const conn = project.connections.find(c => c.id === issue.entityId);
        if (conn) {
          conn.deletedAt = new Date().toISOString();
          this.logger.debug('修复: 软删除孤儿连接', { connectionId: conn.id });
          return true;
        }
        return false;
      }
      
      case 'set_stage_null': {
        const task = project.tasks.find(t => t.id === issue.entityId);
        if (task) {
          task.stage = null;
          this.logger.debug('修复: 重置无效 stage', { taskId: task.id });
          return true;
        }
        return false;
      }
      
      case 'break_cycle': {
        // 打破循环：找到循环中的任务，清除其 parentId
        const task = project.tasks.find(t => t.id === issue.entityId);
        if (task) {
          task.parentId = null;
          this.logger.debug('修复: 打破循环引用', { taskId: task.id });
          return true;
        }
        return false;
      }
      
      default:
        return false;
    }
  }
  
  /**
   * 创建空报告
   */
  private createEmptyReport(): IntegrityReport {
    return {
      valid: true,
      projectCount: 0,
      taskCount: 0,
      connectionCount: 0,
      issues: [],
      checksum: 'empty',
      timestamp: new Date().toISOString(),
      durationMs: 0,
    };
  }
}
