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
}
