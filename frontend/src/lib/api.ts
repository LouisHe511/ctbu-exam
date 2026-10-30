/**
 * 本地 API 客户端（2026-10-17 · 阶段 5）
 *
 * 全站数据与登录接口都走国内服务器（同域 /api/*），**不再直连 Supabase**。
 * 会话 token 存 localStorage，随请求带 Bearer；服务端只认自己的会话表。
 */

const TOKEN_KEY = 'ctbu_session_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐身模式等场景下存取失败：不影响功能，只是刷新后要重新登录 */
  }
}

export class ApiError extends Error {
  reason: string;
  status: number;
  constructor(message: string, reason = 'unknown', status = 0, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.reason = reason;
    this.status = status;
    this.payload = payload;
  }

  /** 服务端返回的完整响应体（如 device_limit 里的设备列表） */
  payload?: unknown;
}

interface FetchOpts {
  method?: string;
  /** JSON 对象（自动序列化 + 设置 Content-Type） */
  body?: unknown;
  /** FormData（上传用，自动跳过 Content-Type 以便浏览器补 boundary） */
  form?: FormData;
  /** 是否附带登录 token，默认 true（有则带） */
  auth?: boolean;
  timeoutMs?: number;
}

/**
 * 全局「会话失效」事件（2026-10-28）。
 *
 * 为什么需要：会话被服务端吊销（改密码、被踢设备、超过 90 天绝对上限）之后，
 * 以前前端毫无察觉 —— Header 还显示头像、收藏/记录静默变空、所有 apiMaybe 返回 null，
 * 用户看到的是"网站坏了"，而不是"请重新登录"。
 *
 * 这里只负责广播，不直接跳转：由 AuthContext 决定是清 token 还是弹提示，
 * 避免数据层和路由层互相耦合。
 */
export const AUTH_EXPIRED_EVENT = 'ctbu:auth-expired';

function emitAuthExpired(): void {
  try {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  } catch {
    /* SSR / 老浏览器：忽略 */
  }
}

/** 发一个 API 请求；HTTP 失败或业务 ok:false 都抛 ApiError */
export async function api<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'GET', body, form, auth = true, timeoutMs = 25_000 } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError('网络异常，请检查网络后重试', 'network_error', 0);
  } finally {
    window.clearTimeout(timer);
  }
  let data: { ok?: boolean; reason?: string; message?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || (data && data.ok === false)) {
    const reason = data?.reason ?? `http_${res.status}`;
    const message = data?.message ?? defaultMessage(reason);
    // 带了 token 却被判未登录 = 会话真的失效了（不是"从来没登录过"）
    if (res.status === 401 && auth && getToken()) emitAuthExpired();
    // 带上原始 payload：device_limit 要在登录页列出「哪些设备正在用」
    throw new ApiError(message, reason, res.status, data);
  }
  // 200 + 空/非 JSON 响应（nginx 错误页、204）不能当成功返回 null，
  // 否则调用方 `r.papers` 直接 TypeError，错误被吞成"加载失败"。
  if (data === null) {
    throw new ApiError('响应格式异常，请稍后重试', 'bad_response', res.status);
  }
  return data as T;
}

/** 宽容版：任何失败都返回 null（"失败不打扰用户"的场景用） */
export async function apiMaybe<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T | null> {
  try {
    return await api<T>(path, opts);
  } catch {
    return null;
  }
}

/**
 * supabase.rpc 的等价物：返回 { data, error } 形状，让调用点少改代码。
 * error 只带 message（与 supabase 的用法对齐）；业务失败（如额度用完）属于 data 内容，不是 error。
 */
export async function apiRpc<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  try {
    const r = await api<{ ok: true; data: T }>('/api/data/rpc', {
      method: 'POST',
      body: { fn, args: args ?? {} },
    });
    return { data: (r.data ?? null) as T | null, error: null };
  } catch (e) {
    const message = e instanceof ApiError ? e.message : '请求失败';
    return { data: null, error: { message } };
  }
}

function defaultMessage(reason: string): string {
  switch (reason) {
    case 'not_logged_in':
      return '请先登录';
    case 'bad_credentials':
      return '邮箱或密码不正确';
    case 'quota_exceeded':
      return '免费额度已用完';
    case 'email_taken':
      return '这个邮箱已经注册过了，直接登录即可';
    default:
      return '请求失败，请稍后重试';
  }
}
