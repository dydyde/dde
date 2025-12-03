/**
 * Supabase 数据库类型到前端领域模型的映射器
 * 
 * 【架构边界】
 * - 此层负责 snake_case (DB) ↔ camelCase (Frontend) 转换
 * - 仅 Service 层可以使用这些映射器
 * - Component 层永远不应直接接触 supabase-types.ts
 * 
 * 【设计原则】
 * - 数据库是"底层协议"，前端模型是"领域语言"
 * - 数据库变更不应击穿到 UI 代码
 * - 所有转换逻辑集中在此文件，便于维护和测试
 */

import type {
  Json,
  TaskRow,
  TaskInsert,
  TaskUpdate,
  ConnectionRow,
  ConnectionInsert,
  UserPreferencesRow,
  ProjectRow,
  TaskStatusDb,
  TaskPriorityDb,
} from './supabase-types';

import type {
  Task,
  TaskStatus,
  Connection,
  UserPreferences,
  ThemeType,
  Attachment,
} from './index';

// ============================================
// 任务映射器
// ============================================

/**
 * 将数据库任务行转换为前端任务模型
 */
export function mapTaskFromDb(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? '',
    stage: row.stage,
    parentId: row.parent_id,
    order: row.order,
    rank: row.rank,
    status: row.status as TaskStatus,
    x: row.x,
    y: row.y,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
    displayId: '?', // 由前端动态计算
    shortId: row.short_id ?? undefined,
    hasIncompleteTask: false, // 由前端计算
    deletedAt: row.deleted_at,
    attachments: parseAttachments(row.attachments),
    tags: parseTags(row.tags),
    priority: row.priority as Task['priority'],
    dueDate: row.due_date,
  };
}

/**
 * 将前端任务模型转换为数据库插入数据
 */
export function mapTaskToDbInsert(task: Task, projectId: string): TaskInsert {
  return {
    id: task.id,
    project_id: projectId,
    parent_id: task.parentId,
    title: task.title,
    content: task.content,
    stage: task.stage,
    order: task.order,
    rank: task.rank,
    status: task.status as TaskStatusDb,
    x: task.x,
    y: task.y,
    short_id: task.shortId,
    priority: task.priority as TaskPriorityDb,
    due_date: task.dueDate,
    tags: task.tags ?? [],
    attachments: mapAttachmentsToJson(task.attachments),
    deleted_at: task.deletedAt,
  };
}

/**
 * 将前端任务模型转换为数据库更新数据
 */
export function mapTaskToDbUpdate(task: Partial<Task>): TaskUpdate {
  const update: TaskUpdate = {};
  
  if (task.parentId !== undefined) update.parent_id = task.parentId;
  if (task.title !== undefined) update.title = task.title;
  if (task.content !== undefined) update.content = task.content;
  if (task.stage !== undefined) update.stage = task.stage;
  if (task.order !== undefined) update.order = task.order;
  if (task.rank !== undefined) update.rank = task.rank;
  if (task.status !== undefined) update.status = task.status as TaskStatusDb;
  if (task.x !== undefined) update.x = task.x;
  if (task.y !== undefined) update.y = task.y;
  if (task.shortId !== undefined) update.short_id = task.shortId;
  if (task.priority !== undefined) update.priority = task.priority as TaskPriorityDb;
  if (task.dueDate !== undefined) update.due_date = task.dueDate;
  if (task.tags !== undefined) update.tags = task.tags;
  if (task.attachments !== undefined) {
    update.attachments = mapAttachmentsToJson(task.attachments);
  }
  if (task.deletedAt !== undefined) update.deleted_at = task.deletedAt;
  
  return update;
}

// ============================================
// 连接映射器
// ============================================

/**
 * 将数据库连接行转换为前端连接模型
 */
export function mapConnectionFromDb(row: ConnectionRow): Connection {
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    description: row.description ?? undefined,
  };
}

/**
 * 将前端连接模型转换为数据库插入数据
 */
export function mapConnectionToDbInsert(conn: Connection, projectId: string): ConnectionInsert {
  return {
    id: conn.id,
    project_id: projectId,
    source_id: conn.source,
    target_id: conn.target,
    description: conn.description,
  };
}

// ============================================
// 用户偏好设置映射器
// ============================================

/**
 * 将数据库用户偏好设置行转换为前端模型
 */
export function mapUserPreferencesFromDb(row: UserPreferencesRow): UserPreferences {
  return {
    theme: (row.theme as ThemeType) ?? 'default',
    layoutDirection: (row.layout_direction as 'ltr' | 'rtl') ?? 'ltr',
    floatingWindowPref: (row.floating_window_pref as 'auto' | 'fixed') ?? 'auto',
  };
}

/**
 * 将前端用户偏好设置转换为数据库更新数据
 */
export function mapUserPreferencesToDb(prefs: Partial<UserPreferences>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  
  if (prefs.theme !== undefined) result.theme = prefs.theme;
  if (prefs.layoutDirection !== undefined) result.layout_direction = prefs.layoutDirection;
  if (prefs.floatingWindowPref !== undefined) result.floating_window_pref = prefs.floatingWindowPref;
  
  return result;
}

// ============================================
// 项目映射器
// ============================================

/**
 * 将数据库项目行转换为前端项目基础数据（不含 tasks/connections）
 * 注意：tasks 和 connections 需要从独立表加载后单独设置
 */
export function mapProjectBaseFromDb(row: ProjectRow): {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  updatedAt?: string;
  version: number;
} {
  return {
    id: row.id,
    name: row.title ?? 'Untitled project',
    description: row.description ?? '',
    createdDate: row.created_date ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? undefined,
    version: row.version ?? 0,
  };
}

// ============================================
// 辅助函数
// ============================================

/**
 * 解析附件 JSON 数据
 */
function parseAttachments(json: unknown): Attachment[] | undefined {
  if (!json || !Array.isArray(json)) return undefined;
  if (json.length === 0) return undefined;
  
  return json.map((item: Record<string, unknown>) => ({
    id: String(item.id ?? ''),
    type: (item.type as Attachment['type']) ?? 'file',
    name: String(item.name ?? ''),
    url: String(item.url ?? ''),
    thumbnailUrl: item.thumbnailUrl ? String(item.thumbnailUrl) : undefined,
    mimeType: item.mimeType ? String(item.mimeType) : undefined,
    size: typeof item.size === 'number' ? item.size : undefined,
    createdAt: String(item.createdAt ?? item.created_at ?? new Date().toISOString()),
    signedAt: item.signedAt ? String(item.signedAt) : undefined,
    deletedAt: item.deletedAt ? String(item.deletedAt) : undefined,
  }));
}

/**
 * 解析标签 JSON 数据
 */
function parseTags(json: unknown): string[] | undefined {
  if (!json || !Array.isArray(json)) return undefined;
  if (json.length === 0) return undefined;
  
  return json.filter((item): item is string => typeof item === 'string');
}

/**
 * 将附件模型转换为数据库 JSON 格式
 */
function mapAttachmentToDb(attachment: Attachment): Record<string, unknown> {
  return {
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    url: attachment.url,
    thumbnailUrl: attachment.thumbnailUrl,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt,
    signedAt: attachment.signedAt,
    deletedAt: attachment.deletedAt,
  };
}

/**
 * 将附件数组转换为 JSON 兼容格式
 */
function mapAttachmentsToJson(attachments: Attachment[] | undefined): Json {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map(a => mapAttachmentToDb(a)) as unknown as Json;
}

// ============================================
// 批量转换辅助函数
// ============================================

/**
 * 批量转换任务列表
 */
export function mapTasksFromDb(rows: TaskRow[]): Task[] {
  return rows.map(mapTaskFromDb);
}

/**
 * 批量转换连接列表
 */
export function mapConnectionsFromDb(rows: ConnectionRow[]): Connection[] {
  return rows.map(mapConnectionFromDb);
}
