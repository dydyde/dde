/**
 * Flow Services barrel export
 * 流程图相关服务导出
 */

// 核心服务
export { FlowDiagramService } from './flow-diagram.service';
export { FlowDiagramConfigService } from './flow-diagram-config.service';
export { FlowOverviewService } from './flow-overview.service';

// 事件与选择
export { FlowEventService } from './flow-event.service';
export { FlowSelectionService } from './flow-selection.service';
export { FlowZoomService } from './flow-zoom.service';
export { FlowLayoutService } from './flow-layout.service';

// 模板与事件总线
export { FlowTemplateService } from './flow-template.service';
export * from './flow-template-events';

// 交互服务
export { FlowDragDropService } from './flow-drag-drop.service';
export type { InsertPositionInfo } from './flow-drag-drop.service';
export { FlowTouchService } from './flow-touch.service';
export { FlowLinkService } from './flow-link.service';
export { FlowTaskOperationsService } from './flow-task-operations.service';

// 调试
export { FlowDebugService } from './flow-debug.service';
