import { AfterViewInit, Component, ElementRef, OnDestroy, inject, NgZone, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as go from 'gojs';
import { TaskStateService } from '../services/task-state.service';

@Component({
  selector: 'app-flowchart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flowchart-shell">
      <div #diagramDiv class="diagram-host"></div>
    </div>
  `,
  styles: [
    `
      :host,
      .flowchart-shell {
        display: block;
        width: 100%;
        height: 100%;
      }
      .diagram-host {
        width: 100%;
        height: 100%;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        background: #f8fafc;
        overflow: hidden;
      }
    `
  ]
})
export class FlowchartComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv', { static: true }) private diagramRef!: ElementRef<HTMLDivElement>;

  private readonly taskState = inject(TaskStateService);
  private readonly zone = inject(NgZone);
  private diagram: go.Diagram | null = null;
  private lastStructureKey: string | null = null;

  constructor() {
    // Reactive bridge: synchronize service graph projection into GoJS without rebuilding the model.
    effect(() => {
      const payload = this.taskState.graphView();
      if (!this.diagram) return;
      const model = this.diagram.model as go.GraphLinksModel;
      const nodeData = payload.nodes.map(n => ({ key: n.id, label: n.label, stageId: n.stageId }));
      const linkData = payload.edges.map(e => ({
        key: `${e.source}->${e.target}`,
        from: e.source,
        to: e.target
      }));

      this.diagram.startTransaction('sync-graph');

      model.mergeNodeDataArray(nodeData);
      model.mergeLinkDataArray(linkData);

      // Remove stale nodes/links not present anymore.
      const nodeKeys = new Set(payload.nodes.map(n => n.id));
      const linkKeys = new Set(payload.edges.map(e => `${e.source}->${e.target}`));

      model.nodeDataArray
        .filter((n: any) => !nodeKeys.has((n as any).key))
        .forEach((n: any) => model.removeNodeData(n));

      model.linkDataArray
        .filter((l: any) => !linkKeys.has((l as any).key))
        .forEach((l: any) => model.removeLinkData(l));

      this.diagram.commitTransaction('sync-graph');

      const structureKey = `${Array.from(nodeKeys).sort().join('|')}::${Array.from(linkKeys)
        .sort()
        .join('|')}`;
      if (this.lastStructureKey !== structureKey) {
        this.diagram.layoutDiagram(true);
        this.lastStructureKey = structureKey;
      }
    });
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      const $ = go.GraphObject.make;
      this.diagram = $(go.Diagram, this.diagramRef.nativeElement, {
        layout: $(go.TreeLayout, { angle: 0, layerSpacing: 50 }),
        'undoManager.isEnabled': false,
        allowDrop: true
      });
      // Prevent automatic re-layout on every data change; we'll trigger layout manually when structure changes.
      const treeLayout = this.diagram.layout as go.TreeLayout;
      treeLayout.isOngoing = false;
      treeLayout.isInitial = false;

      this.diagram.nodeTemplate = $(
        go.Node,
        'Auto',
        {
          mouseDragEnter: (_e: go.InputEvent, node: any) => this.highlight(node as go.Node, true),
          mouseDragLeave: (_e: go.InputEvent, node: any) => this.highlight(node as go.Node, false),
          mouseDrop: (e: go.InputEvent, node: any) => this.handleNodeDrop(e, node as go.Node)
        },
        $(
          go.Shape,
          'RoundedRectangle',
          {
            name: 'SHAPE',
            portId: '',
            fromLinkable: true,
            toLinkable: true,
            cursor: 'pointer',
            stroke: '#cbd5e1',
            strokeWidth: 1.2,
            fill: '#fff'
          },
          new go.Binding('fill', 'stageId', (stage: any) => this.stageColor(stage))
        ),
        $(
          go.TextBlock,
          {
            margin: 8,
            font: '12px "Inter", Arial, sans-serif',
            stroke: '#0f172a',
            wrap: go.TextBlock.WrapFit,
            width: 160,
            pickable: false
          },
          new go.Binding('text', 'label')
        )
      );

      this.diagram.linkTemplate = $(
        go.Link,
        {
          routing: go.Link.Orthogonal,
          corner: 8,
          toShortLength: 4
        },
        $(go.Shape, { stroke: '#94a3b8', strokeWidth: 1.2 })
      );

      this.diagram.model = new go.GraphLinksModel([], [], { linkKeyProperty: 'key' });

      this.diagram.mouseDrop = (e: go.InputEvent) => this.handleDiagramDrop(e);
      this.diagram.addDiagramListener('LinkDrawn', e => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', e => this.handleLinkGesture(e));
    });
  }

  ngOnDestroy(): void {
    if (this.diagram) {
      this.diagram.div = null as any;
      this.diagram = null;
    }
  }

  private stageColor(stageId: string): string {
    const palette = ['#e0f2fe', '#dcfce7', '#fef9c3', '#ffe4e6', '#ede9fe', '#f1f5f9'];
    const idx = Math.abs(this.hash(stageId)) % palette.length;
    return palette[idx];
  }

  private hash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) {
      h = (h << 5) - h + value.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  private highlight(node: go.Node, active: boolean) {
    const shape = node.findObject('SHAPE') as go.Shape | null;
    if (!shape) return;
    shape.stroke = active ? '#f97316' : '#cbd5e1';
    shape.strokeWidth = active ? 2 : 1.2;
  }

  private handleNodeDrop(e: go.InputEvent, targetNode: go.Node) {
    if (!this.diagram) return;
    const dragged = this.diagram.selection.first();
    if (!(dragged instanceof go.Node)) return;
    const childKey = dragged.data?.key as string | undefined;
    const parentKey = targetNode.data?.key as string | undefined;
    if (!childKey || !parentKey) return;
    e.handled = true;
    this.highlight(targetNode, false);
    this.taskState.moveTask(childKey, parentKey, dragged.data.stageId, 0);
  }

  private handleDiagramDrop(e: go.InputEvent) {
    if (!this.diagram) return;
    const dragged = this.diagram.selection.first();
    if (!(dragged instanceof go.Node)) return;
    const childKey = dragged.data?.key as string | undefined;
    if (!childKey) return;
    this.taskState.moveTask(childKey, null, dragged.data.stageId, 0);
  }

  private handleLinkGesture(e: go.DiagramEvent) {
    if (!this.diagram) return;
    const link = e.subject as go.Link;
    const fromNode = link.fromNode;
    const toNode = link.toNode;
    if (!fromNode || !toNode) return;
    const parentId = fromNode.data?.key as string | undefined;
    const childId = toNode.data?.key as string | undefined;
    const childStage = toNode.data?.stageId ?? fromNode.data?.stageId;
    if (!parentId || !childId || !childStage) return;

    console.log('Link gesture', { parentId, childId });

    // Remove the temporary link; service is the source of truth.
    this.diagram.remove(link);
    this.zone.run(() => {
      this.taskState.moveTask(childId, parentId, childStage, 0);
    });
  }
}
