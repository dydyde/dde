import { Injectable, signal, computed, effect } from '@angular/core';
import { LoggerService } from './logger.service';

/**
 * 流程图命令类型枚举
 * 
 * 定义所有可能的流程图操作命令
 */
export enum FlowCommandType {
  /** 居中到指定节点 */
  CenterOnNode = 'CENTER_ON_NODE',
  /** 重试初始化图表 */
  RetryDiagram = 'RETRY_DIAGRAM',
  /** 缩放到适合视口 */
  ZoomToFit = 'ZOOM_TO_FIT',
  /** 放大 */
  ZoomIn = 'ZOOM_IN',
  /** 缩小 */
  ZoomOut = 'ZOOM_OUT',
  /** 自动布局 */
  AutoLayout = 'AUTO_LAYOUT',
  /** 导出为图片 */
  ExportImage = 'EXPORT_IMAGE'
}

/**
 * 流程图命令接口
 * 
 * 纯数据结构，可序列化，不包含运行时逻辑
 */
export interface FlowCommand {
  /** 唯一标识符，用于去重和确认消费 */
  id: string;
  /** 命令类型 */
  type: FlowCommandType;
  /** 命令携带的参数 */
  payload?: Record<string, unknown>;
  /** 创建时间戳，用于排序或过期处理 */
  timestamp: number;
}

/**
 * 居中到节点命令的 payload 类型
 */
export interface CenterNodePayload extends Record<string, unknown> {
  taskId: string;
  openDetail: boolean;
}

/**
 * 流程图命令服务
 * 
 * 作用：解耦 ProjectShellComponent 和 FlowViewComponent
 * 使 @defer 懒加载真正生效
 * 
 * 设计决策：
 * - 使用 Angular Signals 而非 RxJS Subject（符合项目架构）
 * - 命令包含 timestamp 确保相同参数也能触发响应
 * - 命令模式而非直接调用，支持 FlowView 未加载时的命令缓存
 * - 实现乐观 UI：界面立即响应用户操作，不等待底层执行完成
 * 
 * 核心机制：
 * 1. 命令队列模式：Shell 发布意图，View 订阅并响应
 * 2. 待处理命令缓存：解决 FlowView 未加载时的命令丢失问题
 * 3. 信号驱动：利用 Angular Signals 的同步响应特性
 * 
 * @example
 * // 在 ProjectShellComponent 中
 * this.flowCommand.centerOnNode('task-123', true);
 * 
 * // 在 FlowViewComponent 中通过 effect() 自动响应
 */
@Injectable({ providedIn: 'root' })
export class FlowCommandService {
  private readonly logger = new LoggerService().category('FlowCommand');

  // ========== 命令队列信号 ==========
  
  /**
   * 命令队列信号
   * 作为 Shell 和 View 的异步缓冲区
   */
  private readonly _commandQueue = signal<FlowCommand[]>([]);
  
  /**
   * 只读命令队列（供外部订阅）
   */
  readonly commandQueue = this._commandQueue.asReadonly();

  /**
   * 队列中是否有待处理命令
   */
  readonly hasPendingCommands = computed(() => this._commandQueue().length > 0);

  // ========== 专用命令信号（简化常用操作） ==========

  /**
   * 居中到节点命令信号
   * 每次写入触发 FlowViewComponent 响应
   */
  private readonly _centerNodeCommand = signal<CenterNodePayload | null>(null);
  readonly centerNodeCommand = this._centerNodeCommand.asReadonly();

  /**
   * 重试初始化命令信号
   * 值递增时触发重试
   */
  private readonly _retryDiagramCommand = signal<number>(0);
  readonly retryDiagramCommand = this._retryDiagramCommand.asReadonly();

  // ========== 待执行命令缓存 ==========

  /**
   * 待执行的居中命令
   * FlowView 未加载时缓存，初始化后执行
   */
  private pendingCenterCommand: CenterNodePayload | null = null;

  /**
   * FlowView 是否已就绪
   */
  private readonly _isViewReady = signal(false);
  readonly isViewReady = this._isViewReady.asReadonly();

  constructor() {
    // 调试日志
    effect(() => {
      const queue = this._commandQueue();
      if (queue.length > 0) {
        this.logger.debug('命令队列更新', { 
          count: queue.length, 
          types: queue.map(c => c.type) 
        });
      }
    });
  }

  // ========== 公共 API ==========

  /**
   * 发送居中到节点命令
   * 
   * @param taskId 目标任务 ID
   * @param openDetail 是否打开详情面板
   */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    const payload: CenterNodePayload = { taskId, openDetail };
    
    // 1. 设置专用信号（供 effect 响应）
    this._centerNodeCommand.set(payload);
    
    // 2. 缓存待执行命令（应对 View 未就绪情况）
    this.pendingCenterCommand = payload;
    
    // 3. 同时加入通用队列（用于调试和日志）
    this.dispatch(FlowCommandType.CenterOnNode, payload);

    this.logger.debug('发送居中命令', { taskId, openDetail });
  }

  /**
   * 发送重试初始化命令
   */
  retryDiagram(): void {
    this._retryDiagramCommand.update(v => v + 1);
    this.dispatch(FlowCommandType.RetryDiagram);
    this.logger.debug('发送重试命令');
  }

  /**
   * 发送缩放到适合命令
   */
  zoomToFit(): void {
    this.dispatch(FlowCommandType.ZoomToFit);
  }

  /**
   * 发送自动布局命令
   */
  autoLayout(): void {
    this.dispatch(FlowCommandType.AutoLayout);
  }

  /**
   * 通用命令分发方法
   * 采用不可变更新模式追加命令
   */
  dispatch(type: FlowCommandType, payload?: Record<string, unknown>): void {
    const command: FlowCommand = {
      id: crypto.randomUUID(),
      type,
      payload,
      timestamp: Date.now()
    };
    
    this._commandQueue.update(queue => [...queue, command]);
  }

  // ========== View 端 API ==========

  /**
   * 标记 FlowView 已就绪
   * 由 FlowViewComponent 在 InitialLayoutCompleted 后调用
   */
  markViewReady(): void {
    this._isViewReady.set(true);
    this.logger.debug('FlowView 已就绪');
  }

  /**
   * 标记 FlowView 已销毁
   * 由 FlowViewComponent 在 ngOnDestroy 时调用
   */
  markViewDestroyed(): void {
    this._isViewReady.set(false);
    this.logger.debug('FlowView 已销毁');
  }

  /**
   * 获取并清除待执行的居中命令
   * FlowView 初始化完成后调用
   * 
   * @returns 待执行的命令，如果没有则返回 null
   */
  consumePendingCenterCommand(): CenterNodePayload | null {
    const cmd = this.pendingCenterCommand;
    this.pendingCenterCommand = null;
    if (cmd) {
      this.logger.debug('消费待执行命令', cmd);
    }
    return cmd;
  }

  /**
   * 清除居中命令信号
   * 防止重复执行
   */
  clearCenterCommand(): void {
    this._centerNodeCommand.set(null);
  }

  /**
   * 消费确认方法
   * 由 View 调用，用于清理已执行的命令，防止重复执行
   */
  acknowledgeCommands(processedIds: string[]): void {
    const oldLength = this._commandQueue().length;
    
    this._commandQueue.update(queue => 
      queue.filter(cmd => !processedIds.includes(cmd.id))
    );

    const newLength = this._commandQueue().length;
    if (oldLength !== newLength) {
      this.logger.debug('命令已确认消费', { 
        processed: processedIds.length, 
        remaining: newLength 
      });
    }
  }

  /**
   * 清空所有待处理命令
   * 通常在组件销毁或重置时调用
   */
  clearAllCommands(): void {
    this._commandQueue.set([]);
    this.pendingCenterCommand = null;
    this._centerNodeCommand.set(null);
    this.logger.debug('已清空所有命令');
  }
}
