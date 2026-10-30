import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePapers } from '@/context/PapersContext';
import { uploadPaper, deletePaper } from '@/lib/papers';
import { AlertCircle, CheckCircle, Loader2, LockKeyhole, Upload } from 'lucide-react';

/** 由管理员挑选 import-ready 目录里的本次授权资料；元数据预先和规范化文件名对应。 */
const IMPORT_MANIFEST: Record<string, {
  courseId: string;
  courseName: string;
  category: string;
  year: number | null;
  semester: string;
  examType: string;
  sourceType: string;
  resourceType: 'exam' | 'study_guide';
  sourceSchool?: string;
  hasAnswer: boolean;
  hasSolution: boolean;
  solutionPage: number | null;
  pageCount: number;
  description: string;
  /**
   * 配对答案文件的**文件名**（2026-10-16 新增）。
   *
   * 为什么这样配对而不是按顺序：勾选文件时顺序不可控，靠"下一个就是答案"迟早错位。
   * 用显式文件名最稳，也方便一眼核对；答案文件本身不单独入库，只是被配对上传。
   * 注意：答案单独成文件时 `hasSolution` 要填 **false** —— 那是"解析并进同一份 PDF、
   * 靠 solutionPage 跳转"的老机制，两者不要混用。
   */
  answerFileName?: string;
}> = {
  'CTBU-高等数学AII-2024-2025-春季-期末.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2025, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '重庆工商大学 2024-2025 学年第二学期高等数学 AII 期末试卷（24级，多学时）',
  },
  'CTBU-高等数学AII-2021-2022-春季-期末-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2022, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 4, pageCount: 6,
    description: '重庆工商大学 2021-2022 学年第二学期高等数学 AII 期末试卷，附答案与解析扫描页',
  },
  'CTBU-高等数学AII-2020-2021-春季-期末.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2021, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 4,
    description: '重庆工商大学 2020-2021 学年第二学期高等数学 AII 期末试卷（20级）',
  },
  'CTBU-高等数学AII-2019-2020-春季-期末-A1-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2020, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 5, pageCount: 7,
    description: '重庆工商大学 2019-2020 学年第二学期高等数学 AII 期末 A1 套，附参考答案与评分标准',
  },
  'CTBU-高等数学AII-2019-2020-春季-期末-A2-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2020, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 5, pageCount: 7,
    description: '重庆工商大学 2019-2020 学年第二学期高等数学 AII 期末 A2 套，附参考答案与评分标准',
  },
  'CTBU-高等数学AII-2018-2019-春季-期末-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2019, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 7, pageCount: 10,
    description: '重庆工商大学 2018-2019 学年第二学期高等数学 AII 期末试卷，附答案与评分标准',
  },
  'CTBU-高等数学AII-2017-2018-春季-期末-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2018, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 8, pageCount: 10,
    description: '重庆工商大学 2017-2018 学年第二学期高等数学 AII 期末试卷，附答案与评分标准',
  },
  'CTBU-高等数学AII-2016-2017-春季-期末-含答案与解析.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2017, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 6, pageCount: 7,
    description: '重庆工商大学 2016-2017 学年第二学期高等数学 AII 期末试卷，附答案与评分标准',
  },
  'CTBU-线性代数A-2007-2008-秋季-期末-A-含答案与解析.pdf': {
    courseId: 'c002', courseName: '线性代数', category: 'math', year: 2007, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 3, pageCount: 8,
    description: '重庆工商大学 2007-2008 学年第一学期线性代数 A 卷，含答案及参考解法',
  },
  'CTBU-高等数学AI-2018-2019-秋季-期末-扫描转PDF.pdf': {
    courseId: 'c001', courseName: '高等数学', category: 'math', year: 2018, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 5,
    description: '重庆工商大学 2018-2019 学年第一学期高等数学 AI 期末试题（原DOC逐页转换）',
  },
  'CTBU-毛中特复习资料-2021版-导论至第7章.pdf': {
    courseId: 'c007', courseName: '毛泽东思想和中国特色社会主义理论体系概论', category: 'politics', year: 2021, semester: '', examType: '其他',
    sourceType: 'course_material', resourceType: 'study_guide', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 36,
    description: '《毛泽东思想和中国特色社会主义理论体系概论（2021版）》导论至第七章知识点、练习题与参考答案',
  },
  'CTBU-中国近现代史纲要复习资料.pdf': {
    courseId: 'c009', courseName: '中国近现代史纲要', category: 'politics', year: null, semester: '', examType: '其他',
    sourceType: 'course_material', resourceType: 'study_guide', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 9,
    description: '中国近现代史纲要复习资料大全：重点知识与章节复习题',
  },

  // ============================================================
  // 2026-10-16 新增：用户线下收集的会计学 / 统计学真题（10 套 20 份）
  //
  // 来源：两份合并扫描件拆分成套（会计学 32 张、统计学 38 张），已做 A4 竖版归一 + 去水印。
  // 口径：**只收有答案的**（用户 2026-10-16 决定），所以下面每套都有配对答案文件。
  // ⚠️ 这些是**答案独立成 PDF**的：hasSolution 一律 false、solutionPage 一律 null，
  //    答案通过 answerFileName 配对入库（写 papers.answer_path）。
  // 学年 → year 取学年**后一年**（与上面高等数学那批的口径一致，如 2024-2025 → 2025）。
  // 第1学期 → 秋季，第2学期 → 春季（沿用库里既有取值，避免界面出现两种写法）。
  // ============================================================
  'CTBU-会计学-2025-2026-第1学期-A卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2026, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2025-2026-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2025-2026 学年第一学期会计学 A 卷期末试卷（附答案与评分标准，答案单独成册）',
  },
  'CTBU-会计学-2023-2024-第2学期-A卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2024, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2023-2024-第2学期-A卷-答案.pdf',
    description: '重庆工商大学 2023-2024 学年第二学期会计学 A 卷期末试卷（附答案与评分标准，答案单独成册）',
  },
  'CTBU-会计学-2018-2019-第1学期-B卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2019, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2018-2019-第1学期-B卷-答案.pdf',
    description: '重庆工商大学 2018-2019 学年第一学期会计学 B 卷期末试卷（2018 级，B 套）',
  },
  'CTBU-会计学-2017-2018-第2学期-B卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2018, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 12,
    answerFileName: 'CTBU-会计学-2017-2018-第2学期-B卷-答案.pdf',
    description: '重庆工商大学 2017-2018 学年第二学期会计学 A（B 卷）期末试卷（附答案及评分标准）',
  },
  // ============================================================
  // 2026-10-16 深夜新增：eol 教学平台（课程50723）的原生 doc 转出的会计学卷
  //
  // 与上面「线下扫描件」那批的区别：这批是**老师上传的原始 Word 文档**转出来的，
  // 矢量文字、可搜索、体积只有扫描件的十分之一（100~200KB vs 1~2MB）。
  // 其中 2017-2018 第2学期 B 与 2018-2019 第1学期 B **与扫描件版重复** →
  // 用户 2026-10-16 拍板**用原生版覆盖替换**（库内 id 会变、旧链接失效，属已知代价）。
  // ⚠️ 2018-2019 第1学期 B：eol 源**只有 B 卷试卷、没有 B 卷答案**
  //   （源目录里 2018 级仅一个参考答案文件，是 A 卷的）→
  //   试卷换成原生版，**答案沿用上一轮扫描件那份**，绝不能一起覆盖掉。
  // 学年 → year 取学年后一年；第1学期 → 秋季（与上面既有条目口径一致）。
  // 答案全部独立成 PDF：hasSolution 一律 false、solutionPage 一律 null，靠 answerFileName 配对。
  // ============================================================
  'CTBU-会计学-2018-2019-第1学期-A卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2019, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2018-2019-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2018-2019 学年第一学期基础会计学 A 卷期末试卷（2018 级会计学等专业，A 套，附参考答案与评分标准）',
  },
  'CTBU-会计学-2019-2020-第1学期-A卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2020, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2019-2020-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2019-2020 学年第一学期基础会计学 A 卷期末试卷（2019 级会计学院院级教考分离，A 套，附参考答案）',
  },
  'CTBU-会计学-2019-2020-第1学期-B卷-试卷.pdf': {
    courseId: 'c020', courseName: '会计学', category: 'econ', year: 2020, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-会计学-2019-2020-第1学期-B卷-答案.pdf',
    description: '重庆工商大学 2019-2020 学年第一学期基础会计学 B 卷期末试卷（2019 级会计学院院级教考分离，B 套，附参考答案与评分标准）',
  },
  'CTBU-统计学-2023-2024-第1学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2024, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2023-2024-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2023-2024 学年第一学期统计学 A 卷期末试卷（全校教考分离，附标准答案及评分细则）',
  },
  'CTBU-统计学-2021-2022-第1学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2022, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2021-2022-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2021-2022 学年第一学期统计学 A 卷期末试卷（全校教考分离，附标准答案及评分细则）',
  },
  'CTBU-统计学-2020-2021-第1学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2021, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2020-2021-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2020-2021 学年第一学期统计学 A 卷期末试卷（全校教考分离，附标准答案及评分细则）',
  },
  'CTBU-统计学-2019-2020-第1学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2020, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2019-2020-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2019-2020 学年第一学期统计学 A 卷期末试卷（全校教考分离，附标准答案及评分细则）',
  },
  'CTBU-统计学-2018-2019-第1学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2019, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2018-2019-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2018-2019 学年第一学期统计学 A 卷期末试卷（校级教考分离，附标准答案及评分细则）',
  },
  'CTBU-统计学-2017-2018-第2学期-A卷-试卷.pdf': {
    courseId: 'c017', courseName: '统计学', category: 'math', year: 2018, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 8,
    answerFileName: 'CTBU-统计学-2017-2018-第2学期-A卷-答案.pdf',
    description: '重庆工商大学 2017-2018 学年第二学期统计学 A 卷期末试卷（全校教考分离，附标准答案及评分细则）',
  },

  // ============================================================
  // 2026-10-16 第二批：从学校 eol 平台采集的试卷（概率论 / 微积分Ⅰ / 管理学 / 计量经济学）
  //
  // 这批的 PDF 是从 eol 上的 .doc/.docx **重新转换**的。
  // 注意：第一版转换（2026-10-15）有严重缺陷 —— LibreOffice 的 fontconfig 找不到
  // macOS 中文字体，中文全渲染成方块、且字宽按 Latin 度量算（排版也错），
  // 44 份里 38 份实际不可用。修法见 tools/fonts.conf 与 AGENT-STATE。
  //
  // 答案形式分两种，不要混：
  //   · 概率论：答案与试卷在**同一份 PDF**里 → hasSolution=true + solutionPage=答案起始页
  //   · 微积分/管理学：答案**独立成一份** → hasSolution=false + answerFileName 配对
  // 学年 → year 取学年后一年；第1学期→秋季，第2学期→春季（与前面几批口径一致）。
  // ============================================================
  'CTBU-概率论-2019-2020-第2学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2020, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 9, pageCount: 14,
    description: '重庆工商大学 2019-2020 学年第二学期概率论 A 卷期末试卷（2019 级经济统计等专业，参考答案自第 9 页起）',
  },
  'CTBU-概率论-2019-2020-第2学期-B卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2020, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 9, pageCount: 14,
    description: '重庆工商大学 2019-2020 学年第二学期概率论 B 卷期末试卷（2019 级经济统计等专业，参考答案自第 9 页起）',
  },
  'CTBU-概率论-2019-2020-第1学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2020, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 9, pageCount: 12,
    description: '重庆工商大学 2019-2020 学年第一学期概率论 A 卷期末试卷（2018 级金融数学、应用数学，参考答案自第 9 页起）',
  },
  'CTBU-概率论-2020-2021-第2学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2021, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 9, pageCount: 14,
    description: '重庆工商大学 2020-2021 学年第二学期概率论 A 卷期末试卷（2020 级经济统计等专业，参考答案自第 9 页起）',
  },
  'CTBU-概率论-2020-2021-第1学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2021, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 7, pageCount: 10,
    description: '重庆工商大学 2020-2021 学年第一学期概率论 A 卷期末试卷（参考答案自第 7 页起）',
  },
  'CTBU-概率论-2021-2022-第2学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2022, semester: '春季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 9, pageCount: 12,
    description: '重庆工商大学 2021-2022 学年第二学期概率论 A 套期末试卷（2021 级 48 学时，参考答案自第 9 页起）',
  },
  'CTBU-概率论-2021-2022-第1学期-A卷-含答案.pdf': {
    courseId: 'c003', courseName: '概率论与数理统计', category: 'math', year: 2022, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: true, solutionPage: 7, pageCount: 12,
    description: '重庆工商大学 2021-2022 学年第一学期概率论 A 卷期末试卷（2020 级应用数学，参考答案自第 7 页起）',
  },

  'CTBU-微积分-统考试题-A卷-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 7,
    answerFileName: 'CTBU-微积分-统考试题-A卷-答案.pdf',
    description: '微积分 I 统考试题（A 卷，120 分钟，2005 级）。原卷未标学年，答案与评分标准为独立一份',
  },
  'CTBU-微积分-统考试题-B卷-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 9,
    answerFileName: 'CTBU-微积分-统考试题-B卷-答案.pdf',
    description: '微积分 I 统考试题（B 卷，120 分钟，2005 级）。原卷未标学年，答案与评分标准为独立一份',
  },
  'CTBU-微积分-2017-2018-第1学期-A卷-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: 2018, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 7,
    answerFileName: 'CTBU-微积分-2017-2018-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2017-2018 学年第一学期微积分 A(Ⅰ) A 套期末试卷（17 级经济管理类各专业，校级教考分离，答案独立成册）',
  },
  'CTBU-微积分-2014-2015-第1学期-A卷-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: 2015, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 6,
    description: '重庆工商大学《微积分 I》期末考试试卷 A 卷（暂未收集答案）。注：卷头印的是 2013-2014，与源文件名标注的 2014-2015 学年不一致，年份存疑',
  },
  'CTBU-微积分-2014-2015-第1学期-B卷-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: 2015, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 6,
    description: '重庆工商大学《微积分 I》期末考试试卷 B 卷（暂未收集答案）。年份口径同上，存疑',
  },
  'CTBU-微积分-自测试题-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 5,
    description: '微积分 1 第 1-5 章自测试题（一），供章节复习自测用（无答案）',
  },
  'CTBU-微积分-模拟题-一-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '微积分（上）模拟题一（填空＋选择＋计算＋证明，无答案）',
  },
  'CTBU-微积分-模拟题-二-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 2,
    description: '微积分（上）模拟题二（无答案）',
  },
  'CTBU-微积分-模拟题-三-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '微积分（上）模拟题三（无答案）',
  },
  'CTBU-微积分-模拟题-四-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '微积分（上）模拟题四（无答案）',
  },
  'CTBU-微积分-模拟题-五-试卷.pdf': {
    courseId: 'c011', courseName: '微积分Ⅰ', category: 'math', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '微积分（上）模拟题五（无答案）',
  },

  'CTBU-管理学-2017-2018-第1学期-A卷-试卷.pdf': {
    courseId: 'c021', courseName: '管理学', category: 'econ', year: 2018, semester: '秋季', examType: '期末',
    sourceType: 'original', resourceType: 'exam', hasAnswer: true, hasSolution: false, solutionPage: null, pageCount: 6,
    answerFileName: 'CTBU-管理学-2017-2018-第1学期-A卷-答案.pdf',
    description: '重庆工商大学 2017-2018 学年第一学期管理学 A 套期末试卷（适用 2017 级 IBS 人资 1 班、会计 3 班，答案及评分标准独立成册）',
  },

  'CTBU-计量经济学-模拟试题-一-试卷.pdf': {
    courseId: 'c022', courseName: '计量经济学', category: 'econ', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 7,
    description: '计量经济学模拟试题（一）（判断对错＋选择＋计算，无答案）',
  },
  'CTBU-计量经济学-模拟试题-二-试卷.pdf': {
    courseId: 'c022', courseName: '计量经济学', category: 'econ', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 7,
    description: '计量经济学模拟试题（二）（无答案）',
  },
  'CTBU-计量经济学-模拟试题-三-试卷.pdf': {
    courseId: 'c022', courseName: '计量经济学', category: 'econ', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 5,
    description: '计量经济学模拟试题（三）（无答案）',
  },
  'CTBU-计量经济学-模拟试题-四-试卷.pdf': {
    courseId: 'c022', courseName: '计量经济学', category: 'econ', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 5,
    description: '计量经济学模拟试题（四）（无答案）',
  },
  'CTBU-计量经济学-模拟试题-五-试卷.pdf': {
    courseId: 'c022', courseName: '计量经济学', category: 'econ', year: null, semester: '', examType: '其他',
    sourceType: 'original', resourceType: 'exam', hasAnswer: false, hasSolution: false, solutionPage: null, pageCount: 3,
    description: '计量经济学模拟试题（五）（无答案）',
  },
};

interface UploadStatus { name: string; state: 'ready' | 'uploading' | 'done' | 'error' | 'skipped'; message?: string; }

export function BulkImportPapers() {
  const { session, isAdmin } = useAuth();
  const { refresh, realPapers } = usePapers();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<UploadStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  /** 覆盖模式：已入库的试卷也重传，先删旧记录与旧文件再传新的（用于把线上 PDF 换成新版本） */
  const [overwrite, setOverwrite] = useState(false);

  /** 清单里被引用为「答案」的文件名集合 —— 它们不单独入库，只作为配对附件 */
  const answerFileNames = useMemo(
    () => new Set(
      Object.values(IMPORT_MANIFEST)
        .map((m) => m.answerFileName)
        .filter((n): n is string => !!n),
    ),
    [],
  );

  const unrecognized = useMemo(
    () => files.filter((f) => !IMPORT_MANIFEST[f.name] && !answerFileNames.has(f.name)),
    [files, answerFileNames],
  );

  /** 该文件对应的已入库试卷（按 description 匹配） */
  const existingFor = (f: File) => {
    const meta = IMPORT_MANIFEST[f.name];
    if (!meta) return undefined;
    return realPapers.find((p) => p.description === meta.description);
  };
  const alreadyImported = files.filter((f) => !!existingFor(f));
  const fresh = files.filter((f) => !!IMPORT_MANIFEST[f.name] && !existingFor(f));

  /** 本次实际要处理的文件 */
  const toImport = overwrite ? [...fresh, ...alreadyImported] : fresh;
  const completed = statuses.filter((s) => s.state === 'done').length;

  if (!isAdmin) return null;

  const runImport = async () => {
    if (!session?.user?.id || toImport.length === 0 || busy) return;
    setBusy(true);
    setFinished(false);
    const next: UploadStatus[] = toImport.map((f) => ({ name: f.name, state: 'ready' }));
    setStatuses(next);

    for (let i = 0; i < toImport.length; i += 1) {
      const file = toImport[i];
      next[i] = { name: file.name, state: 'uploading' };
      setStatuses([...next]);
      try {
        // 把 answerFileName 摘出去（它只是"配对线索"，不是 papers 表的字段），
        // 再按文件名把对应的答案文件找出来一并交给 uploadPaper。
        const { answerFileName, ...meta } = IMPORT_MANIFEST[file.name];
        const answerFile = answerFileName
          ? files.find((f) => f.name === answerFileName) ?? null
          : null;
        if (answerFileName && !answerFile) {
          throw new Error(`清单要求配答案「${answerFileName}」，但本次没勾选到该文件`);
        }
        const old = overwrite ? existingFor(file) : undefined;
        // 先删旧记录与旧文件，再传新的：既不留孤儿文件，也不会出现重复条目。
        // 顺序若反过来（先传后删），一旦删除失败就会留下两份重复试卷。
        if (old) await deletePaper(old);
        await uploadPaper({ file, ...meta, answerFile });
        next[i] = { name: file.name, state: 'done' };
      } catch (e) {
        next[i] = {
          name: file.name,
          state: 'error',
          message: (e instanceof Error ? e.message : '上传失败') + (overwrite ? '（旧记录可能已删除，请重试该份）' : ''),
        };
      }
      setStatuses([...next]);
    }
    await refresh();
    setBusy(false);
    setFinished(true);
  };

  return (
    <div className="bg-ink-850 rounded-2xl border border-gray-200 p-5 sm:p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-wash flex items-center justify-center shrink-0">
          <LockKeyhole className="w-5 h-5 text-accent" />
        </div>
        <div>
          {/* 数量改为按清单实时算：以前写死「24 份」，加料之后就会对不上 */}
          <h3 className="font-semibold text-gray-900">
            批量导入资料（清单 {Object.keys(IMPORT_MANIFEST).length} 份）
          </h3>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            清单里的每份都要勾选；配了答案的试卷要一并勾选它的答案文件（答案不单独入库，只作为配对附件）。
            留空的答案文件会被报错拦下，不会静默漏传。PDF 存在私有存储；试卷需登录并按免费额度/会员授权后在线查看，网页不提供 PDF 下载按钮。
          </p>
        </div>
      </div>

      <label className="block">
        <span className="text-xs text-gray-500">选择 `import-ready` 文件夹里的全部 PDF</span>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => {
            const selected = Array.from(e.target.files ?? []);
            setFiles(selected);
            setStatuses([]);
            setFinished(false);
          }}
          className="mt-1 w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-accent-wash file:text-accent"
        />
      </label>

      <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => {
            setOverwrite(e.target.checked);
            setStatuses([]);
            setFinished(false);
          }}
          className="mt-0.5 shrink-0"
        />
        <span className="leading-relaxed">
          <span className="text-gray-900 font-medium">覆盖已入库的试卷（重传替换）</span>
          <br />
          勾选后，清单里<b>已经入库的试卷也会重新上传</b>：先删除旧记录与旧文件，再传新的。
          用于把线上 PDF 换成新版本。处理期间该份会短暂不可用。
        </span>
      </label>

      {files.length > 0 && (
        <div className="rounded-xl bg-gray-50 p-3 space-y-2">
          <div className="flex justify-between text-xs text-gray-600">
            <span>
              已选 {files.length} 个：本次处理 <b>{toImport.length}</b> 份
              （新导入 {fresh.length}，覆盖 {alreadyImported.length}）
            </span>
            <span>{completed}/{toImport.length} 完成</span>
          </div>
          {unrecognized.length > 0 && (
            <div className="text-xs text-gray-500 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              以下文件名未匹配导入清单，将跳过：{unrecognized.map((f) => f.name).join('、')}
            </div>
          )}
          <ul className="max-h-40 overflow-auto space-y-1">
            {files.map((f) => {
              const st = statuses.find((s) => s.name === f.name);
              const exists = alreadyImported.some((item) => item.name === f.name);
              return (
                <li key={f.name} className="flex items-center gap-2 text-xs text-gray-600">
                  {st?.state === 'done' ? <CheckCircle className="w-3.5 h-3.5 text-accent" />
                    : st?.state === 'uploading' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                    : st?.state === 'error' ? <AlertCircle className="w-3.5 h-3.5 text-red-600" />
                    : exists ? <CheckCircle className="w-3.5 h-3.5 text-gray-500" />
                    : <span className="w-3.5 h-3.5 rounded-full border border-gray-300" />}
                  <span className="truncate flex-1">{f.name}</span>
                  {exists && !st && (
                    <span className={overwrite ? 'text-amber-700' : 'text-gray-500'}>
                      {overwrite ? '将覆盖重传' : '已导入，跳过'}
                    </span>
                  )}
                  {st?.message && <span className="text-red-600">{st.message}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {finished && completed === toImport.length && toImport.length > 0 && (
        <p className="text-sm text-green-700 flex items-center gap-2"><CheckCircle className="w-4 h-4" />全部处理完成，站点试卷库已刷新。</p>
      )}
      {finished && completed < toImport.length && (
        <p className="text-sm text-gray-500">批次已结束；成功 {completed} 份，其余失败可重新选择文件再试。</p>
      )}

      <button
        onClick={runImport}
        disabled={busy || toImport.length === 0 || unrecognized.length > 0}
        className="w-full sm:w-auto px-5 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-deep disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {busy
          ? `正在安全上传 ${completed}/${toImport.length}…`
          : overwrite
            ? `覆盖重传 ${toImport.length} 份`
            : '按清单批量上传'}
      </button>
    </div>
  );
}
