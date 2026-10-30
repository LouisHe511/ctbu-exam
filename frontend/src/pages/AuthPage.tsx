import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { SecondDeviceNotice } from '@/components/SecondDeviceNotice';
import { Captcha } from '@/components/Captcha';
import { ThemeToggle } from '@/components/ThemeToggle';
import { sendEmailCode, sendSmsCode } from '@/lib/captcha';
import { usePapers } from '@/context/PapersContext';
import { countByCourse } from '@/lib/counts';
import { courses } from '@/data/courses';
import { formatLastSeen } from '@/lib/device';
import { Mail, Lock, User, ArrowLeft, AlertCircle, CheckCircle, Loader2, Smartphone } from 'lucide-react';

type AuthMode = 'login' | 'register' | 'forgot';

/**
 * 同一条路两种凭据：邮箱 或 手机号。
 *
 * 2026-10-21 第二次改动（用户要求）：**注册页也要能选手机号**。
 * 三个入口现在长一样 —— 登录 / 注册 / 找回密码，都能在「邮箱」和「手机号」之间切：
 *   · 邮箱注册 = 邮箱 + 邮箱验证码 + 密码（老流程）
 *   · 手机号注册 = 手机号 + 短信验证码 → **服务端首次自动建号**，不用设密码
 * 手机号注册没有独立的注册接口：它和「手机号登录」是同一条路，
 * 区别只在服务端回的 `is_new` —— 前端据此说清楚"账号是刚给你建的"。
 */
type Credential = 'email' | 'phone';

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { signIn, signUp, resetPassword, signInWithPhone, resetByPhone } = useAuth();
  const { navigate } = useApp();
  /**
   * 左侧叙事栏的三个数字。
   * 2026-10-21：原来这里是**写死的 104 / 15 / 81**，实际早就 121 / 22 / 90 了——
   * 学生看到的数字和首页对不上，一看就知道是假数据。改成和首页同源实时计算。
   */
  const { papers, totalPapers: allPapers, totalWithAnswer } = usePapers();
  const courseCounts = useMemo(() => countByCourse(papers), [papers]);
  const statPapers = allPapers || papers.length;
  const statCourses = useMemo(
    () => courses.filter((c) => (courseCounts.get(c.id)?.total ?? 0) > 0).length,
    [courseCounts],
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // 从 #/register?ref=XXXX 里取邀请码（别人分享的链接会带这个）
  const [inviteCode, setInviteCode] = useState(() => {
    const m = window.location.hash.match(/[?&]ref=([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : '';
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /**
   * 手机号首次登录 = 服务端刚自动建号。
   * 存下号码，好显示"已用 191****4417 为你创建账号"。
   * 显示完点一下再进首页 —— 不给这一下，学生根本不知道自己已经被注册了。
   */
  const [createdPhone, setCreatedPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // ---- 人机验证 + 邮箱验证码（2026-10-21）----
  // captcha 是**一次性**的：服务端校验过就删，所以每次提交（无论成败）都要换一张，
  // 用 captchaNonce 递增来触发 Captcha 组件重新拉图。
  const [captcha, setCaptcha] = useState({ id: '', code: '' });
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [emailCode, setEmailCode] = useState('');
  // 找回密码（forgot）现在是真的自助重置：验证码 + 新密码一起提交
  const [newPassword, setNewPassword] = useState('');
  // 手机号通道
  const [credential, setCredential] = useState<Credential>('email');
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsSending, setSmsSending] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [smsHint, setSmsHint] = useState<string | null>(null);
  /**
   * **发送短信验证码这一步专属**的错误（2026-10-27）。
   *
   * 为什么不复用全局 `error`：那个提示栏在表单最上方，而"没填图形验证码"这种错
   * 恰恰发生在页面下方的「发送验证码」按钮旁边 —— 用户点完按钮，眼睛还在那一行，
   * 提示却跑到屏幕顶上，很容易完全没看见（用户实测反馈）。
   *
   * 所以这条错误紧贴按钮下方、一行红色小字显示。
   * 全局 `error` 继续管"提交表单"这类整体性错误的显示。
   */
  const [smsError, setSmsError] = useState<string | null>(null);
  /**
   * 手机号通道的两种登录方式（2026-10-21 用户要求）：
   *   code     = 收短信验证码登录（老流程，第一次用手机号也是走这条自动建号）
   *   password = 手机号 + 密码登录（需要先在个人中心设过密码）
   */
  const [phoneMode, setPhoneMode] = useState<'code' | 'password'>('code');
  const [codeSending, setCodeSending] = useState(false);
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [codeHint, setCodeHint] = useState<string | null>(null);
  /** 设备超限时，服务端告诉我们的「正在占名额的设备」 */
  // 2026-10-20：第 2 台设备登录时提醒「最多 2 台设备」
  const [secondDevice, setSecondDevice] = useState(false);
  const [lockedDevices, setLockedDevices] = useState<{ device_name?: string; last_seen_at?: string }[]>([]);
  const [lockedMax, setLockedMax] = useState(2);

  useEffect(() => {
    setError(null);
    setSuccess(null);
    setEmailCode('');
    setCodeHint(null);
    setCodeCountdown(0);
    setSmsCode('');
    setSmsHint(null);
    setSmsCountdown(0);
    setCreatedPhone(null);
    // 2026-10-21：注册也支持手机号了，切模式时不再强制回到邮箱
    setCredential((c) => c)
    setCaptcha({ id: '', code: '' });
    setCaptchaNonce((n) => n + 1);   // 切页面换一张新验证码（旧的已随提交/超时失效）
  }, [mode]);

  // 发送验证码倒计时（邮箱）
  useEffect(() => {
    if (codeCountdown <= 0) return;
    const t = setTimeout(() => setCodeCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [codeCountdown]);

  // 发送验证码倒计时（短信）
  useEffect(() => {
    if (smsCountdown <= 0) return;
    const t = setTimeout(() => setSmsCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [smsCountdown]);

  /**
   * 发短信验证码。
   * 注意：**手机号不能用来注册**（注册仍走邮箱），这里只服务「登录」和「找回密码」。
   */
  const handleSendSms = async () => {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      setSmsError('请先填写正确的 11 位手机号');
      return;
    }
    setSmsSending(true);
    setSmsError(null);   // 只清自己这一行，不动全局错误
    setSmsHint(null);
    const r = await sendSmsCode(phone, { id: captcha.id, code: captcha.code });
    setSmsSending(false);
    if (r.ok) {
      setSmsCountdown(60);
      setSmsHint(r.message);
      // ❌ 这里以前会 `setCaptchaNonce(n+1)` 刷新图形码 —— 那是**错的**。
      // 后端 `auth_send_sms_code` 用的是 `_verify_captcha_required(body, keep=True)`：
      // 发码这一步**不消费**图形码，所以这张码在提交登录时仍然有效。
      // 前端一刷新，用户刚填的字符被清空、还要重看一次图 —— 纯属自找麻烦
      // （2026-10-21 用户明确反馈："点了发验证码过后不要再刷新"）。
    } else {
      setSmsError(r.message);
      // ⚠️ 只有「过期 / 错太多次」才换图。**答错（mismatch）不换** ——
      // 服务端还保留着这张码（最多允许错 3 次），刷新等于把用户刚填的清掉、还得重看一次。
      if (r.reason === 'captcha_expired' || r.reason === 'captcha_too_many_tries') {
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
      }
    }
  };

  /** 发送邮箱验证码：**先用当前图形码过一次服务端**，通过才真的发信 */
  const handleSendCode = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError('请先填写正确的邮箱');
      return;
    }
    setCodeSending(true);
    setError(null);
    setCodeHint(null);
    const r = await sendEmailCode(email, { id: captcha.id, code: captcha.code });
    setCodeSending(false);
    if (r.ok) {
      setCodeCountdown(60);
      setCodeHint(r.message);
      // 同短信：后端发邮箱码也是 `keep=True`，这张图形码提交时还能用，不刷新。
    } else {
      setError(r.message);
      // 同短信：答错不换图，只有过期/作废才换
      if (r.reason === 'captcha_expired' || r.reason === 'captcha_too_many_tries') {
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLockedDevices([]);
    setLoading(true);

    // 前端先挡一道（服务端还会再验一次，这里只是为了少一次无谓请求）
    if (!captcha.id || captcha.code.length < 3) {
      setError('请填写图片中的验证码');
      setLoading(false);
      return;
    }
    // 邮箱验证码：注册（邮箱）与找回密码（邮箱）才需要
    if (mode !== 'login' && credential === 'email' && emailCode.length < 4) {
      setError('请填写邮箱验证码（点「发送验证码」获取）');
      setLoading(false);
      return;
    }

    // ---- 手机号通道（登录 / 注册 / 找回密码）----
    if (credential === 'phone') {
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        setError('手机号格式不正确');
        setLoading(false);
        return;
      }

      // 手机号 + 密码登录（2026-10-21）
      // 和邮箱登录走同一个接口 —— 服务端认 "account" 里是邮箱还是手机号。
      if (mode === 'login' && phoneMode === 'password') {
        if (password.length < 6) {
          setError('请填写密码');
          setLoading(false);
          return;
        }
        const r = await signIn(phone, password, {
          captchaId: captcha.id, captchaCode: captcha.code,
        });
        if (r.error) {
          // 同上：图形码校验即消费，失败一律换图
          setCaptchaNonce((n) => n + 1);
          setCaptcha({ id: '', code: '' });
          if (r.reason === 'device_limit' && r.devices?.length) {
            setLockedDevices(r.devices);
            setLockedMax(r.maxDevices ?? 2);
          }
          setError(r.error);
          setLoading(false);
          return;
        }
        // 第 2 台起弹提醒；但**不限设备的账号（maxDevices === 0）不弹** ——
        // 对他们说"最多 2 台"是假话（2026-10-28 加了按账号开的口子）
        if ((r.deviceCount ?? 0) >= 2 && r.maxDevices !== 0) {
          setSecondDevice(true);
          setLoading(false);
          return;
        }
        setLoading(false);
        navigate({ name: 'home' });
        return;
      }

      if (smsCode.length < 4) {
        setError('请填写短信验证码（点「发送验证码」获取）');
        setLoading(false);
        return;
      }

      // 找回密码（手机号）：验证码 + 新密码
      if (mode === 'forgot') {
        if (newPassword.length < 8) {
          setError('新密码至少 8 位');
          setLoading(false);
          return;
        }
        const { error } = await resetByPhone(phone, smsCode, newPassword, {
          captchaId: captcha.id, captchaCode: captcha.code,
        });
        if (error) {
          setError(error);
          // 重置也是"校验即消费"，失败就换一张
          setCaptchaNonce((n) => n + 1);
          setCaptcha({ id: '', code: '' });
        } else {
          setSuccess('密码已重置，请用新密码登录。');
        }
        setLoading(false);
        return;
      }

      // 登录 / 注册：同一条接口。差别只在服务端回的 is_new。
      const r = await signInWithPhone(phone, smsCode, {
        captchaId: captcha.id,
        captchaCode: captcha.code,
        // 注册页填的邀请码；登录时后端不会用（账号已存在）
        inviteCode: mode === 'register' ? inviteCode.trim() : undefined,
      });
      if (r.error) {
        setError(r.error);
        // 图形码校验即消费，失败一律换图（2026-10-28 统一）
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
        if (r.reason === 'device_limit' && r.devices?.length) {
          setLockedDevices(r.devices);
          setLockedMax(r.maxDevices ?? 2);
        }
        setLoading(false);
        return;
      }
      // 这个号码第一次来 → 账号是刚刚自动建的。**必须说清楚**，
      // 否则学生只会觉得自己莫名其妙进了别人的账号。
      if (r.isNew) {
        setCreatedPhone(phone);
        setLoading(false);
        return;
      }
      setLoading(false);
      navigate({ name: 'home' });
      return;
    }

    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      setLoading(false);
      return;
    }

    if (mode === 'login') {
      const { error, reason, devices, maxDevices, deviceCount } = await signIn(
        email, password, { captchaId: captcha.id, captchaCode: captcha.code });
      if (error) {
        /*
         * 登录失败一律换一张图形码（2026-10-28 修）。
         *
         * 服务端是"校验即消费"：密码对错先不管，只要图形码验过，这条 id 就被删了。
         * 所以密码打错一次，第二次再提交必然是 captcha_expired —— 用户要提交三次
         * 才进得去，且中间那句"验证码已失效"看着像他填错了。
         * 原来这里只对 expired / too_many 换图，属于把注释（顶部写着"每次提交都要换"）
         * 和实现写岔了。现在无条件换图：错一次 = 换一张，符合用户直觉。
         */
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
        // 设备超限：除了拒绝原因，还要列出「哪几台正在占用名额」——
        // 否则用户在新设备上只看到一句拒绝，完全不知道该去哪儿退
        if (reason === 'device_limit' && devices?.length) {
          setLockedDevices(devices);
          setLockedMax(maxDevices ?? 2);
        }
        if (error.includes('Email not confirmed')) {
          setError('邮箱还没有验证，请先到邮箱点击确认链接。');
        } else {
          setError(error);
        }
        setLoading(false);
      } else {
        // 第 2 台设备：弹提醒（讲清"最多 2 台、可同时查看"的新口径），关掉再进站
        // maxDevices === 0 = 该账号不限设备，不弹（2026-10-28）
        if ((deviceCount ?? 0) >= 2 && maxDevices !== 0) {
          setSecondDevice(true);
          setLoading(false);
          return;
        }
        navigate({ name: 'home' });
      }
    } else if (mode === 'register') {
      const { error, needsConfirm } = await signUp(email, password, inviteCode.trim() || undefined, {
        captchaId: captcha.id, captchaCode: captcha.code, emailCode,
      });
      if (error) {
        setError(error);
        // 图形码校验即消费 → 失败一律换图（2026-10-28 统一，不再挑 reason）
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
        setLoading(false);
      } else if (needsConfirm) {
        setSuccess('注册成功！请到你的邮箱点击确认链接，然后再回来登录。如果没收到，请检查垃圾邮件文件夹。');
        setLoading(false);
      } else {
        navigate({ name: 'home' });
      }
    } else if (mode === 'forgot') {
      if (newPassword.length < 8) {
        setError('新密码至少 8 位');
        setLoading(false);
        return;
      }
      const { error } = await resetPassword(email, {
        captchaId: captcha.id, captchaCode: captcha.code, emailCode, newPassword,
      });
      if (error) {
        setError(error);
        setCaptchaNonce((n) => n + 1);
        setCaptcha({ id: '', code: '' });
      } else {
        setSuccess('密码已重置，请用新密码登录。');
      }
      setLoading(false);
    }
  };

  const titles: Record<AuthMode, string> = {
    login: '登录',
    register: '注册新账号',
    forgot: '重置密码',
  };

  /**
   * 这一屏要不要「密码」输入框。
   *   · 邮箱 + 登录/注册 → 要
   *   · 手机号 + 登录 + 密码登录 → 要
   *   · 手机号 + 注册/验证码登录 → 不要（服务端自动建号，密码以后在个人中心设）
   */
  const showPassword =
    (mode === 'login' && credential === 'email') ||
    (mode === 'login' && credential === 'phone' && phoneMode === 'password') ||
    (mode === 'register' && credential === 'email');
  /** 手机号这一栏是不是走"密码登录"（此时不显示短信验证码那一行） */
  const phoneUsingPassword = mode === 'login' && credential === 'phone' && phoneMode === 'password';

  const submitLabel =
    mode === 'forgot'
      ? '重置密码'
      : mode === 'register'
        ? credential === 'phone' ? '手机号注册' : '注册'
        : credential === 'phone'
          ? phoneMode === 'password' ? '密码登录' : '手机号登录'
          : '登录';

  return (
    /*
     * 2026-10-21 整体重做。用户：「这个登录界面太他妈丑了」。
     *
     * 丑在哪（对照 Linear 的登录页）：
     *   · 一个居中的圆角盒子，四周全是空 —— 是"对话框"不是"页面"
     *   · 里面再套一个 56px 的彩色圆角方块放学士帽 —— App Icon 的做法
     *   · 标题居中、副标题居中、按钮满宽 —— 三处居中最容易显得廉价
     *   · 背景是白纸，跟全站深色脱节
     *
     * 现在改成 **全屏左右分栏**：左侧是叙事（大字 + 说明 + 一行统计），
     * 右侧是表单（左对齐、无卡片外壳、输入框直接落在背景上）。
     * 这是 Linear / Vercel / Stripe 登录页的共同结构 ——
     * 表单不需要"盒子"，盒子会让它看起来像个弹窗。
     */
    <div className="relative min-h-screen overflow-x-clip bg-page">
      {/*
        登录/注册/找回密码没有 Header（全屏左右分栏，顶部不放导航条），
        所以主题开关单独补一个浮动的 —— 用户要求"所有页面都能切"。
        放右上角，避让返回键（返回键在左上）。
      */}
      <ThemeToggle floating />
      {/* 环境光：右上角一团极淡冷光，和首页同一套语言 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 right-0 h-[520px] w-[520px] translate-x-1/3 rounded-full bg-[radial-gradient(circle_at_center,rgba(120,142,158,0.14),transparent_68%)] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:88px_88px] [mask-image:linear-gradient(to_bottom,#000_0%,transparent_65%)]"
      />

      {/*
        2026-10-21：登录页左上角放品牌标识，与全站导航同位置同尺寸。
        之前这里只有一个「返回」文字按钮，整页看不到任何品牌 ——
        用户进来不知道自己在一个什么站上。
        现在：签名 + 小字站名（C 方案），右边是返回。
      */}
      <div className="absolute left-6 top-6 z-10 flex items-center gap-4">
        <button
          onClick={() => navigate({ name: 'home' })}
          className="group flex flex-col items-start gap-[3px]"
          aria-label="返回工商真题库首页"
        >
          <img
            src="/logo-signature.png"
            alt="Louis"
            width={76}
            height={30}
            className="h-[26px] w-auto opacity-90 transition-opacity duration-200 group-hover:opacity-100"
          />
          <span className="pl-[2px] font-mono text-[9px] uppercase tracking-[0.22em] text-gray-500 transition-colors group-hover:text-gray-700">
            工商真题库
          </span>
        </button>
        <span aria-hidden="true" className="h-8 w-px bg-elevate/[0.08]" />
        <button
          onClick={() => navigate({ name: 'home' })}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-solid-hover/[0.05] hover:text-gray-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          返回
        </button>
      </div>

      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-16 px-6 py-16 lg:grid-cols-[1fr_400px] lg:gap-24">
        {/* ── 左：叙事 ── */}
        <div className="hidden lg:block">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">
            重庆工商大学 · 历年真题
          </p>
          <h1 className="mt-6 max-w-[16ch] text-[42px] font-medium leading-[1.05] tracking-[-0.03em] text-gray-900">
            登录后，
            <br />
            把整库真题带走
          </h1>
          <p className="mt-6 max-w-[38ch] text-[14px] leading-[1.7] text-gray-500">
            收录历年考试原卷，支持在线翻阅与原文下载。每份都标注是否含答案与解析。
          </p>

          <div className="mt-12 flex items-center gap-10 border-t border-hairline/[0.06] pt-7">
            <div>
              <p className="font-mono text-[20px] font-medium leading-none text-gray-900 tabular-nums">{statPapers}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">份真题</p>
            </div>
            <div>
              <p className="font-mono text-[20px] font-medium leading-none text-gray-900 tabular-nums">{statCourses}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">门课程</p>
            </div>
            <div>
              <p className="font-mono text-[20px] font-medium leading-none text-gray-900 tabular-nums">{totalWithAnswer}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">含答案</p>
            </div>
          </div>
        </div>

        {/* ── 右：表单（无卡片外壳，直接落在背景上）── */}
        <div className="w-full">
          {/*
            ⚠️ 这里原本还有一份「签名 + 工商真题库」，与左上角那个完全重复。
            2026-10-21 实测截图里同一个 logo 上下出现两次，像排版错误。
            左上角那个是全站统一位置（首页/真题库页都在这），保留它；
            这块删掉。小屏上左上角一样看得到，不损失品牌。
          */}
          <div className="mb-7">
            <h2 className="text-[26px] font-medium tracking-[-0.03em] text-gray-900">{titles[mode]}</h2>
            <p className="mt-1.5 text-[13px] text-gray-500">
              {mode === 'login'
                ? credential === 'email'
                  ? '用邮箱和密码继续'
                  : phoneMode === 'password' ? '用手机号和密码登录' : '用手机号和短信验证码登录'
                : mode === 'register'
                  ? credential === 'email'
                    ? '创建账号，免费试用 3 份'
                    : '验证手机号即可注册，不用设密码'
                  : credential === 'email' ? '验证邮箱后设置新密码' : '验证手机号后设置新密码'}
            </p>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.08] p-3 text-[13px] text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 设备超限：列出正在占名额的两台，用户才知道回哪台退 */}
          {lockedDevices.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-3">
              <p className="mb-2 text-[12px] font-medium text-amber-600">
                正在使用这个账号的 {lockedMax} 台设备
              </p>
              <ul className="space-y-1.5">
                {lockedDevices.map((d, i) => (
                  <li key={i} className="flex items-center justify-between text-[12px] text-amber-700/90">
                    <span className="font-medium">{d.device_name || '未知设备'}</span>
                    <span className="font-mono text-amber-400/70">{formatLastSeen(d.last_seen_at)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-amber-600/70">
                在以上任一台设备上：个人中心 → 我的设备 → 退出这台，名额会立刻释放。
              </p>
            </div>
          )}

          {success && (
            <>
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] p-3 text-[13px] text-emerald-300">
                <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{success}</span>
              </div>
              <button
                onClick={() => navigate({ name: 'login' })}
                className="w-full rounded-lg bg-solid py-2.5 text-[14px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
              >
                返回登录
              </button>
            </>
          )}

          {/*
            「首次手机号登录 = 自动注册」的确认页。
            不加这一屏，学生的体验是：输个验证码，突然就"登录成功"进了某个账号，
            完全不知道账号是什么、下次怎么回来。这里把三件事一次讲清：
            ① 账号是刚给你建的 ② 账号就是你的手机号 ③ 下次怎么进。
          */}
          {createdPhone && (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-5">
              <div className="flex items-start gap-3">
                <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-gray-900">账号已创建</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-gray-600">
                    手机号 {createdPhone.slice(0, 3)}****{createdPhone.slice(-4)} 是第一次来，
                    已经为你直接建好账号了 —— 不用再单独填一遍注册表。
                  </p>
                  <p className="mt-2 text-[12px] leading-relaxed text-gray-500">
                    下次回来只要填这个号码、收一条短信验证码就能进，不用记密码。
                    想改用邮箱登录，可以在「个人中心」里补上邮箱和密码。
                  </p>
                </div>
              </div>
              <button
                onClick={() => navigate({ name: 'home' })}
                className="mt-5 w-full rounded-lg bg-solid py-2.5 text-[14px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
              >
                进入首页
              </button>
            </div>
          )}

          {!success && !createdPhone && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 三个入口都能在「邮箱 / 手机号」之间切（2026-10-21：注册也支持手机号） */}
            <div className="flex gap-1 rounded-lg border border-hairline/[0.08] p-1">
                {([['email', '邮箱', Mail], ['phone', '手机号', Smartphone]] as [Credential, string, typeof Mail][]).map(
                  ([id, label, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { setCredential(id); setError(null); setSuccess(null); setCreatedPhone(null); }}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[13px] transition-colors ${
                        credential === id
                          ? 'bg-elevate/[0.10] text-strong'
                          : 'text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {label}
                    </button>
                  ),
                )}
            </div>

            {/*
              手机号通道的二级选择：验证码 / 密码（2026-10-21 用户要求）。
              只登录需要 —— 注册和找回密码本来就只能靠验证码。
              做小一号的 pill，而不是第二排大 tab：它在语义上是"同一个手机号入口的两种证明方式"。
            */}
            {mode === 'login' && credential === 'phone' && (
              <div className="flex items-center gap-4 pl-0.5">
                {([
                  ['code', '验证码登录'],
                  ['password', '密码登录'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { setPhoneMode(id); setError(null); setSuccess(null); }}
                    className={`relative py-0.5 text-[12px] transition-colors ${
                      phoneMode === id
                        ? 'text-gray-900'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {label}
                    {phoneMode === id && (
                      <span className="absolute -bottom-1 left-0 h-px w-full bg-gray-900" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {phoneUsingPassword && (
              <p className="text-[11px] leading-relaxed text-gray-500">
                登录密码在「个人中心 → 登录密码」中设置。若该号码尚未设置密码，
                请改用上方「验证码登录」，登录后再行设置。
              </p>
            )}

            {credential === 'email' ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-600">邮箱</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input
                  type="email"
                  required={credential === 'email'}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                />
              </div>
            </div>
            ) : (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-600">手机号</label>
              <div className="relative">
                <Smartphone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={11}
                  required={credential === 'phone'}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  placeholder="11 位手机号"
                  className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                />
              </div>
            </div>
            )}

            {showPassword && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                  <input
                    type="password"
                    required
                    minLength={mode === 'register' ? 8 : 6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? '至少 8 位（建议字母 + 数字）' : '请输入密码'}
                    className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                </div>
              </div>
            )}

            {mode === 'register' && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">
                  邀请码 <span className="text-gray-500 font-normal">（选填，填了帮邀请你的同学攒会员）</span>
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="例如 3DD56871"
                    maxLength={16}
                    className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                </div>
              </div>
            )}

            {mode === 'register' && credential === 'email' && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">确认密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="再输入一次"
                    className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                </div>
              </div>
            )}

            {/*
              邮箱验证码（注册 / 找回密码才需要）。
              放在图形码**上面**：先让用户看到「还要收邮件」，再去填图 ——
              反过来会让他在填完图之后才发现还有一步，感觉被耍。
            */}
            {mode !== 'login' && credential === 'email' && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">
                  邮箱验证码
                  <span className="ml-1 font-normal text-gray-500">（防止有人批量注册）</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="6 位数字"
                    className="min-w-0 flex-1 rounded-lg border border-hairline/[0.10] bg-input px-3 py-2.5 text-[14px] tracking-[0.14em] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSendCode()}
                    disabled={codeSending || codeCountdown > 0}
                    className="shrink-0 whitespace-nowrap rounded-lg border border-hairline/[0.12] px-3 py-2.5 text-[13px] text-gray-800 transition-colors hover:bg-solid-hover/[0.06] disabled:opacity-40"
                  >
                    {codeSending ? '发送中…' : codeCountdown > 0 ? `${codeCountdown}s 后重发` : '发送验证码'}
                  </button>
                </div>
                {codeHint && <p className="mt-1.5 text-[11px] text-emerald-400/80">{codeHint}</p>}
              </div>
            )}

            {/* 短信验证码（手机号通道：注册 / 验证码登录 / 找回密码都用它） */}
            {credential === 'phone' && !phoneUsingPassword && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">短信验证码</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="6 位数字"
                    className="min-w-0 flex-1 rounded-lg border border-hairline/[0.10] bg-input px-3 py-2.5 text-[14px] tracking-[0.14em] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSendSms()}
                    disabled={smsSending || smsCountdown > 0}
                    className="shrink-0 whitespace-nowrap rounded-lg border border-hairline/[0.12] px-3 py-2.5 text-[13px] text-gray-800 transition-colors hover:bg-solid-hover/[0.06] disabled:opacity-40"
                  >
                    {smsSending ? '发送中…' : smsCountdown > 0 ? `${smsCountdown}s 后重发` : '发送验证码'}
                  </button>
                </div>
                {smsError && (
                  <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-red-400">
                    {smsError}
                  </p>
                )}
                {smsHint && <p className="mt-1.5 text-[11px] text-emerald-400/80">{smsHint}</p>}
              </div>
            )}

            {mode === 'forgot' && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-gray-600">新密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="至少 8 位（建议字母 + 数字）"
                    className="w-full rounded-lg border border-hairline/[0.10] bg-input py-2.5 pl-10 pr-4 text-[14px] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                  />
                </div>
              </div>
            )}

            {/*
              人机验证（自建图形码）。三个入口都必填：
              注册防批量、登录防撞库、找回密码防刷别人的邮箱。
              ⚠️ 服务端会再验一次，且校验即消费 —— 所以每次提交后都要换一张。
            */}
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-600">图形验证</label>
              <Captcha onChange={setCaptcha} refreshKey={captchaNonce} />
            </div>

            {/* 注册时的告知同意：按《个人信息保护法》，收集前要让用户明确知情并同意 */}
            {mode === 'register' && (
              <p className="text-xs text-gray-500 leading-relaxed">
                点击「注册」即表示你已阅读并同意
                <button
                  type="button"
                  onClick={() => navigate({ name: 'privacy' })}
                  className="text-gray-700 hover:text-gray-700 underline underline-offset-2 mx-0.5"
                >
                  《隐私政策》
                </button>
                ，同意我们按该政策处理你的{credential === 'phone' ? '手机号' : '邮箱'}与使用记录。
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-solid py-2.5 text-[14px] font-medium text-on-solid transition-all duration-150 hover:bg-solid-hover active:scale-[0.99] disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitLabel}
            </button>
          </form>
          )}

          {/* Switch links */}
          <div className="mt-8 space-y-3 text-center text-[13px]">
            {mode === 'login' && (
              <>
                <p className="text-gray-500">
                  还没有账号？
                  <button onClick={() => navigate({ name: 'register' })} className="ml-1 font-medium text-gray-900 underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/60">
                    注册
                  </button>
                </p>
                <button onClick={() => navigate({ name: 'forgot' })} className="mx-auto block text-[12px] text-gray-500 transition-colors hover:text-gray-700">
                  忘记密码？
                </button>
              </>
            )}
            {mode === 'register' && (
              <p className="text-gray-500">
                已有账号？
                <button onClick={() => navigate({ name: 'login' })} className="ml-1 font-medium text-gray-900 underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/60">
                  登录
                </button>
              </p>
            )}
            {mode === 'forgot' && (
              <p className="text-gray-500">
                想起来了？
                <button onClick={() => navigate({ name: 'login' })} className="ml-1 font-medium text-gray-900 underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/60">
                  返回登录
                </button>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 第 2 台设备登录提醒（2026-10-20） */}
      {secondDevice && (
        <SecondDeviceNotice
          onClose={() => {
            setSecondDevice(false);
            navigate({ name: 'home' });
          }}
        />
      )}
    </div>
  );
}
