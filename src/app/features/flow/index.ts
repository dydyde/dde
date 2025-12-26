/**
 * Flow Feature Module - 流程图视图
 * 
 * 包含流程图视图相关的组件和服务
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 禁止使用 visibility: hidden 隐藏 GoJS canvas（占用内存）
 */

// 组件
export * from './components';

// 服务
export * from './services';

// 其他相关服务（仍在 src/services/ 目录）
export { LayoutService } from '../../../services/layout.service';
export { LineageColorService } from '../../../services/lineage-color.service';
export { MinimapMathService } from '../../../services/minimap-math.service';
export { ReactiveMinimapService } from '../../../services/reactive-minimap.service';
