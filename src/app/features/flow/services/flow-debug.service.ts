import { Injectable } from '@angular/core';

/**
 * 流程图调试服务
 * 提供调试工具，帮助诊断连接线和节点配置问题
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDebugService {

  /**
   * 检查所有连接线的配置
   */
  inspectLinks(diagram: any): void {
    if (!diagram) {
      console.error('❌ diagram 对象不存在');
      return;
    }
    
    console.log('========== 连接线检查 ==========');
    
    const links: any[] = [];
    let problemCount = 0;
    
    diagram.links.each((link: any) => {
      const info = {
        key: link.data.key,
        from: link.data.from,
        to: link.data.to,
        fromPortId: link.fromPortId,
        toPortId: link.toPortId,
        fromSpot: link.fromSpot.toString(),
        toSpot: link.toSpot.toString(),
        hasGetLinkPoint: typeof link.getLinkPoint === 'function',
        routing: link.routing,
        curve: link.curve
      };
      links.push(info);
      
      console.log(`连接线 ${info.key}:`, info);
      
      // 检查问题
      if (info.fromPortId !== "") {
        console.warn(`  ⚠️ fromPortId 应该是空字符串，当前是: "${info.fromPortId}"`);
        problemCount++;
      }
      if (info.toPortId !== "") {
        console.warn(`  ⚠️ toPortId 应该是空字符串，当前是: "${info.toPortId}"`);
        problemCount++;
      }
      if (!info.fromSpot.includes('AllSides') && !info.fromSpot.includes('NaN')) {
        console.warn(`  ⚠️ fromSpot 应该是 AllSides，当前是: ${info.fromSpot}`);
        problemCount++;
      }
      if (!info.hasGetLinkPoint) {
        console.warn(`  ⚠️ 缺少 getLinkPoint 函数`);
        problemCount++;
      }
    });
    
    console.log(`========================================`);
    console.log(`共检查 ${links.length} 条连接线`);
    if (problemCount > 0) {
      console.warn(`发现 ${problemCount} 个问题`);
      console.log('建议运行: flowDebugService.fixAllLinks(diagram)');
    } else {
      console.log('✅ 所有连接线配置正确！');
    }
  }

  /**
   * 修复所有连接线，使用主端口
   */
  fixAllLinks(diagram: any): void {
    if (!diagram) {
      console.error('❌ diagram 对象不存在');
      return;
    }
    
    console.log('========== 开始修复连接线 ==========');
    
    diagram.startTransaction('修复连接线端口');
    
    let fixedCount = 0;
    diagram.links.each((link: any) => {
      let needsFix = false;
      
      // 检查数据层
      if (link.data.fromPortId !== "" || link.data.toPortId !== "") {
        diagram.model.setDataProperty(link.data, 'fromPortId', '');
        diagram.model.setDataProperty(link.data, 'toPortId', '');
        needsFix = true;
      }
      
      // 检查对象层
      if (link.fromPortId !== "" || link.toPortId !== "") {
        link.fromPortId = "";
        link.toPortId = "";
        needsFix = true;
      }
      
      // 强制刷新路由
      if (needsFix) {
        link.invalidateRoute();
        fixedCount++;
        console.log(`✅ 修复连接线: ${link.data.key}`);
      }
    });
    
    diagram.commitTransaction('修复连接线端口');
    
    console.log(`========== 完成，共修复 ${fixedCount} 条连接线 ==========`);
    
    // 重新检查
    setTimeout(() => {
      console.log('\n重新检查结果：');
      this.inspectLinks(diagram);
    }, 100);
  }

  /**
   * 检查节点端口配置
   */
  inspectNodePorts(diagram: any): void {
    if (!diagram) {
      console.error('❌ diagram 对象不存在');
      return;
    }
    
    const firstNode = diagram.nodes.first();
    if (!firstNode) {
      console.error('❌ 图表中没有节点');
      return;
    }
    
    console.log('========== 节点端口检查 ==========');
    console.log('节点 key:', firstNode.data.key);
    
    // 检查主端口
    const mainPort = firstNode.findPort("");
    if (mainPort) {
      console.log('✅ 找到主端口 (portId: "")');
      console.log('  - fromLinkable:', mainPort.fromLinkable);
      console.log('  - toLinkable:', mainPort.toLinkable);
      console.log('  - fromSpot:', mainPort.fromSpot.toString());
      console.log('  - toSpot:', mainPort.toSpot.toString());
      
      if (!mainPort.toLinkable) {
        console.warn('  ⚠️ toLinkable 应该是 true');
      }
      if (!mainPort.fromSpot.toString().includes('AllSides') && !mainPort.fromSpot.toString().includes('NaN')) {
        console.warn('  ⚠️ fromSpot 应该是 AllSides');
      }
      if (!mainPort.toSpot.toString().includes('AllSides') && !mainPort.toSpot.toString().includes('NaN')) {
        console.warn('  ⚠️ toSpot 应该是 AllSides');
      }
    } else {
      console.error('❌ 未找到主端口！这是严重问题！');
    }
    
    // 检查边缘端口
    const edgePorts = ['T', 'B', 'L', 'R'];
    let edgePortCount = 0;
    edgePorts.forEach(portId => {
      const port = firstNode.findPort(portId);
      if (port) {
        edgePortCount++;
        console.log(`✅ 找到边缘端口 "${portId}"`);
        console.log(`  - fromLinkable: ${port.fromLinkable}`);
        console.log(`  - toLinkable: ${port.toLinkable}`);
        console.log(`  - fromSpot: ${port.fromSpot.toString()}`);
        console.log(`  - toSpot: ${port.toSpot.toString()}`);
        
        // 验证边缘端口不应该有 AllSides
        if (port.fromSpot.toString().includes('AllSides') || port.fromSpot.toString().includes('NaN')) {
          console.error(`  ❌ 边缘端口 "${portId}" 不应该有 AllSides！会在端口边界打转！`);
        }
        if (port.fromSpot.toString().includes('None') || port.fromSpot.toString() === 'Spot(0,0,0,0)') {
          console.log(`  ✅ 正确：fromSpot 是 None，不在端口边界计算`);
        }
      }
    });
    
    if (edgePortCount === 0) {
      console.warn('⚠️ 未找到任何边缘端口（T/B/L/R）');
    }
    
    // 检查 BODY 面板
    const bodyPanel = firstNode.findObject("BODY");
    if (bodyPanel) {
      console.log('✅ 找到 BODY 面板');
      const bounds = bodyPanel.getDocumentBounds();
      console.log('  - bounds:', bounds.toString());
      console.log('  - width:', bounds.width);
      console.log('  - height:', bounds.height);
      
      if (bounds.width < 50) {
        console.error('  ❌ BODY 面板太小，可能获取的是端口而不是主面板！');
      } else {
        console.log('  ✅ BODY 面板尺寸正常（应该是整个节点）');
      }
    } else {
      console.warn('⚠️ 未找到 BODY 面板（会使用节点边界作为后备）');
      console.log('  - actualBounds:', firstNode.actualBounds.toString());
    }
    
    console.log('========================================');
  }

  /**
   * 显示测试说明
   */
  showTestInstructions(): void {
    console.log('========== 边界滑动效果测试说明 ==========');
    console.log('1. 点击任意节点边缘的小圆点（T/B/L/R）');
    console.log('2. 拖动鼠标画圈或移动');
    console.log('3. 观察连接线起点是否沿着节点边界滑动');
    console.log('');
    console.log('✅ 正确：起点沿着矩形边界移动（水珠滑动效果）');
    console.log('❌ 错误：起点固定在小圆点上不动');
    console.log('');
    console.log('如果效果不对，请运行：');
    console.log('  flowDebugService.inspectLinks(diagram)');
    console.log('  flowDebugService.fixAllLinks(diagram)');
    console.log('========================================');
  }

  /**
   * 导出到全局对象（便于在控制台调试）
   */
  exposeToWindow(diagram: any): void {
    (window as any).flowDebug = {
      inspectLinks: () => this.inspectLinks(diagram),
      fixAllLinks: () => this.fixAllLinks(diagram),
      inspectNodePorts: () => this.inspectNodePorts(diagram),
      test: () => this.showTestInstructions(),
      diagram: diagram
    };
    
    console.log('========== 调试工具已加载 ==========');
    console.log('可用命令（在浏览器控制台运行）：');
    console.log('  flowDebug.inspectLinks()     - 检查所有连接线');
    console.log('  flowDebug.fixAllLinks()      - 修复所有连接线端口');
    console.log('  flowDebug.inspectNodePorts() - 检查节点端口配置');
    console.log('  flowDebug.test()             - 显示测试说明');
    console.log('========================================');
  }

  /**
   * 启用小地图调试模式
   * 在控制台执行：flowDebug.enableMinimapDebug()
   * 
   * 调试信息包括：
   * - fixedBounds: 小地图的世界边界
   * - viewportBounds: 主图视口边界
   * - overview.scale: 当前缩放比例
   * - isViewportOutside: 视口是否超出内容边界
   * - box.actualBounds: 视口框在小地图中的实际位置
   */
  enableMinimapDebug(overview?: any, diagram?: any): void {
    // 启用 Overview 调试日志
    (globalThis as any).__NF_OVERVIEW_DEBUG = true;
    
    console.log('========== 小地图调试模式已启用 ==========');
    console.log('调试日志将在 Overview 更新时输出（每 1000ms 最多一次）');
    console.log('');
    console.log('手动检查当前状态：');
    console.log('  flowDebug.inspectMinimap()');
    console.log('');
    console.log('禁用调试模式：');
    console.log('  flowDebug.disableMinimapDebug()');
    console.log('==========================================');
    
    // 如果提供了 overview 和 diagram，立即输出当前状态
    if (overview && diagram) {
      this.inspectMinimap(overview, diagram);
    }
  }

  /**
   * 禁用小地图调试模式
   */
  disableMinimapDebug(): void {
    (globalThis as any).__NF_OVERVIEW_DEBUG = false;
    console.log('小地图调试模式已禁用');
  }

  /**
   * 检查小地图当前状态
   * 输出关键诊断信息
   */
  inspectMinimap(overview?: any, diagram?: any): void {
    console.log('========== 小地图状态检查 ==========');
    
    if (!overview || !diagram) {
      console.log('使用方法：flowDebug.inspectMinimap(overview, diagram)');
      console.log('或者：在 FlowDiagramService 中调用 exposeMinimapToDebug()');
      console.log('');
      console.log('快捷方式（如果已暴露）：');
      console.log('  flowDebug.inspectMinimap(flowDebug.overview, flowDebug.diagram)');
      return;
    }
    
    try {
      const viewportBounds = diagram.viewportBounds;
      const documentBounds = diagram.documentBounds;
      const fixedBounds = overview.fixedBounds;
      const scale = overview.scale;
      const box = overview.box;
      
      console.log('1. 主图视口 (viewportBounds):');
      console.log(`   x: ${Math.round(viewportBounds.x)}, y: ${Math.round(viewportBounds.y)}`);
      console.log(`   width: ${Math.round(viewportBounds.width)}, height: ${Math.round(viewportBounds.height)}`);
      
      console.log('');
      console.log('2. 主图内容边界 (documentBounds):');
      console.log(`   x: ${Math.round(documentBounds.x)}, y: ${Math.round(documentBounds.y)}`);
      console.log(`   width: ${Math.round(documentBounds.width)}, height: ${Math.round(documentBounds.height)}`);
      
      console.log('');
      console.log('3. 小地图世界边界 (fixedBounds):');
      if (fixedBounds && fixedBounds.isReal()) {
        console.log(`   x: ${Math.round(fixedBounds.x)}, y: ${Math.round(fixedBounds.y)}`);
        console.log(`   width: ${Math.round(fixedBounds.width)}, height: ${Math.round(fixedBounds.height)}`);
      } else {
        console.log('   未设置或无效');
      }
      
      console.log('');
      console.log('4. 小地图缩放 (scale):');
      console.log(`   ${scale.toFixed(6)}`);
      console.log(`   最小允许值: 1e-4 (0.0001)`);
      console.log(`   当前是否接近下限: ${scale < 0.001 ? '⚠️ 是，可能导致视口框消失' : '否'}`);
      
      console.log('');
      console.log('5. 视口框位置 (box):');
      if (box) {
        const boxBounds = box.actualBounds;
        console.log(`   x: ${Math.round(boxBounds.x)}, y: ${Math.round(boxBounds.y)}`);
        console.log(`   width: ${Math.round(boxBounds.width)}, height: ${Math.round(boxBounds.height)}`);
      } else {
        console.log('   box 未找到');
      }
      
      console.log('');
      console.log('6. 视口超界检测:');
      const isOutside = 
        viewportBounds.x < documentBounds.x - 50 ||
        viewportBounds.y < documentBounds.y - 50 ||
        viewportBounds.right > documentBounds.right + 50 ||
        viewportBounds.bottom > documentBounds.bottom + 50;
      console.log(`   isViewportOutside: ${isOutside ? '⚠️ 是' : '否'}`);
      if (isOutside) {
        console.log('   超界方向:');
        if (viewportBounds.x < documentBounds.x - 50) console.log('     - 左侧超界');
        if (viewportBounds.y < documentBounds.y - 50) console.log('     - 顶部超界');
        if (viewportBounds.right > documentBounds.right + 50) console.log('     - 右侧超界');
        if (viewportBounds.bottom > documentBounds.bottom + 50) console.log('     - 底部超界');
      }
      
      console.log('');
      console.log('=========================================');
    } catch (error) {
      console.error('检查失败:', error);
    }
  }

  /**
   * 扩展 exposeToWindow，添加小地图调试功能
   */
  exposeToWindowWithMinimap(diagram: any, overview?: any): void {
    (window as any).flowDebug = {
      inspectLinks: () => this.inspectLinks(diagram),
      fixAllLinks: () => this.fixAllLinks(diagram),
      inspectNodePorts: () => this.inspectNodePorts(diagram),
      test: () => this.showTestInstructions(),
      diagram: diagram,
      overview: overview,
      // 小地图调试
      enableMinimapDebug: () => this.enableMinimapDebug(overview, diagram),
      disableMinimapDebug: () => this.disableMinimapDebug(),
      inspectMinimap: () => this.inspectMinimap(overview, diagram)
    };
    
    console.log('========== 调试工具已加载（含小地图） ==========');
    console.log('可用命令（在浏览器控制台运行）：');
    console.log('');
    console.log('连接线调试：');
    console.log('  flowDebug.inspectLinks()     - 检查所有连接线');
    console.log('  flowDebug.fixAllLinks()      - 修复所有连接线端口');
    console.log('  flowDebug.inspectNodePorts() - 检查节点端口配置');
    console.log('');
    console.log('小地图调试：');
    console.log('  flowDebug.enableMinimapDebug()  - 启用调试日志');
    console.log('  flowDebug.disableMinimapDebug() - 禁用调试日志');
    console.log('  flowDebug.inspectMinimap()      - 检查当前状态');
    console.log('');
    console.log('=====================================================');
  }
}
