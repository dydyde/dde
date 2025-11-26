import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, effect, NgZone, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';

declare var go: any;

@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col h-full bg-[#F9F8F6] relative">
       
       <!-- Top Palette Area (Resizable) -->
       <div class="flex-none flex flex-col overflow-hidden transition-none" [style.height.px]="paletteHeight()">
           <!-- 1. 待完成区域 (To-Do) -->
           <div class="flex-none mx-4 mt-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-orange-50/60 border border-orange-100/50 backdrop-blur-sm z-10 relative">
               <div (click)="store.isFlowUnfinishedOpen.set(!store.isFlowUnfinishedOpen())" 
                    class="py-3 cursor-pointer flex justify-between items-center group select-none">
                   <span class="font-bold text-stone-800 text-sm flex items-center gap-3 tracking-tight">
                       <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
                       待办事项
                   </span>
                   <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnfinishedOpen()">▼</span>
               </div>
               
               @if (store.isFlowUnfinishedOpen()) {
                   <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                       <ul class="space-y-2">
                           @for (item of store.unfinishedItems(); track item.taskId + item.text) {
                               <li class="text-xs text-stone-600 flex items-center gap-3 bg-white/80 backdrop-blur-sm border border-stone-100/50 p-2 rounded-lg hover:border-orange-200 cursor-pointer group shadow-sm transition-all" (click)="centerOnNode(item.taskId)">
                                   <span class="w-1 h-1 rounded-full bg-stone-200 group-hover:bg-orange-400 transition-colors ml-1"></span>
                                   <span class="font-mono text-stone-400 text-[10px]">{{item.taskDisplayId}}</span>
                                   <span class="truncate flex-1 font-medium group-hover:text-stone-900 transition-colors">{{item.text}}</span>
                               </li>
                           }
                           @if (store.unfinishedItems().length === 0) {
                               <li class="text-xs text-stone-400 italic px-2 font-light">暂无待办</li>
                           }
                       </ul>
                   </div>
               }
           </div>

           <!-- 2. 待分配区域 (To-Assign) -->
           <div class="flex-none mx-4 mt-2 mb-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-teal-50/60 border border-teal-100/50 backdrop-blur-sm z-10 relative">
               <div (click)="store.isFlowUnassignedOpen.set(!store.isFlowUnassignedOpen())" 
                    class="py-3 cursor-pointer flex justify-between items-center group select-none">
                   <span class="font-bold text-stone-800 text-sm flex items-center gap-3 tracking-tight">
                       <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
                       待分配
                   </span>
                   <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnassignedOpen()">▼</span>
               </div>

               @if (store.isFlowUnassignedOpen()) {
                   <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                       <div class="flex flex-wrap gap-2" id="unassignedPalette">
                           @for (task of store.unassignedTasks(); track task.id) {
                               <div 
                                   draggable="true" 
                                   (dragstart)="onDragStart($event, task)"
                                   class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium hover:border-teal-300 hover:text-teal-700 cursor-grab shadow-sm transition-all active:scale-95 text-stone-500">
                                   {{task.title}}
                               </div>
                           }
                           <button (click)="createUnassigned()" class="px-3 py-1.5 bg-white/50 hover:bg-teal-50 text-stone-400 hover:text-teal-600 rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
                       </div>
                   </div>
               }
           </div>
       </div>

       <!-- Resizer Handle -->
       <div class="h-1.5 hover:h-2 bg-transparent hover:bg-stone-200 cursor-row-resize z-20 flex-shrink-0 relative group transition-all flex items-center justify-center"
            (mousedown)="startPaletteResize($event)">
            <div class="w-12 h-1 rounded-full bg-stone-200 group-hover:bg-stone-400 transition-colors"></div>
       </div>

       <!-- 3. 流程图区域 -->
       <div class="flex-1 relative overflow-hidden bg-[#F9F8F6] mt-0 mx-0 border-t border-stone-200/50">
           <!-- GoJS Diagram Div -->
           <div #diagramDiv class="absolute inset-0 w-full h-full z-0"></div>

           <!-- Zoom Controls -->
           <div class="absolute bottom-4 left-4 z-10 flex flex-col gap-2">
               <button (click)="zoomIn()" class="bg-white/90 backdrop-blur p-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600" title="放大">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                   </svg>
               </button>
               <button (click)="zoomOut()" class="bg-white/90 backdrop-blur p-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600" title="缩小">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
                   </svg>
               </button>
           </div>

           <!-- 4. 详情区域 (Floating Right) -->
           <div class="absolute top-6 right-0 bottom-6 z-20 flex pointer-events-none">
                <!-- Container for positioning -->
                <div class="relative flex h-full pointer-events-auto">
                    <!-- Toggle Button (Triangle) -->
                    <button (click)="store.isFlowDetailOpen.set(!store.isFlowDetailOpen())" 
                            class="absolute left-0 top-8 -translate-x-full bg-white/90 backdrop-blur border border-stone-200 border-r-0 rounded-l-lg p-2 shadow-sm hover:bg-white text-stone-400 hover:text-stone-600 transition-all z-30 flex items-center justify-center w-8 h-10 pl-2">
                        <span class="text-[10px] transition-transform duration-300" [class.rotate-180]="store.isFlowDetailOpen()">◀</span>
                    </button>

                    <!-- Content Panel -->
                    <div class="h-full bg-white/90 backdrop-blur-xl border-l border-stone-200/50 shadow-xl transition-all duration-500 ease-out overflow-hidden flex flex-col"
                         [class.w-0]="!store.isFlowDetailOpen()"
                         [class.w-80]="store.isFlowDetailOpen()"
                         [class.opacity-0]="!store.isFlowDetailOpen()"
                         [class.opacity-100]="store.isFlowDetailOpen()">
                        
                        <div class="p-6 border-b border-stone-100 flex justify-between items-center bg-transparent">
                            <h3 class="font-bold text-stone-800 tracking-tight text-sm">详情概览</h3>
                        </div>
                        
                        <div class="flex-1 overflow-y-auto p-6 space-y-6">
                            @if (store.activeProject(); as proj) {
                                <div class="space-y-2">
                                    <div class="text-[10px] font-bold text-stone-400 uppercase tracking-widest">项目信息</div>
                                    <div class="bg-transparent p-0">
                                        <div class="font-bold text-stone-800 mb-1 text-base">{{proj.name}}</div>
                                        <div class="text-xs text-stone-400 mb-2 font-mono">{{proj.createdDate | date:'yyyy-MM-dd'}}</div>
                                        <div class="text-sm text-stone-600 leading-relaxed font-light">{{proj.description}}</div>
                                    </div>
                                </div>
                            }
                            
                            <!-- Contextual Details (e.g. selected node) could go here -->
                            <div class="p-4 border border-dashed border-stone-200 rounded-lg text-center text-stone-400 text-xs font-light">
                                点击节点查看详情
                            </div>
                        </div>
                    </div>
                </div>
           </div>
       </div>
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  store = inject(StoreService);
    private readonly zone = inject(NgZone);
  
  private diagram: any;

  // Resizing State
  isResizingPalette = false;
  paletteHeight = signal(200); // Initial height for the top palette area
  private startY = 0;
  private startHeight = 0;

  constructor() {
      effect(() => {
          const tasks = this.store.tasks();
          if (this.diagram) {
              this.updateDiagram(tasks);
          }
      });
  }

  public refreshLayout() {
      if (this.diagram) {
          this.diagram.requestUpdate();
      }
  }

  zoomIn() {
      if (this.diagram) {
          this.diagram.commandHandler.increaseZoom();
      }
  }

  zoomOut() {
      if (this.diagram) {
          this.diagram.commandHandler.decreaseZoom();
      }
  }

  startPaletteResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingPalette = true;
      this.startY = e.clientY;
      this.startHeight = this.paletteHeight();
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      
      const onMove = (ev: MouseEvent) => {
          if (!this.isResizingPalette) return;
          const delta = ev.clientY - this.startY;
          const newHeight = Math.max(100, Math.min(600, this.startHeight + delta));
          this.paletteHeight.set(newHeight);
      };
      
      const onUp = () => {
          this.isResizingPalette = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  }

  ngAfterViewInit() {
      this.initDiagram();
  }

  initDiagram() {
      if (typeof go === 'undefined') {
          console.warn('GoJS not loaded');
          return;
      }
      const $ = go.GraphObject.make;

      this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          "undoManager.isEnabled": true,
          "animationManager.isEnabled": true,
          "allowDrop": true, // accept drops from HTML
          layout: $(go.LayeredDigraphLayout, { 
              direction: 0, 
              layerSpacing: 100, 
              columnSpacing: 40,
              setsPortSpots: false 
          })
      });

      // Helper to create ports
      function makePort(name: string, spot: any, output: boolean, input: boolean) {
        return $(go.Shape, "Circle",
          {
            fill: "transparent",
            stroke: null,
            desiredSize: new go.Size(10, 10),
            alignment: spot,
            alignmentFocus: spot,
            portId: name,
            fromLinkable: output,
            toLinkable: input,
            cursor: "pointer",
            fromSpot: spot,
            toSpot: spot,
            mouseEnter: (e: any, port: any) => { if (!e.diagram.isReadOnly) port.fill = "#a8a29e"; },
            mouseLeave: (e: any, port: any) => port.fill = "transparent"
          });
      }

      // Node Template
      this.diagram.nodeTemplate =
          $(go.Node, "Spot",
            { 
                locationSpot: go.Spot.Center,
                selectionAdorned: true,
                click: (e: any, node: any) => {
                    if (e.diagram.lastInput.dragging) return;
                    // component.handleNodeSelect(node.data.key, false);
                },
                doubleClick: (e: any, node: any) => {
                    this.store.isFlowDetailOpen.set(true); // Auto open details on double click
                }
            },
            new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
            
            // Main Content
            $(go.Panel, "Auto",
                { width: 200 }, // Fixed width
                $(go.Shape, "RoundedRectangle", 
                  { 
                      fill: "white", 
                      stroke: "#e7e5e4", 
                      strokeWidth: 1, 
                      parameter1: 10,
                      // Make the body NOT linkable, so it's draggable
                      portId: "", 
                      fromLinkable: false, 
                      toLinkable: false, 
                      cursor: "move" 
                  },
                  new go.Binding("fill", "color"),
                  new go.Binding("stroke", "isSelected", (s: boolean) => s ? "#a8a29e" : "#e7e5e4").ofObject()
                ),
                $(go.Panel, "Vertical", { margin: 16 },
                    $(go.TextBlock, { font: "bold 10px monospace", stroke: "#a8a29e", alignment: go.Spot.Left },
                        new go.Binding("text", "displayId")),
                    $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "500 13px sans-serif", stroke: "#44403c", maxSize: new go.Size(160, NaN) },
                        new go.Binding("text", "title"))
                )
            ),

            // Ports
            makePort("T", go.Spot.Top, true, true),
            makePort("L", go.Spot.Left, true, true),
            makePort("R", go.Spot.Right, true, true),
            makePort("B", go.Spot.Bottom, true, true)
          );

      // Link Template
      this.diagram.linkTemplate =
          $(go.Link, 
            { 
                routing: go.Link.AvoidsNodes, 
                curve: go.Link.JumpOver, 
                corner: 12,
                toShortLength: 4,
                relinkableFrom: true,
                relinkableTo: true,
                reshapable: true,
                resegmentable: true
            },
            // Transparent fat line for easier selection
            $(go.Shape, { isPanelMain: true, strokeWidth: 8, stroke: "transparent" }),
            // Visible line
            $(go.Shape, { isPanelMain: true, strokeWidth: 2, stroke: "#94a3b8" }),
            // Arrowhead
            $(go.Shape, { toArrow: "Standard", stroke: null, fill: "#94a3b8", scale: 1.2 })
          );

      // Initialize model with linkKeyProperty for proper merging
      this.diagram.model = new go.GraphLinksModel([], [], { 
          linkKeyProperty: 'key',
          nodeKeyProperty: 'key'
      });

      // Handle External Drops
      this.diagram.div.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          // Highlight logic could go here
      });

      this.diagram.div.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          const data = e.dataTransfer?.getData("text");
          if (data) {
             const task = JSON.parse(data);
             // Logic to add task to stage?
             // Prompt says: "Dragging to a node (stage) renders them in flow".
             // Here we drop onto canvas.
             // Let's assign it a stage based on drop, or just make it active (Stage 1 default if dropped on blank?)
             // We'll verify if dropped on existing node?
             
             const pt = this.diagram.lastInput.viewPoint;
             const loc = this.diagram.transformViewToDoc(pt);
             
             // Update task in store
             // We assume dropping on canvas assigns it to stage 1 for now to show it.
             this.store.moveTaskToStage(task.id, 1);
          }
      });

      this.diagram.addDiagramListener('LinkDrawn', (e: any) => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', (e: any) => this.handleLinkGesture(e));
  }

  updateDiagram(tasks: Task[]) {
      if (!this.diagram) return;
      
      const model = this.diagram.model;
      if (!model) return;
      
      // Build a map of existing node locations to preserve user's manual positioning
      const existingLocations = new Map<string, string>();
      (model as any).nodeDataArray.forEach((n: any) => {
          if (n.key && n.loc) {
              existingLocations.set(n.key, n.loc);
          }
      });
      
      const nodeDataArray: any[] = [];
      const linkDataArray: any[] = [];

      tasks.filter(t => t.stage !== null).forEach(t => {
          // Preserve existing location if node was already rendered, otherwise use store coordinates
          const existingLoc = existingLocations.get(t.id);
          nodeDataArray.push({
              key: t.id,
              title: t.title,
              displayId: t.displayId,
              stage: t.stage, // Add stage info for drag computation
              loc: existingLoc || `${t.x} ${t.y}`,
              color: t.status === 'completed' ? '#f0fdf4' : 'white',
              isSelected: false // handled by diagram selection
          });
          
          if (t.parentId) {
              linkDataArray.push({ 
                  key: `${t.parentId}-${t.id}`,
                  from: t.parentId, 
                  to: t.id 
              });
          }
      });

      this.diagram.startTransaction('update');
      
      // Skip layout temporarily to prevent view reset
      this.diagram.skipsUndoManager = true;
      
      // Use merge methods to preserve diagram state (zoom, pan, etc.)
      (model as any).mergeNodeDataArray(nodeDataArray);
      (model as any).mergeLinkDataArray(linkDataArray);
      
      // Remove stale nodes/links not present anymore
      const nodeKeys = new Set(nodeDataArray.map(n => n.key));
      const linkKeys = new Set(linkDataArray.map(l => l.key));
      
      (model as any).nodeDataArray
        .filter((n: any) => !nodeKeys.has(n.key))
        .forEach((n: any) => (model as any).removeNodeData(n));
      
      (model as any).linkDataArray
        .filter((l: any) => !linkKeys.has(l.key))
        .forEach((l: any) => (model as any).removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
  }

  createUnassigned() {
      this.store.addTask('新任务', '', null, null, false);
  }

  onDragStart(event: DragEvent, task: Task) {
      if (event.dataTransfer) {
          event.dataTransfer.setData("text", JSON.stringify(task));
          event.dataTransfer.effectAllowed = "move";
      }
  }

  centerOnNode(taskId: string) {
      if (!this.diagram) return;
      const node = this.diagram.findNodeForKey(taskId);
      if (node) {
          this.diagram.centerRect(node.actualBounds);
          this.diagram.select(node);
      }
  }

  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent) {
      if (!this.diagram) return;
      if (!event.altKey || event.key.toLowerCase() !== 'z') return;

      const targets: string[] = [];
      const it = this.diagram.selection?.iterator;
      if (it) {
          while (it.next()) {
              const part = it.value;
              const key = part?.data?.key;
              const isNode = typeof go !== 'undefined' ? part instanceof go.Node : !part?.category;
              if (isNode && key) {
                  targets.push(key);
              }
          }
      }

      if (!targets.length) return;
      event.preventDefault();
      event.stopPropagation();

      this.zone.run(() => {
          targets.forEach(id => this.store.detachTask(id));
      });
  }

    private handleLinkGesture(e: any) {
            if (!this.diagram) return;
            const link = e.subject;
            const fromNode = link?.fromNode;
            const toNode = link?.toNode;
            const parentId = fromNode?.data?.key;
            const childId = toNode?.data?.key;
            if (!parentId || !childId || parentId === childId) return;

            const parentStage = typeof fromNode.data?.stage === 'number' ? fromNode.data.stage : null;
            const childStage = typeof toNode.data?.stage === 'number' ? toNode.data.stage : null;
            const nextStage = parentStage !== null ? parentStage + 1 : (childStage ?? 1);

            this.diagram.remove(link);
            this.zone.run(() => {
                    this.store.moveTaskToStage(childId, nextStage, undefined, parentId);
            });
    }
}
