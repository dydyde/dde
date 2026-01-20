/**
 * Web Vitals 真实用户监控 (RUM) 服务
 * 
 * 职责：
 * - 收集 Core Web Vitals 指标 (LCP, FID, CLS, INP, TTFB)
 * - 将指标上报到 Sentry 用于性能监控
 * - 支持自定义阈值告警
 * 
 * 【性能优化 2026-01-17】
 * 实现策划案中的 "真实用户监控 (RUM)" 建议
 * 参考: docs/performance-analysis-report.md
 * 
 * 使用方式：
 * 在 main.ts 中调用 inject(WebVitalsService).init()
 */

import { Injectable, inject, isDevMode } from '@angular/core';
import { onLCP, onCLS, onINP, onTTFB, onFCP, type Metric } from 'web-vitals';
import * as Sentry from '@sentry/angular';
import { LoggerService } from './logger.service';

/** Web Vitals 阈值配置 (基于 Google 推荐值) */
export const WEB_VITALS_THRESHOLDS = {
  /** 最大内容绘制 - 良好 < 2.5s, 需改进 < 4s, 差 >= 4s */
  LCP: { good: 2500, needsImprovement: 4000 },
  /** 首次内容绘制 - 良好 < 1.8s, 需改进 < 3s, 差 >= 3s */
  FCP: { good: 1800, needsImprovement: 3000 },
  /** 累积布局偏移 - 良好 < 0.1, 需改进 < 0.25, 差 >= 0.25 */
  CLS: { good: 0.1, needsImprovement: 0.25 },
  /** 下一次绘制的交互延迟 - 良好 < 200ms, 需改进 < 500ms, 差 >= 500ms */
  INP: { good: 200, needsImprovement: 500 },
  /** 首字节时间 - 良好 < 800ms, 需改进 < 1800ms, 差 >= 1800ms */
  TTFB: { good: 800, needsImprovement: 1800 },
} as const;

/** 指标评级 */
export type MetricRating = 'good' | 'needs-improvement' | 'poor';

@Injectable({
  providedIn: 'root'
})
export class WebVitalsService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('WebVitals');
  
  /** 是否已初始化 */
  private initialized = false;
  
  /** 收集到的指标缓存 */
  private metricsCache = new Map<string, Metric>();
  
  /**
   * 初始化 Web Vitals 监控
   * 应在应用启动时调用一次
   */
  init(): void {
    if (this.initialized) {
      this.logger.warn('WebVitalsService 已初始化，跳过重复调用');
      return;
    }
    
    this.initialized = true;
    
    // 注册 Core Web Vitals 回调
    // 注意：FID 已在 web-vitals v4 中被 INP 替代
    onLCP((metric: Metric) => this.handleMetric(metric));
    onFCP((metric: Metric) => this.handleMetric(metric));
    onCLS((metric: Metric) => this.handleMetric(metric));
    onINP((metric: Metric) => this.handleMetric(metric));
    onTTFB((metric: Metric) => this.handleMetric(metric));
    
    this.logger.info('Web Vitals 监控已启动');
  }
  
  /**
   * 处理收集到的指标
   */
  private handleMetric(metric: Metric): void {
    // 缓存指标
    this.metricsCache.set(metric.name, metric);
    
    // 计算评级
    const rating = this.getRating(metric.name, metric.value);
    
    // 开发模式下打印到控制台
    if (isDevMode()) {
      this.logMetric(metric, rating);
    }
    
    // 上报到 Sentry（仅生产环境或评级差时上报）
    if (!isDevMode() || rating === 'poor') {
      this.reportToSentry(metric, rating);
    }
  }
  
  /**
   * 根据指标值计算评级
   */
  private getRating(name: string, value: number): MetricRating {
    const thresholds = WEB_VITALS_THRESHOLDS[name as keyof typeof WEB_VITALS_THRESHOLDS];
    if (!thresholds) return 'good';
    
    if (value <= thresholds.good) return 'good';
    if (value <= thresholds.needsImprovement) return 'needs-improvement';
    return 'poor';
  }
  
  /**
   * 在控制台打印指标（开发模式）
   */
  private logMetric(metric: Metric, rating: MetricRating): void {
    const emoji = rating === 'good' ? '✅' : rating === 'needs-improvement' ? '⚠️' : '🔴';
    const value = metric.name === 'CLS' 
      ? metric.value.toFixed(4) 
      : `${metric.value.toFixed(0)}ms`;
    
    console.log(
      `%c${emoji} ${metric.name}: ${value} (${rating})`,
      `color: ${rating === 'good' ? 'green' : rating === 'needs-improvement' ? 'orange' : 'red'}`
    );
  }
  
  /**
   * 上报指标到 Sentry
   */
  private reportToSentry(metric: Metric, rating: MetricRating): void {
    // 使用 Sentry 的 transaction 记录性能指标
    Sentry.setMeasurement(metric.name, metric.value, metric.name === 'CLS' ? '' : 'millisecond');
    
    // 如果评级差，额外发送告警消息
    if (rating === 'poor') {
      Sentry.captureMessage(`性能告警: ${metric.name} 超出阈值`, {
        level: 'warning',
        tags: {
          'web-vital': metric.name,
          'rating': rating,
        },
        extra: {
          value: metric.value,
          id: metric.id,
          delta: metric.delta,
          navigationType: metric.navigationType,
          entries: metric.entries?.map((e: PerformanceEntry) => ({
            name: e.name,
            startTime: e.startTime,
            duration: (e as PerformanceEntry & { duration?: number }).duration,
          })),
        },
      });
    }
  }
  
  /**
   * 获取所有已收集的指标
   */
  getMetrics(): Map<string, Metric> {
    return new Map(this.metricsCache);
  }
  
  /**
   * 获取指标摘要（用于调试面板）
   */
  getMetricsSummary(): Record<string, { value: number; rating: MetricRating }> {
    const summary: Record<string, { value: number; rating: MetricRating }> = {};
    
    for (const [name, metric] of this.metricsCache) {
      summary[name] = {
        value: metric.value,
        rating: this.getRating(name, metric.value),
      };
    }
    
    return summary;
  }
}
