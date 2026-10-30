import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RotateCw, ZoomIn, ZoomOut, Columns2, Square } from 'lucide-react';
import { Watermark } from '@/components/Watermark';

/**
 * 逐页图片版试卷阅读器 —— 与 PdfCanvasViewer 外观、交互一致，只是用 <img> 渲染。
 *
 * 为什么值得单独做一个组件（而不是让 PDF 阅读器去兼容）：
 *   1) 快：只加载当前页（约 110 KB），PDF 必须整份下载（2.4 MB）→ 实测 134ms vs 7.9s
 *   2) 省：不用加载约 1.7 MB 的 PDF.js 运行库
 *   3) 稳：图片加载失败只影响那一页，不会像 PDF.js 那样整份停在中态
 *
 * 预取策略（性能关键）：
 *   当前页加载完成后立刻用 new Image() 预取下一页。3 Mbps 下每个新连接都要付
 *   一次 TCP 慢启动成本（实测首帧 1.3 秒、之后每帧 0.03~0.07 秒），
 *   预取能把翻页等待几乎抹平。
 */
/** 双页开关的本地记忆键 */
const SPREAD_KEY = 'ctbu:reader-spread';

export function ImagePageViewer({
  urls,
  title,
  watermark,
  requestedPage,
  requestNonce = 0,
  onPageChange,
  onStale,
}: {
  urls: string[];
  title: string;
  watermark: string;
  requestedPage: number | null;
  /**
   * 跳页请求的序号（2026-10-22）。
   * ⚠️ 必须有它：`requestedPage` 是"要跳到第几页"，
   * 连续两次跳到**同一页**时值没变，useEffect 不会重跑 ——
   * 表现就是"点了没反应"。带上自增序号后每次点击都是一个新请求。
   */
  requestNonce?: number;
  /** 实际页码变了就回报（1 基），父组件用它同步缩略图高亮 */
  onPageChange?: (page1Based: number) => void;
  /**
   * 图片持续加载失败时通知父组件重新签发链接（2026-10-28）。
   * 签名链接有有效期（现在 2 小时），过期后所有图片都是 403 ——
   * 只在这一页上重试没有意义，必须回服务端换一批新 URL。
   */
  onStale?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 容器宽度：把「缩放 100%」定义为「适应宽度」，与 PDF 阅读器一致（2026-10-17 修） */
  const [containerW, setContainerW] = useState(0);
  const pageCount = urls.length;
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  /** 哪些页已经加载成功过 —— 翻回去时不用再显示骨架 */
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  /** 重试计数：key 变化会让 <img> 重新挂载，从而真的重发请求 */
  const [retry, setRetry] = useState(0);
  /**
   * 双页对照（2026-10-21 用户要求）
   * ---------------------------------------------------------------
   * 我们的卷子是 A3 原卷对折后按 A4 切开的 —— 每两页在物理上本来是**同一张纸**。
   * 打开这个开关就把两页并排复原成 A3 的样子：左边是前半页、右边是后半页，
   * 中间一道发丝线表示折痕。
   *
   * 为什么记在 localStorage：学生一旦选了双页，翻下一份卷子还应该是双页，
   * 不要每进一份卷子都重新点一次。
   */
  const [spread, setSpread] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SPREAD_KEY) === '1';
    } catch {
      return false;
    }
  });

  // 记住双页选择
  useEffect(() => {
    try {
      localStorage.setItem(SPREAD_KEY, spread ? '1' : '0');
    } catch { /* 隐私模式：记不住就算了，每次都点一下也不致命 */ }
  }, [spread]);

  // 外部要求跳到某一页（答案起始页跳转 / 底部缩略图点选）
  useEffect(() => {
    if (requestedPage && requestedPage >= 1 && requestedPage <= pageCount) {
      // 双页模式下必须落在奇数页上，否则这一"跨"会和上一跨重叠。
      // ⚠️ `spread` 故意**不在依赖里**（2026-10-28）：它一变就会把页码拽回
      // "上次外部跳转的目标页"—— 翻到第 40 页、切一下双页，立刻跳回第 29 页。
      setPage(spread && requestedPage % 2 === 0 ? requestedPage - 1 : requestedPage);
    }
    // requestNonce 参与依赖：同一个目标页被再次点击时也要生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPage, requestNonce, pageCount]);

  // 切双页时只做"对齐到奇数页"，不动用户当前翻到的位置（2026-10-28）
  useEffect(() => {
    setPage((cur) => (spread && cur % 2 === 0 ? cur - 1 : cur));
  }, [spread]);


  // 切换试卷时重置状态（父组件也会用 key 强制重建，这里是双保险）
  useEffect(() => {
    setPage(1);
    setLoaded({});
    setFailed({});
    setLoading(true);
    setRetry(0);
  }, [urls]);

  // 当前页变化时滚回顶部 —— 否则从长页翻到短页会停在半空。
  // 双页开关也算"换了一屏"：单页看第 7 页看到一半切双页，视口还停在原位置会很懵。
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [page, spread]);

  // 容器宽度测量（跟随窗口尺寸变化）：缩放的 100% = 适应宽度
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 当前这一"屏"要显示哪几页（1 基）。
   * 单页：只有 left=page。
   * 双页：left 一定是奇数，right = left+1（末页落单时 right 为 null）。
   */
  const leftPage = spread ? (page % 2 === 0 ? page - 1 : page) : page;
  const rightPage = spread && leftPage + 1 <= pageCount ? leftPage + 1 : null;
  /** 一屏翻几页 */
  const step = spread ? 2 : 1;
  const canPrev = leftPage > 1;
  const canNext = spread ? leftPage + step <= pageCount : leftPage < pageCount;

  // 把"当前真实页码"同步给父组件（缩略图高亮 / 页码显示都靠它）
  useEffect(() => {
    onPageChange?.(leftPage);
  }, [leftPage, onPageChange]);

  // 预取下一屏（当前屏加载完成后）—— 双页时一次预取两页
  useEffect(() => {
    if (!loaded[leftPage]) return;
    const nextStart = leftPage + step;
    for (let p = nextStart; p < nextStart + step; p++) {
      if (p >= 1 && p <= pageCount) {
        const im = new Image();
        im.src = urls[p - 1];
      }
    }
  }, [leftPage, step, loaded, pageCount, urls]);

  // 缩放基准 = 容器可视宽度（减去 p-4 的左右内边距）；zoom>1 时横向滚动查看
  const baseWidth = Math.max(280, (containerW || 760) - 32);
  const displayWidth = Math.round(baseWidth * zoom);

  return (
    <section className="w-full max-w-4xl mx-auto rounded-xl overflow-hidden border border-hairline/[0.10] bg-ink-850 shadow-2xl shadow-black/60 select-none">
      <div className="flex items-center justify-between gap-3 border-b border-hairline/[0.07] bg-ink-900 px-3 sm:px-4 py-3 text-xs text-gray-500">
        <span className="truncate font-medium text-gray-700">{title}</span>
        <span className="shrink-0">仅限在线查看</span>
      </div>

      <div
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative max-h-[72vh] overflow-auto p-4 ${
          // 单页时给个最小高度，避免加载中塌成一条；双页时两页并排本来就矮，
          // 再撑 58vh 会在手机/平板上留一大片空白（实测 iPhone 上尤其明显）
          spread ? 'min-h-0' : 'min-h-[58vh]'
        }`}
      >
        {/*
          一屏一屏地画。单页 = 一页；双页 = 两页并排（复原 A3 对折前的样子）。
          ---------------------------------------------------------------
          兼容性说明（用户点名要考虑这个）：
            · 只用 `display:flex` + `width:50%`，不用 gap / aspect-ratio / grid ——
              iPadOS 14 及更老的 Safari 对 flex-gap、aspect-ratio 支持不完整，
              width 百分比从 IE 时代就稳。
            · 两页之间不放 gap，改用左半页的 1px 右边框当"折痕"，
              这样即使某一页高度略短也不会出现一条黑缝。
            · 容器仍是 overflow:auto + 触摸滚动，iPad 上直接手指拖，
              不需要被动事件的特殊处理。
        */}
        <div className="mx-auto flex items-start" style={{ width: displayWidth }}>
          {(rightPage ? [leftPage, rightPage] : [leftPage]).map((p, idx) => (
            <div
              key={p}
              className={`relative ${spread ? 'w-1/2' : 'w-full'} ${
                spread && idx === 0 ? 'border-r border-hairline/[0.10]' : ''
              }`}
            >
              {failed[p] ? (
                <div className="p-6 text-center">
                  <p className="text-sm font-medium text-red-600">这一页暂时显示不出来</p>
                  <p className="mt-2 text-xs text-gray-500">
                    可能是网络波动，或本次查看链接已过期。已加载的其它页不受影响。
                  </p>
                  <button
                    onClick={() => {
                      setFailed((f) => ({ ...f, [p]: false }));
                      setLoading(true);
                      setRetry((n) => n + 1);
                    }}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    重试这一页
                  </button>
                </div>
              ) : (
                <>
                  <img
                    key={`${p}-${retry}`}
                    src={urls[p - 1]}
                    alt={`${title}，第 ${p} 页`}
                    draggable={false}
                    // 只在第一次加载该页时显示骨架；翻回去时 loaded 为真，直接显示避免闪白
                    onLoad={() => {
                      setLoading(false);
                      setLoaded((l) => ({ ...l, [p]: true }));
                    }}
                    onError={() => {
                      setLoading(false);
                      setFailed((f) => ({ ...f, [p]: true }));
                      // 已经手动重试过一次还是失败 → 极可能是签名过期，交给父组件重签
                      if (retry > 0) onStale?.();
                    }}
                    /*
                      2026-10-22 浅色模式：扫描件是白纸，页面底也是纸白，两者贴在一起会"消失"
                      （看不出卷子边界在哪）。给纸张加一条发丝线 + 一点投影，深色下也更有实体感。
                    */
                    className="block h-auto w-full border border-hairline/[0.10] shadow-[0_1px_10px_rgba(0,0,0,0.10)]"
                  />
                  <Watermark text={watermark} />
                  {loading && !loaded[p] && (
                    <div className="absolute inset-0 flex items-center justify-center bg-page/65">
                      <Loader2 className="w-6 h-6 animate-spin text-accent" />
                    </div>
                  )}
                </>
              )}
            </div>
          ))}

          {/* 末页落单：补一个空的半页，保持"整张 A3"的宽度比例，别让最后一页突然放大 */}
          {spread && !rightPage && <div className="w-1/2" aria-hidden="true" />}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-hairline/[0.07] bg-ink-900 px-3 py-2.5">
        <button
          onClick={() => setPage(() => Math.max(1, leftPage - step))}
          disabled={!canPrev}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label={spread ? '上两页' : '上一页'}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="min-w-14 whitespace-nowrap text-center font-mono text-xs tabular-nums text-gray-600">
          {pageCount
            ? rightPage ? `${leftPage}–${rightPage} / ${pageCount}` : `${leftPage} / ${pageCount}`
            : '— / —'}
        </span>
        <button
          onClick={() => setPage(() => Math.min(pageCount, leftPage + step))}
          disabled={!canNext}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label={spread ? '下两页' : '下一页'}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="mx-1 h-6 w-px bg-elevate/[0.12]" />

        {/*
          双页对照开关。放在缩放键左边 —— 它和缩放一样属于"怎么显示"，
          不属于"看第几页"，所以不跟翻页键挤在一起。
          手机上双页会很小，但放大键还能用，所以不隐藏（不替用户决定）。
        */}
        <button
          onClick={() => setSpread((v) => !v)}
          disabled={pageCount < 2}
          title={spread ? '切回单页' : '双页并排（像看整张 A3）'}
          aria-pressed={spread}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs transition-colors disabled:opacity-25 ${
            spread
              ? 'bg-elevate/[0.14] text-strong'
              : 'bg-elevate/[0.06] text-gray-800 hover:bg-solid-hover/[0.12] hover:text-strong'
          }`}
        >
          {spread ? <Square className="w-4 h-4" /> : <Columns2 className="w-4 h-4" />}
          <span className="hidden sm:inline">{spread ? '单页' : '双页'}</span>
        </button>

        <span className="mx-1 h-6 w-px bg-elevate/[0.12]" />
        <button
          onClick={() => setZoom((z) => Math.max(0.65, Math.round((z - 0.1) * 10) / 10))}
          className="rounded-lg bg-elevate/[0.06] p-2 text-gray-800 transition-colors hover:bg-solid-hover/[0.12] hover:text-strong disabled:opacity-25 disabled:hover:bg-solid-hover/[0.06]"
          aria-label="缩小"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="w-10 text-center font-mono text-xs tabular-nums text-gray-600">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.min(1.8, Math.round((z + 0.1) * 10) / 10))}
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
