import { courses } from '@/data';
import type { Course, ExamPaper } from '@/types';

/**
 * 课程别名表 —— 学生嘴里的简称，和教务系统的正式课名不是一回事。
 *
 * 为什么要单独一张表（而不是在课名上做模糊匹配）：
 *   1) 「毛概」和「毛泽东思想和中国特色社会主义理论体系概论」**没有任何公共子串**，
 *      编辑距离也差得远，任何通用模糊算法都连不上；
 *   2) 「高数」「线代」「概统」同理，是缩略语，只能靠人写的对照表；
 *   3) 反过来「数学」这类词又太宽，必须靠表控制命中范围，不能让它乱穿。
 *
 * 维护规则：key 必须是 data/courses.ts 里真实存在的 id（找不到会直接跳过，不报错）。
 * 加新课程时**同时**在这里补简称，否则学生搜简称会搜不到——这是最容易漏的一步。
 */
const ALIAS_BY_COURSE: Record<string, string[]> = {
  // 2026-10-19 高数拆成 AⅠ / AⅡ 两门课：高数一 → c001，高数二 → c028。
  // 「高数」「高等数学A」两个通称两边都挂，搜通称时两门课都出现，不会漏掉半门。
  c001: ['高数', '高数一', '高数上', '高数A', '高数AI', '高数A1', '高等数学A', '高等数学A1'],
  c028: ['高数', '高数二', '高数下', '高数A', '高数AII', '高数A2', '高等数学A', '高等数学A2'],
  c002: ['线代', '线性'],
  c003: ['概率', '概率论', '概统', '概率统计', '数理统计'],
  c007: ['毛概', '毛中特', '毛特', '毛泽东思想', '毛泽东思想概论', '概论'],
  c004: ['物理', '大学物理', '大物'],
  c009: ['近现代史', '近代史', '现代史', '史纲'],
  c011: ['微积分', '微积分1', '微积分I', '微积', '微积分一'],
  // 2026-10-19 补：c012「微积分Ⅱ」此前没有任何别名，搜「微积分」只会命中Ⅰ，Ⅱ被漏掉。
  c012: ['微积分', '微积分2', '微积分II', '微积', '微积分二'],
  c017: ['统计', '统计学原理'],
  c020: ['会计', '财务会计', '会计学基础'],
  c021: ['管理', '管理学原理'],
  c022: ['计量', '计量经济', '计量经济学'],
  c023: ['宏观', '宏观经济', '宏观经济学'],
  c024: ['审计', '审计学原理'],
  c025: ['保险', '保险学原理', '保学'],
  c026: ['习概', '习思想', '习中特', '新时代概论', '习新时代中国特色社会主义思想概论'],
  c027: ['微观', '微观经济', '微经', '微观经济学原理'],
  // 2026-10-19 新增 c029 投资学：搜「投资」「证券投资」「投学」都要能命中。
  c033: ['证券投资', '证券', '投资分析', '证投'],
  c029: ['投资', '投资学', '投资分析', '证券投资', '证投', '投资学原理'],
  // 2026-10-19 新增 c030 / c031 政治经济学 I / II。
  // ⚠️ 「政经」这个通称两门课都挂 —— 搜通称时两门都出现，不会漏掉半门（同高数 AⅠ/AⅡ 的做法）。
  c030: ['政经', '政经一', '政经1', '政经I', '政治经济学', '政治经济学1', '政治经济学Ⅰ', '政治经济学一', '马经'],
  c031: ['政经', '政经二', '政经2', '政经II', '政治经济学', '政治经济学2', '政治经济学Ⅱ', '政治经济学二'],
  // 2026-10-19 新增 c032 财政学。
  c032: ['财政', '财政学', '财学', '财政税收', '公共财政'],
};

interface AliasEntry {
  /** 小写后的简称 */
  alias: string;
  courseId: string;
  /** 该课程的正式课名（用于提示「已关联到…」） */
  canonical: string;
}

/** 建一次索引，页面里反复用；不随渲染重建 */
const ALIAS_INDEX: AliasEntry[] = Object.entries(ALIAS_BY_COURSE).flatMap(([courseId, list]) => {
  const c = courses.find((x) => x.id === courseId);
  if (!c) return []; // id 写错时静默跳过，不让一个笔误白屏整站
  return list.map((a) => ({ alias: a.toLowerCase(), courseId, canonical: c.name }));
});

/** 与课程无关的通用同义词（考试类型这类） */
const GENERIC_SYNONYMS: Record<string, string[]> = {
  半期: ['期中'],
  期中: ['半期'],
};

export interface QueryExpansion {
  /** 原始查询（trim + 小写） */
  raw: string;
  /** 参与匹配的全部词：原词 + 命中的简称 + 命中课程的正式名 */
  terms: string[];
  /** 命中的课程 id —— 比字符串匹配更准，课名改了也不会漏 */
  courseIds: Set<string>;
  /** 命中的正式课名，用来给用户一个「已关联到…」的提示 */
  matchedCourseNames: string[];
}

const EMPTY: QueryExpansion = { raw: '', terms: [], courseIds: new Set(), matchedCourseNames: [] };

/**
 * 把用户输入展开成一组可匹配的词。
 *
 * 双向包含（alias ⊂ query 或 query ⊂ alias）是刻意为之：
 *   - 「毛概」：query ⊂ alias 不可能，靠 alias.includes 命中；
 *   - 「毛」：query ⊂ alias，命中「毛概/毛中特」——单字也给出结果，不至于空手；
 *   - 「高等数学」：query ⊃ alias「高数」？不成立，但 formal 名会兜底。
 */
export function expandQuery(q: string): QueryExpansion {
  const raw = q.trim().toLowerCase();
  if (!raw) return EMPTY;

  const terms = new Set<string>([raw]);
  const courseIds = new Set<string>();
  const names = new Set<string>();

  for (const s of GENERIC_SYNONYMS[raw] ?? []) terms.add(s);

  // 2026-10-19：先做「精确简称」匹配，命中就到此为止。
  // 否则「高数二」会通过 raw.includes('高数') 把「高数一」一起带进来 —— 高数拆成两门课后这个歧义必须收掉。
  const exactHits = ALIAS_INDEX.filter((item) => item.alias === raw);
  const candidates = exactHits.length
    ? exactHits
    : ALIAS_INDEX.filter((item) => item.alias.includes(raw) || raw.includes(item.alias));

  for (const item of candidates) {
    courseIds.add(item.courseId);
    names.add(item.canonical);
    terms.add(item.alias);
    terms.add(item.canonical.toLowerCase());
    // 命中一门课后，把它所有简称也带上：搜「毛中特」也能把只写了「毛概」的关联起来
    for (const t of ALIAS_BY_COURSE[item.courseId] ?? []) terms.add(t.toLowerCase());
  }

  return { raw, terms: Array.from(terms), courseIds, matchedCourseNames: Array.from(names) };
}

const hit = (text: string | null | undefined, terms: string[]) => {
  if (!text) return false;
  const s = text.toLowerCase();
  return terms.some((t) => s.includes(t));
};

/** 一份试卷是否命中查询（课名 / 课程 id / 考试类型 / 学期 / 标签 / 年份） */
export function paperMatches(paper: ExamPaper, exp: QueryExpansion): boolean {
  if (!exp.raw) return true;
  return (
    exp.courseIds.has(paper.courseId) ||
    hit(paper.courseName, exp.terms) ||
    hit(paper.examType, exp.terms) ||
    hit(paper.semester, exp.terms) ||
    paper.tags.some((t) => hit(t, exp.terms)) ||
    (paper.year !== null && String(paper.year).includes(exp.raw))
  );
}

/** 课程卡片是否命中查询（课名 / 课程代号 / 别名命中的 id） */
export function courseMatches(course: Course, exp: QueryExpansion): boolean {
  if (!exp.raw) return true;
  return (
    exp.courseIds.has(course.id) ||
    hit(course.name, exp.terms) ||
    hit(course.code, exp.terms) ||
    hit(course.baseName, exp.terms)
  );
}

/**
 * 给用户的提示文案：只有「用户输入的不是正式课名」时才提示，
 * 搜「高等数学」本身不需要告诉他"已关联到高等数学"。
 */
export function expansionHint(exp: QueryExpansion): string | null {
  const names = exp.matchedCourseNames.filter((n) => n.toLowerCase() !== exp.raw);
  if (!names.length) return null;
  return `已按「${names.join('」「')}」搜索`;
}
