import { useMemo, useState } from 'react';
import { courses } from '@/data/courses';
import { categories } from '@/data/categories';
import { grades, termsByGrade, type Grade } from '@/data/terms';
import { usePapers } from '@/context/PapersContext';
import { countByCourse, courseCount } from '@/lib/counts';
import type { Course } from '@/types';
import { ChevronRight, BookOpen, AlertCircle } from 'lucide-react';

/**
 * 按年级/学期浏览 —— 真题库的主入口。
 *
 * 为什么要做成主轴：学生找卷子的真实问法是「我是大一的，要这学期期末的卷子」，
 * 而不是「我要数学基础分类下的高等数学」。而「高数一 / 高数二」这类同名不同课，
 * 只有落到学期上才能分开。
 *
 * 诚实原则：termId 为空 = 尚未确认，单独收进「学期待确认」，
 * 不猜、不塞进某个学期充数。
 */
export function GradeNav({ onOpenCourse, hideHeader = false }: { onOpenCourse: (course: Course) => void; hideHeader?: boolean }) {
  const [active, setActive] = useState<Grade>('大一');
  // 数量必须按数据库真实试卷实时统计，不能用 courses.ts 里写死的演示值
  const { papers } = usePapers();
  const counts = useMemo(() => countByCourse(papers), [papers]);

  const byGrade = useMemo(() => {
    const map = {} as Record<Grade, { term: string; termId: string; list: Course[] }[]>;
    for (const g of grades) {
      map[g] = termsByGrade(g).map((t) => ({
        termId: t.id,
        term: t.semester === '上' ? '上学期' : '下学期',
        list: courses.filter((c) => c.termId === t.id),
      }));
    }
    return map;
  }, []);

  const unassigned = useMemo(() => courses.filter((c) => !c.termId && !c.spansTerms), []);
  const spanAll = useMemo(() => courses.filter((c) => c.spansTerms), []);
  const totalOf = (g: Grade) => byGrade[g].reduce((n, t) => n + t.list.length, 0);

  return (
    <section className="mb-6">
      {!hideHeader && (
        <div className="flex items-end justify-between mb-5">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900">按年级找</h2>
            <p className="text-sm text-gray-500 mt-1.5">
              同一门课在不同学期是不同的课（高数一和高数二考卷不一样），所以先选年级
            </p>
          </div>
        </div>
      )}

      {/* 年级切换 */}
      <div className="flex gap-2 mb-6">
        {grades.map((g) => {
          const on = g === active;
          return (
            <button
              key={g}
              onClick={() => setActive(g)}
              className={`px-5 py-2.5 rounded-full text-sm transition-colors border ${
                on
                  ? 'bg-solid text-on-solid border-solid'
                  : 'bg-ink-850 text-gray-900 border-hairline/[0.08] hover:border-hairline/[0.2]'
              }`}
            >
              {g}
              <span className={`ml-2 text-xs ${on ? 'text-white/60' : 'text-gray-500'}`}>
                {totalOf(g)}
              </span>
            </button>
          );
        })}
      </div>

      {/* 两个学期 */}
      <div className="grid md:grid-cols-2 gap-5">
        {byGrade[active].map((t) => (
          <div key={t.termId} className="bg-ink-850 rounded-xl border border-hairline/[0.08] p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-900">
                {active}·{t.term}
              </h3>
              <span className="text-xs text-gray-500">{t.list.length} 门课</span>
            </div>

            {t.list.length === 0 ? (
              <p className="text-sm text-gray-500 py-3">这门学期还没收录课程</p>
            ) : (
              <ul className="space-y-1">
                {t.list.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => onOpenCourse(c)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 -mx-3 rounded-lg hover:bg-solid-hover/[0.03] transition-colors text-left group"
                    >
                      <BookOpen className="w-4 h-4 text-gray-500 shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-gray-900 truncate">{c.name}</span>
                        <span className="block text-xs text-gray-500 mt-0.5">
                          {categories.find((x) => x.id === c.category)?.name}
                          {c.variant ? ` · ${c.variant}` : ''}
                          {courseCount(counts, c.id).total > 0
                            ? ` · ${courseCount(counts, c.id).total} 套`
                            : ' · 暂未收录'}
                        </span>
                      </span>
                      <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-500 shrink-0 transition-colors" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {/* 跨学期连开 */}
      {spanAll.length > 0 && (
        <div className="mt-5 bg-ink-850 rounded-xl border border-hairline/[0.08] p-5">
          <h3 className="text-sm font-medium text-gray-900 mb-3">跨学期连开</h3>
          <div className="flex flex-wrap gap-2">
            {spanAll.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenCourse(c)}
                className="px-3.5 py-1.5 rounded-full border border-hairline/[0.08] text-sm text-gray-900 hover:border-hairline/[0.2] transition-colors"
              >
                {c.name}
                <span className="ml-1.5 text-xs text-gray-500">8 学期</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 学期待确认 —— 诚实标注，不硬塞 */}
      {unassigned.length > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-hairline/[0.08] p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-medium text-gray-500">
              学期待确认（{unassigned.length} 门）
            </h3>
          </div>
          <p className="text-xs text-gray-500 mb-3 leading-relaxed">
            这些课的开课学期还没有可靠依据，所以没有归入任何年级。
            欢迎在校同学按培养方案告诉我们，再补上。
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenCourse(c)}
                className="px-3.5 py-1.5 rounded-full border border-hairline/[0.08] text-sm text-gray-500 hover:border-hairline/[0.2] hover:text-gray-900 transition-colors"
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
