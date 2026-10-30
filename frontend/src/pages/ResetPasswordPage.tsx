import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { GraduationCap, Lock, AlertCircle, CheckCircle, Loader2, Smartphone, Mail } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

type Mode = 'email' | 'phone';

/**
 * 设置新密码页。
 *
 * 「邮箱」标签：**已可用** —— 用户从重置邮件点进来，Supabase 会带 recovery 会话，
 *   这里调 updateUser({ password }) 改密。
 *   已实测：改密后新密码立刻可用、旧密码失效（证明改动真的落到了后台）。
 *
 * 「手机号」标签：**预留**。SMS 通道（阿里云「短信认证」）还在开通中，
 *   所以先把完整交互与校验写好、控件置灰并说明原因。
 *   等短信 API 到位后，只需在 sendCode / submit 两处接上服务端接口，
 *   界面与流程不用再动。
 */
export function ResetPasswordPage() {
  const { setIsPasswordRecovery } = useAuth();
  const { navigate } = useApp();
  const [mode, setMode] = useState<Mode>('email');

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-page px-4 py-10">
      {/* 这页没有 Header（重置密码是独立流程），主题开关单独补一个（2026-10-22） */}
      <ThemeToggle floating />
      <div className="w-full max-w-md">
        <div className="bg-ink-850 rounded-xl border border-hairline/[0.08] p-6 sm:p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-xl bg-accent flex items-center justify-center mb-3">
              <GraduationCap className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">设置新密码</h1>
            <p className="text-sm text-gray-500 mt-1">工商真题库</p>
          </div>

          {/* 两种验证方式 */}
          <div className="flex gap-6 border-b border-hairline/[0.08] mb-6">
            {([
              ['email', '邮箱重置', Mail],
              ['phone', '手机号重置', Smartphone],
            ] as [Mode, string, typeof Mail][]).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`flex items-center gap-1.5 pb-3 -mb-px text-sm border-b-2 transition-colors ${
                  mode === id
                    ? 'border-hairline/[0.2] text-gray-900 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>

          {mode === 'email' ? (
            <EmailReset
              onDone={() => {
                setIsPasswordRecovery(false);
                navigate({ name: 'home' });
              }}
            />
          ) : (
            <PhoneReset />
          )}
        </div>
      </div>
    </div>
  );
}

/** 邮箱重置：**需要先登录**（登录状态下调本地改密接口；忘记密码请联系站长人工重置） */
function EmailReset({ onDone }: { onDone: () => void }) {
  const { updatePassword, session } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    const { error: err } = await updatePassword(password);
    setLoading(false);
    if (err) {
      setError(err);
    } else {
      setSuccess('密码修改成功，正在返回首页…');
      setTimeout(onDone, 1500);
    }
  };

  if (!session) {
    return (
      <div className="flex items-start gap-2 bg-elevate/[0.03] text-gray-500 text-xs rounded-lg p-3 leading-relaxed">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          修改密码需要先<strong className="text-gray-900">登录</strong>（登录后也可在
          「个人中心」里修改）。如果忘记了密码，请联系站长人工重置。
        </span>
      </div>
    );
  }

  return (
    <>
      <Notice error={error} success={success} />
      <form onSubmit={submit} className="space-y-4">
        <Field label="新密码" value={password} onChange={setPassword} placeholder="至少 6 位" />
        <Field label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} placeholder="再输入一次" />
        <button
          type="submit"
          disabled={loading || !!success}
          className="w-full py-3 bg-solid text-on-solid rounded-lg text-sm font-medium hover:bg-solid-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          确认修改
        </button>
      </form>
    </>
  );
}

/**
 * 手机号重置：**预留**。
 *
 * 2026-10-21 结论：短信仍不可用 —— 阿里云「短信认证」配置的 `恒创联众/100001`
 * 现在返回 UNKNOWN（10-15 曾成功过一次，之后因余额被停），而**赠送的那一对
 * 签名+模板必须登录控制台才能抄到**，在那之前无法修复。
 * 所以真正的自助重置走「邮箱验证码」（见 AuthPage 的 forgot 模式），
 * 这里保留界面与交互，接上短信后把 SMS_READY 改成 true 即可。
 */
function PhoneReset() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [countdown, setCountdown] = useState(0);

  // 短信通道尚未开通。接上服务端后改成 true。
  const SMS_READY = false;

  const phoneValid = /^1[3-9]\d{9}$/.test(phone);
  const canSubmit = phoneValid && code.length >= 4 && password.length >= 6;

  const sendCode = () => {
    // TODO(短信通道就绪后): 调服务端发送验证码
    //   1) 前端先过一次人机验证（复用 src/components/Captcha.tsx）
    //   2) POST /api/auth/sms { phone, captchaToken }
    //   3) 服务端 → 阿里云 SendSmsVerifyCode（Code 可传自定义码）
    setCountdown(60);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO(短信通道就绪后): POST /api/auth/reset-by-phone { phone, code, password }
    //   服务端核验验证码 → 调 Supabase 管理端改密 → 返回结果
    //   注意：管理端密钥只放服务端，绝不下发前端
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 bg-elevate/[0.03] text-gray-500 text-xs rounded-lg p-3 leading-relaxed">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          手机号重置正在接入短信通道（阿里云「短信认证」），暂未开放。
          现在请切到左边的<strong className="text-gray-900">「邮箱重置」</strong>。
        </span>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">手机号</label>
          <div className="relative">
            <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="tel"
              inputMode="numeric"
              maxLength={11}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              placeholder="11 位手机号"
              disabled={!SMS_READY}
              className="w-full pl-10 pr-4 py-3 text-sm bg-elevate/[0.03] rounded-lg border border-hairline/[0.08] focus:border-hairline/[0.2] outline-none transition-colors disabled:opacity-50"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">短信验证码</label>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6 位验证码"
              disabled={!SMS_READY}
              className="flex-1 px-4 py-3 text-sm bg-elevate/[0.03] rounded-lg border border-hairline/[0.08] focus:border-hairline/[0.2] outline-none transition-colors disabled:opacity-50"
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={!SMS_READY || !phoneValid || countdown > 0}
              className="px-4 py-3 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              {countdown > 0 ? `${countdown}s` : '发送验证码'}
            </button>
          </div>
        </div>

        <Field label="新密码" value={password} onChange={setPassword} placeholder="至少 6 位" disabled={!SMS_READY} />

        <button
          type="submit"
          disabled={!SMS_READY || !canSubmit}
          className="w-full py-3 bg-solid text-on-solid rounded-lg text-sm font-medium hover:bg-solid-hover transition-colors disabled:opacity-40"
        >
          确认修改
        </button>
      </form>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="password"
          required
          minLength={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full pl-10 pr-4 py-3 text-sm bg-elevate/[0.03] rounded-lg border border-hairline/[0.08] focus:border-hairline/[0.2] outline-none transition-colors disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function Notice({ error, success }: { error: string | null; success: string | null }) {
  if (!error && !success) return null;
  return (
    <>
      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 text-red-700 text-sm rounded-lg p-3 mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 bg-elevate/[0.06] text-gray-800 text-sm rounded-lg p-3 mb-4">
          <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}
    </>
  );
}
