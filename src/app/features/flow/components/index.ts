/**
 * Flow Components barrel export
 * 流程图相关组件导出
 */

// 主视图组件
export { FlowViewComponent } from './flow-view.component';

// 工具栏组件
export { FlowToolbarComponent } from './flow-toolbar.component';
export { FlowPaletteComponent } from './flow-palette.component';

// 任务详情组件
export { FlowTaskDetailComponent } from './flow-task-detail.component';

// 删除确认组件
export { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';

// 连接线相关组件
export { FlowLinkTypeDialogComponent } from './flow-link-type-dialog.component';
export type { LinkTypeDialogData } from './flow-link-type-dialog.component';

export { FlowConnectionEditorComponent } from './flow-connection-editor.component';
export type { ConnectionEditorData, ConnectionTasks } from './flow-connection-editor.component';

export { FlowLinkDeleteHintComponent } from './flow-link-delete-hint.component';

// 级联分配对话框
export { FlowCascadeAssignDialogComponent } from './flow-cascade-assign-dialog.component';
export type { CascadeAssignDialogData } from './flow-cascade-assign-dialog.component';

// 类型导出
export type { LinkDeleteHint } from '../../../../models/flow-view-state';
