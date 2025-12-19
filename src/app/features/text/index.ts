/**
 * Text Feature Module - 文本列表视图
 * 
 * 包含文本视图相关的组件和服务
 * 手机端默认进入文本列表视图
 */

// 主视图组件
export { TextViewComponent } from '../../../components/text-view/text-view.component';

// 文本视图子组件
export { TextStagesComponent } from '../../../components/text-view/text-stages.component';
export { TextStageCardComponent } from '../../../components/text-view/text-stage-card.component';
export { TextTaskCardComponent } from '../../../components/text-view/text-task-card.component';
export { TextTaskEditorComponent } from '../../../components/text-view/text-task-editor.component';
export { TextTaskConnectionsComponent } from '../../../components/text-view/text-task-connections.component';
export { TextUnassignedComponent } from '../../../components/text-view/text-unassigned.component';
export { TextUnfinishedComponent } from '../../../components/text-view/text-unfinished.component';
export { TextViewLoadingComponent } from '../../../components/text-view/text-view-loading.component';
export { TextDeleteDialogComponent } from '../../../components/text-view/text-delete-dialog.component';
export { DeleteConfirmModalComponent } from '../../../components/text-view/delete-confirm-modal.component';

// 文本视图服务
export { TextViewDragDropService } from '../../../components/text-view/text-view-drag-drop.service';

// 类型定义
export type { TextViewState, TextViewDropTarget, TextViewDragData } from '../../../components/text-view/text-view.types';
