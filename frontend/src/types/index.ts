/** 学期（四年制八学期）—— 真题库的主轴 */
export interface Term {
  /** y1s1 … y4s2 */
  id: string;
  /** 大一上 / 大一下 … */
  name: string;
  /** 大一 / 大二 / 大三 / 大四 */
  grade: string;
  /** 上 / 下 */
  semester: string;
  /** 1-8，排序用 */
  order: number;
}

export interface Course {
  id: string;
  name: string;
  category: string;
  code: string;
  description: string;
  paperCount: number;
  hasAnswerCount: number;
  views: number;
  popularity: number;
  coverGradient: string;

  // ---- 年级/学期维度（新增）----
  /**
   * 归一化后的课程本体名，用于归并「同一门课的不同班型」。
   * 例：毛泽东思想和中国特色社会主义理论体系概论Ⅰ / Ⅱ → 同一个 baseName。
   * 同一门课在学校平台上可能有好几个课程空间（不同老师各建一个），
   * 采集时按 baseName 归并，试卷汇总到一门课下。
   */
  baseName?: string;
  /** 班型/版本后缀：A类 / B类 / 中外 / IBS / 48学时 / 文新 等 */
  variant?: string;
  /** 主开课学期 y1s1…y4s2。**为空表示尚未确认**（界面会标注"学期待确认"，不瞎猜） */
  termId?: string;
  /** 是否跨学期连开（如「形势与政策」1-8 学期都开） */
  spansTerms?: boolean;
  /** 适用专业/学院，为空表示全校通用 */
  majors?: string[];
  /** 来源：school_platform=学校网络教学平台 / offline=线下收集 / user=用户投稿 */
  source?: string;
}

export interface ExamPaper {
  id: string;
  courseId: string;
  courseName: string;
  category: string;
  /**
   * 考试年份。**可能为 null** —— 有些卷子的原件上根本没有学年信息
   * （例如只写「2005 级」的统考试题、或模拟题/自测题），
   * 这时一律留空、界面**直接不显示年份**（2026-10-18 用户要求：不要写「年份待确认」占位），
   * 绝不拿当前年份顶上（2026-10-16 修）。
   */
  year: number | null;
  /**
   * 开课学期。**可能为 null** —— 只有原卷写明「第 1/2 学期」的才有依据映射，
   * 没写的一律留空、界面直接跳过不显示，不再一律回退成「秋季」（2026-10-16 修）。
   */
  semester: '春季' | '秋季' | '夏季' | '寒假补考' | null;
  examType: '期中' | '期末' | '补考' | '重修' | '其他';
  hasAnswer: boolean;
  /** 是否含解析（比"答案"更进一步：有解题过程/讲解） */
  hasSolution?: boolean;
  /** 解析在 PDF 里的起始页码（从 1 开始）。有值时阅读器可以一键跳到解析 */
  solutionPage?: number;
  pages: number;
  views: number;
  uploadedAt: string;
  tags: string[];
  /** Storage 里的 PDF 路径。为空表示这是演示数据，没有真实文件 */
  filePath?: string;
  /**
   * 答案 / 评分标准 PDF 的 Storage 路径（与 filePath 配对，**答案独立成一份文件**）。
   * 为空表示这份试卷没有独立答案 —— 阅读器此时不渲染「查看答案」入口。
   * 与 `hasSolution` + `solutionPage`（答案并进同一份 PDF、按页码跳转）是**两套并存**的机制：
   * 老数据用后者，新收的线下真题用前者。2026-10-16 新增。
   */
  answerPath?: string;
  /** recall=回忆版 / original=原卷 / mock=模拟题 */
  sourceType?: string;
  description?: string;
  /** true 表示来自数据库的真实试卷，false/undefined 表示演示数据 */
  isReal?: boolean;
  /** 非本校试卷要标明来源学校（例如「西安邮电大学」） */
  sourceSchool?: string;
  /** public=任何人可见；login=仅登录用户可见。匿名用户根本查不到 login 的行 */
  visibility?: 'public' | 'login';
  /** exam=真题 / study_guide=复习资料 */
  resourceType?: 'exam' | 'study_guide';
  /** 卡片标题（比课程名更具体，如「财政学模拟试题1-5」）。为空时回退 courseName */
  title?: string;
  /** 类型标签：真题 / 模拟 / 习题（2026-10-20 新增，用户要求卡片下方打标签） */
  paperKind?: '真题' | '模拟' | '习题';
}

/** papers 表的一行 */
export interface PaperRow {
  id: string;
  course_id: string;
  course_name: string;
  /** 2026-10-20 新增可空列 */
  title?: string | null;
  paper_kind?: string | null;
  category: string;
  year: number | null;
  semester: string;
  exam_type: string;
  source_type: string;
  resource_type: string | null;
  source_school: string | null;
  has_answer: boolean;
  has_solution: boolean | null;
  solution_page: number | null;
  page_count: number;
  file_path: string;
  /** 答案 PDF 的 Storage 路径；老数据为 null。2026-10-16 新增列 */
  answer_path?: string | null;
  file_size: number;
  description: string;
  view_count: number;
  status: string;
  /** public=所有人可见；login=仅登录用户可见（学校平台采集的资料走这个）
   *  RLS 强制：匿名只能读到 visibility='public' 的行，前端改不了这个事实 */
  visibility: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

/** my_access_status() / unlock_paper() 返回的额度状态 */
export interface AccessStatus {
  logged_in: boolean;
  is_member: boolean;
  member_until: string | null;
  free_used: number;
  free_remaining: number;
}


export interface PaperContent {
  paperId: string;
  pages: PaperPage[];
}

export interface PaperPage {
  pageNumber: number;
  content: string;
  isAnswer: boolean;
}

/** 用户资料（profiles 表一行；2026-10-17 从 supabase.ts 挪到这里） */
export interface Profile {
  id: string;
  email: string | null;
  /**
   * ⚠️ 2026-10-21：这几列**真的可能是 null**。
   * 手机号注册的账号没有邮箱，触发器建 profile 时 display_name / student_id /
   * school / college 全是 NULL。以前类型写成 `string` 是撒谎，
   * 结果后台的 `.toLowerCase()` 直接炸成白屏（用户报"打不开管理员页面"）。
   */
  display_name: string | null;
  student_id: string | null;
  school: string | null;
  college: string | null;
  created_at: string;
  /** 手机号账号才有（2026-10-21） */
  phone?: string | null;
  membership_tier?: string;
  membership_expires_at?: string | null;
  is_founder?: boolean;
  invite_code?: string | null;
  invite_months_granted?: number;
}

export interface UserFavorite {
  paperId: string;
  addedAt: string;
}

export interface RecentView {
  paperId: string;
  viewedAt: string;
}

export interface UserDevice {
  id: string;
  deviceName: string;
  deviceType: '手机' | '电脑' | '平板';
  lastActive: string;
  isCurrent: boolean;
}

export interface UserPermission {
  courseId: string;
  courseName: string;
  purchasedAt: string;
  expiresAt: string;
  status: 'active' | 'expired';
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: string;
  studentId: string;
  school: string;
  college: string;
  joinedAt: string;
}

export type PageView =
  | { name: 'home' }
  | { name: 'library'; category?: string }
  | { name: 'course'; courseId: string }
  | { name: 'reader'; paperId: string }
  | { name: 'cet' }
  | { name: 'cetlisten'; slug: string }
  | { name: 'cetpaper'; slug: string }
  | { name: 'membership' }
  | { name: 'profile' }
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'forgot' }
  | { name: 'privacy' }
  | { name: 'terms' }   // 会员服务条款（2026-10-30）
  | { name: 'mistakes' }   // 错题本（2026-10-25）
  | { name: 'admin' };

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  courseCount: number;
  paperCount: number;
}
