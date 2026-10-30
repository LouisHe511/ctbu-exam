import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { loadCetIndex, CET_BANDS, type CetIndex, type CetIndexSet, type CetBandId } from '@/lib/cet';
import { cetPaperPdfName, cetPaperPdfUrl, OBJECTIVE_TOTAL } from '@/lib/cetPaper';
import { BookOpen, Headphones, FileText, Download, Loader2, Lock, CheckCircle2 } from 'lucide-react';

/**
 * 四六级真题 · 选择入口
 * =================================================================
 * 这是导航「四六级」点进来的第一页。之前没有这一页，学生从导航进来直接落在
 * **听力页**上，想要整套卷还得从听力页里"顺便"跳出去 —— 用户明确否掉了那个结构
 * （"不要整的像做听力顺便跳出来了整套试卷"）。
 *
 * 现在三层各就各位：
 *   #/cet                 → 本页：选套（四级/六级 × 24 套，一眼看全）
 *   #/cet/listen/<套>      → 只练这一套的听力
 *   #/cet-paper/<套>       → 做这一套的整卷（写作/听力/阅读/翻译）
 *
 * 下载口径（用户 2026-10-16 拍板）：
 *   · **原题 PDF 谁都能下**（不需要会员，链接也不带鉴权）
 *   · **原题+答案解析 PDF 只有会员能下**，入口在每套的试卷页里（不在这张卡片上），
 *     因为下载前要过会员校验，放在卡片上会变成"点了才知道不给下"
 */

interface Progress {
  answered: number;
  submitted: boolean;
}

/** 从本地存的作答进度里读出「已答 n/55」「已提交」——两套 key 都看（听力页 / 全卷页各存一份） */
function readProgress(fullSlug: string, setSlug: string): Progress | null {
  const keys = [`cet-paper:${fullSlug}`, `cet-state:${setSlug}`];
  for (const k of keys) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const st = JSON.parse(raw) as { answers?: Record<string, string>; submitted?: boolean };
      const n = Object.keys(st.answers ?? {}).length;
      if (n > 0 || st.submitted) return { answered: n, submitted: Boolean(st.submitted) };
    } catch {
      /* 坏数据忽略 */
    }
  }
  return null;
}

export function CetHomePage() {
  const { navigate } = useApp();
  const { session, loading: authLoading } = useAuth();
  const [index, setIndex] = useState<CetIndex | null>(null);
  const [band, setBand] = useState<CetBandId>('cet4');
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void (async () => {
      setIndex(await loadCetIndex());
      setBooted(true);
    })();
  }, []);

  const sets: CetIndexSet[] = useMemo(() => index?.bands?.[band]?.sets ?? [], [index, band]);

  // 进度只在挂载时读一次（这页不常驻，回来时会重新 mount）
  const progress = useMemo(() => {
    const map = new Map<string, Progress | null>();
    for (const b of CET_BANDS) {
      for (const s of index?.bands?.[b]?.sets ?? []) {
        map.set(`${b}-${s.slug}`, readProgress(`${b}-${s.slug}`, s.slug));
      }
    }
    return map;
  }, [index]);

  if (authLoading) {
    return <Centered><Loader2 className="w-5 h-5 text-gray-700 animate-spin" /></Centered>;
  }
  if (!session) {
    /*
     * 未登录引导页（2026-10-21 重做）。
     * 原来是一小块「图标 + 标题 + 按钮」挤在左上角，下面 800px 全是空的 ——
     * 在深色全屏里看起来像页面崩了，不像"需要登录"。
     * 现在做成居中的完整引导：居中标题 + 说明 + 主次两个动作。
     */
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-page px-5 pt-[73px] pb-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(120,142,158,0.13),transparent_70%)] blur-3xl"
        />
        <div className="relative mx-auto max-w-md text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-hairline/[0.10] bg-elevate/[0.04]">
            <Lock className="h-4 w-4 text-gray-500" aria-hidden="true" />
          </div>

          <p className="mt-7 font-mono text-[10px] uppercase tracking-[0.18em] text-gray-400">CET · 四六级</p>
          <h1 className="mt-2.5 text-[28px] font-medium leading-tight tracking-[-0.03em] text-gray-900">
            登录后查看四六级真题
          </h1>
          <p className="mx-auto mt-3 max-w-[34ch] text-[14px] leading-relaxed text-gray-500">
            四级、六级各 24 套完整试卷，含听力音频、题目原文与答案解析。
          </p>

          <div className="mt-8 flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigate({ name: 'login' })}
              className="w-full max-w-[260px] rounded-lg bg-solid px-5 py-2.5 text-[14px] font-medium text-on-solid transition-all duration-150 hover:bg-solid-hover active:scale-[0.99]"
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => navigate({ name: 'register' })}
              className="w-full max-w-[260px] rounded-lg border border-hairline/[0.12] px-5 py-2.5 text-[14px] text-gray-600 transition-colors hover:border-hairline/[0.22] hover:text-gray-900"
            >
              创建账号
            </button>
          </div>

          <p className="mt-6 font-mono text-[11px] text-gray-500">
            免费额度用完后再看真题，需要开通会员
          </p>
        </div>
      </div>
    );
  }

  if (!booted) {
    return <Centered><Loader2 className="w-5 h-5 text-gray-700 animate-spin" /></Centered>;
  }

  return (
    <div className="pt-24 pb-20 min-h-screen">
      <div className="max-w-5xl mx-auto px-5">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-elevate/[0.03] flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-gray-900" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">四六级真题</h1>
            <p className="mt-1 text-sm text-gray-500 leading-relaxed">
              四级 / 六级共 {CET_BANDS.reduce((n, b) => n + (index?.bands?.[b]?.sets?.length ?? 0), 0)} 套。
              可以「做整套」（写作 / 听力 / 阅读 / 翻译，提交后统一判分），也可以只练这一套的听力。
            </p>
            <p className="mt-1 text-xs text-gray-500">
              原题 PDF 免费下载；含答案解析的版本在每套的试卷页里（会员）。
            </p>
          </div>
        </div>

        {/* 等级切换 */}
        <div className="mt-6 flex items-center gap-2">
          {CET_BANDS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBand(b)}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                band === b ? 'bg-solid text-on-solid' : 'text-gray-500 hover:bg-solid-hover/[0.03]'
              }`}
            >
              {index?.bands?.[b]?.label ?? b}
            </button>
          ))}
        </div>

        {/* 套卷卡片 */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sets.map((s) => {
            const full = `${band}-${s.slug}`;
            const pg = progress.get(full) ?? null;
            return (
              <div
                key={full}
                className="rounded-2xl border border-hairline/[0.08] p-4 flex flex-col hover:border-hairline/[0.2] transition-colors"
              >
                <p className="text-sm font-semibold text-gray-900">{s.label}</p>
                <p className="mt-1 text-xs text-gray-500">
                  共 {OBJECTIVE_TOTAL} 道客观题 · 6 个部分
                  {s.pieceCount ? ` · 听力 ${s.pieceCount} 篇` : ''}
                  {s.isAlias ? '（听力与第 1 套同一份录音）' : ''}
                </p>

                <div className="mt-2 min-h-[20px]">
                  {pg?.submitted ? (
                    <span className="inline-flex items-center gap-1 text-xs text-gray-800">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 已提交 · 已答 {pg.answered}/{OBJECTIVE_TOTAL}
                    </span>
                  ) : pg ? (
                    <span className="text-xs text-gray-500">已答 {pg.answered}/{OBJECTIVE_TOTAL}（未提交）</span>
                  ) : (
                    <span className="text-xs text-gray-400">还没做过</span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigate({ name: 'cetpaper', slug: full })}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-solid text-on-solid text-xs font-medium hover:bg-solid-hover transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5" /> 做整套
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate({ name: 'cetlisten', slug: full })}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-xs text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
                  >
                    <Headphones className="w-3.5 h-3.5" /> 听力
                  </button>
                  {/* 原题下载：公开文件，不需要会员 */}
                  <a
                    href={cetPaperPdfUrl(full)}
                    download={cetPaperPdfName(s.label)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-xs text-gray-500 hover:bg-solid-hover/[0.03] transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> 原题
                  </a>
                </div>
              </div>
            );
          })}
        </div>

        {sets.length === 0 && (
          <p className="mt-6 text-sm text-gray-500">真题清单暂时取不到，请稍后再试。</p>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-24 pb-20 min-h-screen flex items-start justify-center">{children}</div>
  );
}
