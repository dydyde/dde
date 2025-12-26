import { Component, inject, signal, computed, input, ChangeDetectionStrategy, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { ToastService } from '../../../services/toast.service';

/**
 * 同步状态组件
 * 支持紧凑模式和完整模式
 * - 紧凑模式：仅显示小图标和状态文字，适合侧边栏项目列表
 * - 完整模式：显示详细状态，适合弹出面板
 * 
 * 嵌入模式（embedded）：直接显示在侧边栏中而非弹窗
 * 
 * 冲突仓库功能：
 * - 显示冲突红点提示
 * - 用户点击可进入冲突解决中心
 */
@Component({
  selector: 'app-sync-status',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (compact() && !embedded()) {
      <!-- 紧凑模式：仅显示状态指示器 -->
      <div class="relative">
        <button 
          (click)="toggleExpand()"
          class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-stone-100 transition-colors text-xs"
          [class.bg-stone-100]="isExpanded()">
          <!-- 状态点 -->
          <div class="w-2 h-2 rounded-full flex-shrink-0" 
               [class.bg-green-500]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
               [class.bg-amber-500]="!isOnline() || offlineMode() || pendingCount() > 0 || !isLoggedIn()"
               [class.bg-red-500]="deadLetterCount() > 0"
               [class.bg-blue-500]="isSyncing()"
               [class.animate-pulse]="isSyncing() || pendingCount() > 0">
          </div>
          
          <!-- 简短状态文字 -->
          <span class="text-stone-500 hidden sm:inline">
            @if (isSyncing()) {
              同步中...
            } @else if (deadLetterCount() > 0) {
              {{ deadLetterCount() }} 失败
            } @else if (pendingCount() > 0) {
              {{ pendingCount() }} 待同步
            } @else if (!isOnline()) {
              离线
            } @else if (offlineMode()) {
              连接中断
            } @else if (!isLoggedIn()) {
              本地
            } @else {
              已保存
            }
          </span>
          
          <!-- 有问题时显示徽章 -->
          @if (hasIssues() && !isExpanded()) {
            <span class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {{ totalIssues() }}
            </span>
          }
        </button>
        
        <!-- 展开的浮动面板 -->
        @if (isExpanded()) {
          <div class="absolute bottom-full left-0 mb-2 z-50 w-72">
            <ng-container *ngTemplateOutlet="fullPanel"></ng-container>
          </div>
          <!-- 点击外部关闭 -->
          <div class="fixed inset-0 z-40" (click)="isExpanded.set(false)"></div>
        }
      </div>
    } @else if (embedded()) {
      <!-- 嵌入模式：直接显示在侧边栏中 -->
      <div class="w-full space-y-2 px-2 py-2 bg-stone-50/50 rounded-lg border border-stone-100">
        <!-- 状态概览行 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <!-- 状态点 -->
            <div data-testid="sync-status-indicator" class="w-2 h-2 rounded-full flex-shrink-0" 
                 [attr.data-testid-offline]="!isOnline() || offlineMode() ? 'offline-indicator' : null"
                 [attr.data-testid-pending]="pendingCount() > 0 ? 'pending-sync-indicator' : null"
                 [attr.data-testid-success]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues() ? 'sync-success-indicator' : null"
                 [class.bg-green-500]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                 [class.bg-amber-500]="!isOnline() || offlineMode() || pendingCount() > 0 || !isLoggedIn()"
                 [class.bg-red-500]="deadLetterCount() > 0"
                 [class.bg-blue-500]="isSyncing()"
                 [class.animate-pulse]="isSyncing() || pendingCount() > 0">
            </div>
            <!-- 状态文字 -->
            <span class="text-[11px] text-stone-500">
              @if (isSyncing()) {
                同步中...
              } @else if (deadLetterCount() > 0) {
                {{ deadLetterCount() }} 个同步失败
              } @else if (pendingCount() > 0) {
                {{ pendingCount() }} 待同步
              } @else if (!isOnline()) {
                离线模式
              } @else if (offlineMode()) {
                连接中断
              } @else if (!isLoggedIn()) {
                数据保存在本地
              } @else {
                已保存到云端
              }
            </span>
          </div>
          
          <!-- 操作按钮 -->
          <div class="flex items-center gap-1">
            @if (pendingCount() > 0 || deadLetterCount() > 0) {
              <button 
                (click)="retryAll(); $event.stopPropagation()"
                [disabled]="isProcessing() || isRetrying()"
                class="px-2 py-0.5 text-[10px] font-medium bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1">
                @if (isRetrying()) {
                  <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  同步中...
                } @else {
                  立即同步
                }
              </button>
            }
            
            <!-- 刷新同步按钮（次要操作） -->
            @if (isLoggedIn() && isOnline() && !offlineMode()) {
              <button
                (click)="resyncProject(); $event.stopPropagation()"
                [disabled]="isResyncing()"
                class="p-1 text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded transition-colors disabled:opacity-50"
                title="刷新同步当前项目">
                @if (isResyncing()) {
                  <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                } @else {
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                }
              </button>
            }
          </div>
        </div>
        
        <!-- 错误信息 -->
        @if (syncError()) {
          <div class="p-1.5 bg-red-50 border border-red-100 rounded text-[10px] text-red-600 line-clamp-2">
            {{ syncError() }}
          </div>
        }
        
        <!-- 死信队列（失败的操作）详情 -->
        @if (deadLetterCount() > 0) {
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-red-500 font-medium">失败的操作</span>
              <button 
                (click)="showDeadLetters.set(!showDeadLetters()); $event.stopPropagation()"
                class="text-[9px] text-stone-400 hover:text-stone-600">
                {{ showDeadLetters() ? '收起' : '展开' }}
              </button>
            </div>
            
            @if (showDeadLetters()) {
              <div class="space-y-1 max-h-24 overflow-y-auto">
                @for (item of deadLetters(); track item.action.id) {
                  <div class="flex items-center justify-between p-1 bg-white rounded border border-stone-100 text-[10px]">
                    <span class="text-stone-600 truncate flex-1">{{ getActionLabel(item.action) }}</span>
                    <div class="flex gap-0.5 ml-1">
                      <button 
                        (click)="retryDeadLetter(item.action.id); $event.stopPropagation()"
                        class="p-0.5 text-amber-600 hover:bg-amber-50 rounded"
                        title="重试">
                        ↻
                      </button>
                      <button 
                        (click)="dismissDeadLetter(item.action.id); $event.stopPropagation()"
                        class="p-0.5 text-stone-400 hover:bg-stone-100 rounded"
                        title="放弃">
                        ✕
                      </button>
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }
        
        <!-- 离线模式提示 -->
        @if (!isOnline()) {
          <div class="text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded">
            网络不可用，恢复后自动同步
          </div>
        }
      </div>
    } @else {
      <!-- 完整模式面板 -->
      <ng-container *ngTemplateOutlet="fullPanel"></ng-container>
    }
    
    <!-- 完整面板模板 -->
    <ng-template #fullPanel>
      <div class="bg-white rounded-xl shadow-lg border border-stone-200 overflow-hidden">
        <!-- 标题栏 -->
        <div class="px-3 py-2 bg-gradient-to-r from-stone-50 to-white border-b border-stone-100 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full" 
                 [class.bg-green-500]="isLoggedIn() && isOnline() && !offlineMode()"
                 [class.bg-amber-500]="!isOnline() || offlineMode() || !isLoggedIn()"
                 [class.bg-blue-500]="isSyncing()"
                 [class.animate-pulse]="isSyncing()">
            </div>
            <h3 class="font-bold text-stone-700 text-xs">同步状态</h3>
          </div>
          <span class="text-[10px] text-stone-400">
            {{ !isLoggedIn() ? '未登录' : isOnline() && !offlineMode() ? '在线' : offlineMode() ? '连接中断' : '离线' }}
          </span>
        </div>
        
        <!-- 状态概览 -->
        <div class="p-3 space-y-2">
          <!-- 同步错误 -->
          @if (syncError()) {
            <div class="p-2 bg-red-50 border border-red-100 rounded-lg">
              <div class="flex items-start gap-2">
                <svg class="w-3 h-3 text-red-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div class="text-[10px] text-red-600 line-clamp-2">{{ syncError() }}</div>
              </div>
            </div>
          }
          
          <!-- 待处理操作 -->
          <div class="flex items-center justify-between p-2 bg-stone-50 rounded-lg">
            <div class="flex items-center gap-1.5">
              <svg class="w-3 h-3 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span class="text-[10px] text-stone-600">待处理</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold" [class.text-stone-400]="pendingCount() === 0" [class.text-amber-600]="pendingCount() > 0">
                {{ pendingCount() }}
              </span>
              @if (pendingCount() > 0) {
                <button 
                  (click)="retryAll(); $event.stopPropagation()"
                  [disabled]="isProcessing()"
                  class="px-1.5 py-0.5 text-[9px] font-medium bg-amber-100 hover:bg-amber-200 text-amber-700 rounded transition-colors disabled:opacity-50">
                  {{ isProcessing() ? '...' : '同步' }}
                </button>
              }
            </div>
          </div>
          
          <!-- 死信队列 -->
          @if (deadLetterCount() > 0) {
            <div class="p-2 bg-red-50 border border-red-100 rounded-lg">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <svg class="w-3 h-3 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  <span class="text-[10px] text-red-600 font-medium">{{ deadLetterCount() }} 个失败</span>
                </div>
                <button 
                  (click)="showDeadLetters.set(!showDeadLetters()); $event.stopPropagation()"
                  class="text-[9px] text-red-500 hover:text-red-700">
                  {{ showDeadLetters() ? '收起' : '详情' }}
                </button>
              </div>
              
              <!-- 死信详情列表 -->
              @if (showDeadLetters()) {
                <div class="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
                  @for (item of deadLetters(); track item.action.id) {
                    <div class="flex items-center justify-between p-1.5 bg-white rounded text-[10px]">
                      <div class="flex-1 min-w-0 mr-2">
                        <div class="font-medium text-red-700 truncate">{{ getActionLabel(item.action) }}</div>
                      </div>
                      <div class="flex gap-0.5 flex-shrink-0">
                        <button 
                          (click)="retryDeadLetter(item.action.id); $event.stopPropagation()"
                          class="p-0.5 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded"
                          title="重试">
                          <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                        <button 
                          (click)="dismissDeadLetter(item.action.id); $event.stopPropagation()"
                          class="p-0.5 bg-stone-100 hover:bg-stone-200 text-stone-500 rounded"
                          title="放弃">
                          <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  }
                </div>
                
                @if (deadLetterCount() > 1) {
                  <button 
                    (click)="clearAllDeadLetters(); $event.stopPropagation()"
                    class="w-full mt-1.5 py-1 text-[9px] font-medium text-red-600 hover:bg-red-100 rounded transition-colors">
                    清空全部
                  </button>
                }
              }
            </div>
          }
        </div>
        
        <!-- 底部提示 -->
        @if (!isOnline()) {
          <div class="px-3 py-1.5 bg-amber-50 border-t border-amber-100 text-[10px] text-amber-700">
            离线模式 - 恢复后自动同步
          </div>
        }
      </div>
    </ng-template>
  `
})
export class SyncStatusComponent {
  private actionQueue = inject(ActionQueueService);
  private syncService = inject(SimpleSyncService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private toastService = inject(ToastService);
  
  // 输入属性 - 是否使用紧凑模式
  compact = input(false);
  // 输入属性 - 是否使用嵌入模式（直接显示在侧边栏中）
  embedded = input(false);
  
  // 输出事件 - 打开冲突解决中心
  readonly openConflictCenterEvent = output<void>({ alias: 'openConflictCenter' });
  
  /** 用户是否已登录 */
  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());
  
  // 状态
  showDeadLetters = signal(false);
  isExpanded = signal(false);
  /** 本地重试状态（用于禁用按钮防止重复点击） */
  isRetrying = signal(false);
  /** 重新同步状态 */
  isResyncing = signal(false);
  
  // 从服务获取状态
  readonly pendingCount = this.actionQueue.queueSize;
  readonly deadLetterCount = this.actionQueue.deadLetterSize;
  readonly deadLetters = this.actionQueue.deadLetterQueue;
  readonly isProcessing = this.actionQueue.isProcessing;
  
  // 冲突仓库状态
  readonly conflictCount = this.conflictStorage.conflictCount;
  readonly hasUnresolvedConflicts = this.conflictStorage.hasUnresolvedConflicts;
  
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  
  // 计算属性 - 是否有需要关注的问题（包括 offlineMode 连接中断状态和冲突）
  readonly hasIssues = computed(() => 
    this.deadLetterCount() > 0 || this.pendingCount() > 0 || !!this.syncError() || this.offlineMode() || this.conflictCount() > 0
  );
  
  readonly totalIssues = computed(() => 
    this.deadLetterCount() + (this.pendingCount() > 0 ? 1 : 0) + (this.syncError() ? 1 : 0) + (this.offlineMode() ? 1 : 0) + this.conflictCount()
  );
  
  /** 详细状态文本 */
  readonly detailedStatus = computed(() => {
    if (this.isSyncing()) {
      return '正在同步数据...';
    }
    if (this.deadLetterCount() > 0) {
      return `${this.deadLetterCount()} 个操作失败`;
    }
    if (this.pendingCount() > 0) {
      return `${this.pendingCount()} 个操作待同步`;
    }
    if (!this.isOnline()) {
      return '离线模式 - 数据保存在本地';
    }
    if (this.offlineMode()) {
      return '连接中断 - 恢复后自动同步';
    }
    if (this.syncError()) {
      return '同步错误';
    }
    if (!this.isLoggedIn()) {
      return '数据保存在本地 - 登录后可同步到云端';
    }
    return '数据已保存到云端';
  });
  
  /**
   * 切换展开状态
   */
  toggleExpand() {
    this.isExpanded.update(v => !v);
  }
  
  /**
   * 立即重试所有待处理操作
   */
  async retryAll() {
    // 防止重复点击
    if (this.isRetrying() || this.isProcessing()) return;
    
    this.isRetrying.set(true);
    try {
      await this.actionQueue.processQueue();
    } finally {
      this.isRetrying.set(false);
    }
  }
  
  /**
   * 重试单个死信
   */
  retryDeadLetter(itemId: string) {
    this.actionQueue.retryDeadLetter(itemId);
  }
  
  /**
   * 放弃单个死信
   */
  dismissDeadLetter(itemId: string) {
    this.actionQueue.dismissDeadLetter(itemId);
  }
  
  /**
   * 清空所有死信
   */
  clearAllDeadLetters() {
    this.actionQueue.clearDeadLetterQueue();
    this.showDeadLetters.set(false);
  }
  
  /**
   * 打开冲突解决中心
   * 发出事件让父组件处理（可能是打开模态框或导航到冲突页面）
   */
  openConflictCenter() {
    this.isExpanded.set(false);
    this.openConflictCenterEvent.emit();
  }
  
  /**
   * 重新同步当前项目
   * 智能合并而非暴力覆盖
   */
  async resyncProject() {
    if (this.isResyncing()) return;
    
    this.isResyncing.set(true);
    try {
      const result = await this.syncCoordinator.resyncActiveProject();
      
      if (result.success) {
        if (result.conflictDetected) {
          this.toastService.warning('同步完成', result.message, { duration: 5000 });
        } else {
          this.toastService.success('同步完成', result.message);
        }
      } else {
        this.toastService.error('同步失败', result.message);
      }
    } catch (_e) {
      this.toastService.error('同步错误', '重新同步时发生意外错误');
    } finally {
      this.isResyncing.set(false);
    }
  }
  
  /**
   * 获取操作的可读标签
   */
  getActionLabel(action: { type: string; entityType: string; entityId: string }): string {
    const typeLabels: Record<string, string> = {
      'create': '创建',
      'update': '更新',
      'delete': '删除'
    };
    const entityLabels: Record<string, string> = {
      'project': '项目',
      'task': '任务',
      'preference': '设置'
    };
    
    return `${typeLabels[action.type] || action.type} ${entityLabels[action.entityType] || action.entityType}`;
  }
  
  /**
   * 格式化日期
   */
  formatDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} 天前`;
  }
}
