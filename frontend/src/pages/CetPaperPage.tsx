import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { useAccess } from '@/context/AccessContext';
import { ListeningPlayer, type PlayerHandle } from '@/components/ListeningPlayer';
import { confirmDialog } from '@/lib/dialog';
import { useScrollHide } from '@/hooks/useScrollHide';
import {
  pieceRanges, toPlayerPieces, type CetQuestion, type CetSetFull,
} from '@/lib/cet';
import {
  loadCetAnswerKey, loadCetExplain, loadCetListening, loadCetPaper, loadCetSolutionUrl,
  cetPaperPdfName, cetPaperPdfUrl, cetSolutionPdfName,
  explainIndex, OBJECTIVE_TOTAL,
  type BankWord, type CetExplain, type CetPaper, type ExplainBlock, type ExplainItem,
  type MatchingPara, type MatchingStmt, type PaperBanked, type PaperMatching,
  type PaperReading, type PaperSection, type ReadingPassage,
} from '@/lib/cetPaper';
import {
  BookOpen, Check, ChevronDown, Download, Eye, EyeOff, Loader2, Lock, Play,
  RotateCcw, Send, Sparkles, X, ArrowLeft,
} from 'lucide-react';

/**
 * 四六级「全卷交互」页面
 * =================================================================
 * 学生在这里做**整套卷**：写作、听力、选词填空、信息匹配、仔细阅读、翻译。
 *
 * 设计口径全部对齐听力页（用户已认可的那一套）：
 *   · **一页到底**，顶部按题型分段，不跳来跳去
 *   · 客观题点选作答，**点「提交答案」后统一判分**（不是每题即时判）
 *   · 每题一个「查看解析」，**默认收起**；另有顶部「查看解析」总开关，不必先作答
 *   · 主观题（写作/翻译）给作答框，不判分；提交后展示参考范文 / 参考译文
 *   · 进度存 localStorage，中途退出不丢
 *
 * 数据可见性（三份数据，别搞混，详见 lib/cetPaper.ts 顶部注释）：
 *   题面 + 答案字母 → 登录可见（随前端部署）
 *   逐题解析文本    → **会员专属**（走 /api/pay/cet-explain，国内服务器校验）
 */
export function CetPaperPage({ slug }: { slug: string }) {
  const { session, loading: authLoading } = useAuth();
  const { navigate } = useApp();
  const { isMember } = useAccess();

  const [paper, setPaper] = useState<CetPaper | null>(null);
  const [answerKey, setAnswerKey] = useState<Record<string, string> | null>(null);
  const [listen, setListen] = useState<CetSetFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [essay, setEssay] = useState('');
  const [translation, setTranslation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  /**
   * 提交条跟随顶部导航一起显隐（2026-10-22 用户要求）。
   *
   * 原来它写死 `sticky top-[64px]` —— 那是"假设导航栏永远在那儿"。
   * 但导航往下滚会收起来（Layout 里用同一套滚动方向判断），
   * 于是屏幕上边永远空着 64px，露出一条缝。
   * 现在两边共用 `useScrollHide`，判据完全一致：
   *   往下滚 → 导航藏 + 提交条贴到 top:0
   *   往上滚 → 导航回来 + 提交条落到 top:64px
   */
  const hideTopBar = useScrollHide(80);
  const [explainAlways, setExplainAlways] = useState(false);
  const [showTrans, setShowTrans] = useState(false);
  const [openExp, setOpenExp] = useState<Set<number>>(new Set());
  const [activePiece, setActivePiece] = useState(0);
  const [booted, setBooted] = useState(false);

  const [explain, setExplain] = useState<CetExplain | null>(null);
  const [explainState, setExplainState] = useState<'idle' | 'loading' | 'locked' | 'error' | 'ready'>('idle');
  const playerRef = useRef<PlayerHandle>(null);

  const band = slug.split('-')[0];
  const setSlug = slug.slice(band.length + 1);
  const STATE_KEY = `cet-paper:${slug}`;


  // ---------------------------------------------------------------- 载入
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [p, k, l] = await Promise.all([
        loadCetPaper(slug),
        loadCetAnswerKey(slug),
        loadCetListening(band, setSlug),
      ]);
      if (cancelled) return;
      setPaper(p);
      setAnswerKey(k);
      setListen(l);
      if (!p) setLoadError('这套试卷的数据暂时取不到，请稍后再试。');
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [slug, band, setSlug]);

  // ---------------------------------------------------- 本地进度（刷新不丢）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as {
          answers?: Record<number, string>; essay?: string;
          translation?: string; submitted?: boolean;
        };
        if (s.answers) setAnswers(s.answers);
        if (s.essay) setEssay(s.essay);
        if (s.translation) setTranslation(s.translation);
        if (s.submitted) setSubmitted(true);
      }
    } catch { /* 隐私模式下 localStorage 不可用，忽略 */ }
    setBooted(true);
  }, [STATE_KEY]);

  const persist = useCallback(() => {
    if (!booted) return;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ answers, essay, translation, submitted }));
    } catch { /* ignore */ }
  }, [STATE_KEY, answers, essay, translation, submitted, booted]);

  useEffect(() => { persist(); }, [persist]);

  // ---------------------------------------------------------------- 交互
  const pick = useCallback((no: number, letter: string) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (next[no] === letter) delete next[no];   // 再点一次 = 取消
      else next[no] = letter;
      return next;
    });
  }, []);

  const toggleExp = useCallback((no: number) => {
    setOpenExp((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no); else next.add(no);
      return next;
    });
  }, []);

  /** 解析是会员内容 —— 非会员点进来时给一个明确的去路，而不是静默失败 */
  const askMember = useCallback(async () => {
    const go = await confirmDialog(
      '四六级全卷的题目与音频对登录用户开放；逐题解析、写作范文与参考译文属于会员内容。\n\n要现在去了解会员吗？',
      { confirmLabel: '了解会员' },
    );
    if (go) navigate({ name: 'membership' });
  }, [navigate]);

  /** 展开某题解析前：先确认会员，再把解析数据拉进来 */
  const ensureExplain = useCallback(async (): Promise<boolean> => {
    if (explain) return true;
    if (!isMember) { void askMember(); return false; }
    setExplainState('loading');
    const res = await loadCetExplain(slug);
    if (res.ok) { setExplain(res.data); setExplainState('ready'); return true; }
    if (res.reason === 'not_a_member') { void askMember(); setExplainState('locked'); return false; }
    setExplainState('error');
    return false;
  }, [explain, isMember, slug, askMember]);

  const openExplain = useCallback(async (no: number) => {
    const ok = await ensureExplain();
    if (!ok) return;
    setOpenExp((prev) => new Set(prev).add(no));
  }, [ensureExplain]);

  const toggleExplainAlways = useCallback(async () => {
    if (!explainAlways) {
      const ok = await ensureExplain();
      if (!ok) return;
    }
    setExplainAlways((v) => !v);
  }, [explainAlways, ensureExplain]);

  const submit = useCallback(async () => {
    // 主观题不判分，但客观题的判分需要答案；答案字母是公开数据，已随题面加载
    setSubmitted(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const reset = useCallback(() => {
    setAnswers({}); setEssay(''); setTranslation('');
    setSubmitted(false); setOpenExp(new Set());
  }, []);

  // ---------------------------------------------------------------- 数据整理
  const sections = paper?.sections ?? [];
  const sec = useMemo(() => {
    const map: Partial<Record<PaperSection['id'], PaperSection>> = {};
    for (const s of sections) map[s.id] = s;
    return map;
  }, [sections]);
  const expIdx = useMemo(() => explainIndex(explain), [explain]);

  /** 题号 → 正确答案字母（听力走听力数据，26–55 走公开答案表） */
  const answerOf = useCallback((no: number): string | undefined => {
    if (no <= 25) return listen?.questions.find((q) => q.no === no)?.answer;
    return answerKey?.[String(no)];
  }, [listen, answerKey]);

  const objectiveNos = useMemo(() => {
    const nos: number[] = [];
    if (listen) nos.push(...listen.questions.map((q) => q.no));
    const b = sec.banked as PaperBanked | undefined;
    const m = sec.matching as PaperMatching | undefined;
    const r = sec.reading as PaperReading | undefined;
    if (b) nos.push(...b.questionNos);
    if (m) nos.push(...m.statements.map((x: MatchingStmt) => x.no));
    if (r) for (const p of r.passages) nos.push(...p.questions.map((q) => q.no));
    return nos;
  }, [listen, sec]);

  const answered = objectiveNos.filter((n) => answers[n]).length;
  const right = submitted ? objectiveNos.filter((n) => answers[n] === answerOf(n)).length : 0;
  const wrongNos = submitted ? objectiveNos.filter((n) => answers[n] && answers[n] !== answerOf(n)) : [];

  const ranges = useMemo(() => (listen ? pieceRanges(listen) : []), [listen]);
  const playerPieces = useMemo(() => (listen ? toPlayerPieces(listen) : []), [listen]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(`sec-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** 播放器是吸底的，所以挂在页面级（不是塞进听力 section 里） */
  const playPiece = useCallback((i: number) => {
    setActivePiece(i);
    playerRef.current?.playPiece(i);
  }, []);

  // ---------------------------------------------------------------- 门禁
  if (authLoading) {
    return <Centered><Loader2 className="w-5 h-5 text-gray-700 animate-spin" /></Centered>;
  }
  if (!session) {
    return (
      <div className="pt-24 pb-20 min-h-screen">
        <div className="max-w-2xl mx-auto px-5">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-elevate/[0.03] flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5 text-gray-900" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">四六级全卷</h1>
              <p className="mt-1 text-sm text-gray-500 leading-relaxed">
                四六级全卷仅对登录用户开放 —— 题目、原文与音频都一样。
              </p>
            </div>
          </div>
          <button
            type="button" onClick={() => navigate({ name: 'login' })}
            className="mt-6 inline-flex items-center px-5 py-3 rounded-lg bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover transition-colors"
          >
            登录 / 注册
          </button>
        </div>
      </div>
    );
  }
  if (loading || !booted) {
    return <Centered><Loader2 className="w-5 h-5 text-gray-700 animate-spin" /></Centered>;
  }
  if (!paper) {
    return (
      <div className="pt-24 pb-20 min-h-screen">
        <div className="max-w-2xl mx-auto px-5">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">四六级全卷</h1>
          <p className="mt-4 text-sm text-gray-500">{loadError || '数据暂时不可用。'}</p>
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

  const bandLabel = band === 'cet4' ? '英语四级' : '英语六级';

  return (
    // pb：移动端要给「播放器 + 底部导航」两层留位（141px），md 以上没有导航故回落到 pb-32
    <div
      className="pt-24 pb-36 md:pb-32 min-h-screen"
      // 导航收起时把粘性栏的落点上移 73px（见上面 STICKY_LEFT 的说明）
      style={{ ['--ctbu-cet-top' as string]: hideTopBar ? '4.25rem' : '8.5rem' }}
    >
      <div className="max-w-2xl mx-auto px-5">
        {/* ── 顶部 ── */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button" onClick={() => navigate({ name: 'cet' })}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" /> 真题列表
          </button>
          <h1 className="text-lg font-semibold tracking-tight text-gray-900">
            {bandLabel} · 全卷
          </h1>
          {listen?.isAlias && (
            <span className="text-xs text-gray-500">（与第 1/2 套共用听力）</span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">
          共 6 个部分 · 客观题 {OBJECTIVE_TOTAL} 道 · 写作与翻译不判分，提交后给参考范文与译文
        </p>

        {/* ── 下载（原题免费 / 原题+解析 会员） ── */}
        <DownloadRow
          slug={slug}
          label={listen?.label ?? setSlug}
          isMember={isMember}
          onNeedMember={() => void askMember()}
        />

        {/*
          ── 提交/成绩条（吸顶 + 跟随导航显隐） ──
          导航栏高 73px，所以导航显示时提交条落在 top-[73px]；
          导航收起时贴到 top:0，把屏幕空间还给学生。
          transition 用 transform/height 之外的属性会引发布局抖动，
          所以这里只过渡 `top`，200ms，比导航的 300ms 快一点，
          两条一起动时不会显得拖泥带水。
        */}
        <div
          className={`sticky z-30 -mx-5 px-5 py-3 mt-3 bg-page/95 backdrop-blur border-b border-hairline/[0.08] transition-[top] duration-200 ease-out ${
            hideTopBar ? 'top-0' : 'top-[73px]'
          }`}
        >
          <div className="flex items-center gap-3 flex-wrap">
            {!submitted ? (
              <>
                <p className="text-sm text-gray-500">
                  已答 <span className="text-gray-900 font-medium">{answered}</span>/{objectiveNos.length}
                </p>
                <div className="ml-auto flex items-center gap-2">
                  {/*
                    2026-10-22：这个按钮原来叫「查看解析」，实际作用是"解锁每道题的按钮"，
                    用户点完发现还得再点具体某题 —— 两步。现在改名为「展开全部」，
                    语义变成批量操作：一键展开所有题的解析，再点一次全部收起。
                    单题的「查看解析」按钮始终存在，不再依赖这个开关。
                  */}
                  <button
                    type="button" onClick={() => void toggleExplainAlways()}
                    aria-pressed={explainAlways}
                    title={explainAlways ? '收起所有题目的解析' : '展开所有题目的解析'}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      explainAlways
                        ? 'border-hairline/[0.2] bg-elevate/[0.06] text-gray-800'
                        : 'border-hairline/[0.08] text-gray-900 hover:bg-solid-hover/[0.03]'
                    }`}
                  >
                    <BookOpen className="w-4 h-4" />
                    {explainAlways ? '收起全部' : '展开全部'}
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
                  <span className="font-semibold">客观题答对 {right}</span>
                  <span className="text-gray-500"> / {objectiveNos.length} 道</span>
                  {wrongNos.length > 0 && (
                    <span className="ml-2 text-red-700">错 {wrongNos.length} 道</span>
                  )}
                </p>
                <div className="ml-auto flex items-center gap-3">
                  <button
                    type="button" onClick={() => void toggleExplainAlways()}
                    aria-pressed={explainAlways}
                    title={explainAlways ? '收起所有题目的解析' : '展开所有题目的解析'}
                    className={`inline-flex items-center gap-1 text-xs ${explainAlways ? 'text-gray-800' : 'text-gray-500 hover:text-gray-900'}`}
                  >
                    <BookOpen className="w-3.5 h-3.5" /> {explainAlways ? '收起全部' : '展开全部'}
                  </button>
                  <button
                    type="button" onClick={() => setShowTrans((v) => !v)}
                    aria-pressed={showTrans}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                  >
                    {showTrans ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} 中文
                  </button>
                  <button
                    type="button" onClick={reset}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> 重做
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── 题型分段导航 ── */}
        {explainState === 'loading' && (
          <p className="mt-2 text-xs text-gray-500">正在取解析…</p>
        )}
        {explainState === 'error' && (
          <p className="mt-2 text-xs text-red-700">解析暂时取不到，请稍后重试。</p>
        )}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {sections.map((s) => (
            <button
              key={s.id} type="button" onClick={() => jumpTo(s.id)}
              className="px-2.5 py-1.5 rounded-lg border border-hairline/[0.08] text-xs text-gray-500 hover:bg-solid-hover/[0.03] transition-colors"
            >
              {s.name}
              {rangeLabel(s) && (
                <span className="ml-1 text-[10px] text-gray-400">{rangeLabel(s)}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── 各题型 ── */}
        <div className="mt-6 space-y-10">
          {sections.map((s) => (
            <section key={s.id} id={`sec-${s.id}`} className="scroll-mt-32">
              <SectionBody
                section={s}
                slug={slug}
                listen={listen}
                ranges={ranges}
                activePiece={activePiece}
                onPlayPiece={playPiece}
                answers={answers}
                onPick={pick}
                submitted={submitted}
                explainAlways={explainAlways}
                showTrans={showTrans}
                openExp={openExp}
                onOpenExplain={openExplain}
                onToggleExp={toggleExp}
                answerOf={answerOf}
                exp={expIdx}
                fullExplain={explain}
                essay={essay}
                setEssay={setEssay}
                translation={translation}
                setTranslation={setTranslation}
                onNeedMember={() => void askMember()}
              />
            </section>
          ))}
        </div>

        {/* 底部再放一次提交，长页面不用滚回顶部 */}
        {!submitted && (
          <div className="mt-10 flex justify-center">
            <button
              type="button" onClick={() => void submit()}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover transition-colors"
            >
              <Send className="w-4 h-4" /> 提交答案
            </button>
          </div>
        )}
      </div>

      {/* 吸底播放器：挂在页面级（它有 position:fixed，放哪都一样，但页面级更清楚） */}
      {listen && (
        <ListeningPlayer
          ref={playerRef}
          audio={listen.audio}
          slug={listen.slug}
          pieces={playerPieces}
          onActivePiece={setActivePiece}
        />
      )}
    </div>
  );
}

/** 分段导航里显示的题号区间 */
function rangeLabel(s: PaperSection): string | null {
  if ('range' in s) return `${s.range[0]}–${s.range[1]}`;
  if (s.id === 'listening') return '1–25';
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-24 pb-20 min-h-screen flex items-start justify-center">{children}</div>
  );
}

// ================================================================= 下载
/**
 * 下载区（用户 2026-10-16 定的口径）：
 *   · **原题 PDF：谁都能下**（服务器上是公开静态文件，链接本身不带鉴权）
 *   · **原题+解析 PDF：会员专享** —— 先带 token 换一个短效签名链接，再交给浏览器下载
 *
 * 为什么不用 <a href> 直接指向会员文件：那就等于把文件公开了。
 * 为什么下载用 <a download>：签名链接与本站同源，`download` 属性才生效，
 * 这样能给出中文文件名（服务器上文件名是 ASCII，避免 URL 编码那一堆坑）。
 */
function DownloadRow({
  slug, label, isMember, onNeedMember,
}: {
  slug: string; label: string; isMember: boolean; onNeedMember: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const getSolution = async () => {
    setErr('');
    if (!isMember) { onNeedMember(); return; }
    setBusy(true);
    const res = await loadCetSolutionUrl(slug);
    setBusy(false);
    if (res.ok) { triggerDownload(res.url, cetSolutionPdfName(label)); return; }
    if (res.reason === 'not_a_member') { onNeedMember(); return; }
    setErr('解析版暂时取不到，请稍后再试。');
  };

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <a
        href={cetPaperPdfUrl(slug)}
        download={cetPaperPdfName(label)}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
      >
        <Download className="w-4 h-4" /> 下载原题 PDF
        <span className="text-xs text-gray-500">免费</span>
      </a>
      <button
        type="button"
        onClick={() => void getSolution()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        下载原题 + 答案解析
        <span className="text-xs text-gray-500">{isMember ? 'PDF' : '会员'}</span>
      </button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </div>
  );
}

/** 同源链接才认 `download` 的中文文件名；这里统一走一个隐式 <a> 触发 */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ================================================================= 破格容器
/**
 * 阅读类题目在宽屏下要「左原文 / 右题目」并排 —— 比正文列（max-w-2xl ≈ 672px）宽太多。
 * 这里用「撑到视口宽 + 反向偏移」把自己居中放大，**不动外层容器**
 * （听力/写作/翻译仍保持原来的窄栏，读起来更舒服）。
 * ⚠️ 手机（< lg）不加任何类，保持原来的上下堆叠 —— 手机上左右分栏没法看。
 */
function Wide({ children }: { children: React.ReactNode }) {
  return (
    <div className="lg:relative lg:left-1/2 lg:-translate-x-1/2 lg:w-[calc(100vw-7rem)] lg:max-w-[1180px]">
      {children}
    </div>
  );
}

/** 左栏（原文）在宽屏下吸顶 + 自己滚动：学生往下翻题时原文一直看得见 */
/*
 * 左侧粘性栏的 top 偏移（2026-10-22）。
 *
 * 原来写死 `lg:top-[8.5rem]` = 73px 导航 + 提交条 —— 那是"导航永远在"的假设。
 * 导航一收起，这个 73px 的空档就露出来了。
 *
 * 为什么用 CSS 变量而不是传 prop：
 *   这几个粘性栏在三个不同的子组件里（短文填空 / 匹配 / 阅读），
 *   逐个把 hideTopBar 传下去要改三层 props。变量挂在页面根节点上，
 *   所有后代自动跟随，一处赋值全站生效。
 */
const STICKY_LEFT =
  'lg:sticky lg:top-[var(--ctbu-cet-top,8.5rem)] lg:max-h-[calc(100vh-var(--ctbu-cet-top,8.5rem)-1.5rem)] lg:overflow-y-auto';

// ================================================================= 各题型
interface SectionProps {
  section: PaperSection;
  slug: string;
  listen: CetSetFull | null;
  ranges: { from: number; to: number }[];
  activePiece: number;
  onPlayPiece: (i: number) => void;
  answers: Record<number, string>;
  onPick: (no: number, L: string) => void;
  submitted: boolean;
  explainAlways: boolean;
  showTrans: boolean;
  openExp: Set<number>;
  onOpenExplain: (no: number) => void;
  onToggleExp: (no: number) => void;
  answerOf: (no: number) => string | undefined;
  /** 会员解析按题号索引（未加载时为空表，展开时会提示需要会员） */
  exp: Map<number, ExplainItem>;
  fullExplain: CetExplain | null;
  essay: string;
  setEssay: (s: string) => void;
  translation: string;
  setTranslation: (s: string) => void;
  onNeedMember: () => void;
}

function SectionBody(p: SectionProps) {
  const { section: s } = p;
  switch (s.id) {
    case 'writing':
      return (
        <Subjective
          s={s as Extract<PaperSection, { id: 'writing' }>}
          value={p.essay} onChange={p.setEssay}
          submitted={p.submitted}
          model={p.fullExplain?.writing?.model}
          modelZh={p.fullExplain?.writing?.modelZh}
          paras={p.fullExplain?.writing?.paras}
          onNeedMember={p.onNeedMember}
        />
      );
    case 'listening':
      return <ListeningBody {...p} />;
    case 'banked':
      return <BankedBody {...p} />;
    case 'matching':
      return <MatchingBody {...p} />;
    case 'reading':
      return <ReadingBody {...p} />;
    case 'translation':
      return (
        <Subjective
          s={s as Extract<PaperSection, { id: 'translation' }>}
          value={p.translation} onChange={p.setTranslation}
          submitted={p.submitted}
          reference={p.fullExplain?.translation?.reference}
          onNeedMember={p.onNeedMember}
        />
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ 写作 / 翻译
function Subjective({
  s, value, onChange, submitted, model, modelZh, paras, reference, onNeedMember,
}: {
  s: Extract<PaperSection, { id: 'writing' | 'translation' }>;
  value: string; onChange: (v: string) => void;
  submitted: boolean;
  model?: string; modelZh?: string; paras?: ExplainBlock[]; reference?: string;
  onNeedMember: () => void;
}) {
  const isWriting = s.id === 'writing';
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div>
      <SectionHead name={s.name} meta={isWriting ? `${s.minutes} 分钟` : `${s.minutes} 分钟`} />
      <div className="mt-3 rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/50 p-4">
        <p className="text-sm text-gray-900 leading-relaxed">{s.directions}</p>
        {!isWriting && s.prompt && (
          <p className="mt-3 text-sm text-gray-900 leading-relaxed whitespace-pre-wrap">{s.prompt}</p>
        )}
        {isWriting && (s.minWords || s.maxWords) && (
          <p className="mt-2 text-xs text-gray-500">
            要求 {s.minWords ?? '—'}–{s.maxWords ?? '—'} 词
          </p>
        )}
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={isWriting ? 10 : 8}
        placeholder={isWriting ? '在这里写作文…' : '在这里写英文翻译…'}
        className="mt-3 w-full rounded-xl border border-hairline/[0.08] bg-ink-900 p-3 text-sm leading-relaxed text-gray-900 placeholder:text-gray-400 outline-none resize-y transition-colors focus:border-hairline/[0.2] focus:bg-ink-850 focus:ring-1 focus:ring-hairline/[0.08]"
      />
      <p className="mt-1 text-xs text-gray-500">
        已写 {words} 词{isWriting ? '（本题不判分，可对照下方范文自查）' : '（本题不判分，可对照下方参考译文自查）'}
      </p>

      {submitted && (
        <div className="mt-4 space-y-3">
          {model ? (
            <ExplainCard title={isWriting ? '参考范文' : '参考译文'} defaultOpen>
              <p className="whitespace-pre-wrap">{model}</p>
              {modelZh && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-gray-500">查看范文中文翻译</summary>
                  <p className="mt-2 text-gray-500 whitespace-pre-wrap">{modelZh}</p>
                </details>
              )}
            </ExplainCard>
          ) : null}
          {reference ? (
            <ExplainCard title="参考译文" defaultOpen>
              <p className="whitespace-pre-wrap">{reference}</p>
            </ExplainCard>
          ) : null}
          {paras && paras.length > 0 && (
            <ExplainCard title="逐段解析">
              {paras.map((b) => (
                <p key={b.k} className="mb-2">
                  <span className="font-medium text-gray-900">【{b.k}】</span>
                  {b.v}
                </p>
              ))}
            </ExplainCard>
          )}
          {!model && !reference && (
            <button
              type="button" onClick={onNeedMember}
              className="inline-flex items-center gap-1.5 text-sm text-gray-800 hover:underline"
            >
              <Sparkles className="w-4 h-4" /> 会员可查看参考范文 / 译文与逐段解析
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 听力
function ListeningBody(p: SectionProps) {
  const { listen, ranges, onPlayPiece, activePiece } = p;
  if (!listen) {
    return (
      <div>
        <SectionHead name="听力" meta="25 分钟 · 1–25 题" />
        <p className="mt-3 text-sm text-gray-500">听力数据暂时取不到。</p>
      </div>
    );
  }
  return (
    <div>
      <SectionHead name="听力" meta={`25 分钟 · 1–25 题 · ${listen.bandLabel}`} />
      <p className="mt-2 text-xs text-gray-500">
        一篇录音对应 2~5 道题，先听完整篇再答这几道题。播放器在屏幕底部常驻。
      </p>

      {listen.pieces.map((pc, pi) => {
        const r = ranges[pi];
        const qs = listen.questions.filter((q) => q.no >= r.from && q.no <= r.to);
        return (
          <div key={pc.anchor} className="mt-5">
            <div className="rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/60 px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm font-medium text-gray-900">
                  第 {pi + 1} 篇
                  <span className="ml-1.5 text-xs font-normal text-gray-500">
                    第 {r.from}–{r.to} 题 · 共 {qs.length} 题
                  </span>
                </p>
                <button
                  type="button" onClick={() => onPlayPiece(pi)}
                  className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-solid text-on-solid text-xs font-medium hover:bg-solid-hover transition-colors"
                >
                  <Play className="w-3.5 h-3.5" fill="currentColor" /> 播放本篇
                </button>
              </div>
              {pc.title && <p className="mt-2 text-xs text-gray-500 leading-relaxed">{pc.title}</p>}
            </div>
            <div className="mt-4 space-y-6">
              {qs.map((q) => (
                <QuestionBlock
                  key={q.no}
                  no={q.no}
                  stem={q.stemEn}
                  stemZh={q.transStem}
                  options={listen.options[String(q.no)] ?? {}}
                  optionsZh={q.transChoices}
                  picked={p.answers[q.no]}
                  onPick={(L) => p.onPick(q.no, L)}
                  submitted={p.submitted}
                  showTrans={p.showTrans}
                  answer={q.answer}
                  qtype={q.qtype}
                  canExplain
                  expanded={p.openExp.has(q.no) || p.explainAlways}
                  onOpenExplain={() => void p.onOpenExplain(q.no)}
                  onToggleExp={() => p.onToggleExp(q.no)}
                  listeningQ={q}
                />
              ))}
            </div>
          </div>
        );
      })}
      <p className="mt-3 text-xs text-gray-500">
        当前定位：第 {activePiece + 1} 篇
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ 选词填空
function BankedBody(p: SectionProps) {
  const s = p.section as Extract<PaperSection, { id: 'banked' }>;
  const zh = p.fullExplain?.faceZh?.banked ?? [];
  return (
    <div>
      <SectionHead name={s.name} meta="26–35 题 · 每题从 15 词库里选一个" />
      <Wide>
        <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-6 lg:items-start">
          {/* 左：带空位的短文 */}
          <div className={`rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/50 p-4 ${STICKY_LEFT}`}>
            {s.paras.map((t, i) => (
              <div key={i} className={i > 0 ? 'mt-3' : ''}>
                <p className="text-sm leading-relaxed text-gray-900 whitespace-pre-wrap">
                  {renderBlanks(t, p.answers, p.submitted, p.answerOf, s.questionNos)}
                </p>
                {/* 「中文」开关：段中译来自会员解析数据 */}
                {p.showTrans && zh[i] && (
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{zh[i]}</p>
                )}
              </div>
            ))}
          </div>

          {/* 右：词库 + 26–35 的作答卡 */}
          <div className="mt-3 lg:mt-0 space-y-3">
            <div className="rounded-xl border border-hairline/[0.08] p-4">
              <p className="text-xs font-medium text-gray-500">词库（A–O）</p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                {s.bank.map((b: BankWord) => (
                  <p key={b.letter} className="text-sm text-gray-900">
                    <span className="font-medium">{b.letter})</span> {b.word}
                  </p>
                ))}
              </div>
            </div>

            {s.questionNos.map((no) => (
              <div key={no} className="rounded-xl border border-hairline/[0.08] p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900">第 {no} 题</span>
                  <PickLetters
                    letters={s.bank.map((b) => b.letter)}
                    picked={p.answers[no]}
                    answer={p.answerOf(no)}
                    submitted={p.submitted}
                    onPick={(L) => p.onPick(no, L)}
                  />
                  <ExplainToggle
                    no={no}
                    visible
                    expanded={p.openExp.has(no) || p.explainAlways}
                    loading={false}
                    onOpen={() => void p.onOpenExplain(no)}
                    onToggle={() => p.onToggleExp(no)}
                  />
                </div>
                {(p.openExp.has(no) || p.explainAlways) && <ExplainBody item={p.exp.get(no)} onNeedMember={p.onNeedMember} />}
              </div>
            ))}
          </div>
        </div>
      </Wide>
    </div>
  );
}

/** 把短文里的 __(26)__ 变成可点选的下拉/胶囊 */
function renderBlanks(
  text: string, answers: Record<number, string>, submitted: boolean,
  answerOf: (no: number) => string | undefined, nos: number[],
) {
  const parts = text.split(/(__\(\d+\)__)/g);
  return parts.map((seg, i) => {
    const m = /^__\((\d+)\)__$/.exec(seg);
    if (!m) return <span key={i}>{seg}</span>;
    const no = Number(m[1]);
    const picked = answers[no];
    const ans = answerOf(no);
    let cls = 'border-hairline/[0.08] bg-ink-850 text-gray-500';
    if (submitted && picked) {
      cls = picked === ans ? 'border-hairline/[0.2] bg-elevate/[0.06] text-gray-800'
                           : 'border-red-500/40 bg-red-500/10 text-red-700';
    } else if (picked) {
      cls = 'border-solid bg-solid text-on-solid';
    }
    void nos;
    return (
      <span
        key={i}
        className={`inline-flex items-center justify-center min-w-[3.2rem] px-1.5 mx-0.5 rounded-md border text-xs font-medium align-baseline ${cls}`}
        title={`第 ${no} 题`}
      >
        {no}
        {picked ? `:${picked}` : ''}
      </span>
    );
  });
}

// ------------------------------------------------------------------ 信息匹配
function MatchingBody(p: SectionProps) {
  const s = p.section as Extract<PaperSection, { id: 'matching' }>;
  return (
    <div>
      <SectionHead name={s.name} meta={`36–45 题 · 从 ${s.paras.length} 个段落里找出处`} />
      <Wide>
        <div className="mt-3 lg:grid lg:grid-cols-2 lg:gap-6 lg:items-start">
          {/* 左：A–L 段落（宽屏吸顶 + 自己滚动） */}
          <div className={`rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/50 p-4 ${STICKY_LEFT}`}>
            <p className="text-xs font-medium text-gray-500">原文段落（A–{s.paras[s.paras.length - 1]?.letter}）</p>
            <div className="mt-2">
              {s.paras.map((para: MatchingPara) => (
                <p key={para.letter} className="mb-2 text-sm leading-relaxed text-gray-900">
                  <span className="font-semibold mr-1">{para.letter})</span>
                  {para.text}
                </p>
              ))}
            </div>
          </div>

          {/* 右：36–45 陈述句 */}
          <div className="mt-3 lg:mt-0 space-y-3">
            <p className="text-xs font-medium text-gray-500">下面每句话出自哪个段落？</p>
            {s.statements.map((st: MatchingStmt) => (
              <div key={st.no} className="rounded-xl border border-hairline/[0.08] p-3">
                {/* 题号统一写成「第 N 题」：与其它题型一致，也让读屏/自动化能按同一口径识别 */}
                <p className="text-sm leading-relaxed text-gray-900">
                  <span className="font-semibold mr-1.5">第 {st.no} 题</span>
                  {st.text}
                </p>
                {/* 「中文」开关在这里也生效：陈述句的中译来自解析数据（会员） */}
                {p.showTrans && p.exp.get(st.no)?.zh && (
                  <p className="mt-1 text-xs text-gray-500 leading-relaxed">{p.exp.get(st.no)!.zh}</p>
                )}
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <PickLetters
                    letters={s.paras.map((x) => x.letter)}
                    picked={p.answers[st.no]}
                    answer={p.answerOf(st.no)}
                    submitted={p.submitted}
                    onPick={(L) => p.onPick(st.no, L)}
                    dense
                  />
                  <ExplainToggle
                    no={st.no}
                    visible
                    expanded={p.openExp.has(st.no) || p.explainAlways}
                    loading={false}
                    onOpen={() => void p.onOpenExplain(st.no)}
                    onToggle={() => p.onToggleExp(st.no)}
                  />
                </div>
                {(p.openExp.has(st.no) || p.explainAlways) && <ExplainBody item={p.exp.get(st.no)} onNeedMember={p.onNeedMember} />}
              </div>
            ))}
          </div>
        </div>
      </Wide>
    </div>
  );
}

// ------------------------------------------------------------------ 仔细阅读
function ReadingBody(p: SectionProps) {
  const s = p.section as Extract<PaperSection, { id: 'reading' }>;
  return (
    <div>
      <SectionHead name={s.name} meta="46–55 题 · 两篇" />
      {s.passages.map((psg: ReadingPassage, pi: number) => {
        const zh = (pi === 0 ? p.fullExplain?.faceZh?.reading1 : p.fullExplain?.faceZh?.reading2) ?? [];
        return (
        <div key={psg.label} className="mt-5">
          <p className="text-sm font-semibold text-gray-900">
            {psg.label}
            <span className="ml-2 text-xs font-normal text-gray-500">
              {psg.from}–{psg.to} 题
            </span>
          </p>
          {/* 宽屏：左原文右题目，不用上下翻；手机：维持上下堆叠 */}
          <Wide>
            <div className="mt-2 lg:grid lg:grid-cols-2 lg:gap-6 lg:items-start">
              <div className={`rounded-xl border border-hairline/[0.08] bg-elevate/[0.03]/50 p-4 ${STICKY_LEFT}`}>
                {psg.paras.map((t, i) => (
                  <div key={i} className={i > 0 ? 'mt-2' : ''}>
                    <p className="text-sm leading-relaxed text-gray-900">{t}</p>
                    {/* 「中文」开关：段中译来自会员解析数据 */}
                    {p.showTrans && zh[i] && (
                      <p className="mt-1 text-xs leading-relaxed text-gray-500">{zh[i]}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 lg:mt-0 space-y-6">
                {psg.questions.map((q) => (
                  <QuestionBlock
                    key={q.no}
                    no={q.no}
                    stem={q.stem}
                    stemZh={p.exp.get(q.no)?.stemZh}
                    options={q.options}
                    optionsZh={p.exp.get(q.no)?.optionsZh}
                    picked={p.answers[q.no]}
                    onPick={(L) => p.onPick(q.no, L)}
                    submitted={p.submitted}
                    showTrans={p.showTrans}
                    answer={p.answerOf(q.no)}
                    canExplain
                    expanded={p.openExp.has(q.no) || p.explainAlways}
                    onOpenExplain={() => void p.onOpenExplain(q.no)}
                    onToggleExp={() => p.onToggleExp(q.no)}
                    explainItem={p.exp.get(q.no)}
                    onNeedMember={p.onNeedMember}
                  />
                ))}
              </div>
            </div>
          </Wide>
        </div>
        );
      })}
    </div>
  );
}

// ================================================================= 零件
function SectionHead({ name, meta }: { name: string; meta?: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-hairline/[0.08] pb-2">
      <h2 className="text-base font-semibold tracking-tight text-gray-900">{name}</h2>
      {meta && <span className="text-xs text-gray-500">{meta}</span>}
    </div>
  );
}

/** 选项按钮组（A–D 或段落 A–N），判分口径与听力页一致 */
function PickLetters({
  letters, picked, answer, submitted, onPick, dense,
}: {
  letters: string[]; picked?: string; answer?: string; submitted: boolean;
  onPick: (L: string) => void; dense?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {letters.map((L) => {
        let cls = 'border-hairline/[0.08] text-gray-900 hover:bg-solid-hover/[0.03]';
        if (!submitted) {
          if (picked === L) cls = 'border-solid bg-solid text-on-solid';
        } else if (answer === L) {
          cls = 'border-hairline/[0.2] bg-elevate/[0.06]/70 text-gray-800';
        } else if (picked === L) {
          cls = 'border-red-500/40 bg-red-500/10 text-red-700';
        } else {
          cls = 'border-hairline/[0.08] text-gray-400';
        }
        return (
          <button
            key={L} type="button" disabled={submitted} onClick={() => onPick(L)}
            className={`${dense ? 'w-7 h-7 text-xs' : 'w-8 h-8 text-sm'} rounded-lg border font-medium transition-colors disabled:cursor-default ${cls}`}
          >
            {L}
          </button>
        );
      })}
    </div>
  );
}

/** 完整题干 + 四个选项（听力 / 仔细阅读用） */
function QuestionBlock({
  no, stem, stemZh, options, optionsZh, picked, onPick, submitted, showTrans,
  answer, qtype, canExplain, expanded, onOpenExplain, onToggleExp,
  listeningQ, explainItem, onNeedMember,
}: {
  no: number; stem: string; stemZh?: string;
  options: Record<string, string>; optionsZh?: Record<string, string>;
  picked?: string; onPick: (L: string) => void; submitted: boolean; showTrans: boolean;
  answer?: string; qtype?: string;
  canExplain: boolean; expanded: boolean;
  onOpenExplain: () => void; onToggleExp: () => void;
  /** 听力题：解析已在听力数据里，用专用渲染 */
  listeningQ?: CetQuestion;
  /** 阅读类题：解析来自会员接口 */
  explainItem?: ExplainItem;
  onNeedMember?: () => void;
}) {
  const right = submitted && picked === answer;
  const wrong = submitted && picked !== undefined && picked !== answer;
  return (
    <div className="rounded-xl border border-hairline/[0.08] p-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-900">第 {no} 题</span>
        {qtype && <span className="text-xs text-gray-500">{qtype}</span>}
        {submitted && (
          right ? <span className="inline-flex items-center gap-1 text-xs text-gray-800">
              <Check className="w-3.5 h-3.5" />答对
            </span>
            : wrong ? <span className="inline-flex items-center gap-1 text-xs text-red-700">
              <X className="w-3.5 h-3.5" />答错 · 正确答案 {answer}
            </span>
            : <span className="text-xs text-gray-500">未作答 · 正确答案 {answer}</span>
        )}
      </div>

      {stem && <p className="mt-2 text-base text-gray-900 leading-relaxed">{stem}</p>}
      {showTrans && stemZh && <p className="mt-1 text-sm text-gray-500">{stemZh}</p>}

      <ul className="mt-3 space-y-2">
        {(['A', 'B', 'C', 'D'] as const).map((L) => {
          const isPicked = picked === L;
          const isAnswer = answer === L;
          let cls = 'border-hairline/[0.08] hover:bg-solid-hover/[0.03]';
          if (!submitted) {
            if (isPicked) cls = 'border-solid bg-solid text-on-solid';
          } else if (isAnswer) {
            cls = 'border-hairline/[0.2] bg-elevate/[0.06]/60';
          } else if (isPicked) {
            cls = 'border-red-500/40 bg-red-500/10';
          } else {
            cls = 'border-hairline/[0.08] opacity-60';
          }
          const muted = !submitted && isPicked;
          const body = options[L];
          if (!body) return null;
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
                      {body}
                    </span>
                    {showTrans && optionsZh?.[L] && (
                      <span className={`block text-xs mt-0.5 ${muted ? 'text-white/75' : 'text-gray-500'}`}>
                        {optionsZh[L]}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <ExplainToggle
          no={no} visible={canExplain} expanded={expanded} loading={false}
          onOpen={onOpenExplain} onToggle={onToggleExp} hasListening={!!listeningQ}
        />
      </div>
      {/*
        解析面板必须**两种题型都接上**。
        这里曾经只写了听力那支（`listeningQ`），结果仔细阅读 46–55 点「查看解析」
        点了没任何反应 —— 按钮在、状态也在变，就是面板不渲染。实测页面才抓到。
      */}
      {expanded && listeningQ && <ListeningExplain q={listeningQ} />}
      {expanded && !listeningQ && (
        <ExplainBody item={explainItem} onNeedMember={onNeedMember} />
      )}
    </div>
  );
}

/**
 * 单题「查看解析」按钮（2026-10-22 改版）
 *
 * 之前的行为：顶部有个总开关「查看解析」，**点了之后**每道题才会长出这个按钮，
 * 用户还得再点一次具体那道题 —— 两步才看到一份解析，看着像坏了。
 *
 * 现在：每道题旁边**始终**有这个按钮，点一下直接展开。
 * 顶部总开关改成「展开全部 / 收起全部」，作用从"解锁入口"变成"批量操作"。
 *
 * 视觉上从文字下划线改成带边框的小按钮 —— 它是个动作，不是个链接。
 */
function ExplainToggle({
  no, visible, expanded, loading, onOpen, onToggle, hasListening,
}: {
  no: number; visible: boolean; expanded: boolean; loading: boolean;
  onOpen: () => void; onToggle: () => void; hasListening?: boolean;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={() => (expanded ? onToggle() : onOpen())}
      aria-expanded={expanded}
      title={hasListening ? `查看第 ${no} 题的解析` : `查看第 ${no} 题的解析（会员内容）`}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        expanded
          ? 'border-hairline/[0.22] bg-elevate/[0.06] text-gray-800'
          : 'border-hairline/[0.10] text-gray-600 hover:border-hairline/[0.22] hover:bg-elevate/[0.04] hover:text-gray-900'
      }`}
    >
      <BookOpen className="w-3.5 h-3.5" />
      {loading ? '加载中…' : expanded ? '收起解析' : '查看解析'}
      <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
  );
}

/** 阅读类题目的解析面板（【答案】【判型】【定位】…） */
function ExplainBody({ item, onNeedMember }: { item?: ExplainItem; onNeedMember?: () => void }) {
  if (!item) {
    return (
      <div className="mt-3 rounded-lg bg-elevate/[0.03] p-3 text-xs text-gray-500">
        解析需要会员权限。
        {onNeedMember && (
          <button type="button" onClick={onNeedMember} className="ml-1 text-gray-800 hover:underline">
            了解会员
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg bg-elevate/[0.03] p-3 space-y-2 text-sm">
      {item.zh && <p className="text-gray-900">{item.zh}</p>}
      {item.blocks.map((b, i) => (
        <p key={i} className="leading-relaxed text-gray-900">
          <span className="font-medium text-gray-800">【{b.k}】</span>
          {b.v}
        </p>
      ))}
    </div>
  );
}

/** 听力已有完整的逐题解析（原文定位 / 信号 / 排除 / 改写），直接复用 */
function ListeningExplain({ q }: { q: CetQuestion }) {
  return (
    <div className="mt-3 rounded-lg bg-elevate/[0.03] p-3 space-y-2 text-sm">
      <p className="text-gray-900">
        <span className="font-medium text-gray-800">【答案】</span>
        {q.answer}
        {q.qtype && <span className="ml-1 text-xs text-gray-500">（{q.qtype}）</span>}
      </p>
      {q.correctEn && (
        <p className="leading-relaxed text-gray-900">
          <span className="font-medium text-gray-800">【正确项原文】</span>
          {q.correctEn}
        </p>
      )}
      {q.locate?.en && (
        <p className="leading-relaxed text-gray-900">
          <span className="font-medium text-gray-800">【定位】</span>
          {q.locate.en}
        </p>
      )}
      {q.locate?.zh && <p className="text-gray-500 leading-relaxed">{q.locate.zh}</p>}
      {q.signalText && (
        <p className="leading-relaxed text-gray-900">
          <span className="font-medium text-gray-800">【信号】</span>
          {q.signalText}
        </p>
      )}
      {q.verdicts?.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-gray-800">【排除】</p>
          {q.verdicts.map((v, i) => (
            <p key={i} className="text-gray-900 leading-relaxed">
              {v.letter}) {v.flag}{v.reason ? ` —— ${v.reason}` : ''}
            </p>
          ))}
        </div>
      )}
      {q.pairs?.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-gray-800">【改写】</p>
          {q.pairs.map((pr, i) => (
            <p key={i} className="text-gray-900 leading-relaxed">
              {pr.orig} ↔ {pr.opt}{pr.why ? `（${pr.why}）` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ExplainCard({
  title, children, defaultOpen,
}: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded-xl border border-hairline/[0.08] overflow-hidden">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-gray-900 hover:bg-solid-hover/[0.03]"
      >
        <BookOpen className="w-4 h-4 text-gray-700" />
        {title}
        <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-4 pb-4 text-sm leading-relaxed text-gray-900">{children}</div>}
    </div>
  );
}
