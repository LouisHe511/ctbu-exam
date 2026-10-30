/**
 * PDF.js Web Worker 的入口（带运行时补丁）
 *
 * ## 为什么需要这一层
 * pdf.js 的 worker 里大量调用 `Promise.withResolvers()`（ES2024）：
 * 网络流、字体加载、消息通道都用它。这个方法 2024 年才进标准，
 * Safari 17.4 / Chrome 119 之前没有 → worker 一启动就抛
 * `Promise.withResolvers is not a function`，阅读器整块打不开
 * （2026-10-17 用户用电脑实测报障）。
 *
 * worker 是独立 JS 环境，主线程的补丁管不到它，所以必须在这里先补再加载。
 *
 * ## 顺序很重要
 * ESM 按 import 声明顺序求值，所以 `./pdf-worker-polyfill` 一定先执行，
 * 再到 `pdf.worker`。补丁必须早于 pdf.js 的任何求值。
 *
 * ## 用法（见 PdfCanvasViewer）
 *   import PdfWorker from '@/lib/pdf-worker-entry?worker';
 *   pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
 *
 * vite.config.ts 里 `worker.format: 'es'` 是必需的（pdf.worker 本身是 ESM）。
 */

import './pdf-worker-polyfill';

// pdfjs-dist 的 worker 入口：它自己会注册全局 message 监听，导入即生效
import 'pdfjs-dist/build/pdf.worker.min.mjs';

export {};
