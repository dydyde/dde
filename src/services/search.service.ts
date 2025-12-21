import { Injectable, inject, computed } from '@angular/core';
import { Task, Project } from '../models';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';

/**
 * 搜索结果
 */
export interface SearchResult {
  tasks: Task[];
  totalCount: number;
}

/**
 * 项目搜索结果
 */
export interface ProjectSearchResult {
  projects: Project[];
  totalCount: number;
}

/**
 * 搜索服务
 * 从 StoreService 拆分出来，专注于搜索逻辑
 * 
 * 【职责边界】
 * ✓ 任务搜索（标题、内容、displayId、标签、附件）
 * ✓ 项目搜索（名称、描述）
 * ✓ 模糊匹配算法
 * ✓ 搜索结果计算
 * ✗ 搜索查询状态 → UiStateService
 * ✗ 任务数据 → ProjectStateService
 * 
 * 【依赖说明】
 * 此服务依赖 ProjectStateService 获取任务数据
 * 依赖 UiStateService 获取搜索查询状态
 * 这是设计上的正确依赖方向：搜索 → 数据源
 */
@Injectable({
  providedIn: 'root'
})
export class SearchService {
  private projectState = inject(ProjectStateService);
  private uiState = inject(UiStateService);
  
  // ========== 计算属性 ==========
  
  /**
   * 任务搜索结果
   */
  readonly searchResults = computed(() => {
    const query = this.normalizeSearchQuery(this.uiState.searchQuery());
    if (!query) return [];
    
    const tasks = this.projectState.tasks();
    return tasks.filter(t => 
      !t.deletedAt && (
        this.fuzzyMatch(t.title, query) ||
        this.fuzzyMatch(t.content, query) ||
        this.fuzzyMatch(t.displayId, query) ||
        (t.shortId && this.fuzzyMatch(t.shortId, query)) ||
        (t.attachments?.some(a => this.fuzzyMatch(a.name, query)) ?? false) ||
        (t.tags?.some(tag => this.fuzzyMatch(tag, query)) ?? false)
      )
    );
  });
  
  /**
   * 项目列表搜索结果
   */
  readonly filteredProjects = computed(() => {
    const query = this.normalizeSearchQuery(this.uiState.projectSearchQuery());
    const projects = this.projectState.projects();
    
    if (!query) return projects;
    
    return projects.filter(p => {
      const nameMatch = this.fuzzyMatch(p.name, query);
      const descMatch = p.description ? this.fuzzyMatch(p.description, query) : false;
      return nameMatch || descMatch;
    });
  });
  
  /**
   * 搜索结果数量
   */
  readonly searchResultCount = computed(() => this.searchResults().length);
  
  /**
   * 是否有搜索结果
   */
  readonly hasSearchResults = computed(() => this.searchResultCount() > 0);
  
  // ========== 公共方法 ==========
  
  /**
   * 执行任务搜索（手动调用）
   * @param query 搜索查询
   * @param tasks 任务列表（可选，默认使用当前项目任务）
   */
  searchTasks(query: string, tasks?: Task[]): Task[] {
    const normalizedQuery = this.normalizeSearchQuery(query);
    if (!normalizedQuery) return [];
    
    const searchTargets = tasks ?? this.projectState.tasks();
    
    return searchTargets.filter(t => 
      !t.deletedAt && (
        this.fuzzyMatch(t.title, normalizedQuery) ||
        this.fuzzyMatch(t.content, normalizedQuery) ||
        this.fuzzyMatch(t.displayId, normalizedQuery) ||
        (t.shortId && this.fuzzyMatch(t.shortId, normalizedQuery)) ||
        (t.attachments?.some(a => this.fuzzyMatch(a.name, normalizedQuery)) ?? false) ||
        (t.tags?.some(tag => this.fuzzyMatch(tag, normalizedQuery)) ?? false)
      )
    );
  }
  
  /**
   * 执行项目搜索（手动调用）
   * @param query 搜索查询
   * @param projects 项目列表（可选，默认使用所有项目）
   */
  searchProjects(query: string, projects?: Project[]): Project[] {
    const normalizedQuery = this.normalizeSearchQuery(query);
    if (!normalizedQuery) return projects ?? this.projectState.projects();
    
    const searchTargets = projects ?? this.projectState.projects();
    
    return searchTargets.filter(p => {
      const nameMatch = this.fuzzyMatch(p.name, normalizedQuery);
      const descMatch = p.description ? this.fuzzyMatch(p.description, normalizedQuery) : false;
      return nameMatch || descMatch;
    });
  }
  
  /**
   * 高亮搜索结果中的匹配文本
   * @param text 原始文本
   * @param query 搜索查询
   * @returns 带有高亮标记的 HTML 字符串
   */
  highlightMatch(text: string, query: string): string {
    if (!text || !query) return text;
    
    const normalizedQuery = this.normalizeSearchQuery(query);
    if (!normalizedQuery) return text;
    
    // 简单的高亮实现：包含匹配
    const lowerText = text.toLowerCase();
    const lowerQuery = normalizedQuery.toLowerCase();
    
    const index = lowerText.indexOf(lowerQuery);
    if (index === -1) return text;
    
    const before = text.slice(0, index);
    const match = text.slice(index, index + normalizedQuery.length);
    const after = text.slice(index + normalizedQuery.length);
    
    return `${this.escapeHtml(before)}<mark class="search-highlight">${this.escapeHtml(match)}</mark>${this.escapeHtml(after)}`;
  }
  
  // ========== 私有辅助方法 ==========
  
  /**
   * 规范化搜索查询
   */
  private normalizeSearchQuery(query: string): string {
    return query
      .toLowerCase()
      .trim()
      .replace(/[.,!?;:'"()[\]{}<>@#$%^&*+=~`|\\/-]/g, '')
      .replace(/\s+/g, ' ');
  }
  
  /**
   * 模糊匹配
   * 支持字符序列匹配 (例如 "abc" 匹配 "axbycz")
   */
  private fuzzyMatch(text: string, query: string): boolean {
    if (!text || !query) return false;
    
    const normalizedText = text.toLowerCase();
    
    // 1. 包含匹配 (最快)
    if (normalizedText.includes(query)) {
      return true;
    }
    
    // 2. 字符序列匹配 (Fuzzy Sequence Matching)
    let queryIndex = 0;
    let textIndex = 0;
    
    while (queryIndex < query.length && textIndex < normalizedText.length) {
      if (query[queryIndex] === normalizedText[textIndex]) {
        queryIndex++;
      }
      textIndex++;
    }
    
    return queryIndex === query.length;
  }
  
  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
