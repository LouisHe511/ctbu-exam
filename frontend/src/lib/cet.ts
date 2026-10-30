import { getToken } from '@/lib/api';

/**
 * 四六级听力：数据加载 + 受保护音频的签名换取
 *
 * 数据由 `备份/CET四六级/脚本/生成前端数据.py` 产出，放在 `public/cet/`：
 *   · `index.json`            等级 + 套卷清单（很小，首屏只加载它）
 *   · `{band}-{slug}.json`    单套完整数据（约 90KB，**用到才加载**）
 *
 * 为什么不整包给：24 套合并是 2MB，学生在同一套里做题不该下载另外 23 套。
 *
 * 音频为什么不能直接播：
 *   `/media/` 由 nginx `secure_link` 守着，没签名一律 403。
 *   播放前要先向 `/api/pay/sign-media` 换**带 md5+expires 的短效链接**，
 *   服务端在那里校验「这个用户有没有会员」——这就是"会员才能听"的落点。
 */

// ------------------------------------------------------------------ 数据类型
export interface CetPara {
  /** 段序（P1/P2…），与解析【定位】用的是同一套编号，别重编号 */
  seq: number;
  en: string;
  zh: string;
  /** 该段属于第几题（原文页的段号锚用得到） */
  ownerQ: number;
}

export interface CetPiece {
  /** 原站锚点，如 lt-1 */
  anchor: string;
  /** 该篇在音频里的起始秒（人耳切的时间轴，直接用） */
  seek: number;
  /** 篇题，如「Questions 1 and 2 are based on the news report…」 */
  title: string;
  paras: CetPara[];
}

export interface CetVerdict {
  letter: string;
  /** 错误类型（原站归一化的 7 类，如 张冠李戴 / 原词陷阱） */
  flag: string;
  reason: string;
  source: string;
  isBad: boolean;
}

export interface CetPair {
  orig: string;
  opt: string;
  why: string;
}

export interface CetQuestion {
  no: number;
  stemEn: string;
  transStem: string;
  /** A/B/C/D */
  answer: string;
  /** 题型，如 细节题 */
  qtype: string;
  correctEn: string;
  transChoices: Record<string, string>;
  locate: {
    /** P 药丸：{q, seq, label} —— 指向原文的那一段 */
    refs: { q: number; seq: number; label: string }[];
    en: string;
    zh: string;
  };
  signalCore: string;
  signalText: string;
  pairs: CetPair[];
  verdicts: CetVerdict[];
}

export interface CetSetFull {
  band: string;
  bandLabel: string;
  slug: string;
  label: string;
  /** 受保护路径，如 /media/cet4/xxx.mp3 */
  audio: string;
  /** 数据实际来自哪一套（「第 3 套」沿用姐妹套时会不同） */
  sourceSlug: string;
  isAlias: boolean;
  qCount: number;
  pieceCount: number;
  /** { "1": {A: "...", B: "..."}, ... } */
  options: Record<string, Record<string, string>>;
  pieces: CetPiece[];
  questions: CetQuestion[];
}

export interface CetIndexSet {
  slug: string;
  label: string;
  file: string;
  qCount: number;
  pieceCount: number;
  isAlias: boolean;
  sourceSlug: string;
  sizeKB: number;
}

export interface CetIndex {
  bands: Record<string, { label: string; sets: CetIndexSet[] }>;
}

export const CET_BANDS = ['cet4', 'cet6'] as const;
export type CetBandId = (typeof CET_BANDS)[number];

// -------------------------------------------------------------------- 加载
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

export function loadCetIndex(): Promise<CetIndex | null> {
  return getJSON<CetIndex>('/cet/index.json');
}

export function loadCetSet(file: string): Promise<CetSetFull | null> {
  return getJSON<CetSetFull>(`/cet/${file}`);
}

// ------------------------------------------------- 受保护音频的签名换取
export type SignMediaResult =
  | { ok: true; url: string; expires: number }
  | { ok: false; reason: string };

/**
 * 换取带签名的音频链接。
 * reason：not_logged_in / not_a_member / bad_path / not_found / network_error
 */
export async function signMedia(path: string): Promise<SignMediaResult> {
  try {
    // ⚠️ 必须带用户自己的 access token —— 服务端靠它认人（再查会员）。
    //    不带 token 服务端一律 401 not_logged_in，前端就会误显示"听力是会员内容"（踩过）
    const token = getToken();
    if (!token) return { ok: false, reason: 'not_logged_in' };

    const res = await fetch('/api/pay/sign-media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path }),
    });
    const data = (await res.json().catch(() => ({}))) as
      { ok?: boolean; url?: string; expires?: number; reason?: string };
    if (res.ok && data.ok && data.url) {
      return { ok: true, url: data.url, expires: data.expires ?? 0 };
    }
    return { ok: false, reason: data.reason ?? `http_${res.status}` };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

// ------------------------------------------------------------------ 小工具
/** 把秒格式化成 m:ss（与原站 `0:00 / 0:00` 一致） */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** 播放器需要的篇信息（只要起始秒 + 篇题） */
export interface PlayerPiece {
  anchor: string;
  label: string;
  start: number;
}

export function toPlayerPieces(set: CetSetFull): PlayerPiece[] {
  return set.pieces.map((p) => ({ anchor: p.anchor, label: p.title, start: p.seek }));
}

/** 当前播放到第几篇 */
export function pieceAt(pieces: PlayerPiece[], sec: number): number {
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (sec >= pieces[i].start - 0.35) return i;
  }
  return 0;
}

/**
 * 每一篇录音覆盖哪几道题。
 *
 * 为什么必须有这个：四六级听力**从来不是一题一段录音** ——
 * 一篇录音对应 2~5 道题（新闻 1–2 题、长对话 5–8 题、篇章 16–18 题…），
 * 学生是「听完一篇，连着答那几道题」。所以页面的最小单元是**篇**，不是题。
 *
 * 做法：用每篇首个段落的 `ownerQ` 当作该篇的起始题号，
 * 该篇的结束题号 = 下一篇起始题号 − 1（最后一篇到 qCount）。
 */
export interface PieceRange {
  from: number;
  to: number;
}

export function pieceRanges(set: CetSetFull): PieceRange[] {
  const starts: number[] = [];
  let last = 0;
  for (const pc of set.pieces) {
    // 防御：起始题号必须单调递增，否则说明数据有问题
    const raw = pc.paras[0]?.ownerQ ?? (last + 1);
    const s = Math.max(last + 1, raw);
    starts.push(s);
    last = s;
  }
  return starts.map((from, i) => ({
    from,
    to: i + 1 < starts.length ? Math.max(from, starts[i + 1] - 1) : set.qCount,
  }));
}

/** 某一道题属于第几篇 */
export function pieceOfQuestion(set: CetSetFull, qno: number): number {
  const rs = pieceRanges(set);
  for (let i = 0; i < rs.length; i++) {
    if (qno >= rs[i].from && qno <= rs[i].to) return i;
  }
  return Math.max(0, rs.length - 1);
}

/** 段落锚点 id（与解析【定位】的 href 一致，用于联动高亮） */
export function paraAnchor(ownerQ: number, seq: number): string {
  return `p-${ownerQ}-${seq}`;
}
