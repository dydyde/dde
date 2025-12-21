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
  | 'dashboard';

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
  
  /**
   * 加载设置模态框
   */
  async loadSettingsModal(): Promise<Type<unknown>> {
    return this.loadModal('settings', () => 
      import('../../../components/modals/settings-modal.component').then(m => m.SettingsModalComponent)
    );
  }
  
  /**
   * 加载登录模态框
   */
  async loadLoginModal(): Promise<Type<unknown>> {
    return this.loadModal('login', () => 
      import('../../../components/modals/login-modal.component').then(m => m.LoginModalComponent)
    );
  }
  
  /**
   * 加载冲突解决模态框
   */
  async loadConflictModal(): Promise<Type<unknown>> {
    return this.loadModal('conflict', () => 
      import('../../../components/modals/conflict-modal.component').then(m => m.ConflictModalComponent)
    );
  }
  
  /**
   * 加载新建项目模态框
   */
  async loadNewProjectModal(): Promise<Type<unknown>> {
    return this.loadModal('newProject', () => 
      import('../../../components/modals/new-project-modal.component').then(m => m.NewProjectModalComponent)
    );
  }
  
  /**
   * 加载配置帮助模态框
   */
  async loadConfigHelpModal(): Promise<Type<unknown>> {
    return this.loadModal('configHelp', () => 
      import('../../../components/modals/config-help-modal.component').then(m => m.ConfigHelpModalComponent)
    );
  }
  
  /**
   * 加载回收站模态框
   */
  async loadTrashModal(): Promise<Type<unknown>> {
    return this.loadModal('trash', () => 
      import('../../../components/modals/trash-modal.component').then(m => m.TrashModalComponent)
    );
  }
  
  /**
   * 加载迁移模态框
   */
  async loadMigrationModal(): Promise<Type<unknown>> {
    return this.loadModal('migration', () => 
      import('../../../components/modals/migration-modal.component').then(m => m.MigrationModalComponent)
    );
  }
  
  /**
   * 加载错误恢复模态框
   */
  async loadErrorRecoveryModal(): Promise<Type<unknown>> {
    return this.loadModal('errorRecovery', () => 
      import('../../../components/modals/error-recovery-modal.component').then(m => m.ErrorRecoveryModalComponent)
    );
  }
  
  /**
   * 加载存储逃生模态框
   */
  async loadStorageEscapeModal(): Promise<Type<unknown>> {
    return this.loadModal('storageEscape', () => 
      import('../../../components/modals/storage-escape-modal.component').then(m => m.StorageEscapeModalComponent)
    );
  }
  
  /**
   * 加载仪表盘模态框
   */
  async loadDashboardModal(): Promise<Type<unknown>> {
    return this.loadModal('dashboard', () => 
      import('../../../components/modals/dashboard-modal.component').then(m => m.DashboardModalComponent)
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
    
    try {
      this.logger.debug(`加载模态框: ${type}`);
      const component = await loader();
      this.loadedModals.set(type, component as Type<unknown>);
      this.logger.debug(`模态框加载成功: ${type}`);
      return component;
    } catch (error) {
      this.logger.error(`模态框加载失败: ${type}`, error);
      this.toast.error('加载失败', '无法加载组件，请刷新页面重试');
      throw error;
    }
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
}
