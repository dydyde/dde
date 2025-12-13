import { Task, Project, Connection, TaskStatus, Attachment, AttachmentType } from '../models';
import { nowISO } from './date';

/**
 * 数据验证工具
 * 在关键入口点验证数据完整性
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================
// 附件验证
// 附件功能已完整实现，包括 UI 和后端存储
// ============================================================

// 允许的附件 MIME 类型
const ALLOWED_MIME_TYPES: Record<AttachmentType, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'],
  link: [], // 链接类型不需要 MIME 验证
  file: [] // 通用文件类型不限制 MIME
};

// 最大附件大小 (10MB)
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// 每个任务最大附件数
const MAX_ATTACHMENTS_PER_TASK = 20;

/**
 * 验证单个附件
 */
export function validateAttachment(attachment: Partial<Attachment>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ID 验证
  if (!attachment.id || typeof attachment.id !== 'string') {
    errors.push('附件 ID 无效或缺失');
  }

  // 名称验证
  if (!attachment.name || typeof attachment.name !== 'string') {
    errors.push('附件名称无效或缺失');
  } else if (attachment.name.length > 255) {
    errors.push('附件名称过长（最大 255 字符）');
  }

  // URL 验证
  if (!attachment.url || typeof attachment.url !== 'string') {
    errors.push('附件 URL 无效或缺失');
  } else {
    try {
      new URL(attachment.url);
    } catch {
      // 允许相对路径或存储桶路径
      if (!attachment.url.startsWith('/') && !attachment.url.startsWith('storage/')) {
        warnings.push('附件 URL 格式可能无效');
      }
    }
  }

  // 类型验证
  const validTypes: AttachmentType[] = ['image', 'document', 'link', 'file'];
  if (!attachment.type || !validTypes.includes(attachment.type)) {
    errors.push(`附件类型无效: ${attachment.type}`);
  }

  // MIME 类型验证
  if (attachment.type && attachment.mimeType) {
    const allowedMimes = ALLOWED_MIME_TYPES[attachment.type];
    if (allowedMimes.length > 0 && !allowedMimes.includes(attachment.mimeType)) {
      warnings.push(`附件 MIME 类型 ${attachment.mimeType} 可能不受支持`);
    }
  }

  // 文件大小验证
  if (attachment.size !== undefined) {
    if (typeof attachment.size !== 'number' || attachment.size < 0) {
      errors.push('附件大小无效');
    } else if (attachment.size > MAX_ATTACHMENT_SIZE) {
      errors.push(`附件过大: ${(attachment.size / 1024 / 1024).toFixed(2)}MB（最大 10MB）`);
    }
  }

  // 创建日期验证
  if (!attachment.createdAt || typeof attachment.createdAt !== 'string') {
    warnings.push('附件缺少创建日期');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 验证任务数据
 */
export function validateTask(task: Partial<Task>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 必需字段
  if (!task.id || typeof task.id !== 'string') {
    errors.push('任务 ID 无效或缺失');
  }
  
  if (task.title !== undefined && typeof task.title !== 'string') {
    errors.push('任务标题必须是字符串');
  }

  // Rank 验证
  if (task.rank !== undefined) {
    if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) {
      errors.push(`任务 ${task.id} 的 rank 值无效: ${task.rank}`);
    } else if (task.rank < 0) {
      warnings.push(`任务 ${task.id} 的 rank 值为负数`);
    } else if (task.rank > 1000000000) {
      warnings.push(`任务 ${task.id} 的 rank 值过大`);
    }
  }

  // Stage 验证
  if (task.stage !== undefined && task.stage !== null) {
    if (typeof task.stage !== 'number' || task.stage < 1) {
      errors.push(`任务 ${task.id} 的 stage 值无效: ${task.stage}`);
    }
  }

  // Status 验证
  if (task.status !== undefined) {
    const validStatuses: TaskStatus[] = ['active', 'completed', 'archived'];
    if (!validStatuses.includes(task.status)) {
      errors.push(`任务 ${task.id} 的状态无效: ${task.status}`);
    }
  }

  // 坐标验证
  if (task.x !== undefined && (typeof task.x !== 'number' || !Number.isFinite(task.x))) {
    warnings.push(`任务 ${task.id} 的 X 坐标无效`);
  }
  if (task.y !== undefined && (typeof task.y !== 'number' || !Number.isFinite(task.y))) {
    warnings.push(`任务 ${task.id} 的 Y 坐标无效`);
  }

  // 附件验证
  if (task.attachments !== undefined) {
    if (!Array.isArray(task.attachments)) {
      errors.push(`任务 ${task.id} 的附件列表必须是数组`);
    } else {
      if (task.attachments.length > MAX_ATTACHMENTS_PER_TASK) {
        errors.push(`任务 ${task.id} 附件数量超限（最大 ${MAX_ATTACHMENTS_PER_TASK} 个）`);
      }
      
      // 验证每个附件
      for (let i = 0; i < task.attachments.length; i++) {
        const attachResult = validateAttachment(task.attachments[i]);
        errors.push(...attachResult.errors.map(e => `附件[${i}]: ${e}`));
        warnings.push(...attachResult.warnings.map(w => `附件[${i}]: ${w}`));
      }
      
      // 检查重复附件 ID
      const attachmentIds = new Set<string>();
      for (const att of task.attachments) {
        if (att.id && attachmentIds.has(att.id)) {
          errors.push(`任务 ${task.id} 存在重复的附件 ID: ${att.id}`);
        }
        if (att.id) attachmentIds.add(att.id);
      }
    }
  }

  // 标签验证
  if (task.tags !== undefined) {
    if (!Array.isArray(task.tags)) {
      errors.push(`任务 ${task.id} 的标签列表必须是数组`);
    } else {
      for (const tag of task.tags) {
        if (typeof tag !== 'string' || tag.length === 0) {
          errors.push(`任务 ${task.id} 包含无效的标签`);
        }
      }
    }
  }

  // 优先级验证
  if (task.priority !== undefined) {
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(task.priority)) {
      errors.push(`任务 ${task.id} 的优先级无效: ${task.priority}`);
    }
  }

  // 截止日期验证
  if (task.dueDate !== undefined && task.dueDate !== null) {
    if (typeof task.dueDate !== 'string') {
      errors.push(`任务 ${task.id} 的截止日期格式无效`);
    } else {
      const dueDate = new Date(task.dueDate);
      if (isNaN(dueDate.getTime())) {
        errors.push(`任务 ${task.id} 的截止日期无法解析`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 验证连接数据
 */
export function validateConnection(conn: Connection, taskIds: Set<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!conn.source || typeof conn.source !== 'string') {
    errors.push('连接源 ID 无效');
  } else if (!taskIds.has(conn.source)) {
    errors.push(`连接源任务不存在: ${conn.source}`);
  }

  if (!conn.target || typeof conn.target !== 'string') {
    errors.push('连接目标 ID 无效');
  } else if (!taskIds.has(conn.target)) {
    errors.push(`连接目标任务不存在: ${conn.target}`);
  }

  if (conn.source === conn.target) {
    errors.push('连接不能指向自身');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 验证项目数据
 */
export function validateProject(project: Partial<Project>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 基本字段验证
  if (!project.id || typeof project.id !== 'string') {
    errors.push('项目 ID 无效或缺失');
  }

  if (!project.name || typeof project.name !== 'string') {
    warnings.push('项目名称缺失');
  }

  // 任务数组验证
  if (!Array.isArray(project.tasks)) {
    errors.push('项目任务列表必须是数组');
  } else {
    const taskIds = new Set(project.tasks.map(t => t.id));
    
    // 检查重复 ID
    if (taskIds.size !== project.tasks.length) {
      errors.push('存在重复的任务 ID');
    }

    // 验证每个任务
    for (const task of project.tasks) {
      const taskResult = validateTask(task);
      errors.push(...taskResult.errors);
      warnings.push(...taskResult.warnings);

      // 验证父子关系
      if (task.parentId && !taskIds.has(task.parentId)) {
        errors.push(`任务 ${task.id} 的父任务不存在: ${task.parentId}`);
      }
    }

    // 验证连接 - 先检查 connections 存在性
    if (project.connections === undefined || project.connections === null) {
      warnings.push('项目连接列表缺失，已初始化为空数组');
    } else if (!Array.isArray(project.connections)) {
      errors.push('项目连接列表必须是数组');
    } else {
      for (const conn of project.connections) {
        const connResult = validateConnection(conn, taskIds);
        errors.push(...connResult.errors);
        warnings.push(...connResult.warnings);
      }
    }
  }

  // 版本号验证
  if (project.version !== undefined && typeof project.version !== 'number') {
    warnings.push('项目版本号应该是数字');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 安全地解析和验证附件数据
 */
export function sanitizeAttachment(attachment: any): Attachment {
  const validTypes: AttachmentType[] = ['image', 'document', 'link', 'file'];
  const type = validTypes.includes(attachment.type) ? attachment.type : 'file';
  
  return {
    id: String(attachment.id || crypto.randomUUID()),
    type,
    name: String(attachment.name || '未命名附件'),
    url: String(attachment.url || ''),
    thumbnailUrl: typeof attachment.thumbnailUrl === 'string' ? attachment.thumbnailUrl : undefined,
    mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
    size: typeof attachment.size === 'number' && attachment.size >= 0 ? attachment.size : undefined,
    createdAt: attachment.createdAt || nowISO()
  };
}

/**
 * 安全地解析和验证任务数据
 * 用于从外部源（如 Supabase）加载数据时
 * 
 * 注意：此函数会静默修复无效数据，修复内容已在日志中记录
 */
export function sanitizeTask(task: any): Task {
  const fixes: string[] = [];
  
  // 解析附件
  const attachments = Array.isArray(task.attachments)
    ? task.attachments.slice(0, MAX_ATTACHMENTS_PER_TASK).map(sanitizeAttachment)
    : undefined;

  // 解析标签
  const tags = Array.isArray(task.tags)
    ? task.tags.filter((t: any) => typeof t === 'string' && t.length > 0)
    : undefined;

  // 解析优先级
  const validPriorities = ['low', 'medium', 'high', 'urgent'];
  const priority = validPriorities.includes(task.priority) ? task.priority : undefined;

  // 解析截止日期
  let dueDate: string | null | undefined = undefined;
  if (task.dueDate === null) {
    dueDate = null;
  } else if (typeof task.dueDate === 'string') {
    const parsedDate = new Date(task.dueDate);
    if (!isNaN(parsedDate.getTime())) {
      dueDate = task.dueDate;
    }
  }

  // 记录修复的字段
  if (!task.id) fixes.push('id (已生成)');
  if (!task.title || typeof task.title !== 'string') fixes.push('title');
  if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) fixes.push('rank');
  if (typeof task.order !== 'number' || !Number.isFinite(task.order)) fixes.push('order');
  if (!['active', 'completed', 'archived'].includes(task.status)) fixes.push('status');
  if (typeof task.x !== 'number' || !Number.isFinite(task.x)) fixes.push('x');
  if (typeof task.y !== 'number' || !Number.isFinite(task.y)) fixes.push('y');
  
  // 输出修复日志
  if (fixes.length > 0) {
    console.warn(`[sanitizeTask] 任务 ${task.id || 'unknown'} 的以下字段已修复:`, fixes.join(', '));
  }

  return {
    id: String(task.id || crypto.randomUUID()),
    title: String(task.title || '未命名任务'),
    content: String(task.content || ''),
    stage: typeof task.stage === 'number' ? task.stage : null,
    parentId: typeof task.parentId === 'string' ? task.parentId : null,
    order: typeof task.order === 'number' && Number.isFinite(task.order) ? task.order : 0,
    rank: typeof task.rank === 'number' && Number.isFinite(task.rank) ? task.rank : 10000,
    status: task.status === 'completed' ? 'completed' : (task.status === 'archived' ? 'archived' : 'active'),
    x: typeof task.x === 'number' && Number.isFinite(task.x) ? task.x : 0,
    y: typeof task.y === 'number' && Number.isFinite(task.y) ? task.y : 0,
    createdDate: task.createdDate || nowISO(),
    displayId: String(task.displayId || '?'),
    shortId: typeof task.shortId === 'string' ? task.shortId : undefined,
    hasIncompleteTask: Boolean(task.hasIncompleteTask),
    deletedAt: typeof task.deletedAt === 'string' ? task.deletedAt : (task.deletedAt === null ? null : null),
    attachments,
    tags,
    priority,
    dueDate
  };
}

/**
 * 安全地解析和验证项目数据
 */
export function sanitizeProject(project: any): Project {
  const tasks = Array.isArray(project.tasks)
    ? project.tasks.map(sanitizeTask)
    : [];

  // 修复因 tombstone/软删除过滤等原因导致的结构断裂：
  // - parentId 指向不存在的任务时，降级为根任务（parentId = null）
  // - 过滤掉引用不存在任务的连接
  const taskIds = new Set(tasks.map(t => t.id));
  const fixedTasks = tasks.map(t => {
    if (t.parentId && !taskIds.has(t.parentId)) {
      return { ...t, parentId: null };
    }
    if (t.parentId === t.id) {
      return { ...t, parentId: null };
    }
    return t;
  });

  const connections = Array.isArray(project.connections)
    ? project.connections
        .filter((c: any) => c && c.source && c.target)
        .map((c: any) => ({
          id: c.id ? String(c.id) : crypto.randomUUID(),
          source: String(c.source),
          target: String(c.target),
          description: c.description ? String(c.description) : undefined,
          deletedAt: c.deletedAt ? String(c.deletedAt) : undefined
        }))
        .filter(c => taskIds.has(c.source) && taskIds.has(c.target) && c.source !== c.target)
    : [];

  return {
    id: String(project.id || crypto.randomUUID()),
    name: String(project.name || '未命名项目'),
    description: String(project.description || ''),
    createdDate: project.createdDate || nowISO(),
    tasks: fixedTasks,
    connections,
    updatedAt: project.updatedAt || nowISO(),
    version: typeof project.version === 'number' ? project.version : 0
  };
}

/**
 * 检测循环依赖
 */
export function detectCycles(tasks: Task[]): { hasCycle: boolean; cycleNodes: string[] } {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const cycleNodes: string[] = [];
  
  for (const task of tasks) {
    if (!task.parentId) continue;
    
    const visited = new Set<string>();
    let current: string | null = task.parentId;
    
    while (current) {
      if (current === task.id) {
        cycleNodes.push(task.id);
        break;
      }
      if (visited.has(current)) {
        break;
      }
      visited.add(current);
      
      const parent = taskMap.get(current);
      current = parent?.parentId || null;
    }
  }
  
  return {
    hasCycle: cycleNodes.length > 0,
    cycleNodes
  };
}

/**
 * 检测孤儿节点
 */
export function detectOrphans(tasks: Task[]): string[] {
  const taskIds = new Set(tasks.map(t => t.id));
  const orphans: string[] = [];
  
  for (const task of tasks) {
    if (task.parentId && !taskIds.has(task.parentId)) {
      orphans.push(task.id);
    }
  }
  
  return orphans;
}
