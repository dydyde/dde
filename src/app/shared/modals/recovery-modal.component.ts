/**
 * 备份恢复模态框组件
 * 
 * 功能：
 * 1. 显示可用的恢复点列表
 * 2. 预览恢复内容
 * 3. 执行恢复操作
 * 
 * 位置: src/app/shared/modals/recovery-modal.component.ts
 */

import { Component, inject, signal, computed, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { 
  RecoveryService, 
  RecoveryPoint, 
  RecoveryPreview,
  RecoveryOptions,
} from '../../../services/recovery.service';

@Component({
  selector: 'app-recovery-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="recovery-modal">
      <!-- 标题栏 -->
      <div class="modal-header">
        <h2 class="modal-title">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          数据恢复
        </h2>
        <button class="close-btn" (click)="close()" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- 内容区 -->
      <div class="modal-content">
        <!-- 加载状态 -->
        @if (recovery.isLoading()) {
          <div class="loading-state">
            <div class="spinner"></div>
            <p>
              @switch (recovery.status()) {
                @case ('loading') { 正在加载恢复点... }
                @case ('previewing') { 正在预览备份内容... }
                @case ('restoring') { 正在恢复数据，请勿关闭页面... }
              }
            </p>
          </div>
        } @else if (recovery.error()) {
          <!-- 错误状态 -->
          <div class="error-state">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M15 9l-6 6M9 9l6 6"/>
            </svg>
            <p>{{ recovery.error() }}</p>
            <button class="btn btn-primary" (click)="loadRecoveryPoints()">重试</button>
          </div>
        } @else if (currentView() === 'list') {
          <!-- 恢复点列表 -->
          <div class="recovery-list">
            @if (recovery.recoveryPoints().length === 0) {
              <div class="empty-state">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20 7h-9M14 17H5"/>
                  <circle cx="17" cy="17" r="3"/>
                  <circle cx="7" cy="7" r="3"/>
                </svg>
                <p>暂无可用的恢复点</p>
                <span class="hint">系统会自动创建每日备份</span>
              </div>
            } @else {
              <div class="list-header">
                <span class="count">共 {{ recovery.recoveryPoints().length }} 个恢复点</span>
              </div>
              <div class="list-container">
                @for (point of recovery.recoveryPoints(); track point.id) {
                  <div 
                    class="recovery-point-card"
                    [class.selected]="selectedPointId() === point.id"
                    (click)="selectPoint(point)"
                  >
                    <div class="point-header">
                      <span class="type-badge" [class.full]="point.type === 'full'">
                        {{ recovery.getTypeLabel(point.type) }}
                      </span>
                      <span class="timestamp">{{ recovery.formatTimestamp(point.timestamp) }}</span>
                    </div>
                    <div class="point-stats">
                      <span class="stat">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M3 3h18v18H3zM21 9H3M9 21V9"/>
                        </svg>
                        {{ point.projectCount }} 项目
                      </span>
                      <span class="stat">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M9 11l3 3L22 4"/>
                          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                        </svg>
                        {{ point.taskCount }} 任务
                      </span>
                      <span class="stat">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M4 12h16"/>
                        </svg>
                        {{ point.connectionCount }} 连接
                      </span>
                    </div>
                    <div class="point-meta">
                      <span class="size">{{ recovery.formatSize(point.size) }}</span>
                      @if (point.encrypted) {
                        <span class="encrypted" title="已加密">🔒</span>
                      }
                      @if (!point.validationPassed) {
                        <span class="warning" title="校验警告">⚠️</span>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        } @else if (currentView() === 'preview') {
          <!-- 预览视图 -->
          <div class="preview-view">
            @if (recovery.currentPreview(); as preview) {
              <div class="preview-header">
                <button class="back-btn" (click)="backToList()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 12H5M12 19l-7-7 7-7"/>
                  </svg>
                  返回列表
                </button>
                <h3>备份预览</h3>
              </div>
              
              <div class="preview-info">
                <div class="info-row">
                  <span class="label">备份类型</span>
                  <span class="value">{{ recovery.getTypeLabel(preview.type) }}</span>
                </div>
                <div class="info-row">
                  <span class="label">备份时间</span>
                  <span class="value">{{ recovery.formatTimestamp(preview.timestamp) }}</span>
                </div>
                <div class="info-row">
                  <span class="label">数据统计</span>
                  <span class="value">
                    {{ preview.projectCount }} 项目 / {{ preview.taskCount }} 任务 / {{ preview.connectionCount }} 连接
                  </span>
                </div>
              </div>

              <div class="preview-projects">
                <h4>包含的项目</h4>
                <div class="project-list">
                  @for (project of preview.projects; track project.id) {
                    <div class="project-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 3h18v18H3zM21 9H3M9 21V9"/>
                      </svg>
                      <span>{{ project.name }}</span>
                    </div>
                  }
                </div>
              </div>

              <div class="restore-options">
                <h4>恢复选项</h4>
                <div class="option-group">
                  <label class="option">
                    <input 
                      type="radio" 
                      name="mode" 
                      value="replace"
                      [checked]="restoreOptions().mode === 'replace'"
                      (change)="setRestoreMode('replace')"
                    >
                    <span class="option-content">
                      <strong>替换模式</strong>
                      <small>删除现有数据，使用备份数据替换</small>
                    </span>
                  </label>
                  <label class="option">
                    <input 
                      type="radio" 
                      name="mode" 
                      value="merge"
                      [checked]="restoreOptions().mode === 'merge'"
                      (change)="setRestoreMode('merge')"
                    >
                    <span class="option-content">
                      <strong>合并模式</strong>
                      <small>保留现有数据，合并备份数据</small>
                    </span>
                  </label>
                </div>

                <label class="checkbox-option">
                  <input 
                    type="checkbox" 
                    [checked]="restoreOptions().createSnapshot"
                    (change)="toggleCreateSnapshot()"
                  >
                  <span>恢复前创建当前数据快照</span>
                </label>
              </div>

              <div class="warning-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <div>
                  <strong>警告</strong>
                  <p>恢复操作将{{ restoreOptions().mode === 'replace' ? '覆盖' : '修改' }}您的现有数据。请确认已了解恢复内容。</p>
                </div>
              </div>
            }
          </div>
        }
      </div>

      <!-- 底部操作栏 -->
      <div class="modal-footer">
        @if (currentView() === 'list') {
          <button class="btn btn-secondary" (click)="close()">关闭</button>
          <button 
            class="btn btn-primary" 
            [disabled]="!selectedPointId()"
            (click)="previewSelectedPoint()"
          >
            预览选中备份
          </button>
        } @else if (currentView() === 'preview') {
          <button class="btn btn-secondary" (click)="backToList()">取消</button>
          <button 
            class="btn btn-danger" 
            [disabled]="recovery.isLoading()"
            (click)="confirmRestore()"
          >
            确认恢复
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    /* 深色模式变量定义 */
    :host-context([data-color-mode="dark"]) .recovery-modal {
      --bg-primary: #1c1917;
      --bg-secondary: #292524;
      --hover-bg: #3f3f46;
      --border-color: #525252;
      --text-primary: #fafaf9;
      --text-secondary: #a8a29e;
      --text-tertiary: #78716c;
      --primary: #818cf8;
      --primary-dark: #6366f1;
      --primary-bg: #312e81;
      --success: #4ade80;
      --success-bg: #14532d;
      --danger: #f87171;
      --danger-dark: #ef4444;
      --warning: #fbbf24;
      --warning-bg: #78350f;
      --warning-border: #92400e;
    }

    .recovery-modal {
      display: flex;
      flex-direction: column;
      width: 600px;
      max-width: 90vw;
      max-height: 80vh;
      background: var(--bg-primary, #fff);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color, #e5e7eb);
    }

    .modal-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .modal-title .icon {
      width: 24px;
      height: 24px;
      color: var(--primary, #3b82f6);
    }

    .close-btn {
      padding: 8px;
      border: none;
      background: transparent;
      cursor: pointer;
      border-radius: 8px;
      transition: background 0.2s;
    }

    .close-btn:hover {
      background: var(--hover-bg, #f3f4f6);
    }

    .close-btn svg {
      width: 20px;
      height: 20px;
      color: var(--text-secondary, #6b7280);
    }

    .modal-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 20px;
      border-top: 1px solid var(--border-color, #e5e7eb);
    }

    /* 按钮样式 */
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--primary, #3b82f6);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--primary-dark, #2563eb);
    }

    .btn-secondary {
      background: var(--bg-secondary, #f3f4f6);
      color: var(--text-primary, #374151);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--hover-bg, #e5e7eb);
    }

    .btn-danger {
      background: var(--danger, #ef4444);
      color: white;
    }

    .btn-danger:hover:not(:disabled) {
      background: var(--danger-dark, #dc2626);
    }

    /* 加载状态 */
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      gap: 16px;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border-color, #e5e7eb);
      border-top-color: var(--primary, #3b82f6);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* 错误状态 */
    .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
      gap: 16px;
      text-align: center;
    }

    .error-state .icon {
      width: 48px;
      height: 48px;
      color: var(--danger, #ef4444);
    }

    /* 空状态 */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 20px;
      gap: 12px;
      text-align: center;
    }

    .empty-state .icon {
      width: 64px;
      height: 64px;
      color: var(--text-tertiary, #9ca3af);
    }

    .empty-state .hint {
      color: var(--text-tertiary, #9ca3af);
      font-size: 13px;
    }

    /* 恢复点列表 */
    .list-header {
      margin-bottom: 12px;
      color: var(--text-secondary, #6b7280);
      font-size: 13px;
    }

    .list-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .recovery-point-card {
      padding: 12px 16px;
      border: 1px solid var(--border-color, #e5e7eb);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .recovery-point-card:hover {
      border-color: var(--primary, #3b82f6);
      background: var(--hover-bg, #f9fafb);
    }

    .recovery-point-card.selected {
      border-color: var(--primary, #3b82f6);
      background: var(--primary-bg, #eff6ff);
    }

    .point-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .type-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      background: var(--bg-secondary, #f3f4f6);
      color: var(--text-secondary, #6b7280);
    }

    .type-badge.full {
      background: var(--success-bg, #dcfce7);
      color: var(--success, #16a34a);
    }

    .timestamp {
      font-size: 14px;
      color: var(--text-primary, #374151);
    }

    .point-stats {
      display: flex;
      gap: 16px;
      margin-bottom: 8px;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      color: var(--text-secondary, #6b7280);
    }

    .stat svg {
      width: 14px;
      height: 14px;
    }

    .point-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-tertiary, #9ca3af);
    }

    /* 预览视图 */
    .preview-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
    }

    .back-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border: none;
      background: var(--bg-secondary, #f3f4f6);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .back-btn:hover {
      background: var(--hover-bg, #e5e7eb);
    }

    .back-btn svg {
      width: 16px;
      height: 16px;
    }

    .preview-info {
      background: var(--bg-secondary, #f9fafb);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-color, #e5e7eb);
    }

    .info-row:last-child {
      border-bottom: none;
    }

    .info-row .label {
      color: var(--text-secondary, #6b7280);
    }

    .info-row .value {
      font-weight: 500;
    }

    .preview-projects {
      margin-bottom: 20px;
    }

    .preview-projects h4 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
    }

    .project-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .project-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-secondary, #f9fafb);
      border-radius: 6px;
      font-size: 14px;
    }

    .project-item svg {
      width: 16px;
      height: 16px;
      color: var(--text-tertiary, #9ca3af);
    }

    /* 恢复选项 */
    .restore-options {
      margin-bottom: 20px;
    }

    .restore-options h4 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
    }

    .option-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--border-color, #e5e7eb);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .option:hover {
      background: var(--hover-bg, #f9fafb);
    }

    .option input {
      margin-top: 2px;
    }

    .option-content {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .option-content strong {
      font-size: 14px;
    }

    .option-content small {
      font-size: 12px;
      color: var(--text-tertiary, #9ca3af);
    }

    .checkbox-option {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      cursor: pointer;
    }

    /* 警告框 */
    .warning-box {
      display: flex;
      gap: 12px;
      padding: 12px 16px;
      background: var(--warning-bg, #fef3c7);
      border: 1px solid var(--warning-border, #fcd34d);
      border-radius: 8px;
    }

    .warning-box svg {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      color: var(--warning, #f59e0b);
    }

    .warning-box strong {
      display: block;
      margin-bottom: 4px;
      font-size: 14px;
    }

    .warning-box p {
      margin: 0;
      font-size: 13px;
      color: var(--text-secondary, #6b7280);
    }
  `],
})
export class RecoveryModalComponent implements OnInit {
  readonly recovery = inject(RecoveryService);

  /** 关闭事件 */
  @Output() closeModal = new EventEmitter<void>();

  // 视图状态
  readonly currentView = signal<'list' | 'preview'>('list');
  readonly selectedPointId = signal<string | null>(null);
  readonly restoreOptions = signal<RecoveryOptions>({
    mode: 'replace',
    scope: 'all',
    createSnapshot: true,
  });

  // 选中的恢复点
  readonly selectedPoint = computed(() => {
    const id = this.selectedPointId();
    if (!id) return null;
    return this.recovery.recoveryPoints().find(p => p.id === id) ?? null;
  });

  ngOnInit(): void {
    this.loadRecoveryPoints();
  }

  async loadRecoveryPoints(): Promise<void> {
    await this.recovery.listRecoveryPoints();
  }

  selectPoint(point: RecoveryPoint): void {
    this.selectedPointId.set(point.id);
  }

  async previewSelectedPoint(): Promise<void> {
    const pointId = this.selectedPointId();
    if (!pointId) return;

    await this.recovery.previewRecovery(pointId);
    if (this.recovery.currentPreview()) {
      this.currentView.set('preview');
    }
  }

  backToList(): void {
    this.currentView.set('list');
    this.recovery.reset();
  }

  setRestoreMode(mode: 'replace' | 'merge'): void {
    this.restoreOptions.update(opts => ({ ...opts, mode }));
  }

  toggleCreateSnapshot(): void {
    this.restoreOptions.update(opts => ({ 
      ...opts, 
      createSnapshot: !opts.createSnapshot 
    }));
  }

  async confirmRestore(): Promise<void> {
    const pointId = this.selectedPointId();
    if (!pointId) return;

    // 二次确认
    const confirmed = confirm(
      '确定要恢复到此备份吗？\n\n' +
      (this.restoreOptions().mode === 'replace' 
        ? '⚠️ 替换模式将删除您的现有数据！' 
        : '合并模式将保留现有数据。') +
      '\n\n此操作不可撤销。'
    );

    if (!confirmed) return;

    const result = await this.recovery.executeRecovery(pointId, this.restoreOptions());
    
    if (result?.success) {
      this.close();
    }
  }

  close(): void {
    this.recovery.reset();
    this.closeModal.emit();
  }
}
