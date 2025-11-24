import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { TaskStateService, ViewTaskNode } from '../services/task-state.service';

@Component({
  selector: 'app-text-outline',
  standalone: true,
  imports: [CommonModule, DragDropModule],
  templateUrl: './text-outline.component.html'
})
export class TextOutlineComponent {
  private readonly taskState = inject(TaskStateService);
  readonly viewTree = this.taskState.viewTree;

  drop(event: CdkDragDrop<ViewTaskNode[]>, targetParentId: string | null) {
    const dragged = event.item.data as ViewTaskNode;
    const parentNode = targetParentId ? this.taskState.taskMap().get(targetParentId) : null;
    const newStageId = parentNode?.stageId ?? dragged.stageId;
    const newIndex = event.currentIndex;

    // Reorder or transfer are both expressed via moveTask; monotonic stage rules are enforced in the service.
    this.taskState.moveTask(dragged.id, targetParentId, newStageId, newIndex);
  }

  trackNode(_: number, node: ViewTaskNode) {
    return node.id;
  }

  listId(parentId: string | null) {
    return parentId ? `list-${parentId}` : 'list-root';
  }
}
