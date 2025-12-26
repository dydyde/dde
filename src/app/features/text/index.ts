/**
 * Text Feature Module - 文本列表视图
 * 
 * 包含文本视图相关的组件和服务
 * 手机端默认进入文本列表视图
 */

// 主视图组件
export { TextViewComponent } from './components/text-view.component';

// 文本视图子组件
export { TextStagesComponent } from './components/text-stages.component';
export { TextStageCardComponent } from './components/text-stage-card.component';
export { TextTaskCardComponent } from './components/text-task-card.component';
export { TextTaskEditorComponent } from './components/text-task-editor.component';
export { TextTaskConnectionsComponent } from './components/text-task-connections.component';
export { TextUnassignedComponent } from './components/text-unassigned.component';
export { TextUnfinishedComponent } from './components/text-unfinished.component';
export { TextViewLoadingComponent } from './components/text-view-loading.component';
export { TextDeleteDialogComponent } from './components/text-delete-dialog.component';

// 文本视图服务
export { TextViewDragDropService } from './components/text-view-drag-drop.service';

// 类型定义
export type { 
  DragState,
  TouchDragState,
  DragExpandState,
  AutoScrollState,
  DropTargetInfo,
  UnfinishedItem,
  StageData,
  TaskConnection,
  TaskConnections
} from './components/text-view.types';
