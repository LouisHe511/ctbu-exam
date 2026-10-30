import type { Term } from '@/types';

/**
 * 学期模型 —— 这是整个真题库的主轴。
 *
 * 为什么必须有它：学生找卷子的真实路径不是「数学基础 → 高等数学」，
 * 而是「我是大一的，要这学期期末的卷子」。
 *
 * 更关键的是：**同名课程在不同学期/不同专业是不同的课**。
 * 实测证据（来自学校网络教学平台的真实课名）：
 *   - 「形势与政策V」          → 罗马数字 V 表示第 5 学期（大三上）
 *   - 「毛泽东思想和中国特色社会主义理论体系概论Ⅰ」 → Ⅰ 表示上学期
 *   - 「机械设计基础AII」      → A 是班型，II 是学期
 *   - 「大学英语(中外)II」     → 「中外」是班型（中外合作班）
 *   - 「商务英语写作Ⅰ」/「法语泛读II」/「高级英语I」
 * 所以光有课名不够，必须「课名 + 班型 + 学期」三者才能唯一确定一门课。
 *
 * 注意：下面的 grade/order 是通用学制（4 年 8 学期），
 * 而每门课落在哪个学期属于「培养方案」，各专业略有差异 ——
 * 课程数据里 termId 为空即表示「尚未确认」，界面会明确标注，不瞎猜。
 */
export const terms: Term[] = [
  { id: 'y1s1', name: '大一上', grade: '大一', semester: '上', order: 1 },
  { id: 'y1s2', name: '大一下', grade: '大一', semester: '下', order: 2 },
  { id: 'y2s1', name: '大二上', grade: '大二', semester: '上', order: 3 },
  { id: 'y2s2', name: '大二下', grade: '大二', semester: '下', order: 4 },
  { id: 'y3s1', name: '大三上', grade: '大三', semester: '上', order: 5 },
  { id: 'y3s2', name: '大三下', grade: '大三', semester: '下', order: 6 },
  { id: 'y4s1', name: '大四上', grade: '大四', semester: '上', order: 7 },
  { id: 'y4s2', name: '大四下', grade: '大四', semester: '下', order: 8 },
];

/** 四个年级（导航用），顺序固定 */
export const grades = ['大一', '大二', '大三', '大四'] as const;

export type Grade = (typeof grades)[number];

export const termsByGrade = (grade: Grade): Term[] =>
  terms.filter((t) => t.grade === grade);

export const getTerm = (id?: string): Term | undefined =>
  id ? terms.find((t) => t.id === id) : undefined;

export const getTermName = (id?: string): string =>
  getTerm(id)?.name ?? '学期待确认';

/** 罗马数字 → 学期序号（用于从课名推断学期） */
const ROMAN: Record<string, number> = {
  'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8,
  'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8,
  'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8,
};

/**
 * 从课名里提取班型/版本后缀，并尝试推断学期。
 *
 * 返回：
 *   base  —— 去掉后缀的课程本体名（用于归并同一门课的不同班型）
 *   parts —— 识别出的后缀片段
 *   term  —— 若后缀能唯一表示学期则给出 termId，否则 null
 *
 * 例：
 *   「毛泽东思想和中国特色社会主义理论体系概论Ⅰ」
 *        → base=「毛泽东思想和中国特色社会主义理论体系概论」 term=y1s1
 *   「机械设计基础AII」   → base=「机械设计基础」 variant=A term=?（II 单独不足以定位）
 *   「大学英语(中外)II」   → base=「大学英语」 variant=中外
 *   「形势与政策V」        → base=「形势与政策」 term=y3s1
 */
export function parseCourseName(raw: string): {
  base: string;
  variant?: string;
  termId?: string;
  parts: string[];
} {
  const parts: string[] = [];
  let s = raw.trim();

  // 1) 圆括号班型：大学英语(中外) / 专业英语(文新) / 形势与政策Ⅴ(IBS)
  const parens = [...s.matchAll(/[（(]([^）)]+)[）)]/g)].map((m) => m[1].trim());
  for (const p of parens) parts.push(p);
  s = s.replace(/[（(][^）)]+[）)]/g, '').trim();

  // 2) 结尾的拉丁字母班型：机械设计基础AII / 国际经济法A / 统计学B
  //    小心不要吃掉罗马数字（I/V/X 也可能是罗马数字），所以只认 A/B/C 开头且后面跟罗马数字或结束
  const tailClass = s.match(/([ABC])(?=(?:[IVX]+)?$)/);
  if (tailClass) {
    parts.push(tailClass[1]);
  }

  // 3) 学期罗马数字：出现在结尾（可能跟在班型字母后）
  const romanTail = s.match(/([IVXivx]+)$/);
  const romanPrefix = s.match(/([IVX]+)/);
  let termNo: number | null = null;

  const romanToken = romanTail?.[1] ?? romanPrefix?.[1];
  if (romanToken && ROMAN[romanToken] !== undefined) {
    termNo = ROMAN[romanToken];
    parts.push(romanToken);
  }

  // 4) 归一化 base：去掉班型字母与罗马数字后缀
  let base = s
    .replace(/[IVXivx]+$/, '')
    .replace(/[ABC](?=[IVX]*$)/, '')
    .trim();

  if (base.length < 2) base = s;

  return {
    base,
    variant: parts.length ? parts.join('·') : undefined,
    // 学期序号 1-8 直接映射到 y{N}s{1|2}（第奇数学期=上，偶数=下）
    termId: termNo ? `y${Math.ceil(termNo / 2)}s${termNo % 2 === 1 ? 1 : 2}` : undefined,
    parts,
  };
}
