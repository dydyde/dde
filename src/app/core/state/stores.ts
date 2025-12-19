/**
 * 状态管理服务
 * 
 * 按照 agents.md 极简架构要求：
 * - 使用 Angular Signals 进行细粒度更新
 * - projects signal: 存储元数据
 * - tasksMap signal: Map<string, Task> 用于 O(1) 查找
 * - 避免深层嵌套对象的 Signal，保持扁平化
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import { Project, Task, Connection } from '../../../models';

/**
 * 任务状态 Store
 * 使用 Map 结构实现 O(1) 查找
 */
@Injectable({
  providedIn: 'root'
})
export class TaskStore {
  /**
   * 任务 Map - O(1) 查找
   * key: taskId
   * value: Task
   */
  readonly tasksMap = signal<Map<string, Task>>(new Map());
  
  /**
   * 任务列表（从 Map 派生）
   */
  readonly tasks = computed(() => Array.from(this.tasksMap().values()));
  
  /**
   * 按项目 ID 索引的任务
   * 快速获取某个项目的所有任务
   */
  private readonly tasksByProject = signal<Map<string, Set<string>>>(new Map());
  
  /**
   * 获取单个任务 - O(1)
   */
  getTask(id: string): Task | undefined {
    return this.tasksMap().get(id);
  }
  
  /**
   * 获取项目的所有任务
   */
  getTasksByProject(projectId: string): Task[] {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return [];
    
    const map = this.tasksMap();
    return Array.from(taskIds)
      .map(id => map.get(id))
      .filter((t): t is Task => !!t);
  }
  
  /**
   * 设置任务（单个）
   */
  setTask(task: Task, projectId: string): void {
    this.tasksMap.update(map => {
      const newMap = new Map(map);
      newMap.set(task.id, task);
      return newMap;
    });
    
    this.tasksByProject.update(map => {
      const newMap = new Map(map);
      if (!newMap.has(projectId)) {
        newMap.set(projectId, new Set());
      }
      newMap.get(projectId)!.add(task.id);
      return newMap;
    });
  }
  
  /**
   * 批量设置任务
   */
  setTasks(tasks: Task[], projectId: string): void {
    this.tasksMap.update(map => {
      const newMap = new Map(map);
      tasks.forEach(task => newMap.set(task.id, task));
      return newMap;
    });
    
    this.tasksByProject.update(map => {
      const newMap = new Map(map);
      const taskIds = new Set(tasks.map(t => t.id));
      newMap.set(projectId, taskIds);
      return newMap;
    });
  }
  
  /**
   * 删除任务 - O(1)
   */
  removeTask(id: string, projectId: string): void {
    this.tasksMap.update(map => {
      const newMap = new Map(map);
      newMap.delete(id);
      return newMap;
    });
    
    this.tasksByProject.update(map => {
      const newMap = new Map(map);
      newMap.get(projectId)?.delete(id);
      return newMap;
    });
  }
  
  /**
   * 清除项目的所有任务
   */
  clearProject(projectId: string): void {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return;
    
    this.tasksMap.update(map => {
      const newMap = new Map(map);
      taskIds.forEach(id => newMap.delete(id));
      return newMap;
    });
    
    this.tasksByProject.update(map => {
      const newMap = new Map(map);
      newMap.delete(projectId);
      return newMap;
    });
  }
  
  /**
   * 清除所有任务
   */
  clear(): void {
    this.tasksMap.set(new Map());
    this.tasksByProject.set(new Map());
  }
}

/**
 * 项目状态 Store
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectStore {
  /**
   * 项目 Map - O(1) 查找
   */
  readonly projectsMap = signal<Map<string, Project>>(new Map());
  
  /**
   * 项目列表（从 Map 派生）
   */
  readonly projects = computed(() => Array.from(this.projectsMap().values()));
  
  /**
   * 当前活动项目 ID
   */
  readonly activeProjectId = signal<string | null>(null);
  
  /**
   * 当前活动项目
   */
  readonly activeProject = computed(() => {
    const id = this.activeProjectId();
    return id ? this.projectsMap().get(id) || null : null;
  });
  
  /**
   * 获取单个项目 - O(1)
   */
  getProject(id: string): Project | undefined {
    return this.projectsMap().get(id);
  }
  
  /**
   * 设置项目
   */
  setProject(project: Project): void {
    this.projectsMap.update(map => {
      const newMap = new Map(map);
      newMap.set(project.id, project);
      return newMap;
    });
  }
  
  /**
   * 批量设置项目
   */
  setProjects(projects: Project[]): void {
    this.projectsMap.update(() => {
      const newMap = new Map<string, Project>();
      projects.forEach(p => newMap.set(p.id, p));
      return newMap;
    });
  }
  
  /**
   * 删除项目
   */
  removeProject(id: string): void {
    this.projectsMap.update(map => {
      const newMap = new Map(map);
      newMap.delete(id);
      return newMap;
    });
    
    // 如果删除的是活动项目，清除选择
    if (this.activeProjectId() === id) {
      this.activeProjectId.set(null);
    }
  }
  
  /**
   * 清除所有项目
   */
  clear(): void {
    this.projectsMap.set(new Map());
    this.activeProjectId.set(null);
  }
}

/**
 * 连接状态 Store
 */
@Injectable({
  providedIn: 'root'
})
export class ConnectionStore {
  /**
   * 连接 Map - O(1) 查找
   */
  readonly connectionsMap = signal<Map<string, Connection>>(new Map());
  
  /**
   * 按项目索引的连接
   */
  private readonly connectionsByProject = signal<Map<string, Set<string>>>(new Map());
  
  /**
   * 连接列表
   */
  readonly connections = computed(() => Array.from(this.connectionsMap().values()));
  
  /**
   * 获取单个连接 - O(1)
   */
  getConnection(id: string): Connection | undefined {
    return this.connectionsMap().get(id);
  }
  
  /**
   * 获取项目的所有连接
   */
  getConnectionsByProject(projectId: string): Connection[] {
    const ids = this.connectionsByProject().get(projectId);
    if (!ids) return [];
    
    const map = this.connectionsMap();
    return Array.from(ids)
      .map(id => map.get(id))
      .filter((c): c is Connection => !!c);
  }
  
  /**
   * 设置连接
   */
  setConnection(connection: Connection, projectId: string): void {
    this.connectionsMap.update(map => {
      const newMap = new Map(map);
      newMap.set(connection.id, connection);
      return newMap;
    });
    
    this.connectionsByProject.update(map => {
      const newMap = new Map(map);
      if (!newMap.has(projectId)) {
        newMap.set(projectId, new Set());
      }
      newMap.get(projectId)!.add(connection.id);
      return newMap;
    });
  }
  
  /**
   * 批量设置连接
   */
  setConnections(connections: Connection[], projectId: string): void {
    this.connectionsMap.update(map => {
      const newMap = new Map(map);
      connections.forEach(c => newMap.set(c.id, c));
      return newMap;
    });
    
    this.connectionsByProject.update(map => {
      const newMap = new Map(map);
      newMap.set(projectId, new Set(connections.map(c => c.id)));
      return newMap;
    });
  }
  
  /**
   * 删除连接
   */
  removeConnection(id: string, projectId: string): void {
    this.connectionsMap.update(map => {
      const newMap = new Map(map);
      newMap.delete(id);
      return newMap;
    });
    
    this.connectionsByProject.update(map => {
      const newMap = new Map(map);
      newMap.get(projectId)?.delete(id);
      return newMap;
    });
  }
  
  /**
   * 清除项目的所有连接
   */
  clearProject(projectId: string): void {
    const ids = this.connectionsByProject().get(projectId);
    if (!ids) return;
    
    this.connectionsMap.update(map => {
      const newMap = new Map(map);
      ids.forEach(id => newMap.delete(id));
      return newMap;
    });
    
    this.connectionsByProject.update(map => {
      const newMap = new Map(map);
      newMap.delete(projectId);
      return newMap;
    });
  }
  
  /**
   * 清除所有连接
   */
  clear(): void {
    this.connectionsMap.set(new Map());
    this.connectionsByProject.set(new Map());
  }
}
