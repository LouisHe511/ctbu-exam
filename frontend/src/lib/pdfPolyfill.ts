/**
 * `Promise.withResolvers` 运行时补丁（ES2024）
 *
 * ## 为什么必须补
 * `pdfjs-dist` 4.8 内部**直接调用** `Promise.withResolvers()`（网络流、字体加载、
 * 消息通道都用它）。这个静态方法是 2024 年才进入标准的：
 *   - Safari 17.4+、Chrome 119+、Firefox 121+ 才有
 *   - 更旧的浏览器（尤其 Mac 上没升级的 Safari）会抛
 *     `Promise.withResolvers is not a function`
 *
 * 表现：阅读器整块空白 + 红字「PDF 暂时无法显示」，一个都打不开
 * （2026-10-17 用户用电脑实测报障）。
 *
 * ## 为什么主线程和 worker 都要补
 * pdf.js 分两半跑：主线程（pdf.mjs）和 Web Worker（pdf.worker.mjs），
 * **两者是独立 JS 环境，补丁不共享**。worker 里用得更多，只补主线程照样崩。
 *   - 主线程：`installPromiseWithResolvers()` 在 main.tsx 里执行
 *   - worker：`pdf-worker-entry.ts` 在 worker 启动时执行同一段逻辑
 *
 * 本文件同时导出字符串形式，供 worker 侧复用（避免两处实现漂移）。
 */

type Resolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseWithResolvers = {
  withResolvers?: <T>() => Resolvers<T>;
};

/** 规范的等价实现：resolve / reject 与 promise 一次性绑定 */
function withResolversImpl<T>(): Resolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 在主线程安装补丁（幂等；浏览器原生支持时什么都不做） */
export function installPromiseWithResolvers(): void {
  const P = Promise as unknown as PromiseWithResolvers;
  if (typeof P.withResolvers === 'function') return;
  P.withResolvers = withResolversImpl;
}
