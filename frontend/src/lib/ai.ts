/**
 * AI 学习助手客户端（2026-10-25）
 *
 * 后端 POST /api/ai/ask 返回的是 NDJSON 流（一行一个事件），
 * 不能走 lib/api.ts 的「等整个 JSON」模式 —— 学生要看到逐字输出。
 * 事件协议（与 pay-service/ai.py 的 _line 一一对应）：
 *   {t:"meta",  mode, remaining, quota}
 *   {t:"queue", pos}              排队中，前面还有 pos 人
 *   {t:"delta", c}                一小段回答文本
 *   {t:"done",  ms, tokens, remaining}
 *   {t:"error", reason, message}
 *
 * 鉴权失败/超额等「还没开始流」的错误是普通 JSON + 4xx 状态码，
 * 两种形态都要接住。
 */

import { getToken } from './api';

export type AiEvent =
  | { t: 'meta'; mode: 'cached' | 'vision'; trial?: boolean; remaining?: number; quota?: number }
  | { t: 'queue'; pos: number }
  | { t: 'delta'; c: string }
  | { t: 'done'; ms: number; tokens: number; trial_used?: boolean; remaining?: number }
  | { t: 'error'; reason: string; message?: string };

export interface AiAskInput {
  paperId: string;
  page: number;
  which: 'paper' | 'answer';
  question: string;
  /** 最近几轮对话（服务端最多取 4 条）；短答疑场景，不是长对话 */
  history: { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
  onEvent: (ev: AiEvent) => void;
}

/** 非流式错误（4xx + JSON）统一抛成 Error，reason 挂在字段上 */
export class AiAskError extends Error {
  reason: string;
  payload?: { quota?: number; used?: number };
  constructor(reason: string, message: string, payload?: { quota?: number; used?: number }) {
    super(message);
    this.reason = reason;
    this.payload = payload;
  }
}

export async function askAi(input: AiAskInput): Promise<void> {
  const token = getToken();
  const res = await fetch('/api/ai/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      paper_id: input.paperId,
      page: input.page,
      which: input.which,
      question: input.question,
      history: input.history,
    }),
    signal: input.signal,
  });

  if (!res.ok || !res.body) {
    // 还没进流的失败：普通 JSON（not_logged_in / quota_exhausted / no_access…）
    let data: { reason?: string; message?: string; quota?: number; used?: number } | null = null;
    try { data = await res.json(); } catch { /* 非 JSON */ }
    throw new AiAskError(
      data?.reason ?? `http_${res.status}`,
      data?.message ?? '请求失败，请稍后再试',
      data ?? undefined,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        input.onEvent(JSON.parse(line) as AiEvent);
      } catch {
        /* 半行/坏行：丢弃，等下一行 */
      }
    }
  }
}

export interface AiQuota {
  /** 能不能用（会员有每日额度；非会员首次为试用 true；试用已用完为 false） */
  allowed: boolean;
  member: boolean;
  /** 非会员：本次是免费试用（共 1 次） */
  trial?: boolean;
  /** 每日额度 / 剩余（会员档位） */
  quota?: number;
  remaining?: number;
  message?: string;
}

/** 面板打开时先问一次「能不能用 / 剩多少」；失败返回 null（不打扰） */
export async function fetchAiQuota(): Promise<AiQuota | null> {
  const token = getToken();
  try {
    const res = await fetch('/api/ai/quota', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { ok: boolean } & AiQuota;
    return d.ok ? d : null;
  } catch {
    return null;
  }
}
