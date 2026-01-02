import { Component, inject, Output, EventEmitter, input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService, ImportOptions, ImportPreview } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeType, Project } from '../../../models';
import { LOCAL_BACKUP_CONFIG } from '../../../config/local-backup.config';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 animate-scale-in max-h-[90vh] overflow-y-auto" (click)="$event.stopPropagation()">
        <h2 class="text-xl font-bold mb-5 text-slate-800">设置</h2>
        
        <div class="space-y-5">
          <!-- 系统仪表盘入口 -->
          <div class="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer" (click)="openDashboard.emit()">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                  <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-semibold text-indigo-900">系统仪表盘</div>
                  <div class="text-xs text-indigo-600">监控同步状态与数据冲突</div>
                </div>
              </div>
              <svg class="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
          
          <!-- 主题设置 -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-4">
            <div>
              <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide mb-1">外观</div>
              <div class="text-sm font-semibold text-stone-800">主题风格</div>
            </div>
            
            <div class="grid grid-cols-5 gap-2">
              <!-- 默认主题 -->
              <button (click)="updateTheme('default')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-indigo-500]="preferenceService.theme() === 'default'"
                      [class.bg-indigo-50]="preferenceService.theme() === 'default'"
                      [class.border-stone-200]="preferenceService.theme() !== 'default'"
                      [class.hover:border-stone-300]="preferenceService.theme() !== 'default'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-stone-100 to-stone-300 border border-stone-300"></div>
                <span class="text-[10px] text-stone-600">默认</span>
              </button>
              
              <!-- 海洋主题 -->
              <button (click)="updateTheme('ocean')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-sky-500]="preferenceService.theme() === 'ocean'"
                      [class.bg-sky-50]="preferenceService.theme() === 'ocean'"
                      [class.border-stone-200]="preferenceService.theme() !== 'ocean'"
                      [class.hover:border-stone-300]="preferenceService.theme() !== 'ocean'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-sky-200 to-cyan-400 border border-sky-300"></div>
                <span class="text-[10px] text-stone-600">海洋</span>
              </button>
              
              <!-- 森林主题 -->
              <button (click)="updateTheme('forest')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-green-500]="preferenceService.theme() === 'forest'"
                      [class.bg-green-50]="preferenceService.theme() === 'forest'"
                      [class.border-stone-200]="preferenceService.theme() !== 'forest'"
                      [class.hover:border-stone-300]="preferenceService.theme() !== 'forest'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-green-200 to-emerald-400 border border-green-300"></div>
                <span class="text-[10px] text-stone-600">森林</span>
              </button>
              
              <!-- 日落主题 -->
              <button (click)="updateTheme('sunset')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-orange-500]="preferenceService.theme() === 'sunset'"
                      [class.bg-orange-50]="preferenceService.theme() === 'sunset'"
                      [class.border-stone-200]="preferenceService.theme() !== 'sunset'"
                      [class.hover:border-stone-300]="preferenceService.theme() !== 'sunset'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-orange-200 to-red-400 border border-orange-300"></div>
                <span class="text-[10px] text-stone-600">日落</span>
              </button>
              
              <!-- 薰衣草主题 -->
              <button (click)="updateTheme('lavender')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-purple-500]="preferenceService.theme() === 'lavender'"
                      [class.bg-purple-50]="preferenceService.theme() === 'lavender'"
                      [class.border-stone-200]="preferenceService.theme() !== 'lavender'"
                      [class.hover:border-stone-300]="preferenceService.theme() !== 'lavender'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-purple-200 to-fuchsia-400 border border-purple-300"></div>
                <span class="text-[10px] text-stone-600">薰衣草</span>
              </button>
            </div>
          </div>
          
          <!-- 同步设置 -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-4">
            <div>
              <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide mb-1">同步</div>
              <div class="text-sm font-semibold text-stone-800">冲突处理</div>
            </div>
            
            <!-- 自动解决冲突开关 -->
            <div class="flex items-center justify-between gap-4">
              <div class="flex-1">
                <div class="text-sm text-stone-700">自动解决冲突</div>
                <div class="text-[11px] text-stone-500 mt-0.5">
                  开启后使用「最后写入优先」策略自动解决冲突；关闭后所有冲突将进入仪表盘由您手动处理
                </div>
              </div>
              <button 
                type="button"
                (click)="toggleAutoResolve()"
                class="relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                [class.bg-indigo-500]="preferenceService.autoResolveConflicts()"
                [class.bg-stone-300]="!preferenceService.autoResolveConflicts()">
                <span 
                  class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200"
                  [class.translate-x-5]="preferenceService.autoResolveConflicts()">
                </span>
              </button>
            </div>
            
            <div class="text-[10px] text-stone-400 p-2 bg-stone-100 rounded-lg">
              💡 个人应用中冲突较少，建议保持开启以获得更流畅的体验
            </div>
          </div>
          
          <!-- 数据管理 -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-4">
            <div>
              <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide mb-1">备份</div>
              <div class="text-sm font-semibold text-stone-800">数据管理</div>
            </div>
            
            <!-- 导出按钮 -->
            <div class="space-y-3">
              <button 
                type="button"
                (click)="handleExport()"
                [disabled]="exportService.isExporting()"
                class="w-full flex items-center gap-3 p-3 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <div class="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center">
                  <svg class="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </div>
                <div class="flex-1 text-left">
                  <div class="text-sm font-medium text-stone-800">
                    @if (exportService.isExporting()) {
                      导出中...
                    } @else {
                      导出数据
                    }
                  </div>
                  <div class="text-[11px] text-stone-500">导出所有项目到 JSON 文件</div>
                </div>
                @if (exportService.isExporting()) {
                  <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                }
              </button>
              
              <!-- 导入按钮 -->
              <button 
                type="button"
                (click)="triggerImportFileSelect()"
                [disabled]="importService.isImporting()"
                class="w-full flex items-center gap-3 p-3 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <div class="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center">
                  <svg class="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </div>
                <div class="flex-1 text-left">
                  <div class="text-sm font-medium text-stone-800">
                    @if (importService.isImporting()) {
                      导入中... {{ importService.progress().percentage | number:'1.0-0' }}%
                    } @else {
                      导入数据
                    }
                  </div>
                  <div class="text-[11px] text-stone-500">从备份文件恢复</div>
                </div>
                @if (importService.isImporting()) {
                  <div class="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                }
              </button>
              
              <!-- 隐藏的文件输入 -->
              <input 
                #fileInput
                type="file" 
                accept=".json,application/json"
                class="hidden"
                (change)="handleFileSelected($event)" />
            </div>
            
            <!-- 上次导出时间 -->
            @if (exportService.lastExportTime()) {
              <div class="text-[11px] text-stone-500 pt-1">
                上次导出：{{ exportService.lastExportTime() | date:'yyyy-MM-dd HH:mm' }}
              </div>
            }
            
            <!-- 导出提醒开关 -->
            <div class="flex items-center justify-between gap-4 pt-2 border-t border-stone-200">
              <div class="flex-1">
                <div class="text-sm text-stone-700">定期备份提醒</div>
                <div class="text-[11px] text-stone-500">每 7 天提醒导出数据</div>
              </div>
              <button 
                type="button"
                (click)="toggleExportReminder()"
                class="relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                [class.bg-blue-500]="exportReminderEnabled()"
                [class.bg-stone-300]="!exportReminderEnabled()">
                <span 
                  class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200"
                  [class.translate-x-5]="exportReminderEnabled()">
                </span>
              </button>
            </div>
          </div>
          
          <!-- 本地自动备份（坚果云等） -->
          @if (localBackupService.isAvailable()) {
            <div class="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-4 shadow-sm space-y-4">
              <div>
                <div class="text-[11px] font-semibold text-amber-600 uppercase tracking-wide mb-1">增强</div>
                <div class="text-sm font-semibold text-amber-900">本地自动备份</div>
                <div class="text-[11px] text-amber-700 mt-1">
                  将数据备份到本地目录，配合坚果云/Dropbox 等同步盘使用
                </div>
              </div>
              
              @if (!localBackupService.isAuthorized()) {
                <!-- 未授权状态 -->
                <button 
                  type="button"
                  (click)="handleSetupLocalBackup()"
                  class="w-full flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 transition-colors">
                  <div class="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center">
                    <svg class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  </div>
                  <div class="flex-1 text-left">
                    <div class="text-sm font-medium text-amber-900">选择备份目录</div>
                    <div class="text-[11px] text-amber-700">推荐选择坚果云同步文件夹</div>
                  </div>
                </button>
              } @else {
                <!-- 已授权状态 -->
                <div class="space-y-3">
                  <!-- 目录信息 -->
                  <div class="flex items-center gap-3 p-3 rounded-lg bg-white/70 border border-amber-100">
                    <div class="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                      <svg class="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-amber-900 truncate">{{ localBackupService.directoryName() }}</div>
                      @if (formattedLastBackupTime()) {
                        <div class="text-[11px] text-amber-700">上次备份：{{ formattedLastBackupTime() }}</div>
                      }
                    </div>
                    <button 
                      type="button"
                      (click)="handleRevokeLocalBackup()"
                      class="text-[11px] text-amber-600 hover:text-amber-800 underline">
                      取消
                    </button>
                  </div>
                  
                  <!-- 立即备份按钮 -->
                  <button 
                    type="button"
                    (click)="handleManualBackup()"
                    [disabled]="localBackupService.isBackingUp()"
                    class="w-full flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 transition-colors disabled:opacity-50">
                    <div class="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center">
                      @if (localBackupService.isBackingUp()) {
                        <div class="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                      } @else {
                        <svg class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                      }
                    </div>
                    <div class="flex-1 text-left">
                      <div class="text-sm font-medium text-amber-900">
                        @if (localBackupService.isBackingUp()) { 备份中... } @else { 立即备份 }
                      </div>
                    </div>
                  </button>
                  
                  <!-- 自动备份开关 -->
                  <div class="flex items-center justify-between gap-4 pt-2 border-t border-amber-200">
                    <div class="flex-1">
                      <div class="text-sm text-amber-900">自动定时备份</div>
                      <div class="text-[11px] text-amber-700">间隔 {{ selectedBackupInterval }}</div>
                    </div>
                    <button 
                      type="button"
                      (click)="toggleAutoBackup()"
                      class="relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2"
                      [class.bg-amber-500]="localBackupService.autoBackupEnabled()"
                      [class.bg-stone-300]="!localBackupService.autoBackupEnabled()">
                      <span 
                        class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200"
                        [class.translate-x-5]="localBackupService.autoBackupEnabled()">
                      </span>
                    </button>
                  </div>
                </div>
              }
              
              <div class="text-[10px] text-amber-700 p-2 bg-amber-100/50 rounded-lg">
                💡 浏览器重启后需重新授权目录访问权限
              </div>
            </div>
          }
          
          <!-- 账户信息 (只读显示) -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide">账户</div>
                <div class="text-sm font-semibold text-stone-800">同步状态</div>
              </div>
              <span class="px-2.5 py-1 text-[11px] rounded-full border"
                    [class.bg-emerald-50]="userSession.currentUserId()"
                    [class.border-emerald-100]="userSession.currentUserId()"
                    [class.text-emerald-700]="userSession.currentUserId()"
                    [class.bg-amber-50]="!userSession.currentUserId()"
                    [class.border-amber-100]="!userSession.currentUserId()"
                    [class.text-amber-700]="!userSession.currentUserId()">
                @if (userSession.currentUserId()) { 已登录 } @else { 未登录 }
              </span>
            </div>

            <div class="text-xs text-stone-500">
              @if (userSession.currentUserId()) {
                当前账号：{{ sessionEmail() || "Supabase 用户" }}
              } @else {
                点击侧边栏底部的"登录同步"按钮进行登录。
              }
            </div>

            @if (userSession.currentUserId()) {
              <div class="flex flex-wrap gap-2 pt-1">
                <button type="button" (click)="signOut.emit()" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 transition">退出登录</button>
              </div>
            }
          </div>
        </div>
        
        <div class="mt-6 flex justify-end">
          <button (click)="close.emit()" class="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors text-sm font-medium">关闭</button>
        </div>
      </div>
    </div>
  `
})
export class SettingsModalComponent {
  readonly userSession = inject(UserSessionService);
  readonly preferenceService = inject(PreferenceService);
  readonly exportService = inject(ExportService);
  readonly importService = inject(ImportService);
  readonly attachmentExportService = inject(AttachmentExportService);
  readonly localBackupService = inject(LocalBackupService);
  
  /** 当前登录用户邮箱 */
  sessionEmail = input<string | null>(null);
  
  /** 所有项目（用于导出） */
  projects = input<Project[]>([]);
  
  @Output() close = new EventEmitter<void>();
  @Output() signOut = new EventEmitter<void>();
  @Output() themeChange = new EventEmitter<ThemeType>();
  @Output() openDashboard = new EventEmitter<void>();
  @Output() importComplete = new EventEmitter<Project>();
  
  /** 导出提醒开关状态 */
  exportReminderEnabled = signal(true);
  
  /** 本地备份间隔选项 */
  readonly backupIntervalOptions = [
    { label: '15 分钟', value: 15 * 60 * 1000 },
    { label: '30 分钟', value: 30 * 60 * 1000 },
    { label: '1 小时', value: 60 * 60 * 1000 },
    { label: '2 小时', value: 2 * 60 * 60 * 1000 },
  ];
  
  /** 当前选择的备份间隔 */
  readonly selectedBackupInterval = computed(() => {
    const currentInterval = this.localBackupService.autoBackupIntervalMs();
    return this.backupIntervalOptions.find(opt => opt.value === currentInterval)?.label || '30 分钟';
  });
  
  /** 格式化上次备份时间 */
  readonly formattedLastBackupTime = computed(() => {
    const time = this.localBackupService.lastBackupTime();
    if (!time) return null;
    const date = new Date(time);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  });
  
  /** 文件输入引用 */
  private fileInput: HTMLInputElement | null = null;
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
  
  toggleAutoResolve() {
    const current = this.preferenceService.autoResolveConflicts();
    this.preferenceService.setAutoResolveConflicts(!current);
  }
  
  toggleExportReminder() {
    this.exportReminderEnabled.update(v => !v);
  }
  
  /**
   * 处理导出
   */
  async handleExport(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      return;
    }
    
    await this.exportService.exportAndDownload(projectList);
  }
  
  /**
   * 触发文件选择
   */
  triggerImportFileSelect(): void {
    // 查找隐藏的文件输入
    const input = document.querySelector('input[type="file"][accept*=".json"]') as HTMLInputElement;
    if (input) {
      input.click();
    }
  }
  
  /**
   * 处理文件选择
   */
  async handleFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    
    if (!file) return;
    
    // 清空 input 以便可以再次选择同一文件
    input.value = '';
    
    // 验证文件
    const validation = await this.importService.validateFile(file);
    if (!validation.valid || !validation.data) {
      alert(`导入失败：${validation.error}`);
      return;
    }
    
    // 生成预览
    const preview = await this.importService.generatePreview(
      validation.data,
      this.projects()
    );
    
    // 如果有冲突，询问用户
    let conflictStrategy: ImportOptions['conflictStrategy'] = 'skip';
    if (preview.conflicts.length > 0) {
      const choice = confirm(
        `发现 ${preview.conflicts.length} 个冲突项目。\n` +
        `点击"确定"跳过冲突项目，点击"取消"覆盖现有项目。`
      );
      conflictStrategy = choice ? 'skip' : 'overwrite';
    }
    
    // 执行导入
    const result = await this.importService.executeImport(
      validation.data,
      this.projects(),
      { conflictStrategy },
      async (project) => {
        this.importComplete.emit(project);
      }
    );
    
    if (result.success) {
      alert(`导入完成！\n成功: ${result.importedCount}\n跳过: ${result.skippedCount}`);
    } else {
      alert(`导入失败：${result.error}`);
    }
  }
  
  // ============================================
  // 本地备份方法
  // ============================================
  
  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupService.requestDirectoryAccess();
  }
  
  /**
   * 取消本地备份授权
   */
  handleRevokeLocalBackup(): void {
    if (confirm('确定要取消本地备份吗？')) {
      this.localBackupService.revokeDirectoryAccess();
    }
  }
  
  /**
   * 手动执行本地备份
   */
  async handleManualBackup(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      alert('没有可备份的项目');
      return;
    }
    
    const result = await this.localBackupService.performBackup(projectList);
    
    if (result.success) {
      alert(`备份成功！\n文件：${result.filename}\n位置：${result.pathHint}`);
    } else {
      alert(`备份失败：${result.error}`);
    }
  }
  
  /**
   * 切换自动备份
   */
  toggleAutoBackup(): void {
    if (this.localBackupService.autoBackupEnabled()) {
      this.localBackupService.stopAutoBackup();
    } else {
      this.localBackupService.startAutoBackup(
        () => this.projects(),
        LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS
      );
    }
  }
}
