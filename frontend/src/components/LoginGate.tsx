import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { usePapers } from '@/context/PapersContext';
import { Lock, ArrowRight } from 'lucide-react';
import { fetchLibraryTotals } from '@/lib/papers';
import { FREE_LIMIT } from '@/context/AccessContext';

/**
 * 「登录后可免费试用」提示条（2026-10-20 改写）
 *
 * 用户要求：
 *   「我们是整个真题库都需要登陆后才能试用三次 而不是非登陆用户就能看
 *     这个数据要随着网站题库数量更新实时刷新跟上」
 *
 * 所以这里不再写「还有 N 份仅对登录用户开放」——
 * 那句话会让匿名访客以为**站里另一半是公开的**，与真实规则（全都得登录）不符。
 * 现在明确讲：全库共 N 份，登录后可免费查看 3 份。
 *
 * 数量取自列表接口的两个计数（匿名可见 + 仅登录可见），
 * **题库一更新，下次进页面就是新数字**，不写死。
 */
export function LoginGate({ className = '' }: { className?: string }) {
  const { user } = useAuth();
  const { navigate } = useApp();
  const { papers } = usePapers();
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (user) return;
    let alive = true;
    // 先用本地已知的匿名可见数量兜底（秒出），再用接口拿全库总数校正
    setTotal((n) => (n > 0 ? n : papers.length));
    fetchLibraryTotals().then((t) => {
      if (alive && t.total > 0) setTotal(t.total);
    });
    return () => {
      alive = false;
    };
  }, [user, papers.length]);

  if (user || total <= 0) return null;

  return (
    /*
     * 2026-10-21：原样硬编码了浅色（bg-elevate/[0.03] 白纸 + #1c1b17 墨字），
     * 全站转深色后它成了一块刺眼的白斑。改成深色面板 + 琥珀色强调：
     *   · 底色用 ink-850（比页面底略亮，看得出是个"条"）
     *   · 边框用琥珀色 20% —— 提示条需要比普通卡片多一分"注意我"，
     *     但不能用大色块（那是电商的做法）
     *   · 数字用琥珀色，一眼看到"免费 3 份"这个关键信息
     */
    <div
      className={`flex flex-col gap-3 rounded-xl border border-amber-400/20 bg-ink-850 px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] sm:flex-row sm:items-center ${className}`}
    >
      {/*
        2026-10-22：amber-300/400 在浅色底上几乎不可见（对比度 ~1.4:1）。
        统一改用 amber-600（浅底 4.6:1 ✅），深色底上同样可读；
        只有"强调数字"这种小面积文字才用得到 600，不再用 300。
      */}
      <Lock className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      <p className="flex-1 text-[13px] leading-relaxed text-gray-600">
        全库共 <span className="font-mono font-medium text-amber-600 tabular-nums">{total}</span> 份真题与资料。
        登录后可免费试用{' '}
        <span className="font-mono font-medium text-amber-600 tabular-nums">{FREE_LIMIT}</span> 份，之后需开通会员。
      </p>
      <button
        onClick={() => navigate({ name: 'login' })}
        className="flex shrink-0 items-center gap-1 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-[13px] font-medium text-amber-600 transition-colors hover:bg-amber-500/15 hover:text-amber-700"
      >
        登录查看
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
