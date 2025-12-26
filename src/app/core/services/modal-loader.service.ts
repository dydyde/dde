/**
 * 模态框懒加载服务
 * 
 * 职责：
 * - 按需动态加载模态框组件
 * - 减少首屏 main.js 体积
 * - 统一模态框的加载和错误处理
 * - 与 DynamicModalService 集成实现完整的动态渲染
 * 
 * 使用方式：
 * ```typescript
 * // 方式一：仅加载组件
 * const modal = await this.modalLoader.loadSettingsModal();
 * 
 * // 方式二：加载并打开（推荐）
 * const result = await this.modalLoader.openSettingsModal({ sessionEmail: 'xxx' });
 * ```
 */

import { Injectable, inject, Type } from '@angular/core';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { DynamicModalService, ModalRef } from '../../../services/dynamic-modal.service';
import * as Sentry from '@sentry/angular';

/**
 * 模态框类型映射
 */
export type ModalType = 
  | 'settings'
  | 'login'
  | 'conflict'
  | 'newProject'
  | 'configHelp'
  | 'trash'
  | 'migration'
  | 'errorRecovery'
  | 'storageEscape'
  | 'dashboard'
  | 'deleteConfirm';

@Injectable({
  providedIn: 'root'
})
export class ModalLoaderService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ModalLoader');
  private readonly toast = inject(ToastService);
  private readonly dynamicModal = inject(DynamicModalService);
  
  /** 已加载的模态框缓存 */
  private readonly loadedModals = new Map<ModalType, Type<unknown>>();
  
  /** 模态框加载超时时间（毫秒）- 手机端网络较慢，给予更长时间 */
  private readonly MODAL_LOAD_TIMEOUT = 15000;
  
  /** 最大重试次数 */
  private readonly MAX_RETRIES = 2;
  
  /** 加载失败计数器（用于降级策略） */
  private readonly failureCount = new Map<ModalType, number>();
  
  /**
   * 加载设置模态框
   */
  async loadSettingsModal(): Promise<Type<unknown>> {
    return this.loadModal('settings', () => 
      import('../../shared/modals/settings-modal.component').then(m => m.SettingsModalComponent)
    );
  }
  
  /**
   * 加载登录模态框
   */
  async loadLoginModal(): Promise<Type<unknown>> {
    return this.loadModal('login', () => 
      import('../../shared/modals/login-modal.component').then(m => m.LoginModalComponent)
    );
  }
  
  /**
   * 加载冲突解决模态框
   */
  async loadConflictModal(): Promise<Type<unknown>> {
    return this.loadModal('conflict', () => 
      import('../../shared/modals/conflict-modal.component').then(m => m.ConflictModalComponent)
    );
  }
  
  /**
   * 加载新建项目模态框
   */
  async loadNewProjectModal(): Promise<Type<unknown>> {
    return this.loadModal('newProject', () => 
      import('../../shared/modals/new-project-modal.component').then(m => m.NewProjectModalComponent)
    );
  }
  
  /**
   * 加载删除确认模态框
   */
  async loadDeleteConfirmModal(): Promise<Type<unknown>> {
    return this.loadModal('deleteConfirm', () => 
      import('../../shared/modals/delete-confirm-modal.component').then(m => m.DeleteConfirmModalComponent)
    );
  }
  
  /**
   * 加载配置帮助模态框
   */
  async loadConfigHelpModal(): Promise<Type<unknown>> {
    return this.loadModal('configHelp', () => 
      import('../../shared/modals/config-help-modal.component').then(m => m.ConfigHelpModalComponent)
    );
  }
  
  /**
   * 加载回收站模态框
   */
  async loadTrashModal(): Promise<Type<unknown>> {
    return this.loadModal('trash', () => 
      import('../../shared/modals/trash-modal.component').then(m => m.TrashModalComponent)
    );
  }
  
  /**
   * 加载迁移模态框
   */
  async loadMigrationModal(): Promise<Type<unknown>> {
    return this.loadModal('migration', () => 
      import('../../shared/modals/migration-modal.component').then(m => m.MigrationModalComponent)
    );
  }
  
  /**
   * 加载错误恢复模态框
   */
  async loadErrorRecoveryModal(): Promise<Type<unknown>> {
    return this.loadModal('errorRecovery', () => 
      import('../../shared/modals/error-recovery-modal.component').then(m => m.ErrorRecoveryModalComponent)
    );
  }
  
  /**
   * 加载存储逃生模态框
   */
  async loadStorageEscapeModal(): Promise<Type<unknown>> {
    return this.loadModal('storageEscape', () => 
      import('../../shared/modals/storage-escape-modal.component').then(m => m.StorageEscapeModalComponent)
    );
  }
  
  /**
   * 加载仪表盘模态框
   */
  async loadDashboardModal(): Promise<Type<unknown>> {
    return this.loadModal('dashboard', () => 
      import('../../shared/modals/dashboard-modal.component').then(m => m.DashboardModalComponent)
    );
  }
  
  /**
   * 通用模态框加载方法
   * @param type 模态框类型
   * @param loader 加载函数
   */
  private async loadModal<T>(
    type: ModalType, 
    loader: () => Promise<Type<T>>
  ): Promise<Type<T>> {
    // 检查缓存
    if (this.loadedModals.has(type)) {
      return this.loadedModals.get(type) as Type<T>;
    }
    
    // 带重试的加载逻辑
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.debug(`加载模态框: ${type} (尝试 ${attempt + 1}/${this.MAX_RETRIES + 1})`);
        
        // 添加超时保护
        const component = await this.loadWithTimeout(loader(), type);
        
        // 加载成功，缓存并重置失败计数
        this.loadedModals.set(type, component as Type<unknown>);
        this.failureCount.delete(type);
        this.logger.debug(`模态框加载成功: ${type}`);
        return component;
        
      } catch (error) {
        lastError = error;
        this.logger.warn(`模态框加载失败 (尝试 ${attempt + 1}): ${type}`, error);
        
        // 如果还有重试机会，等待一段时间后重试
        if (attempt < this.MAX_RETRIES) {
          await this.delay(1000 * (attempt + 1)); // 递增延迟
        }
      }
    }
    
    // 所有重试都失败，记录失败次数并显示友好提示
    const failures = (this.failureCount.get(type) || 0) + 1;
    this.failureCount.set(type, failures);
    
    this.logger.error(`模态框加载失败 (已重试${this.MAX_RETRIES}次): ${type}`, lastError);
    Sentry.captureException(lastError, { tags: { operation: 'loadModal', modalType: type } });
    
    // 根据失败次数显示不同提示
    if (failures >= 3) {
      this.toast.error('网络连接不稳定', '建议稍后重试或检查网络连接');
    } else {
      this.toast.error('加载失败', '正在重试，请稍候...');
    }
    
    throw lastError;
  }
  
  /**
   * 带超时保护的加载
   */
  private async loadWithTimeout<T>(promise: Promise<T>, type: ModalType): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(
          () => reject(new Error(`模态框 ${type} 加载超时 (>${this.MODAL_LOAD_TIMEOUT}ms)`)),
          this.MODAL_LOAD_TIMEOUT
        )
      )
    ]);
  }
  
  /**
   * 延迟辅助函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 预加载常用模态框（可在空闲时调用）
   */
  async preloadCommonModals(): Promise<void> {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(async () => {
        try {
          // 预加载最常用的模态框
          await Promise.all([
            this.loadSettingsModal(),
            this.loadNewProjectModal()
          ]);
          this.logger.debug('常用模态框预加载完成');
        } catch {
          // 预加载失败不影响正常使用
        }
      });
    }
  }
  
  /**
   * 检查模态框是否已加载
   */
  isLoaded(type: ModalType): boolean {
    return this.loadedModals.has(type);
  }
  
  /**
   * 清理缓存（用于测试）
   */
  clearCache(): void {
    this.loadedModals.clear();
  }
  
  // ========== 打开模态框方法（加载 + 渲染）==========
  
  /**
   * 打开设置模态框
   */
  async openSettingsModal<R = unknown>(data?: { sessionEmail?: string }): Promise<ModalRef<R>> {
    const component = await this.loadSettingsModal();
    return this.dynamicModal.open(component, { data });
  }
  
  /**
   * 打开登录模态框
   */
  async openLoginModal<R = unknown>(data?: { authError?: string; isLoading?: boolean; resetPasswordSent?: boolean }): Promise<ModalRef<R>> {
    const component = await this.loadLoginModal();
    return this.dynamicModal.open(component, { data, closeOnBackdropClick: false, closeOnEscape: false });
  }
  
  /**
   * 打开新建项目模态框
   */
  async openNewProjectModal<R = unknown>(): Promise<ModalRef<R>> {
    const component = await this.loadNewProjectModal();
    return this.dynamicModal.open(component, {});
  }
  
  /**
   * 打开冲突解决模态框
   */
  async openConflictModal<R = unknown>(data: unknown): Promise<ModalRef<R>> {
    const component = await this.loadConflictModal();
    return this.dynamicModal.open(component, { data, closeOnBackdropClick: false, closeOnEscape: false });
  }
  
  /**
   * 打开配置帮助模态框
   */
  async openConfigHelpModal<R = unknown>(): Promise<ModalRef<R>> {
    const component = await this.loadConfigHelpModal();
    return this.dynamicModal.open(component, {});
  }
  
  /**
   * 打开回收站模态框
   */
  async openTrashModal<R = unknown>(): Promise<ModalRef<R>> {
    const component = await this.loadTrashModal();
    return this.dynamicModal.open(component, {});
  }
  
  /**
   * 打开数据迁移模态框
   */
  async openMigrationModal<R = unknown>(): Promise<ModalRef<R>> {
    const component = await this.loadMigrationModal();
    return this.dynamicModal.open(component, { closeOnBackdropClick: false, closeOnEscape: false });
  }
  
  /**
   * 打开错误恢复模态框
   */
  async openErrorRecoveryModal<R = unknown>(data: unknown): Promise<ModalRef<R>> {
    const component = await this.loadErrorRecoveryModal();
    return this.dynamicModal.open(component, { data, closeOnBackdropClick: false, closeOnEscape: false });
  }
  
  /**
   * 打开存储逃生模态框
   */
  async openStorageEscapeModal<R = unknown>(data: unknown): Promise<ModalRef<R>> {
    const component = await this.loadStorageEscapeModal();
    return this.dynamicModal.open(component, { data, closeOnBackdropClick: false, closeOnEscape: false });
  }
  
  /**
   * 打开仪表盘模态框
   */
  async openDashboardModal<R = unknown>(): Promise<ModalRef<R>> {
    const component = await this.loadDashboardModal();
    return this.dynamicModal.open(component, {});
  }
  
  /**
   * 打开删除确认模态框
   */
  async openDeleteConfirmModal<R = unknown>(data: { 
    title?: string; 
    message?: string; 
    itemName: string; 
    warning?: string; 
  }): Promise<ModalRef<R>> {
    const component = await this.loadDeleteConfirmModal();
    return this.dynamicModal.open(component, { data });
  }
}
