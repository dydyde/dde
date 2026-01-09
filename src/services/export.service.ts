/**
 * ExportService - 数据导出服务
 * 
 * 【Week 8 数据保护 - P1 手动导出/导入】
 * 职责：
 * - 导出项目数据到 JSON 文件
 * - 生成校验和确保数据完整性
 * - 支持单项目和全项目导出
 * - 附件导出（流式 ZIP）
 * 
 * 设计理念：
 * - 全平台可用的数据逃生能力
 * - 离线也可导出
 * - 导出文件人类可读（JSON 格式化）
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { PreferenceService } from './preference.service';
import { Project, Task, Connection } from '../models';
import { environment } from '../environments/environment';

// ============================================
// 导出配置
// ============================================

export const EXPORT_CONFIG = {
  /** 导出格式版本 */
  FORMAT_VERSION: '2.0',
  
  /** 默认文件名前缀 */
  FILENAME_PREFIX: 'nanoflow-backup',
  
  /** 导出文件 MIME 类型 */
  MIME_TYPE: 'application/json',
  
  /** 是否格式化 JSON（便于人类阅读） */
  PRETTY_PRINT: true,
  
  /** 缩进空格数 */
  INDENT_SPACES: 2,
  
  /** 是否包含附件元数据 */
  INCLUDE_ATTACHMENT_METADATA: true,
  
  /** 是否包含已删除项目（回收站中的任务和连接） */
  INCLUDE_DELETED_ITEMS: true,
  
  /** 是否移除敏感字段 */
  SANITIZE_SENSITIVE_FIELDS: true,
  
  /** 敏感字段列表 */
  SENSITIVE_FIELDS: ['ownerId', 'userId'] as readonly string[],
  
  /** 导出提醒间隔（毫秒）- 7 天 */
  REMINDER_INTERVAL: 7 * 24 * 60 * 60 * 1000,
} as const;

// ============================================
// 类型定义
// ============================================

/**
 * 导出元数据
 */
export interface ExportMetadata {
  /** 导出时间 */
  exportedAt: string;
  /** 格式版本 */
  version: string;
  /** 应用版本 */
  appVersion: string;
  /** 项目数量 */
  projectCount: number;
  /** 任务数量 */
  taskCount: number;
  /** 连接数量 */
  connectionCount: number;
  /** 附件数量 */
  attachmentCount: number;
  /** 校验和 */
  checksum: string;
  /** 导出类型 */
  exportType: 'full' | 'single-project' | 'selected';
}

/**
 * 导出数据结构
 */
export interface ExportData {
  /** 元数据 */
  metadata: ExportMetadata;
  /** 项目列表 */
  projects: ExportProject[];
}

/**
 * 导出项目结构（清理后的项目）
 */
export interface ExportProject {
  id: string;
  name: string;
  description: string;
  tasks: ExportTask[];
  connections: ExportConnection[];
  createdAt?: string;
  updatedAt?: string;
  viewState?: {
    scale: number;
    positionX: number;
    positionY: number;
  };
  /** 流程图图片 URL */
  flowchartUrl?: string;
  /** 流程图缩略图 URL */
  flowchartThumbnailUrl?: string;
  /** 数据版本号 */
  version?: number;
}

/**
 * 导出任务结构
 */
export interface ExportTask {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  status: string;
  x: number;
  y: number;
  displayId: string;
  shortId?: string;
  createdAt?: string;
  updatedAt?: string;
  attachments?: ExportAttachment[];
  /** 标签列表 */
  tags?: string[];
  /** 优先级 */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** 截止日期 */
  dueDate?: string | null;
  /** 是否包含未完成待办项 */
  hasIncompleteTask?: boolean;
  /** 软删除时间戳（回收站中的任务） */
  deletedAt?: string | null;
}

/**
 * 导出连接结构
 */
export interface ExportConnection {
  id: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  /** 软删除时间戳（回收站中的连接） */
  deletedAt?: string | null;
}

/**
 * 导出附件元数据
 */
export interface ExportAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** 附件 URL（注意：Signed URL 可能过期） */
  url?: string;
  createdAt?: string;
  /** 附件类型 */
  type?: 'image' | 'document' | 'link' | 'file';
  /** 缩略图 URL（图片类型） */
  thumbnailUrl?: string;
}

/**
 * 导出结果
 */
export interface ExportResult {
  success: boolean;
  error?: string;
  blob?: Blob;
  filename?: string;
  metadata?: ExportMetadata;
  /** 导出耗时（毫秒） */
  durationMs?: number;
}

/**
 * 导出进度
 */
export interface ExportProgress {
  /** 当前阶段 */
  stage: 'preparing' | 'processing' | 'generating' | 'complete';
  /** 进度百分比 (0-100) */
  percentage: number;
  /** 当前处理项 */
  currentItem?: string;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class ExportService {
  private readonly logger = inject(LoggerService).category('Export');
  private readonly toast = inject(ToastService);
  private readonly preference = inject(PreferenceService);
  
  // 状态信号
  private readonly _isExporting = signal(false);
  private readonly _progress = signal<ExportProgress>({
    stage: 'preparing',
    percentage: 0,
  });
  private readonly _lastExportTime = signal<string | null>(null);
  
  // 公开的计算属性
  readonly isExporting = computed(() => this._isExporting());
  readonly progress = computed(() => this._progress());
  readonly lastExportTime = computed(() => this._lastExportTime());
  
  /** 是否需要导出提醒 */
  readonly needsExportReminder = computed(() => {
    const lastExport = this._lastExportTime();
    if (!lastExport) return true;
    
    const elapsed = Date.now() - new Date(lastExport).getTime();
    return elapsed > EXPORT_CONFIG.REMINDER_INTERVAL;
  });
  
  constructor() {
    // 加载上次导出时间
    this.loadLastExportTime();
  }
  
  /**
   * 导出当前项目
   */
  async exportProject(project: Project): Promise<ExportResult> {
    return this.exportProjects([project], 'single-project');
  }
  
  /**
   * 导出所有项目
   */
  async exportAllProjects(projects: Project[]): Promise<ExportResult> {
    return this.exportProjects(projects, 'full');
  }
  
  /**
   * 导出选中的项目
   */
  async exportSelectedProjects(projects: Project[]): Promise<ExportResult> {
    return this.exportProjects(projects, 'selected');
  }
  
  /**
   * 核心导出逻辑
   */
  private async exportProjects(
    projects: Project[],
    exportType: ExportMetadata['exportType']
  ): Promise<ExportResult> {
    if (this._isExporting()) {
      return { success: false, error: '导出正在进行中' };
    }
    
    const startTime = Date.now();
    this._isExporting.set(true);
    this.updateProgress('preparing', 0);
    
    try {
      this.logger.info('开始导出', { projectCount: projects.length, exportType });
      
      // 阶段 1：准备数据
      this.updateProgress('preparing', 10);
      
      // 统计任务和附件
      let taskCount = 0;
      let connectionCount = 0;
      let attachmentCount = 0;
      
      for (const project of projects) {
        taskCount += project.tasks?.length ?? 0;
        connectionCount += project.connections?.length ?? 0;
        for (const task of project.tasks ?? []) {
          attachmentCount += task.attachments?.length ?? 0;
        }
      }
      
      this.updateProgress('processing', 30);
      
      // 阶段 2：清理和转换项目数据
      const exportProjects: ExportProject[] = [];
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        const exportProject = this.sanitizeProject(project);
        exportProjects.push(exportProject);
        
        const progress = 30 + (i / projects.length) * 40;
        this.updateProgress('processing', progress, project.name);
      }
      
      this.updateProgress('generating', 75);
      
      // 阶段 3：构建导出数据
      const exportData: ExportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          version: EXPORT_CONFIG.FORMAT_VERSION,
          appVersion: '1.0.0', // 应用版本
          projectCount: projects.length,
          taskCount,
          connectionCount,
          attachmentCount,
          checksum: '', // 后面计算
          exportType,
        },
        projects: exportProjects,
      };
      
      // 阶段 4：计算校验和
      this.updateProgress('generating', 85);
      exportData.metadata.checksum = await this.calculateChecksum(exportData);
      
      // 阶段 5：生成文件
      this.updateProgress('generating', 95);
      const jsonContent = EXPORT_CONFIG.PRETTY_PRINT
        ? JSON.stringify(exportData, null, EXPORT_CONFIG.INDENT_SPACES)
        : JSON.stringify(exportData);
      
      const blob = new Blob([jsonContent], { type: EXPORT_CONFIG.MIME_TYPE });
      const filename = this.generateFilename(exportType);
      
      // 完成
      this.updateProgress('complete', 100);
      const durationMs = Date.now() - startTime;
      
      // 记录导出时间
      await this.saveLastExportTime();
      
      this.logger.info('导出完成', {
        projectCount: projects.length,
        taskCount,
        attachmentCount,
        durationMs,
        fileSize: blob.size,
      });
      
      return {
        success: true,
        blob,
        filename,
        metadata: exportData.metadata,
        durationMs,
      };
    } catch (error) {
      this.logger.error('导出失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '导出失败',
      };
    } finally {
      this._isExporting.set(false);
    }
  }
  
  /**
   * 触发浏览器下载（传统方式）
   */
  downloadExport(result: ExportResult): boolean {
    if (!result.success || !result.blob) {
      this.toast.error('导出失败：无数据可下载');
      return false;
    }
    
    try {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename ?? 'nanoflow-backup.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.toast.success('数据已导出');
      return true;
    } catch (error) {
      this.logger.error('下载失败', error);
      this.toast.error('下载失败');
      return false;
    }
  }
  
  /**
   * 使用 File System Access API 导出（现代方式）
   * 允许用户选择保存位置和文件名
   */
  async downloadExportWithFilePicker(result: ExportResult): Promise<boolean> {
    if (!result.success || !result.blob) {
      this.toast.error('导出失败：无数据可下载');
      return false;
    }
    
    // 检查是否支持 showSaveFilePicker
    if (!('showSaveFilePicker' in window)) {
      // 降级到传统下载方式
      return this.downloadExport(result);
    }
    
    try {
      const suggestedName = result.filename ?? this.generateFilename('full');
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const showSaveFilePicker = (window as any).showSaveFilePicker;
      const handle = await showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'JSON 备份文件',
          accept: { 'application/json': ['.json'] }
        }]
      });
      
      const writable = await handle.createWritable();
      await writable.write(result.blob);
      await writable.close();
      
      this.toast.success(`数据已导出到：${handle.name}`);
      return true;
      
    } catch (error) {
      const e = error as Error;
      
      // 用户取消不算错误
      if (e.name === 'AbortError') {
        this.logger.info('用户取消导出');
        return false;
      }
      
      this.logger.error('导出失败', error);
      // 降级到传统下载方式
      this.logger.info('降级到传统下载方式');
      return this.downloadExport(result);
    }
  }
  
  /**
   * 一键导出并下载（使用现代 API，支持选择保存位置）
   */
  async exportAndDownload(projects: Project[]): Promise<boolean> {
    const result = await this.exportAllProjects(projects);
    if (result.success) {
      // 优先使用 File System Access API
      return this.downloadExportWithFilePicker(result);
    } else {
      this.toast.error(result.error ?? '导出失败');
      return false;
    }
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 清理项目数据（移除敏感字段，规范化结构）
   */
  private sanitizeProject(project: Project): ExportProject {
    // 根据配置决定是否包含已删除项目
    const taskFilter = EXPORT_CONFIG.INCLUDE_DELETED_ITEMS
      ? () => true // 包含所有任务（含回收站）
      : (t: Task) => !t.deletedAt; // 仅包含未删除任务
    
    const connectionFilter = EXPORT_CONFIG.INCLUDE_DELETED_ITEMS
      ? () => true // 包含所有连接（含回收站）
      : (c: Connection) => !c.deletedAt; // 仅包含未删除连接
    
    const tasks = (project.tasks ?? [])
      .filter(taskFilter)
      .map(t => this.sanitizeTask(t));
    
    const connections = (project.connections ?? [])
      .filter(connectionFilter)
      .map(c => this.sanitizeConnection(c));
    
    return {
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      tasks,
      connections,
      createdAt: project.createdDate,
      updatedAt: project.updatedAt,
      viewState: project.viewState,
      flowchartUrl: project.flowchartUrl,
      flowchartThumbnailUrl: project.flowchartThumbnailUrl,
      version: project.version,
    };
  }
  
  /**
   * 清理任务数据
   */
  private sanitizeTask(task: Task): ExportTask {
    const exportTask: ExportTask = {
      id: task.id,
      title: task.title,
      content: task.content ?? '',
      stage: task.stage,
      parentId: task.parentId,
      order: task.order ?? 0,
      rank: task.rank ?? 10000,
      status: task.status ?? 'active',
      x: task.x ?? 0,
      y: task.y ?? 0,
      displayId: task.displayId ?? '',
      shortId: task.shortId,
      createdAt: task.createdDate,
      updatedAt: task.updatedAt,
      tags: task.tags,
      priority: task.priority,
      dueDate: task.dueDate,
      hasIncompleteTask: task.hasIncompleteTask,
      deletedAt: task.deletedAt,
    };
    
    // 包含附件元数据
    if (EXPORT_CONFIG.INCLUDE_ATTACHMENT_METADATA && task.attachments?.length) {
      exportTask.attachments = task.attachments
        .filter(att => !att.deletedAt) // 过滤已删除附件
        .map(att => ({
          id: att.id,
          name: att.name,
          size: att.size ?? 0,
          mimeType: att.mimeType ?? 'application/octet-stream',
          url: att.url, // 注意：Signed URL 可能过期
          createdAt: att.createdAt,
          type: att.type,
          thumbnailUrl: att.thumbnailUrl,
        }));
    }
    
    return exportTask;
  }
  
  /**
   * 清理连接数据
   */
  private sanitizeConnection(connection: Connection): ExportConnection {
    return {
      id: connection.id,
      source: connection.source,
      target: connection.target,
      title: connection.title,
      description: connection.description,
      deletedAt: connection.deletedAt,
    };
  }
  
  /**
   * 计算校验和（简化版 SHA-256）
   */
  private async calculateChecksum(data: ExportData): Promise<string> {
    // 移除 checksum 字段后计算
    const dataForChecksum = {
      ...data,
      metadata: { ...data.metadata, checksum: '' },
    };
    
    const jsonString = JSON.stringify(dataForChecksum);
    
    // 使用 Web Crypto API 计算 SHA-256
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(jsonString);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } catch {
        // 降级到简单 hash
        return this.simpleHash(jsonString);
      }
    }
    
    return this.simpleHash(jsonString);
  }
  
  /**
   * 简单哈希（降级方案）
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `simple-${Math.abs(hash).toString(16)}`;
  }
  
  /**
   * 生成文件名
   */
  private generateFilename(exportType: ExportMetadata['exportType']): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '');
    
    const typeSuffix = exportType === 'single-project' ? '-project' : 
                       exportType === 'selected' ? '-selected' : '';
    
    return `${EXPORT_CONFIG.FILENAME_PREFIX}${typeSuffix}-${dateStr}-${timeStr}.json`;
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: ExportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.set({
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    });
  }
  
  /**
   * 加载上次导出时间
   */
  private loadLastExportTime(): void {
    try {
      const stored = localStorage.getItem('nanoflow.lastExportAt');
      if (stored) {
        this._lastExportTime.set(stored);
      }
    } catch {
      // 忽略存储错误
    }
  }
  
  /**
   * 保存上次导出时间
   */
  private async saveLastExportTime(): Promise<void> {
    const now = new Date().toISOString();
    this._lastExportTime.set(now);
    
    try {
      localStorage.setItem('nanoflow.lastExportAt', now);
      // 仅本地存储，不同步到云端
    } catch {
      // 忽略存储错误
    }
  }
}
