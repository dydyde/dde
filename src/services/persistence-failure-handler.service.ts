/**
 * PersistenceFailureHandlerService - 持久化失败处理服务
 * 
 * 【设计理念】
 * 不同类型的数据需要不同的失败处理策略：
 * 
 * 1. 轻量操作（checkbox/date/priority）：
 *    - Toast 提示 + UI 回滚
 *    - 重做成本极低，用户点击即可
 * 
 * 2. 富文本内容（任务描述、笔记）：
 *    - "脏数据滞留"策略：保存失败时不关闭编辑窗口，不清空表单
 *    - 页面跳转/刷新前写入 localStorage 作为"逃生舱"
 *    - 用户的心血不能因为一次网络波动而消失
 * 
 * 【职责边界】
 * ✓ 判断操作类型（轻量 vs 富文本）
 * ✓ 管理脏数据滞留状态
 * ✓ localStorage 逃生舱机制
 * ✗ 实际的数据持久化 → SyncCoordinatorService
 * ✗ Toast 显示 → ToastService
 */
import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';

/**
 * 操作类型
 */
export type OperationType = 'lightweight' | 'content';

/**
 * 脏数据记录
 */
export interface DirtyDataRecord {
  id: string;
  taskId: string;
  projectId: string;
  field: string;
  value: unknown;
  timestamp: number;
  /** 重试次数 */
  retryCount: number;
}

/**
 * 逃生舱数据结构
 */
interface EscapePodData {
  version: number;
  records: DirtyDataRecord[];
  savedAt: string;
}

/** 逃生舱存储 key */
const ESCAPE_POD_KEY = 'nanoflow.escape-pod';
/** 逃生舱数据版本 */
const ESCAPE_POD_VERSION = 1;
/** 逃生舱数据最大存活时间（24小时） */
const ESCAPE_POD_TTL = 24 * 60 * 60 * 1000;
/** 最大脏数据记录数 */
const MAX_DIRTY_RECORDS = 50;

@Injectable({
  providedIn: 'root'
})
export class PersistenceFailureHandlerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('PersistenceFailure');
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);

  /** 当前脏数据记录（内存中） */
  readonly dirtyRecords = signal<DirtyDataRecord[]>([]);

  /** 是否有未保存的脏数据 */
  readonly hasDirtyData = signal(false);

  constructor() {
    this.setupBeforeUnloadListener();
    this.loadEscapePod();

    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }

  // ========== 公共方法 ==========

  /**
   * 判断操作类型
   * 
   * @param field 被修改的字段名
   * @param oldValue 旧值
   * @param newValue 新值
   * @returns 操作类型
   */
  classifyOperation(field: string, oldValue: unknown, newValue: unknown): OperationType {
    // 富文本字段：content（任务描述）、title（可能包含长文本）
    const contentFields = ['content', 'description'];
    
    if (contentFields.includes(field)) {
      return 'content';
    }

    // title 字段：根据文本长度变化判断
    // 如果是微小修改（如修复错别字）算轻量，大幅修改算内容
    if (field === 'title') {
      const oldLen = typeof oldValue === 'string' ? oldValue.length : 0;
      const newLen = typeof newValue === 'string' ? newValue.length : 0;
      const lenDiff = Math.abs(newLen - oldLen);
      
      // 变化超过 20 字符或新值超过 50 字符，算内容型操作
      if (lenDiff > 20 || newLen > 50) {
        return 'content';
      }
    }

    // 其他字段都算轻量操作
    return 'lightweight';
  }

  /**
   * 处理持久化失败
   * 
   * @param taskId 任务 ID
   * @param projectId 项目 ID
   * @param field 被修改的字段
   * @param value 修改后的值（用于脏数据滞留）
   * @param operationType 操作类型
   * @param rollbackFn 轻量操作的回滚函数
   */
  handlePersistenceFailure(
    taskId: string,
    projectId: string,
    field: string,
    value: unknown,
    operationType: OperationType,
    rollbackFn?: () => void
  ): void {
    if (operationType === 'lightweight') {
      // 轻量操作：Toast 提示 + 回滚 UI
      this.toast.warning(
        '保存失败',
        '网络异常，请稍后重试',
        { duration: 4000 }
      );

      if (rollbackFn) {
        rollbackFn();
      }

      this.logger.info('轻量操作保存失败，已回滚 UI', { taskId, field });
    } else {
      // 富文本操作：脏数据滞留策略
      this.addDirtyRecord(taskId, projectId, field, value);

      this.toast.error(
        '内容保存失败',
        '您的内容已暂存，请勿离开页面，稍后将自动重试',
        { duration: 0 } // 不自动关闭
      );

      this.logger.warn('富文本内容保存失败，已启用脏数据滞留', { taskId, field });
    }
  }

  /**
   * 标记数据已成功保存（清除对应的脏数据记录）
   */
  markSaved(taskId: string, field?: string): void {
    this.dirtyRecords.update(records => {
      const filtered = records.filter(r => {
        if (r.taskId !== taskId) return true;
        if (field && r.field !== field) return true;
        return false;
      });
      return filtered;
    });

    this.updateHasDirtyData();
  }

  /**
   * 获取指定任务的脏数据
   */
  getDirtyData(taskId: string, field?: string): DirtyDataRecord | undefined {
    const records = this.dirtyRecords();
    return records.find(r => {
      if (r.taskId !== taskId) return false;
      if (field && r.field !== field) return false;
      return true;
    });
  }

  /**
   * 获取所有脏数据记录
   */
  getAllDirtyRecords(): DirtyDataRecord[] {
    return this.dirtyRecords();
  }

  /**
   * 清除所有脏数据
   */
  clearAllDirtyData(): void {
    this.dirtyRecords.set([]);
    this.hasDirtyData.set(false);
    this.clearEscapePod();
  }

  /**
   * 增加脏数据重试次数
   */
  incrementRetryCount(taskId: string, field: string): number {
    let newCount = 0;
    this.dirtyRecords.update(records => {
      return records.map(r => {
        if (r.taskId === taskId && r.field === field) {
          newCount = r.retryCount + 1;
          return { ...r, retryCount: newCount };
        }
        return r;
      });
    });
    return newCount;
  }

  // ========== 私有方法 ==========

  /**
   * 添加脏数据记录
   */
  private addDirtyRecord(taskId: string, projectId: string, field: string, value: unknown): void {
    const record: DirtyDataRecord = {
      id: `${taskId}-${field}-${Date.now()}`,
      taskId,
      projectId,
      field,
      value,
      timestamp: Date.now(),
      retryCount: 0
    };

    this.dirtyRecords.update(records => {
      // 检查是否已存在相同任务+字段的记录，如果存在则更新
      const existingIndex = records.findIndex(r => r.taskId === taskId && r.field === field);
      
      if (existingIndex >= 0) {
        const updated = [...records];
        updated[existingIndex] = record;
        return updated;
      }

      // 添加新记录，限制最大数量
      const newRecords = [...records, record];
      if (newRecords.length > MAX_DIRTY_RECORDS) {
        // 移除最旧的记录
        return newRecords.slice(-MAX_DIRTY_RECORDS);
      }
      return newRecords;
    });

    this.hasDirtyData.set(true);
  }

  /**
   * 更新 hasDirtyData 状态
   */
  private updateHasDirtyData(): void {
    this.hasDirtyData.set(this.dirtyRecords().length > 0);
  }

  /**
   * 设置 beforeunload 监听器
   * 使用统一的 BeforeUnloadManagerService，在页面离开前将脏数据写入 localStorage 逃生舱
   */
  private setupBeforeUnloadListener(): void {
    // 使用统一的 beforeunload 管理器注册回调
    // 优先级 15 - 在核心数据保存（优先级 1）之后执行
    this.beforeUnloadManager.register('persistence-escape-pod', () => {
      const records = this.dirtyRecords();
      
      if (records.length > 0) {
        // 写入逃生舱
        this.saveToEscapePod(records);
        // 返回 true 表示需要显示确认对话框
        return true;
      }
      return false;
    }, 15);
  }

  /**
   * 保存到逃生舱（localStorage）
   */
  private saveToEscapePod(records: DirtyDataRecord[]): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data: EscapePodData = {
        version: ESCAPE_POD_VERSION,
        records,
        savedAt: new Date().toISOString()
      };

      localStorage.setItem(ESCAPE_POD_KEY, JSON.stringify(data));
      this.logger.info('脏数据已保存到逃生舱', { count: records.length });
    } catch (e) {
      this.logger.error('保存逃生舱数据失败', e);
    }
  }

  /**
   * 从逃生舱加载数据
   */
  private loadEscapePod(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const saved = localStorage.getItem(ESCAPE_POD_KEY);
      if (!saved) return;

      const data = JSON.parse(saved) as EscapePodData;

      // 版本检查
      if (data.version !== ESCAPE_POD_VERSION) {
        this.logger.warn('逃生舱数据版本不匹配，清除旧数据');
        this.clearEscapePod();
        return;
      }

      // TTL 检查
      const savedAt = new Date(data.savedAt).getTime();
      if (Date.now() - savedAt > ESCAPE_POD_TTL) {
        this.logger.info('逃生舱数据已过期，清除');
        this.clearEscapePod();
        return;
      }

      // 恢复数据
      if (data.records && data.records.length > 0) {
        this.dirtyRecords.set(data.records);
        this.hasDirtyData.set(true);

        this.logger.info('从逃生舱恢复脏数据', { count: data.records.length });

        // 提示用户
        this.toast.warning(
          '恢复未保存内容',
          `检测到 ${data.records.length} 条未保存的内容，正在尝试恢复...`,
          { duration: 5000 }
        );

        // 清除逃生舱（数据已加载到内存）
        this.clearEscapePod();
      }
    } catch (e) {
      this.logger.warn('加载逃生舱数据失败', e);
      this.clearEscapePod();
    }
  }

  /**
   * 清除逃生舱数据
   */
  private clearEscapePod(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(ESCAPE_POD_KEY);
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    // 取消注册 beforeunload 回调
    this.beforeUnloadManager.unregister('persistence-escape-pod');

    // 如果有脏数据，保存到逃生舱
    const records = this.dirtyRecords();
    if (records.length > 0) {
      this.saveToEscapePod(records);
    }
  }

  // ========== 测试/HMR 支持 ==========

  /**
   * 重置服务状态
   */
  reset(): void {
    this.dirtyRecords.set([]);
    this.hasDirtyData.set(false);
  }
}
