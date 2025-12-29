/**
 * API 响应类型定义 - 边境防御类型安全
 * 
 * 这些类型定义用于确保"系统边界"的类型安全：
 * 1. API 响应结构
 * 2. 数据库行映射
 * 3. 外部数据解析
 * 
 * 【设计原则】
 * - 边境防御：严格定义入口和出口类型
 * - 类型守卫：运行时验证外部数据
 * - 内部灵活：中间处理允许适度使用 any
 */

import { Task, Project, Connection, Attachment, TaskStatus, AttachmentType } from './index';

// ========== Supabase API 响应类型 ==========

/**
 * Supabase 通用 API 响应
 */
export interface SupabaseResponse<T> {
  data: T | null;
  error: SupabaseError | null;
  count?: number;
}

/**
 * Supabase 错误结构
 */
export interface SupabaseError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

/**
 * 项目保存结果
 */
export interface ProjectSaveResult {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  error?: string;
}

/**
 * 任务保存结果
 */
export interface TaskSaveResult {
  success: boolean;
  error?: string;
  savedCount?: number;
}

/**
 * 连接同步结果
 */
export interface ConnectionSyncResult {
  success: boolean;
  error?: string;
  created?: number;
  updated?: number;
  deleted?: number;
}

// ========== 数据库行类型（从数据库直接读取的原始结构）==========

/**
 * 任务表行类型
 * 对应 Supabase tasks 表结构
 */
export interface TaskRowFromDB {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string | null;
  content: string | null;
  stage: number | null;
  order: number | null;
  rank: number | null;
  status: string | null;
  x: number | null;
  y: number | null;
  short_id: string | null;
  priority: string | null;
  due_date: string | null;
  tags: unknown; // JSON 数组，需要运行时验证
  attachments: unknown; // JSON 数组，需要运行时验证
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * 连接表行类型
 * 对应 Supabase connections 表结构
 */
export interface ConnectionRowFromDB {
  id: string;
  project_id: string;
  source_id: string | null;
  target_id: string | null;
  /** 联系块标题 */
  title: string | null;
  description: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * 项目表行类型
 * 对应 Supabase projects 表结构
 */
export interface ProjectRowFromDB {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number | null;
  migrated_to_v2: boolean | null;
  // v1 格式：JSONB 数据（已废弃但仍需支持迁移）
  data: unknown;
}

/**
 * 用户偏好设置表行类型
 */
export interface UserPreferencesRowFromDB {
  user_id: string;
  theme: string | null;
  layout_direction: string | null;
  floating_window_pref: string | null;
  updated_at: string | null;
}

// ========== 类型守卫函数 ==========

/**
 * 验证任务状态是否合法
 */
export function isValidTaskStatus(status: unknown): status is TaskStatus {
  return status === 'active' || status === 'completed' || status === 'archived';
}

/**
 * 验证附件类型是否合法
 */
export function isValidAttachmentType(type: unknown): type is AttachmentType {
  return type === 'image' || type === 'document' || type === 'link' || type === 'file';
}

/**
 * 验证优先级是否合法
 */
export function isValidPriority(priority: unknown): priority is Task['priority'] {
  return priority === undefined || 
         priority === null || 
         priority === 'low' || 
         priority === 'medium' || 
         priority === 'high' || 
         priority === 'urgent';
}

/**
 * 验证字符串数组
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * 验证附件数组
 */
export function isAttachmentArray(value: unknown): value is Attachment[] {
  if (!Array.isArray(value)) return false;
  return value.every(item => 
    typeof item === 'object' &&
    item !== null &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.url === 'string' &&
    isValidAttachmentType(item.type)
  );
}

// ========== 安全解析函数 ==========

/**
 * 安全解析任务行数据
 * 将数据库原始行转换为类型安全的 Task 对象
 */
export function parseTaskRow(row: TaskRowFromDB): Task {
  const nowISO = new Date().toISOString();
  
  // 解析标签
  let tags: string[] | undefined;
  if (Array.isArray(row.tags)) {
    tags = row.tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tags.length === 0) tags = undefined;
  }
  
  // 解析附件
  let attachments: Attachment[] | undefined;
  if (Array.isArray(row.attachments)) {
    attachments = row.attachments
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map(a => parseAttachment(a))
      .filter((a): a is Attachment => a !== null);
    if (attachments.length === 0) attachments = undefined;
  }
  
  // 解析状态
  const status: TaskStatus = isValidTaskStatus(row.status) ? row.status : 'active';
  
  // 解析优先级
  const priority = isValidPriority(row.priority) ? row.priority : undefined;
  
  return {
    id: row.id,
    title: row.title ?? '未命名任务',
    content: row.content ?? '',
    stage: row.stage,
    parentId: row.parent_id,
    order: row.order ?? 0,
    rank: row.rank ?? 10000,
    status,
    x: row.x ?? 0,
    y: row.y ?? 0,
    createdDate: row.created_at ?? nowISO,
    updatedAt: row.updated_at ?? undefined,
    displayId: '?', // 由 LayoutService 计算
    shortId: row.short_id ?? undefined,
    hasIncompleteTask: false, // 由业务逻辑计算
    deletedAt: row.deleted_at,
    attachments,
    tags,
    priority,
    dueDate: row.due_date,
  };
}

/**
 * 安全解析附件数据
 */
export function parseAttachment(data: Record<string, unknown>): Attachment | null {
  if (!data.id || !data.name || !data.url || !data.type) {
    return null;
  }
  
  const type = isValidAttachmentType(data.type) ? data.type : 'file';
  
  return {
    id: String(data.id),
    type,
    name: String(data.name),
    url: String(data.url),
    thumbnailUrl: typeof data.thumbnailUrl === 'string' ? data.thumbnailUrl : undefined,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
    size: typeof data.size === 'number' ? data.size : undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    signedAt: typeof data.signedAt === 'string' ? data.signedAt : undefined,
    deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : undefined,
  };
}

/**
 * 安全解析连接行数据
 */
export function parseConnectionRow(row: ConnectionRowFromDB): Connection | null {
  if (!row.source_id || !row.target_id) {
    return null;
  }
  
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    deletedAt: row.deleted_at,
  };
}

/**
 * 安全解析项目行数据
 */
export function parseProjectRow(
  row: ProjectRowFromDB, 
  tasks: Task[], 
  connections: Connection[]
): Project {
  return {
    id: row.id,
    name: row.title ?? '未命名项目',
    description: row.description ?? '',
    createdDate: row.created_date ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? undefined,
    version: row.version ?? 0,
    tasks,
    connections,
  };
}

// ========== 序列化函数（用于写入数据库）==========

/**
 * 将 Task 转换为数据库行格式
 */
export function taskToRow(task: Task, projectId: string): Omit<TaskRowFromDB, 'created_at' | 'updated_at'> {
  return {
    id: task.id,
    project_id: projectId,
    parent_id: task.parentId,
    title: task.title,
    content: task.content,
    stage: task.stage,
    order: task.order,
    rank: task.rank,
    status: task.status,
    x: task.x,
    y: task.y,
    short_id: task.shortId ?? null,
    priority: task.priority ?? null,
    due_date: task.dueDate ?? null,
    tags: task.tags ?? [],
    attachments: task.attachments ?? [],
    deleted_at: task.deletedAt ?? null,
  };
}

/**
 * 将 Connection 转换为数据库行格式
 */
export function connectionToRow(conn: Connection, projectId: string): Omit<ConnectionRowFromDB, 'created_at' | 'updated_at'> {
  return {
    id: conn.id,
    project_id: projectId,
    source_id: conn.source,
    target_id: conn.target,
    title: conn.title ?? null,
    description: conn.description ?? null,
    deleted_at: conn.deletedAt ?? null,
  };
}
