import { Injectable, Signal, computed, signal } from '@angular/core';

export interface TaskNode {
  id: string; // UUID
  parentId: string | null;
  stageId: string;
  order: number;
  content: string;
}

export interface ViewTaskNode extends TaskNode {
  children: ViewTaskNode[];
  displayIndex: string;
  depth: number;
}

export interface FlowNode {
  id: string;
  label: string;
  stageId: string;
}

export interface FlowEdge {
  source: string;
  target: string;
}

@Injectable({ providedIn: 'root' })
export class TaskStateService {
  /**
   * Flat single source of truth for tasks.
   */
  readonly tasks = signal<TaskNode[]>([]);

  /**
   * Optional stage ordering (left-to-right). If empty, stringified stageIds are compared as numbers where possible.
   */
  readonly stageOrder = signal<string[]>([]);

  /**
   * Projection for quick lookup.
   */
  readonly taskMap: Signal<Map<string, TaskNode>> = computed(() => {
    return new Map(this.tasks().map(t => [t.id, t]));
  });

  /**
   * Computed tree for the UI; derived only from the flat tasks signal.
   */
  readonly viewTree: Signal<ViewTaskNode[]> = computed(() => this.buildTree(this.tasks()));

  /**
   * Flow-friendly projection for diagram components.
   */
  readonly graphView = computed(() => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];

    const walk = (node: ViewTaskNode) => {
      nodes.push({
        id: node.id,
        label: `${node.displayIndex} ${node.content}`.trim(),
        stageId: node.stageId
      });
      node.children.forEach(child => {
        edges.push({ source: node.id, target: child.id });
        walk(child);
      });
    };

    this.viewTree().forEach(root => walk(root));
    return { nodes, edges };
  });

  setTasks(tasks: TaskNode[]) {
    this.tasks.set(tasks.map(t => ({ ...t })));
  }

  setStageOrder(order: string[]) {
    this.stageOrder.set([...order]);
  }

  addTask(parentId: string | null, stageId: string, insertAfterId?: string) {
    this.tasks.update(list => {
      const siblings = list
        .filter(t => t.parentId === parentId)
        .map(t => ({ ...t }))
        .sort((a, b) => a.order - b.order);

      const insertionIndex = (() => {
        if (!insertAfterId) return siblings.length;
        const idx = siblings.findIndex(s => s.id === insertAfterId);
        return idx >= 0 ? idx + 1 : siblings.length;
      })();

      const parent = parentId ? list.find(t => t.id === parentId) : null;
      const constrainedStageId =
        parent && this.compareStage(stageId, parent.stageId) < 0 ? parent.stageId : stageId;

      const newTask: TaskNode = {
        id: this.uuid(),
        parentId,
        stageId: constrainedStageId,
        order: insertionIndex + 1,
        content: ''
      };

      siblings.splice(insertionIndex, 0, newTask);
      const normalizedSiblings = siblings.map((s, idx) => ({ ...s, order: idx + 1 }));
      const updatedIds = new Set(normalizedSiblings.map(s => s.id));

      return [
        ...list.map(t => (updatedIds.has(t.id) ? normalizedSiblings.find(s => s.id === t.id)! : t)),
        ...normalizedSiblings.filter(s => !list.some(t => t.id === s.id))
      ];
    });
  }

  moveTask(taskId: string, newParentId: string | null, newStageId: string, newIndex: number) {
    this.tasks.update(list => {
      const tasks = list.map(t => ({ ...t }));
      const targetIndex = tasks.findIndex(t => t.id === taskId);
      if (targetIndex === -1) return list;

      if (newParentId && this.isDescendant(newParentId, taskId, tasks)) {
        return list; // Reject cycles
      }

      const target = { ...tasks[targetIndex] };
      const parent = newParentId ? tasks.find(t => t.id === newParentId) : null;

      if (parent && this.compareStage(newStageId, parent.stageId) < 0) {
        newStageId = parent.stageId; // Auto-fix stage to honor monotonic rule
      }

      const withoutTarget = tasks.filter(t => t.id !== taskId);

      // Reorder source siblings after removal
      const sourceSiblings = withoutTarget
        .filter(t => t.parentId === target.parentId)
        .sort((a, b) => a.order - b.order)
        .map((s, idx) => ({ ...s, order: idx + 1 }));

      // Prepare destination siblings including the target
      const destinationSiblings = withoutTarget
        .filter(t => t.parentId === newParentId)
        .sort((a, b) => a.order - b.order)
        .map(s => ({ ...s }));

      const clampedIndex = Math.max(0, Math.min(newIndex, destinationSiblings.length));
      const moved = { ...target, parentId: newParentId, stageId: newStageId };
      destinationSiblings.splice(clampedIndex, 0, moved);
      destinationSiblings.forEach((s, idx) => (s.order = idx + 1));

      const updated = new Map<string, TaskNode>();
      [...sourceSiblings, ...destinationSiblings].forEach(s => updated.set(s.id, s));

      let next = withoutTarget.map(t => updated.get(t.id) ?? t);
      if (!next.some(t => t.id === moved.id)) {
        next = [...next, moved];
      }

      next = this.normalizeSubtreeStage(next, moved.id, moved.stageId);
      return next;
    });
  }

  private buildTree(tasks: TaskNode[]): ViewTaskNode[] {
    const byParent = this.groupByParent(tasks);
    const build = (parentId: string | null, depth: number, prefix: string | null): ViewTaskNode[] => {
      const siblings = [...(byParent.get(parentId) || [])].sort((a, b) => a.order - b.order);
      return siblings.map((task, idx) => {
        const token = this.indexToken(depth, idx);
        const displayIndex = prefix ? `${prefix}.${token}` : token;
        const children = build(task.id, depth + 1, displayIndex);
        return { ...task, depth, displayIndex, children };
      });
    };
    return build(null, 0, null);
  }

  private groupByParent(tasks: TaskNode[]) {
    const map = new Map<string | null, TaskNode[]>();
    const existingIds = new Set(tasks.map(t => t.id));
    tasks.forEach(task => {
      const parentKey = task.parentId && existingIds.has(task.parentId) ? task.parentId : null;
      if (!map.has(parentKey)) map.set(parentKey, []);
      map.get(parentKey)!.push(task);
    });
    return map;
  }

  private indexToken(depth: number, index: number): string {
    switch (depth) {
      case 0:
        return `${index + 1}`;
      case 1:
        return this.alphaIndex(index);
      case 2:
        return this.roman(index + 1);
      default:
        return `${index + 1}`;
    }
  }

  private alphaIndex(index: number): string {
    let n = index + 1;
    let res = '';
    while (n > 0) {
      n--;
      res = String.fromCharCode(97 + (n % 26)) + res;
      n = Math.floor(n / 26);
    }
    return res;
  }

  private roman(num: number): string {
    const map: [number, string][] = [
      [1000, 'm'],
      [900, 'cm'],
      [500, 'd'],
      [400, 'cd'],
      [100, 'c'],
      [90, 'xc'],
      [50, 'l'],
      [40, 'xl'],
      [10, 'x'],
      [9, 'ix'],
      [5, 'v'],
      [4, 'iv'],
      [1, 'i']
    ];
    let n = num;
    let res = '';
    for (const [value, sym] of map) {
      while (n >= value) {
        res += sym;
        n -= value;
      }
    }
    return res;
  }

  private compareStage(a: string, b: string): number {
    const order = this.stageOrder();
    const idxA = order.indexOf(a);
    const idxB = order.indexOf(b);
    const rankA = idxA >= 0 ? idxA : this.fallbackStageRank(a, order.length);
    const rankB = idxB >= 0 ? idxB : this.fallbackStageRank(b, order.length);
    return rankA - rankB;
  }

  private fallbackStageRank(stageId: string, offset: number): number {
    const numeric = Number(stageId);
    if (!Number.isNaN(numeric)) return offset + numeric;
    return offset + 100 + this.stringHash(stageId);
  }

  private normalizeSubtreeStage(tasks: TaskNode[], rootId: string, stageId: string): TaskNode[] {
    const byParent = this.groupByParent(tasks);
    const map = new Map(tasks.map(t => [t.id, { ...t }]));
    const walk = (nodeId: string, parentStage: string) => {
      const children = byParent.get(nodeId) || [];
      const parentRank = this.stageRank(parentStage);
      children.forEach(child => {
        const clone = { ...map.get(child.id)! };
        if (this.stageRank(clone.stageId) < parentRank) {
          clone.stageId = parentStage;
        }
        map.set(clone.id, clone);
        walk(clone.id, clone.stageId);
      });
    };

    const root = map.get(rootId);
    if (!root) return tasks;
    root.stageId = stageId;
    map.set(root.id, root);
    walk(root.id, root.stageId);
    return Array.from(map.values());
  }

  private stageRank(stageId: string): number {
    const order = this.stageOrder();
    const idx = order.indexOf(stageId);
    if (idx >= 0) return idx;
    return this.fallbackStageRank(stageId, order.length);
  }

  private isDescendant(candidateId: string, ancestorId: string, tasks: TaskNode[]) {
    let cursor: string | null | undefined = candidateId;
    const lookup = new Map(tasks.map(t => [t.id, t.parentId]));
    while (cursor) {
      if (cursor === ancestorId) return true;
      cursor = lookup.get(cursor) ?? null;
    }
    return false;
  }

  private stringHash(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash % 1000);
  }

  private uuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
