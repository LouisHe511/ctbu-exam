/**
 * `Promise.withResolvers` 补丁（**仅供 PDF worker 使用**）
 *
 * 单独成文件，是为了让打包器保证它**先于 pdf.worker 求值**：
 * ESM 按 import 声明顺序执行依赖，所以 `pdf-worker-entry.ts` 里
 *   import './pdf-worker-polyfill';          // ← 先跑这个
 *   import 'pdfjs-dist/.../pdf.worker.mjs';  // ← 再跑 pdf.js
 *
 * 主线程用的是 lib/pdfPolyfill.ts（同一个实现，这里给 worker 独立副本，
 * 避免 worker 入口再 import 带 DOM 假设的模块）。
 */
const P = Promise as unknown as {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

if (typeof P.withResolvers !== 'function') {
  P.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
