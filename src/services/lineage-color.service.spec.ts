import { TestBed } from '@angular/core/testing';
import { LineageColorService, LineageNodeData, LineageLinkData } from './lineage-color.service';
import { Task } from '../models';
import { GoJSNodeData, GoJSLinkData } from '../app/features/flow/services/flow-diagram-config.service';

describe('LineageColorService', () => {
  let service: LineageColorService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [LineageColorService]
    });
    service = TestBed.inject(LineageColorService);
  });

  describe('血缘追溯', () => {
    it('应正确识别始祖节点', () => {
      // 创建测试任务树：
      // 任务1 (root)
      //   ├── 任务1.a
      //   │     └── 任务1.a.1
      //   └── 任务1.b
      // 任务2 (root)
      //   └── 任务2.a
      const tasks: Task[] = [
        createTask('task-1', null, '任务1'),
        createTask('task-1a', 'task-1', '任务1.a'),
        createTask('task-1a1', 'task-1a', '任务1.a.1'),
        createTask('task-1b', 'task-1', '任务1.b'),
        createTask('task-2', null, '任务2'),
        createTask('task-2a', 'task-2', '任务2.a'),
      ];

      const nodeData = tasks.map(t => createNodeData(t.id));
      const linkData = tasks.filter(t => t.parentId).map(t => createLinkData(t.parentId!, t.id));

      const result = service.preprocessDiagramData(nodeData, linkData, tasks);

      // 验证始祖索引
      expect(getNodeByKey(result.nodeDataArray, 'task-1')?.rootAncestorIndex).toBe(0);
      expect(getNodeByKey(result.nodeDataArray, 'task-1a')?.rootAncestorIndex).toBe(0);
      expect(getNodeByKey(result.nodeDataArray, 'task-1a1')?.rootAncestorIndex).toBe(0);
      expect(getNodeByKey(result.nodeDataArray, 'task-1b')?.rootAncestorIndex).toBe(0);
      expect(getNodeByKey(result.nodeDataArray, 'task-2')?.rootAncestorIndex).toBe(1);
      expect(getNodeByKey(result.nodeDataArray, 'task-2a')?.rootAncestorIndex).toBe(1);
    });

    it('同一家族应有相同的 familyColor', () => {
      const tasks: Task[] = [
        createTask('task-1', null, '任务1'),
        createTask('task-1a', 'task-1', '任务1.a'),
        createTask('task-1b', 'task-1', '任务1.b'),
      ];

      const nodeData = tasks.map(t => createNodeData(t.id));
      const linkData = tasks.filter(t => t.parentId).map(t => createLinkData(t.parentId!, t.id));

      const result = service.preprocessDiagramData(nodeData, linkData, tasks);

      const color1 = getNodeByKey(result.nodeDataArray, 'task-1')?.familyColor;
      const color1a = getNodeByKey(result.nodeDataArray, 'task-1a')?.familyColor;
      const color1b = getNodeByKey(result.nodeDataArray, 'task-1b')?.familyColor;

      expect(color1).toBe(color1a);
      expect(color1a).toBe(color1b);
    });

    it('不同家族应有不同的 familyColor', () => {
      const tasks: Task[] = [
        createTask('task-1', null, '任务1'),
        createTask('task-2', null, '任务2'),
        createTask('task-3', null, '任务3'),
      ];

      const nodeData = tasks.map(t => createNodeData(t.id));
      const linkData: GoJSLinkData[] = [];

      const result = service.preprocessDiagramData(nodeData, linkData, tasks);

      const color1 = getNodeByKey(result.nodeDataArray, 'task-1')?.familyColor;
      const color2 = getNodeByKey(result.nodeDataArray, 'task-2')?.familyColor;
      const color3 = getNodeByKey(result.nodeDataArray, 'task-3')?.familyColor;

      expect(color1).not.toBe(color2);
      expect(color2).not.toBe(color3);
      expect(color1).not.toBe(color3);
    });

    it('连线应继承源节点的家族颜色', () => {
      const tasks: Task[] = [
        createTask('task-1', null, '任务1'),
        createTask('task-1a', 'task-1', '任务1.a'),
      ];

      const nodeData = tasks.map(t => createNodeData(t.id));
      const linkData: GoJSLinkData[] = [
        createLinkData('task-1', 'task-1a')
      ];

      const result = service.preprocessDiagramData(nodeData, linkData, tasks);

      const nodeColor = getNodeByKey(result.nodeDataArray, 'task-1')?.familyColor;
      const linkColor = getLinkByKey(result.linkDataArray, 'task-1-task-1a')?.familyColor;

      expect(linkColor).toBe(nodeColor);
    });
  });

  describe('HSL 颜色生成', () => {
    it('应生成有效的颜色字符串（HEX 或 HSL）', () => {
      const color = service.generateFamilyColor(0, 5);
      expect(color).toMatch(/^(#([0-9a-fA-F]{6})|hsl\(\d+,\s*85%,\s*55%\))$/);
    });

    it('颜色应具有确定性（同样的输入产生同样的输出）', () => {
      const color1 = service.generateFamilyColor(3, 10);
      const color2 = service.generateFamilyColor(3, 10);
      expect(color1).toBe(color2);
    });

    it('不同索引应产生不同颜色', () => {
      const colors = [0, 1, 2, 3, 4].map(i => service.generateFamilyColor(i, 5));
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(5);
    });
  });

  describe('颜色转换', () => {
    it('hslToHex 应正确转换', () => {
      const hex = service.hslToHex('hsl(0, 100%, 50%)');
      expect(hex.toLowerCase()).toBe('#ff0000'); // 纯红色
    });

    it('getLighterFamilyColor 应增加亮度', () => {
      const original = 'hsl(180, 70%, 50%)';
      const lighter = service.getLighterFamilyColor(original);
      expect(lighter).toMatch(/hsl\(180, 70%, 70%\)/);
    });

    it('getDarkerFamilyColor 应降低亮度', () => {
      const original = 'hsl(180, 70%, 50%)';
      const darker = service.getDarkerFamilyColor(original);
      expect(darker).toMatch(/hsl\(180, 70%, 35%\)/);
    });
  });
});

// ========== 测试辅助函数 ==========

function createTask(id: string, parentId: string | null, title: string): Task {
  return {
    id,
    parentId,
    title,
    content: '',
    stage: parentId ? 2 : 1,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: id
  };
}

function createNodeData(key: string): GoJSNodeData {
  return {
    key,
    title: key,
    displayId: key,
    stage: 1,
    loc: '0 0',
    color: '#ffffff',
    borderColor: '#000000',
    borderWidth: 1,
    titleColor: '#000000',
    displayIdColor: '#888888',
    selectedBorderColor: '#0000ff',
    isUnassigned: false,
    isSearchMatch: false,
    isSelected: false
  };
}

function createLinkData(from: string, to: string): GoJSLinkData {
  return {
    key: `${from}-${to}`,
    from,
    to,
    isCrossTree: false
  };
}

function getNodeByKey(nodes: LineageNodeData[], key: string): LineageNodeData | undefined {
  return nodes.find(n => n.key === key);
}

function getLinkByKey(links: LineageLinkData[], key: string): LineageLinkData | undefined {
  return links.find(l => l.key === key);
}
