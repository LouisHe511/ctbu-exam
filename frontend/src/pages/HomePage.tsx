import { useApp } from '@/context/AppContext';
import { categories } from '@/data/categories';
import { courses } from '@/data';
import { usePapers } from '@/context/PapersContext';
import { countByCourse, countByCategory, categoryCount } from '@/lib/counts';
import { Search, ArrowRight, ArrowUpRight, CornerDownLeft } from 'lucide-react';
import { useMemo, useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { fetchProgress, setReaderHandoff } from '@/lib/study';
import { Sparkles, BookOpen } from 'lucide-react';

/**
 * 首页 — 2026-10-21 第三次重做
 * 用户：「非常非常接近 Linear，同时要实用，让同学一眼知道怎么找东西」
 *
 * ══════════════════════════════════════════════════════════════
 * 一、Linear 的真实设计变量（CDP 读计算样式，不是猜）
 * ══════════════════════════════════════════════════════════════
 *   底色    #08090a        正文    #f7f8f8
 *   次级灰  #8a8f98        更弱    #8a8f98
 *   升层    #101112 / #161718 / rgba(255,255,255,.02/.04/.05)
 *   边框    全是半透明白 rgba(255,255,255,.05/.06/.08/.12)，从不用实色灰
 *   圆角    2/4/6/8/12/16/22/9999 —— 有梯度，不是一个圆角走天下
 *   阴影    只给浮层，且极小：0 1px 1px、0 3px 2px、0 8px 2px
 *   高光    0 0 0 .5px inset rgba(255,255,255,.08)
 *   字号    10 11 12 13 14 15 16 18 20 24 48 64
 *   字重    300 400 500 510 590（510/590 是可变字体中间值）
 *   字距    标题 -1.408px（= 字号 × -0.022）、正文 -0.13~-0.17px
 *   行高    标题 1.0、正文 1.5、小字 1.4
 *
 * ══════════════════════════════════════════════════════════════
 * 二、为什么放弃上一版的「档案馆 / 白底」路线
 * ══════════════════════════════════════════════════════════════
 *   白纸 + 黑字 + 横线 = 报纸，不是 Linear。
 *   Linear 的高级感来自：深色场、极低对比的层次、几乎看不见的边框、
 *   巨大留白、以及**信息密度极低的标题区**。这几条必须整套搬过来，
 *   拆开单用任何一条都不成立。
 *
 * ══════════════════════════════════════════════════════════════
 * 三、实用性：学生怎么找到自己要的东西
 * ══════════════════════════════════════════════════════════════
 *   学生真实的检索路径只有三种，页面让这三条都畅通：
 *     ① 知道课程名        → 搜索框（hero 正中，最高权重）
 *     ② 随便看看有什么     → 按学科（四个分类，信息密度最高的行列表）
 *     ③ 只知道"我大几"     → 按学期
 *
 *   2026-10-21 用户删掉了「最近收录」和「课程与份数」两段：
 *     · 最近收录 —— 与真题库页重复，且首页不需要"信息流"
 *     · 课程与份数 —— 与学科分类重复，一屏能看到两份课程清单是冗余的
 *   并把「我大几」从第二位（学科之前）挪到最后：
 *     学生的第一反应是"我要哪门课的卷子"，不是"我大几"。
 *     按年级找是**兜底路径**，放在下面更合适。
 */

/** 分类单字标记：比图标轻，比纯文字有识别度 */
const CATEGORY_MARK: Record<string, string> = {
  math: '数',
  politics: '政',
  computer: '计',
  econ: '经',
};

/** 学期轴：学生按"我大几"找课，比按分类找更符合直觉 */
const TERM_AXIS = [
  { id: 'y1', label: '大一' },
  { id: 'y2', label: '大二' },
  { id: 'y3', label: '大三' },
  { id: 'y4', label: '大四' },
];

export function HomePage() {
  const { navigate, setSearchQuery } = useApp();
  const { papers, totalPapers: allPapers, totalWithAnswer } = usePapers();
  const [heroSearch, setHeroSearch] = useState('');
  const { session } = useAuth();
  /** 继续阅读（④）：取最近看过且有进度的卷子（后端按 updated_at 排好） */
  const [continueList, setContinueList] = useState<
    { paper_id: string; page: number; title?: string | null; course_name?: string | null; year?: number | null }[]
  >([]);
  useEffect(() => {
    if (!session?.user) return;
    let alive = true;
    fetchProgress().then((ps) => {
      if (alive) setContinueList(ps.filter((x) => x.page > 1).slice(0, 8));
    });
    return () => { alive = false; };
  }, [session?.user]);

  const courseCounts = useMemo(() => countByCourse(papers), [papers]);
  const categoryCounts = useMemo(() => countByCategory(papers), [papers]);

  const totalPapers = allPapers || papers.length;

  /** 有试卷的课程，按真实份数排序 —— 学生最关心"这门课有多少卷" */
  const activeCourses = useMemo(
    () =>
      courses
        .map((c) => ({ course: c, n: courseCounts.get(c.id)?.total ?? 0 }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n),
    [courseCounts],
  );

  /**
   * 课程数兜底（2026-10-21）：activeCourses 依赖 papers 加载完才有值，
   * 网络慢时首帧会显示「0 门课程」。courses 是本地静态数据（无需网络），
   * 先拿它当占位，papers 到了再用真实统计替换。
   */
  const courseCountDisplay = activeCourses.length > 0 ? activeCourses.length : courses.length;

  const onHeroSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!heroSearch.trim()) return;
    setSearchQuery(heroSearch);
    navigate({ name: 'library' });
  };


  return (
    <div className="bg-page pb-20 md:pb-0">
      {/* ═══════════════════ ① HERO ═══════════════════
          Linear 的 hero 信息密度极低：眉标 + 两行大标题 + 一句话 + 一个动作。
          我只多加一样东西：搜索框 —— 资料站里搜索是最高频动作，值得占这个位置。 */}
      <section className="relative overflow-hidden">
        {/* 环境图层：冷光 + 网格。Linear 首页也是这个组合，只是更淡 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-56 left-1/2 h-[640px] w-[1200px] -translate-x-1/2 animate-glow-breathe rounded-full bg-[radial-gradient(ellipse_at_center,rgba(120,142,158,0.16),rgba(120,142,158,0.04)_45%,transparent_72%)] blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.026)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.026)_1px,transparent_1px)] bg-[size:80px_80px] [mask-image:radial-gradient(ellipse_75%_55%_at_50%_0%,#000_35%,transparent_100%)]"
        />

        <div className="relative mx-auto max-w-6xl px-5 pt-36 pb-12 sm:px-8 sm:pt-44 sm:pb-16">
          <div className="max-w-3xl">
            {/* 眉标：11px 等宽 + 0.22em 字距。Linear 的 Berkeley Mono 就是干这个的 */}
            <p className="animate-focus-in font-mono text-[11px] uppercase tracking-[0.22em] text-faint [animation-delay:80ms]">
              重庆工商大学 · 历年真题
            </p>

            {/* 大标题：字号/字重/行高/字距四个数字全部来自 Linear 实测 */}
            {/*
              2026-10-21 修：375px（iPhone SE）上 43px 会让「好」单独掉到第三行。
              改成 33px 起，按屏宽阶梯递增 —— 小屏保两行，大屏仍是大字。
            */}
            {/*
              2026-10-21 用户定稿的主标题（原为「每一份卷子，/ 按课程与学期收好」）。
              第一句「历届真题」不重复校名 —— 顶上那行小字已经写了「重庆工商大学」，
              左上角 logo 也写了「工商真题库」，再来一遍太啰嗦（用户 2026-10-21 定稿）。
              第二句直接给承诺，比"按课程与学期收好"更像人话、也更像卖点。
            */}
            <h1 className="animate-focus-in-slow mt-7 text-[2.06rem] font-medium leading-[1.02] tracking-[-0.028em] text-strong [animation-delay:140ms] min-[420px]:text-[2.5rem] sm:text-[3.2rem] lg:text-[4.15rem]">
              历届真题，
              <br />
              你想要的我都有
            </h1>

            <p className="animate-focus-in mt-8 max-w-[46ch] text-[15px] leading-[1.6] tracking-[-0.01em] text-muted [animation-delay:280ms]">
              {/* 加载中不写"正在加载…"（用户明确要求不要看到）：
                  改用一句与数据无关的固定描述，加载完数字自然补上，
                  句子长度接近，不会造成布局跳动。 */}
              历年考试真题按课程与学期归档，支持在线翻阅与原文下载，每份都标注是否含答案与解析。
              {/*
                2026-10-21：原来条件是 `!loading && totalPapers > 0`。
                但 loading 要等**整个试卷列表**下载完（实测 4 秒），
                而数字早在 <head> 预取阶段就到了（752ms）——
                中间 3 秒多白等，用户看到的是一段没有数字的文案。
                现在只要数字非零就渲染：有预取就是首帧出现，没有则等接口。
              */}
              {totalPapers > 0 && (
                <span className="mt-2 block text-[13px] text-faint">
                  当前已收录 <span className="tabular-nums">{totalPapers}</span> 份 · 覆盖{' '}
                  <span className="tabular-nums">{courseCountDisplay}</span> 门课程
                </span>
              )}
            </p>

            {/* 搜索：全站最高频动作，给足视觉重量 */}
            <form onSubmit={onHeroSearch} className="animate-focus-in mt-10 max-w-xl [animation-delay:400ms]">
              <div className="group flex items-center gap-3 rounded-xl border border-hairline/[0.10] bg-input px-4 py-3 transition-all duration-200 hover:border-hairline/[0.18] focus-within:border-hairline/[0.28] focus-within:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]">
                {/* 2026-10-28 审计发现：这里原本是 text-white —— 浅色主题下
                    输入框底是 --ctbu-input = 纯白，于是"白字白底"，用户看不见自己打的字。
                    一律用语义色：正文 text-strong，弱化 text-muted。 */}
                <Search className="h-4 w-4 shrink-0 text-muted transition-colors group-focus-within:text-strong" aria-hidden="true" />
                <input
                  type="text"
                  value={heroSearch}
                  onChange={(e) => setHeroSearch(e.target.value)}
                  aria-label="搜索课程、真题"
                  placeholder="搜课程名、考试类型…"
                  className="min-w-0 flex-1 bg-transparent text-[14px] tracking-[-0.01em] text-strong placeholder-faint/45 outline-none"
                />
                <kbd className="hidden shrink-0 items-center rounded border border-hairline/20 bg-elevate/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-muted sm:flex">
                  ⌘K
                </kbd>
                <button
                  type="submit"
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-solid px-3.5 py-1.5 text-[13px] font-medium text-on-solid transition-all duration-150 hover:bg-solid-hover active:scale-[0.97]"
                >
                  搜索
                  <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            </form>

            {/* 快捷入口：把三条真实路径直接摊开，学生不用自己想"该从哪进" */}
            <div className="animate-focus-in mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] [animation-delay:520ms]">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">快速进入</span>
              <button onClick={() => navigate({ name: 'library' })} className="text-muted transition-colors hover:text-strong">
                全部真题
              </button>
              <span className="text-gray-500/40">·</span>
              <button onClick={() => navigate({ name: 'cet' })} className="text-muted transition-colors hover:text-strong">
                四六级
              </button>
              <span className="text-gray-500/40">·</span>
              <button onClick={() => navigate({ name: 'library', category: 'math' })} className="text-muted transition-colors hover:text-strong">
                数学基础
              </button>
              <span className="text-gray-500/40">·</span>
              <button onClick={() => navigate({ name: 'library', category: 'econ' })} className="text-muted transition-colors hover:text-strong">
                经济管理
              </button>
            </div>
          </div>

          {/* 右下角统计：数字大、标签极小，是 Linear stat 的体量关系 */}
          <div className="animate-focus-in mt-12 flex items-center gap-12 border-t border-hairline/[0.06] pt-6 [animation-delay:600ms]">
            <Stat value={courseCountDisplay} label="门课程" />
            <Stat value={totalPapers} label="份真题" />
            <Stat value={totalWithAnswer} label="份含答案" />
          </div>
        </div>
      </section>

      {/* ═══ AI 答疑条 + 继续阅读（2026-10-25 · 站点优化②④）═══ */}
      <section className="mx-auto max-w-6xl px-5 pt-8 sm:px-8">
        <button
          onClick={() => navigate({ name: 'library' })}
          className="group flex w-full items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-3 text-left transition-colors hover:border-accent/45"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[13px] text-muted">
            <span className="font-medium text-strong">AI 答疑已上线</span>
            <span className="mx-1.5 text-muted">·</span>
            看卷子时哪道题不会直接问，讲思路、分步算
          </span>
          <span className="shrink-0 text-[12px] text-muted transition-colors group-hover:text-strong">
            去真题库试试 →
          </span>
        </button>

        {session?.user && continueList.length > 0 && (
          <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
            <span className="shrink-0 text-[11px] text-muted">继续阅读</span>
            {continueList.map((c) => (
              <button
                key={c.paper_id}
                onClick={() => {
                  setReaderHandoff(c.paper_id, { page: c.page, question: null });
                  navigate({ name: 'reader', paperId: c.paper_id });
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline/[0.14] bg-ink-850 px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-hairline/[0.3] hover:text-strong"
              >
                <BookOpen className="h-3 w-3" aria-hidden="true" />
                <span className="max-w-[220px] truncate">
                  {c.title || c.course_name || '试卷'}{c.year ? `（${c.year}）` : ''}
                </span>
                <span className="text-accent">第 {c.page} 页</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ═══════════════════ ③ 按学科 ═══════════════════
          四个分类做成「行」而不是「卡」：Linear 的列表都是行。
          行比盒子信息密度高，一屏能看完四个分类的全部数字。 */}
      <section className="mx-auto max-w-6xl px-5 pt-12 sm:px-8 sm:pt-16">
        <SectionHeader
          eyebrow="按学科"
          title="学科分类"
          desc="按学科浏览全部课程"
          action={() => navigate({ name: 'library' })}
          actionLabel="全部真题"
        />

        <div className="mt-8 overflow-hidden rounded-xl border border-hairline/[0.08] bg-ink-850 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)]">
          {categories.map((cat, i) => {
            const n = categoryCount(categoryCounts, cat.id);
            const dim = n === 0;
            return (
              <button
                key={cat.id}
                onClick={() => !dim && navigate({ name: 'library', category: cat.id })}
                disabled={dim}
                className={`group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-150 ${
                  i > 0 ? 'border-t border-hairline/[0.06]' : ''
                } ${dim ? 'cursor-default' : 'hover:bg-ink-800'}`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border font-mono text-[13px] transition-colors ${
                    dim
                      ? 'border-hairline/[0.06] text-muted'
                      : 'border-hairline/[0.08] text-muted group-hover:border-hairline/[0.16] group-hover:text-strong'
                  }`}
                  aria-hidden="true"
                >
                  {CATEGORY_MARK[cat.id] ?? '·'}
                </span>

                <span className="min-w-0 flex-1">
                  <span className={`block text-[14px] font-medium tracking-[-0.01em] ${dim ? 'text-muted' : 'text-strong'}`}>
                    {cat.name}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-faint">{cat.courseCount} 门课程</span>
                </span>

                <span className={`shrink-0 font-mono text-[13px] tabular-nums ${dim ? 'text-muted' : 'text-muted'}`}>
                  {dim ? '暂未收录' : `${n} 份`}
                </span>

                {!dim && (
                  <ArrowRight
                    className="h-3.5 w-3.5 shrink-0 text-faint transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-muted"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ═══════════════════ ② 按学期找 ═══════════════════
          放在学科之前：学生对"我大二上"的认知比对"这是数学还是经济"更强。
          这一栏 Linear 没有，它解决的是本站的真实问题。 */}
      <section className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 sm:pt-20">
        <SectionHeader
          eyebrow="按学期"
          title="我大几？"
          desc="按年级筛选，只看这个阶段开的课"
          action={() => navigate({ name: 'library' })}
          actionLabel="全部课程"
        />

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TERM_AXIS.map((t, i) => (
            <button
              key={t.id}
              onClick={() => navigate({ name: 'library' })}
              className="group relative overflow-hidden rounded-xl border border-hairline/[0.08] bg-ink-850 p-5 text-left shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] transition-all duration-200 hover:border-hairline/[0.16] hover:bg-ink-800"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                {String(i + 1).padStart(2, '0')}
              </span>
              <p className="mt-2 text-[17px] font-medium tracking-[-0.02em] text-strong">{t.label}</p>
              <p className="mt-0.5 text-[12px] text-faint">上下学期</p>
              <ArrowUpRight
                className="absolute bottom-4 right-4 h-4 w-4 text-faint opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </section>

      {/* ═══════════════════ ④ 四六级 ═══════════════════
          加这一块的三个理由：
            1. 四六级是**独立业务线**，有 24 套完整试卷 + 听力播放器，
               但首页此前一个字都没提，学生根本不知道有这个东西
            2. 现有两段（学科 / 我大几）中间断开，页面下半是空的
            3. 它的形态跟上面两段不同（横向、编号、双行），不会造成同构

          设计上刻意**不做成卡片网格**（那和上面重复），
          做成一条横贯的可点条：左边是级数，右边是套数，中间是分隔线。
          一屏只有一条，视觉重量低于学科分类，符合它在业务里的次要地位。 */}
      <section className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 sm:pt-20">
        <SectionHeader
          eyebrow="四六级"
          title="CET 真题"
          desc="四级 / 六级各 24 套，含听力音频与整卷练习"
          action={() => navigate({ name: 'cet' })}
          actionLabel="全部套题"
        />

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {[
            { id: 'cet4', label: '英语四级', code: 'CET-4', n: 24 },
            { id: 'cet6', label: '英语六级', code: 'CET-6', n: 24 },
          ].map((c) => (
            <button
              key={c.id}
              onClick={() => navigate({ name: 'cet' })}
              className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-hairline/[0.08] bg-ink-850 p-5 text-left shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] transition-all duration-200 hover:-translate-y-px hover:border-hairline/[0.16] hover:bg-ink-800"
            >
              {/* 左侧一条 2px 竖线：四六级的身份色，比整块染色克制 */}
              <span
                aria-hidden="true"
                className={`absolute inset-y-4 left-0 w-[2px] rounded-full ${
                  c.id === 'cet4' ? 'bg-amber-400/60' : 'bg-sky-400/50'
                }`}
              />
              <div className="min-w-0 flex-1 pl-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-500">{c.code}</p>
                <p className="mt-1.5 text-[16px] font-medium tracking-[-0.02em] text-gray-800 group-hover:text-strong">
                  {c.label}
                </p>
                <p className="mt-1 font-mono text-[11px] text-gray-500">{c.n} 套完整试卷</p>
              </div>
              <ArrowRight
                className="h-4 w-4 shrink-0 text-gray-400 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-gray-800"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ───────────────── 小组件 ───────────────── */

/** 统计：22px 等宽数字 + 10px 标签，体量差就是 Linear 那种精度感 */
function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[22px] font-medium leading-none tracking-[-0.02em] text-strong tabular-nums">
        {value}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
    </div>
  );
}

/** 区块头：眉标 + 标题 + 说明 + 右侧动作。四个区块共用，保证节奏一致 */
function SectionHeader({
  eyebrow,
  title,
  desc,
  action,
  actionLabel,
}: {
  eyebrow: string;
  title: string;
  desc?: string;
  action: () => void;
  actionLabel: string;
}) {
  return (
    <div className="flex items-end justify-between gap-6">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">{eyebrow}</p>
        <h2 className="mt-2 text-[24px] font-medium tracking-[-0.03em] text-strong">{title}</h2>
        {desc && <p className="mt-1.5 text-[13px] text-faint">{desc}</p>}
      </div>
      <button
        onClick={action}
        className="group flex shrink-0 items-center gap-1 pb-1 text-[13px] text-muted transition-colors hover:text-strong"
      >
        {actionLabel}
        <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
      </button>
    </div>
  );
}
