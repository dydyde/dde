import { Injectable, signal, computed, effect } from '@angular/core';
import { GoogleGenAI } from '@google/genai';

export interface Task {
  id: string;
  title: string;
  content: string; // Markdown
  stage: number | null; // Null if unassigned
  parentId: string | null;
  order: number; // Order within stage/parent
  status: 'active' | 'completed';
  x: number; // Flowchart X
  y: number; // Flowchart Y
  createdDate: string;
  displayId: string; // "1", "1,a", "2,b" etc.
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
  readonly activeView = signal<'text' | 'flow'>('text');
  readonly filterMode = signal<'all' | string>('all'); // 'all' or a root task ID
  
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
    const regex = /- \[ \]\s*(.+)/g;

    tasks.forEach(t => {
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
    // Used for filter dropdown
    return this.tasks().filter(t => t.stage === 1);
  });

  constructor() {
    try {
        // Initialize AI if key is present
        if (process.env['API_KEY']) {
            this.ai = new GoogleGenAI({ apiKey: process.env['API_KEY'] });
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
                stage: 1, parentId: null, order: 1, status: 'active', x: 100, y: 100, createdDate: new Date().toISOString(), displayId: '1' 
            },
             { 
                id: 't2', title: '核心逻辑实现', content: '开发核心业务逻辑。\n- [ ] 编写单元测试用例', 
                stage: 2, parentId: 't1', order: 1, status: 'active', x: 300, y: 100, createdDate: new Date().toISOString(), displayId: '1,a' 
            }
        ],
        connections: [
            { source: 't1', target: 't2' }
        ]
    });
    this.activeProjectId.set('proj-1');
  }

  addProject(project: Project) {
    this.projects.update(p => [...p, project]);
  }

  updateTaskContent(taskId: string, newContent: string) {
    this.projects.update(projects => {
      return projects.map(p => {
        if (p.id === this.activeProjectId()) {
          return {
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent } : t)
          };
        }
        return p;
      });
    });
  }

  // Update Task Position (for Flowchart)
  updateTaskPosition(taskId: string, x: number, y: number) {
    this.projects.update(projects => {
        return projects.map(p => {
            if (p.id === this.activeProjectId()) {
                return {
                    ...p,
                    tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
                };
            }
            return p;
        });
    });
  }

  generateDisplayId(parentId: string | null, stage: number): string {
      const tasks = this.tasks();
      if (!parentId) {
          // Root level (Stage 1 usually)
          const roots = tasks.filter(t => !t.parentId && t.stage === stage);
          return (roots.length + 1).toString();
      } else {
          // Child
          const parent = tasks.find(t => t.id === parentId);
          if (!parent) return '?';
          
          // Siblings
          const siblings = tasks.filter(t => t.parentId === parentId && t.stage === stage);
          
          // Letter based: a, b, c...
          const letters = 'abcdefghijklmnopqrstuvwxyz';
          const index = siblings.length;
          const suffix = letters[index % 26];
          return `${parent.displayId},${suffix}`;
      }
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

    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: targetStage,
      parentId,
      order: Date.now(),
      status: 'active',
      x: Math.random() * 400, 
      y: Math.random() * 400,
      createdDate: new Date().toISOString(),
      displayId: targetStage !== null ? this.generateDisplayId(parentId, targetStage) : '?'
    };

    this.projects.update(projs => projs.map(p => {
        if (p.id === activeP.id) {
            const newTasks = [...p.tasks, newTask];
            let newConns = [...p.connections];
            if (parentId && targetStage !== null) {
                newConns.push({ source: parentId, target: newTask.id });
            }
            return { ...p, tasks: newTasks, connections: newConns };
        }
        return p;
    }));
  }
  
  moveTaskToStage(taskId: string, newStage: number | null) {
      this.projects.update(projs => projs.map(p => {
          if (p.id === this.activeProjectId()) {
              return {
                  ...p,
                  tasks: p.tasks.map(t => t.id === taskId ? { ...t, stage: newStage } : t)
              };
          }
          return p;
      }));
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
