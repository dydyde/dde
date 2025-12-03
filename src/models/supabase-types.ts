/**
 * Supabase 数据库类型定义
 * 
 * 【重要】此文件是"数据库协议层"，直接映射数据库 Schema
 * - 字段命名使用 snake_case（与数据库一致）
 * - 仅 Service 层可以访问这些类型
 * - Component 层应该使用 src/models/index.ts 中的领域模型
 * 
 * 生成方式：基于 scripts/supabase-setup.sql 手动创建
 * 理想情况下应使用 `supabase gen types typescript` 自动生成
 * 
 * @see https://supabase.com/docs/reference/javascript/typescript-support
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Supabase 数据库 Schema 定义
 */
export interface Database {
  public: {
    Tables: {
      /** 项目表 */
      projects: {
        Row: ProjectRow;
        Insert: ProjectInsert;
        Update: ProjectUpdate;
      };
      /** 任务表 */
      tasks: {
        Row: TaskRow;
        Insert: TaskInsert;
        Update: TaskUpdate;
      };
      /** 连接表 */
      connections: {
        Row: ConnectionRow;
        Insert: ConnectionInsert;
        Update: ConnectionUpdate;
      };
      /** 用户偏好设置表 */
      user_preferences: {
        Row: UserPreferencesRow;
        Insert: UserPreferencesInsert;
        Update: UserPreferencesUpdate;
      };
      /** 项目成员表 */
      project_members: {
        Row: ProjectMemberRow;
        Insert: ProjectMemberInsert;
        Update: ProjectMemberUpdate;
      };
      /** 清理日志表 */
      cleanup_logs: {
        Row: CleanupLogRow;
        Insert: CleanupLogInsert;
        Update: never; // 日志表不支持更新
      };
    };
    Views: Record<string, never>;
    Functions: {
      cleanup_old_deleted_tasks: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_old_logs: {
        Args: Record<string, never>;
        Returns: number;
      };
    };
  };
}

// ============================================
// 项目表 (projects)
// ============================================

/** 项目行数据（SELECT 返回） */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number;
  /** @deprecated v1 格式，新数据使用 tasks/connections 独立表 */
  data: Json | null;
  /** 是否已迁移到 v2 独立表 */
  migrated_to_v2: boolean;
}

/** 项目插入数据 */
export interface ProjectInsert {
  id?: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

/** 项目更新数据 */
export interface ProjectUpdate {
  title?: string | null;
  description?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

// ============================================
// 任务表 (tasks)
// ============================================

/** 任务状态枚举 */
export type TaskStatusDb = 'active' | 'completed' | 'archived';

/** 任务优先级枚举 */
export type TaskPriorityDb = 'low' | 'medium' | 'high' | 'urgent' | null;

/** 任务行数据（SELECT 返回） */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string | null;
  stage: number | null;
  order: number;
  rank: number;
  status: TaskStatusDb;
  x: number;
  y: number;
  short_id: string | null;
  priority: TaskPriorityDb;
  due_date: string | null;
  tags: Json;
  attachments: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 任务插入数据 */
export interface TaskInsert {
  id?: string;
  project_id: string;
  parent_id?: string | null;
  title: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
}

/** 任务更新数据 */
export interface TaskUpdate {
  parent_id?: string | null;
  title?: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
}

// ============================================
// 连接表 (connections)
// ============================================

/** 连接行数据（SELECT 返回） */
export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** 连接插入数据 */
export interface ConnectionInsert {
  id?: string;
  project_id: string;
  source_id: string;
  target_id: string;
  description?: string | null;
}

/** 连接更新数据 */
export interface ConnectionUpdate {
  description?: string | null;
}

// ============================================
// 用户偏好设置表 (user_preferences)
// ============================================

/** 主题类型（数据库） */
export type ThemeTypeDb = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/** 布局方向（数据库） */
export type LayoutDirectionDb = 'ltr' | 'rtl';

/** 浮动窗口偏好（数据库） */
export type FloatingWindowPrefDb = 'auto' | 'fixed';

/** 用户偏好设置行数据 */
export interface UserPreferencesRow {
  id: string;
  user_id: string;
  theme: string | null;
  layout_direction: string | null;
  floating_window_pref: string | null;
  created_at: string;
  updated_at: string;
}

/** 用户偏好设置插入数据 */
export interface UserPreferencesInsert {
  id?: string;
  user_id: string;
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
}

/** 用户偏好设置更新数据 */
export interface UserPreferencesUpdate {
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
}

// ============================================
// 项目成员表 (project_members)
// ============================================

/** 成员角色枚举 */
export type MemberRoleDb = 'viewer' | 'editor' | 'admin';

/** 项目成员行数据 */
export interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRoleDb;
  invited_by: string | null;
  invited_at: string | null;
  accepted_at: string | null;
}

/** 项目成员插入数据 */
export interface ProjectMemberInsert {
  id?: string;
  project_id: string;
  user_id: string;
  role?: MemberRoleDb;
  invited_by?: string | null;
}

/** 项目成员更新数据 */
export interface ProjectMemberUpdate {
  role?: MemberRoleDb;
  accepted_at?: string | null;
}

// ============================================
// 清理日志表 (cleanup_logs)
// ============================================

/** 清理日志行数据 */
export interface CleanupLogRow {
  id: string;
  type: string;
  details: Json;
  created_at: string;
}

/** 清理日志插入数据 */
export interface CleanupLogInsert {
  id?: string;
  type: string;
  details?: Json;
}
