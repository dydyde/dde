import { Injectable } from '@angular/core';
import { Task } from '../models';
import { GoJSNodeData, GoJSLinkData } from '../app/features/flow/services/flow-diagram-config.service';

/**
 * 血缘关系数据结构
 * 用于追溯每个节点的始祖节点
 */
export interface LineageData {
  /** 始祖节点索引（1, 2, 3 等顶级任务的索引） */
  rootAncestorIndex: number;
  /** 始祖节点 ID */
  rootAncestorId: string;
  /** 家族专属颜色（HSL 格式） */
  familyColor: string;
}

/**
 * 预处理后的节点数据（包含血缘信息）
 */
export interface LineageNodeData extends GoJSNodeData {
  /** 始祖节点索引 */
  rootAncestorIndex: number;
  /** 家族专属颜色 */
  familyColor: string;
}

/**
 * 预处理后的连线数据（包含血缘信息）
 */
export interface LineageLinkData extends GoJSLinkData {
  /** 始祖节点索引 */
  rootAncestorIndex: number;
  /** 家族专属颜色 */
  familyColor: string;
}

/**
 * 高对比度预定义调色板
 * 经过精心挑选，确保：
 * - 相邻颜色有明显区分度
 * - 色盲友好（避免纯红/绿组合）
 * - 在深色/浅色背景上都清晰可见
 */
const HIGH_CONTRAST_PALETTE: string[] = [
  '#e63946',  // 红色（玫瑰红）
  '#2a9d8f',  // 青色（翡翠绿）
  '#e9c46a',  // 黄色（金黄）
  '#457b9d',  // 蓝色（钢蓝）
  '#f4a261',  // 橙色（沙色）
  '#9b5de5',  // 紫色（兰花紫）
  '#00f5d4',  // 青绿（荧光青）
  '#ff6b6b',  // 珊瑚红
  '#4ecdc4',  // 薄荷绿
  '#ffe66d',  // 柠檬黄
  '#95e1d3',  // 淡青
  '#f38181',  // 浅珊瑚
  '#aa96da',  // 淡紫
  '#fcbad3',  // 粉红
  '#a8d8ea',  // 天蓝
  '#fee440',  // 明黄
];

/**
 * 血缘追溯与颜色服务
 * 
 * 职责：
 * - 追溯每个节点的始祖节点（第一代任务）
 * - 基于高对比度调色板为家族分配颜色
 * - 为节点和连线注入血缘信息
 * 
 * 设计原则：
 * - 数据预处理在 GoJS Model 加载之前完成
 * - 优先使用预定义调色板，超出时使用 HSL 生成
 * - 与现有 FlowDiagramConfigService 解耦，可独立测试
 */
@Injectable({
  providedIn: 'root'
})
export class LineageColorService {
  
  // ========== HSL 色彩配置（后备方案）==========
  /** 固定饱和度 (85%) - 高饱和度确保颜色鲜艳 */
  private readonly SATURATION = 85;
  /** 固定亮度 (55%) - 略高亮度确保在深色背景上也清晰 */
  private readonly LIGHTNESS = 55;
  /** 最小色相步长，确保相邻颜色有足够区分度 */
  private readonly MIN_HUE_STEP = 40;
  /** 色相环起始偏移，避免从纯红色开始 */
  private readonly HUE_OFFSET = 15;
  
  /**
   * 预处理图表数据，注入血缘信息
   * 
   * 核心逻辑：
   * 1. 构建任务 ID 到任务的映射
   * 2. 遍历所有任务，向上追溯始祖节点
   * 3. 为始祖节点分配索引并计算家族颜色
   * 4. 将血缘信息注入到节点和连线数据中
   * 
   * @param nodeDataArray 原始节点数据
   * @param linkDataArray 原始连线数据
   * @param tasks 任务列表（用于追溯父子关系）
   * @returns 包含血缘信息的节点和连线数据
   */
  preprocessDiagramData(
    nodeDataArray: GoJSNodeData[],
    linkDataArray: GoJSLinkData[],
    tasks: Task[]
  ): { nodeDataArray: LineageNodeData[]; linkDataArray: LineageLinkData[] } {
    
    // 步骤1：构建任务映射和父子关系
    const taskMap = new Map<string, Task>();
    tasks.forEach(task => taskMap.set(task.id, task));
    
    // 步骤2：追溯每个任务的始祖节点
    const lineageCache = new Map<string, { rootId: string; rootIndex: number }>();
    const rootNodes: string[] = []; // 按发现顺序记录始祖节点
    
    for (const task of tasks) {
      this.traceRootAncestor(task.id, taskMap, lineageCache, rootNodes);
    }
    
    // 步骤3：计算每个始祖节点的家族颜色
    const totalRoots = rootNodes.length;
    const rootColorMap = new Map<string, string>();
    
    rootNodes.forEach((rootId, index) => {
      rootColorMap.set(rootId, this.generateFamilyColor(index, totalRoots));
    });
    
    // 步骤4：为节点注入血缘信息
    const enhancedNodes: LineageNodeData[] = nodeDataArray.map(node => {
      const lineage = lineageCache.get(node.key);
      const rootId = lineage?.rootId || node.key;
      const rootIndex = lineage?.rootIndex ?? 0;
      const familyColor = rootColorMap.get(rootId) || this.generateFamilyColor(0, 1);
      
      return {
        ...node,
        rootAncestorIndex: rootIndex,
        familyColor
      };
    });
    
    // 步骤5：为连线注入血缘信息（使用源节点的血缘）
    const enhancedLinks: LineageLinkData[] = linkDataArray.map(link => {
      // 连线继承源节点的家族颜色
      const sourceLineage = lineageCache.get(link.from);
      const rootId = sourceLineage?.rootId || link.from;
      const rootIndex = sourceLineage?.rootIndex ?? 0;
      const familyColor = rootColorMap.get(rootId) || this.generateFamilyColor(0, 1);
      
      return {
        ...link,
        rootAncestorIndex: rootIndex,
        familyColor
      };
    });
    
    return {
      nodeDataArray: enhancedNodes,
      linkDataArray: enhancedLinks
    };
  }
  
  /**
   * 追溯任务的始祖节点
   * 
   * 使用递归向上追溯 parentId 链，直到找到没有父节点的任务（始祖）
   * 结果会被缓存以避免重复计算
   * 
   * @param taskId 当前任务 ID
   * @param taskMap 任务映射
   * @param cache 血缘缓存
   * @param rootNodes 始祖节点列表（按发现顺序）
   * @returns 始祖节点 ID
   */
  private traceRootAncestor(
    taskId: string,
    taskMap: Map<string, Task>,
    cache: Map<string, { rootId: string; rootIndex: number }>,
    rootNodes: string[]
  ): string {
    // 检查缓存
    const cached = cache.get(taskId);
    if (cached) {
      return cached.rootId;
    }
    
    const task = taskMap.get(taskId);
    if (!task) {
      // 任务不存在，将自己作为始祖
      const rootIndex = this.getOrAddRootIndex(taskId, rootNodes);
      cache.set(taskId, { rootId: taskId, rootIndex });
      return taskId;
    }
    
    if (!task.parentId) {
      // 没有父节点，这就是始祖
      const rootIndex = this.getOrAddRootIndex(taskId, rootNodes);
      cache.set(taskId, { rootId: taskId, rootIndex });
      return taskId;
    }
    
    // 递归追溯父节点
    const rootId = this.traceRootAncestor(task.parentId, taskMap, cache, rootNodes);
    const rootIndex = cache.get(rootId)?.rootIndex ?? 0;
    cache.set(taskId, { rootId, rootIndex });
    
    return rootId;
  }
  
  /**
   * 获取或添加始祖节点索引
   */
  private getOrAddRootIndex(rootId: string, rootNodes: string[]): number {
    const existingIndex = rootNodes.indexOf(rootId);
    if (existingIndex >= 0) {
      return existingIndex;
    }
    rootNodes.push(rootId);
    return rootNodes.length - 1;
  }
  
  /**
   * 基于高对比度调色板生成家族颜色
   * 
   * 算法原理：
   * - 优先使用预定义的高对比度调色板（前16个家族）
   * - 超出调色板时，使用 HSL 黄金角度算法生成
   * - 确保即使相邻索引也有明显的视觉区分
   * 
   * @param index 始祖节点索引（从 0 开始）
   * @param totalRoots 始祖节点总数
   * @returns 颜色字符串（HEX 或 HSL 格式）
   */
  generateFamilyColor(index: number, totalRoots: number): string {
    // 优先使用预定义的高对比度调色板
    if (index < HIGH_CONTRAST_PALETTE.length) {
      return HIGH_CONTRAST_PALETTE[index];
    }
    
    // 超出调色板范围时，使用 HSL 黄金角度算法
    if (totalRoots <= 0) {
      return `hsl(${this.HUE_OFFSET}, ${this.SATURATION}%, ${this.LIGHTNESS}%)`;
    }
    
    // 使用黄金角度（约137.5度）来分布颜色
    const goldenAngle = 137.508;
    const hue = (this.HUE_OFFSET + index * goldenAngle) % 360;
    
    return `hsl(${Math.round(hue)}, ${this.SATURATION}%, ${this.LIGHTNESS}%)`;
  }
  
  /**
   * 将 HSL 颜色转换为 HEX 格式
   * 用于不支持 HSL 的场景
   */
  hslToHex(hslColor: string): string {
    const match = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return hslColor;
    
    const h = parseInt(match[1], 10);
    const s = parseInt(match[2], 10) / 100;
    const l = parseInt(match[3], 10) / 100;
    
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    
    let r = 0, g = 0, b = 0;
    
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    
    const toHex = (v: number) => {
      const hex = Math.round((v + m) * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  
  /**
   * 获取家族颜色的亮色版本（用于高亮显示）
   */
  getLighterFamilyColor(familyColor: string): string {
    const match = familyColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return familyColor;
    
    const h = match[1];
    const s = match[2];
    // 增加亮度 20%
    const newL = Math.min(parseInt(match[3], 10) + 20, 85);
    
    return `hsl(${h}, ${s}%, ${newL}%)`;
  }
  
  /**
   * 获取家族颜色的暗色版本（用于边框或强调）
   */
  getDarkerFamilyColor(familyColor: string): string {
    const match = familyColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return familyColor;
    
    const h = match[1];
    const s = match[2];
    // 降低亮度 15%
    const newL = Math.max(parseInt(match[3], 10) - 15, 25);
    
    return `hsl(${h}, ${s}%, ${newL}%)`;
  }
}
