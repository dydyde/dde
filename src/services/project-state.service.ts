import { Injectable, computed, inject } from '@angular/core';
import { Project, Task, Connection, UnfinishedItem } from '../models';
import { LayoutService } from './layout.service';
import { UiStateService } from './ui-state.service';
import { TaskStore, ProjectStore, ConnectionStore } from '../app/core/state/stores';
import { SUPERSCRIPT_DIGITS } from '../config';

/**
 * 任务连接信息（缓存用）
 * 用于 O(1) 查询任务的出入连接
 */
export interface TaskConnectionInfo {
  outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
  incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
}

/**
 * 项目状态服务
 * 从 StoreService 拆分出来，专注于项目和任务的状态管理
 * 
 * 【架构升级】
 * 底层使用 TaskStore/ProjectStore/ConnectionStore 实现 O(1) 查找
 * 对外保持原有接口兼容
 * 
 * 【职责边界】
 * ✓ 项目/任务/连接的状态存储（通过 Store 代理）
 * ✓ 计算属性（stages, unassignedTasks, deletedTasks 等）
 * ✓ 纯状态读取操作
 * ✓ displayId 压缩显示
 * ✗ 数据修改操作 → TaskOperationService
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ UI 状态 → UiStateService
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectStateService {
  private layoutService = inject(LayoutService);
  private uiState = inject(UiStateService);
  
  // ========== 新架构：底层 Store ==========
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly connectionStore = inject(ConnectionStore);
  
  // ========== 核心数据状态（代理到 Store） ==========
  
  /** 项目列表 - 代理到 ProjectStore */
  readonly projects = computed(() => this.projectStore.projects());
  
  /** 
   * 活动项目 ID - 直接暴露 ProjectStore 的 WritableSignal
   * 保持 .set() 可用性
   */
  readonly activeProjectId = this.projectStore.activeProjectId;

  // ========== 计算属性 ==========

  readonly activeProject = computed(() => this.projectStore.activeProject());

  /** 当前项目的任务列表 - 使用 TaskStore O(1) 查找 */
  readonly tasks = computed(() => {
    const projectId = this.activeProjectId();
    if (!projectId) return [];
    return this.taskStore.getTasksByProject(projectId);
  });

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null && !t.deletedAt);
    
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    for (const [, val] of stagesMap.entries()) {
      val.sort((a, b) => a.order - b.order);
    }
    
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null && !t.deletedAt);
  });

  /** 已删除（回收站）中的任务 */
  readonly deletedTasks = computed(() => {
    return this.tasks().filter(t => t.deletedAt);
  });

  readonly unfinishedItems = computed<UnfinishedItem[]>(() => {
    const items: UnfinishedItem[] = [];
    const tasks = this.tasks();
    const filter = this.uiState.filterMode();
    
    let rootDisplayId = '';
    if (filter !== 'all') {
      const root = tasks.find(r => r.id === filter);
      if (root) rootDisplayId = root.displayId;
    }

    const todoRegex = /[-*]\s*\[ \]\s*(.+)/g;
    const codeBlockRegex = /```[\s\S]*?```/g;

    tasks.forEach(t => {
      if (t.deletedAt) return;
      
      if (rootDisplayId) {
        const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
        if (!isDescendant) return;
      }

      const contentWithoutCodeBlocks = t.content.replace(codeBlockRegex, '');
      
      let match;
      while ((match = todoRegex.exec(contentWithoutCodeBlocks)) !== null) {
        items.push({
          taskId: t.id,
          taskDisplayId: t.displayId,
          text: match[1].trim()
        });
      }
    });
    return items;
  });

  readonly rootTasks = computed(() => {
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => !t.deletedAt && regex.test(t.content || ''));

    // 用 Set 存储含未完成项的任务 ID，实现 O(1) 查找，避免 O(n²) 嵌套 some
    const unfinishedIds = new Set(tasksWithUnfinished.map(t => t.id));

    return tasks.filter(t => t.stage === 1 && !t.deletedAt).filter(root => {
      if (unfinishedIds.has(root.id)) return true;
      return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    return this.tasks()
      .filter(t => t.stage === 1 && !t.deletedAt)
      .sort((a, b) => a.rank - b.rank);
  });

  /**
   * 【性能优化】所有任务的连接关系缓存
   * 
   * 将 O(n²) 的逐任务查询优化为 O(n) 的一次性计算 + O(1) 查找
   * 返回 Map<taskId, { outgoing, incoming }>
   * 
   * 只在 tasks 或 connections 变化时重新计算
   */
  readonly taskConnectionsMap = computed(() => {
    const project = this.activeProject();
    if (!project) return new Map<string, TaskConnectionInfo>();
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    // 构建父子关系 Set（O(n)）
    const parentChildPairs = new Set<string>();
    for (const t of tasks) {
      if (t.parentId) {
        parentChildPairs.add(`${t.parentId}->${t.id}`);
      }
    }
    
    // 构建任务 ID -> Task 映射（O(n)）
    const taskMap = new Map<string, Task>();
    for (const t of tasks) {
      taskMap.set(t.id, t);
    }
    
    // 初始化结果 Map
    const result = new Map<string, TaskConnectionInfo>();
    for (const t of tasks) {
      result.set(t.id, { outgoing: [], incoming: [] });
    }
    
    // 一次遍历 connections 构建所有连接关系（O(m)）
    for (const conn of connections) {
      const pairKey = `${conn.source}->${conn.target}`;
      if (parentChildPairs.has(pairKey)) continue; // 跳过父子关系
      
      // 添加到 source 的 outgoing
      const sourceInfo = result.get(conn.source);
      if (sourceInfo) {
        sourceInfo.outgoing.push({
          targetId: conn.target,
          targetTask: taskMap.get(conn.target),
          description: conn.description
        });
      }
      
      // 添加到 target 的 incoming
      const targetInfo = result.get(conn.target);
      if (targetInfo) {
        targetInfo.incoming.push({
          sourceId: conn.source,
          sourceTask: taskMap.get(conn.source),
          description: conn.description
        });
      }
    }
    
    return result;
  });

  // ========== 公共方法 ==========

  /**
   * 压缩 displayId 显示
   */
  compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;
    
    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;
    
    while (i < parts.length) {
      const current = parts[i];
      let count = 1;
      
      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }
      
      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d]).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }
      
      i += count;
    }
    
    return result.join(',');
  }

  /**
   * 获取任务的关联连接
   * 
   * 【性能优化】使用 taskConnectionsMap 缓存，O(1) 查找
   * 只有在 tasks 或 connections 变化时才重新计算缓存
   */
  getTaskConnections(taskId: string): TaskConnectionInfo {
    const cached = this.taskConnectionsMap().get(taskId);
    if (cached) return cached;
    
    // 如果缓存中没有（可能是新任务还未进入缓存），返回空结果
    return { outgoing: [], incoming: [] };
  }

  /**
   * 获取当前项目的视图状态
   */
  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    const project = this.activeProject();
    if (!project?.viewState) return null;
    return project.viewState;
  }

  /**
   * 获取项目（用于外部读取）
   */
  getProject(projectId: string): Project | undefined {
    return this.projects().find(p => p.id === projectId);
  }

  // ========== 内部更新方法（供 StoreService 调用） ==========

  /**
   * 直接更新项目列表
   * 同时更新 ProjectStore、TaskStore、ConnectionStore
   */
  setProjects(projects: Project[]): void {
    // 更新 ProjectStore
    this.projectStore.setProjects(projects);
    
    // 同步任务和连接到对应 Store
    // 注意：使用 Array.isArray 而非 length 检查，确保空数组也能正确同步
    // 这对于撤销操作恢复到空连接状态至关重要
    for (const project of projects) {
      if (Array.isArray(project.tasks)) {
        this.taskStore.setTasks(project.tasks, project.id);
      }
      if (Array.isArray(project.connections)) {
        this.connectionStore.setConnections(project.connections, project.id);
      }
    }
  }

  /**
   * 更新项目列表
   * 兼容旧的 updater 模式
   */
  updateProjects(updater: (projects: Project[]) => Project[]): void {
    const currentProjects = this.projectStore.projects();
    const updatedProjects = updater(currentProjects);
    this.setProjects(updatedProjects);
  }

  /**
   * 设置活动项目 ID
   */
  setActiveProjectId(projectId: string | null): void {
    this.projectStore.activeProjectId.set(projectId);
  }

  /**
   * 清空数据
   */
  clearData(): void {
    this.projectStore.clear();
    this.taskStore.clear();
    this.connectionStore.clear();
  }
  
  // ========== 新增：O(1) 查找方法 ==========
  
  /**
   * 获取单个任务 - O(1)
   */
  getTask(taskId: string): Task | undefined {
    return this.taskStore.getTask(taskId);
  }
  
  /**
   * 获取单个连接 - O(1)
   */
  getConnection(connectionId: string): Connection | undefined {
    return this.connectionStore.getConnection(connectionId);
  }
  
  /**
   * 更新单个任务
   */
  updateTask(task: Task, projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.taskStore.setTask(task, pid);
    }
  }
  
  /**
   * 更新单个连接
   */
  updateConnection(connection: Connection, projectId?: string): void {
    const pid = projectId || this.activeProjectId();
    if (pid) {
      this.connectionStore.setConnection(connection, pid);
    }
  }
  
  /**
   * 重命名项目
   * 返回 true 表示成功，false 表示无效名称
   */
  renameProject(projectId: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    
    this.updateProjects(projects => projects.map(p => 
      p.id === projectId ? { ...p, name: trimmed } : p
    ));
    return true;
  }
  
  /**
   * 更新项目视图状态（缩放、位置）
   */
  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }): void {
    this.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          viewState: {
            scale: viewState.scale ?? p.viewState?.scale ?? 1,
            positionX: viewState.positionX ?? p.viewState?.positionX ?? 0,
            positionY: viewState.positionY ?? p.viewState?.positionY ?? 0
          }
        };
      }
      return p;
    }));
  }
}
