import { useMemo, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { courses } from '@/data';
import { usePapers } from '@/context/PapersContext';
import { countByCourse, courseCount } from '@/lib/counts';
import { PaperCard, getCourseById } from '@/components/Cards';
import { BackBar } from '@/components/Layout';
import { FileText, Bookmark, Filter, ChevronDown } from 'lucide-react';

export function CourseDetailPage({ courseId }: { courseId: string }) {
  const { navigate } = useApp();
  const { papers, loginOnlyByCourse } = usePapers();
  // 数量从真实数据实时统计，不用 data/courses.ts 里写死的演示值
  const courseCounts = useMemo(() => countByCourse(papers), [papers]);
  const thisCount = courseCount(courseCounts, courseId);
  const course = getCourseById(courseId);
  // 未登录时：这门课还有多少套是「登录可见」的（服务端只给数量，不给内容）
  const hiddenCount = loginOnlyByCourse[courseId] ?? 0;

  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [selectedExamType, setSelectedExamType] = useState<string>('all');
  const [selectedHasAnswer, setSelectedHasAnswer] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  const coursePapers = useMemo(
    () => papers.filter((p) => p.courseId === courseId),
    [courseId, papers]
  );

  const years = useMemo(() => {
    // 年份为空的卷子不进"年份"筛选下拉（2026-10-16）
    const set = new Set(coursePapers.map((p) => p.year).filter((y): y is number => y !== null));
    return Array.from(set).sort((a, b) => b - a);
  }, [coursePapers]);

  const examTypes = useMemo(() => {
    const set = new Set(coursePapers.map((p) => p.examType));
    return Array.from(set);
  }, [coursePapers]);

  const filteredPapers = useMemo(() => {
    let result = [...coursePapers];
    if (selectedYear !== 'all') result = result.filter((p) => p.year === Number(selectedYear));
    if (selectedExamType !== 'all') result = result.filter((p) => p.examType === selectedExamType);
    if (selectedHasAnswer === 'yes') result = result.filter((p) => p.hasAnswer);
    else if (selectedHasAnswer === 'no') result = result.filter((p) => !p.hasAnswer);
    // 年份为空的卷子排在最后（2026-10-16）
    return result.sort((a, b) => {
      if (a.year === null && b.year === null) return b.uploadedAt.localeCompare(a.uploadedAt);
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return b.year - a.year || b.uploadedAt.localeCompare(a.uploadedAt);
    });
  }, [coursePapers, selectedYear, selectedExamType, selectedHasAnswer]);

  if (!course) {
    return (
      <div className="pt-[73px] flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-gray-500 mb-4">课程不存在</p>
          <button
            onClick={() => navigate({ name: 'library' })}
            className="px-4 py-2 bg-solid text-on-solid rounded-lg text-sm"
          >
            返回真题库
          </button>
        </div>
      </div>
    );
  }

  const activeFilterCount =
    (selectedYear !== 'all' ? 1 : 0) +
    (selectedExamType !== 'all' ? 1 : 0) +
    (selectedHasAnswer !== 'all' ? 1 : 0);

  const relatedCourses = courses
    .filter((c) => c.category === course.category && c.id !== course.id)
    .slice(0, 3);

  return (
    <div className="min-h-screen bg-page pb-20 pt-[73px] md:pb-0">
      <BackBar title={course.name} subtitle={`${course.code} · ${coursePapers.length + hiddenCount} 套真题`} />

      {/* ═══════ 课程头 ═══════
          2026-10-21 重做。原来是一整块 `bg-gradient-to-br` 的彩色渐变 + 白色图标方块，
          在深色站里非常跳（而且每个课程的 coverGradient 都是同一组 slate 渐变，
          等于所有课长得一样）。现在改成**纯深色 + 排版撑层级**：
          眉标（课程代码）→ 大标题 → 一句描述 → 一行等宽元信息。
          这是 Linear 项目页的做法，也和不依赖颜色的首页语言一致。 */}
      <div className="relative overflow-hidden border-b border-hairline/[0.06]">
        {/* 顶部一层极淡冷光，给头图一点纵深，不依赖课程色 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 left-1/4 h-[380px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(120,142,158,0.13),transparent_70%)] blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-10 pt-10 sm:px-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-400">
            Course · {course.code}
          </p>
          <h1 className="mt-2.5 max-w-[24ch] text-[30px] font-medium leading-[1.12] tracking-[-0.03em] text-gray-900 sm:text-[34px]">
            {course.name}
          </h1>
          <p className="mt-3 max-w-[54ch] text-[14px] leading-relaxed text-gray-500">
            {course.description}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-x-7 gap-y-2 font-mono text-[12px] text-gray-500">
            <span>
              <span className="text-gray-800 tabular-nums">{thisCount.total + hiddenCount}</span> 套真题
            </span>
            <span className="text-gray-500/40">·</span>
            <span>
              <span className="text-gray-800 tabular-nums">{thisCount.withAnswer}</span> 套含答案
            </span>
            {hiddenCount > 0 && (
              <>
                <span className="text-gray-500/40">·</span>
                <span className="text-amber-400/80">{hiddenCount} 套登录可见</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Filters */}
        <div className="mb-4 rounded-xl border border-hairline/[0.08] bg-ink-850 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-gray-900">
              <Filter className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
              筛选试卷
            </h3>
            {activeFilterCount > 0 && (
              <button
                onClick={() => {
                  setSelectedYear('all');
                  setSelectedExamType('all');
                  setSelectedHasAnswer('all');
                }}
                className="text-xs text-gray-500 hover:text-gray-600"
              >
                清除筛选
              </button>
            )}
          </div>

          {/* Quick filters - inline on desktop, collapsible on mobile */}
          <div className="hidden sm:flex flex-wrap items-center gap-4">
            {/* Year */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-gray-500">年份</span>
              <button
                onClick={() => setSelectedYear('all')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${selectedYear === 'all' ? 'bg-solid text-on-solid' : 'border border-hairline/[0.08] bg-elevate/[0.03] text-gray-500 hover:border-hairline/[0.16] hover:text-gray-800'}`}
              >
                全部
              </button>
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setSelectedYear(String(y))}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium ${selectedYear === String(y) ? 'bg-solid text-on-solid' : 'border border-hairline/[0.08] bg-elevate/[0.03] text-gray-500 hover:border-hairline/[0.16] hover:text-gray-800'}`}
                >
                  {y}年
                </button>
              ))}
            </div>
          </div>

          {/* Mobile filter toggle */}
          <div className="sm:hidden">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center justify-between w-full py-2 text-sm text-gray-600"
            >
              <span>筛选条件 {activeFilterCount > 0 && `(${activeFilterCount})`}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
            </button>
            {showFilters && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-gray-500 shrink-0">年份</span>
                  <button onClick={() => setSelectedYear('all')} className={`px-2 py-1 rounded-lg text-xs ${selectedYear === 'all' ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-500'}`}>全部</button>
                  {years.map((y) => (
                    <button key={y} onClick={() => setSelectedYear(String(y))} className={`px-2 py-1 rounded-lg text-xs ${selectedYear === String(y) ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-500'}`}>{y}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-gray-500 shrink-0">类型</span>
                  <button onClick={() => setSelectedExamType('all')} className={`px-2 py-1 rounded-lg text-xs ${selectedExamType === 'all' ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-500'}`}>全部</button>
                  {examTypes.map((t) => (
                    <button key={t} onClick={() => setSelectedExamType(t)} className={`px-2 py-1 rounded-lg text-xs ${selectedExamType === t ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-500'}`}>{t}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-gray-500 shrink-0">答案</span>
                  {[
                    { v: 'all', l: '全部' },
                    { v: 'yes', l: '含答案' },
                    { v: 'no', l: '无答案' },
                  ].map((o) => (
                    <button key={o.v} onClick={() => setSelectedHasAnswer(o.v)} className={`px-2 py-1 rounded-lg text-xs ${selectedHasAnswer === o.v ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-600'}`}>{o.l}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Desktop exam type + has answer */}
          <div className="hidden sm:flex flex-wrap items-center gap-4 mt-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-gray-500">类型</span>
              <button onClick={() => setSelectedExamType('all')} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${selectedExamType === 'all' ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-600 hover:bg-solid-hover/[0.07]'}`}>全部</button>
              {examTypes.map((t) => (
                <button key={t} onClick={() => setSelectedExamType(t)} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${selectedExamType === t ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-600 hover:bg-solid-hover/[0.07]'}`}>{t}</button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-gray-500">答案</span>
              {[
                { v: 'all', l: '全部' },
                { v: 'yes', l: '含答案' },
                { v: 'no', l: '无答案' },
              ].map((o) => (
                <button key={o.v} onClick={() => setSelectedHasAnswer(o.v)} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${selectedHasAnswer === o.v ? 'bg-solid text-on-solid' : 'bg-elevate/[0.04] text-gray-600 hover:bg-solid-hover/[0.07]'}`}>{o.l}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Paper list */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-gray-500">
            共 <span className="font-semibold text-gray-900">{filteredPapers.length}</span> 套试卷
          </p>
        </div>

        {filteredPapers.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 stagger">
            {filteredPapers.map((paper, idx) => (
              <div key={paper.id} style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}>
                <PaperCard paper={paper} />
              </div>
            ))}
          </div>
        ) : hiddenCount > 0 && coursePapers.length === 0 ? (
          /* 未登录**且**这门课确实有题（不是被筛选筛空了）—— 必须说清楚，
             否则学生只会看到「没有试卷」，以为真题丢了（2026-10-17 修）。
             ⚠️ 2026-10-28：加了 `papers.length === 0`。原来只要 hiddenCount>0 就报
             「有 N 套真题，登录后即可查看」，于是未登录用户把年份筛成 2020（该课那一年
             没有卷）也会看到这句 —— 他去登录，回来还是空的。筛选为空不等于权限不足。 */
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-elevate/[0.06] flex items-center justify-center mb-4">
              <FileText className="w-8 h-8 text-gray-700" />
            </div>
            <p className="text-gray-900 text-sm font-medium">
              这门课有 <span className="text-gray-700 font-bold">{hiddenCount}</span> 套真题，登录后即可查看
            </p>
            <p className="text-gray-500 text-xs mt-1.5">
              本站真题默认登录可见（防抓取），注册免费
            </p>
            <button
              onClick={() => navigate({ name: 'login' })}
              className="mt-4 px-5 py-2.5 bg-solid text-on-solid rounded-lg text-sm font-medium hover:bg-solid-hover transition-colors"
            >
              登录 / 注册
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-elevate/[0.04] flex items-center justify-center mb-4">
              <FileText className="w-8 h-8 text-gray-300" />
            </div>
            <p className="text-gray-500 text-sm">没有符合筛选条件的试卷</p>
          </div>
        )}

        {/* Related courses */}
        {relatedCourses.length > 0 && (
          <div className="mt-10">
            <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
              <Bookmark className="w-5 h-5 text-gray-700" />
              相关课程
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {relatedCourses.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate({ name: 'course', courseId: c.id })}
                  className="group rounded-xl border border-hairline/[0.08] bg-ink-850 p-4 text-left shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] transition-all duration-200 hover:-translate-y-px hover:border-hairline/[0.16] hover:bg-ink-800"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-hairline/[0.08] bg-elevate/[0.03]">
                    <FileText className="h-4 w-4 text-gray-500 transition-colors group-hover:text-gray-800" aria-hidden="true" />
                  </div>
                  <h4 className="truncate text-[14px] font-medium tracking-[-0.01em] text-gray-800 transition-colors group-hover:text-gray-900">{c.name}</h4>
                  <p className="mt-1 font-mono text-[11px] text-gray-500">{courseCount(courseCounts, c.id).total} 套真题</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
