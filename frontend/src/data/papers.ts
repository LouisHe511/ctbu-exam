import type { ExamPaper, PaperContent } from '@/types';

const semesters: ExamPaper['semester'][] = ['春季', '秋季', '夏季', '寒假补考'];
const examTypes: ExamPaper['examType'][] = ['期中', '期末', '补考', '重修', '其他'];
const years = [2021, 2022, 2023, 2024];

const courseIds = [
  'c001', 'c002', 'c003', 'c005', 'c006', 'c007', 'c008', 'c009', 'c010',
];

const courseNames: Record<string, string> = {
  c001: '高等数学',
  c002: '线性代数',
  c003: '概率论与数理统计',
  c005: '习近平新时代中国特色社会主义思想概论',
  c006: '马克思主义基本原理',
  c007: '毛泽东思想和中国特色社会主义理论体系概论',
  c008: '思想道德与法治',
  c009: '中国近现代史纲要',
  c010: '大学计算机基础',
};

const categoryMap: Record<string, string> = {
  c001: 'math', c002: 'math', c003: 'math',
  c005: 'politics', c006: 'politics', c007: 'politics', c008: 'politics',
  c009: 'politics', c010: 'computer',
};

const DEMO_NOTICE = '以下为演示样例，非真实试卷';

function generatePapers(): ExamPaper[] {
  const papers: ExamPaper[] = [];
  let id = 1;

  for (const courseId of courseIds) {
    for (let i = 0; i < 6; i++) {
      const year = years[i % years.length];
      const semester = semesters[i % semesters.length];
      const examType = examTypes[i % examTypes.length];
      const hasAnswer = i % 2 === 0;
      const pages = 5;
      const views = 5000 - id * 50;
      const tags: string[] = [];
      if (hasAnswer) tags.push('含答案');
      if (year === 2024) tags.push('最新');
      if (examType === '期末') tags.push('重点');

      papers.push({
        id: `p${String(id).padStart(4, '0')}`,
        courseId,
        courseName: courseNames[courseId],
        category: categoryMap[courseId],
        year,
        semester,
        examType,
        hasAnswer,
        pages,
        views,
        uploadedAt: `${year}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        tags,
      });
      id++;
    }
  }

  return papers.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export const papers: ExamPaper[] = generatePapers();

export function getPaperContent(paperId: string): PaperContent {
  const paper = papers.find((p) => p.id === paperId);
  const pageCount = paper?.pages ?? 5;
  const category = paper ? categoryMap[paper.courseId] : 'math';

  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const isAnswer = !!(paper?.hasAnswer && i > Math.ceil(pageCount / 2));
    pages.push({
      pageNumber: i,
      isAnswer,
      content: isAnswer
        ? generateAnswerContent(paper?.courseName ?? '', paper?.year ?? 2024, i, category)
        : generateQuestionContent(paper?.courseName ?? '', paper?.year ?? 2024, i, pageCount, category),
    });
  }

  return { paperId, pages };
}

// ── Math template ──────────────────────────────────────────────

function mathQuestion(course: string, year: number, page: number, total: number): string {
  if (page === 1) {
    return `${DEMO_NOTICE}\n\n重庆工商大学 ${year} 学年考试试卷\n\n课程：${course}\n\n\n一、单项选择题（每小题4分，共20分）\n\n1. 极限 lim(x→0) sin(x)/x 的值为（  ）\n   A. 0    B. 1    C. ∞    D. 不存在\n\n2. 设 f(x) = x³ - 3x + 1，则 f'(x) = （  ）\n   A. 3x² - 3    B. x² - 3    C. 3x² + 1    D. x³ - 3\n\n3. 函数 f(x) = ln(x) 的定义域为（  ）\n   A. (-∞, +∞)    B. [0, +∞)    C. (0, +∞)    D. (1, +∞)\n\n4. 设矩阵 A = [1 2; 3 4]，则 |A| = （  ）\n   A. -2    B. 2    C. 10    D. -10\n\n5. 若事件 A 与 B 互斥，P(A) = 0.3，P(B) = 0.4，则 P(A∪B) = （  ）\n   A. 0.12    B. 0.7    C. 0.1    D. 0.3`;
  }
  if (page === 2) {
    return `${DEMO_NOTICE}\n\n6. 设 f(x) = e^x，则 f''(x) = （  ）\n   A. e^x    B. x·e^x    C. e^(x+1)    D. 1/e^x\n\n7. ∫(1/x)dx = （  ）\n   A. -1/x² + C    B. ln|x| + C    C. 1/x² + C    D. x·ln(x) + C\n\n8. 设随机变量 X ~ N(0,1)，则 P(X > 0) = （  ）\n   A. 0    B. 0.25    C. 0.5    D. 1\n\n\n二、计算题（每小题10分，共30分）\n\n1. 求极限 lim(x→0) (e^x - 1) / x。\n\n\n\n\n2. 求不定积分 ∫ x·e^(x²) dx。\n\n\n\n\n3. 设 f(x) = x²·ln(x)，求 f'(x)。`;
  }
  return `${DEMO_NOTICE}\n\n4. 设 f(x) = x³ - 3x² + 2，求函数的极值点。\n\n\n\n\n\n\n5. 计算定积分 ∫₀¹ x² dx。\n\n\n\n\n\n\n\n\n\n\n\n———————— 第 ${page} / ${total} 页 ————————`;
}

function mathAnswer(course: string, year: number, page: number): string {
  return `${DEMO_NOTICE}\n\n参考答案（${course} ${year}年）\n\n一、单项选择题\n\n1. B   2. A   3. C   4. A   5. B\n6. A   7. B   8. C\n\n\n二、计算题\n\n1. lim(x→0) (e^x - 1)/x = 1（洛必达法则）\n\n2. ∫ x·e^(x²) dx = (1/2)·e^(x²) + C\n\n3. f'(x) = 2x·ln(x) + x = x(2·ln(x) + 1)\n\n4. f'(x) = 3x² - 6x = 3x(x - 2)，令 f'(x) = 0\n   得 x = 0（极大值，f(0)=2）和 x = 2（极小值，f(2)=-2）\n\n5. ∫₀¹ x² dx = [x³/3]₀¹ = 1/3\n\n\n———————— 参考答案 第 ${page} 页 ————————`;
}

// ── Language template ──────────────────────────────────────────

function languageQuestion(course: string, year: number, page: number, total: number): string {
  if (page === 1) {
    return `${DEMO_NOTICE}\n\n重庆工商大学 ${year} 学年考试试卷\n\n课程：${course}\n\n\nPart I. Vocabulary and Structure (20 points)\n\n1. She _____ the letter when the phone rang.\n   A. wrote    B. was writing    C. has written    D. writes\n\n2. The teacher told us _____ the exam carefully.\n   A. to read    B. reading    C. read    D. reads\n\n3. This is the most interesting book _____ I have ever read.\n   A. that    B. which    C. what    D. who\n\n4. By the time he arrived, the meeting _____.\n   A. started    B. had started    C. has started    D. starts\n\n5. Neither Tom nor his brothers _____ to the party.\n   A. is going    B. are going    C. goes    D. was going`;
  }
  if (page === 2) {
    return `${DEMO_NOTICE}\n\nPart II. Cloze Test (15 points)\n\nIn many countries, education is free for all children. However, in some\nplaces, families must pay for schooling. This means that children from\npoor families may not have the 1. _____ to go to school. Governments\nare trying to 2. _____ this problem by providing free education.\nBut there are still many 3. _____ that need to be solved.\n\n1. A. chance    B. money    C. time    D. book\n2. A. solve    B. make    C. find    D. do\n3. A. questions    B. problems    C. answers    D. ways\n\n\nPart III. Reading Comprehension (20 points)\n\nPassage: The Internet has changed the way people communicate.\nWith email and social media, people can stay in touch with friends\nand family around the world. However, some experts worry that\nonline communication may reduce face-to-face interaction.\n\n1. According to the passage, the Internet has changed _____.\n   A. eating habits    B. communication    C. transportation    D. weather\n\n2. What do some experts worry about?\n   A. The cost of the Internet.\n   B. Reduced face-to-face interaction.\n   C. Too many social media platforms.\n   D. Email is too slow.`;
  }
  return `${DEMO_NOTICE}\n\nPart IV. Translation (20 points)\n\n1. 请将下列句子翻译成英文：\n   (1) 他每天早上六点起床去跑步。\n   (2) 这本书比那本书有趣得多。\n\n\n\n\n2. Please translate the following into Chinese:\n   (1) The early bird catches the worm.\n   (2) Knowledge is power.\n\n\n\n\n\n\nPart V. Writing (25 points)\n\nWrite a short essay (about 150 words) on the topic:\n"The Importance of Learning English"\n\n\n\n\n\n\n\n\n———————— 第 ${page} / ${total} 页 ————————`;
}

function languageAnswer(course: string, year: number, page: number): string {
  return `${DEMO_NOTICE}\n\n参考答案（${course} ${year}年）\n\nPart I. 1. B   2. A   3. A   4. B   5. B\n\nPart II. 1. A   2. A   3. B\n\nPart III. 1. B   2. B\n\nPart IV. 参考译文\n1. (1) He gets up at six every morning to go running.\n   (2) This book is much more interesting than that one.\n2. (1) 早起的鸟儿有虫吃。  (2) 知识就是力量。\n\nPart V. 写作参考要点：\n- English as a global language\n- Career opportunities\n- Cultural exchange\n- Personal development\n\n\n———————— 参考答案 第 ${page} 页 ————————`;
}

// ── Politics template ──────────────────────────────────────────

function politicsQuestion(course: string, year: number, page: number, total: number): string {
  if (page === 1) {
    return `${DEMO_NOTICE}\n\n重庆工商大学 ${year} 学年考试试卷\n\n课程：${course}\n\n\n一、单项选择题（每小题2分，共20分）\n\n1. 马克思主义最鲜明的政治立场是（  ）\n   A. 致力于实现最广大人民的根本利益\n   B. 致力于实现共产主义\n   C. 致力于推翻资本主义制度\n   D. 致力于发展生产力\n\n2. 物质的唯一特性是（  ）\n   A. 运动    B. 可知性    C. 客观实在性    D. 结构性\n\n3. 实践是检验真理的唯一标准，因为它具有（  ）\n   A. 直接现实性    B. 普遍性    C. 客观性    D. 主观性\n\n4. 社会存在与社会意识的关系是（  ）\n   A. 社会意识决定社会存在\n   B. 社会存在决定社会意识\n   C. 两者互不相关\n   D. 两者完全等同\n\n5. 中国共产党最大的政治优势是（  ）\n   A. 理论联系实际    B. 密切联系群众\n   C. 批评与自我批评    D. 武装斗争`;
  }
  if (page === 2) {
    return `${DEMO_NOTICE}\n\n6. 新时代我国社会的主要矛盾是（  ）\n   A. 人民日益增长的物质文化需要同落后的社会生产之间的矛盾\n   B. 人民日益增长的美好生活需要和不平衡不充分的发展之间的矛盾\n   C. 无产阶级与资产阶级之间的矛盾\n   D. 经济建设与环境保护之间的矛盾\n\n7. 实现中华民族伟大复兴的中国梦，其本质是（  ）\n   A. 国家富强、民族振兴、人民幸福\n   B. 经济发展、社会和谐\n   C. 科技强国、文化自信\n   D. 政治民主、法治健全\n\n8. 四个全面战略布局不包括（  ）\n   A. 全面建成小康社会    B. 全面深化改革\n   C. 全面从严治党        D. 全面对外开放\n\n\n二、多项选择题（每小题3分，共15分）\n\n1. 马克思主义的三大组成部分是（  ）\n   A. 马克思主义哲学    B. 马克思主义政治经济学\n   C. 科学社会主义      D. 马克思主义法学\n\n2. 下列属于社会主义核心价值观的有（  ）\n   A. 富强    B. 民主    C. 文明    D. 和谐`;
  }
  return `${DEMO_NOTICE}\n\n3. 中国特色社会主义的本质要求包括（  ）\n   A. 解放和发展社会生产力\n   B. 消除两极分化\n   C. 最终达到共同富裕\n   D. 实现绝对平均主义\n\n\n三、简答题（每小题10分，共30分）\n\n1. 简述实践在认识中的决定作用。\n\n\n\n\n\n2. 简述新时代中国特色社会主义思想的"八个明确"中的任意三个。\n\n\n\n\n\n3. 简述中国共产党的群众路线及其现实意义。\n\n\n\n\n\n\n\n\n———————— 第 ${page} / ${total} 页 ————————`;
}

function politicsAnswer(course: string, year: number, page: number): string {
  return `${DEMO_NOTICE}\n\n参考答案（${course} ${year}年）\n\n一、单项选择题\n\n1. A   2. C   3. A   4. B   5. B\n6. B   7. A   8. D\n\n二、多项选择题\n\n1. ABC    2. ABCD    3. ABC\n\n三、简答题要点\n\n1. 实践是认识的来源、动力、目的和检验真理的唯一标准。\n   实践产生了认识的需要，为认识提供了可能，并检验认识\n   的真理性。\n\n2. 明确坚持和发展中国特色社会主义等（任选三个，言之成理\n   即可）。\n\n3. 群众路线：一切为了群众，一切依靠群众，从群众中来，\n   到群众中去。现实意义：保持党同人民群众的血肉联系，\n   是党的生命线。\n\n\n———————— 参考答案 第 ${page} 页 ————————`;
}

// ── Computer template ──────────────────────────────────────────

function computerQuestion(course: string, year: number, page: number, total: number): string {
  if (page === 1) {
    return `${DEMO_NOTICE}\n\n重庆工商大学 ${year} 学年考试试卷\n\n课程：${course}\n\n\n一、单项选择题（每小题2分，共20分）\n\n1. 计算机中数据的表示采用的是（  ）\n   A. 十进制    B. 二进制    C. 八进制    D. 十六进制\n\n2. 一个字节（Byte）等于（  ）位（bit）\n   A. 4    B. 8    C. 16    D. 32\n\n3. 十进制数 25 转换为二进制是（  ）\n   A. 11001    B. 10011    C. 11010    D. 10101\n\n4. 操作系统是一种（  ）\n   A. 应用软件    B. 系统软件    C. 编译程序    D. 用户程序\n\n5. Excel 中求 A1 到 A10 的平均值，正确的公式是（  ）\n   A. =SUM(A1:A10)    B. =AVERAGE(A1:A10)\n   C. =MAX(A1:A10)    D. =COUNT(A1:A10)`;
  }
  if (page === 2) {
    return `${DEMO_NOTICE}\n\n6. IP 地址 192.168.1.1 属于（  ）\n   A. A 类地址    B. B 类地址    C. C 类地址    D. D 类地址\n\n7. HTTP 协议的默认端口号是（  ）\n   A. 21    B. 22    C. 80    D. 443\n\n8. 在 Word 中，要使文字居中对齐，应使用快捷键（  ）\n   A. Ctrl+L    B. Ctrl+R    C. Ctrl+E    D. Ctrl+J\n\n\n二、判断题（每小题2分，共10分）\n\n1. CPU 只能直接访问内存中的数据，不能直接访问外存。\n   （  ）\n\n2. 一个汉字在计算机中用 2 个字节存储。  （  ）\n\n3. 删除文件后，文件一定进入了回收站。  （  ）\n\n4. 局域网（LAN）的覆盖范围比广域网（WAN）大。  （  ）\n\n5. 二进制数 1010 + 1101 = 10111。  （  ）`;
  }
  return `${DEMO_NOTICE}\n\n三、操作题（每小题10分，共30分）\n\n1. 将十进制数 100 分别转换为二进制和十六进制。\n\n\n\n\n2. 在 Excel 中，A 列有 10 个学生的成绩，请在 B 列中\n   写出公式：成绩大于等于 60 分显示"及格"，否则显示\n   "不及格"。\n\n\n\n\n\n3. 简述在 Word 中设置页眉页脚的步骤。\n\n\n\n\n\n\n\n\n———————— 第 ${page} / ${total} 页 ————————`;
}

function computerAnswer(course: string, year: number, page: number): string {
  return `${DEMO_NOTICE}\n\n参考答案（${course} ${year}年）\n\n一、单项选择题\n\n1. B   2. B   3. A   4. B   5. B\n6. C   7. C   8. C\n\n二、判断题\n\n1. √   2. √   3. ×（Shift+Delete 永久删除）\n4. ×（LAN 覆盖范围更小）   5. √\n\n三、操作题\n\n1. 100(十进制) = 1100100(二进制) = 64(十六进制)\n\n2. 在 B1 单元格输入：\n   =IF(A1>=60,"及格","不及格")\n   然后下拉填充至 B10。\n\n3. 插入 → 页眉和页脚 → 选择样式 → 输入内容 → 关闭。\n\n\n———————— 参考答案 第 ${page} 页 ————————`;
}

// ── Dispatch ───────────────────────────────────────────────────

function generateQuestionContent(course: string, year: number, page: number, total: number, category: string): string {
  switch (category) {
    case 'math':     return mathQuestion(course, year, page, total);
    case 'language': return languageQuestion(course, year, page, total);
    case 'politics': return politicsQuestion(course, year, page, total);
    case 'computer': return computerQuestion(course, year, page, total);
    default:         return mathQuestion(course, year, page, total);
  }
}

function generateAnswerContent(course: string, year: number, page: number, category: string): string {
  switch (category) {
    case 'math':     return mathAnswer(course, year, page);
    case 'language': return languageAnswer(course, year, page);
    case 'politics': return politicsAnswer(course, year, page);
    case 'computer': return computerAnswer(course, year, page);
    default:         return mathAnswer(course, year, page);
  }
}
