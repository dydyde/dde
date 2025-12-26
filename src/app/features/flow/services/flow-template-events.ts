/**
 * FlowTemplateEvents - 模板事件总线
 * 
 * 解耦 FlowTemplateService 和 FlowEventService 的桥梁
 * 
 * 设计说明：
 * - GoJS 的 raiseDiagramEvent 只支持内置事件名称
 * - 需要一个中间层让模板能发送自定义事件
 * - FlowEventService 设置回调，FlowTemplateService 触发回调
 * - 使用简单对象而不是 Service，避免循环依赖
 */

import * as go from 'gojs';

/**
 * 事件处理器类型
 */
export interface FlowTemplateEventHandlers {
  onNodeClick?: (node: go.Node) => void;
  onNodeDoubleClick?: (node: go.Node) => void;
  onLinkClick?: (link: go.Link) => void;
  onLinkDoubleClick?: (link: go.Link) => void;
  onLinkDeleteRequest?: (link: go.Link) => void;
  onCrossTreeLabelClick?: (link: go.Link, viewX: number, viewY: number) => void;
  onPortMouseEnter?: (port: go.GraphObject) => void;
  onPortMouseLeave?: (port: go.GraphObject) => void;
}

/**
 * 全局事件处理器存储
 * 
 * 用法：
 * 1. FlowEventService 在 setDiagram 时注册处理器
 * 2. FlowTemplateService 在模板中调用处理器
 */
export const flowTemplateEventHandlers: FlowTemplateEventHandlers = {};

/**
 * 事件名称常量（供日志使用）
 */
export const FLOW_TEMPLATE_EVENTS = {
  NODE_CLICKED: 'NodeClicked',
  NODE_DOUBLE_CLICKED: 'NodeDoubleClicked',
  LINK_CLICKED: 'LinkClicked',
  LINK_DOUBLE_CLICKED: 'LinkDoubleClicked',
  LINK_DELETE_REQUESTED: 'LinkDeleteRequested',
  CROSS_TREE_LABEL_CLICKED: 'CrossTreeLabelClicked',
} as const;
