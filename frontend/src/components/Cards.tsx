import { useMemo } from 'react';
import { useApp } from '@/context/AppContext';
import { usePapers } from '@/context/PapersContext';
import { confirmDialog } from '@/lib/dialog';
import { countByCourse, courseCount, type CourseCount } from '@/lib/counts';
import { courses } from '@/data';
import { Bookmark } from 'lucide-react';
import type { Course, ExamPaper } from '@/types';

/**
 * 卡片 —— 2026-10-20 重做（用户：「ai感太重了」）
 *
 * 原来一张试卷卡上最多挂 **5 个彩色药丸标签**（真题 / 来源学校 / 含答案 / 含解析 / 最新），
 * 每个都是「圆角 + 淡底 + 彩色字」。这是 design-system 点名的典型症状：
 *   标签一多就等于没有标签 —— 五个都跳出来，眼睛一个也不记住。
 *
 * 改法（不是换个颜色，是换信息组织方式）：
 *   ① 药丸只保留 **1 个**：`真题 / 模拟 / 习题`（用户明确要求保留这个区分）。
 *   ② 其余全部降为一行**文字元信息**，用 `·` 分隔，数字走等宽字体对齐。
 *   ③ 圆角全站统一 `rounded-lg`，卡片不再有 hover 上浮 + 阴影（动效只留给主动作）。
 *   ④ 层次靠字号与字重：标题 15px/中黑 → 元信息 12px/灰 → 计数等宽。
 */

/** 元信息一行：课程名 · 年份 · 学期 · 页数 · 答案。数字统一等宽 */
function MetaLine({ paper }: { paper: ExamPaper }) {
  const parts: string[] = [];
  if (paper.title && paper.courseName) parts.push(paper.courseName);
  if (paper.year) parts.push(`${paper.year} 年`);
  if (paper.semester) parts.push(paper.semester);
  if (paper.resourceType !== 'study_guide' && paper.examType) parts.push(paper.examType);
  parts.push(`${paper.pages} 页`);
  if (paper.hasAnswer) parts.push('含答案');
  if (paper.hasSolution) parts.push('含解析');

  return (
    <p className="mt-1.5 truncate font-mono text-[11px] leading-none text-gray-500">
      {parts.join('  ·  ') || (paper.resourceType === 'study_guide' ? '复习资料' : '')}
    </p>
  );
}

export function CourseCard({ course, counts: countsProp }: {
  course: Course;
  /**
   * 可选的页面级统计（2026-10-28）。
   * 原来每张卡各算一次 `countByCourse(papers)` —— 35 张卡 × 121 份 = 每次渲染
   * 4000+ 次 map 写入，而调用方（LibraryPage）**已经**算好了整页的 counts。
   * 传进来就复用；不传（如课程详情页单独用）再自己算。
   */
  counts?: Map<string, CourseCount>;
}) {
  const { navigate } = useApp();
  // 数量必须来自当前真实数据，不能用 data/courses.ts 里写死的演示值
  const { papers, loginOnlyByCourse } = usePapers();
  const fallback = useMemo(
    () => (countsProp ? countsProp : countByCourse(papers)),
    [countsProp, papers],
  );
  const c = courseCount(fallback, course.id);
  // 匿名时：这门课还有多少套是登录后才看得到的（否则卡片上写「0 套」会让人以为没收录）
  const hidden = loginOnlyByCourse[course.id] ?? 0;
  // 真的 0 套（匿名、登录都没卷）→ 显示「待收录」，别写「0 套 0 含答案」让人以为是坏了
  const total = c.total + hidden;
  const empty = total === 0;

  return (
    <button
      onClick={() => navigate({ name: 'course', courseId: course.id })}
      disabled={empty}
      className={`group w-full rounded-xl border px-4 py-4 text-left transition-all duration-200 ${
        empty
          ? 'cursor-default border-hairline/[0.05] bg-ink-900'
          : 'border-hairline/[0.07] bg-ink-850 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)] hover:-translate-y-px hover:border-hairline/[0.16] hover:bg-ink-800'
      }`}
    >
      {/* 首行：课程名（衬线，做层级）+ 课程代码（等宽，右对齐） */}
      <div className="flex items-baseline justify-between gap-3">
        <h3
          className={`text-[15px] font-medium leading-snug tracking-[-0.015em] ${
            empty ? 'text-gray-500' : 'text-gray-800 group-hover:text-strong'
          } transition-colors`}
        >
          {course.name}
        </h3>
        <span className="shrink-0 font-mono text-xs text-gray-400">{course.code}</span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-gray-500">
        {course.description}
      </p>

      {/* 底行：数字等宽、靠右，不再做成三个药丸 */}
      <div className="mt-3 flex items-baseline justify-between border-t border-hairline/[0.06] pt-2.5 font-mono text-[11px] tabular-nums">
        {empty ? (
          <span className="text-gray-400">暂未收录</span>
        ) : (
          <>
            <span className="text-gray-700">{total} 套</span>
            <span className="text-gray-500">{c.withAnswer} 含答案</span>
            {hidden > 0 && <span className="text-amber-400/80">登录可见</span>}
          </>
        )}
      </div>
    </button>
  );
}

export function PaperCard({ paper }: { paper: ExamPaper }) {
  const { navigate, isFavorite, toggleFavorite, addRecentView } = useApp();
  const fav = isFavorite(paper.id);

  const handleClick = () => {
    addRecentView(paper.id);
    navigate({ name: 'reader', paperId: paper.id });
  };

  const handleFavClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await toggleFavorite(paper.id);
    if (result === 'needs-login') {
      if (
        await confirmDialog('登录后才能收藏真题，收藏会保存到你的账号里。现在去登录吗？', {
          confirmLabel: '去登录',
        })
      ) {
        navigate({ name: 'login' });
      }
      return;
    }
    // 失败已经回滚过界面，这里只补一句人话，避免"点了没反应"（2026-10-28）
    if (result === 'error') {
      void confirmDialog('收藏没有保存成功，可能是网络问题。要重试一次吗？', {
        confirmLabel: '重试',
      }).then((again) => { if (again) void toggleFavorite(paper.id); });
    }
  };

  return (
    <div
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className="group h-full cursor-pointer rounded-xl border border-hairline/[0.07] bg-ink-850 px-4 py-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)] transition-all duration-200 hover:-translate-y-px hover:border-hairline/[0.16] hover:bg-ink-800 hover:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.09),0_4px_16px_-4px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            {/* 唯一的药丸：真题 / 模拟 / 习题（用户 2026-10-20 明确要求保留这个区分） */}
            {paper.paperKind && (
              <span
                className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] ${
                  paper.paperKind === '真题' ? 'text-amber-400/90' : 'text-gray-500'
                }`}
              >
                {paper.paperKind}
              </span>
            )}
            <h4 className="flex-1 min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] text-gray-800 transition-colors group-hover:text-strong">
              {paper.title ?? paper.courseName}
            </h4>
          </div>

          <MetaLine paper={paper} />

          {paper.tags.includes('最新') && (
            <p className="mt-1.5 font-mono text-xs text-accent">最新</p>
          )}
        </div>

        <button
          onClick={handleFavClick}
          aria-label={fav ? '取消收藏' : '收藏这份资料'}
          className="-m-1 shrink-0 rounded-md p-2 transition-colors hover:bg-solid-hover/[0.07]"
        >
          <Bookmark
            className={`h-4 w-4 transition-colors ${fav ? 'fill-amber-400 text-amber-400' : 'text-gray-400 hover:text-gray-700'}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

export function getCourseById(id: string): Course | undefined {
  return courses.find((c) => c.id === id);
}

/** 按 id 取试卷（从数据库加载的真实试卷优先，没有则退回演示数据） */
export function usePaperById(id: string): ExamPaper | undefined {
  const { getPaperById } = usePapers();
  return getPaperById(id);
}
