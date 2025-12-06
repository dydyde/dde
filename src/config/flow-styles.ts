/**
 * GoJS 图表样式常量配置
 * 集中管理流程图中使用的颜色、字体等样式
 * 支持主题切换
 */

/**
 * 主题类型
 */
export type FlowTheme = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * 节点样式配置
 */
export interface NodeStyleConfig {
  /** 默认背景色 */
  background: string;
  /** 选中时边框色 */
  selectedBorder: string;
  /** 默认边框色 */
  defaultBorder: string;
  /** 待分配任务背景色 */
  unassignedBackground: string;
  /** 待分配任务边框色 */
  unassignedBorder: string;
  /** 已完成任务背景色 */
  completedBackground: string;
  /** 搜索高亮背景色 */
  searchHighlightBackground: string;
  /** 搜索高亮边框色 */
  searchHighlightBorder: string;
}

/**
 * 文本样式配置
 */
export interface TextStyleConfig {
  /** 标识符颜色 */
  displayIdColor: string;
  /** 标题颜色 */
  titleColor: string;
  /** 待分配任务标题颜色 */
  unassignedTitleColor: string;
  /** 字体 */
  font: {
    displayId: string;
    title: string;
  };
}

/**
 * 连接线样式配置
 */
export interface LinkStyleConfig {
  /** 父子连接颜色 */
  parentChildColor: string;
  /** 跨树连接颜色 */
  crossTreeColor: string;
  /** 连接描述背景色 */
  descriptionBackground: string;
  /** 连接描述边框色 */
  descriptionBorder: string;
  /** 连接描述文字色 */
  descriptionText: string;
}

/**
 * 端口样式配置
 */
export interface PortStyleConfig {
  /** 悬停颜色 */
  hoverColor: string;
  /** 默认颜色 */
  defaultColor: string;
}

/**
 * 画布样式配置
 */
export interface CanvasStyleConfig {
  /** 背景色 */
  background: string;
}

/**
 * 完整的流程图样式配置
 */
export interface FlowStyleConfig {
  node: NodeStyleConfig;
  text: TextStyleConfig;
  link: LinkStyleConfig;
  port: PortStyleConfig;
  canvas: CanvasStyleConfig;
}

/**
 * 默认主题样式
 */
export const DEFAULT_FLOW_STYLES: FlowStyleConfig = {
  node: {
    background: '#FFFFFF', // White nodes on cream canvas
    selectedBorder: '#4A8C8C', // retro.teal
    defaultBorder: '#78716C', // retro.muted
    unassignedBackground: '#EBE7D9', // retro.panel
    unassignedBorder: '#C15B3E', // retro.rust
    completedBackground: '#E2E8C0', // Light olive
    searchHighlightBackground: '#B89C48', // retro.gold
    searchHighlightBorder: '#C15B3E', // retro.rust
  },
  text: {
    displayIdColor: '#78716C', // retro.muted
    titleColor: '#44403C', // retro.dark
    unassignedTitleColor: '#C15B3E', // retro.rust
    font: {
      displayId: 'bold 9px "LXGW WenKai Screen", sans-serif',
      title: '400 12px "LXGW WenKai Screen", sans-serif',
    },
  },
  link: {
    parentChildColor: '#78716C', // retro.muted
    crossTreeColor: '#C15B3E', // retro.rust
    descriptionBackground: '#F5F2E9', // retro.canvas
    descriptionBorder: '#4A8C8C', // retro.teal
    descriptionText: '#44403C', // retro.dark
  },
  port: {
    hoverColor: '#4A8C8C', // retro.teal
    defaultColor: 'transparent',
  },
  canvas: {
    background: '#F5F2E9', // retro.canvas
  },
};

/**
 * 海洋主题样式
 */
export const OCEAN_FLOW_STYLES: FlowStyleConfig = {
  node: {
    background: '#f0f9ff', // sky-50
    selectedBorder: '#0284c7', // sky-600
    defaultBorder: '#bae6fd', // sky-200
    unassignedBackground: '#c7d2fe', // indigo-200 - 紫蓝色，与青色已完成形成对比
    unassignedBorder: '#6366f1', // indigo-500
    completedBackground: '#a7f3d0', // emerald-200 - 更鲜艳的青绿色
    searchHighlightBackground: '#fef08a',
    searchHighlightBorder: '#eab308',
  },
  text: {
    displayIdColor: '#0369a1', // sky-700
    titleColor: '#0c4a6e', // sky-900
    unassignedTitleColor: '#4338ca', // indigo-700
    font: {
      displayId: 'bold 9px "LXGW WenKai Screen", sans-serif',
      title: '400 12px "LXGW WenKai Screen", sans-serif',
    },
  },
  link: {
    parentChildColor: '#7dd3fc', // sky-300
    crossTreeColor: '#06b6d4', // cyan-500
    descriptionBackground: '#ecfeff',
    descriptionBorder: '#22d3ee',
    descriptionText: '#0e7490',
  },
  port: {
    hoverColor: '#38bdf8',
    defaultColor: 'transparent',
  },
  canvas: {
    background: '#f0f9ff',
  },
};

/**
 * 森林主题样式
 */
export const FOREST_FLOW_STYLES: FlowStyleConfig = {
  node: {
    background: '#f0fdf4', // green-50
    selectedBorder: '#16a34a', // green-600
    defaultBorder: '#bbf7d0', // green-200
    unassignedBackground: '#fef3c7', // amber-100 - 琥珀色，与绿色已完成形成对比
    unassignedBorder: '#f59e0b', // amber-500
    completedBackground: '#bbf7d0', // green-200 - 更鲜艳的绿色
    searchHighlightBackground: '#fef08a',
    searchHighlightBorder: '#eab308',
  },
  text: {
    displayIdColor: '#15803d', // green-700
    titleColor: '#14532d', // green-900
    unassignedTitleColor: '#b45309', // amber-700
    font: {
      displayId: 'bold 9px "LXGW WenKai Screen", sans-serif',
      title: '400 12px "LXGW WenKai Screen", sans-serif',
    },
  },
  link: {
    parentChildColor: '#86efac', // green-300
    crossTreeColor: '#10b981', // emerald-500
    descriptionBackground: '#ecfdf5',
    descriptionBorder: '#34d399',
    descriptionText: '#047857',
  },
  port: {
    hoverColor: '#4ade80',
    defaultColor: 'transparent',
  },
  canvas: {
    background: '#f0fdf4',
  },
};

/**
 * 日落主题样式
 */
export const SUNSET_FLOW_STYLES: FlowStyleConfig = {
  node: {
    background: '#fff7ed', // orange-50
    selectedBorder: '#ea580c', // orange-600
    defaultBorder: '#fed7aa', // orange-200
    unassignedBackground: '#fce7f3', // pink-100 - 粉色，与绿色已完成形成对比
    unassignedBorder: '#ec4899', // pink-500
    completedBackground: '#bbf7d0', // green-200 - 绿色表示完成
    searchHighlightBackground: '#fef08a',
    searchHighlightBorder: '#eab308',
  },
  text: {
    displayIdColor: '#c2410c', // orange-700
    titleColor: '#7c2d12', // orange-900
    unassignedTitleColor: '#be185d', // pink-700
    font: {
      displayId: 'bold 9px "LXGW WenKai Screen", sans-serif',
      title: '400 12px "LXGW WenKai Screen", sans-serif',
    },
  },
  link: {
    parentChildColor: '#fdba74', // orange-300
    crossTreeColor: '#ef4444', // red-500
    descriptionBackground: '#fef2f2',
    descriptionBorder: '#f87171',
    descriptionText: '#b91c1c',
  },
  port: {
    hoverColor: '#fb923c',
    defaultColor: 'transparent',
  },
  canvas: {
    background: '#fff7ed',
  },
};

/**
 * 薰衣草主题样式
 */
export const LAVENDER_FLOW_STYLES: FlowStyleConfig = {
  node: {
    background: '#faf5ff', // purple-50
    selectedBorder: '#9333ea', // purple-600
    defaultBorder: '#e9d5ff', // purple-200
    unassignedBackground: '#fae8ff', // fuchsia-100 - 粉紫色
    unassignedBorder: '#d946ef', // fuchsia-500
    completedBackground: '#a7f3d0', // emerald-200 - 绿色表示完成，形成对比
    searchHighlightBackground: '#fef08a',
    searchHighlightBorder: '#eab308',
  },
  text: {
    displayIdColor: '#7e22ce', // purple-700
    titleColor: '#581c87', // purple-900
    unassignedTitleColor: '#c026d3', // fuchsia-600
    font: {
      displayId: 'bold 9px "LXGW WenKai Screen", sans-serif',
      title: '400 12px "LXGW WenKai Screen", sans-serif',
    },
  },
  link: {
    parentChildColor: '#d8b4fe', // purple-300
    crossTreeColor: '#d946ef', // fuchsia-500
    descriptionBackground: '#fdf4ff',
    descriptionBorder: '#e879f9',
    descriptionText: '#a21caf',
  },
  port: {
    hoverColor: '#c084fc',
    defaultColor: 'transparent',
  },
  canvas: {
    background: '#faf5ff',
  },
};

/**
 * 主题样式映射
 */
export const FLOW_THEME_STYLES: Record<FlowTheme, FlowStyleConfig> = {
  default: DEFAULT_FLOW_STYLES,
  ocean: OCEAN_FLOW_STYLES,
  forest: FOREST_FLOW_STYLES,
  sunset: SUNSET_FLOW_STYLES,
  lavender: LAVENDER_FLOW_STYLES,
};

/**
 * 获取指定主题的样式配置
 */
export function getFlowStyles(theme: FlowTheme = 'default'): FlowStyleConfig {
  return FLOW_THEME_STYLES[theme] || DEFAULT_FLOW_STYLES;
}
