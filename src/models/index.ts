// ============================================
// NanoFlow 数据模型定义
// ============================================

/**
 * 任务状态枚举
 * - active: 活动状态，正在进行中
 * - completed: 已完成
 * - archived: 已归档，不显示在主视图中但仍可搜索和恢复
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * 附件类型
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * 附件模型
 */
export interface Attachment {
  id: string;
  type: AttachmentType;
  name: string;
  url: string; // 对于存储在 Supabase Storage 的文件，这是签名 URL
  thumbnailUrl?: string; // 图片缩略图
  mimeType?: string;
  size?: number; // 文件大小（字节）
  createdAt: string;
  /** URL 签名时间戳，用于准确判断签名 URL 是否过期 */
  signedAt?: string;
  /** 软删除时间戳，存在表示已标记删除，等待后台清理 */
  deletedAt?: string;
}

/**
 * 任务模型
 */
export interface Task {
  id: string;
  title: string;
  content: string; // Markdown 内容
  stage: number | null; // null 表示未分配阶段
  parentId: string | null;
  order: number; // 阶段内排序
  rank: number; // 基于重力的排序权重
  status: TaskStatus;
  x: number; // 流程图 X 坐标
  y: number; // 流程图 Y 坐标
  createdDate: string;
  updatedAt?: string; // 最后更新时间戳，用于冲突解决时的版本比较
  displayId: string; // 显示 ID，如 "1", "1,a", "2,b" (动态计算，会随位置变化)
  shortId?: string; // 永久短 ID，如 "NF-A1B2" (创建时生成，永不改变)
  hasIncompleteTask?: boolean; // 是否包含未完成的待办项
  deletedAt?: string | null; // 软删除时间戳，null 表示未删除
  
  // 删除任务时保存的连接，用于恢复时还原
  deletedConnections?: Connection[];

  // 删除任务时保存的位置信息，用于恢复时尽可能回到原位置/层级
  deletedMeta?: {
    parentId: string | null;
    stage: number | null;
    order: number;
    rank: number;
    x: number;
    y: number;
  };
  
  // 新增：附件支持
  attachments?: Attachment[];
  
  // 新增：标签支持（预留）
  tags?: string[];
  
  // 新增：优先级（预留）
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  
  // 新增：截止日期（预留）
  dueDate?: string | null;
}

/**
 * 连接模型（任务之间的关联）
 */
export interface Connection {
  /** 连接的唯一标识符（必需，用于同步和恢复） */
  id: string;
  source: string;
  target: string;
  description?: string; // 联系块描述
  /** 软删除时间戳，存在表示已标记删除，等待恢复或永久删除 */
  deletedAt?: string | null;
}

/**
 * 项目模型
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string; // 用于冲突检测
  version?: number; // 数据版本号
  // 视图状态持久化
  viewState?: ViewState;
  // 流程图缩略图
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/**
 * 视图状态（用于持久化流程图视口位置）
 */
export interface ViewState {
  scale: number; // 缩放比例
  positionX: number; // 视口 X 位置
  positionY: number; // 视口 Y 位置
}

/**
 * 未完成项目模型（待办事项）
 */
export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string;
}

/**
 * 用户偏好设置
 */
export interface UserPreferences {
  theme: ThemeType;
  layoutDirection: 'ltr' | 'rtl';
  floatingWindowPref: 'auto' | 'fixed';
}

/**
 * 主题类型
 */
export type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * Supabase 项目行数据结构
 * 支持 v1 (JSONB) 和 v2 (独立表) 两种格式
 */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  updated_at?: string | null;
  version?: number;
  /** v1 格式: 存储 tasks 和 connections 的 JSONB 列 */
  data?: {
    tasks?: Task[];
    connections?: Connection[];
    version?: number;
  } | null;
  /** v2 格式: 标记是否已迁移到独立表 */
  migrated_to_v2?: boolean;
}

/**
 * 同步状态
 */
export interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: { 
    local: Project; 
    remote: Project;
    projectId: string;
    remoteData?: Project;
  } | null;
}

/**
 * 撤销/重做操作类型
 */
export type UndoActionType = 
  | 'task-create'
  | 'task-delete'
  | 'task-update'
  | 'task-move'
  | 'connection-create'
  | 'connection-delete'
  | 'connection-update'
  | 'project-update';

/**
 * 撤销/重做操作记录
 */
export interface UndoAction {
  type: UndoActionType;
  timestamp: number;
  projectId: string;
  /** 记录操作时的项目版本号，用于检测远程更新冲突 */
  projectVersion?: number;
  data: {
    before: Partial<Project>;
    after: Partial<Project>;
  };
}

// ============================================
// GoJS 边界类型导出
// ============================================
export * from './gojs-boundary';

// ============================================
// 流程图视图状态导出
// ============================================
export * from './flow-view-state';

// ============================================
// API 类型定义导出（边境防御）
// ============================================
export * from './api-types';

// ============================================
// Supabase 映射器导出（仅供 Service 层使用）
// ============================================
// 注意：supabase-types.ts 不在此导出
// Service 层如需访问原始数据库类型，应直接 import from './supabase-types'
// 这保持了"数据库协议层"与"领域模型层"的边界
export * from './supabase-mapper';
