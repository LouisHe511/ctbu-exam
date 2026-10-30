/**
 * 已下载 PDF 字节的内存缓存（LRU）。
 *
 * 为什么需要：阅读器每次打开都会取整份 PDF，扫描件单份 0.3~4MB。
 * 同一次浏览会话内重复查看同一份时，重新下载纯属浪费——跨境网络下每次要等好几秒。
 *
 * 为什么只放内存：
 *   1. 不落盘、不写 localStorage / Cache Storage，不给"保存文件"留任何入口；
 *   2. 刷新页面即清空，不产生持久副本。
 *
 * 注意：PdfCanvasViewer 传给 PDF.js 的是字节的**拷贝**（它自己 new Uint8Array(data)），
 * 所以缓存里的 buffer 不会被 PDF.js 的 transfer 语义掏空。
 */

const cache = new Map<string, Uint8Array>();
let usedBytes = 0;

/** 缓存总上限，避免长时间浏览把内存吃满 */
export const PDF_CACHE_MAX_BYTES = 60 * 1024 * 1024;

/** 命中则把条目移到末尾（最近使用），返回字节 */
export function getCachedPdf(key: string): Uint8Array | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** 写入缓存；单份过大或超上限时按 LRU 淘汰 */
export function setCachedPdf(key: string, bytes: Uint8Array): void {
  if (!key || bytes.byteLength === 0) return;
  // 单份超过上限一半就不缓存，免得把整个缓存挤空
  if (bytes.byteLength > PDF_CACHE_MAX_BYTES / 2) return;

  const existing = cache.get(key);
  if (existing) {
    usedBytes -= existing.byteLength;
    cache.delete(key);
  }
  while (usedBytes + bytes.byteLength > PDF_CACHE_MAX_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    if (evicted) usedBytes -= evicted.byteLength;
    cache.delete(oldest);
  }
  cache.set(key, bytes);
  usedBytes += bytes.byteLength;
}

/** 清空缓存（管理员替换或删除试卷后调用，确保读到新文件） */
export function clearPdfCache(): void {
  cache.clear();
  usedBytes = 0;
}

/** 仅供诊断/测试使用 */
export function pdfCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: usedBytes };
}
