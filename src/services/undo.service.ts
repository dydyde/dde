import { Injectable, signal, computed } from '@angular/core';
import { UndoAction, Project } from '../models';
import { UNDO_CONFIG } from '../config/constants';

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
 */
@Injectable({
  providedIn: 'root'
})
export class UndoService {
  /** 撤销栈 */
  private undoStack = signal<UndoAction[]>([]);
  /** 重做栈 */
  private redoStack = signal<UndoAction[]>([]);
  
  /** 是否可以撤销 */
  readonly canUndo = computed(() => this.undoStack().length > 0);
  /** 是否可以重做 */
  readonly canRedo = computed(() => this.redoStack().length > 0);
  
  /** 撤销栈大小 */
  readonly undoCount = computed(() => this.undoStack().length);
  /** 重做栈大小 */
  readonly redoCount = computed(() => this.redoStack().length);
  
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
   * 记录一个操作（用于后续撤销）
   * 会自动防抖，连续的编辑操作会合并为一个撤销记录
   * @param projectVersion 当前项目版本号，用于撤销时检测远程更新冲突
   */
  recordAction(action: Omit<UndoAction, 'timestamp'>, projectVersion?: number): void {
    if (this.isUndoRedoing) return;
    
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
          return newStack.slice(-UNDO_CONFIG.MAX_HISTORY_SIZE);
        }
        return newStack;
      });
    }
    
    // 有新操作时清空重做栈
    this.redoStack.set([]);
    this.lastActionTime = now;
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
  }
}
