import { useEffect, useState } from 'react';
import { CalendarHeart, X } from 'lucide-react';

/**
 * 创始会员试用期延长通知（2026-10-23）
 *
 * 用户决定：把所有创始会员的试用期延长到 2026-12-31，覆盖四六级 + 期末，
 * 并在他们下次上线时告知一声。
 *
 * ── 三个设计决定 ─────────────────────────────────────────────
 *
 * ① **等开屏动画过去再弹**（用户明确要求「开屏动画过了一秒左右」）
 *    首页整页加载会播放约 2 秒的签名动画（见 index.html 里的 splash）。
 *    如果弹窗立刻出现，会被压在动画上 —— 既难看，也让人没看清动画就关了。
 *    这里用 2900ms：splash 最长 4400ms 兜底移除，但正常路径约 2.
 *    2s 结束，留 700ms 缓冲。只在**首页**等（其他页没有 splash，见下方 SHOULD_WAIT）。
 *
 * ② **只给创始会员看**
 *    按 is_founder 判断，且**排除已是永久会员的**（他们本来就没到期问题，
 *    弹了反而莫名其妙）。
 *
 * ③ **只弹一次，看过永久记住**
 *    存 localStorage，不设过期。同一个浏览器不再打扰。
 *    不做「每次登录都弹」—— 那是骚扰，会让人对站内提示免疫。
 *
 * ── 为什么前端判断而不是后端 ────────────────────────────────
 * 会员信息前端已经从 /api/auth/session 拿到了（含 is_founder / tier）。
 * 后端不需要为这个一次性通知加字段或状态。
 */

const SEEN_KEY = 'ctbu:founder-extended-2026-12-31';

export function FounderExtendedNotice({ isFounder, tier, isLifetime }: {
  isFounder: boolean;
  tier?: string | null;
  /**
   * 是不是**永久有效**的账号（2026-10-30 加）。
   *
   * ⚠️ 不能再用 `tier === 'lifetime'` 单独判断：老创始会员的 tier 是 `'founder'`，
   * 但 `membership_expires_at = 'infinity'` —— 也就是**永久**。
   * 原来只排除 `tier==='lifetime'`，于是这 2 个老号会收到
   * 「你的创始会员有效期已延长至 12 月 31 日」——对一个永久账号说这个很荒谬。
   */
  isLifetime?: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // 永久会员不需要这个通知
    if (!isFounder || isLifetime || tier === 'lifetime') return;
    // 已经看过就不再弹
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
    } catch { /* 隐私模式读不到 localStorage —— 那就弹一次，不阻断 */ }

    /**
     * 首页有开屏动画，要等它播完（约 2.2s + 缓冲）。
     * 其他页面没有 splash（见 index.html 里的 isHome 判断），
     * 800ms 足够让页面渲染稳定，不必干等 3 秒。
     */
    const hash = window.location.hash;
    const onHome = hash === '' || hash === '#/' || hash === '#/home';
    const delay = onHome ? 2900 : 800;

    const t = window.setTimeout(() => setOpen(true), delay);
    return () => window.clearTimeout(t);
  }, [isFounder, tier, isLifetime]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 忽略 */ }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl bg-ink-850 shadow-2xl animate-slide-up-panel">
        <div className="flex items-start gap-3 border-b border-hairline/[0.08] p-5">
          <CalendarHeart className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">创始会员有效期已延长</h3>
            <p className="mt-1 text-xs text-gray-500">延长至 2026 年 12 月 31 日</p>
          </div>
          <button
            onClick={close}
            aria-label="关闭"
            className="shrink-0 rounded-lg p-1 text-gray-400 transition-colors hover:bg-elevate/[0.06] hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <p className="text-sm leading-relaxed text-gray-900">
            为感谢每一位创始会员的支持，现已将所有创始会员有效期延长至 12 月 31 日，
            以保障您的四六级与期末考试复习，预祝所有创始会员考试顺利！
          </p>
        </div>

        <div className="border-t border-hairline/[0.08] p-4 text-right">
          <button
            onClick={close}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-deep"
          >
            好的，谢谢
          </button>
        </div>
      </div>
    </div>
  );
}
