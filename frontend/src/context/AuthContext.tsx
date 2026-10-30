import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { api, ApiError, getToken, setToken, AUTH_EXPIRED_EVENT } from '@/lib/api';
import { devicePayload } from '@/lib/device';
import type { Profile } from '@/types';

/**
 * 本地登录（2026-10-17 · 阶段 5）：不再依赖 Supabase Auth。
 *
 * 会话形状保持与旧代码兼容的最小集：`session.access_token` + `session.user.{id,email}`，
 * 页面里现有的 `session?.user?.email` / `session.access_token` 全部照常工作。
 */
export interface LocalUser {
  id: string;
  email: string | null;
  /** 手机号账号才有；邮箱注册的老账号为 null（2026-10-21 加手机号登录） */
  phone?: string | null;
  /**
   * 用户是否有一个"自己知道的密码"（2026-10-21）。
   * 手机号注册的账号在库里也有 password_hash —— 但那是服务端随机生成的，
   * 用户根本不知道，所以不能拿它判断"能不能用密码登录"。看这个标记。
   */
  password_set?: boolean;
}

export interface LocalSession {
  access_token: string;
  user: LocalUser;
}

/** 一台已登录设备（服务端 auth.sessions 聚合而来） */
export interface DeviceInfo {
  device_id: string;
  device_name: string;
  ip?: string;
  last_ip?: string;
  last_seen_at?: string;
  first_seen_at?: string;
  sessions?: number;
  current?: boolean;
}

/** 登录/注册结果：device_limit 时带上设备列表，让用户知道是哪两台在占位 */
export interface AuthResult {
  error: string | null;
  needsConfirm?: boolean;
  reason?: string;
  devices?: DeviceInfo[];
  maxDevices?: number;
  /** 本次登录后该账号共有几台设备在线（2026-10-20：第 2 台起登录页弹提醒） */
  deviceCount?: number;
  /** 该账号当前是否处于封禁状态（登录时带出，便于立即弹窗） */
  banned?: boolean;
  ban?: { level?: number; until?: string; reason?: string; permanent?: boolean };
  /** 累计违规次数（两类违规合并） */
  violations?: number;
  /** 手机号首次登录 = 服务端刚自动建号（2026-10-21：前端据此提示"已为你创建账号"） */
  isNew?: boolean;
}

/**
 * 人机验证 + 邮箱验证码的提交参数（2026-10-21）。
 *
 * 为什么集中成一个对象：signUp / signIn / resetPassword 三个入口都要带，
 * 以前是 4 个位置参数（`_captchaToken` 这种），越加越乱且容易漏传。
 *
 * ⚠️ 服务端**强制校验** captcha_id/captcha_code —— 之前这两个参数根本没往下传，
 *    等于前端做了个装饰品。现在漏传 = 请求直接 400，不可能"静默放行"。
 */
export interface AuthGuard {
  captchaId?: string;
  captchaCode?: string;
  /** 注册 / 找回密码需要的邮箱验证码 */
  emailCode?: string;
  /** 找回密码时的新密码 */
  newPassword?: string;
  /** 短信验证码（手机号登录 / 手机号注册 / 手机号重置） */
  smsCode?: string;
  /** 邀请码（手机号注册首次建号时生效） */
  inviteCode?: string;
}

interface AuthState {
  session: LocalSession | null;
  user: LocalUser | null;
  profile: Profile | null;
  isAdmin: boolean;
  loading: boolean;
  isPasswordRecovery: boolean;
  setIsPasswordRecovery: (v: boolean) => void;
  signUp: (email: string, password: string, inviteCode?: string, guard?: AuthGuard) => Promise<AuthResult>;
  signIn: (email: string, password: string, guard?: AuthGuard) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string, guard?: AuthGuard) => Promise<{ error: string | null }>;
  /** 手机号 + 短信验证码登录（首次自动注册） */
  signInWithPhone: (phone: string, smsCode: string, guard?: AuthGuard) => Promise<AuthResult>;
  /** 手机号 + 短信验证码重置密码（guard 里带图形码，2026-10-28 起服务端必填） */
  resetByPhone: (phone: string, smsCode: string, newPassword: string, guard?: AuthGuard) => Promise<{ error: string | null }>;
  /** 登录状态下修改密码（已设过密码的账号必须带 currentPassword） */
  updatePassword: (newPassword: string, currentPassword?: string) => Promise<{ error: string | null }>;
  updateProfile: (data: Partial<Pick<Profile, 'display_name' | 'student_id' | 'school' | 'college'>>) => Promise<{ error: string | null }>;
  refreshProfile: () => Promise<void>;
}

interface SessionResponse {
  ok: boolean;
  token?: string;
  user: LocalUser;
  profile: Profile | null;
  is_admin: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // 兼容字段：现在没有"邮件恢复会话"这条路（重置走人工），恒为 false
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  const apply = useCallback((r: SessionResponse) => {
    if (r.token) setToken(r.token);
    const tok = r.token ?? getToken();
    if (!tok || !r.user) return;
    setSession({ access_token: tok, user: r.user });
    setProfile(r.profile ?? null);
    setIsAdmin(!!r.is_admin);
  }, []);

  // 启动时：有 token 就换回登录态（过期/失效则静默清掉）
  useEffect(() => {
    let mounted = true;
    const tok = getToken();
    if (!tok) {
      setLoading(false);
      return () => { mounted = false; };
    }
    (async () => {
      try {
        const r = await api<SessionResponse>('/api/auth/session');
        if (!mounted) return;
        apply(r);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setToken(null);
        console.warn('[auth] 恢复登录态失败：', e instanceof Error ? e.message : e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [apply]);

  /**
   * 会话在使用过程中被吊销（2026-10-28）。
   *
   * 场景：改密码、在另一台设备把本机踢掉、或超过 90 天绝对上限。
   * 以前只有刷新页面才发现；期间页面照常显示"已登录"、数据静默变空。
   * 现在由 `api()` 在收到带 token 的 401 时广播事件，这里统一清干净。
   *
   * 只清本地状态，不强制跳转：用户可能正读到一半，
   * 让他自己点"登录"比突然被弹走更不吓人；页面上的需要登录的功能会自然提示。
   */
  useEffect(() => {
    const onExpired = () => {
      setToken(null);
      setSession(null);
      setProfile(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const signUp = useCallback(async (
    email: string, password: string, inviteCode?: string, guard?: AuthGuard,
  ): Promise<AuthResult> => {
    try {
      const r = await api<SessionResponse>('/api/auth/signup', {
        method: 'POST',
        auth: false,
        body: {
          email, password, invite_code: inviteCode ?? '',
          // 服务端强制校验这两个字段；漏传 → 400 captcha_missing，不会被静默放行
          captcha_id: guard?.captchaId ?? '',
          captcha_code: guard?.captchaCode ?? '',
          email_code: guard?.emailCode ?? '',
          ...devicePayload(),
        },
      });
      apply(r);
      // 本地注册即登录（无邮件确认环节），needsConfirm 恒为 false
      return { error: null, needsConfirm: false };
    } catch (e) {
      return {
        error: e instanceof ApiError ? e.message : '注册失败，请稍后重试',
        needsConfirm: false,
        reason: e instanceof ApiError ? e.reason : undefined,
      };
    }
  }, [apply]);

  const signIn = useCallback(async (email: string, password: string, guard?: AuthGuard): Promise<AuthResult> => {
    try {
      const r = await api<SessionResponse>('/api/auth/signin', {
        method: 'POST',
        auth: false,
        body: {
          // 2026-10-21：这个字段收邮箱**或**手机号，服务端按内容自己判断。
          // 手机号注册的账号 email 是 NULL，只按邮箱查会永远登不进去。
          account: email,
          password,
          captcha_id: guard?.captchaId ?? '',
          captcha_code: guard?.captchaCode ?? '',
          ...devicePayload(),
        },
      });
      apply(r);
      const meta = r as unknown as {
        device_count?: number; max_devices?: number;
        banned?: boolean; ban?: AuthResult['ban']; violations?: number;
      };
      return {
        error: null,
        deviceCount: meta.device_count,
        maxDevices: meta.max_devices,
        banned: meta.banned,
        ban: meta.ban,
        violations: meta.violations,
      };
    } catch (e) {
      if (e instanceof ApiError) {
        // 设备超限：把「哪几台在用」带给登录页，否则用户只会看到一句拒绝、无从下手
        const p = (e.payload ?? {}) as { devices?: DeviceInfo[]; max_devices?: number };
        return {
          error: e.message,
          reason: e.reason,
          devices: p.devices,
          maxDevices: p.max_devices,
        };
      }
      return { error: '登录失败，请稍后重试' };
    }
  }, [apply]);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/signout', { method: 'POST' });
    } catch {
      /* 即使服务端失败，本地也清干净 */
    }
    setToken(null);
    setSession(null);
    setProfile(null);
    setIsAdmin(false);
  }, []);

  /**
   * 找回密码（2026-10-21 起是**真正的自助重置**）：
   *   email + 邮箱验证码 + 新密码 → 服务端核验后改密并踢掉全部旧会话。
   * 没配 SMTP 时服务端仍会回 manual_required 的人工说明，这里原样透出。
   */
  const resetPassword = useCallback(async (email: string, guard?: AuthGuard) => {
    try {
      await api('/api/auth/reset-request', {
        method: 'POST',
        auth: false,
        body: {
          email,
          email_code: guard?.emailCode ?? '',
          new_password: guard?.newPassword ?? '',
          // 2026-10-28：服务端现在要求过图形码（否则谁都能对别人的邮箱刷错码，
          // 把受害者刚收到的验证码打成"作废"）。没带就会被 400 拦下。
          captcha_id: guard?.captchaId ?? '',
          captcha_code: guard?.captchaCode ?? '',
        },
      });
      return { error: null };
    } catch (e) {
      return { error: e instanceof ApiError ? e.message : '请求失败，请稍后重试' };
    }
  }, []);

  /**
   * 手机号 + 短信验证码登录（**首次自动建号**）。
   *
   * 2026-10-21 起也承担"手机号注册"：注册页选了手机号，走的还是这条接口。
   * 服务端回 `is_new=true` 就说明这个号码是第一次来、账号是刚刚建的 ——
   * 前端据此显示"已为你创建账号"，别让学生以为自己进了别人的账号。
   */
  const signInWithPhone = useCallback(async (
    phone: string, smsCode: string, guard?: AuthGuard,
  ): Promise<AuthResult> => {
    try {
      const r = await api<SessionResponse>('/api/auth/sms-login', {
        method: 'POST',
        auth: false,
        body: {
          phone, sms_code: smsCode,
          captcha_id: guard?.captchaId ?? '',
          captcha_code: guard?.captchaCode ?? '',
          // 注册页填的邀请码。只有首次建号时服务端才会用上，老账号登录时被忽略。
          ...(guard?.inviteCode ? { invite_code: guard.inviteCode } : {}),
          ...devicePayload(),
        },
      });
      apply(r);
      const meta = r as unknown as { is_new?: boolean; device_count?: number };
      return { error: null, deviceCount: meta.device_count, isNew: meta.is_new };
    } catch (e) {
      if (e instanceof ApiError) {
        const p = (e.payload ?? {}) as { devices?: DeviceInfo[]; max_devices?: number };
        return { error: e.message, reason: e.reason, devices: p.devices, maxDevices: p.max_devices };
      }
      return { error: '登录失败，请稍后重试' };
    }
  }, [apply]);

  /** 手机号 + 短信验证码重置密码 */
  const resetByPhone = useCallback(async (
    phone: string, smsCode: string, newPassword: string, guard?: AuthGuard,
  ) => {
    try {
      await api('/api/auth/reset-by-phone', {
        method: 'POST',
        auth: false,
        body: {
          phone, sms_code: smsCode, new_password: newPassword,
          // 同上：服务端 2026-10-28 起要求图形码
          captcha_id: guard?.captchaId ?? '',
          captcha_code: guard?.captchaCode ?? '',
        },
      });
      return { error: null };
    } catch (e) {
      return { error: e instanceof ApiError ? e.message : '重置失败，请稍后重试' };
    }
  }, []);

  /**
   * 改密码（已登录）。
   *
   * 2026-10-28：服务端要求带 `current_password`（已设过密码的账号）。
   * 原来只凭 token 就能改密并把其它设备踢下线 —— token 存在 localStorage，
   * 一次 XSS 或一台没退出的公用电脑就等于永久接管账号。
   */
  const updatePassword = useCallback(async (newPassword: string, currentPassword?: string) => {
    if (newPassword.length < 8) return { error: '密码至少 8 位' };
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { new_password: newPassword, current_password: currentPassword ?? '' },
      });
      return { error: null };
    } catch (e) {
      return { error: e instanceof ApiError ? e.message : '修改失败，请稍后重试' };
    }
  }, []);

  const updateProfile = useCallback(
    async (data: Partial<Pick<Profile, 'display_name' | 'student_id' | 'school' | 'college'>>) => {
      if (!session?.user) return { error: '未登录' };
      try {
        const r = await api<{ profile: Profile }>('/api/data/profile', {
          method: 'POST',
          body: data,
        });
        setProfile(r.profile ?? null);
        return { error: null };
      } catch (e) {
        return { error: e instanceof ApiError ? e.message : '保存失败，请稍后重试' };
      }
    },
    [session],
  );

  const refreshProfile = useCallback(async () => {
    if (!session?.user) return;
    try {
      const r = await api<{ profile: Profile }>('/api/data/profile');
      setProfile(r.profile ?? null);
    } catch {
      /* 静默 */
    }
  }, [session]);

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        isAdmin,
        loading,
        isPasswordRecovery,
        setIsPasswordRecovery,
        signUp,
        signIn,
        signOut,
        resetPassword,
        signInWithPhone,
        resetByPhone,
        updatePassword,
        updateProfile,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
