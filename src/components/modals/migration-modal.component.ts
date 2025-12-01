import { Component, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MigrationService, MigrationStrategy } from '../../services/migration.service';
import { AuthService } from '../../services/auth.service';

/**
 * 数据迁移对话框组件
 * 
 * 当访客用户登录后，如果检测到本地有未同步的数据，
 * 显示此对话框让用户选择如何处理数据迁移
 */
@Component({
  selector: 'app-migration-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in" 
         (click)="close.emit()">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-scale-in" 
           (click)="$event.stopPropagation()">
        <!-- 标题 -->
        <div class="px-6 py-4 border-b border-stone-100 bg-gradient-to-r from-indigo-50 to-white">
          <h2 class="text-lg font-bold text-stone-800 flex items-center gap-2">
            <svg class="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
            发现本地数据
          </h2>
          <p class="text-xs text-stone-500 mt-1">
            检测到您在登录前创建的项目数据，请选择处理方式
          </p>
        </div>
        
        <!-- 数据摘要 -->
        <div class="px-6 py-4 bg-stone-50 border-b border-stone-100">
          <div class="grid grid-cols-2 gap-4 text-center">
            <div class="p-3 bg-white rounded-lg border border-stone-200">
              <div class="text-2xl font-bold text-amber-600">{{ summary().localCount }}</div>
              <div class="text-xs text-stone-500">本地项目</div>
            </div>
            <div class="p-3 bg-white rounded-lg border border-stone-200">
              <div class="text-2xl font-bold text-indigo-600">{{ summary().remoteCount }}</div>
              <div class="text-xs text-stone-500">云端项目</div>
            </div>
          </div>
          @if (summary().localOnlyCount > 0 || summary().conflictCount > 0) {
            <div class="mt-3 text-xs text-stone-600 space-y-1">
              @if (summary().localOnlyCount > 0) {
                <p>• {{ summary().localOnlyCount }} 个项目仅存在于本地</p>
              }
              @if (summary().conflictCount > 0) {
                <p>• {{ summary().conflictCount }} 个项目可能存在冲突</p>
              }
            </div>
          }
        </div>
        
        <!-- 迁移选项 -->
        <div class="px-6 py-4 space-y-3">
          <!-- 上传本地数据 -->
          <button 
            (click)="selectStrategy('keep-local')"
            [disabled]="isProcessing()"
            class="w-full p-4 rounded-xl border-2 text-left transition-all hover:border-indigo-300 hover:bg-indigo-50"
            [class.border-indigo-500]="selectedStrategy === 'keep-local'"
            [class.bg-indigo-50]="selectedStrategy === 'keep-local'"
            [class.border-stone-200]="selectedStrategy !== 'keep-local'">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-stone-800">上传本地数据</div>
                <div class="text-xs text-stone-500 mt-0.5">
                  将本地项目上传到云端，保留您的所有工作
                </div>
              </div>
            </div>
          </button>
          
          <!-- 智能合并 -->
          <button 
            (click)="selectStrategy('merge')"
            [disabled]="isProcessing()"
            class="w-full p-4 rounded-xl border-2 text-left transition-all hover:border-emerald-300 hover:bg-emerald-50"
            [class.border-emerald-500]="selectedStrategy === 'merge'"
            [class.bg-emerald-50]="selectedStrategy === 'merge'"
            [class.border-stone-200]="selectedStrategy !== 'merge'">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-stone-800">智能合并</div>
                <div class="text-xs text-stone-500 mt-0.5">
                  合并本地和云端数据，保留双方的所有内容
                </div>
              </div>
            </div>
          </button>
          
          <!-- 使用云端数据 -->
          <button 
            (click)="selectStrategy('keep-remote')"
            [disabled]="isProcessing()"
            class="w-full p-4 rounded-xl border-2 text-left transition-all hover:border-amber-300 hover:bg-amber-50"
            [class.border-amber-500]="selectedStrategy === 'keep-remote'"
            [class.bg-amber-50]="selectedStrategy === 'keep-remote'"
            [class.border-stone-200]="selectedStrategy !== 'keep-remote'">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-stone-800">使用云端数据</div>
                <div class="text-xs text-stone-500 mt-0.5">
                  丢弃本地数据，仅使用云端已有的项目
                </div>
              </div>
            </div>
          </button>
          
          <!-- 丢弃本地 -->
          <button 
            (click)="selectStrategy('discard-local')"
            [disabled]="isProcessing()"
            class="w-full p-3 rounded-lg border text-left transition-all text-stone-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50"
            [class.border-red-300]="selectedStrategy === 'discard-local'"
            [class.text-red-500]="selectedStrategy === 'discard-local'"
            [class.bg-red-50]="selectedStrategy === 'discard-local'"
            [class.border-stone-200]="selectedStrategy !== 'discard-local'">
            <div class="flex items-center gap-2 text-xs">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              彻底丢弃本地数据（不可恢复）
            </div>
          </button>
        </div>
        
        <!-- 操作按钮 -->
        <div class="px-6 py-4 border-t border-stone-100 bg-stone-50 flex justify-end gap-3">
          <button 
            (click)="close.emit()"
            [disabled]="isProcessing()"
            class="px-4 py-2 text-sm text-stone-600 hover:text-stone-800 hover:bg-stone-100 rounded-lg transition-colors disabled:opacity-50">
            稍后处理
          </button>
          <button 
            (click)="executeMigration()"
            [disabled]="!selectedStrategy || isProcessing()"
            class="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            @if (isProcessing()) {
              <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 11-6.219-8.56"/>
              </svg>
              处理中...
            } @else {
              确认迁移
            }
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scale-in {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    .animate-fade-in { animation: fade-in 0.2s ease-out; }
    .animate-scale-in { animation: scale-in 0.2s ease-out; }
  `]
})
export class MigrationModalComponent {
  private migrationService = inject(MigrationService);
  private authService = inject(AuthService);
  
  close = output<void>();
  migrated = output<void>();
  
  selectedStrategy: MigrationStrategy | null = null;
  isProcessing = this.migrationService.showMigrationDialog; // 复用loading状态
  
  readonly summary = this.migrationService.getMigrationSummary.bind(this.migrationService);
  
  selectStrategy(strategy: MigrationStrategy) {
    this.selectedStrategy = strategy;
  }
  
  async executeMigration() {
    if (!this.selectedStrategy) return;
    
    // 从 AuthService 获取当前用户 ID（安全的方式）
    const userId = this.authService.currentUserId();
    if (!userId) {
      console.error('无法获取用户ID：用户未登录');
      return;
    }
    
    const result = await this.migrationService.executeMigration(this.selectedStrategy, userId);
    
    if (result.success) {
      this.migrated.emit();
      this.close.emit();
    }
  }
}
