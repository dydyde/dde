import { Injectable, signal, computed, effect } from '@angular/core';
import { GoogleGenAI } from '@google/genai';

export interface Task {
  id: string;
  title: string;
  content: string; // Markdown
  stage: number | null; // Null if unassigned
  parentId: string | null;
  order: number; // Order within stage/parent
  rank: number; // Gravity-based ordering
  status: 'active' | 'completed';
  x: number; // Flowchart X
  y: number; // Flowchart Y
  createdDate: string;
  displayId: string; // "1", "1,a", "2,b" etc.
  hasIncompleteTask?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: { source: string; target: string }[];
}

export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string; // The text after "- [ ]"
}

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  // State
  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all'); // 'all' or a root task ID (for To-Do list)
  readonly stageViewRootFilter = signal<'all' | string>('all'); // 'all' or a root task ID (for Stage View)
  readonly stageFilter = signal<'all' | number>('all');
  
  // UI State for Text Column
  readonly isTextUnfinishedOpen = signal(true);
  readonly isTextUnassignedOpen = signal(true);

  // UI State for Flow Column
  readonly isFlowUnfinishedOpen = signal(true);
  readonly isFlowUnassignedOpen = signal(true);
  readonly isFlowDetailOpen = signal(false);
  
  // Layout Dimensions
  readonly sidebarWidth = signal(280); // px
  readonly textColumnRatio = signal(50); // percentage of main content
  
  // Settings
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');

  // AI
  private ai: GoogleGenAI | null = null;
  private letters = 'abcdefghijklmnopqrstuvwxyz';
  private stageSpacing = 260;
  private rowSpacing = 140;
  private rankRootBase = 10000;
  private rankStep = 500;
  private rankMinGap = 50;

  private resolveApiKey() {
    const candidate = (globalThis as any).__GENAI_API_KEY__;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    return null;
  }

  private maxParentRank(task: Task | null, tasks: Task[]) {
    if (!task?.parentId) return null;
    const parent = tasks.find(t => t.id === task.parentId);
    return parent ? parent.rank : null;
  }

  private minChildRank(taskId: string, tasks: Task[]) {
    const children = tasks.filter(t => t.parentId === taskId);
    if (children.length === 0) return Infinity;
    return Math.min(...children.map(c => c.rank));
  }

  private applyRefusalStrategy(target: Task, candidateRank: number, parentRank: number | null, minChildRank: number) {
    let nextRank = candidateRank;
    if (parentRank !== null && nextRank <= parentRank) {
      nextRank = parentRank + this.rankStep;
    }
    if (Number.isFinite(minChildRank) && nextRank >= minChildRank) {
      nextRank = minChildRank - this.rankStep;
    }
    const violatesParent = parentRank !== null && nextRank <= parentRank;
    const violatesChild = Number.isFinite(minChildRank) && nextRank >= minChildRank;
    if (violatesParent || violatesChild) {
      console.warn('拒绝排序：违反拓扑约束', {
        taskId: target.id,
        parentRank,
        minChildRank,
        requested: candidateRank
      });
      return { ok: false, rank: candidateRank };
    }
    return { ok: true, rank: nextRank };
  }

  private updateActiveProject(mutator: (project: Project) => Project) {
    this.projects.update(projects => projects.map(p => p.id === this.activeProjectId() ? mutator(p) : p));
  }

  private gridPosition(stage: number, index: number) {
    return {
      x: (stage - 1) * this.stageSpacing + 120,
      y: 100 + index * this.rowSpacing
    };
  }

  private detectIncomplete(content: string) {
    return /- \[ \]/.test(content || '');
  }

  private stageBase(stage: number) {
    return this.rankRootBase + (stage - 1) * this.rankRootBase;
  }

  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null) {
    const sorted = siblings.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
    const base = parentRank !== null && parentRank !== undefined 
      ? parentRank + this.rankStep 
      : this.stageBase(stage);
    let prev: Task | null = null;
    let next: Task | null = null;
    if (beforeId) {
      const idx = sorted.findIndex(t => t.id === beforeId);
      if (idx >= 0) {
        next = sorted[idx];
        prev = idx > 0 ? sorted[idx - 1] : null;
      }
    }
    if (!beforeId || !next) {
      prev = sorted[sorted.length - 1] || null;
      next = null;
    }

    let rank: number;
    if (prev && next) {
      rank = (prev.rank + next.rank) / 2;
    } else if (prev && !next) {
      rank = prev.rank + this.rankStep;
    } else if (!prev && next) {
      rank = next.rank - this.rankStep;
    } else {
      rank = base;
    }

    return rank;
  }

  private rebalance(project: Project): Project {
    const tasks = project.tasks.map(t => ({ ...t }));
    const byId = new Map<string, Task>();
    tasks.forEach(t => byId.set(t.id, t));

    tasks.forEach(t => {
      if (t.rank === undefined || t.rank === null) {
        const base = t.stage ? this.stageBase(t.stage) : this.rankRootBase;
        t.rank = base + (t.order || 0) * this.rankStep;
      }
      t.hasIncompleteTask = this.detectIncomplete(t.content);
    });

    // Align children with parents for stage/rank monotonicity
    tasks.forEach(t => {
      if (t.parentId) {
        const parent = byId.get(t.parentId);
        if (parent && parent.stage !== null) {
          if (t.stage === null || t.stage <= parent.stage) {
            t.stage = parent.stage + 1;
          }
          if (t.rank <= parent.rank) {
            t.rank = parent.rank + this.rankStep;
          }
        }
      }
    });

    // Group by stage and normalize
    const grouped = new Map<number, Task[]>();
    tasks.forEach(t => {
      if (t.stage !== null) {
        if (!grouped.has(t.stage)) grouped.set(t.stage, []);
        grouped.get(t.stage)!.push(t);
      }
    });

    grouped.forEach((list, stage) => {
      list.sort((a, b) => a.rank - b.rank || a.order - b.order);
      list.forEach((t, idx) => {
        t.order = idx + 1;
        if (t.x === undefined || t.y === undefined) {
          const pos = this.gridPosition(stage, idx);
          t.x = pos.x;
          t.y = pos.y;
        }
      });
    });

    // Unassigned ordering
    const unassigned = tasks.filter(t => t.stage === null).sort((a, b) => a.rank - b.rank || a.order - b.order);
    unassigned.forEach((t, idx) => {
      t.order = idx + 1;
      t.displayId = '?';
    });

    // Build lookup again after mutations
    tasks.forEach(t => byId.set(t.id, t));

    // Stage 1 roots define the leading numbers
    const stage1Roots = tasks
      .filter(t => t.stage === 1 && !t.parentId)
      .sort((a, b) => a.rank - b.rank);

    stage1Roots.forEach((t, idx) => {
      t.displayId = `${idx + 1}`;
    });

    // Children inherit parent's id + letters based on rank order
    const children = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!children.has(t.parentId)) children.set(t.parentId, []);
        children.get(t.parentId)!.push(t);
      }
    });

    const assignChildren = (parentId: string) => {
      const parent = byId.get(parentId);
      if (!parent) return;
      const list = (children.get(parentId) || []).sort((a, b) => a.rank - b.rank);
      list.forEach((child, idx) => {
        if (parent.stage !== null && (child.stage === null || child.stage <= parent.stage)) {
          child.stage = parent.stage + 1;
        }
        const letter = this.letters[idx % this.letters.length];
        child.displayId = `${parent.displayId},${letter}`;
        assignChildren(child.id);
      });
    };

    stage1Roots.forEach(t => assignChildren(t.id));

    tasks.forEach(t => {
      if (!t.displayId) t.displayId = '?';
      if (t.stage === null) {
        t.parentId = null;
        t.displayId = '?';
      }
    });

    // Enforce gravity with cascading push-down
    const childrenMap = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId)!.push(t);
      }
    });

    const cascade = (node: Task) => {
      const kids = (childrenMap.get(node.id) || []).sort((a, b) => a.rank - b.rank);
      let floor = node.rank;
      kids.forEach(child => {
        if (child.rank <= floor) {
          child.rank = floor + this.rankStep;
        }
        floor = child.rank;
        cascade(child);
      });
    };

    stage1Roots.forEach(root => cascade(root));

    // Recompute orders after cascade
    tasks
      .filter(t => t.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || a.rank - b.rank)
      .forEach((t, idx, arr) => {
        const sameStage = arr.filter(s => s.stage === t.stage);
        const position = sameStage.findIndex(s => s.id === t.id);
        t.order = position + 1;
      });

    return { ...project, tasks };
  }

  // Computed
  readonly activeProject = computed(() => 
    this.projects().find(p => p.id === this.activeProjectId()) || null
  );

  readonly tasks = computed(() => this.activeProject()?.tasks || []);

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null);
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    // Sort tasks in stages
    for (const [key, val] of stagesMap.entries()) {
      val.sort((a, b) => a.order - b.order);
    }
    
    // Return sorted array of stage objects
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null);
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

    const regex = /- \[ \]\s*(.+)/g;

    tasks.forEach(t => {
      if (rootDisplayId) {
          const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
          if (!isDescendant) return;
      }

      // Clone regex to reset lastIndex
      const r = new RegExp(regex);
      let match;
      while ((match = r.exec(t.content)) !== null) {
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
    // Used for To-Do filter dropdown (only roots with unfinished tasks)
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => regex.test(t.content || ''));
    
    return tasks.filter(t => t.stage === 1).filter(root => {
        if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
        return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    // Used for Stage View filter dropdown (all roots)
    return this.tasks().filter(t => t.stage === 1).sort((a, b) => a.rank - b.rank);
  });

  constructor() {
    try {
        const key = this.resolveApiKey();
        if (key) {
            this.ai = new GoogleGenAI({ apiKey: key });
        } else {
            console.info('AI 未初始化：未提供 __GENAI_API_KEY__');
        }
    } catch (e) {
        console.warn('AI init failed', e);
    }

    // Seed data
    this.addProject({
        id: 'proj-1',
        name: 'Alpha 协议开发',
        description: 'NanoFlow 核心引擎的初始化协议开发计划。',
        createdDate: new Date().toISOString(),
        tasks: [
            { 
                id: 't1', title: '阶段 1: 环境初始化', content: '项目基础环境搭建。\n- [ ] 配置 Git 仓库\n- [ ] 安装 Node.js 依赖', 
                stage: 1, parentId: null, order: 1, rank: 10000, status: 'active', x: 100, y: 100, createdDate: new Date().toISOString(), displayId: '1' 
            },
             { 
                id: 't2', title: '核心逻辑实现', content: '开发核心业务逻辑。\n- [ ] 编写单元测试用例', 
                stage: 2, parentId: 't1', order: 1, rank: 10500, status: 'active', x: 300, y: 100, createdDate: new Date().toISOString(), displayId: '1,a' 
            }
        ],
        connections: [
            { source: 't1', target: 't2' }
        ]
    });
    this.activeProjectId.set('proj-1');
  }

  addProject(project: Project) {
    this.projects.update(p => [...p, this.rebalance(project)]);
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projects.update(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
  }

  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }

  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }

  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
  }

  updateTaskContent(taskId: string, newContent: string) {
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent } : t)
    }));
  }

  updateTaskTitle(taskId: string, title: string) {
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, title } : t)
    }));
  }

  // Update Task Position (for Flowchart)
  updateTaskPosition(taskId: string, x: number, y: number) {
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
    }));
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.updateActiveProject(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status } : t)
    }));
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ) {
    const activeP = this.activeProject();
    if (!activeP) return;

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null ? this.gridPosition(targetStage, newOrder - 1) : { x: 80 + Math.random() * 120, y: 80 + Math.random() * 120 };
    const parent = parentId ? activeP.tasks.find(t => t.id === parentId) : null;
    const candidateRank = targetStage === null
      ? this.rankRootBase + activeP.tasks.filter(t => t.stage === null).length * this.rankStep
      : this.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);

    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: targetStage,
      parentId: targetStage === null ? null : parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x, 
      y: pos.y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    const placed = this.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) return;
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.updateActiveProject(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.updateActiveProject(p => this.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    const activeP = this.activeProject();
    if (!activeP) return;
    const count = activeP.tasks.filter(t => t.stage === null).length;
    const rank = this.rankRootBase + count * this.rankStep;
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: count + 1,
      rank,
      status: 'active',
      x,
      y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    this.updateActiveProject(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }
  
  moveTaskToStage(taskId: string, newStage: number | null, beforeTaskId?: string | null, newParentId?: string | null) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      target.stage = newStage;
      target.parentId = newStage === null ? null : (newParentId !== undefined ? newParentId : target.parentId);

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
      const parentRank = this.maxParentRank(target, tasks);
      const minChildRank = this.minChildRank(target.id, tasks);
      if (newStage !== null) {
        const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) return p;
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = this.rankRootBase + unassignedCount * this.rankStep;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) return p;
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.rebalance({ ...p, tasks });
    });
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank ?? this.stageBase(stage);
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        const parentRank = this.maxParentRank(task, tasks);
        const minChildRank = this.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + this.rankStep;
      });
      return this.rebalance({ ...p, tasks });
    });
  }

  detachTask(taskId: string) {
    this.updateActiveProject(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = tasks.find(t => t.id === parentId);

      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent.stage + 1;
          }
        }
      });

      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = this.rankRootBase + unassignedCount * this.rankStep;
      target.displayId = '?';

      return this.rebalance({ ...p, tasks });
    });
  }

  // AI Capabilities
  async think(prompt: string): Promise<string> {
    if (!this.ai) return "AI 服务未初始化 (请检查 API Key)";
    try {
        const result = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                thinkingConfig: { thinkingBudget: 1024 }
            }
        });
        return result.text || "AI 未返回任何内容。";
    } catch (e) {
        return "AI 处理错误: " + e;
    }
  }
  
  async generateImage(prompt: string): Promise<string | null> {
      if (!this.ai) return null;
      try {
          const result = await this.ai.models.generateImages({
              model: 'imagen-4.0-generate-001',
              prompt: prompt,
              config: { numberOfImages: 1 }
          });
          return result.generatedImages?.[0]?.image?.imageBytes 
            ? `data:image/png;base64,${result.generatedImages[0].image.imageBytes}`
            : null;
      } catch (e) {
          console.error(e);
          return null;
      }
  }
  
  async editImageWithPrompt(imageBase64: string, editInstruction: string): Promise<string | null> {
      if (!this.ai) return null;
      try {
          const analysisResponse = await this.ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: {
                  parts: [
                      { inlineData: { mimeType: 'image/png', data: imageBase64.split(',')[1] } },
                      { text: `Generate a detailed image prompt that describes the new image resulting from applying this change: "${editInstruction}" to the provided image.` }
                  ]
              }
          });
          
          const newPrompt = analysisResponse.text;
          if (!newPrompt) return null;

          const imgResult = await this.ai.models.generateImages({
              model: 'imagen-4.0-generate-001',
              prompt: newPrompt,
              config: { numberOfImages: 1 }
          });
          
          return imgResult.generatedImages?.[0]?.image?.imageBytes
             ? `data:image/png;base64,${imgResult.generatedImages[0].image.imageBytes}`
             : null;
      } catch (e) {
          console.error("Edit Image Error", e);
          return null;
      }
  }
}
