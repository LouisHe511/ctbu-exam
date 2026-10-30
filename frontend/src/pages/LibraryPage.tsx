import { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '@/context/AppContext';
import { categories } from '@/data/categories';
import { courses } from '@/data';
import { terms } from '@/data/terms';
import { LoginGate } from '@/components/LoginGate';
import { GradeNav } from '@/components/GradeNav';
import { countByCourse, courseCount } from '@/lib/counts';
import { expandQuery, paperMatches, courseMatches, expansionHint } from '@/lib/search';
import { readLibraryState, patchLibraryState, resetLibraryState, type LibrarySort } from '@/lib/listState';

/** courseId → termId。试卷记录本身不带开课学期，按年级筛试卷时经它所属课程查 */
const courseTermMap = new Map(courses.map((c) => [c.id, c.termId]));
import { usePapers } from '@/context/PapersContext';
import { PaperCard, CourseCard } from '@/components/Cards';
import { Search, SlidersHorizontal, X, FileText, LayoutGrid, ChevronDown, Info, CheckCircle2, BookOpen } from 'lucide-react';
import type { ExamPaper } from '@/types';
import { ContributeModal } from '@/components/ContributeModal';
import { Upload } from 'lucide-react';

type SortOption = LibrarySort;

export function LibraryPage() {
  const { searchQuery, setSearchQuery, page, navigate } = useApp();
  const { papers } = usePapers();
  const initialCategory = page.name === 'library' ? page.category : undefined;
  // 2026-10-20：右上角「我要投稿」
  const [contributeOpen, setContributeOpen] = useState(false);

  // 上次离开时的界面状态（进阅读器再返回、浏览器后退，都靠它回到原样）
  const saved = useRef(readLibraryState()).current;
  /**
   * 从首页搜索框跳进来（searchQuery 与上次不同）→ 视为「全新一次检索」，
   * 清掉上次遗留的年份/学期等筛选，否则用户搜「毛概」却因为旧筛选是 2020 年而看到空列表。
   */
  const arrivingSearch = useRef(!!searchQuery && searchQuery !== saved.search).current;
  const keepYear = arrivingSearch ? 'all' : saved.year;
  const keepSemester = arrivingSearch ? 'all' : saved.semester;
  const keepExamType = arrivingSearch ? 'all' : saved.examType;
  const keepTerm = arrivingSearch ? 'all' : saved.term;
  const keepHasAnswer = arrivingSearch ? 'all' : saved.hasAnswer;
  const keepHasSolution = arrivingSearch ? 'all' : saved.hasSolution;
  const keepCategory = arrivingSearch ? undefined : saved.category;

  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(initialCategory ?? keepCategory);
  const [selectedYear, setSelectedYear] = useState<string>(keepYear);
  const [selectedSemester, setSelectedSemester] = useState<string>(keepSemester);
  const [selectedExamType, setSelectedExamType] = useState<string>(keepExamType);
  // 年级/学期 —— 与首页同一维度：同名课（高数一/高数二）只有落到学期上才分得开
  const [selectedTerm, setSelectedTerm] = useState<string>(keepTerm);
  const [selectedHasAnswer, setSelectedHasAnswer] = useState<string>(keepHasAnswer);
  const [selectedHasSolution, setSelectedHasSolution] = useState<string>(keepHasSolution);
  const [viewMode, setViewMode] = useState<'papers' | 'courses'>(saved.viewMode);
  const [sortBy, setSortBy] = useState<SortOption>(saved.sortBy);
  /** 课程视图：只看「已经拿到真题」的科目（用真实计数，不看 data 里写死的值） */
  const [onlyWithPapers, setOnlyWithPapers] = useState(arrivingSearch ? false : saved.onlyWithPapers);
  const [showFilters, setShowFilters] = useState(arrivingSearch ? false : saved.showFilters);
  const [showGrade, setShowGrade] = useState(false);
  const [localSearch, setLocalSearch] = useState(searchQuery || saved.search);

  // 只有地址栏明确带了分类时才覆盖既有筛选；
  // 从阅读器返回时 page.category 是空的，此时必须保留用户原来的筛选（否则等于清空）
  useEffect(() => {
    if (initialCategory) setSelectedCategory(initialCategory);
  }, [initialCategory]);

  // 任何一项变化都写回暂存，供「返回」时还原
  useEffect(() => {
    patchLibraryState({
      viewMode,
      category: selectedCategory,
      year: selectedYear,
      semester: selectedSemester,
      examType: selectedExamType,
      term: selectedTerm,
      hasAnswer: selectedHasAnswer,
      hasSolution: selectedHasSolution,
      sortBy,
      search: localSearch,
      onlyWithPapers,
      showFilters,
    });
  }, [viewMode, selectedCategory, selectedYear, selectedSemester, selectedExamType, selectedTerm,
      selectedHasAnswer, selectedHasSolution, sortBy, localSearch, onlyWithPapers, showFilters]);

  // 注意：滚动位置在 AppContext.navigate() 里记（离开前读），不能放在组件卸载时读 ——
  // 那时 navigate 已经把页面滚到顶部，读到的永远是 0。


  const years = useMemo(() => {
    // 年份为空的卷子不进"年份"筛选下拉，否则会多出一个 "null 年"（2026-10-16）
    const set = new Set(papers.map((p) => p.year).filter((y): y is number => y !== null));
    return Array.from(set).sort((a, b) => b - a);
  }, [papers]);

  const semesters = ['春季', '秋季', '夏季', '寒假补考'];
  const examTypes = ['期中', '期末', '补考', '重修', '其他'];

  // 查询展开：把「毛概」「高数」「线代」这类简称映射到正式课名（见 lib/search.ts）
  const queryText = localSearch || searchQuery;
  const exp = useMemo(() => expandQuery(queryText), [queryText]);
  const hint = useMemo(() => expansionHint(exp), [exp]);

  const filteredPapers = useMemo(() => {
    let result = [...papers];
    if (exp.raw) {
      result = result.filter((p) => paperMatches(p, exp));
    }
    if (selectedCategory && selectedCategory !== 'all') {
      result = result.filter((p) => p.category === selectedCategory);
    }
    // 年级/学期：试卷本身不带学期，要经它所属课程去查
    if (selectedTerm !== 'all') {
      result = result.filter((p) => courseTermMap.get(p.courseId) === selectedTerm);
    }
    if (selectedYear !== 'all') {
      result = result.filter((p) => p.year === Number(selectedYear));
    }
    if (selectedSemester !== 'all') {
      result = result.filter((p) => p.semester === selectedSemester);
    }
    if (selectedExamType !== 'all') {
      result = result.filter((p) => p.examType === selectedExamType);
    }
    if (selectedHasAnswer === 'yes') {
      result = result.filter((p) => p.hasAnswer);
    } else if (selectedHasAnswer === 'no') {
      result = result.filter((p) => !p.hasAnswer);
    }
    if (selectedHasSolution === 'yes') {
      result = result.filter((p) => p.hasSolution);
    } else if (selectedHasSolution === 'no') {
      result = result.filter((p) => !p.hasSolution);
    }

    if (sortBy === 'latest') {
      result.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    } else if (sortBy === 'views') {
      result.sort((a, b) => b.views - a.views);
    } else if (sortBy === 'year_desc') {
      // 年份为空的卷子排在最后（不能当 0 处理，否则会排到 2007 年之前）
      result.sort((a, b) => {
        if (a.year === null && b.year === null) return b.uploadedAt.localeCompare(a.uploadedAt);
        if (a.year === null) return 1;
        if (b.year === null) return -1;
        return b.year - a.year || b.uploadedAt.localeCompare(a.uploadedAt);
      });
    }

    return result;
  }, [papers, exp, selectedCategory, selectedYear, selectedSemester, selectedExamType, selectedHasAnswer, selectedHasSolution, selectedTerm, sortBy]);

  // 从阅读器返回时把滚动位置还原到离开前那一屏（只做一次，避免用户往下翻又被拽回去）
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (scrollRestored.current) return;
    if (!filteredPapers.length) return;
    scrollRestored.current = true;
    if (saved.scrollY > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: saved.scrollY, behavior: 'instant' }));
    }
  }, [filteredPapers.length, saved.scrollY]);

  // 课程的真实真题数量（与卡片显示的是同一份统计，避免两处对不上）
  const courseCounts = useMemo(() => countByCourse(papers), [papers]);

  const filteredCourses = useMemo(() => {
    let result = [...courses];
    if (selectedCategory && selectedCategory !== 'all') {
      result = result.filter((c) => c.category === selectedCategory);
    }
    if (selectedTerm !== 'all') {
      result = result.filter((c) => c.termId === selectedTerm);
    }
    if (exp.raw) {
      result = result.filter((c) => courseMatches(c, exp));
    }
    // **已有真题的科目排在前面** —— 学生进真题库就是想直接做题，
    // 让「0 套」的空壳课程占住首屏没有意义。稳定排序，组内保持原有热度序。
    result.sort((a, b) => {
      const pa = courseCount(courseCounts, a.id).total > 0;
      const pb = courseCount(courseCounts, b.id).total > 0;
      if (pa === pb) return 0;
      return pa ? -1 : 1;
    });
    if (onlyWithPapers) {
      result = result.filter((c) => courseCount(courseCounts, c.id).total > 0);
    }
    return result;
  }, [selectedCategory, selectedTerm, exp, courseCounts, onlyWithPapers]);

  const activeFilterCount =
    (selectedCategory && selectedCategory !== 'all' ? 1 : 0) +
    (selectedYear !== 'all' ? 1 : 0) +
    (selectedSemester !== 'all' ? 1 : 0) +
    (selectedExamType !== 'all' ? 1 : 0) +
    (selectedHasAnswer !== 'all' ? 1 : 0) +
    (selectedHasSolution !== 'all' ? 1 : 0);

  const clearAll = () => {
    setSelectedCategory('all');
    setSelectedTerm('all');
    setSelectedYear('all');
    setSelectedSemester('all');
    setSelectedExamType('all');
    setSelectedHasAnswer('all');
    setSelectedHasSolution('all');
    setLocalSearch('');
    setSearchQuery('');
    resetLibraryState();
  };

  const FilterChip = ({ label, value, options, onChange }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
  }) => (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-gray-500 font-medium shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              value === opt.value
                ? 'bg-solid text-on-solid'
                : 'bg-elevate/[0.04] text-gray-600 hover:bg-solid-hover/[0.07]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-page pb-20 pt-[73px] md:pb-0">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-16 pt-10">
        {/* ═══ 页头（2026-10-21 重排，对齐首页的排版语言）═══ */}
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-400">Browse</p>
            <h1 className="mt-1.5 text-[26px] font-medium tracking-[-0.03em] text-gray-900">真题库</h1>
            <p className="mt-1.5 text-[13px] text-gray-500">
              {papers.length > 0 ? `共 ${papers.length} 份可见资料 · 支持按课程、学期、年份筛选` : '加载中'}
            </p>
          </div>
          <button
            onClick={() => setContributeOpen(true)}
            className="shrink-0 rounded-lg border border-hairline/[0.12] bg-elevate/[0.04] px-3 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:border-hairline/[0.2] hover:bg-solid-hover/[0.07] hover:text-gray-900"
          >
            <span className="flex items-center gap-1.5">
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              投稿
            </span>
          </button>
        </div>

        {/* 未登录时告诉用户还有多少资料是登录可见的 */}
        <LoginGate className="mb-4" />

        {/* Search bar */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white" aria-hidden="true" />
            <input
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="搜索课程、考试类型、年份…（支持简称：毛概 / 高数 / 线代）"
              className="w-full rounded-xl border border-hairline/[0.10] bg-input py-3 pl-11 pr-4 text-[14px] text-strong placeholder-faint/40 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-3 text-[13px] font-medium transition-all duration-150 ${
              showFilters || activeFilterCount > 0
                ? 'bg-solid text-on-solid hover:bg-solid-hover'
                : 'border border-hairline/[0.12] bg-elevate/[0.04] text-gray-600 hover:border-hairline/[0.2] hover:text-gray-900'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">筛选</span>
            {activeFilterCount > 0 && (
              <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] ${
                showFilters || activeFilterCount > 0 ? 'bg-page text-strong' : 'bg-elevate/[0.06] text-gray-700'
              }`}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* 简称命中提示：让用户知道「毛概」被翻译成了哪门课，而不是默默给了结果 */}
        {hint && (
          <p className="text-xs text-gray-700 mb-3 -mt-1 flex items-center gap-1">
            <Info className="w-3.5 h-3.5" />
            {hint}
            <span className="text-gray-400">· 共 {viewMode === 'papers' ? filteredPapers.length : filteredCourses.length} 条</span>
          </p>
        )}

        {/* 视图切换：凹槽式 segment（Linear / Vercel 的常见控件） */}
        <div className="mb-4 flex items-center gap-3">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-hairline/[0.08] bg-ink-900 p-0.5">
            <button
              onClick={() => setViewMode('papers')}
              aria-pressed={viewMode === 'papers'}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-all duration-150 ${
                viewMode === 'papers'
                  ? 'bg-ink-750 text-gray-900 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.08)]'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              按试卷
            </button>
            <button
              onClick={() => setViewMode('courses')}
              aria-pressed={viewMode === 'courses'}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-all duration-150 ${
                viewMode === 'courses'
                  ? 'bg-ink-750 text-gray-900 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.08)]'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
              按课程
            </button>
          </div>

          {/* 课程视图专有：只看已有真题的科目 */}
          {viewMode === 'courses' && (
            <button
              onClick={() => setOnlyWithPapers((v) => !v)}
              aria-pressed={onlyWithPapers}
              className={`ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                onlyWithPapers ? 'bg-solid text-on-solid' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              只看已有真题
            </button>
          )}
        </div>

        {/* 按年级找 —— 从首页搬来。
            放在搜索和视图切换之后、默认收起：进真题库的人多数已经知道课名，
            搜索是主路径；「不知道这门课叫什么」时才展开按年级翻。 */}
        <div className="mb-4">
          <button
            onClick={() => setShowGrade((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
            aria-expanded={showGrade}
          >
            <BookOpen className="w-4 h-4" />
            不知道课程叫什么？按年级 / 学期找
            <ChevronDown className={`w-4 h-4 transition-transform ${showGrade ? 'rotate-180' : ''}`} />
          </button>
          {showGrade && (
            <div className="mt-5">
              <GradeNav hideHeader onOpenCourse={(c) => navigate({ name: 'course', courseId: c.id })} />
            </div>
          )}
        </div>

        {/* Filters panel */}
        {showFilters && (
          <div className="mb-4 space-y-4 rounded-xl border border-hairline/[0.08] bg-ink-850 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] animate-fade-in-down">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-gray-900">筛选条件</h3>
              <button
                onClick={clearAll}
                className="flex items-center gap-1 text-[12px] text-gray-500 transition-colors hover:text-gray-800"
              >
                <X className="w-3 h-3" />
                清除全部
              </button>
            </div>

            <FilterChip
              label="学科分类"
              value={selectedCategory || 'all'}
              onChange={setSelectedCategory}
              options={[
                { value: 'all', label: '全部' },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />

            <FilterChip
              label="年级学期"
              value={selectedTerm}
              onChange={setSelectedTerm}
              options={[
                { value: 'all', label: '全部' },
                ...terms.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />

            {viewMode === 'papers' && (
              <>
                <FilterChip
                  label="年份"
                  value={selectedYear}
                  onChange={setSelectedYear}
                  options={[
                    { value: 'all', label: '全部' },
                    ...years.map((y) => ({ value: String(y), label: `${y}年` })),
                  ]}
                />
                <FilterChip
                  label="学期"
                  value={selectedSemester}
                  onChange={setSelectedSemester}
                  options={[
                    { value: 'all', label: '全部' },
                    ...semesters.map((s) => ({ value: s, label: s })),
                  ]}
                />
                <FilterChip
                  label="考试类型"
                  value={selectedExamType}
                  onChange={setSelectedExamType}
                  options={[
                    { value: 'all', label: '全部' },
                    ...examTypes.map((t) => ({ value: t, label: t })),
                  ]}
                />
                <FilterChip
                  label="答案"
                  value={selectedHasAnswer}
                  onChange={setSelectedHasAnswer}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'yes', label: '含答案' },
                    { value: 'no', label: '无答案' },
                  ]}
                />
                <FilterChip
                  label="解析"
                  value={selectedHasSolution}
                  onChange={setSelectedHasSolution}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'yes', label: '含解析' },
                    { value: 'no', label: '无解析' },
                  ]}
                />
              </>
            )}
          </div>
        )}

        {/* Sort + count */}
        <div className="flex items-center justify-between mb-4">
          <p className="font-mono text-[12px] text-gray-500">
            <span className="text-gray-800 tabular-nums">{viewMode === 'papers' ? filteredPapers.length : filteredCourses.length}</span> 条结果
          </p>
          {viewMode === 'papers' && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">排序：</span>
              <div className="relative">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="appearance-none cursor-pointer rounded-lg border border-hairline/[0.10] bg-ink-850 py-1.5 pl-3 pr-8 text-[12px] text-gray-700 outline-none transition-colors hover:border-hairline/[0.18]"
                >
                  <option value="latest">最新上传</option>
                  <option value="year_desc">年份最新</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              </div>
            </div>
          )}
        </div>


        {/* Results */}
        {viewMode === 'papers' ? (
          filteredPapers.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 stagger">
              {filteredPapers.map((paper: ExamPaper, idx: number) => {
                return (
                  <div key={paper.id} style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}>
                    <PaperCard paper={paper} />
</div>
                );
              })}
            </div>
          ) : (
            <EmptyState onReset={clearAll} />
          )
        ) : filteredCourses.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {filteredCourses.map((course) => (
              <CourseCard key={course.id} course={course} counts={courseCounts} />
            ))}
          </div>
        ) : (
          <EmptyState onReset={clearAll} />
        )}
      </div>

      {/* 我要投稿弹窗（2026-10-20） */}
      {contributeOpen && <ContributeModal onClose={() => setContributeOpen(false)} />}
    </div>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-hairline/[0.08] bg-ink-850">
        <FileText className="w-8 h-8 text-gray-300" />
      </div>
      <p className="text-gray-500 text-sm mb-1">没有找到匹配的真题</p>
      <p className="text-gray-500 text-xs mb-4">试试调整筛选条件或搜索关键词</p>
      <button
        onClick={onReset}
        className="px-4 py-2 bg-solid text-on-solid rounded-lg text-sm font-medium hover:bg-solid-hover transition-colors"
      >
        清除筛选
      </button>
    </div>
  );
}
