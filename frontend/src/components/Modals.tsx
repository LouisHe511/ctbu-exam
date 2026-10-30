import { X, Lock, Crown, Sparkles, Check } from 'lucide-react';
import { PLANS } from '@/lib/membership';

/** 付费墙：免费额度用完 / 未登录时弹出 */
export function PaywallModal({
  open,
  onClose,
  onLogin,
  onGoPricing,
  freeLimit,
  freeRemaining,
  isLoggedIn,
}: {
  open: boolean;
  onClose: () => void;
  onLogin: () => void;
  onGoPricing: () => void;
  freeLimit: number;
  freeRemaining: number;
  isLoggedIn: boolean;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative bg-ink-850 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-slide-up-panel">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-gray-100 transition-colors z-10"
        >
          <X className="w-4 h-4 text-gray-500" />
        </button>

        <div className="bg-accent px-6 py-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-elevate/15 flex items-center justify-center mx-auto mb-3">
            {isLoggedIn ? <Lock className="w-7 h-7 text-white" /> : <Crown className="w-7 h-7 text-white" />}
          </div>
          <h2 className="text-lg font-semibold text-white mb-1">
            {isLoggedIn ? '免费额度已用完' : '登录后继续查看'}
          </h2>
          <p className="text-sm text-white/85">
            {isLoggedIn
              ? `每位新用户可以免费查看 ${freeLimit} 份试卷，你已经看完了。`
              : `登录即可免费查看 ${freeLimit} 份试卷，同一份重复看不重复计数。`}
          </p>
        </div>

        <div className="px-6 py-5">
          {isLoggedIn ? (
            <>
              <p className="text-sm text-gray-600 mb-4">
                开通会员即可全站不限量查看，还剩余额：{freeRemaining} 份。
              </p>
              <div className="space-y-2 mb-5">
                {[
                  '全站试卷不限量查看',
                  '包含答案的试卷完整开放',
                  '会员期内新上传的试卷同步开放',
                ].map((t) => (
                  <div key={t} className="flex items-start gap-2 text-sm text-gray-700">
                    <Check className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                    <span>{t}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={onGoPricing}
                className="w-full py-3 rounded-xl bg-accent text-white font-medium hover:bg-accent-deep transition-colors flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                查看会员方案
              </button>
              <p className="text-xs text-gray-500 text-center mt-3">
                {/* 价格一律从 PLANS 渲染（2026-10-28 审计发现这里写死过 ¥6.8/¥12.8，
                    与真实定价 ¥8.8/¥16.8 不符 —— 付费墙说一套、收银台收一套） */}
                {PLANS.map((p) => `${p.name.replace('会员', '')} ¥${p.price}`).join(' · ')}
              </p>
            </>
          ) : (
            <>
              <button
                onClick={onLogin}
                className="w-full py-3 rounded-xl bg-accent text-white font-medium hover:bg-accent-deep transition-colors"
              >
                去登录 / 注册
              </button>
              <p className="text-xs text-gray-500 text-center mt-3">
                登录后免费额度会自动记录在你的账号上
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 首次进入的公告弹窗 */
export function AnnouncementModal({
  open,
  onClose,
  freeLimit,
  onLogin,
}: {
  open: boolean;
  onClose: () => void;
  freeLimit: number;
  onLogin: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative bg-ink-850 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden animate-slide-up-panel">
        <div className="bg-solid px-6 py-6">
          <div className="w-12 h-12 rounded-xl bg-elevate/20 flex items-center justify-center mb-3">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-lg font-semibold text-white">欢迎来到真题库</h2>
          <p className="text-sm text-white/90 mt-1">新用户免费看 {freeLimit} 份试卷</p>
        </div>
        <div className="px-6 py-5">
          <div className="space-y-2.5 mb-5">
            {[
              `注册即可免费查看 ${freeLimit} 份试卷`,
              '同一份试卷重复查看不重复计数',
              '免费额度用完后可开通会员，全站不限量',
            ].map((t) => (
              <div key={t} className="flex items-start gap-2 text-sm text-gray-700">
                <Check className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <span>{t}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              先逛逛
            </button>
            <button
              onClick={onLogin}
              className="flex-1 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-deep transition-colors"
            >
              去注册
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
