import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import PdfWorker from '@/lib/pdf-worker-entry?worker';
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import { Watermark } from '@/components/Watermark';

export function PdfCanvasViewer({
  data,
  title,
  watermark,
  requestedPage,
  requestNonce = 0,
  onPageChange,
}: {
  data: Uint8Array | null;
  title: string;
  watermark: string;
  requestedPage: number | null;
  /** 跳页请求序号：同一个目标页连续点击时值没变，靠它触发（2026-10-22） */
  requestNonce?: number;
  /** 实际页码变了就回报（1 基），父组件用它同步缩略图高亮 */
  onPageChange?: (page1Based: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let destroyLoading: (() => Promise<void>) | null = null;
    /** 自建的 PDF worker（见 src/lib/pdf-worker-entry.ts，负责补 Promise.withResolvers） */
    let pdfWorker: Worker | null = null;
    setLoading(true);
    setError(null);
    setPage(1);
    setPageCount(0);

    (async () => {
      try {
        // PDF.js is loaded only when a paper reader is opened, keeping the library landing bundle light.
        const pdfjs = await import('pdfjs-dist');
        if (cancelled) return;
        // 用**自带补丁的 worker**，不用 pdfjs 按 workerSrc 自建的那个：
        // pdfjs 4.8 的 worker 依赖 Promise.withResolvers（ES2024），
        // 旧 Safari/Chrome 没有 → 报 "Promise.withResolvers is not a function"，整页打不开
        // （2026-10-17 用户实测）。worker 是独立环境，主线程补丁管不到它。
        pdfWorker = new PdfWorker();
        pdfjs.GlobalWorkerOptions.workerPort = pdfWorker;
        if (!data) {
          setError('未收到 PDF 内容');
          setLoading(false);
          return;
        }
        // PDF.js 会把传入的 buffer 转移给 worker，传一份拷贝，避免重复渲染时 buffer 已失效
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
        destroyLoading = () => loadingTask.destroy();
        const doc = await loadingTask.promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        documentRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'PDF 加载失败');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      documentRef.current = null;
      if (destroyLoading) void destroyLoading();
      // worker 是我们自己 new 的（workerPort 模式下 pdf.js 不负责销毁），必须手动收，
      // 否则每开一次试卷就漏一个 worker 线程
      pdfWorker?.terminate();
    };
  }, [data]);

  useEffect(() => {
    if (!requestedPage || !pageCount) return;
    setPage(Math.max(1, Math.min(pageCount, requestedPage)));
    // requestNonce 参与依赖：连续两次跳到同一页时，requestedPage 没变也要生效
  }, [requestedPage, requestNonce, pageCount]);

  // 把当前页码回报给父组件（缩略图高亮靠它）
  useEffect(() => {
    onPageChange?.(page);
  }, [page, onPageChange]);

  useEffect(() => {
    const doc = documentRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!doc || !canvas || !container || !pageCount) return;

    let cancelled = false;
    renderTaskRef.current?.cancel();
    setLoading(true);

    doc.getPage(page).then((pdfPage) => {
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, container.clientWidth - 32);
      const fitScale = Math.min(availableWidth / base.width, 1.4);
      const viewport = pdfPage.getViewport({ scale: fitScale * zoom });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError('浏览器无法创建 PDF 画布');
        setLoading(false);
        return;
      }

      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;

      const task = pdfPage.render({
        canvasContext: ctx,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      renderTaskRef.current = task;
      task.promise.then(() => {
        if (!cancelled) setLoading(false);
      }).catch((e: unknown) => {
        if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) {
          setError(e instanceof Error ? e.message : 'PDF 页面渲染失败');
          setLoading(false);
        }
      });
    }).catch((e: unknown) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'PDF 页面读取失败');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [page, pageCount, zoom]);

  return (
    <section className="w-full max-w-4xl mx-auto rounded-xl overflow-hidden border border-hairline/[0.10] bg-ink-850 shadow-2xl shadow-black/60 select-none">
      <div className="flex items-center justify-between gap-3 border-b border-hairline/[0.07] bg-ink-900 px-3 sm:px-4 py-3 text-xs text-gray-500">
        <span className="truncate font-medium text-gray-700">{title}</span>
        <span className="shrink-0">仅限在线查看</span>
      </div>

      <div
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
        className="relative min-h-[58vh] max-h-[72vh] overflow-auto p-4"
      >
        {error ? (
          <div className="mx-auto text-center rounded-xl bg-ink-850 p-6 max-w-md">
            <p className="text-red-600 text-sm font-medium">PDF 暂时无法显示</p>
            <p className="text-gray-500 text-xs mt-2 break-words">{error}</p>
          </div>
        ) : (
          <div className="relative bg-ink-850 shadow-md mx-auto">
            <canvas
              ref={canvasRef}
              aria-label={`${title}，第 ${page} 页`}
              className="block max-w-none"
              draggable={false}
            />
            <Watermark text={watermark} />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-page/65">
                <Loader2 className="w-6 h-6 animate-spin text-accent" />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-hairline/[0.07] bg-ink-900 px-3 py-2.5">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || loading || !!error}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="min-w-14 text-center font-mono text-xs tabular-nums text-gray-600">
          {pageCount ? `${page} / ${pageCount}` : '— / —'}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          disabled={page >= pageCount || loading || !!error}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label="下一页"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="mx-1 h-6 w-px bg-elevate/[0.12]" />
        <button
          onClick={() => setZoom((z) => Math.max(0.65, Math.round((z - 0.1) * 10) / 10))}
          disabled={loading || !!error}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label="缩小"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="w-10 text-center font-mono text-xs tabular-nums text-gray-600">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.min(1.8, Math.round((z + 0.1) * 10) / 10))}
          disabled={loading || !!error}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label="放大"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>
      <p className="bg-ink-900 px-3 pb-2 text-center text-xs text-gray-500">
        请勿下载、截图传播或用于商业用途。页面含动态水印。
      </p>
    </section>
  );
}
