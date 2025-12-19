/**
 * Flow Feature Module - 流程图视图
 * 
 * 包含流程图视图相关的组件和服务
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 禁止使用 visibility: hidden 隐藏 GoJS canvas（占用内存）
 */

// 主视图组件
export { FlowViewComponent } from '../../../components/flow-view.component';

// 流程图子组件
export { FlowPaletteComponent } from '../../../components/flow/flow-palette.component';
export { FlowToolbarComponent } from '../../../components/flow/flow-toolbar.component';
export { FlowTaskDetailComponent } from '../../../components/flow/flow-task-detail.component';
export { FlowConnectionEditorComponent } from '../../../components/flow/flow-connection-editor.component';
export { FlowDeleteConfirmComponent } from '../../../components/flow/flow-delete-confirm.component';
export { FlowLinkDeleteHintComponent } from '../../../components/flow/flow-link-delete-hint.component';
export { FlowLinkTypeDialogComponent } from '../../../components/flow/flow-link-type-dialog.component';

// 流程图服务
export { GoJSDiagramService } from '../../../services/gojs-diagram.service';
export { FlowDiagramService } from '../../../services/flow-diagram.service';
export { FlowDragDropService } from '../../../services/flow-drag-drop.service';
export { FlowTouchService } from '../../../services/flow-touch.service';
export { FlowLinkService } from '../../../services/flow-link.service';
export { FlowDebugService } from '../../../services/flow-debug.service';
export { FlowDiagramConfigService } from '../../../services/flow-diagram-config.service';
export { FlowTaskOperationsService } from '../../../services/flow-task-operations.service';
export { LayoutService } from '../../../services/layout.service';
export { LineageColorService } from '../../../services/lineage-color.service';
export { MinimapMathService } from '../../../services/minimap-math.service';
export { ReactiveMinimapService } from '../../../services/reactive-minimap.service';
