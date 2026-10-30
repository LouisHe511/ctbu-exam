import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Headphones, Loader2, BookOpen, Eye, EyeOff, Check, X, RotateCcw, Play,
  ChevronDown, ChevronRight, Send, Lock, FileText, ArrowLeft, Download,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import {
  loadCetIndex, loadCetSet, toPlayerPieces, pieceRanges, paraAnchor,
  CET_BANDS,
  type CetIndex, type CetIndexSet, type CetSetFull, type CetQuestion, type CetBandId,
} from '@/lib/cet';
import { cetPaperPdfName, cetPaperPdfUrl } from '@/lib/cetPaper';
import { ListeningPlayer, type PlayerHandle } from '@/components/ListeningPlayer';
// 项目约定：不要用 window.confirm / window.alert —— 浏览器会静默抑制，表现为「点了没反应」
import { confirmDialog } from '@/lib/dialog';
import { useScrollHide } from '@/hooks/useScrollHide';

/**
 * 四六级听力
 *
 * ⚠️ 两条**必须守住**的设计（都是用户当面纠正过的，别改回去）
 *
 * 【一】最小单元是**篇**，不是题
 *   一篇录音对应 2~5 道题（四级 8 篇 `1-2/3-4/5-7/8-11/12-15/16-18/19-21/22-25`；
 *   六级 7 篇 `1-4/5-8/9-11/12-15/16-18/19-21/22-25`）。学生是「听完一篇 → 连着答那几道题」。
 *
 * 【二】判定时机 = **做完整套、点提交之后**，不是每题即时判
 *   学生的真实流程是**模考**：从头做到尾，全部做完再对答案。
 *   所以：
 *     · 未提交：选项只记录"我选了哪个"（中性高亮），**不提示对错、不给解析**
 *     · 点「提交答案」→ 一次性标出对✓/错✗ + 正确答案 + 得分
 *     · 解析**不主动铺开**，每题给一个「查看解析」按钮，想看才点开
 *   另外**所有题在同一条长页里从上到下排**，不需要在篇之间手动跳转
 *   （页首那排只是"跳到某篇"的快捷锚点，不是必须的步骤）。
 *
 * 抄自原站的"科学"（保留）：
 *   · 点解析里的 **`P1` 药丸** → 展开原文抽屉、滚到该段、高亮
 *   · 段号 P1/P2… 与解析【定位】是同一套编号
 *   · 吸底播放器：±10 秒 / 变速 / 上一段下一段 / preload=none
 */

interface SavedState {
  answers: Record<number, string>;
  submitted: boolean;
}
const STATE_KEY = (slug: string) => `cet-state:${slug}`;

export function CetPage({ slug: fullSlug }: { slug: string }) {
  /** 提交条跟随顶部导航显隐（2026-10-22，与 CetPaperPage / Layout.Header 同一套判据） */
  const hideTopBar = useScrollHide(80);
  const { navigate } = useApp();
  const { session, loading: authLoading } = useAuth();

  /** 形如 `cet4-2024-12-1`：前 4 位是等级，后面是套号（与试题数据、答案表同一口径） */
  const band = fullSlug.split('-')[0] as CetBandId;
  const slug = fullSlug.slice(band.length + 1);

  const [index, setIndex] = useState<CetIndex | null>(null);
  const [set, setSet] = useState<CetSetFull | null>(null);
  const [loadingSet, setLoadingSet] = useState(false);
  const [booted, setBooted] = useState(false);

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [openExp, setOpenExp] = useState<Set<number>>(new Set());
  /** 「查看解析」总开关：打开后**不必先作答**也能逐题看解析（用户要求随时可看） */
  const [explainAlways, setExplainAlways] = useState(false);
  const [showTrans, setShowTrans] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [hl, setHl] = useState<{ q: number; seq: number } | null>(null);
  const [activePiece, setActivePiece] = useState(0);

  const playerRef = useRef<PlayerHandle | null>(null);

  // -------------------------------------------------------------- 载入清单
  useEffect(() => {
    void (async () => {
      setIndex(await loadCetIndex());
      setBooted(true);
    })();
  }, []);

  const setsMeta: CetIndexSet[] = useMemo(
    () => index?.bands?.[band]?.sets ?? [], [index, band]);

  /**
   * 当前套的元数据。**由 URL 决定，不再有内部 state** ——
   * 以前这里是 `useState('')` + 一个 `<select>`，代价是"换套不换地址"，
   * 学生没法把某一套的听力链接发给同学，刷新还会跳回第一套。
   */
  const meta = useMemo(
    () => setsMeta.find((s) => s.slug === slug) ?? null, [setsMeta, slug]);

  // ------------------------------------------------------- 载入单套（懒加载）
  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    setLoadingSet(true);
    void (async () => {
      const d = await loadCetSet(meta.file);
      if (cancelled) return;
      setSet(d);
      setLoadingSet(false);
      setOpenExp(new Set()); setDrawer(false); setHl(null); setActivePiece(0);
      try {
        const raw = localStorage.getItem(STATE_KEY(meta.slug));
        const st = raw ? (JSON.parse(raw) as SavedState) : null;
        setAnswers(st?.answers ?? {});
        setSubmitted(Boolean(st?.submitted));
      } catch { setAnswers({}); setSubmitted(false); }
    })();
    return () => { cancelled = true; };
  }, [meta]);

  const persist = useCallback((a: Record<number, string>, sub: boolean) => {
    try {
      localStorage.setItem(STATE_KEY(slug), JSON.stringify({ answers: a, submitted: sub } satisfies SavedState));
    } catch { /* 忽略 */ }
  }, [slug]);

  const pick = useCallback((no: number, letter: string) => {
    setAnswers((prev) => {
      // 已提交后不允许改答案（要改就点「重做」）
      if (submitted) return prev;
      const next = { ...prev };
      if (next[no] === letter) delete next[no];   // 再点一次 = 取消选择
      else next[no] = letter;
      persist(next, false);
      return next;
    });
  }, [submitted, persist]);

  const submit = useCallback(async () => {
    if (!set) return;
    const unanswered = set.qCount - Object.keys(answers).length;
    if (unanswered > 0) {
      const go = await confirmDialog(
        `还有 ${unanswered} 题没作答，确定提交吗？`, { confirmLabel: '提交' });
      if (!go) return;
    }
    setSubmitted(true);
    persist(answers, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [set, answers, persist]);

  const reset = useCallback(async () => {
    const go = await confirmDialog('清空答案、重新做这一套？', { confirmLabel: '重做', danger: true });
    if (!go) return;
    setAnswers({}); setSubmitted(false); setOpenExp(new Set());
    persist({}, false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [persist]);

  const toggleExp = useCallback((no: number) => {
    setOpenExp((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no); else next.add(no);
      return next;
    });
  }, []);

  // -------------------------------------------------------- 篇 ↔ 题号区间
  const ranges = useMemo(() => (set ? pieceRanges(set) : []), [set]);
  const pieceQuestions = useMemo<CetQuestion[][]>(() => {
    if (!set) return [];
    return ranges.map((r) => set.questions.filter((q) => q.no >= r.from && q.no <= r.to));
  }, [set, ranges]);
  const playerPieces = useMemo(() => (set ? toPlayerPieces(set) : []), [set]);

  const openDrawerAt = useCallback((target: { q: number; seq: number } | null) => {
    setDrawer(true); setHl(target);
  }, []);

  useEffect(() => {
    if (!drawer || !hl) return;
    const el = document.getElementById(paraAnchor(hl.q, hl.seq));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [drawer, hl]);

  const jumpToPiece = useCallback((i: number) => {
    const el = document.getElementById(`piece-${i}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // 登录态还没确定 → 先不动，避免闪一下门禁又跳回内容
  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page pt-[73px] pb-20">
        <Loader2 className="h-5 w-5 animate-spin text-gray-500" aria-hidden="true" />
      </div>
    );
  }

  // ⚠️ 四六级听力**整块要求登录**（题目、解析、原文、音频都一样）——
  //    不能再出现「解析无需登录」这种半开的说法（用户 2026-10-16 明确纠正）
  if (!session) {
    return (
      /* 2026-10-21：与四六级首页统一成居中的完整引导页（原来挤在左上角） */
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-page px-5 pt-[73px] pb-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/3 h-[380px] w-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(120,142,158,0.12),transparent_70%)] blur-3xl"
        />
        <div className="relative mx-auto max-w-md text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-hairline/[0.10] bg-elevate/[0.04]">
            <Lock className="h-4 w-4 text-gray-500" aria-hidden="true" />
          </div>
          <p className="mt-7 font-mono text-[10px] uppercase tracking-[0.18em] text-gray-400">CET · Listening</p>
          <h1 className="mt-2.5 text-[28px] font-medium leading-tight tracking-[-0.03em] text-gray-900">四六级听力</h1>
          <p className="mx-auto mt-3 max-w-[34ch] text-[14px] leading-relaxed text-gray-500">
            听力音频、题目原文与解析仅对登录用户开放。
          </p>
          <button
            type="button"
            onClick={() => navigate({ name: 'login' })}
            className="mt-8 w-full max-w-[260px] rounded-lg bg-solid px-5 py-2.5 text-[14px] font-medium text-on-solid transition-all hover:bg-solid-hover active:scale-[0.99]"
          >
            登录
          </button>
        </div>
      </div>
    );
  }

  if (!booted || (loadingSet && !set)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page pt-[73px] pb-20">
        <Loader2 className="h-5 w-5 animate-spin text-gray-500" aria-hidden="true" />
      </div>
    );
  }

  if (booted && index && !meta) {
    return (
      <div className="pt-24 pb-20 min-h-screen">
        <div className="max-w-2xl mx-auto px-5">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">四六级听力</h1>
          <p className="mt-4 text-sm text-gray-500">
            没有找到「{fullSlug}」这一套，可能是链接抄错了。
          </p>
          <button
            type="button" onClick={() => navigate({ name: 'cet' })}
            className="mt-6 text-sm text-gray-800 hover:underline"
          >
            ← 回到真题列表
          </button>
        </div>
      </div>
    );
  }

  if (!index || !set || !meta || !ranges.length) {
    return (
      <div className="pt-24 pb-20 min-h-screen">
        <div className="max-w-2xl mx-auto px-5">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">四六级听力</h1>
          <p className="mt-4 text-sm text-gray-500">听力数据暂时不可用，请稍后再试。</p>
        </div>
      </div>
    );
  }

  const answeredCount = Object.keys(answers).length;
  const rightCount = set.questions.filter((x) => answers[x.no] === x.answer).length;
  const wrongNos = set.questions.filter((x) => answers[x.no] && answers[x.no] !== x.answer).map((x) => x.no);

  return (
    // pb：移动端要给「播放器 + 底部导航」两层留位（141px），md 以上没有导航故回落到 pb-32
    <div className="pt-24 pb-36 md:pb-32 min-h-screen">
      <div className="max-w-2xl mx-auto px-5">
        {/* ── 顶部：回真题列表 + 等级 + 套卷（换套 = 换地址，链接可分享） ── */}
        <button
          type="button" onClick={() => navigate({ name: 'cet' })}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" /> 真题列表
        </button>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Headphones className="w-4 h-4 text-gray-500 shrink-0" />
          {CET_BANDS.map((b) => (
            <button
              key={b} type="button"
              onClick={() => {
                // 换等级时优先保留"同一套"（如 cet4-2024-12-1 → cet6-2024-12-1），
                // 那边没有这套再退回该等级的第一套
                const list = index?.bands?.[b]?.sets ?? [];
                if (!list.length) return;
                const same = list.find((x) => x.slug === slug);
                navigate({ name: 'cetlisten', slug: `${b}-${(same ?? list[0]).slug}` });
              }}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                band === b ? 'bg-solid text-on-solid' : 'text-gray-500 hover:bg-solid-hover/[0.03]'
              }`}
            >
              {index.bands[b]?.label ?? b}
            </button>
          ))}
          <select
            value={slug}
            onChange={(e) => navigate({ name: 'cetlisten', slug: `${band}-${e.target.value}` })}
            aria-label="选择套卷"
            className="ml-auto text-sm border border-hairline/[0.08] rounded-lg px-2.5 py-1.5 bg-ink-850 text-gray-900"
          >
            {setsMeta.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
          </select>
        </div>

        {set.isAlias && (
          <p className="mt-2 text-xs text-gray-500">
            本套听力与「{setsMeta.find((x) => x.slug === set.sourceSlug)?.label ?? set.sourceSlug}」是同一份录音，题目与解析因而相同。
          </p>
        )}

        {/* ── 同一套的其它入口 ──
            听力只是整卷的一部分。这里并排给两条去路：做整套、下载原题 PDF。
            （导航进来的第一屏是「真题列表」，不是这里 —— 用户明确要求过） */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => navigate({ name: 'cetpaper', slug: `${band}-${slug}` })}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
          >
            <FileText className="w-4 h-4" />
            做整套试卷
            <span className="text-xs text-gray-500">（含写作 / 阅读 / 翻译）</span>
          </button>
          {/* 原题 PDF 是公开文件，不需要会员 */}
          <a
            href={cetPaperPdfUrl(`${band}-${slug}`)}
            download={cetPaperPdfName(meta.label)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-500 hover:bg-solid-hover/[0.03] transition-colors"
          >
            <Download className="w-4 h-4" />
            原题 PDF
          </a>
        </div>

        {/*
          ── 提交/成绩条（吸顶 + 跟随导航显隐） ──
          2026-10-22：原来写死 top-[73px]，导航收起后会留一条空档。
          现在导航藏 → 贴到 top:0；导航回来 → 回到 73px。
        */}
        <div
          className={`sticky z-30 -mx-5 mt-3 border-b border-hairline/[0.08] bg-page/95 px-5 py-3 backdrop-blur transition-[top] duration-200 ease-out ${
            hideTopBar ? 'top-0' : 'top-[73px]'
          }`}
        >
          <div className="flex items-center gap-3 flex-wrap">
            {!submitted ? (
              <>
                <p className="text-sm text-gray-500">
                  全卷 {set.qCount} 题 · 已答 <span className="font-mono font-medium text-gray-900 tabular-nums">{answeredCount}</span><span className="text-gray-500">/{set.qCount}</span>
                </p>
                <div className="ml-auto flex items-center gap-2">
                  {/* ★ 右上角：随时查看解析（不必先作答） */}
                  <button
                    type="button"
                    onClick={() => setExplainAlways((v) => !v)}
                    aria-pressed={explainAlways}
                    title="打开后每道题都会出现「查看解析」，不必先作答"
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      explainAlways
                        ? 'border-hairline/[0.2] bg-elevate/[0.06] text-gray-800'
                        : 'border-hairline/[0.08] text-gray-900 hover:bg-solid-hover/[0.03]'
                    }`}
                  >
                    <BookOpen className="w-4 h-4" />
                    查看解析
                  </button>
                  <button
                    type="button" onClick={() => void submit()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover transition-colors"
                  >
                    <Send className="w-4 h-4" /> 提交答案
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-900">
                  <span className="font-semibold">答对 {rightCount}</span>
                  <span className="text-gray-500"> / {set.qCount} 题</span>
                  {wrongNos.length > 0 && (
                    <span className="ml-2 text-red-700">错 {wrongNos.length} 题</span>
                  )}
                </p>
                <div className="ml-auto flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setExplainAlways((v) => !v)}
                    aria-pressed={explainAlways}
                    className={`inline-flex items-center gap-1 text-xs ${explainAlways ? 'text-gray-800' : 'text-gray-500 hover:text-gray-900'}`}
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    查看解析
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTrans((v) => !v)}
                    aria-pressed={showTrans}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                  >
                    {showTrans ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    中文
                  </button>
                  <button
                    type="button" onClick={() => void reset()}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> 重做
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── 篇快捷跳转（只是锚点；下面所有题本来就在同一页） ── */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {ranges.map((r, i) => {
            const qs = pieceQuestions[i] ?? [];
            const done = qs.filter((x) => answers[x.no]).length;
            const wrong = submitted && qs.some((x) => answers[x.no] && answers[x.no] !== x.answer);
            const tone = done === 0
              ? 'border-hairline/[0.08] text-gray-500 hover:bg-solid-hover/[0.03]'
              : wrong
                ? 'border-red-500/40 bg-red-500/10 text-red-700'
                : submitted
                  ? 'border-hairline/[0.2] bg-solid text-on-solid'
                  : 'border-solid bg-solid text-on-solid';
            return (
              <button
                key={r.from} type="button" onClick={() => jumpToPiece(i)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${tone}`}
                title={`跳到第 ${i + 1} 篇（第 ${r.from}–${r.to} 题）`}
              >
                第{i + 1}篇 · {r.from}–{r.to}题
              </button>
            );
          })}
        </div>

        {/* ── 全部篇 + 全部题：一页到底，从上到下 ── */}
        <div className="mt-6 space-y-8">
          {set.pieces.map((pc, pi) => {
            const r = ranges[pi];
            const qs = pieceQuestions[pi] ?? [];
            return (
              <section key={pc.anchor} id={`piece-${pi}`} className="scroll-mt-32">
                {/* 篇头：题号区间 + 播放本篇 + 篇题 */}
                <div className="rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/60 px-4 py-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-sm font-medium text-gray-900">
                      第 {pi + 1} 篇
                      <span className="ml-1.5 text-xs font-normal text-gray-500">
                        第 {r.from}–{r.to} 题 · 共 {qs.length} 题
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => { setActivePiece(pi); playerRef.current?.playPiece(pi); }}
                      className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-solid text-on-solid text-xs font-medium hover:bg-solid-hover transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" fill="currentColor" /> 播放本篇
                    </button>
                  </div>
                  {pc.title && (
                    <p className="mt-2 text-xs text-gray-500 leading-relaxed">{pc.title}</p>
                  )}
                </div>

                {/* 该篇的题（同一页里顺排） */}
                <div className="mt-4 space-y-6">
                  {qs.map((q) => (
                    <QuestionItem
                      key={q.no}
                      q={q}
                      options={set.options[String(q.no)] ?? {}}
                      picked={answers[q.no]}
                      submitted={submitted}
                      explainAlways={explainAlways}
                      showTrans={showTrans}
                      expanded={openExp.has(q.no)}
                      onPick={(L) => pick(q.no, L)}
                      onToggleExp={() => toggleExp(q.no)}
                      onLocate={openDrawerAt}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {/* 底部再给一次提交/重做（做完最后一题就在手边） */}
        <div className="mt-10 flex items-center gap-3">
          {!submitted ? (
            <button
              type="button" onClick={() => void submit()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover transition-colors"
            >
              <Send className="w-4 h-4" /> 提交答案（已答 {answeredCount}/{set.qCount}）
            </button>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                答对 {rightCount}/{set.qCount}
              </p>
              <button
                type="button" onClick={() => void reset()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
              >
                <RotateCcw className="w-4 h-4" /> 重做这一套
              </button>
            </>
          )}
        </div>

        {/* ── 原文抽屉 ── */}
        <div className="mt-6">
          {!drawer ? (
            <button
              type="button" onClick={() => openDrawerAt(null)}
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
            >
              <BookOpen className="w-4 h-4" /> 展开本套听力原文
            </button>
          ) : (
            <div className="rounded-xl border border-hairline/[0.08] p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-gray-900">听力原文</p>
                <button
                  type="button" onClick={() => { setDrawer(false); setHl(null); }}
                  className="text-xs text-gray-500 hover:text-gray-900"
                >
                  收起
                </button>
              </div>
              <div className="mt-4 space-y-6">
                {set.pieces.map((pc, pi) => (
                  <div key={pc.anchor}>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-xs text-gray-500">
                        第 {pi + 1} 篇 · {ranges[pi]?.from}–{ranges[pi]?.to}题
                        {pi === activePiece && <span className="ml-1.5 text-gray-700">· 当前播放</span>}
                      </p>
                      <button
                        type="button"
                        onClick={() => { setActivePiece(pi); playerRef.current?.playPiece(pi); }}
                        className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"
                      >
                        <Play className="w-3 h-3" fill="currentColor" /> 播放本篇
                      </button>
                    </div>
                    {pc.paras.map((pa) => {
                      const on = hl && hl.q === pa.ownerQ && hl.seq === pa.seq;
                      return (
                        <div
                          key={pa.seq}
                          id={paraAnchor(pa.ownerQ, pa.seq)}
                          className={`mt-3 pl-3 border-l-2 ${on ? 'border-hairline/[0.2] bg-elevate/[0.06]/50' : 'border-transparent'}`}
                        >
                          <p className="text-sm text-gray-900 leading-relaxed">
                            <span className="text-xs text-gray-500 mr-1.5">P{pa.seq}</span>
                            {pa.en}
                          </p>
                          {(showTrans || on) && pa.zh && (
                            <p className="text-xs text-gray-500 leading-relaxed mt-1">{pa.zh}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>

      <ListeningPlayer
        ref={playerRef}
        audio={set.audio}
        slug={set.slug}
        pieces={playerPieces}
        onActivePiece={setActivePiece}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ 单题 */
interface QProps {
  q: CetQuestion;
  options: Record<string, string>;
  picked?: string;
  submitted: boolean;
  /** 总开关打开时，未提交也允许逐题看解析 */
  explainAlways: boolean;
  showTrans: boolean;
  expanded: boolean;
  onPick: (letter: string) => void;
  onToggleExp: () => void;
  onLocate: (t: { q: number; seq: number }) => void;
}

function QuestionItem({
  q, options, picked, submitted, explainAlways, showTrans, expanded, onPick, onToggleExp, onLocate,
}: QProps) {
  const right = submitted && picked === q.answer;
  const wrong = submitted && picked !== undefined && picked !== q.answer;

  return (
    <div className="rounded-xl border border-hairline/[0.08] p-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-900">第 {q.no} 题</span>
        {q.qtype && <span className="text-xs text-gray-500">{q.qtype}</span>}
        {/* 判定结果只在提交后出现 */}
        {submitted && (
          right ? (
            <span className="inline-flex items-center gap-1 text-xs text-gray-800">
              <Check className="w-3.5 h-3.5" />答对
            </span>
          ) : wrong ? (
            <span className="inline-flex items-center gap-1 text-xs text-red-700">
              <X className="w-3.5 h-3.5" />答错 · 正确答案 {q.answer}
            </span>
          ) : (
            <span className="text-xs text-gray-500">未作答 · 正确答案 {q.answer}</span>
          )
        )}
      </div>

      <p className="mt-2 text-base text-gray-900 leading-relaxed">{q.stemEn}</p>
      {showTrans && q.transStem && <p className="mt-1 text-sm text-gray-500">{q.transStem}</p>}

      <ul className="mt-3 space-y-2">
        {(['A', 'B', 'C', 'D'] as const).map((L) => {
          const isPicked = picked === L;
          const isAnswer = q.answer === L;
          let cls = 'border-hairline/[0.08] hover:bg-solid-hover/[0.03]';
          if (!submitted) {
            // 未提交：只表示"我选了它"，**不透露对错**
            if (isPicked) cls = 'border-solid bg-solid text-on-solid';
          } else {
            if (isAnswer) cls = 'border-hairline/[0.2] bg-elevate/[0.06]/60';
            else if (isPicked) cls = 'border-red-500/40 bg-red-500/10';
            else cls = 'border-hairline/[0.08] opacity-60';
          }
          const muted = !submitted && isPicked;
          return (
            <li key={L}>
              <button
                type="button" disabled={submitted} onClick={() => onPick(L)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors disabled:cursor-default ${cls}`}
              >
                <span className="flex items-start gap-2">
                  <span className={`font-medium shrink-0 ${muted ? 'text-strong' : 'text-gray-900'}`}>{L})</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-relaxed ${muted ? 'text-strong' : 'text-gray-900'}`}>
                      {options[L] ?? '（选项缺失）'}
                    </span>
                    {showTrans && q.transChoices[L] && (
                      <span className={`block text-xs mt-0.5 ${muted ? 'text-white/75' : 'text-gray-500'}`}>
                        {q.transChoices[L]}
                      </span>
                    )}
                  </span>
                  {submitted && isAnswer && <Check className="w-4 h-4 text-gray-700 shrink-0 mt-0.5" />}
                  {submitted && isPicked && !isAnswer && <X className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* 解析入口：提交后自动出现；或用户在右上角打开了「查看解析」总开关（随时可看） */}
      {(submitted || explainAlways) && (
        <div className="mt-3">
          <button
            type="button" onClick={onToggleExp}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-xs text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {expanded ? '收起解析' : '查看解析'}
          </button>

          {expanded && <ExplainBlocks q={q} onLocate={onLocate} />}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- 解析区块 */
function ExplainBlocks({
  q, onLocate,
}: { q: CetQuestion; onLocate: (t: { q: number; seq: number }) => void }) {
  return (
    <div className="mt-3 pt-3 border-t border-hairline/[0.08]">
      {q.correctEn && (
        <p className="text-xs text-gray-500 leading-relaxed">
          <span className="text-gray-700 font-medium">【答案】</span>
          <span className="text-gray-900 font-medium ml-1">{q.answer}</span>
          <span className="ml-1.5">{q.correctEn}</span>
        </p>
      )}

      {q.locate.refs.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-1.5">
            <span className="text-gray-700 font-medium">【定位】</span>答案句在这一段（点开看原文）
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {q.locate.refs.map((r) => (
              <button
                key={`${r.q}-${r.seq}`} type="button" onClick={() => onLocate({ q: r.q, seq: r.seq })}
                title="在原文里看这一段"
                className="px-2 py-0.5 rounded-md bg-solid text-on-solid text-xs font-medium hover:bg-solid-hover transition-colors"
              >
                {r.label}
              </button>
            ))}
          </div>
          {q.locate.en && <p className="mt-1.5 text-sm text-gray-900 leading-relaxed">{q.locate.en}</p>}
          {q.locate.zh && <p className="mt-1 text-xs text-gray-500 leading-relaxed">{q.locate.zh}</p>}
        </div>
      )}

      {q.signalText && (
        <div className="mt-3">
          <p className="text-xs mb-1">
            <span className="text-gray-700 font-medium">【信号】</span>
            {q.signalCore && <span className="text-gray-900 font-medium">{q.signalCore}</span>}
          </p>
          <p className="text-sm text-gray-500 leading-relaxed">{q.signalText}</p>
        </div>
      )}

      {q.pairs.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-1">
            <span className="text-gray-700 font-medium">【替换】</span>听到的和选项不是同一个说法
          </p>
          <ul className="space-y-1.5">
            {q.pairs.map((p, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="text-gray-900">{p.orig}</span>
                <span className="text-gray-500 mx-1.5">↔</span>
                <span className="text-gray-900">{p.opt}</span>
                {p.why && <span className="block text-xs text-gray-500">{p.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {q.verdicts.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-1">
            <span className="text-gray-700 font-medium">【排除】</span>其余选项错在哪
          </p>
          <ul className="space-y-2">
            {q.verdicts.map((v, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="font-medium text-red-700">{v.letter})</span>
                {v.flag && (
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-700">{v.flag}</span>
                )}
                <span className="block text-gray-500 mt-0.5">{v.reason}</span>
                {v.source && <span className="block text-xs text-gray-500 mt-0.5">{v.source}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
