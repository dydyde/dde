import { Component, inject, Output, EventEmitter, computed, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService, ConflictRecord } from '../../../services/conflict-storage.service';
import { ConflictResolutionService } from '../../../services/conflict-resolution.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { Task } from '../../../models';

/** 任务差异项 */
interface TaskDiff {
  id: string;
  title: string;
  localValue?: string;
  remoteValue?: string;
  status: 'same' | 'modified' | 'local-only' | 'remote-only';
  field?: string; // 冲突字段名
}

/** 冲突展示项 */
interface ConflictItem {
  projectId: string;
  projectName: string;
  reason: string;
  reasonLabel: string;
  conflictedAt: string;
  localTaskCount: number;
  remoteTaskCount: number;
  taskDiffs: TaskDiff[];
  isExpanded: boolean;
  isResolving: boolean;
}

/**
 * 仪表盘模态框组件
 * 集中展示数据冲突、同步状态、焦点通知等重要信息
 * 支持内联冲突解决，无需跳转到独立模态框
 * 
 * 设计原则：
 * - 移动端优先：差异视图使用垂直堆叠布局
 * - 内联操作：直接在仪表盘内解决冲突
 * - 简化策略：使用本地 / 使用云端 / 保留两者
 */
@Component({
  selector: 'app-dashboard-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden animate-scale-in" (click)="$event.stopPropagation()">
        <!-- 标题栏 -->
        <div class="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-gradient-to-r from-stone-50 to-white">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <h2 class="text-lg font-bold text-stone-800">系统仪表盘</h2>
              <p class="text-xs text-stone-500">监控同步状态与数据冲突</p>
            </div>
          </div>
          <button (click)="close.emit()" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition-colors">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        
        <!-- 内容区域 -->
        <div class="p-6 space-y-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          
          <!-- 状态概览卡片 -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <!-- 同步状态 -->
            <div class="p-4 rounded-lg border-2 transition-all"
                 [class.border-green-200]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                 [class.bg-green-50]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                 [class.border-amber-200]="!isOnline() || offlineMode() || !isLoggedIn()"
                 [class.bg-amber-50]="!isOnline() || offlineMode() || !isLoggedIn()"
                 [class.border-blue-200]="isSyncing()"
                 [class.bg-blue-50]="isSyncing()">
              <div class="flex items-center gap-2 mb-2">
                <div class="w-2.5 h-2.5 rounded-full" 
                     [class.bg-green-500]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                     [class.bg-amber-500]="!isOnline() || offlineMode() || !isLoggedIn()"
                     [class.bg-blue-500]="isSyncing()"
                     [class.animate-pulse]="isSyncing()">
                </div>
                <span class="text-xs font-semibold text-stone-600">同步状态</span>
              </div>
              <div class="text-sm font-medium"
                   [class.text-green-700]="isLoggedIn() && isOnline() && !offlineMode() && !hasIssues()"
                   [class.text-amber-700]="!isOnline() || offlineMode() || !isLoggedIn()"
                   [class.text-blue-700]="isSyncing()">
                {{ detailedStatus() }}
              </div>
            </div>
            
            <!-- 待处理操作 -->
            <div class="p-4 rounded-lg border-2 transition-all"
                 [class.border-stone-200]="pendingCount() === 0"
                 [class.bg-stone-50]="pendingCount() === 0"
                 [class.border-amber-200]="pendingCount() > 0"
                 [class.bg-amber-50]="pendingCount() > 0">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-4 h-4 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span class="text-xs font-semibold text-stone-600">待处理操作</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-2xl font-bold" 
                      [class.text-stone-400]="pendingCount() === 0"
                      [class.text-amber-600]="pendingCount() > 0">
                  {{ pendingCount() }}
                </span>
                @if (pendingCount() > 0) {
                  <button 
                    (click)="retryAll()"
                    [disabled]="isProcessing()"
                    class="px-3 py-1.5 text-xs font-medium bg-amber-100 hover:bg-amber-200 text-amber-700 rounded-lg transition-colors disabled:opacity-50">
                    {{ isProcessing() ? '同步中...' : '立即同步' }}
                  </button>
                }
              </div>
            </div>
            
            <!-- 数据冲突 -->
            <div class="p-4 rounded-lg border-2 transition-all"
                 [class.border-stone-200]="conflictCount() === 0"
                 [class.bg-stone-50]="conflictCount() === 0"
                 [class.border-red-200]="conflictCount() > 0"
                 [class.bg-red-50]="conflictCount() > 0">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-4 h-4 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span class="text-xs font-semibold text-stone-600">数据冲突</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-2xl font-bold" 
                      [class.text-stone-400]="conflictCount() === 0"
                      [class.text-red-600]="conflictCount() > 0">
                  {{ conflictCount() }}
                </span>
                @if (conflictCount() > 0 && !showConflictList()) {
                  <button 
                    (click)="showConflictList.set(true)"
                    class="px-3 py-1.5 text-xs font-medium bg-red-100 hover:bg-red-200 text-red-700 rounded-lg transition-colors">
                    查看详情
                  </button>
                }
              </div>
            </div>
          </div>
          
          <!-- ========== 内联冲突解决区域 ========== -->
          @if (conflictCount() > 0 && showConflictList()) {
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-stone-700 flex items-center gap-2">
                  <svg class="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  冲突解决中心
                </h3>
                <button 
                  (click)="showConflictList.set(false)"
                  class="text-xs text-stone-500 hover:text-stone-700">
                  收起
                </button>
              </div>
              
              <!-- 冲突列表 -->
              @for (conflict of conflictItems(); track conflict.projectId) {
                <div class="border border-red-200 rounded-lg overflow-hidden bg-white">
                  <!-- 冲突卡片头部 -->
                  <div class="p-4 bg-red-50 border-b border-red-100">
                    <div class="flex items-start justify-between gap-3">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 mb-1">
                          <span class="text-sm font-semibold text-stone-800 truncate">{{ conflict.projectName }}</span>
                          <span class="px-1.5 py-0.5 text-[9px] font-medium rounded"
                                [class.bg-amber-100]="conflict.reason === 'concurrent_edit'"
                                [class.text-amber-700]="conflict.reason === 'concurrent_edit'"
                                [class.bg-blue-100]="conflict.reason === 'network_recovery'"
                                [class.text-blue-700]="conflict.reason === 'network_recovery'"
                                [class.bg-red-100]="conflict.reason === 'version_mismatch'"
                                [class.text-red-700]="conflict.reason === 'version_mismatch'">
                            {{ conflict.reasonLabel }}
                          </span>
                        </div>
                        <div class="text-[10px] text-stone-500 flex items-center gap-3">
                          <span>本地 {{ conflict.localTaskCount }} 个任务</span>
                          <span>·</span>
                          <span>云端 {{ conflict.remoteTaskCount }} 个任务</span>
                          <span>·</span>
                          <span>{{ formatRelativeTime(conflict.conflictedAt) }}</span>
                        </div>
                      </div>
                      <button 
                        (click)="toggleConflictExpand(conflict.projectId)"
                        class="p-1 rounded hover:bg-red-100 transition-colors">
                        <svg class="w-4 h-4 text-stone-500 transition-transform" 
                             [class.rotate-180]="conflict.isExpanded"
                             fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                    
                    <!-- 快速操作按钮 -->
                    <div class="mt-3 flex flex-wrap gap-2">
                      <button 
                        (click)="resolveUseLocal(conflict.projectId)"
                        [disabled]="conflict.isResolving"
                        class="flex-1 min-w-[100px] px-3 py-2 text-xs font-medium bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                        @if (conflict.isResolving) {
                          <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                          </svg>
                        } @else {
                          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="4" width="18" height="16" rx="2"/>
                            <path d="M7 8h10M7 12h6"/>
                          </svg>
                        }
                        使用本地
                      </button>
                      <button 
                        (click)="resolveUseRemote(conflict.projectId)"
                        [disabled]="conflict.isResolving"
                        class="flex-1 min-w-[100px] px-3 py-2 text-xs font-medium bg-teal-500 hover:bg-teal-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
                        </svg>
                        使用云端
                      </button>
                      <button 
                        (click)="resolveKeepBoth(conflict.projectId)"
                        [disabled]="conflict.isResolving"
                        class="flex-1 min-w-[100px] px-3 py-2 text-xs font-medium bg-violet-500 hover:bg-violet-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2"/>
                        </svg>
                        保留两者
                      </button>
                    </div>
                  </div>
                  
                  <!-- 差异详情（展开时显示） -->
                  @if (conflict.isExpanded) {
                    <div class="p-4 space-y-3 bg-white">
                      <div class="text-xs font-medium text-stone-600 mb-2">任务差异对比</div>
                      
                      <!-- 响应式差异网格：移动端垂直堆叠，桌面端三列 -->
                      <div class="space-y-2 max-h-64 overflow-y-auto">
                        @for (diff of conflict.taskDiffs.slice(0, 10); track diff.id) {
                          <div class="diff-grid grid gap-2 p-2 rounded-lg text-[11px]"
                               [class.bg-green-50]="diff.status === 'same'"
                               [class.bg-amber-50]="diff.status === 'modified'"
                               [class.bg-indigo-50]="diff.status === 'local-only'"
                               [class.bg-teal-50]="diff.status === 'remote-only'">
                            <!-- 移动端：垂直堆叠布局 -->
                            <div class="md:hidden space-y-1">
                              <div class="font-medium text-stone-700 flex items-center gap-2">
                                <span class="px-1.5 py-0.5 rounded text-[9px]"
                                      [class.bg-green-200]="diff.status === 'same'"
                                      [class.text-green-700]="diff.status === 'same'"
                                      [class.bg-amber-200]="diff.status === 'modified'"
                                      [class.text-amber-700]="diff.status === 'modified'"
                                      [class.bg-indigo-200]="diff.status === 'local-only'"
                                      [class.text-indigo-700]="diff.status === 'local-only'"
                                      [class.bg-teal-200]="diff.status === 'remote-only'"
                                      [class.text-teal-700]="diff.status === 'remote-only'">
                                  {{ getStatusLabel(diff.status) }}
                                </span>
                                {{ diff.title }}
                              </div>
                              @if (diff.status === 'modified' && diff.localValue && diff.remoteValue) {
                                <div class="pl-2 border-l-2 border-indigo-300">
                                  <span class="text-indigo-600">本地:</span> {{ diff.localValue }}
                                </div>
                                <div class="pl-2 border-l-2 border-teal-300">
                                  <span class="text-teal-600">云端:</span> {{ diff.remoteValue }}
                                </div>
                              }
                            </div>
                            
                            <!-- 桌面端：三列网格布局 -->
                            <div class="hidden md:grid md:grid-cols-[1fr_1fr_1fr] md:gap-3 md:items-center">
                              <div class="font-medium text-stone-700 truncate">{{ diff.title }}</div>
                              <div class="text-indigo-600 truncate">
                                @if (diff.status === 'local-only' || diff.status === 'modified') {
                                  {{ diff.localValue || '(本地)' }}
                                } @else if (diff.status === 'remote-only') {
                                  <span class="text-stone-300">—</span>
                                } @else {
                                  <span class="text-green-600">✓ 一致</span>
                                }
                              </div>
                              <div class="text-teal-600 truncate">
                                @if (diff.status === 'remote-only' || diff.status === 'modified') {
                                  {{ diff.remoteValue || '(云端)' }}
                                } @else if (diff.status === 'local-only') {
                                  <span class="text-stone-300">—</span>
                                } @else {
                                  <span class="text-green-600">✓ 一致</span>
                                }
                              </div>
                            </div>
                          </div>
                        }
                        
                        @if (conflict.taskDiffs.length > 10) {
                          <div class="text-center text-[10px] text-stone-400 py-2">
                            还有 {{ conflict.taskDiffs.length - 10 }} 个任务差异未显示
                          </div>
                        }
                      </div>
                      
                      <!-- 差异统计 -->
                      <div class="flex flex-wrap gap-2 pt-2 border-t border-stone-100">
                        <span class="px-2 py-1 bg-green-100 text-green-700 rounded text-[10px]">
                          一致: {{ countByStatus(conflict.taskDiffs, 'same') }}
                        </span>
                        <span class="px-2 py-1 bg-amber-100 text-amber-700 rounded text-[10px]">
                          有修改: {{ countByStatus(conflict.taskDiffs, 'modified') }}
                        </span>
                        <span class="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-[10px]">
                          仅本地: {{ countByStatus(conflict.taskDiffs, 'local-only') }}
                        </span>
                        <span class="px-2 py-1 bg-teal-100 text-teal-700 rounded text-[10px]">
                          仅云端: {{ countByStatus(conflict.taskDiffs, 'remote-only') }}
                        </span>
                      </div>
                    </div>
                  }
                </div>
              }
              
              <!-- 提示信息 -->
              <div class="text-[10px] text-stone-400 p-2 bg-stone-50 rounded-lg">
                💡 <span class="font-medium">提示：</span>
                「使用本地」保留您在此设备的编辑；
                「使用云端」同步其他设备的内容；
                「保留两者」将云端版本作为新任务添加（标题加「(副本)」后缀）。
              </div>
            </div>
          }
          
          <!-- 同步错误 -->
          @if (syncError()) {
            <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div class="flex-1">
                  <h3 class="text-sm font-semibold text-red-800 mb-1">同步错误</h3>
                  <p class="text-xs text-red-700">{{ syncError() }}</p>
                </div>
              </div>
            </div>
          }
          
          <!-- 死信队列 -->
          @if (deadLetterCount() > 0) {
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-stone-700">失败的操作 ({{ deadLetterCount() }})</h3>
                <button 
                  (click)="toggleDeadLetters()"
                  class="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                  {{ showDeadLetters() ? '收起' : '展开' }}
                </button>
              </div>
              
              @if (showDeadLetters()) {
                <div class="space-y-2 max-h-64 overflow-y-auto">
                  @for (item of deadLetters(); track item.id) {
                    <div class="p-3 bg-red-50 border border-red-100 rounded-lg">
                      <div class="flex items-start justify-between gap-2 mb-2">
                        <div class="flex-1 min-w-0">
                          <div class="text-xs font-medium text-red-800 mb-1">
                            {{ getActionLabel(item.action) }}
                          </div>
                          <div class="text-[10px] text-red-600 break-all">
                            {{ item.error }}
                          </div>
                        </div>
                        <span class="text-[9px] text-red-400 whitespace-nowrap">
                          {{ formatDate(item.timestamp) }}
                        </span>
                      </div>
                      <div class="flex gap-2">
                        <button 
                          (click)="retryDeadLetter(item.id)"
                          class="flex-1 px-2 py-1 text-[10px] font-medium bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors">
                          重试
                        </button>
                        <button 
                          (click)="dismissDeadLetter(item.id)"
                          class="flex-1 px-2 py-1 text-[10px] font-medium bg-stone-100 hover:bg-stone-200 text-stone-600 rounded transition-colors">
                          忽略
                        </button>
                      </div>
                    </div>
                  }
                </div>
                <button 
                  (click)="clearAllDeadLetters()"
                  class="w-full px-3 py-2 text-xs font-medium bg-stone-100 hover:bg-stone-200 text-stone-600 rounded-lg transition-colors">
                  清空所有失败记录
                </button>
              }
            </div>
          }
          
          <!-- 离线模式提示 -->
          @if (!isOnline()) {
            <div class="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <div class="flex-1">
                  <h3 class="text-sm font-semibold text-blue-800 mb-1">离线模式</h3>
                  <p class="text-xs text-blue-700">
                    当前网络不可用，所有操作将保存在本地。网络恢复后将自动同步到云端。
                  </p>
                </div>
              </div>
            </div>
          }
          
          <!-- 快捷操作 -->
          <div class="pt-4 border-t border-stone-200">
            <h3 class="text-sm font-semibold text-stone-700 mb-3">快捷操作</h3>
            <div class="grid grid-cols-2 gap-3">
              <button 
                (click)="resyncProject()"
                [disabled]="isResyncing()"
                class="px-4 py-3 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                @if (isResyncing()) {
                  <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  同步中...
                } @else {
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  重新同步当前项目
                }
              </button>
              
              <button 
                (click)="close.emit()"
                class="px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                完成
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
export class DashboardModalComponent implements OnInit, OnDestroy {
  private actionQueue = inject(ActionQueueService);
  private syncService = inject(SimpleSyncService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private conflictResolution = inject(ConflictResolutionService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private toastService = inject(ToastService);
  
  @Output() close = new EventEmitter<void>();
  @Output() openConflictCenter = new EventEmitter<void>();
  
  /** 用户是否已登录 */
  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());
  
  // 本地状态
  showDeadLetters = signal(false);
  showConflictList = signal(false);
  isRetrying = signal(false);
  isResyncing = signal(false);
  
  /** 冲突展示项列表 */
  conflictItems = signal<ConflictItem[]>([]);
  
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
  
  // 计算属性 - 是否有需要关注的问题
  readonly hasIssues = computed(() => 
    this.deadLetterCount() > 0 || this.pendingCount() > 0 || !!this.syncError() || this.offlineMode() || this.conflictCount() > 0
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
   * 切换死信队列显示
   */
  toggleDeadLetters() {
    this.showDeadLetters.update((v: boolean) => !v);
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
      this.toastService.success('同步完成', '所有待处理操作已成功同步');
    } catch (error) {
      this.toastService.error('同步失败', '部分操作同步失败，请稍后重试');
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
    this.toastService.success('已清空', '所有失败记录已清空');
  }
  
  /**
   * 重新同步当前项目
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
    } catch (e) {
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
  
  // ========== 生命周期 ==========
  
  ngOnInit(): void {
    // 初始加载冲突数据
    this.loadConflicts();
  }
  
  ngOnDestroy(): void {
    // 清理资源（如果需要）
  }
  
  // ========== 冲突解决方法 ==========
  
  /**
   * 加载所有冲突数据
   */
  async loadConflicts(): Promise<void> {
    const conflicts = await this.conflictStorage.getAllConflicts();
    const items: ConflictItem[] = conflicts.map(conflict => this.mapConflictToItem(conflict));
    this.conflictItems.set(items);
    
    // 如果有冲突，自动展开列表
    if (items.length > 0) {
      this.showConflictList.set(true);
    }
  }
  
  /**
   * 将冲突记录映射为展示项
   */
  private mapConflictToItem(record: ConflictRecord): ConflictItem {
    const localTasks: Task[] = record.localProject?.tasks || [];
    const remoteTasks: Task[] = record.remoteProject?.tasks || [];
    
    return {
      projectId: record.projectId,
      projectName: record.localProject?.name || record.remoteProject?.name || '未知项目',
      reason: record.reason,
      reasonLabel: this.getReasonLabel(record.reason),
      conflictedAt: record.conflictedAt,
      localTaskCount: localTasks.length,
      remoteTaskCount: remoteTasks.length,
      taskDiffs: this.calculateTaskDiffs(localTasks, remoteTasks),
      isExpanded: false,
      isResolving: false
    };
  }
  
  /**
   * 计算任务差异
   */
  private calculateTaskDiffs(localTasks: Task[], remoteTasks: Task[]): TaskDiff[] {
    const localMap = new Map<string, Task>(localTasks.map(t => [t.id, t]));
    const remoteMap = new Map<string, Task>(remoteTasks.map(t => [t.id, t]));
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    
    const diffs: TaskDiff[] = [];
    
    allIds.forEach(id => {
      const localTask = localMap.get(id);
      const remoteTask = remoteMap.get(id);
      
      let status: TaskDiff['status'];
      let title: string;
      let localValue: string | undefined;
      let remoteValue: string | undefined;
      
      if (localTask && remoteTask) {
        const isSame = localTask.title === remoteTask.title && 
                       localTask.content === remoteTask.content &&
                       localTask.status === remoteTask.status;
        status = isSame ? 'same' : 'modified';
        title = localTask.title || remoteTask.title || '未命名';
        if (!isSame) {
          localValue = localTask.title !== remoteTask.title ? localTask.title : undefined;
          remoteValue = localTask.title !== remoteTask.title ? remoteTask.title : undefined;
        }
      } else if (localTask) {
        status = 'local-only';
        title = localTask.title || '未命名';
        localValue = localTask.title;
      } else {
        status = 'remote-only';
        title = remoteTask!.title || '未命名';
        remoteValue = remoteTask!.title;
      }
      
      diffs.push({ id, title, localValue, remoteValue, status });
    });
    
    // 按状态排序：modified > local-only > remote-only > same
    const order = { 'modified': 0, 'local-only': 1, 'remote-only': 2, 'same': 3 };
    return diffs.sort((a, b) => order[a.status] - order[b.status]);
  }
  
  /**
   * 获取冲突原因标签
   */
  private getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      'version_mismatch': '版本不匹配',
      'concurrent_edit': '并发编辑',
      'network_recovery': '网络恢复',
      'status_conflict': '状态冲突',
      'field_conflict': '字段冲突'
    };
    return labels[reason] || reason;
  }
  
  /**
   * 切换冲突项展开状态
   */
  toggleConflictExpand(projectId: string): void {
    this.conflictItems.update(items => 
      items.map(item => 
        item.projectId === projectId 
          ? { ...item, isExpanded: !item.isExpanded }
          : item
      )
    );
  }
  
  /**
   * 使用本地版本解决冲突
   */
  async resolveUseLocal(projectId: string): Promise<void> {
    await this.resolveConflictWithStrategy(projectId, 'local');
  }
  
  /**
   * 使用云端版本解决冲突
   */
  async resolveUseRemote(projectId: string): Promise<void> {
    await this.resolveConflictWithStrategy(projectId, 'remote');
  }
  
  /**
   * 保留两者（将云端版本作为副本添加）
   */
  async resolveKeepBoth(projectId: string): Promise<void> {
    this.setResolving(projectId, true);
    
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) {
        this.toastService.error('错误', '未找到冲突数据');
        return;
      }
      
      // 调用 keepBoth 策略
      const result = await this.conflictResolution.resolveKeepBoth(
        projectId,
        conflict.localProject,
        conflict.remoteProject
      );
      
      if (result.ok) {
        await this.conflictStorage.deleteConflict(projectId);
        this.toastService.success('已保留两者', '云端版本的任务已作为副本添加');
        await this.loadConflicts();
      } else {
        this.toastService.error('解决失败', result.error.message);
      }
    } catch (e) {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }
  
  /**
   * 通用冲突解决方法
   */
  private async resolveConflictWithStrategy(projectId: string, strategy: 'local' | 'remote'): Promise<void> {
    this.setResolving(projectId, true);
    
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) {
        this.toastService.error('错误', '未找到冲突数据');
        return;
      }
      
      const result = await this.conflictResolution.resolveConflict(
        projectId,
        strategy,
        conflict.localProject,
        conflict.remoteProject
      );
      
      if (result.ok) {
        await this.conflictStorage.deleteConflict(projectId);
        await this.loadConflicts();
      } else {
        this.toastService.error('解决失败', result.error.message);
      }
    } catch (e) {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }
  
  /**
   * 设置解决中状态
   */
  private setResolving(projectId: string, isResolving: boolean): void {
    this.conflictItems.update(items => 
      items.map(item => 
        item.projectId === projectId 
          ? { ...item, isResolving }
          : item
      )
    );
  }
  
  /**
   * 获取状态标签
   */
  getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      'same': '一致',
      'modified': '有修改',
      'local-only': '仅本地',
      'remote-only': '仅云端'
    };
    return labels[status] || status;
  }
  
  /**
   * 按状态统计差异数量
   */
  countByStatus(diffs: TaskDiff[], status: TaskDiff['status']): number {
    return diffs.filter(d => d.status === status).length;
  }
  
  /**
   * 格式化相对时间
   */
  formatRelativeTime(isoString: string): string {
    return this.formatDate(isoString);
  }
}
