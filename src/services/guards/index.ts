/**
 * 路由守卫导出
 * 
 * 注意：authGuard 已移除（曾标记为 @deprecated）
 * 请使用 requireAuthGuard 进行认证检查
 */
export { 
  requireAuthGuard, 
  isLocalModeEnabled, 
  enableLocalMode, 
  disableLocalMode,
  getDataIsolationId 
} from './auth.guard';
export { projectExistsGuard } from './project.guard';

// 路由离开保护
export {
  UnsavedChangesGuard,
  BeforeUnloadGuardService,
  ProjectSwitchGuardService,
  ROUTE_LEAVE_PROTECTION_CONFIG,
  type CanLeave,
} from './unsaved-changes.guard';
