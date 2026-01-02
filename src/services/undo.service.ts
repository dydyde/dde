import { Injectable, signal, computed, inject } from '@angular/core';
import { UndoAction, Project } from '../models';
import { UNDO_CONFIG } from '../config';
import { ToastService } from './toast.service';

/**
 * 持久化数据结构
 * @internal
 */
interface PersistedUndoData {
  version: number;
  timestamp: string;
  projectId: string;
  undoStack: UndoAction[];
}

/**
 * 撤销操作结果类型
 * - UndoAction: 撤销成功，返回操作数据
 * - 'version-mismatch': 版本不匹配，建议不撤销
 * - 'version-mismatch-forceable': 版本不匹配但可强制撤销，附带 action 数据
 * - null: 没有可撤销的操作
 */
export type UndoResult = 
  | UndoAction 
  | null 
  | 'version-mismatch' 
  | { type: 'version-mismatch-forceable'; action: UndoAction; versionDiff: number };

/**
 * 撤销/重做服务
 * 实现应用级别的撤销重做功能
 * 
 * 特性：
 * - 防抖合并：连续的编辑操作会被合并为一个撤销记录
 * - 栈大小限制：避免内存溢出
 * - 版本追踪：与远程同步配合使用
 * - 【v5.8】sessionStorage 持久化：页面刷新后恢复撤销历史
 */
@Injectable({
  providedIn: 'root'
})
export class UndoService {
  private readonly toast = inject(ToastService);
  
  /** 撤销栈 */
  private undoStack = signal<UndoAction[]>([]);
  /** 重做栈 */
  private redoStack = signal<UndoAction[]>([]);
  
  /** 持久化防抖计时器 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前项目 ID（用于持久化） */
  private currentProjectId: string | null = null;
  
  /** 是否可以撤销 */
  readonly canUndo = computed(() => this.undoStack().length > 0);
  /** 是否可以重做 */
  readonly canRedo = computed(() => this.redoStack().length > 0);
  
  /** 撤销栈大小 */
  readonly undoCount = computed(() => this.undoStack().length);
  /** 重做栈大小 */
  readonly redoCount = computed(() => this.redoStack().length);
  
  /** 
   * 栈截断事件 
   * 当撤销历史因达到上限而被截断时触发
   */
  private _truncatedCount = signal(0);
  readonly truncatedCount = this._truncatedCount.asReadonly();
  
  /** 上次截断提示时间（防止频繁提示） */
  private lastTruncationNotifyTime = 0;
  private readonly TRUNCATION_NOTIFY_COOLDOWN = 30000; // 30秒内不重复提示
  
  /** 是否正在执行撤销/重做操作（防止循环记录） */
  private isUndoRedoing = false;
  
  /** 防抖相关状态 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAction: Omit<UndoAction, 'timestamp'> | null = null;
  private lastActionTime = 0;
  
  /** 防抖配置 */
  private readonly DEBOUNCE_DELAY = 800; // 800ms 内的连续编辑合并
  private readonly MERGE_WINDOW = 2000; // 2s 内同类型操作可合并
  
  /** 
   * 批处理状态
   * 用于将多个操作合并为单个撤销单元（如多选批量移动）
   */
  private isBatching = false;
  private batchBeforeSnapshot: Partial<Project> | null = null;
  private batchProjectId: string | null = null;
  private batchProjectVersion: number | null = null;

  /**
   * 开始批处理模式
   * 在此模式下，所有操作将被合并为单个撤销记录
   * 用于多选批量移动等场景
   * 
   * @param project 当前项目（用于创建 before 快照）
   */
  beginBatch(project: Project): void {
    if (this.isBatching) {
      console.warn('[UndoService] 已在批处理模式，忽略重复调用');
      return;
    }
    
    this.isBatching = true;
    this.batchBeforeSnapshot = this.createProjectSnapshot(project);
    this.batchProjectId = project.id;
    this.batchProjectVersion = project.version ?? 0;
  }
  
  /**
   * 结束批处理模式并提交撤销记录
   * 
   * @param project 当前项目（用于创建 after 快照）
   */
  endBatch(project: Project): void {
    if (!this.isBatching) {
      console.warn('[UndoService] 未在批处理模式，忽略调用');
      return;
    }
    
    this.isBatching = false;
    
    // 只有当快照存在且项目 ID 匹配时才记录
    if (this.batchBeforeSnapshot && this.batchProjectId === project.id) {
      const afterSnapshot = this.createProjectSnapshot(project);
      
      // 检查是否有实际变更（避免空撤销记录）
      const beforeTasks = this.batchBeforeSnapshot.tasks as Array<{ id: string; x: number; y: number }> | undefined;
      const afterTasks = afterSnapshot.tasks as Array<{ id: string; x: number; y: number }> | undefined;
      
      let hasChanges = false;
      if (beforeTasks && afterTasks && beforeTasks.length === afterTasks.length) {
        for (let i = 0; i < beforeTasks.length; i++) {
          const before = beforeTasks[i];
          const after = afterTasks.find(t => t.id === before.id);
          if (after && (Math.abs(before.x - after.x) > 1 || Math.abs(before.y - after.y) > 1)) {
            hasChanges = true;
            break;
          }
        }
      } else {
        hasChanges = true; // 数量变化也算变更
      }
      
      if (hasChanges) {
        this.recordAction({
          type: 'task-move',
          projectId: this.batchProjectId,
          data: { before: this.batchBeforeSnapshot, after: afterSnapshot }
        }, this.batchProjectVersion ?? undefined);
      }
    }
    
    // 清理状态
    this.batchBeforeSnapshot = null;
    this.batchProjectId = null;
    this.batchProjectVersion = null;
  }
  
  /**
   * 取消批处理（不记录撤销）
   */
  cancelBatch(): void {
    this.isBatching = false;
    this.batchBeforeSnapshot = null;
    this.batchProjectId = null;
    this.batchProjectVersion = null;
  }
  
  /**
   * 检查是否在批处理模式
   */
  get isBatchMode(): boolean {
    return this.isBatching;
  }

  /**
   * 记录一个操作（用于后续撤销）
   * 会自动防抖，连续的编辑操作会合并为一个撤销记录
   * @param projectVersion 当前项目版本号，用于撤销时检测远程更新冲突
   */
  recordAction(action: Omit<UndoAction, 'timestamp'>, projectVersion?: number): void {
    if (this.isUndoRedoing) return;
    
    // 批处理模式下跳过单独记录（由 endBatch 统一处理）
    if (this.isBatching) return;
    
    // 检查是否应该与上一个操作合并
    const now = Date.now();
    const lastAction = this.undoStack().at(-1);
    
    // 合并条件：
    // 1. 同一个项目
    // 2. 同类型操作（都是 task-update）
    // 3. 在合并窗口内
    const shouldMerge = lastAction &&
      lastAction.projectId === action.projectId &&
      lastAction.type === action.type &&
      action.type === 'task-update' &&
      (now - lastAction.timestamp) < this.MERGE_WINDOW;
    
    if (shouldMerge && lastAction) {
      // 合并操作：保留最初的 before 快照，更新 after 快照
      this.undoStack.update(stack => {
        const updated = [...stack];
        const lastIdx = updated.length - 1;
        updated[lastIdx] = {
          ...updated[lastIdx],
          timestamp: now,
          data: {
            before: updated[lastIdx].data.before, // 保留原始的 before
            after: action.data.after // 使用最新的 after
          }
        };
        return updated;
      });
    } else {
      // 创建新的撤销记录
      const fullAction: UndoAction = {
        ...action,
        timestamp: now,
        projectVersion // 记录当前项目版本号
      };
      
      this.undoStack.update(stack => {
        const newStack = [...stack, fullAction];
        // 限制栈大小
        if (newStack.length > UNDO_CONFIG.MAX_HISTORY_SIZE) {
          const truncatedCount = newStack.length - UNDO_CONFIG.MAX_HISTORY_SIZE;
          this.notifyTruncation(truncatedCount);
          return newStack.slice(-UNDO_CONFIG.MAX_HISTORY_SIZE);
        }
        return newStack;
      });
    }
    
    // 有新操作时清空重做栈
    this.redoStack.set([]);
    this.lastActionTime = now;
    
    // 【v5.8】触发持久化
    this.schedulePersist();
  }
  
  /**
   * 带防抖的记录操作
   * 用于高频输入场景（如输入框），延迟提交以合并多次输入
   */
  recordActionDebounced(action: Omit<UndoAction, 'timestamp'>): void {
    if (this.isUndoRedoing) return;
    
    // 如果没有待处理的操作，保存初始快照
    if (!this.pendingAction) {
      this.pendingAction = action;
    } else {
      // 更新 after 快照，保留原始 before
      this.pendingAction = {
        ...this.pendingAction,
        data: {
          before: this.pendingAction.data.before,
          after: action.data.after
        }
      };
    }
    
    // 清除之前的定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // 设置新的防抖定时器
    this.debounceTimer = setTimeout(() => {
      if (this.pendingAction) {
        this.recordAction(this.pendingAction);
        this.pendingAction = null;
      }
      this.debounceTimer = null;
    }, this.DEBOUNCE_DELAY);
  }
  
  /**
   * 立即提交待处理的防抖操作
   * 在用户离开编辑状态时调用
   */
  flushPendingAction(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    if (this.pendingAction) {
      this.recordAction(this.pendingAction);
      this.pendingAction = null;
    }
  }

  /**
   * 执行撤销
   * 在撤销前检查快照中的任务是否仍然存在
   * 支持渐进式降级：
   * 1. 版本差距小于容差：正常撤销
   * 2. 版本差距在容差范围内：返回可强制撤销结果
   * 3. 版本差距过大：拒绝撤销
   * @param currentProjectVersion 当前项目版本号，用于检测远程更新冲突
   * @returns 需要应用的撤销数据，或 null（如果没有可撤销的操作），或 'version-mismatch'（如果版本不匹配）
   */
  undo(currentProjectVersion?: number): UndoResult {
    // 先刷新待处理的防抖操作，确保最近的编辑不会丢失
    this.flushPendingAction();
    
    const stack = this.undoStack();
    if (stack.length === 0) return null;
    
    const action = stack[stack.length - 1];
    
    // 版本检查：如果远程版本已更新（超过本地记录的版本），拒绝撤销
    // 只有当两个版本号都有定义时才进行检查
    // 注意：允许本地版本比记录的版本高（本地多次操作后撤销是正常的）
    // 只拒绝当检测到远程同步导致版本跳跃的情况
    // 使用宽松判断：如果远程版本比记录版本高超过允许的偏差量才拒绝
    if (currentProjectVersion !== undefined && 
        currentProjectVersion !== null &&
        action.projectVersion !== undefined &&
        action.projectVersion !== null) {
      
      const versionDiff = currentProjectVersion - action.projectVersion;
      
      // 版本差距超过容差的 2 倍：完全拒绝撤销
      if (versionDiff > UNDO_CONFIG.VERSION_TOLERANCE * 2) {
        return 'version-mismatch';
      }
      
      // 版本差距在容差范围内：返回可强制撤销结果
      if (versionDiff > UNDO_CONFIG.VERSION_TOLERANCE) {
        return {
          type: 'version-mismatch-forceable',
          action,
          versionDiff
        };
      }
    }
    
    this.isUndoRedoing = true;
    
    // 注意：撤销操作的安全检查由 StoreService.applyProjectSnapshot 完成
    // 这里不阻止撤销，只记录可能的警告供日志使用
    
    this.undoStack.update(s => s.slice(0, -1));
    this.redoStack.update(s => [...s, action]);
    
    this.isUndoRedoing = false;
    
    // 【v5.8】触发持久化
    this.schedulePersist();
    
    return action;
  }
  
  /**
   * 强制执行撤销（忽略版本检查）
   * 警告：这可能覆盖远程更新，仅在用户明确确认后使用
   */
  forceUndo(): UndoAction | null {
    const stack = this.undoStack();
    if (stack.length === 0) return null;
    
    const action = stack[stack.length - 1];
    
    this.isUndoRedoing = true;
    
    this.undoStack.update(s => s.slice(0, -1));
    this.redoStack.update(s => [...s, action]);
    
    this.isUndoRedoing = false;
    
    // 【v5.8】触发持久化
    this.schedulePersist();
    
    return action;
  }

  /**
   * 执行重做
   * @param currentProjectVersion 当前项目版本号，用于检测远程更新冲突
   * @returns 需要应用的重做数据，或 null（如果没有可重做的操作），或 'version-mismatch'（如果版本不匹配）
   */
  redo(currentProjectVersion?: number): UndoResult {
    // 先刷新待处理的防抖操作，确保一致性
    this.flushPendingAction();
    
    const stack = this.redoStack();
    if (stack.length === 0) return null;
    
    const action = stack[stack.length - 1];
    
    // 版本检查：如果远程版本已更新，拒绝重做
    // 只有当两个版本号都有定义时才进行检查
    // 使用与 undo 相同的宽松判断逻辑
    if (currentProjectVersion !== undefined && 
        currentProjectVersion !== null &&
        action.projectVersion !== undefined &&
        action.projectVersion !== null &&
        currentProjectVersion > action.projectVersion + UNDO_CONFIG.VERSION_TOLERANCE) {
      return 'version-mismatch';
    }
    
    this.isUndoRedoing = true;
    
    this.redoStack.update(s => s.slice(0, -1));
    this.undoStack.update(s => [...s, action]);
    
    this.isUndoRedoing = false;
    
    // 【v5.8】触发持久化
    this.schedulePersist();
    
    return action;
  }

  /**
   * 清理过时的撤销记录
   * 当检测到远程更新时调用，移除版本号低于当前版本的记录
   * 这可以防止撤销时意外覆盖远程更新
   */
  clearOutdatedHistory(projectId: string, currentVersion: number): number {
    const before = this.undoStack().length;
    
    this.undoStack.update(stack => 
      stack.filter(action => {
        // 保留不同项目的记录
        if (action.projectId !== projectId) return true;
        // 保留版本号匹配或较新的记录
        if (action.projectVersion === undefined) return true;
        return action.projectVersion >= currentVersion - 1;
      })
    );
    
    // 同时清理重做栈中的过时记录
    this.redoStack.update(stack => 
      stack.filter(action => {
        if (action.projectId !== projectId) return true;
        if (action.projectVersion === undefined) return true;
        return action.projectVersion >= currentVersion - 1;
      })
    );
    
    return before - this.undoStack().length;
  }

  /**
   * 清理指定任务相关的撤销历史
   * 当任务被远程删除时调用，防止撤销操作引用已删除的任务
   * @param taskId 被删除的任务 ID
   * @param projectId 任务所属的项目 ID
   * @returns 清理的记录数
   */
  clearTaskHistory(taskId: string, projectId: string): number {
    const beforeUndo = this.undoStack().length;
    const beforeRedo = this.redoStack().length;
    
    // 过滤掉引用被删除任务的撤销记录
    this.undoStack.update(stack => 
      stack.filter(action => {
        if (action.projectId !== projectId) return true;
        
        // 检查 before/after 快照中是否包含被删除的任务
        const beforeTasks = action.data.before?.tasks as Array<{ id: string }> | undefined;
        const afterTasks = action.data.after?.tasks as Array<{ id: string }> | undefined;
        
        // 如果操作涉及被删除的任务，移除该记录
        const involvesDeletedTask = 
          beforeTasks?.some(t => t.id === taskId) ||
          afterTasks?.some(t => t.id === taskId);
        
        return !involvesDeletedTask;
      })
    );
    
    // 同时清理重做栈
    this.redoStack.update(stack => 
      stack.filter(action => {
        if (action.projectId !== projectId) return true;
        
        const beforeTasks = action.data.before?.tasks as Array<{ id: string }> | undefined;
        const afterTasks = action.data.after?.tasks as Array<{ id: string }> | undefined;
        
        const involvesDeletedTask = 
          beforeTasks?.some(t => t.id === taskId) ||
          afterTasks?.some(t => t.id === taskId);
        
        return !involvesDeletedTask;
      })
    );
    
    const clearedUndo = beforeUndo - this.undoStack().length;
    const clearedRedo = beforeRedo - this.redoStack().length;
    
    return clearedUndo + clearedRedo;
  }

  /**
   * 清空历史（切换项目时调用）
   * @param projectId 可选，指定要清空的项目ID。如果不传则清空所有历史。
   */
  clearHistory(projectId?: string): void {
    // 取消任何待处理的防抖操作
    this.flushPendingAction();
    
    if (projectId) {
      // 只清空指定项目的历史
      this.undoStack.update(stack => stack.filter(a => a.projectId !== projectId));
      this.redoStack.update(stack => stack.filter(a => a.projectId !== projectId));
    } else {
      // 清空所有历史
      this.undoStack.set([]);
      this.redoStack.set([]);
    }
  }
  
  /**
   * 在项目切换时调用，清空当前项目的撤销历史
   * 这是全局撤销栈 + 切换时清空的策略实现
   */
  onProjectSwitch(previousProjectId: string | null): void {
    if (previousProjectId) {
      this.clearHistory(previousProjectId);
    }
  }

  /**
   * 创建项目快照（用于记录操作前的状态）
   */
  createProjectSnapshot(project: Project): Partial<Project> {
    return {
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: project.connections.map(c => ({ ...c }))
    };
  }

  /**
   * 检查是否正在执行撤销/重做
   */
  get isProcessing(): boolean {
    return this.isUndoRedoing;
  }
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   * 
   * 注意：Root 级别的服务在 Angular 设计中不会被销毁，
   * 使用显式 reset() 方法而非 ngOnDestroy 来清理状态
   */
  reset(): void {
    // 清除待处理的防抖操作
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    // 重置所有状态
    this.undoStack.set([]);
    this.redoStack.set([]);
    this.pendingAction = null;
    this.lastActionTime = 0;
    this.isUndoRedoing = false;
  }
  
  /**
   * 用户登出时调用
   * 清理跨会话可能泄漏的状态
   * 
   * 设计理念：
   * - 防止旧会话的防抖定时器在新会话中触发
   * - 清除可能包含敏感数据的撤销历史
   */
  onUserLogout(): void {
    // 立即取消任何待处理的防抖操作
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    // 清除待处理但未提交的操作（不提交到撤销栈）
    this.pendingAction = null;
    
    // 清空所有撤销历史（可能包含敏感数据）
    this.undoStack.set([]);
    this.redoStack.set([]);
    
    // 重置状态
    this.lastActionTime = 0;
    this.isUndoRedoing = false;
    this._truncatedCount.set(0);
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 通知撤销历史被截断
   * 
   * 使用冷却时间防止频繁提示打扰用户
   */
  private notifyTruncation(count: number): void {
    const now = Date.now();
    
    // 累计截断数量
    this._truncatedCount.update(c => c + count);
    
    // 检查冷却时间
    if (now - this.lastTruncationNotifyTime < this.TRUNCATION_NOTIFY_COOLDOWN) {
      return;
    }
    
    this.lastTruncationNotifyTime = now;
    
    // 显示提示
    this.toast.info(
      '撤销历史已达上限',
      `最早的 ${count} 条记录已被移除`,
      4000
    );
  }
  
  // ==================== 持久化方法 (v5.8) ====================
  
  /**
   * 设置当前项目 ID 并尝试恢复历史
   * 应在项目加载时调用
   */
  setCurrentProject(projectId: string): void {
    if (this.currentProjectId === projectId) return;
    
    this.currentProjectId = projectId;
    this.restoreFromStorage(projectId);
  }
  
  /**
   * 触发持久化（防抖）
   * 在撤销栈变化时调用
   */
  private schedulePersist(): void {
    if (!UNDO_CONFIG.PERSISTENCE.ENABLED || !this.currentProjectId) return;
    
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    
    this.persistTimer = setTimeout(() => {
      this.persistToStorage();
    }, UNDO_CONFIG.PERSISTENCE.DEBOUNCE_DELAY);
  }
  
  /**
   * 将撤销历史持久化到 sessionStorage
   * 
   * 策略：
   * - 只保存撤销栈（重做栈页面刷新后无意义）
   * - 限制条目数以控制存储大小
   * - 静默失败，不影响功能
   */
  private persistToStorage(): void {
    if (!this.currentProjectId) return;
    
    try {
      const undoItems = this.undoStack();
      // 只保存最近的 N 条
      const itemsToPersist = undoItems.slice(
        -UNDO_CONFIG.PERSISTENCE.MAX_PERSISTED_ITEMS
      );
      
      const data: PersistedUndoData = {
        version: 1,
        timestamp: new Date().toISOString(),
        projectId: this.currentProjectId,
        undoStack: itemsToPersist.map(item => this.serializeUndoAction(item))
      };
      
      sessionStorage.setItem(
        UNDO_CONFIG.PERSISTENCE.STORAGE_KEY,
        JSON.stringify(data)
      );
    } catch {
      // sessionStorage 满或不可用，静默失败
    }
  }
  
  /**
   * 从 sessionStorage 恢复撤销历史
   */
  private restoreFromStorage(projectId: string): void {
    if (!UNDO_CONFIG.PERSISTENCE.ENABLED) return;
    
    try {
      const stored = sessionStorage.getItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
      if (!stored) return;
      
      const data: PersistedUndoData = JSON.parse(stored);
      
      // 验证项目匹配
      if (data.projectId !== projectId) {
        // 不同项目，清除旧数据
        sessionStorage.removeItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
        return;
      }
      
      // 验证版本和时间戳
      if (data.version !== 1 || !data.undoStack || !Array.isArray(data.undoStack)) {
        return;
      }
      
      // 检查数据是否过期（5分钟内有效）
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age > 5 * 60 * 1000) {
        sessionStorage.removeItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
        return;
      }
      
      // 恢复撤销栈
      const restoredActions = data.undoStack
        .map(item => this.deserializeUndoAction(item))
        .filter((item): item is UndoAction => item !== null);
      
      if (restoredActions.length > 0) {
        this.undoStack.set(restoredActions);
        // 不恢复重做栈，因为刷新后重做无意义
      }
    } catch {
      // 解析失败，静默忽略
      sessionStorage.removeItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
    }
  }
  
  /**
   * 清除持久化数据
   */
  private clearPersistedData(): void {
    try {
      sessionStorage.removeItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
    } catch {
      // 静默失败
    }
  }
  
  /**
   * 序列化 UndoAction（移除不可序列化的属性）
   */
  private serializeUndoAction(action: UndoAction): UndoAction {
    // 创建深拷贝，确保可序列化
    return JSON.parse(JSON.stringify(action));
  }
  
  /**
   * 反序列化 UndoAction
   */
  private deserializeUndoAction(data: unknown): UndoAction | null {
    if (!data || typeof data !== 'object') return null;
    
    const action = data as Record<string, unknown>;
    
    // 验证必要字段
    if (
      typeof action['type'] !== 'string' ||
      typeof action['projectId'] !== 'string' ||
      typeof action['timestamp'] !== 'number'
    ) {
      return null;
    }
    
    return action as unknown as UndoAction;
  }
}
