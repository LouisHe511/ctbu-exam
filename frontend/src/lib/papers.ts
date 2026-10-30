import { api, apiRpc } from '@/lib/api';
import { getCachedPdf, setCachedPdf, clearPdfCache } from '@/lib/pdfCache';
import type { ExamPaper, PaperRow, AccessStatus } from '@/types';

/** 数据库行 → 前端模型 */
export function paperRowToModel(row: PaperRow): ExamPaper {
  const hasSolution = row.has_solution === true;
  const tags: string[] = [];
  if (row.has_answer) tags.push('含答案');
  if (hasSolution) tags.push('含解析');
  // 「最新」只在**确实有年份**且就是今年时才打；
  // 否则年份为空的卷子会因为下面的回退而被误标成「最新」（2026-10-16 修）
  if (row.year !== null && row.year === new Date().getFullYear()) tags.push('最新');

  return {
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    title: row.title?.trim() || undefined,
    paperKind: (row.paper_kind === '模拟' || row.paper_kind === '习题') ? row.paper_kind : (row.paper_kind === '真题' ? '真题' : undefined),
    category: row.category,
    // 不再用当前年份回退：原件没有学年信息时保持 null，界面就不显示年份这一段
    //（2026-10-18 起不再写「年份待确认」占位，直接省略）
    year: row.year,
    // 空字符串 → null：原卷没写学期就不显示，不自作主张填「秋季」（2026-10-16 修）
    semester: (row.semester || null) as ExamPaper['semester'],
    examType: (row.exam_type || '期末') as ExamPaper['examType'],
    hasAnswer: row.has_answer,
    hasSolution,
    solutionPage: row.solution_page ?? undefined,
    pages: row.page_count || 1,
    views: row.view_count || 0,
    uploadedAt: (row.created_at || '').slice(0, 10),
    tags,
    filePath: row.file_path || undefined,
    answerPath: row.answer_path || undefined,
    sourceType: row.source_type || 'recall',
    resourceType: row.resource_type === 'study_guide' ? 'study_guide' : 'exam',
    sourceSchool: row.source_school || undefined,
    visibility: row.visibility === 'login' ? 'login' : 'public',
    description: row.description || '',
    isReal: true,
  };
}

/**
 * 取已发布的试卷。
 * 匿名 → 只有公开的；登录 → 含 visibility='login' 的（服务端按会话过滤，字段与原来一致）。
 */
export async function fetchPublishedPapers(): Promise<ExamPaper[]> {
  const b = await fetchPapersBundle();
  return b.papers;
}

/** 试卷列表 + 「登录可见」统计（匿名时服务端只给数量，不给内容） */
export interface PapersBundle {
  papers: ExamPaper[];
  /** 每门课还有多少套是登录后才能看的（匿名时有值；登录后为空） */
  loginOnlyByCourse: Record<string, number>;
  loginOnlyTotal: number;
  /**
   * 全库总份数 / 含答案份数（2026-10-20）。
   * 匿名时服务端额外下发**数字**，用于首页展示真实规模
   * （否则只报 public 行，会比真实少三分之一）。
   * 登录后服务端不下发（本地 papers 已含全部），此时用本地长度即可。
   */
  totalPapers?: number;
  totalWithAnswer?: number;
}

/**
 * 2026-10-21：请求去重。
 *
 * <head> 的预取脚本和 PapersContext 挂载时都会打 `/api/data/papers`，
 * 两次请求内容完全一样 —— 白白多传 40KB、多占一个连接。
 * 这里做「同一次调用共享同一个 Promise」：预取先发起，context 跟进时直接复用；
 * 反之亦然。请求结束 2 秒后释放，避免后续刷新永远拿到旧数据。
 */
let inflight: Promise<PapersBundle> | null = null;
let inflightAt = 0;
const INFLIGHT_TTL = 2000;

export async function fetchPapersBundle(): Promise<PapersBundle> {
  const now = Date.now();
  if (inflight && now - inflightAt < INFLIGHT_TTL) return inflight;
  inflightAt = now;
  inflight = doFetchPapersBundle();
  // 结束后留 2 秒窗口给第二个调用者复用；超时清空
  inflight.finally(() => {
    window.setTimeout(() => {
      if (Date.now() - inflightAt >= INFLIGHT_TTL) inflight = null;
    }, INFLIGHT_TTL);
  });
  return inflight;
}

async function doFetchPapersBundle(): Promise<PapersBundle> {
  try {
    const r = await api<{
      papers: PaperRow[];
      login_only_by_course?: Record<string, number>;
      login_only_total?: number;
      total_papers?: number;
      total_with_answer?: number;
    }>('/api/data/papers');
    return {
      papers: (r.papers ?? []).map(paperRowToModel),
      loginOnlyByCourse: r.login_only_by_course ?? {},
      loginOnlyTotal: r.login_only_total ?? 0,
      totalPapers: r.total_papers,
      totalWithAnswer: r.total_with_answer,
    };
  } catch (e) {
    // 网络异常时不要炸掉页面，退化成空列表
    console.warn('[papers] 读取失败：', e instanceof Error ? e.message : e);
    return { papers: [], loginOnlyByCourse: {}, loginOnlyTotal: 0 };
  }
}

/** 管理员视角：连草稿一起取 */
export async function fetchAllPapersForAdmin(): Promise<ExamPaper[]> {
  try {
    const r = await api<{ papers: PaperRow[] }>('/api/data/papers?scope=all');
    return (r.papers ?? []).map(paperRowToModel);
  } catch (e) {
    console.warn('[papers] 管理员读取失败：', e instanceof Error ? e.message : e);
    return [];
  }
}

/** 这份试卷是否会消耗免费额度（外校参考真题不消耗） */
export function consumesQuota(paper: ExamPaper): boolean {
  if (!paper.isReal || paper.sourceSchool || paper.sourceType === 'external') return false;
  return paper.resourceType !== 'study_guide';
}

/**
 * 给 Promise 加超时。
 *
 * 弱网（尤其手机流量）下请求可能长时间挂住不返回；
 * 没有超时的话界面会永远转圈、既不报错也不给提示。加上超时后至少能给出可重试的错误。
 */
export function withTimeout<T>(p: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 下载私有文件字节到内存，供 PDF.js 逐页绘制到 canvas。
 * 不生成 / 不向页面返回可复制的 signed URL 或原生 PDF 链接。
 *
 * 2026-10-17 起：全部 PDF 已在国内服务器，走 `localUrl`（服务端签发的短效链接）；
 * 同一浏览会话内重复查看同一份时会直接命中内存缓存，不再重复下载。
 */
export async function getPrivatePdfBytes(
  filePath: string,
  timeoutMs = 90_000,
  localUrl?: string | null,
): Promise<Uint8Array> {
  if (!filePath) throw new Error('这份试卷没有 PDF 文件');

  const cached = getCachedPdf(filePath);
  if (cached) return cached;

  if (!localUrl) {
    throw new Error('这份试卷暂时没有拿到文件链接，请刷新重试。');
  }

  const res = await withTimeout(fetch(localUrl), timeoutMs, '读取试卷超时，请检查网络后重试。');
  if (!res.ok) {
    throw new Error(`读取试卷失败（HTTP ${res.status}），请刷新重试。`);
  }
  const bytes = await withTimeout(
    res.arrayBuffer().then((buf) => new Uint8Array(buf)),
    timeoutMs,
    '下载试卷内容超时，请重试。',
  );
  if (!bytes.byteLength) throw new Error('文件内容为空，请刷新重试。');
  setCachedPdf(filePath, bytes);
  return bytes;
}

export interface NewPaperInput {
  file: File;
  courseId: string;
  courseName: string;
  category: string;
  year: number | null;
  semester: string;
  examType: string;
  sourceType: string;
  resourceType?: 'exam' | 'study_guide';
  sourceSchool?: string;
  /** 默认 'login'：新采集的资料一律先只给登录用户看，避免把学校平台资料摊在公网 */
  visibility?: 'public' | 'login';
  hasAnswer: boolean;
  hasSolution: boolean;
  solutionPage: number | null;
  pageCount: number;
  description: string;
  /**
   * 可选的**独立答案 PDF**（2026-10-16 新增）。
   * 传了就与试卷文件配对入库（写进 `papers.answer_path`），阅读器会多出一个「查看答案」入口。
   * 不传则退化成老行为：答案要么没有，要么并进 `file` 里靠 `solutionPage` 跳转。
   */
  answerFile?: File | null;
}

/** 上传 PDF 并写入 papers 表（管理员；走本地服务 multipart，落盘到 /var/lib/ctbu-pdfs/） */
export async function uploadPaper(input: NewPaperInput): Promise<ExamPaper> {
  const fd = new FormData();
  fd.append('file', input.file, input.file.name);
  if (input.answerFile) {
    fd.append('answer_file', input.answerFile, input.answerFile.name);
  }
  fd.append('meta', JSON.stringify({
    course_id: input.courseId,
    course_name: input.courseName,
    category: input.category,
    year: input.year,
    semester: input.semester,
    exam_type: input.examType,
    source_type: input.sourceType,
    resource_type: input.resourceType ?? 'exam',
    source_school: input.sourceSchool ?? null,
    has_answer: input.hasAnswer,
    has_solution: input.hasSolution,
    solution_page: input.solutionPage,
    page_count: input.pageCount,
    description: input.description,
    visibility: input.visibility ?? 'login',
  }));
  const r = await api<{ paper: PaperRow }>('/api/data/admin/upload', {
    method: 'POST',
    form: fd,
    timeoutMs: 300_000,
  });
  if (!r.paper) throw new Error('上传失败：服务器没有返回记录');
  return paperRowToModel(r.paper);
}

/** 删除试卷（连同服务器上的文件与关联记录） */
export async function deletePaper(paper: ExamPaper): Promise<void> {
  await api('/api/data/admin/delete', { method: 'POST', body: { id: paper.id } });
  clearPdfCache();
}

/** 浏览计数 +1（失败不阻塞阅读） */
export async function incrementPaperView(paperId: string): Promise<void> {
  const { error } = await apiRpc('increment_paper_view', { p_paper_id: paperId });
  if (error) console.warn('[papers] 浏览计数失败：', error.message);
}

/** 查询当前用户的免费额度 / 会员状态（不消耗额度） */
export async function myAccessStatus(freeLimit = 3): Promise<AccessStatus | null> {
  const { data, error } = await apiRpc<AccessStatus>('my_access_status', { p_free_limit: freeLimit });
  if (error) {
    console.warn('[access] 查询失败：', error.message);
    return null;
  }
  return (data as AccessStatus) ?? null;
}

export type UnlockReason =
  | 'free'
  | 'member'
  | 'already_unlocked'
  | 'quota_exceeded'
  | 'not_logged_in';

export interface UnlockResult {
  ok: boolean;
  reason: UnlockReason;
  free_remaining: number;
}

/**
 * 尝试解锁一份试卷（服务端强制校验免费额度）。
 *
 * 注意：额度用完是**正常返回**（ok:false, reason:'quota_exceeded'），不是 error。
 * 所以这里遇到 error 一律抛出，让调用方显示"可重试的错误"，
 * 而不是把它误判成"未登录"或"额度用完"而错误地弹出付费墙。
 */
export async function unlockPaper(
  paperId: string,
  freeLimit = 3,
): Promise<UnlockResult> {
  const { data, error } = await apiRpc<UnlockResult>('unlock_paper', {
    p_paper_id: paperId,
    p_free_limit: freeLimit,
  });
  if (error) throw new Error(`校验查看权限失败：${error.message}`);
  return data as UnlockResult;
}

/**
 * 登录可见的资料份数。
 *
 * 匿名用户查不到 visibility='login' 的行，但需要让他们知道
 * "还有多少资料登录后才有"，所以服务端只暴露一个数字（匿名也可调）。
 */
export async function fetchLoginOnlyCount(): Promise<number> {
  const { data, error } = await apiRpc<number>('count_login_only_papers');
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

/**
 * 题库总份数（匿名可见 + 仅登录可见）。
 *
 * 2026-10-20 用户要求：「整个真题库都需要登陆后才能试用三次」——
 * 所以对匿名访客要展示**全库数量**，而不是只报"还有 N 份登录可见"
 * （那样看起来像站里一半是公开的，与真实规则不符）。
 *
 * 数据来源就是列表接口本身的两个计数，**随题库更新自动刷新**，不写死。
 */
export async function fetchLibraryTotals(): Promise<{ total: number; loginOnly: number }> {
  const b = await fetchPapersBundle();
  return {
    total: b.papers.length + b.loginOnlyTotal,
    loginOnly: b.loginOnlyTotal,
  };
}
