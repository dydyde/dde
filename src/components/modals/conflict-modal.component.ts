import { Component, signal, Output, EventEmitter, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Project, Task } from '../../models';

/**
 * 冲突解决模态框组件
 * 提供本地/远程版本选择及智能合并功能
 * 包含任务级别的差异对比视图
 */
@Component({
  selector: 'app-conflict-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-6 animate-scale-in max-h-[90vh] overflow-y-auto" (click)="$event.stopPropagation()">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-semibold text-stone-800">数据冲突</h3>
            <p class="text-xs text-stone-500">本地和云端数据存在差异，请选择解决方案</p>
          </div>
        </div>
        
        <!-- 差异概览 -->
        <div class="mb-4 p-3 bg-stone-50 rounded-lg border border-stone-200">
          <div class="text-xs font-medium text-stone-600 mb-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            差异概览
          </div>
          <div class="grid grid-cols-3 gap-2 text-[10px]">
            <div class="p-2 bg-white rounded border border-stone-100">
              <div class="text-stone-400 mb-0.5">项目名称</div>
              <div class="font-medium text-stone-700">{{ conflictData()?.localProject?.name || conflictData()?.remoteProject?.name }}</div>
            </div>
            <div class="p-2 bg-white rounded border border-stone-100">
              <div class="text-stone-400 mb-0.5">本地任务数</div>
              <div class="font-medium text-indigo-600">{{ conflictData()?.localProject?.tasks?.length || 0 }}</div>
            </div>
            <div class="p-2 bg-white rounded border border-stone-100">
              <div class="text-stone-400 mb-0.5">云端任务数</div>
              <div class="font-medium text-teal-600">{{ conflictData()?.remoteProject?.tasks?.length || 0 }}</div>
            </div>
          </div>
        </div>
        
        <!-- 详细差异对比 -->
        @if (showDetailedDiff()) {
          <div class="mb-4 border border-stone-200 rounded-lg overflow-hidden">
            <div class="px-3 py-2 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
              <span class="text-xs font-medium text-stone-700">任务级别差异对比</span>
              <button (click)="showDetailedDiff.set(false)" class="text-xs text-stone-500 hover:text-stone-700">收起</button>
            </div>
            <div class="max-h-48 overflow-y-auto">
              <table class="w-full text-[10px]">
                <thead class="bg-stone-50 sticky top-0">
                  <tr>
                    <th class="px-2 py-1.5 text-left text-stone-500 font-medium">任务</th>
                    <th class="px-2 py-1.5 text-center text-indigo-500 font-medium">本地</th>
                    <th class="px-2 py-1.5 text-center text-teal-500 font-medium">云端</th>
                    <th class="px-2 py-1.5 text-left text-stone-500 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-stone-100">
                  @for (diff of taskDiffs(); track diff.id) {
                    <tr class="hover:bg-stone-50">
                      <td class="px-2 py-1.5 font-medium text-stone-700 truncate max-w-[150px]">{{ diff.title }}</td>
                      <td class="px-2 py-1.5 text-center">
                        @if (diff.inLocal) {
                          <span class="inline-block w-2 h-2 rounded-full bg-indigo-400"></span>
                        } @else {
                          <span class="inline-block w-2 h-2 rounded-full bg-stone-200"></span>
                        }
                      </td>
                      <td class="px-2 py-1.5 text-center">
                        @if (diff.inRemote) {
                          <span class="inline-block w-2 h-2 rounded-full bg-teal-400"></span>
                        } @else {
                          <span class="inline-block w-2 h-2 rounded-full bg-stone-200"></span>
                        }
                      </td>
                      <td class="px-2 py-1.5">
                        <span class="px-1.5 py-0.5 rounded text-[9px]"
                              [class.bg-green-100]="diff.status === 'same'"
                              [class.text-green-700]="diff.status === 'same'"
                              [class.bg-amber-100]="diff.status === 'modified'"
                              [class.text-amber-700]="diff.status === 'modified'"
                              [class.bg-indigo-100]="diff.status === 'local-only'"
                              [class.text-indigo-700]="diff.status === 'local-only'"
                              [class.bg-teal-100]="diff.status === 'remote-only'"
                              [class.text-teal-700]="diff.status === 'remote-only'">
                          {{ getStatusLabel(diff.status) }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        } @else {
          <button 
            (click)="showDetailedDiff.set(true)"
            class="mb-4 w-full px-3 py-2 text-xs text-stone-600 bg-stone-50 hover:bg-stone-100 rounded-lg border border-stone-200 transition-colors flex items-center justify-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            查看详细差异
          </button>
        }
        
        <div class="grid grid-cols-2 gap-3 mb-4">
          <!-- 本地版本 -->
          <div class="p-3 rounded-lg border-2 border-stone-200 hover:border-indigo-400 transition-colors cursor-pointer group"
               (click)="resolveLocal.emit()">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-4 h-4 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="16" rx="2"/>
                <path d="M7 8h10M7 12h6"/>
              </svg>
              <span class="text-sm font-medium text-stone-700 group-hover:text-indigo-700">本地版本</span>
            </div>
            <div class="text-xs text-stone-500 space-y-1">
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                任务数：<span class="font-medium text-indigo-600">{{ conflictData()?.localProject?.tasks?.length || 0 }}</span>
              </p>
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-stone-300"></span>
                修改：{{ conflictData()?.localProject?.updatedAt | date:'yyyy-MM-dd HH:mm' }}
              </p>
            </div>
            <div class="mt-2 text-[10px] text-indigo-600 bg-indigo-50 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
              点击选择本地版本
            </div>
          </div>
          
          <!-- 云端版本 -->
          <div class="p-3 rounded-lg border-2 border-stone-200 hover:border-teal-400 transition-colors cursor-pointer group"
               (click)="resolveRemote.emit()">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
              </svg>
              <span class="text-sm font-medium text-stone-700 group-hover:text-teal-700">云端版本</span>
            </div>
            <div class="text-xs text-stone-500 space-y-1">
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-teal-400"></span>
                任务数：<span class="font-medium text-teal-600">{{ conflictData()?.remoteProject?.tasks?.length || 0 }}</span>
              </p>
              <p class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-stone-300"></span>
                修改：{{ conflictData()?.remoteProject?.updatedAt | date:'yyyy-MM-dd HH:mm' }}
              </p>
            </div>
            <div class="mt-2 text-[10px] text-teal-600 bg-teal-50 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
              点击选择云端版本
            </div>
          </div>
        </div>
        
        <!-- 智能合并选项 -->
        <div class="mb-4 p-3 bg-gradient-to-r from-violet-50 to-indigo-50 rounded-lg border border-violet-200">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 text-violet-500 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
            <div class="flex-1">
              <div class="text-xs font-medium text-violet-700 mb-1">智能合并（推荐）</div>
              <p class="text-[10px] text-violet-600 mb-2">保留双方的新增内容，合并修改。如果同一任务在双方都有修改，将优先使用较新的版本。</p>
              <button 
                (click)="resolveMerge.emit()"
                class="px-3 py-1.5 bg-violet-500 text-white text-xs font-medium rounded-lg hover:bg-violet-600 transition-colors flex items-center gap-1.5">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>
                </svg>
                执行智能合并
              </button>
            </div>
          </div>
        </div>
        
        <div class="text-xs text-stone-400 mb-4 p-2 bg-stone-50 rounded-lg">
          💡 <span class="font-medium">提示：</span>选择「本地版本」将覆盖云端数据；选择「云端版本」将丢弃本地未同步的更改；「智能合并」会尝试保留双方的修改。
        </div>
        
        <div class="flex justify-between items-center">
          <button 
            (click)="cancel.emit()"
            class="px-3 py-1.5 text-stone-500 hover:text-stone-700 text-xs transition-colors">
            稍后解决
          </button>
          <div class="flex gap-2">
            <button (click)="resolveRemote.emit()" class="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm font-medium border border-stone-200">
              使用云端
            </button>
            <button (click)="resolveLocal.emit()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium">
              使用本地
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class ConflictModalComponent {
  /** 冲突数据（本地和远程项目信息） */
  conflictData = input<{
    localProject: Project;
    remoteProject: Project;
    projectId: string;
  } | null>(null);
  
  @Output() resolveLocal = new EventEmitter<void>();
  @Output() resolveRemote = new EventEmitter<void>();
  @Output() resolveMerge = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
  
  showDetailedDiff = signal(false);
  
  /** 计算任务级别的差异 */
  taskDiffs = computed(() => {
    const data = this.conflictData();
    if (!data) return [];
    
    const localTasks: Task[] = data.localProject?.tasks || [];
    const remoteTasks: Task[] = data.remoteProject?.tasks || [];
    
    const localMap = new Map<string, Task>(localTasks.map((t: Task) => [t.id, t]));
    const remoteMap = new Map<string, Task>(remoteTasks.map((t: Task) => [t.id, t]));
    
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    const diffs: Array<{
      id: string;
      title: string;
      inLocal: boolean;
      inRemote: boolean;
      status: 'same' | 'modified' | 'local-only' | 'remote-only';
    }> = [];
    
    allIds.forEach(id => {
      const localTask = localMap.get(id);
      const remoteTask = remoteMap.get(id);
      
      let status: 'same' | 'modified' | 'local-only' | 'remote-only';
      let title: string;
      
      if (localTask && remoteTask) {
        // 两边都有
        const isSame = localTask.title === remoteTask.title && 
                       localTask.content === remoteTask.content &&
                       localTask.status === remoteTask.status;
        status = isSame ? 'same' : 'modified';
        title = localTask.title || remoteTask.title || '未命名';
      } else if (localTask) {
        status = 'local-only';
        title = localTask.title || '未命名';
      } else {
        status = 'remote-only';
        title = remoteTask!.title || '未命名';
      }
      
      diffs.push({
        id,
        title,
        inLocal: !!localTask,
        inRemote: !!remoteTask,
        status
      });
    });
    
    // 按状态排序：modified > local-only > remote-only > same
    const order = { 'modified': 0, 'local-only': 1, 'remote-only': 2, 'same': 3 };
    return diffs.sort((a, b) => order[a.status] - order[b.status]);
  });
  
  getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      'same': '一致',
      'modified': '有修改',
      'local-only': '仅本地',
      'remote-only': '仅云端'
    };
    return labels[status] || status;
  }
}
