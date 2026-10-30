import { useEffect } from 'react';
import { Check } from 'lucide-react';

/**
 * 支付成功小弹窗（2026-10-28）
 *
 * 用户原话：「当用户支付成功需要有一个小弹窗，而不只是在支付完成后，
 * 下面显示付款已确认，会员已开通」。
 *
 * 为什么要单独做，而不是继续用页面里那行 notice：
 *   付钱是整条链路里最需要"被确认"的一步。原来成功后的反馈是一行灰字，
 *   夹在一堆说明文字中间，扫一眼根本分不清"这是提示"还是"已经完事了"。
 *   弹窗是唯一能明确表达「这件事结束了」的交互，且它出现时页面已经被
 *   收干净（面板收起、选中态清掉），不会和"还能再付一次"混在一起。
 *
 * 设计纪律（与站点其余部分一致）：
 *   · 一个强调色（accent）只用在图标底和主按钮上，不做装饰性彩色
 *   · 面板底用 bg-ink-850 —— 深色主题下是近黑、浅色主题下是纯白，
 *     两种主题都不需要额外写 dark: 分支
 *   · 不用 emoji、不用撒花动画。付完钱的人要的是"确认"，不是庆祝
 *   · 只能通过「开始使用」或点遮罩关掉；按 Esc 也可以（键盘用户）
 */
export function PaymentSuccessModal({
  open,
  planLabel,
  expiry,
  validFrom,
  validTo,
  lifetime,
  onClose,
}: {
  open: boolean;
  /** 刚开通的方案名，如「年度会员」；拿不到就不显示这一行 */
  planLabel?: string | null;
  /** 有效期文案（旧口径，单值）。validFrom/validTo 都没给时回退到它 */
  expiry?: string | null;
  /** 本次权益生效时间（订单支付时间），如「2026年10月30日 15:12」 */
  validFrom?: string | null;
  /** 本次权益到期时间，如「2026年11月29日 15:12」 */
  validTo?: string | null;
  /** 永久会员：起止时间没有意义，显示「永久有效」 */
  lifetime?: boolean;
  onClose: () => void;
}) {
  // Esc 关闭。必须放在 `if (!open) return null` 之前，保证 hook 顺序恒定。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  /*
   * 有效期怎么显示（2026-10-30 用户要求「显示起止时间」）：
   *   · 永久        → 一行「永久有效」
   *   · 有起有止    → 两行，起在上面、止在下面，手机窄屏也不会挤成一坨
   *   · 只有到期日  → 回退到旧的单值显示
   */
  const hasPeriod = Boolean(validFrom && validTo);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 px-5 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pay-success-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[330px] rounded-2xl border border-hairline/[0.10] bg-ink-850 p-6 text-center shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-wash">
          <Check className="h-7 w-7 text-accent" strokeWidth={2.5} aria-hidden="true" />
        </div>

        <h2 id="pay-success-title" className="mt-4 text-[17px] font-semibold tracking-[-0.02em] text-gray-900">
          支付成功
        </h2>
        {/* 书面表述（2026-10-30）：原来写「全站资料现在都可以看了」，太口语，
            且「看了」容易被理解成"可以下载/独占"。这里只说查阅权限，不说别的。 */}
        <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
          会员权益已生效，有效期内可查阅站内全部资料。
        </p>

        {(planLabel || expiry || hasPeriod || lifetime) && (
          <dl className="mt-5 space-y-2 rounded-xl bg-elevate/[0.03] px-4 py-3 text-left text-[13px]">
            {planLabel && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">方案</dt>
                <dd className="text-gray-900">{planLabel}</dd>
              </div>
            )}

            {hasPeriod && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-gray-500">有效期</dt>
                {/* 只到「日」，且写成一句话（2026-10-30 用户要求去掉时分） */}
                <dd className="text-right text-gray-900">
                  {validFrom} 至 {validTo}
                </dd>
              </div>
            )}

            {!hasPeriod && lifetime && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">有效期</dt>
                <dd className="text-gray-900">永久有效</dd>
              </div>
            )}

            {!hasPeriod && !lifetime && expiry && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">有效期至</dt>
                <dd className="text-gray-900">{expiry}</dd>
              </div>
            )}
          </dl>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-lg bg-solid px-5 py-3 text-[14px] font-medium text-on-solid transition-colors hover:bg-solid-hover active:scale-[0.99]"
        >
          开始使用
        </button>
      </div>
    </div>
  );
}
