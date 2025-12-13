import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Task, Connection, Project } from '../models';
import { sanitizeTask, sanitizeAttachment } from '../utils/validation';

/**
 * 数据库行类型定义
 */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  stage: number | null;
  order: number;
  rank: number;
  status: 'active' | 'completed' | 'archived';
  x: number;
  y: number;
  short_id: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  due_date: string | null;
  tags: string[];
  attachments: any[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number;
  migrated_to_v2: boolean;
}

/**
 * 任务仓库服务
 * 负责与 Supabase 的任务级 CRUD 操作
 * 使用独立的 tasks 和 connections 表
 */
@Injectable({
  providedIn: 'root'
})
export class TaskRepositoryService {
  private supabase = inject(SupabaseClientService);

  /**
   * 加载项目的所有任务
   * 排除：
   * 1. 已被永久删除（在 task_tombstones 中）的任务
   * 2. 软删除（deleted_at 不为 null）的任务
   * 
   * 注意：软删除的任务理论上应该只存在于本地回收站，
   * 如果服务器上有软删除的任务，说明可能存在同步问题或旧数据。
   * 为了防止已删除任务在其他设备上"复活"，我们在加载时就过滤它们。
   */
  async loadTasks(projectId: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    // 1. 加载所有任务
    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to load tasks:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      return [];
    }

    // 预先将所有行映射为 Task（包含将被过滤掉的软删/ tombstone 任务），
    // 以便在父任务被删除时，让子任务能够“顶替”父任务的位置属性（stage/order/rank/x/y）。
    const allTasks = data.map(row => this.mapRowToTask(row as TaskRow));
    const taskById = new Map(allTasks.map(t => [t.id, t] as const));

    // 2. 获取该项目的所有 tombstone 记录
    const { data: tombstones, error: tombstoneError } = await this.supabase.client()
      .from('task_tombstones')
      .select('task_id')
      .eq('project_id', projectId);

    // 3. 过滤掉已 tombstone 或软删除的任务
    // tombstone 查询失败时降级：只依赖 deleted_at 过滤
    const tombstoneIds = tombstoneError
      ? new Set<string>()
      : new Set((tombstones || []).map(t => t.task_id));

    if (tombstoneError) {
      console.warn('Failed to load tombstones (continuing without tombstone filtering):', tombstoneError);
    }

    const removedIds = new Set<string>();
    for (const t of allTasks) {
      if (tombstoneIds.has(t.id) || t.deletedAt) {
        removedIds.add(t.id);
      }
    }

    // 4. 子任务“顶替”父任务：
    // 若 task.parentId 指向已删除任务（软删/ tombstone），则把该任务提升到父任务的位置，
    // 并把 parentId 指向祖父（支持多层级联）。
    const promote = (task: Task): Task => {
      let promoted: Task = { ...task };
      let parentId = promoted.parentId;
      let guard = 0;
      while (parentId && removedIds.has(parentId) && guard < 50) {
        const removedParent = taskById.get(parentId);
        if (!removedParent) {
          // 父任务行已不存在（可能已被物理 purge），无法继承其位置信息，只能断开父子关系
          parentId = null;
          break;
        }

        promoted = {
          ...promoted,
          stage: removedParent.stage,
          order: removedParent.order,
          rank: removedParent.rank,
          x: removedParent.x,
          y: removedParent.y,
        };

        parentId = removedParent.parentId;
        guard++;
      }

      if (guard > 0) {
        promoted = { ...promoted, parentId: parentId ?? null };
      }

      if (promoted.parentId === promoted.id) {
        promoted = { ...promoted, parentId: null };
      }
      return promoted;
    };

    const keptTasks = allTasks
      .filter(t => !removedIds.has(t.id) && !t.deletedAt)
      .map(promote);

    const tombstoneCount = tombstoneIds.size;
    const softDeleteCount = allTasks.filter(t => t.deletedAt && !tombstoneIds.has(t.id)).length;
    if (tombstoneCount > 0 || softDeleteCount > 0) {
      console.log(`Filtered out ${tombstoneCount} tombstoned and ${softDeleteCount} soft-deleted tasks for project ${projectId}`);
    }

    return keptTasks;
  }

  /**
   * 加载项目的所有连接
   */
  async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('connections')
      .select('*')
      .eq('project_id', projectId);

    if (error) {
      console.error('Failed to load connections:', error);
      throw error;
    }

    return (data || []).map(row => this.mapRowToConnection(row as ConnectionRow));
  }

  /**
   * 保存单个任务（创建或更新）
   */
  async saveTask(projectId: string, task: Task): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const taskRow = this.mapTaskToRow(projectId, task) as any;
    // tombstone-wins：不允许通过“缺省同步”清空 deleted_at。
    // 恢复任务应走显式 restore（增量变更会携带 changedFields=deletedAt）。
    if ((task.deletedAt ?? null) === null) {
      delete taskRow.deleted_at;
    }

    const { error } = await this.supabase.client()
      .from('tasks')
      .upsert(taskRow, { onConflict: 'id' });

    if (error) {
      console.error('Failed to save task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 批量保存任务
   * 注意：Supabase upsert 是原子操作，但如果部分失败无法自动回滚
   * 调用方应该处理失败情况并决定是否需要重试
   */
  async saveTasks(projectId: string, tasks: Task[]): Promise<{ success: boolean; error?: string; failedCount?: number }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (tasks.length === 0) return { success: true };

    const taskRows = tasks.map(task => {
      const row = this.mapTaskToRow(projectId, task) as any;
      if ((task.deletedAt ?? null) === null) {
        delete row.deleted_at;
      }
      return row;
    });

    // 对于大批量任务，分批处理以避免超时和单次失败影响所有数据
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;
    let failedCount = 0;
    let lastError: string | undefined;
    const failedBatches: { index: number; tasks: typeof taskRows }[] = [];

    for (let i = 0; i < taskRows.length; i += BATCH_SIZE) {
      const batch = taskRows.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      let success = false;
      
      while (!success && retryCount <= MAX_RETRIES) {
        const { error } = await this.supabase.client()
          .from('tasks')
          .upsert(batch, { onConflict: 'id' });

        if (error) {
          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            // 指数退避重试
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount)));
            console.warn(`任务批次 ${i}-${i + batch.length} 保存失败，重试 ${retryCount}/${MAX_RETRIES}:`, error.message);
          } else {
            console.error(`任务批次 ${i}-${i + batch.length} 保存失败，已达最大重试次数:`, error);
            failedCount += batch.length;
            lastError = error.message;
            failedBatches.push({ index: i, tasks: batch });
          }
        } else {
          success = true;
        }
      }
    }

    if (failedCount > 0) {
      // 记录详细失败信息以便调试
      console.error(`[TaskRepo] 批量保存任务失败统计:`, {
        total: tasks.length,
        failed: failedCount,
        failedBatchCount: failedBatches.length,
        lastError
      });
      
      return { 
        success: false, 
        error: `${failedCount} 个任务保存失败: ${lastError}`,
        failedCount 
      };
    }

    return { success: true };
  }

  /**
   * 删除任务（永久删除 / purge）
   *
   * 设计说明：
   * - 物理 DELETE 会导致旧端/离线端的 upsert 将任务“重新插回”（复活）。
   * - 因此这里优先调用服务端 purge RPC（会写入 tombstone 并删除行），从根源阻断复活。
   * - 若后端尚未部署该 RPC，则降级为软删除（deleted_at=now），保证跨端至少不会立刻复活。
   */
  async deleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 1) 优先走 purge RPC（后端会记录 tombstone）
    const purgeResult = await this.supabase.client().rpc('purge_tasks', {
      p_task_ids: [taskId]
    });

    if (!purgeResult.error) {
      return { success: true };
    }

    // 2) 降级：软删除
    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      console.error('Failed to delete task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 软删除任务
   */
  async softDeleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      console.error('Failed to soft delete task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 恢复任务
   */
  async restoreTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: null })
      .eq('id', taskId);

    if (error) {
      console.error('Failed to restore task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 更新任务的单个字段（细粒度更新）
   */
  async updateTaskField(
    taskId: string, 
    field: keyof TaskRow, 
    value: any
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ [field]: value })
      .eq('id', taskId);

    if (error) {
      console.error(`Failed to update task ${field}:`, error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 批量更新任务的多个字段（细粒度更新）
   */
  async updateTaskFields(
    taskId: string, 
    updates: Partial<TaskRow>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update(updates)
      .eq('id', taskId);

    if (error) {
      console.error('Failed to update task fields:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 添加附件到任务（原子操作）
   */
  async addAttachment(
    taskId: string, 
    attachment: any
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 使用 Postgres 的 jsonb 数组追加操作
    const { error } = await this.supabase.client()
      .rpc('append_task_attachment', {
        p_task_id: taskId,
        p_attachment: attachment
      });

    if (error) {
      // 如果 RPC 不存在，回退到读取-修改-写入模式
      console.warn('RPC not available, falling back to read-modify-write:', error);
      return this.addAttachmentFallback(taskId, attachment);
    }

    return { success: true };
  }

  /**
   * 添加附件的回退实现（读取-修改-写入）
   */
  private async addAttachmentFallback(
    taskId: string, 
    attachment: any
  ): Promise<{ success: boolean; error?: string }> {
    const { data, error: fetchError } = await this.supabase.client()
      .from('tasks')
      .select('attachments')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }
    
    if (!data) {
      return { success: false, error: '任务不存在' };
    }

    const currentAttachments = data?.attachments || [];
    const newAttachments = [...currentAttachments, attachment];

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ attachments: newAttachments })
      .eq('id', taskId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 从任务移除附件（原子操作）
   */
  async removeAttachment(
    taskId: string, 
    attachmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 尝试使用 RPC
    const { error } = await this.supabase.client()
      .rpc('remove_task_attachment', {
        p_task_id: taskId,
        p_attachment_id: attachmentId
      });

    if (error) {
      // 回退到读取-修改-写入模式
      console.warn('RPC not available, falling back to read-modify-write:', error);
      return this.removeAttachmentFallback(taskId, attachmentId);
    }

    return { success: true };
  }

  /**
   * 移除附件的回退实现
   */
  private async removeAttachmentFallback(
    taskId: string, 
    attachmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    const { data, error: fetchError } = await this.supabase.client()
      .from('tasks')
      .select('attachments')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }
    
    if (!data) {
      return { success: false, error: '任务不存在' };
    }

    const currentAttachments = data?.attachments || [];
    const newAttachments = currentAttachments.filter(
      (a: any) => a.id !== attachmentId
    );

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ attachments: newAttachments })
      .eq('id', taskId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 保存连接
   */
  async saveConnection(projectId: string, connection: Connection): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('connections')
      .upsert({
        project_id: projectId,
        source_id: connection.source,
        target_id: connection.target,
        description: connection.description
      }, { onConflict: 'project_id,source_id,target_id' });

    if (error) {
      console.error('Failed to save connection:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 删除连接
   */
  async deleteConnection(projectId: string, sourceId: string, targetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('connections')
      .delete()
      .eq('project_id', projectId)
      .eq('source_id', sourceId)
      .eq('target_id', targetId);

    if (error) {
      console.error('Failed to delete connection:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 批量同步连接（差异对比，只更新变化的部分）
   * 优化版本：避免全删全插，减少网络请求和数据丢失风险
   * 增加重试逻辑和部分失败恢复
   */
  async syncConnections(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const MAX_RETRIES = 2;
    const errors: string[] = [];

    try {
      // 1. 加载当前数据库中的连接
      let existingConnections: Connection[] = [];
      try {
        existingConnections = await this.loadConnections(projectId);
      } catch (loadError: any) {
        console.warn('加载现有连接失败，尝试全量插入:', loadError.message);
        // 如果加载失败，回退到全量 upsert
        return this.syncConnectionsFallback(projectId, connections);
      }
      
      // 2. 构建对比集合（使用 source-target 作为唯一标识）
      const existingSet = new Set(existingConnections.map((c: Connection) => `${c.source}|${c.target}`));
      const newSet = new Set(connections.map((c: Connection) => `${c.source}|${c.target}`));
      
      // 3. 找出需要删除的连接（在数据库中存在但本地不存在）
      const toDelete = existingConnections.filter((c: Connection) => !newSet.has(`${c.source}|${c.target}`));
      
      // 4. 找出需要新增的连接（在本地存在但数据库中不存在）
      const toInsert = connections.filter((c: Connection) => !existingSet.has(`${c.source}|${c.target}`));
      
      // 5. 找出需要更新的连接（两边都存在但描述可能变化）
      const toUpdate = connections.filter((c: Connection) => {
        const key = `${c.source}|${c.target}`;
        if (!existingSet.has(key)) return false;
        const existing = existingConnections.find((e: Connection) => e.source === c.source && e.target === c.target);
        return existing && existing.description !== c.description;
      });

      // 6. 批量删除操作（提升性能）
      if (toDelete.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
          const batch = toDelete.slice(i, i + BATCH_SIZE);
          let success = false;
          
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            // 使用 IN 查询批量删除
            const deleteKeys = batch.map(c => `(${c.source},${c.target})`);
            const { error } = await this.supabase.client()
              .from('connections')
              .delete()
              .eq('project_id', projectId)
              .in('source_id', batch.map(c => c.source))
              .in('target_id', batch.map(c => c.target));
            
            if (error) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`批量删除连接失败（${i}-${i + batch.length}）: ${error.message}`);
              }
            } else {
              success = true;
            }
          }
        }
      }

      // 7. 批量插入操作（提升性能）
      if (toInsert.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
          const batch = toInsert.slice(i, i + BATCH_SIZE);
          const connectionRows = batch.map((conn: Connection) => ({
            project_id: projectId,
            source_id: conn.source,
            target_id: conn.target,
            description: conn.description
          }));

          let success = false;
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            const { error: insertError } = await this.supabase.client()
              .from('connections')
              .insert(connectionRows);

            if (insertError) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`批量插入连接失败（${i}-${i + batch.length}）: ${insertError.message}`);
              }
            } else {
              success = true;
            }
          }
        }
      }
      
      // 8. 执行更新操作（带重试）
      for (const conn of toUpdate) {
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .update({ description: conn.description })
            .eq('project_id', projectId)
            .eq('source_id', conn.source)
            .eq('target_id', conn.target);
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`更新连接失败 ${conn.source}->${conn.target}: ${error.message}`);
            }
          } else {
            success = true;
          }
        }
      }
      
      if (errors.length > 0) {
        console.warn('连接同步部分失败:', errors);
        // 部分成功也返回 success，只记录警告
      }
      
      // console.log(`连接同步完成: 删除 ${toDelete.length}, 新增 ${toInsert.length}, 更新 ${toUpdate.length}, 错误 ${errors.length}`);
      return { success: true };
    } catch (error: any) {
      console.error('Connection sync failed:', error);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * 连接同步的回退方法：全量 upsert
   */
  private async syncConnectionsFallback(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (connections.length === 0) return { success: true };
    
    const connectionRows = connections.map(conn => ({
      project_id: projectId,
      source_id: conn.source,
      target_id: conn.target,
      description: conn.description
    }));
    
    const { error } = await this.supabase.client()
      .from('connections')
      .upsert(connectionRows, { onConflict: 'project_id,source_id,target_id' });
    
    if (error) {
      console.error('Connection fallback sync failed:', error);
      return { success: false, error: error.message };
    }
    
    return { success: true };
  }

  /**
   * 加载完整项目（包括任务和连接）
   */
  async loadFullProject(projectId: string): Promise<{ project: ProjectRow; tasks: Task[]; connections: Connection[] } | null> {
    if (!this.supabase.isConfigured) return null;

    const [projectResult, tasksResult, connectionsResult] = await Promise.all([
      this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle(),
      this.loadTasks(projectId),
      this.loadConnections(projectId)
    ]);

    if (projectResult.error) {
      throw projectResult.error;
    }
    
    if (!projectResult.data) {
      return null; // Project not found
    }

    return {
      project: projectResult.data as ProjectRow,
      tasks: tasksResult,
      connections: connectionsResult
    };
  }

  /**
   * 检查任务是否有更新（通过 updated_at 比较）
   */
  async hasTaskUpdates(projectId: string, since: string): Promise<boolean> {
    if (!this.supabase.isConfigured) return false;

    const { count, error } = await this.supabase.client()
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .gt('updated_at', since);

    if (error) {
      console.error('Failed to check task updates:', error);
      return false;
    }

    return (count ?? 0) > 0;
  }

  /**
   * 获取自某个时间点以来更新的任务
   */
  async getUpdatedTasks(projectId: string, since: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .gt('updated_at', since);

    if (error) {
      console.error('Failed to get updated tasks:', error);
      throw error;
    }

    return (data || []).map(row => this.mapRowToTask(row as TaskRow));
  }

  // ========== 映射函数 ==========

  private mapRowToTask(row: TaskRow): Task {
    // 使用 sanitizeTask 进行数据清洗，确保从数据库读取的数据符合预期格式
    // 这是数据入口的第一道防线，防止脏数据进入模板层
    return sanitizeTask({
      id: row.id,
      title: row.title ?? '',
      content: row.content ?? '',
      stage: row.stage,
      parentId: row.parent_id,
      order: row.order ?? 0,
      rank: row.rank ?? 10000,
      status: row.status ?? 'active',
      x: row.x ?? 0,
      y: row.y ?? 0,
      createdDate: row.created_at ?? new Date().toISOString(),
      updatedAt: row.updated_at ?? undefined,
      displayId: '?', // 由前端计算
      shortId: row.short_id ?? undefined,
      hasIncompleteTask: false, // 由前端计算
      deletedAt: row.deleted_at,
      attachments: row.attachments ?? [],
      tags: row.tags ?? [],
      priority: row.priority ?? undefined,
      dueDate: row.due_date
    });
  }

  private mapTaskToRow(projectId: string, task: Task): Partial<TaskRow> {
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
      // 注意：不需要手动设置 updated_at，数据库触发器会自动更新
    };
  }

  private mapRowToConnection(row: ConnectionRow): Connection {
    return {
      id: row.id,
      source: row.source_id,
      target: row.target_id,
      description: row.description ?? undefined
    };
  }

  // ========== 增量同步方法 ==========

  /**
   * 增量保存任务（只保存变化的部分）
   * 相比全量 saveTasks，此方法只处理指定的变更集
   */
  async saveTasksIncremental(
    projectId: string,
    tasksToCreate: Task[],
    tasksToUpdate: Task[],
    taskIdsToDelete: string[],
    taskUpdateFieldsById?: Record<string, string[] | undefined>
  ): Promise<{ success: boolean; error?: string; stats?: { created: number; updated: number; deleted: number } }> {
    if (!this.supabase.isConfigured) return { success: true };
    
    const stats = { created: 0, updated: 0, deleted: 0 };
    const errors: string[] = [];
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;

    // 1. 批量删除任务
    if (taskIdsToDelete.length > 0) {
      for (let i = 0; i < taskIdsToDelete.length; i += BATCH_SIZE) {
        const batch = taskIdsToDelete.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          // 优先走 purge RPC（写入 tombstone + 删除行），阻断旧端 upsert 复活。
          // v2 支持在 tasks 行已不存在时也能落 tombstone（需要 projectId）。
          const purgeV2Result = await this.supabase.client().rpc('purge_tasks_v2', {
            p_project_id: projectId,
            p_task_ids: batch
          });

          const purgeResult = purgeV2Result.error
            ? await this.supabase.client().rpc('purge_tasks', { p_task_ids: batch })
            : purgeV2Result;

          // 后端未部署/权限不足时降级为软删除（不再使用物理 DELETE）。
          const error = purgeResult.error
            ? (await this.supabase.client()
                .from('tasks')
                .update({ deleted_at: new Date().toISOString() })
                .eq('project_id', projectId)
                .in('id', batch)).error
            : null;
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量删除任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.deleted += batch.length;
          }
        }
      }
    }

    // 2. 批量创建任务（使用 insert 而非 upsert，更明确语义）
    if (tasksToCreate.length > 0) {
      const createRows = tasksToCreate.map(task => this.mapTaskToRow(projectId, task));
      
      for (let i = 0; i < createRows.length; i += BATCH_SIZE) {
        const batch = createRows.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          // 使用 upsert 以处理重复创建的边缘情况
          const { error } = await this.supabase.client()
            .from('tasks')
            .upsert(batch, { onConflict: 'id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量创建任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.created += batch.length;
          }
        }
      }
    }

    // 3. 批量更新任务
    if (tasksToUpdate.length > 0) {
      const updateRows = tasksToUpdate.map(task => {
        const row = this.mapTaskToRow(projectId, task) as any;
        const changedFields = taskUpdateFieldsById?.[task.id] ?? [];

        // tombstone-wins：
        // - 如果本次更新没有显式修改 deletedAt（changedFields 不包含 deletedAt）
        // - 且当前 task.deletedAt 为 null
        // 则不发送 deleted_at 字段，避免把远端已存在的 deleted_at 覆盖回 null（导致复活）。
        if ((task.deletedAt ?? null) === null && !changedFields.includes('deletedAt')) {
          delete row.deleted_at;
        }

        return row;
      });
      
      for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
        const batch = updateRows.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('tasks')
            .upsert(batch, { onConflict: 'id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量更新任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.updated += batch.length;
          }
        }
      }
    }

    if (errors.length > 0) {
      console.error('[TaskRepo] 增量保存任务部分失败:', errors);
      return { 
        success: false, 
        error: errors.join('; '),
        stats
      };
    }

    // console.log('[TaskRepo] 增量保存任务完成', stats);
    return { success: true, stats };
  }

  /**
   * 增量同步连接（只处理变化的部分）
   */
  async syncConnectionsIncremental(
    projectId: string,
    connectionsToCreate: Connection[],
    connectionsToUpdate: Connection[],
    connectionsToDelete: { source: string; target: string }[]
  ): Promise<{ success: boolean; error?: string; stats?: { created: number; updated: number; deleted: number } }> {
    if (!this.supabase.isConfigured) return { success: true };
    
    const stats = { created: 0, updated: 0, deleted: 0 };
    const errors: string[] = [];
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;

    // 1. 批量删除连接
    if (connectionsToDelete.length > 0) {
      for (let i = 0; i < connectionsToDelete.length; i += BATCH_SIZE) {
        const batch = connectionsToDelete.slice(i, i + BATCH_SIZE);
        
        for (const conn of batch) {
          let success = false;
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            const { error } = await this.supabase.client()
              .from('connections')
              .delete()
              .eq('project_id', projectId)
              .eq('source_id', conn.source)
              .eq('target_id', conn.target);
            
            if (error) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`删除连接失败 ${conn.source}->${conn.target}: ${error.message}`);
              }
            } else {
              success = true;
              stats.deleted++;
            }
          }
        }
      }
    }

    // 2. 批量创建连接
    if (connectionsToCreate.length > 0) {
      for (let i = 0; i < connectionsToCreate.length; i += BATCH_SIZE) {
        const batch = connectionsToCreate.slice(i, i + BATCH_SIZE);
        const rows = batch.map(conn => ({
          project_id: projectId,
          source_id: conn.source,
          target_id: conn.target,
          description: conn.description
        }));
        
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .upsert(rows, { onConflict: 'project_id,source_id,target_id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量创建连接失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.created += batch.length;
          }
        }
      }
    }

    // 3. 批量更新连接
    if (connectionsToUpdate.length > 0) {
      for (let i = 0; i < connectionsToUpdate.length; i += BATCH_SIZE) {
        const batch = connectionsToUpdate.slice(i, i + BATCH_SIZE);
        const rows = batch.map(conn => ({
          project_id: projectId,
          source_id: conn.source,
          target_id: conn.target,
          description: conn.description
        }));
        
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .upsert(rows, { onConflict: 'project_id,source_id,target_id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量更新连接失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.updated += batch.length;
          }
        }
      }
    }

    if (errors.length > 0) {
      console.error('[TaskRepo] 增量同步连接部分失败:', errors);
      return { 
        success: false, 
        error: errors.join('; '),
        stats
      };
    }

    // console.log('[TaskRepo] 增量同步连接完成', stats);
    return { success: true, stats };
  }

  /**
   * 批量删除任务
   */
  async deleteTasks(projectId: string, taskIds: string[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (taskIds.length === 0) return { success: true };

    const BATCH_SIZE = 50;
    const errors: string[] = [];

    for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
      const batch = taskIds.slice(i, i + BATCH_SIZE);

      // 同 deleteTask：优先 purge RPC，降级软删除。
      const purgeV2Result = await this.supabase.client().rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: batch
      });

      const purgeResult = purgeV2Result.error
        ? await this.supabase.client().rpc('purge_tasks', { p_task_ids: batch })
        : purgeV2Result;

      const error = purgeResult.error
        ? (await this.supabase.client()
            .from('tasks')
            .update({ deleted_at: new Date().toISOString() })
            .eq('project_id', projectId)
            .in('id', batch)).error
        : null;
      
      if (error) {
        errors.push(`批量删除任务失败（${i}-${i + batch.length}）: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }

  /**
   * 批量删除连接
   */
  async deleteConnections(
    projectId: string, 
    connections: { source: string; target: string }[]
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (connections.length === 0) return { success: true };

    const errors: string[] = [];

    // 连接没有好的批量删除方式（复合主键），逐个删除
    for (const conn of connections) {
      const { error } = await this.supabase.client()
        .from('connections')
        .delete()
        .eq('project_id', projectId)
        .eq('source_id', conn.source)
        .eq('target_id', conn.target);
      
      if (error) {
        errors.push(`删除连接 ${conn.source}->${conn.target} 失败: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }
}
