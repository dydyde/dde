// Deno 全局类型声明
// 用于在 VS Code 中提供 Deno API 的类型提示
// 实际运行时由 Deno 运行时提供这些 API

// Deno 命名空间（全局可用）
declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    toObject(): { [key: string]: string };
  }

  const env: Env;

  function serve(
    handler: (request: Request) => Response | Promise<Response>,
    options?: { port?: number; hostname?: string }
  ): void;

  function serve(
    options: { port?: number; hostname?: string },
    handler: (request: Request) => Response | Promise<Response>
  ): void;
}

// Supabase 模块声明 - 使用 @ts-ignore 让 TypeScript 忽略 URL 模块
// 这些模块在 Deno 运行时是有效的
declare module "https://esm.sh/@supabase/supabase-js@2" {
  import type { SupabaseClient as SC } from "@supabase/supabase-js";
  export function createClient(url: string, key: string, options?: Record<string, unknown>): SC;
  export type SupabaseClient = SC;
}

declare module "https://esm.sh/@supabase/supabase-js@2.49.1" {
  import type { SupabaseClient as SC } from "@supabase/supabase-js";
  export function createClient(url: string, key: string, options?: Record<string, unknown>): SC;
  export type SupabaseClient = SC;
}

declare module "https://deno.land/std@0.177.0/http/server.ts" {
  export function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

// JSR Edge Runtime 模块
declare module "jsr:@supabase/functions-js/edge-runtime.d.ts" {}

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
