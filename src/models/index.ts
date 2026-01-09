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
  
  // ⚠️ 以下字段仅用于客户端状态管理，不会同步到数据库
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
  /** 联系块标题（外显内容，类似维基百科的预览标题） */
  title?: string;
  /** 联系块详细描述（悬停/点击时显示） */
  description?: string;
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
  /** 颜色模式（云端默认值，本地可覆盖） */
  colorMode?: ColorMode;
  layoutDirection: 'ltr' | 'rtl';
  floatingWindowPref: 'auto' | 'fixed';
  /** 
   * 自动解决冲突开关
   * true: 使用 LWW (Last-Write-Wins) 自动解决冲突
   * false: 所有冲突进入仪表盘由用户手动处理
   */
  autoResolveConflicts?: boolean;
  /**
   * 本地自动备份开关
   * 仅同步开关状态，目录路径不同步（不同设备路径不同）
   */
  localBackupEnabled?: boolean;
  /**
   * 本地自动备份间隔（毫秒）
   */
  localBackupIntervalMs?: number;
}

/**
 * 主题类型（色调）
 */
export type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * 颜色模式（明暗）
 * - light: 浅色模式
 * - dark: 深色模式  
 * - system: 跟随系统设置
 */
export type ColorMode = 'light' | 'dark' | 'system';

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
// 同步相关类型定义
// ============================================

/**
 * 同步模式
 * - automatic: 自动模式 - 按间隔自动同步
 * - manual: 手动模式 - 仅在用户手动触发或应用启动/退出时同步
 * - completely-manual: 完全手动模式 - 用户必须明确选择"上传"或"下载"
 */
export type SyncMode = 'automatic' | 'manual' | 'completely-manual';

/**
 * 同步方向
 */
export type SyncDirection = 'upload' | 'download' | 'both';

/**
 * 设备信息
 */
export interface DeviceInfo {
  /** 设备唯一ID */
  deviceId: string;
  /** 设备名称 */
  deviceName: string;
  /** 操作系统 */
  os: string;
  /** 应用版本 */
  version: string;
  /** 最后活跃时间 */
  lastSeen: number;
}

/**
 * 同步状态扩展
 */
export interface ExtendedSyncState extends SyncState {
  /** 同步模式 */
  mode: SyncMode;
  /** 是否启用感知 */
  perceptionEnabled: boolean;
  /** 在线设备数量 */
  onlineDeviceCount: number;
  /** 最后同步时间 */
  lastSyncAt: number | null;
  /** 下次自动同步时间（仅自动模式） */
  nextSyncAt: number | null;
}

/**
 * 冲突原因
 */
export type ConflictReason = 
  | 'version_mismatch'
  | 'concurrent_edit'
  | 'network_recovery'
  | 'status_conflict'
  | 'field_conflict'
  | 'merge_conflict';

/**
 * 解决策略
 */
export type ResolutionStrategy = 
  | 'use_local'
  | 'use_remote'
  | 'merge'
  | 'manual'
  | 'auto_rebase';

// ============================================
// GoJS 边界类型导出
// ============================================
export * from './gojs-boundary';

// ============================================
// 流程图视图状态导出
// ============================================
export * from './flow-view-state';

// ============================================
// API 类型定义（边境防御）
// 注意：api-types.ts 中的类型当前未被使用
// 如需类型守卫功能，可从 './api-types' 直接导入
// ============================================

// ============================================
// Supabase 映射器（仅供 Service 层使用）
// ============================================
// 注意：supabase-mapper.ts 中的映射函数当前未被使用
// simple-sync.service.ts 有自己的私有 mapper 方法
// 如需统一映射逻辑，可从 './supabase-mapper' 直接导入
// supabase-types.ts 不在此导出，应直接 import from './supabase-types'
