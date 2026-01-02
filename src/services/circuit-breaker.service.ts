// ============================================
// CircuitBreakerService - 客户端熔断保护服务
// 
// 职责：
// - 空数据拒写校验
// - 任务数骤降检测（L1/L2/L3 分级）
// - 必填字段校验
// - 熔断状态管理与恢复
// 
// 设计原则（来自 data-protection-plan.md）：
// - 永不主动丢弃用户数据
// - 熔断分级：L1 警告 → L2 软熔断 → L3 硬熔断
// - 使用绝对值+相对值结合的阈值策略
// ============================================

import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project, Task, Connection } from '../models';
import * as Sentry from '@sentry/angular';

/**
 * 熔断分级配置
 * 
 * 【策划案 v5.5】：
 * - L1 警告：下降 20-50%，记录日志 + Sentry 警告
 * - L2 软熔断：下降 50-80%，阻止同步 + Toast 提示
 * - L3 硬熔断：下降 >80% 或归零，阻止 + 强制导出提示
 */
export const CLIENT_CIRCUIT_BREAKER_CONFIG = {
  // 规则 1: 空数据拒写
  REJECT_EMPTY_DATA: true,
  
  // 规则 2: 任务数骤降阈值 - 使用绝对值+相对值结合
  TASK_COUNT_DROP_CONFIG: {
    /** L1 警告：下降 20-50% */
    L1_WARNING_THRESHOLD: 0.2,
    /** L2 软熔断：下降 50-80% */
    L2_SOFT_BLOCK_THRESHOLD: 0.5,
    /** L3 硬熔断：下降 >80% 或归零 */
    L3_HARD_BLOCK_THRESHOLD: 0.8,
    /** 绝对值阈值：小项目使用绝对值而非比例 */
    ABSOLUTE_DROP_THRESHOLD: 20,
    /** 最小任务数（低于此数量时使用绝对值） */
    MIN_TASK_COUNT_FOR_RATIO: 10,
    /** 动态阈值系数：项目越大，阈值越宽松 */
    DYNAMIC_THRESHOLD_FACTOR: 0.01,
  },
  
  // 规则 3: 最小任务数保护（防止全部删除）
  MIN_TASK_COUNT_PROTECTION: true,
  MIN_TASK_COUNT_THRESHOLD: 10,
  
  // 规则 4: 必要字段列表
  REQUIRED_TASK_FIELDS: ['id', 'title'] as const,
  REQUIRED_PROJECT_FIELDS: ['id', 'name'] as const,
  
  // 规则 5: Schema 结构校验
  VALIDATE_SCHEMA: true,
  
  // 规则 6: 熔断分级行为
  CIRCUIT_LEVELS: {
    L1: 'log_and_sentry',      // 记录日志 + Sentry 警告
    L2: 'block_and_toast',     // 阻止同步 + Toast 提示
    L3: 'block_and_export',    // 阻止 + 强制导出提示
  },
} as const;

/**
 * 熔断级别
 */
export type CircuitLevel = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * 熔断行为
 */
export type CircuitAction = 'none' | 'log' | 'toast' | 'export-prompt';

/**
 * 违规类型
 */
export type ViolationType = 
  | 'empty_project_name'
  | 'empty_data'
  | 'task_count_drop'
  | 'missing_required_field'
  | 'schema_violation'
  | 'zero_task_count_from_existing';

/**
 * 违规详情
 */
export interface CircuitBreakerViolation {
  /** 规则名称 */
  rule: ViolationType;
  /** 可读消息 */
  message: string;
  /** 额外详情 */
  details: Record<string, unknown>;
}

/**
 * 校验结果
 */
export interface CircuitBreakerValidation {
  /** 是否通过校验 */
  passed: boolean;
  /** 违规列表 */
  violations: CircuitBreakerViolation[];
  /** 熔断级别 */
  level: CircuitLevel;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 是否应该阻止同步 */
  shouldBlock: boolean;
  /** 建议操作 */
  suggestedAction: CircuitAction;
}

/**
 * 任务数历史记录
 */
interface TaskCountHistory {
  projectId: string;
  counts: number[];
  lastUpdated: number;
}

@Injectable({
  providedIn: 'root'
})
export class CircuitBreakerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('CircuitBreaker');
  private readonly toast = inject(ToastService);
  
  /**
   * 上次已知的任务数量（按项目 ID）
   */
  private lastKnownTaskCounts = new Map<string, number>();
  
  /**
   * 任务数历史记录（用于动态阈值计算）
   */
  private taskCountHistory = new Map<string, TaskCountHistory>();
  
  /**
   * 熔断状态（按项目 ID）
   */
  private circuitStates = new Map<string, CircuitLevel>();
  
  /**
   * 全局熔断状态
   */
  readonly isCircuitOpen = signal(false);
  
  /**
   * 当前熔断级别
   */
  readonly currentLevel = signal<CircuitLevel>('L0');
  
  /**
   * 是否启用熔断保护
   */
  readonly isEnabled = computed(() => FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED);
  
  /**
   * 是否启用 L3 硬熔断
   */
  readonly isL3Enabled = computed(() => FEATURE_FLAGS.CIRCUIT_BREAKER_L3_ENABLED);
  
  /**
   * 同步前校验
   * 
   * 【核心方法】在数据同步到云端之前调用此方法进行校验
   * 检测空数据、任务数骤降、必填字段缺失等异常情况
   * 
   * @param project 要同步的项目
   * @param previousTaskCount 可选，之前的任务数量（用于骤降检测）
   * @returns 校验结果
   */
  validateBeforeSync(
    project: Project,
    previousTaskCount?: number
  ): CircuitBreakerValidation {
    // 如果熔断功能被禁用，直接放行
    if (!FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED) {
      return this.createPassResult();
    }
    
    const violations: CircuitBreakerViolation[] = [];
    
    // 获取之前的任务数量
    const prevCount = previousTaskCount ?? this.lastKnownTaskCounts.get(project.id) ?? 0;
    const currentCount = project.tasks?.length ?? 0;
    
    // 规则 1: 项目名称不能为空
    if (!project.name || project.name.trim() === '') {
      violations.push({
        rule: 'empty_project_name',
        message: '项目名称不能为空',
        details: { projectId: project.id }
      });
    }
    
    // 规则 2: 空数据检测
    if (CLIENT_CIRCUIT_BREAKER_CONFIG.REJECT_EMPTY_DATA) {
      const emptyViolation = this.checkEmptyData(project, prevCount);
      if (emptyViolation) {
        violations.push(emptyViolation);
      }
    }
    
    // 规则 3: 任务数骤降检测
    const dropViolation = this.checkTaskCountDrop(project.id, prevCount, currentCount);
    if (dropViolation) {
      violations.push(dropViolation);
    }
    
    // 规则 4: 必填字段校验
    const fieldViolations = this.validateRequiredFields(project);
    violations.push(...fieldViolations);
    
    // 规则 5: Schema 校验（可选）
    if (CLIENT_CIRCUIT_BREAKER_CONFIG.VALIDATE_SCHEMA) {
      const schemaViolations = this.validateSchema(project);
      violations.push(...schemaViolations);
    }
    
    // 更新历史记录
    this.updateTaskCountHistory(project.id, currentCount);
    
    // 计算最终结果
    const result = this.calculateResult(violations, project.id);
    
    // 执行熔断行为
    this.executeCircuitAction(result, project.id);
    
    return result;
  }
  
  /**
   * 验证单个任务
   */
  validateTask(task: Task): CircuitBreakerViolation[] {
    const violations: CircuitBreakerViolation[] = [];
    
    // 检查必填字段
    for (const field of CLIENT_CIRCUIT_BREAKER_CONFIG.REQUIRED_TASK_FIELDS) {
      const value = task[field as keyof Task];
      if (value === undefined || value === null || value === '') {
        violations.push({
          rule: 'missing_required_field',
          message: `任务缺少必填字段: ${field}`,
          details: { taskId: task.id, field }
        });
      }
    }
    
    // 检查 ID 格式（必须是 UUID）
    if (task.id && !this.isValidUUID(task.id)) {
      violations.push({
        rule: 'schema_violation',
        message: '任务 ID 格式无效（必须是 UUID）',
        details: { taskId: task.id }
      });
    }
    
    return violations;
  }
  
  /**
   * 验证连接
   */
  validateConnection(connection: Connection): CircuitBreakerViolation[] {
    const violations: CircuitBreakerViolation[] = [];
    
    // 检查必填字段
    if (!connection.id) {
      violations.push({
        rule: 'missing_required_field',
        message: '连接缺少 ID',
        details: { connection }
      });
    }
    
    if (!connection.source) {
      violations.push({
        rule: 'missing_required_field',
        message: '连接缺少 source',
        details: { connectionId: connection.id }
      });
    }
    
    if (!connection.target) {
      violations.push({
        rule: 'missing_required_field',
        message: '连接缺少 target',
        details: { connectionId: connection.id }
      });
    }
    
    return violations;
  }
  
  /**
   * 更新已知任务数量
   * 
   * 在成功同步后调用，更新基准值
   */
  updateLastKnownTaskCount(projectId: string, count: number): void {
    this.lastKnownTaskCounts.set(projectId, count);
    this.updateTaskCountHistory(projectId, count);
  }
  
  /**
   * 获取已知任务数量
   */
  getLastKnownTaskCount(projectId: string): number | undefined {
    return this.lastKnownTaskCounts.get(projectId);
  }
  
  /**
   * 重置项目的熔断状态
   */
  resetCircuitState(projectId: string): void {
    this.circuitStates.delete(projectId);
    this.updateGlobalState();
  }
  
  /**
   * 清除所有熔断状态
   */
  clearAllCircuitStates(): void {
    this.circuitStates.clear();
    this.lastKnownTaskCounts.clear();
    this.taskCountHistory.clear();
    this.isCircuitOpen.set(false);
    this.currentLevel.set('L0');
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 检查空数据
   */
  private checkEmptyData(
    project: Project,
    previousCount: number
  ): CircuitBreakerViolation | null {
    const currentCount = project.tasks?.length ?? 0;
    
    // 如果之前有数据，现在变成空的，这是异常情况
    if (previousCount > CLIENT_CIRCUIT_BREAKER_CONFIG.MIN_TASK_COUNT_THRESHOLD && currentCount === 0) {
      return {
        rule: 'zero_task_count_from_existing',
        message: `项目从 ${previousCount} 个任务变为 0 个，疑似数据丢失`,
        details: {
          projectId: project.id,
          previousCount,
          currentCount,
        }
      };
    }
    
    // 全新项目允许为空（previousCount === 0 && currentCount === 0）
    return null;
  }
  
  /**
   * 检查任务数骤降
   * 
   * 【策划案设计】使用绝对值 + 相对值结合：
   * - 小项目（<10 任务）使用绝对值阈值
   * - 大项目使用相对值阈值
   * - 动态阈值：项目越大，容忍度越高
   */
  private checkTaskCountDrop(
    projectId: string,
    previousCount: number,
    currentCount: number
  ): CircuitBreakerViolation | null {
    // 无变化或增加，不触发
    if (currentCount >= previousCount) {
      return null;
    }
    
    // 之前为空，不触发
    if (previousCount === 0) {
      return null;
    }
    
    const config = CLIENT_CIRCUIT_BREAKER_CONFIG.TASK_COUNT_DROP_CONFIG;
    const dropCount = previousCount - currentCount;
    const dropRatio = dropCount / previousCount;
    
    // 计算动态阈值（大项目更宽松）
    const dynamicL3Threshold = Math.min(
      config.L3_HARD_BLOCK_THRESHOLD,
      config.L3_HARD_BLOCK_THRESHOLD + (previousCount * config.DYNAMIC_THRESHOLD_FACTOR)
    );
    
    // 小项目使用绝对值阈值
    if (previousCount < config.MIN_TASK_COUNT_FOR_RATIO) {
      // 对于小项目，只有全部删除才触发 L3
      if (currentCount === 0) {
        return {
          rule: 'task_count_drop',
          message: `小项目任务全部删除（${previousCount} → 0）`,
          details: {
            projectId,
            previousCount,
            currentCount,
            dropCount,
            dropRatio: 1,
            level: 'L3'
          }
        };
      }
      return null;
    }
    
    // 大项目使用相对值阈值
    // L3 硬熔断：下降 >80% 或归零
    if (dropRatio >= dynamicL3Threshold || currentCount === 0) {
      return {
        rule: 'task_count_drop',
        message: `任务数骤降 ${(dropRatio * 100).toFixed(0)}%（${previousCount} → ${currentCount}）`,
        details: {
          projectId,
          previousCount,
          currentCount,
          dropCount,
          dropRatio,
          level: 'L3',
          threshold: dynamicL3Threshold
        }
      };
    }
    
    // L2 软熔断：下降 50-80%
    if (dropRatio >= config.L2_SOFT_BLOCK_THRESHOLD) {
      return {
        rule: 'task_count_drop',
        message: `任务数下降 ${(dropRatio * 100).toFixed(0)}%（${previousCount} → ${currentCount}）`,
        details: {
          projectId,
          previousCount,
          currentCount,
          dropCount,
          dropRatio,
          level: 'L2'
        }
      };
    }
    
    // L1 警告：下降 20-50%
    if (dropRatio >= config.L1_WARNING_THRESHOLD) {
      return {
        rule: 'task_count_drop',
        message: `任务数下降 ${(dropRatio * 100).toFixed(0)}%（${previousCount} → ${currentCount}）`,
        details: {
          projectId,
          previousCount,
          currentCount,
          dropCount,
          dropRatio,
          level: 'L1'
        }
      };
    }
    
    return null;
  }
  
  /**
   * 验证必填字段
   */
  private validateRequiredFields(project: Project): CircuitBreakerViolation[] {
    const violations: CircuitBreakerViolation[] = [];
    
    // 验证项目字段
    for (const field of CLIENT_CIRCUIT_BREAKER_CONFIG.REQUIRED_PROJECT_FIELDS) {
      const value = project[field as keyof Project];
      if (value === undefined || value === null || value === '') {
        violations.push({
          rule: 'missing_required_field',
          message: `项目缺少必填字段: ${field}`,
          details: { projectId: project.id, field }
        });
      }
    }
    
    // 验证任务字段（抽样检查，避免性能问题）
    const tasksToCheck = project.tasks?.slice(0, 10) ?? [];
    for (const task of tasksToCheck) {
      const taskViolations = this.validateTask(task);
      violations.push(...taskViolations);
    }
    
    return violations;
  }
  
  /**
   * 验证 Schema
   */
  private validateSchema(project: Project): CircuitBreakerViolation[] {
    const violations: CircuitBreakerViolation[] = [];
    
    // 检查项目 ID
    if (!this.isValidUUID(project.id)) {
      violations.push({
        rule: 'schema_violation',
        message: '项目 ID 格式无效',
        details: { projectId: project.id }
      });
    }
    
    // 检查 tasks 是否为数组
    if (project.tasks && !Array.isArray(project.tasks)) {
      violations.push({
        rule: 'schema_violation',
        message: 'tasks 必须是数组',
        details: { projectId: project.id, tasksType: typeof project.tasks }
      });
    }
    
    // 检查 connections 是否为数组
    if (project.connections && !Array.isArray(project.connections)) {
      violations.push({
        rule: 'schema_violation',
        message: 'connections 必须是数组',
        details: { projectId: project.id, connectionsType: typeof project.connections }
      });
    }
    
    return violations;
  }
  
  /**
   * UUID 格式校验
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }
  
  /**
   * 更新任务数历史
   */
  private updateTaskCountHistory(projectId: string, count: number): void {
    const history = this.taskCountHistory.get(projectId) ?? {
      projectId,
      counts: [],
      lastUpdated: Date.now()
    };
    
    // 保留最近 10 个历史记录
    history.counts.push(count);
    if (history.counts.length > 10) {
      history.counts.shift();
    }
    history.lastUpdated = Date.now();
    
    this.taskCountHistory.set(projectId, history);
    this.lastKnownTaskCounts.set(projectId, count);
  }
  
  /**
   * 计算校验结果
   */
  private calculateResult(
    violations: CircuitBreakerViolation[],
    projectId: string
  ): CircuitBreakerValidation {
    if (violations.length === 0) {
      return this.createPassResult();
    }
    
    // 确定最高级别
    let maxLevel: CircuitLevel = 'L1';
    for (const v of violations) {
      const level = (v.details['level'] as CircuitLevel) ?? 'L1';
      if (level === 'L3') {
        maxLevel = 'L3' as CircuitLevel;
        break;
      }
      if (level === 'L2' && maxLevel !== 'L3') {
        maxLevel = 'L2' as CircuitLevel;
      }
    }
    
    // 如果有空数据或严重 schema 问题，升级到 L3
    const hasEmptyViolation = violations.some(v => 
      v.rule === 'zero_task_count_from_existing' || 
      v.rule === 'empty_data'
    );
    if (hasEmptyViolation) {
      maxLevel = 'L3' as CircuitLevel;
    }
    
    // 如果 L3 被禁用，降级到 L2
    if (maxLevel === 'L3' && !FEATURE_FLAGS.CIRCUIT_BREAKER_L3_ENABLED) {
      maxLevel = 'L2' as CircuitLevel;
    }
    
    // 更新熔断状态
    this.circuitStates.set(projectId, maxLevel);
    this.updateGlobalState();
    
    const severity = this.levelToSeverity(maxLevel);
    const shouldBlock = maxLevel === 'L2' || maxLevel === 'L3';
    const suggestedAction = this.levelToAction(maxLevel);
    
    return {
      passed: !shouldBlock,
      violations,
      level: maxLevel,
      severity,
      shouldBlock,
      suggestedAction,
    };
  }
  
  /**
   * 创建通过结果
   */
  private createPassResult(): CircuitBreakerValidation {
    return {
      passed: true,
      violations: [],
      level: 'L0',
      severity: 'low',
      shouldBlock: false,
      suggestedAction: 'none',
    };
  }
  
  /**
   * 级别转严重程度
   */
  private levelToSeverity(level: CircuitLevel): 'low' | 'medium' | 'high' | 'critical' {
    switch (level) {
      case 'L0': return 'low';
      case 'L1': return 'medium';
      case 'L2': return 'high';
      case 'L3': return 'critical';
    }
  }
  
  /**
   * 级别转建议操作
   */
  private levelToAction(level: CircuitLevel): CircuitAction {
    switch (level) {
      case 'L0': return 'none';
      case 'L1': return 'log';
      case 'L2': return 'toast';
      case 'L3': return 'export-prompt';
    }
  }
  
  /**
   * 执行熔断行为
   */
  private executeCircuitAction(
    result: CircuitBreakerValidation,
    projectId: string
  ): void {
    if (result.passed) {
      return;
    }
    
    const violationSummary = result.violations.map(v => v.message).join('; ');
    
    switch (result.level) {
      case 'L1':
        // 记录日志 + Sentry 警告
        this.logger.warn('熔断警告 (L1)', {
          projectId,
          violations: result.violations
        });
        Sentry.captureMessage('CircuitBreaker: L1 Warning', {
          level: 'warning',
          tags: { level: 'L1', projectId },
          extra: { violations: result.violations }
        });
        break;
        
      case 'L2':
        // 阻止同步 + Toast 提示
        this.logger.error('熔断触发 (L2)', {
          projectId,
          violations: result.violations
        });
        Sentry.captureMessage('CircuitBreaker: L2 Soft Block', {
          level: 'error',
          tags: { level: 'L2', projectId },
          extra: { violations: result.violations }
        });
        this.toast.warning(
          '同步已暂停',
          `检测到异常数据变更：${violationSummary}。请检查后重试。`
        );
        break;
        
      case 'L3':
        // 阻止 + 强制导出提示
        this.logger.error('硬熔断触发 (L3)', {
          projectId,
          violations: result.violations
        });
        Sentry.captureMessage('CircuitBreaker: L3 Hard Block', {
          level: 'fatal',
          tags: { level: 'L3', projectId },
          extra: { violations: result.violations }
        });
        this.toast.error(
          '⚠️ 数据保护已触发',
          `检测到严重数据异常：${violationSummary}。同步已停止，请立即导出数据备份。`,
          { duration: 0 } // 不自动关闭
        );
        break;
    }
  }
  
  /**
   * 更新全局状态
   */
  private updateGlobalState(): void {
    let maxLevel: CircuitLevel = 'L0';
    
    for (const level of this.circuitStates.values()) {
      if (level === 'L3') {
        maxLevel = 'L3' as CircuitLevel;
        break;
      }
      if (level === 'L2' && maxLevel !== 'L3') {
        maxLevel = 'L2' as CircuitLevel;
      }
      if (level === 'L1' && maxLevel === 'L0') {
        maxLevel = 'L1' as CircuitLevel;
      }
    }
    
    this.currentLevel.set(maxLevel);
    this.isCircuitOpen.set(maxLevel === 'L2' || maxLevel === 'L3');
  }
}
