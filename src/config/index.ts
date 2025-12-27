// ============================================
// 配置导出中心
// 统一导出所有配置模块
// ============================================

// 布局配置
export {
  LAYOUT_CONFIG,
  FLOATING_TREE_CONFIG,
  GOJS_CONFIG,
  LETTERS,
  SUPERSCRIPT_DIGITS
} from './layout.config';

// 同步配置
export {
  SYNC_CONFIG,
  SYNC_PERCEPTION_CONFIG,
  SYNC_MODE_CONFIG,
  REQUEST_THROTTLE_CONFIG,
  SYNC_CHECKPOINT_CONFIG,
  CONFLICT_HISTORY_CONFIG,
  CACHE_CONFIG,
  OPTIMISTIC_CONFIG,
  QUEUE_CONFIG,
  UNDO_SYNC_CONFIG
} from './sync.config';

// UI 配置
export {
  UI_CONFIG,
  TOAST_CONFIG,
  SEARCH_CONFIG,
  DEEP_LINK_CONFIG,
  FLOW_VIEW_CONFIG
} from './ui.config';

// 认证配置
export {
  AUTH_CONFIG,
  GUARD_CONFIG
} from './auth.config';

// 超时配置
export {
  TIMEOUT_CONFIG,
  RETRY_POLICY
} from './timeout.config';
export type { TimeoutLevel } from './timeout.config';

// 附件配置
export {
  ATTACHMENT_CONFIG,
  ATTACHMENT_CLEANUP_CONFIG
} from './attachment.config';

// 任务配置
export {
  TRASH_CONFIG,
  UNDO_CONFIG
} from './task.config';

// 流程图样式（独立文件，保持不变）
export * from './flow-styles';
