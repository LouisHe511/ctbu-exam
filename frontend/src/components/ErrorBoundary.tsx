import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, AlertTriangle, Home } from 'lucide-react';

/**
 * ═══════════════════════════════════════════════════════════════
 * 页面级错误边界 —— 专治「点一下整页变黑」
 * ═══════════════════════════════════════════════════════════════
 * 背景（2026-10-21 真实故障）：
 *   学生登录后点「四六级」，整页变成纯黑，什么按钮都没有，只能刷新。
 *   原因不是四六级页面本身写错了，而是 **没有错误边界**：
 *
 *   1. 为了首屏快，13 个页面全部走 `lazy(() => import(...))`（见 App.tsx）；
 *   2. 每次部署会把 `dist/assets/` 原子替换，旧的哈希文件名被删掉；
 *   3. 学生的浏览器里可能还留着上一版 `index.html`，它指向**已经不存在的**
 *      `CetHomePage-旧哈希.js` → 请求 404；
 *   4. React.lazy 拿不到模块 → 在渲染期抛错 → 没有边界接住 →
 *      React **卸载整棵树**，`#root` 变空。页面底色是 #08090a，
 *      于是「整页黑屏」。
 *
 * 这里做三件事：
 *   ① 接住渲染期抛出的任何错误，至少给人一条出路（刷新 / 回首页）；
 *   ② 认出「chunk 加载失败」这一类，**自动刷新一次**（刷新会取到新的
 *      index.html，哈希名自然对上了），并用 sessionStorage 限流防止死循环；
 *   ③ 认出普通渲染错误时，不说"页面崩溃"这种吓人的话，只给一个能继续用的出口。
 *
 * 注意：错误边界只接**渲染期**错误。事件回调和 Promise 里的错误要靠
 * `vite:preloadError`（在 main.tsx 里接）和页面自己的 try/catch。
 */

/** chunk 加载失败的几种长相（不同浏览器/打包器文案不一样） */
const CHUNK_ERROR = new RegExp(
  [
    'Failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'Importing a module script failed',
    'Loading chunk \\d+ failed',
    'Loading CSS chunk',
    'ChunkLoadError',
  ].join('|'),
  'i',
);

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  return CHUNK_ERROR.test(`${e.name ?? ''} ${e.message ?? ''}`);
}

const RETRY_KEY = 'ctbu:chunk-reload-at';
/** 两次自动刷新之间至少隔这么久，避免「刷了还是 404」时无限循环 */
const RETRY_COOLDOWN_MS = 15_000;

/**
 * 自动刷新一次来取新的 index.html。
 * 返回 true = 已经发起刷新；false = 刚刷过，别再刷了（交给界面兜底）。
 */
export function autoReloadOnce(): boolean {
  const now = Date.now();
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RETRY_KEY) ?? 0) || 0;
  } catch {
    /* 隐私模式下 sessionStorage 可能抛错，当作"没刷过" */
  }
  if (now - last < RETRY_COOLDOWN_MS) return false;
  try {
    sessionStorage.setItem(RETRY_KEY, String(now));
  } catch {
    /* 同上 */
  }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
  /** 换页时传一个新值，边界会自动复位（否则一次报错会一直卡住后续页面） */
  resetKey?: string;
  /** 出错时先回首页的按钮要不要显示（登录页之类不需要） */
  showHome?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留证据：线上出问题时能在控制台看到是哪一段挂的
    console.error('[页面错误]', error, info.componentStack);
    if (isChunkLoadError(error)) {
      // 典型的「版本更新了、旧哈希没了」：刷新一次就好，不用打扰用户
      autoReloadOnce();
    }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);

    return (
      <div className="flex min-h-[70vh] items-center justify-center bg-page px-5">
        <div className="w-full max-w-md">
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline/[0.10] bg-elevate/[0.04]">
            <AlertTriangle className="h-4 w-4 text-gray-500" aria-hidden="true" />
          </div>

          <h1 className="mt-6 text-[22px] font-medium tracking-[-0.02em] text-gray-900">
            {chunk ? '页面资源没取到' : '这一页没能打开'}
          </h1>
          <p className="mt-2.5 text-[14px] leading-relaxed text-gray-500">
            {chunk
              ? '站点已更新，您的浏览器仍在引用旧版本资源。点击下方按钮重新载入即可恢复。'
              : '可能是刚才的网络抖动，或者一时的程序问题。重新载入通常就能恢复。'}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 rounded-lg bg-solid px-5 py-2.5 text-[14px] font-medium text-on-solid transition-all duration-150 hover:bg-solid-hover active:scale-[0.99]"
            >
              <RefreshCw className="h-4 w-4" /> 重新载入
            </button>
            {this.props.showHome !== false && (
              <button
                type="button"
                onClick={() => {
                  // 用 hash 回首页：不依赖 AppContext，边界里也不该假设它在
                  window.location.hash = '#/';
                  this.setState({ error: null });
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-hairline/[0.12] px-5 py-2.5 text-[14px] text-gray-600 transition-colors hover:border-hairline/[0.22] hover:text-gray-900"
              >
                <Home className="h-4 w-4" /> 回首页
              </button>
            )}
          </div>

          {/* 具体报错收在下面，折叠起来：学生不需要看见，但排查时要有 */}
          <details className="mt-8 text-[12px] text-gray-400">
            <summary className="cursor-pointer select-none hover:text-gray-500">技术细节</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all font-mono leading-relaxed">
              {error.name}: {error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
