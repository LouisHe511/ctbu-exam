import type { ExamPaper } from '@/types';

/**
 * 从**当前实际展示的试卷列表**实时统计数量。
 *
 * 为什么需要这个模块：
 * `src/data/categories.ts` 和 `courses.ts` 里的 paperCount / hasAnswerCount
 * 是模块加载时按**静态演示数组**算好写死的，并不反映数据库里的真实数据。
 * 直接渲染它们会让页面显示"思想政治 30 套真题"这类不存在的数字，
 * 同时在有真实数据时仍挂着"当前为演示数据"的说明 —— 都是误导。
 *
 * 所以所有对外显示的数量都必须经由这里的函数、基于真实 papers 计算。
 */

export interface CourseCount {
  total: number;
  withAnswer: number;
}

const EMPTY: CourseCount = { total: 0, withAnswer: 0 };

export function countByCourse(papers: ExamPaper[]): Map<string, CourseCount> {
  const map = new Map<string, CourseCount>();
  for (const p of papers) {
    const cur = map.get(p.courseId) ?? { total: 0, withAnswer: 0 };
    cur.total += 1;
    if (p.hasAnswer) cur.withAnswer += 1;
    map.set(p.courseId, cur);
  }
  return map;
}

export function countByCategory(papers: ExamPaper[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of papers) {
    map.set(p.category, (map.get(p.category) ?? 0) + 1);
  }
  return map;
}

export function courseCount(
  counts: Map<string, CourseCount>,
  courseId: string,
): CourseCount {
  return counts.get(courseId) ?? EMPTY;
}

export function categoryCount(
  counts: Map<string, number>,
  categoryId: string,
): number {
  return counts.get(categoryId) ?? 0;
}
