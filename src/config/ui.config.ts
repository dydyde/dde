// ============================================
// UI 配置
// 包含用户界面、动画、搜索、流程图视图相关常量
// ============================================

/**
 * UI 配置
 */
export const UI_CONFIG = {
  /** 图表更新延迟（毫秒）- 给 Angular 变更检测时间 */
  DIAGRAM_UPDATE_DELAY: 50,
  /** 输入框聚焦延迟（毫秒） */
  INPUT_FOCUS_DELAY: 100,
  /** 滚动到元素延迟（毫秒） */
  SCROLL_TO_ELEMENT_DELAY: 100,
  /** 长按拖拽触发延迟（毫秒） */
  LONG_PRESS_DELAY: 200,
  /** 移动端长按延迟（毫秒） - 稍长避免误触 */
  MOBILE_LONG_PRESS_DELAY: 250,
  /** 触摸拖拽边缘滚动区域（像素） */
  TOUCH_SCROLL_EDGE_SIZE: 80,
  /** 鼠标拖拽边缘滚动区域（像素） */
  MOUSE_SCROLL_EDGE_SIZE: 60,
  /** 最大滚动速度（像素/帧） */
  MAX_SCROLL_SPEED: 15,
  /** 滑动切换阈值（像素） */
  SWIPE_THRESHOLD: 50,
  /** 手势识别最小移动距离（像素） */
  GESTURE_MIN_DISTANCE: 30,
  /** 手势方向比率（水平距离/垂直距离超过此值认为是水平手势） */
  GESTURE_DIRECTION_RATIO: 1.5,
  /** 提示自动消失时间（毫秒） */
  HINT_AUTO_DISMISS: 3000,
  /** 视图状态保存防抖延迟（毫秒） */
  VIEW_STATE_SAVE_DEBOUNCE: 1000,
  /** 视图恢复延迟（毫秒） */
  VIEW_RESTORE_DELAY: 200,
  /** 动画/过渡延迟（毫秒） */
  ANIMATION_DELAY: 50,
  /** 短延迟（毫秒）- 用于简单的下一帧操作 */
  SHORT_DELAY: 50,
  /** 中等延迟（毫秒）- 用于需要等待 DOM 更新的操作 */
  MEDIUM_DELAY: 100,
  /** 重置尺寸防抖延迟（毫秒） */
  RESIZE_DEBOUNCE_DELAY: 100,
  /** 调色板最小高度（像素） */
  PALETTE_MIN_HEIGHT: 80,
  /** 调色板最大高度（像素） */
  PALETTE_MAX_HEIGHT: 500,
} as const;

/**
 * Toast 配置
 */
export const TOAST_CONFIG = {
  /** 默认显示时长（毫秒） */
  DEFAULT_DURATION: 5000,
  /** 错误去重间隔（毫秒）- 5秒内相同错误只提示一次 */
  ERROR_DEDUP_INTERVAL: 5000,
} as const;

/**
 * 搜索配置
 */
export const SEARCH_CONFIG = {
  /** 搜索防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 300,
} as const;

/**
 * 深链接配置
 * 任务深链接定位相关配置
 */
export const DEEP_LINK_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 20,
  /** 基础延迟（毫秒） */
  BASE_DELAY: 100,
  /** 最大延迟（毫秒） */
  MAX_DELAY: 500,
} as const;

/**
 * 流程图配置
 * 图表初始化和重试相关配置
 */
export const FLOW_VIEW_CONFIG = {
  /** 最大图表初始化重试次数 */
  MAX_DIAGRAM_RETRIES: 3,
  /** 图表初始化重试基础延迟（毫秒） */
  DIAGRAM_RETRY_BASE_DELAY: 100,
} as const;
