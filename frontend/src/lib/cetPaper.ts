import { getToken } from '@/lib/api';
import { loadCetSet, type CetSetFull } from '@/lib/cet';

/**
 * 四六级「全卷交互」：题面 / 答案 / 解析 的加载层
 *
 * 数据分工（**三份数据、三种可见性**，别搞混）：
 *
 * | 文件 | 内容 | 谁可见 | 在哪 |
 * |---|---|---|---|
 * | `/cet/full/{slug}.json`        | 题面（题干、选项、原文、段落、词库） | 登录用户 | 随前端部署 |
 * | `/cet/full/{slug}.key.json`    | **只有答案字母**（判分用）          | 登录用户 | 随前端部署 |
 * | `/api/pay/cet-explain?slug=…`  | 逐题解析、写作范文、参考译文        | **仅会员** | 国内服务器 |
 *
 * 为什么答案字母要单独放一份公开文件：
 *   做题必须当场判对错，否则体验是断的；但解析文本是会员内容。
 *   所以把「答案字母」和「解析文本」拆开 —— 前者随前端走，后者走会员接口。
 *   （难点也在这：不能图省事把整份解析塞进 public/，那等于免费送。）
 */

// ------------------------------------------------------------------ 类型
export interface BankWord { letter: string; word: string }
export interface MatchingPara { letter: string; text: string }
export interface MatchingStmt { no: number; text: string }
export interface ReadingQuestion { no: number; stem: string; options: Record<string, string> }
export interface ReadingPassage {
  label: string;
  from: number | null;
  to: number | null;
  paras: string[];
  questions: ReadingQuestion[];
}

export interface PaperWriting {
  id: 'writing'; name: string; kind: 'subjective';
  minutes: number; directions: string; minWords: number | null; maxWords: number | null;
}
export interface PaperListening {
  id: 'listening'; name: string; kind: 'reuse';
  reuse?: string; qCount?: number; audio?: string;
}
export interface PaperBanked {
  id: 'banked'; name: string; kind: 'objective'; range: [number, number];
  paras: string[]; bank: BankWord[]; questionNos: number[];
}
export interface PaperMatching {
  id: 'matching'; name: string; kind: 'objective'; range: [number, number];
  paras: MatchingPara[]; statements: MatchingStmt[];
}
export interface PaperReading {
  id: 'reading'; name: string; kind: 'objective'; range: [number, number];
  passages: ReadingPassage[];
}
export interface PaperTranslation {
  id: 'translation'; name: string; kind: 'subjective';
  minutes: number; directions: string; prompt: string;
}
export type PaperSection =
  | PaperWriting | PaperListening | PaperBanked | PaperMatching | PaperReading | PaperTranslation;

export interface CetPaper {
  slug: string;
  band: string;
  sections: PaperSection[];
}

export interface ExplainBlock { k: string; v: string }
export interface ExplainItem {
  no: number;
  answer: string | null;
  head: string;
  zh: string;
  blocks: ExplainBlock[];
  word?: string;
  qtype?: string;
  optionsEn?: string[];
  /** 阅读题：中文题干（供页面「中文」开关用） */
  stemZh?: string;
  /** 阅读题：各选项中译，如 {A:'…', B:'…'} */
  optionsZh?: Record<string, string>;
}
export interface CetExplain {
  slug: string;
  answers: Record<string, string>;
  banked?: ExplainItem[];
  matching?: ExplainItem[];
  reading1?: ExplainItem[];
  reading2?: ExplainItem[];
  writing?: { model: string; modelZh: string; paras: ExplainBlock[] };
  translation?: { reference: string };
  /**
   * 「卷面」里英文段落对应的中文翻译（与题面的段落一一对应）。
   * banked = 选词填空短文；reading1 / reading2 = 仔细阅读两篇原文。
   * 供页面「中文」开关用，会员数据。
   */
  faceZh?: {
    banked?: string[];
    reading1?: string[];
    reading2?: string[];
  };
}

// ------------------------------------------------------------------ 加载
const CACHE = new Map<string, unknown>();

async function getJSON<T>(url: string): Promise<T | null> {
  if (CACHE.has(url)) return CACHE.get(url) as T;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    CACHE.set(url, data);
    return data;
  } catch {
    return null;
  }
}

export function loadCetPaper(slug: string): Promise<CetPaper | null> {
  return getJSON<CetPaper>(`/cet/full/${slug}.json`);
}

/** 判分用的答案字母表（公开，随前端走） */
export function loadCetAnswerKey(slug: string): Promise<Record<string, string> | null> {
  return getJSON<{ answers: Record<string, string> }>(`/cet/full/${slug}.key.json`)
    .then((d) => d?.answers ?? null);
}

/** 听力数据（复用听力页那一份，含原文/翻译/逐题解析/音频时间轴） */
export function loadCetListening(band: string, setSlug: string): Promise<CetSetFull | null> {
  return loadCetSet(`${band}-${setSlug}.json`);
}

export type ExplainResult =
  | { ok: true; data: CetExplain }
  | { ok: false; reason: 'not_logged_in' | 'not_a_member' | 'not_found' | 'network_error' | string };

/**
 * 拉取某套的解析（**会员专属**）。
 * 与 `signMedia()` 同款做法：必须带用户自己的 access token，
 * 服务端靠它认人；不带 token 会一律 401，前端就会误显示"需要会员"（听力那边踩过）。
 */
export async function loadCetExplain(slug: string): Promise<ExplainResult> {
  try {
    const token = getToken();
    if (!token) return { ok: false, reason: 'not_logged_in' };
    const res = await fetch(`/api/pay/cet-explain?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as CetExplain;
      if (data && data.answers) return { ok: true, data };
      return { ok: false, reason: 'bad_payload' };
    }
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: body.reason ?? `http_${res.status}` };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

// ------------------------------------------------------------------ 小工具
/** 客观题总量：听力 25 + 选词 10 + 匹配 10 + 仔细 10 = 55 */
export const OBJECTIVE_TOTAL = 55;

// ------------------------------------------------------------------ 下载
/**
 * 「原题」PDF 的直链。文件在服务器 `/var/www/ctbu-papers/`，nginx 用 `/papers/` 公开挂着
 * ——**不校验登录、不校验会员**（用户 2026-10-16 拍板：原题开源，谁都能下来做）。
 * 页面本身仍要求登录，但这条链接本身就是公开资源。
 */
export function cetPaperPdfUrl(fullSlug: string): string {
  return `/papers/${fullSlug}-paper.pdf`;
}

/** 保存到本地时用的文件名（`<a download>` 只在同源下生效，这里是同源） */
export function cetPaperPdfName(label: string): string {
  return `${label} · 四六级原题.pdf`;
}

export function cetSolutionPdfName(label: string): string {
  return `${label} · 原题与答案解析.pdf`;
}

export type SolutionUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_logged_in' | 'not_a_member' | 'not_found' | 'network_error' | string };

/**
 * 换「原题+答案解析」PDF 的签名直链（**会员专属**）。
 *
 * 做法与听力音频完全一致：带用户 token 向服务端要一个**短效签名链接**，
 * 服务端在那里校验会员；返回的链接由 nginx 的 secure_link 认签名后才给文件。
 * 为什么不直接把文件放 public/：那样谁拿到 URL 都能下，会员就白设了。
 */
export async function loadCetSolutionUrl(slug: string): Promise<SolutionUrlResult> {
  try {
    const token = getToken();
    if (!token) return { ok: false, reason: 'not_logged_in' };
    const res = await fetch(`/api/pay/cet-solution-url?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { ok?: boolean; url?: string };
      if (data?.url) return { ok: true, url: data.url };
      return { ok: false, reason: 'bad_payload' };
    }
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: body.reason ?? `http_${res.status}` };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

/** 解析块按题号索引，便于展开时 O(1) 取用 */
export function explainIndex(explain: CetExplain | null): Map<number, ExplainItem> {
  const map = new Map<number, ExplainItem>();
  if (!explain) return map;
  for (const key of ['banked', 'matching', 'reading1', 'reading2'] as const) {
    for (const it of explain[key] ?? []) map.set(it.no, it);
  }
  return map;
}
