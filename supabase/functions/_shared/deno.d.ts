/// <reference types="npm:@types/node" />

// Deno 全局类型声明
// 用于在 VS Code 中提供 Deno API 的类型提示
// 实际运行时由 Deno 运行时提供这些 API

declare namespace Deno {
  export interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    toObject(): { [key: string]: string };
  }

  export const env: Env;

  export function serve(
    handler: (request: Request) => Response | Promise<Response>,
    options?: { port?: number; hostname?: string }
  ): void;

  export function serve(
    options: { port?: number; hostname?: string },
    handler: (request: Request) => Response | Promise<Response>
  ): void;
}

// CompressionStream/DecompressionStream 类型
// Deno 和现代浏览器都支持
interface CompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

interface DecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

declare var CompressionStream: {
  prototype: CompressionStream;
  new (format: "gzip" | "deflate" | "deflate-raw"): CompressionStream;
};

declare var DecompressionStream: {
  prototype: DecompressionStream;
  new (format: "gzip" | "deflate" | "deflate-raw"): DecompressionStream;
};

// 扩展 Uint8Array 类型以兼容 BufferSource
// 在 Deno 中 Uint8Array 直接兼容 BufferSource
declare global {
  interface Uint8Array {
    // 确保 buffer 属性类型兼容
    readonly buffer: ArrayBuffer;
  }
}

export {};
