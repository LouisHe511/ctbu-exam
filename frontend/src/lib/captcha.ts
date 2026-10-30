/**
 * 人机验证（自建图形验证码）
 *
 * 为什么不用 Cloudflare Turnstile / 极验（2026-10-21 改成自建）：
 *   · Turnstile：国内加载实测 3.3 秒 / 87KB，且依赖 Cloudflare 账号 + site key + secret
 *   · 极验：要注册开发者账号拿 ID/KEY，还要自己写服务端二次校验
 *   · 自建：0 依赖 0 账号 0 成本，**答案只在服务端内存里**，前端拿到的只是一张 PNG
 *
 * 安全边界（如实告知后来者）：
 *   图形码可被 OCR，它挡的是「无脑脚本」，不是「有心的对手」。
 *   真正的防线是组合：图形码 + 邮箱验证码 + 服务端限流（见 pay-service/pay_service.py）。
 *   而且服务端**强制校验** —— 不传 captcha_id/captcha_code 的注册请求一律 400，
 *   所以绕过前端直接打 API 也没用。
 */

import { api, ApiError } from '@/lib/api';

export interface CaptchaChallenge {
  id: string;
  /** data:image/png;base64,... —— 直接塞进 <img src> */
  image: string;
  ttl: number;
  length: number;
}

/**
 * 向服务端要一张新验证码。
 * ⚠️ 必须带时间戳参数，否则浏览器会拿缓存的那张 —— 而它的答案在服务端已消费，
 *    用户输了也永远对不上（这是这类接口最常见的坑）。
 */
export async function fetchCaptcha(): Promise<CaptchaChallenge> {
  const r = await api<{
    ok: boolean; id: string; image: string; ttl: number; length: number;
    reason?: string; disabled?: boolean;
  }>(`/api/auth/captcha?t=${Date.now()}`, { auth: false, timeoutMs: 15_000 });
  if (!r.ok) throw new Error(r.reason || '验证码加载失败');
  return { id: r.id, image: r.image, ttl: r.ttl, length: r.length };
}

/** 发送邮箱验证码（注册 / 找回密码共用） */
export interface SendResult {
  ok: boolean;
  message: string;
  ttl?: number;
  /**
   * 失败原因（来自服务端 reason）。
   * ⚠️ 必须透出：调用方要区分「图形码答错（可原地重试）」和
   * 「图形码过期/作废（必须换图）」—— 前者刷新图片等于把用户填好的内容清掉。
   */
  reason?: string;
}

export async function sendEmailCode(
  email: string,
  captcha: { id: string; code: string },
): Promise<SendResult> {
  try {
    const r = await api<{ ok: boolean; message?: string; ttl?: number }>('/api/auth/email-code', {
      method: 'POST',
      auth: false,
      body: { email, captcha_id: captcha.id, captcha_code: captcha.code },
    });
    return { ok: true, message: r.message || '验证码已发送', ttl: r.ttl };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : '发送失败，请稍后重试',
      reason: e instanceof ApiError ? e.reason : undefined,
    };
  }
}


/** 发送短信验证码（手机号注册/登录/找回密码共用） */
export async function sendSmsCode(
  phone: string,
  captcha: { id: string; code: string },
): Promise<SendResult> {
  try {
    const r = await api<{ ok: boolean; message?: string; ttl?: number }>('/api/auth/sms-code', {
      method: 'POST',
      auth: false,
      body: { phone, captcha_id: captcha.id, captcha_code: captcha.code },
    });
    return { ok: true, message: r.message || '验证码已发送', ttl: r.ttl };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : '发送失败，请稍后重试',
      reason: e instanceof ApiError ? e.reason : undefined,
    };
  }
}
