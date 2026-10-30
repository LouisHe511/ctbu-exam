import type { Category } from '@/types';
import { courses } from './courses';
import { papers } from './papers';

export const categories: Category[] = [
  // 2026-10-19 用户定：「大学英语」整栏永久移除（四六级有独立版块，不需要公共英语课），
  // 所以这里不再有 language / 大学外语 分类。要恢复从 git 历史里找回 c004/c013/c014/c015。
  { id: 'math',     name: '数学基础',   icon: 'Calculator', color: 'from-slate-700 to-slate-900',    courseCount: 0, paperCount: 0 },
  { id: 'politics', name: '思想政治',   icon: 'Landmark',   color: 'from-slate-700 to-slate-900',       courseCount: 0, paperCount: 0 },
  { id: 'computer', name: '计算机基础', icon: 'Cpu',        color: 'from-slate-700 to-slate-900',       courseCount: 0, paperCount: 0 },
  { id: 'econ',     name: '经济管理',   icon: 'TrendingUp', color: 'from-slate-700 to-slate-900',       courseCount: 0, paperCount: 0 },
];

for (const cat of categories) {
  cat.courseCount = courses.filter((c) => c.category === cat.id).length;
  cat.paperCount = papers.filter((p) => p.category === cat.id).length;
}

for (const course of courses) {
  const coursePapers = papers.filter((p) => p.courseId === course.id);
  course.paperCount = coursePapers.length;
  course.hasAnswerCount = coursePapers.filter((p) => p.hasAnswer).length;
}
