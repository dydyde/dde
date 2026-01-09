import { Component, inject, signal, Output, EventEmitter, Input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService } from '../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { ToastService } from '../../../services/toast.service';
import { Task } from '../../../models';
import { TRASH_CONFIG } from '../../../config';

/**
 * 回收站模态框组件
 * 展示已删除和已归档的任务并提供恢复/永久删除功能
 */
@Component({
  selector: 'app-trash-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (show) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
           (click)="close.emit()">
        <div class="bg-white dark:bg-stone-900 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-700 overflow-hidden w-full max-w-lg mx-4 animate-scale-in max-h-[80vh] flex flex-col"
             (click)="$event.stopPropagation()">
          
          <!-- 标题栏 -->
          <div class="px-5 py-4 border-b border-stone-100 dark:border-stone-700 flex items-center justify-between flex-shrink-0">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-stone-100 dark:bg-stone-800 flex items-center justify-center">
                <svg class="w-5 h-5 text-stone-500 dark:text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 class="text-lg font-bold text-stone-800 dark:text-stone-100">回收站</h3>
                <p class="text-xs text-stone-500 dark:text-stone-400">
                  {{ deletedTasks().length }} 个已删除 · {{ archivedTasks().length }} 个已归档
                </p>
              </div>
            </div>
            <button (click)="close.emit()" class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 p-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <!-- 切换标签 -->
          <div class="flex border-b border-stone-100 dark:border-stone-700">
            <button 
              (click)="activeTab.set('deleted')"
              class="flex-1 py-2.5 text-sm font-medium transition-colors"
              [class.text-stone-800]="activeTab() === 'deleted'"
              [class.border-b-2]="activeTab() === 'deleted'"
              [class.border-stone-800]="activeTab() === 'deleted'"
              [class.text-stone-400]="activeTab() !== 'deleted'">
              已删除 ({{ deletedTasks().length }})
            </button>
            <button 
              (click)="activeTab.set('archived')"
              class="flex-1 py-2.5 text-sm font-medium transition-colors"
              [class.text-violet-700]="activeTab() === 'archived'"
              [class.border-b-2]="activeTab() === 'archived'"
              [class.border-violet-600]="activeTab() === 'archived'"
              [class.text-stone-400]="activeTab() !== 'archived'">
              已归档 ({{ archivedTasks().length }})
            </button>
          </div>
          
          <!-- 任务列表 -->
          <div class="flex-1 overflow-y-auto px-5 py-3">
            <!-- 已删除任务 -->
            @if (activeTab() === 'deleted') {
              @if (deletedTasks().length === 0) {
                <div class="text-center py-8">
                  <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-stone-50 dark:bg-stone-800 flex items-center justify-center">
                    <svg class="w-8 h-8 text-stone-300 dark:text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p class="text-stone-400 dark:text-stone-500 text-sm">回收站是空的</p>
                  <p class="text-stone-300 dark:text-stone-600 text-xs mt-1">删除的任务将在此显示</p>
                </div>
              } @else {
                <ul class="space-y-2">
                  @for (task of deletedTasks(); track task.id) {
                    <li class="p-3 bg-stone-50 dark:bg-stone-800 rounded-lg border border-stone-100 dark:border-stone-700 hover:border-stone-200 dark:hover:border-stone-600 transition-all">
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 mb-1">
                            <span class="font-medium text-stone-800 dark:text-stone-100 text-sm truncate">{{ task.title }}</span>
                            @if (task.shortId) {
                              <span class="text-[9px] font-mono text-stone-400 dark:text-stone-500 bg-stone-100 dark:bg-stone-700 px-1 rounded">{{ task.shortId }}</span>
                            }
                          </div>
                          <p class="text-xs text-stone-500 truncate">{{ task.content || '无内容' }}</p>
                          <div class="flex items-center gap-2 mt-1">
                            <span class="text-[10px] text-stone-400">
                              删除于 {{ formatDeletedAt(task.deletedAt) }}
                            </span>
                            @if (hasChildren(task.id)) {
                              <span class="text-[10px] text-amber-600 bg-amber-50 px-1.5 rounded">
                                含 {{ getChildCount(task.id) }} 个子任务
                              </span>
                            }
                          </div>
                        </div>
                        <div class="flex gap-1 flex-shrink-0">
                          <button 
                            (click)="restoreTask(task)"
                            class="px-2 py-1 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-800/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-medium rounded transition-all"
                            title="恢复任务">
                            恢复
                          </button>
                          <button 
                            (click)="confirmPermanentDelete(task)"
                            class="px-2 py-1 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-800/50 text-red-600 dark:text-red-400 text-[10px] font-medium rounded transition-all"
                            title="永久删除">
                            删除
                          </button>
                        </div>
                      </div>
                    </li>
                  }
                </ul>
              }
            }
            
            <!-- 已归档任务 -->
            @if (activeTab() === 'archived') {
              @if (archivedTasks().length === 0) {
                <div class="text-center py-8">
                  <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
                    <svg class="w-8 h-8 text-violet-300 dark:text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                  </div>
                  <p class="text-stone-400 dark:text-stone-500 text-sm">没有归档任务</p>
                  <p class="text-stone-300 dark:text-stone-600 text-xs mt-1">归档的任务将在此显示</p>
                </div>
              } @else {
                <ul class="space-y-2">
                  @for (task of archivedTasks(); track task.id) {
                    <li class="p-3 bg-violet-50/50 dark:bg-violet-900/20 rounded-lg border border-violet-100 dark:border-violet-800/50 hover:border-violet-200 dark:hover:border-violet-700 transition-all">
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 mb-1">
                            <span class="font-medium text-stone-800 dark:text-stone-100 text-sm truncate">{{ task.title }}</span>
                            @if (task.shortId) {
                              <span class="text-[9px] font-mono text-violet-400 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/50 px-1 rounded">{{ task.shortId }}</span>
                            }
                          </div>
                          <p class="text-xs text-stone-500 dark:text-stone-400 truncate">{{ task.content || '无内容' }}</p>
                          <div class="flex items-center gap-2 mt-1">
                            <span class="text-[10px] text-violet-500 dark:text-violet-400">
                              <svg class="w-3 h-3 inline-block mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                              </svg>
                              已归档
                            </span>
                            @if (hasChildren(task.id)) {
                              <span class="text-[10px] text-amber-600 bg-amber-50 px-1.5 rounded">
                                含 {{ getChildCount(task.id) }} 个子任务
                              </span>
                            }
                          </div>
                        </div>
                        <div class="flex gap-1 flex-shrink-0">
                          <button 
                            (click)="unarchiveTask(task)"
                            class="px-2 py-1 bg-violet-100 dark:bg-violet-900/50 hover:bg-violet-200 dark:hover:bg-violet-800/50 text-violet-700 dark:text-violet-300 text-[10px] font-medium rounded transition-all"
                            title="取消归档">
                            取消归档
                          </button>
                        </div>
                      </div>
                    </li>
                  }
                </ul>
              }
            }
          </div>
          
          <!-- 底部操作栏 -->
          <div class="px-5 py-3 border-t border-stone-100 dark:border-stone-700 flex justify-between items-center flex-shrink-0 bg-stone-50/50 dark:bg-stone-800/50">
            @if (activeTab() === 'deleted') {
              <p class="text-[10px] text-stone-400 dark:text-stone-500">
                任务将在删除 {{ autoCleanupDays }} 天后自动清除
              </p>
              @if (deletedTasks().length > 0) {
                <button 
                  (click)="confirmEmptyTrash()"
                  class="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-all">
                  清空回收站
                </button>
              }
            } @else {
              <p class="text-[10px] text-violet-500">
                归档任务不会自动删除
              </p>
            }
          </div>
        </div>
      </div>
      
      <!-- 确认永久删除对话框 -->
      @if (confirmDeleteTask()) {
        <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
             (click)="confirmDeleteTask.set(null)">
          <div class="bg-white dark:bg-stone-900 rounded-xl shadow-2xl border border-stone-200 dark:border-stone-700 p-5 w-80 mx-4 animate-scale-in"
               (click)="$event.stopPropagation()">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h4 class="font-bold text-stone-800 dark:text-stone-100">永久删除</h4>
                <p class="text-xs text-stone-500 dark:text-stone-400">此操作不可撤销</p>
              </div>
            </div>
            <p class="text-sm text-stone-600 dark:text-stone-300 mb-4">
              确定永久删除 "<span class="font-medium">{{ confirmDeleteTask()?.title }}</span>" 吗？
              @if (hasChildren(confirmDeleteTask()!.id)) {
                <span class="text-amber-600">其 {{ getChildCount(confirmDeleteTask()!.id) }} 个子任务也将被删除。</span>
              }
            </p>
            <div class="flex gap-2">
              <button 
                (click)="confirmDeleteTask.set(null)"
                class="flex-1 px-3 py-2 bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-300 text-sm font-medium rounded-lg transition-all">
                取消
              </button>
              <button 
                (click)="executePermanentDelete()"
                class="flex-1 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-all">
                永久删除
              </button>
            </div>
          </div>
        </div>
      }
      
      <!-- 确认清空回收站对话框 -->
      @if (showEmptyConfirm()) {
        <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
             (click)="showEmptyConfirm.set(false)">
          <div class="bg-white dark:bg-stone-900 rounded-xl shadow-2xl border border-stone-200 dark:border-stone-700 p-5 w-80 mx-4 animate-scale-in"
               (click)="$event.stopPropagation()">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h4 class="font-bold text-stone-800 dark:text-stone-100">清空回收站</h4>
                <p class="text-xs text-stone-500 dark:text-stone-400">此操作不可撤销</p>
              </div>
            </div>
            <p class="text-sm text-stone-600 dark:text-stone-300 mb-4">
              确定永久删除回收站中的所有 {{ deletedTasks().length }} 个任务吗？
            </p>
            <div class="flex gap-2">
              <button 
                (click)="showEmptyConfirm.set(false)"
                class="flex-1 px-3 py-2 bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-300 text-sm font-medium rounded-lg transition-all">
                取消
              </button>
              <button 
                (click)="executeEmptyTrash()"
                class="flex-1 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-all">
                全部删除
              </button>
            </div>
          </div>
        </div>
      }
    }
  `
})
export class TrashModalComponent {
  @Input() show = false;
  @Output() close = new EventEmitter<void>();
  
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private toast = inject(ToastService);
  
  // 当前激活的标签页
  activeTab = signal<'deleted' | 'archived'>('deleted');
  
  // 确认删除状态
  confirmDeleteTask = signal<Task | null>(null);
  showEmptyConfirm = signal(false);
  
  // 从配置读取自动清理天数
  readonly autoCleanupDays = TRASH_CONFIG.AUTO_CLEANUP_DAYS;
  
  // 已删除任务列表
  deletedTasks = computed(() => this.projectState.deletedTasks());
  
  // 已归档任务列表（当前项目中状态为 archived 的任务）
  archivedTasks = computed(() => 
    this.projectState.tasks().filter(t => t.status === 'archived' && !t.deletedAt)
  );
  
  /**
   * 格式化删除时间
   */
  formatDeletedAt(deletedAt: string | null | undefined): string {
    if (!deletedAt) return '未知时间';
    
    const date = new Date(deletedAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        return `${diffMinutes} 分钟前`;
      }
      return `${diffHours} 小时前`;
    } else if (diffDays === 1) {
      return '昨天';
    } else if (diffDays < 7) {
      return `${diffDays} 天前`;
    } else {
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
  }
  
  /**
   * 检查任务是否有子任务
   */
  hasChildren(taskId: string): boolean {
    // 同时检查当前任务列表和已删除任务列表
    const allTasks = [...this.projectState.tasks(), ...this.projectState.deletedTasks()];
    return allTasks.some(t => t.parentId === taskId);
  }
  
  /**
   * 获取子任务数量（包括已删除的子任务）
   */
  getChildCount(taskId: string): number {
    // 同时计算当前任务和已删除任务中的子任务
    const allTasks = [...this.projectState.tasks(), ...this.projectState.deletedTasks()];
    
    const countDescendants = (id: string): number => {
      const children = allTasks.filter(t => t.parentId === id);
      return children.length + children.reduce((sum, child) => sum + countDescendants(child.id), 0);
    };
    return countDescendants(taskId);
  }
  
  /**
   * 恢复任务
   */
  restoreTask(task: Task) {
    this.taskOpsAdapter.restoreTask(task.id);
    this.toast.success('已恢复', `任务 "${task.title}" 已恢复`);
  }
  
  /**
   * 取消归档任务
   */
  unarchiveTask(task: Task) {
    this.taskOpsAdapter.updateTaskStatus(task.id, 'active');
    this.toast.success('已取消归档', `任务 "${task.title}" 已恢复到主视图`);
  }
  
  /**
   * 确认永久删除
   */
  confirmPermanentDelete(task: Task) {
    this.confirmDeleteTask.set(task);
  }
  
  /**
   * 执行永久删除
   */
  executePermanentDelete() {
    const task = this.confirmDeleteTask();
    if (task) {
      this.taskOpsAdapter.permanentlyDeleteTask(task.id);
      this.toast.success('已删除', `任务 "${task.title}" 已永久删除`);
    }
    this.confirmDeleteTask.set(null);
  }
  
  /**
   * 确认清空回收站
   */
  confirmEmptyTrash() {
    this.showEmptyConfirm.set(true);
  }
  
  /**
   * 执行清空回收站
   */
  executeEmptyTrash() {
    this.taskOpsAdapter.emptyTrash();
    this.showEmptyConfirm.set(false);
    this.toast.success('已清空', '回收站已清空');
  }
}
