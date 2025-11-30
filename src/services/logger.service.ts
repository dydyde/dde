import { Injectable, signal } from '@angular/core';
import { environment } from '../environments/environment';

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

/**
 * 日志条目
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

/**
 * 统一日志服务
 * 替代分散的 console.log/warn/error 调用
 * 
 * 功能：
 * - 统一的日志级别控制
 * - 生产环境自动禁用 debug/info 日志
 * - 可选的日志持久化（用于调试）
 * - 结构化日志输出
 */
@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  /** 当前日志级别 */
  private level: LogLevel;
  
  /** 最近的日志条目（用于调试面板） */
  private recentLogs: LogEntry[] = [];
  private maxLogEntries = 100;
  
  /** 是否启用持久化日志 */
  private persistLogs = false;
  
  /** CategoryLogger 缓存 */
  private categoryLoggers = new Map<string, CategoryLogger>();
  
  constructor() {
    // 生产环境只显示警告和错误
    this.level = environment.production ? LogLevel.WARN : LogLevel.DEBUG;
  }
  
  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  
  /**
   * 启用/禁用日志持久化
   */
  setPersist(enabled: boolean): void {
    this.persistLogs = enabled;
    if (!enabled) {
      this.recentLogs = [];
    }
  }
  
  /**
   * 获取最近的日志
   */
  getRecentLogs(): ReadonlyArray<LogEntry> {
    return this.recentLogs;
  }
  
  /**
   * 清除日志
   */
  clearLogs(): void {
    this.recentLogs = [];
  }
  
  /**
   * DEBUG 级别日志
   * 仅在开发环境显示
   */
  debug(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }
  
  /**
   * INFO 级别日志
   * 开发环境显示，生产环境隐藏
   */
  info(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, category, message, data);
  }
  
  /**
   * WARN 级别日志
   * 所有环境显示
   */
  warn(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, category, message, data);
  }
  
  /**
   * ERROR 级别日志
   * 所有环境显示
   */
  error(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, category, message, data);
  }
  
  /**
   * 核心日志方法
   */
  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (level < this.level) return;
    
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data
    };
    
    // 持久化日志
    if (this.persistLogs) {
      this.recentLogs.push(entry);
      if (this.recentLogs.length > this.maxLogEntries) {
        this.recentLogs.shift();
      }
    }
    
    // 控制台输出
    const prefix = `[${this.getLevelName(level)}] [${category}]`;
    const args = data !== undefined ? [prefix, message, data] : [prefix, message];
    
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(...args);
        break;
      case LogLevel.INFO:
        console.info(...args);
        break;
      case LogLevel.WARN:
        console.warn(...args);
        break;
      case LogLevel.ERROR:
        console.error(...args);
        break;
    }
  }
  
  /**
   * 获取日志级别名称
   */
  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return 'DEBUG';
      case LogLevel.INFO: return 'INFO';
      case LogLevel.WARN: return 'WARN';
      case LogLevel.ERROR: return 'ERROR';
      default: return 'UNKNOWN';
    }
  }
  
  /**
   * 创建带固定分类的子日志器
   */
  createLogger(category: string): CategoryLogger {
    return new CategoryLogger(this, category);
  }
  
  /**
   * 创建带固定分类的子日志器（简写方法）
   * 使用缓存避免重复创建
   */
  category(category: string): CategoryLogger {
    let logger = this.categoryLoggers.get(category);
    if (!logger) {
      logger = new CategoryLogger(this, category);
      this.categoryLoggers.set(category, logger);
    }
    return logger;
  }
}

/**
 * 带固定分类的日志器
 * 方便在特定服务/组件中使用
 */
export class CategoryLogger {
  constructor(
    private logger: LoggerService,
    private category: string
  ) {}
  
  debug(message: string, data?: unknown): void {
    this.logger.debug(this.category, message, data);
  }
  
  info(message: string, data?: unknown): void {
    this.logger.info(this.category, message, data);
  }
  
  warn(message: string, data?: unknown): void {
    this.logger.warn(this.category, message, data);
  }
  
  error(message: string, data?: unknown): void {
    this.logger.error(this.category, message, data);
  }
}
