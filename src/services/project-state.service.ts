import { Injectable, signal, computed, inject } from '@angular/core';
import { Project, Task, Connection, UnfinishedItem } from '../models';
import { LayoutService } from './layout.service';
import { LAYOUT_CONFIG, LETTERS, SUPERSCRIPT_DIGITS } from '../config/constants';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 项目状态服务
 * 从 StoreService 拆分出来，专注于项目和任务的状态管理
 * 职责：
 * - 项目/任务/连接的状态存储
 * - 计算属性（stages, unassignedTasks 等）
 * - 纯状态操作（不涉及同步）
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectStateService {
  private layoutService = inject(LayoutService);
  
  // ========== 核心数据状态 ==========
  
  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all');
  readonly stageViewRootFilter = signal<'all' | string>('all');
  readonly stageFilter = signal<'all' | number>('all');
  readonly searchQuery = signal<string>('');

  // ========== 计算属性 ==========

  readonly activeProject = computed(() => 
    this.projects().find(p => p.id === this.activeProjectId()) || null
  );

  readonly tasks = computed(() => this.activeProject()?.tasks || []);

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
    const filter = this.filterMode();
    
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
  
  readonly searchResults = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return [];
    
    return this.tasks().filter(t => 
      !t.deletedAt && (
        t.title.toLowerCase().includes(query) ||
        t.content.toLowerCase().includes(query) ||
        t.displayId.toLowerCase().includes(query) ||
        (t.attachments?.some(a => a.name.toLowerCase().includes(query)) ?? false) ||
        (t.tags?.some(tag => tag.toLowerCase().includes(query)) ?? false)
      )
    );
  });

  readonly rootTasks = computed(() => {
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => !t.deletedAt && regex.test(t.content || ''));
    
    return tasks.filter(t => t.stage === 1 && !t.deletedAt).filter(root => {
      if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
      return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    return this.tasks()
      .filter(t => t.stage === 1 && !t.deletedAt)
      .sort((a, b) => a.rank - b.rank);
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
   * 设置阶段筛选
   */
  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
  }

  /**
   * 切换视图
   */
  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }

  /**
   * 确保显示指定视图
   */
  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }

  /**
   * 获取任务的关联连接
   */
  getTaskConnections(taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    const project = this.activeProject();
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    // 排除父子关系的连接
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: tasks.find(t => t.id === c.target),
        description: c.description
      }));
    
    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: tasks.find(t => t.id === c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }

  /**
   * 获取当前项目的视图状态
   */
  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    const project = this.activeProject();
    if (!project?.viewState) return null;
    return project.viewState;
  }

  // ========== 内部更新方法（供 StoreService 调用） ==========

  /**
   * 直接更新项目列表
   */
  setProjects(projects: Project[]) {
    this.projects.set(projects);
  }

  /**
   * 更新项目列表
   */
  updateProjects(updater: (projects: Project[]) => Project[]) {
    this.projects.update(updater);
  }

  /**
   * 获取项目（用于外部读取）
   */
  getProject(projectId: string): Project | undefined {
    return this.projects().find(p => p.id === projectId);
  }

  /**
   * 清空数据
   */
  clearData() {
    this.projects.set([]);
    this.activeProjectId.set(null);
    this.searchQuery.set('');
    this.filterMode.set('all');
    this.stageViewRootFilter.set('all');
    this.stageFilter.set('all');
  }
}
