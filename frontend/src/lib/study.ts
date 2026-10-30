/**
 * 学习痕迹：继续阅读（④）+ 错题本（③）的客户端。
 *
 * 后端：/api/data/progress、/api/data/mistakes（pay_service.py，2026-10-25）。
 * 全部静默失败 —— 这些是锦上添花的功能，任何网络问题都不该打断看卷子。
 */
import { api, apiMaybe, ApiError } from '@/lib/api';

export interface ReadingProgress {
  paper_id: string;
  page: number;
  which: 'paper' | 'answer';
  updated_at: string;
  course_name?: string | null;
  title?: string | null;
  year?: number | null;
}

export interface Mistake {
  id: number;
  paper_id: string;
  page: number;
  question: string;
  created_at: string;
  course_name?: string | null;
  title?: string | null;
  year?: number | null;
  solution_page?: number | null;
}

/** 保存阅读进度（防抖由调用方负责），未登录直接跳过 */
export async function saveProgress(paperId: string, page: number, which: 'paper' | 'answer' = 'paper'): Promise<void> {
  try {
    await apiMaybe('/api/data/progress', {
      method: 'POST',
      body: { paper_id: paperId, page, which },
    });
  } catch { /* 静默：进度丢了不影响使用 */ }
}

export async function fetchProgress(): Promise<ReadingProgress[]> {
  try {
    const r = await apiMaybe<{ progress?: ReadingProgress[] }>('/api/data/progress');
    return r?.progress ?? [];
  } catch {
    return [];
  }
}

export async function fetchMistakes(): Promise<{ mistakes: Mistake[]; isMember: boolean; freeLimit: number } | null> {
  try {
    const r = await apiMaybe<{ mistakes?: Mistake[]; is_member?: boolean; free_limit?: number }>(
      '/api/data/mistakes');
    if (!r) return null;
    return { mistakes: r.mistakes ?? [], isMember: !!r.is_member, freeLimit: r.free_limit ?? 10 };
  } catch {
    return null;
  }
}

export type AddMistakeResult =
  | { ok: true }
  | { ok: false; reason: 'limit' | 'error'; message?: string };

export async function addMistake(paperId: string, page: number, question: string): Promise<AddMistakeResult> {
  try {
    await api('/api/data/mistakes', {
      method: 'POST',
      body: { paper_id: paperId, page, question },
    });
    return { ok: true };
  } catch (e) {
    // apiMaybe 会把 403(mistake_limit) 也吞成 null，这里要区分「到上限」和「真失败」
    if (e instanceof ApiError && e.reason === 'mistake_limit') {
      return { ok: false, reason: 'limit', message: e.message };
    }
    return { ok: false, reason: 'error' };
  }
}

export async function removeMistake(id: number): Promise<void> {
  try {
    await apiMaybe('/api/data/mistakes/remove', { method: 'POST', body: { id } });
  } catch { /* 静默 */ }
}

/**
 * 错题本 → 阅读器的交接：错题本页写下「翻到第几页 + 替学生把问题填进 AI 面板」，
 * 阅读器挂载时消费一次。走 sessionStorage 而不是 URL，避免把用户内容拼进 hash。
 */
const HANDOFF_KEY = 'ctbu-mistake-handoff';

export interface ReaderHandoff { page: number; question: string | null; }

export function setReaderHandoff(paperId: string, h: ReaderHandoff): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ paperId, ...h }));
  } catch { /* 隐私模式等存不进去就算了 */ }
}

/** 读取并清掉交接信息（只在 paperId 匹配时生效，防止串卷） */
export function consumeReaderHandoff(paperId: string): ReaderHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    const d = JSON.parse(raw) as { paperId: string } & ReaderHandoff;
    return d.paperId === paperId ? { page: d.page, question: d.question ?? null } : null;
  } catch {
    return null;
  }
}
