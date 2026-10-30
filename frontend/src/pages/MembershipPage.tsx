import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crown, Check, Copy, Users, Gift, ShieldCheck, Loader2,
  ArrowLeft, BadgeCheck, Infinity as InfinityIcon, Clock,
  CreditCard, RefreshCw, Lock, ScanLine, HandHeart,
} from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import {
  PLANS, INVITES_PER_MONTH, FOUNDER_SLOTS, FOUNDER_TRIAL,
  myMembership, myOrders, createPaymentOrder,
  claimInviteRewards, tierLabel, formatExpiry, formatYuan, inviteLink,
  type Membership, type MyOrder, type PlanId,
} from '@/lib/membership';
import {
  createPaySession, recheckOrder, gotoCashier, fetchPayChannels,
  wechatJsapiPay, resolveWechatOpenid, fetchWechatOAuthUrl, oauthTriedTooMany, resetOauthTries,
  readCachedOpenid, reportDiag, savePendingIntent, takePendingIntent,
  bindOpenidToAccount, fetchMyOpenid, cacheOpenid,
  type PayType, type PayMethod,
} from '@/lib/pay';
import {
  rememberPendingPay, clearPendingPay, isWechatBrowser, readPendingPay,
  markPaidNotified, isPaidNotified,
} from '@/lib/payResume';
import { APPEAL_QQ, SUPPORT_WECHAT } from '@/lib/policy';
import { confirmDialog } from '@/lib/dialog';
import { PaymentSuccessModal } from '@/components/PaymentSuccessModal';

/** 把服务端返回的 reason 翻成人话（学生看得懂的那种） */
function payMessage(reason: string, message?: string): string {
  switch (reason) {
    case 'need_browser':
      return message || '微信内无法使用支付宝付款，请点右上角选择「在浏览器打开」。';
    // 渠道名不进前端文案：换平台时学生侧不该看到"某某支付"字样
    case 'epay_not_configured':
    case 'no_channel_configured':
      return '支付通道还没配置好，暂时不能下单，请稍后再试。';
    case 'not_logged_in':
      return '登录状态已过期，请重新登录后再试。';
    case 'not_your_order':
      return '订单归属异常，请刷新页面后重试。';
    case 'not_pending':
      return '这笔订单已不是待支付状态，请刷新页面。';
    case 'channel_error':
      return '支付通道暂时不可用（常见原因：收款账号离线），请稍后再试或联系管理员。';
    case 'network_error':
      return '网络异常，请检查网络后重试。';
    default:
      return `下单失败（${reason}），请稍后重试。`;
  }
}

/**
 * 会员页。
 *
 * 设计纪律（按 design-system skill）：
 * - 单一强调色 teal，只用于主操作，不做装饰
 * - 中性阶只有 5 档；字号只用 6 级；间距只用 8 的倍数
 * - 左对齐阅读起点，不把正文居中
 * - 图标一律用 lucide（不用 emoji）
 *
 * 支付流程（2026-10-21 改版）：
 *   点方案 → **只是选中，不建单、不跳转**
 *        → 右侧/下方出现「确认支付」面板：应付金额、订单号、**支付方式二选一**
 *        → 学生点「确认支付」才创建订单 + 跳收银台
 *   → 学生付款 → 支付平台回调我们的服务端 → 自动开通会员（无需人工核对）
 *   回调万一丢了，学生可点「我已完成付款」触发主动查单兜底。
 *
 * ⚠️ 为什么必须加这一步（2026-10-21 用户原话）：
 *   「为什么没有选择支付渠道的方式？我点击 3 月度会员后就直接被拉入了支付宝的支付界面」
 *   「应该做一个确认生成订单或叫确认支付之类的按钮，选择支付方式并点击后才能正式付款」
 *   之前的写法是点卡片就下单+跳走，学生连"我要付多少钱、用什么付"都没看见。
 *
 * `embedded` = 嵌在「个人主页 → 会员」这个 tab 里显示（2026-10-28 用户要求）。
 *
 * 为什么用同一个组件而不是复制一份：
 *   原来个人页的「会员」tab 点一下就 `navigate('membership')` 跳到独立页面，
 *   用户原话是「我本意不是这样，而是把这个会员的界面直接移植到上面」。
 *   而两套 UI 各写一遍必然分叉（价格改一处忘另一处），
 *   所以这里只加一个开关：外壳（顶栏留白、返回首页、最大宽度）按需关掉，
 *   里面**整套**状态卡 / 档位 / 支付面板 / 成功弹窗原样复用。
 *
 * 注意：站点的顶部功能栏不受影响 —— 那里点「会员」仍是独立路由页，
 * 因为从阅读器、错题库、四六级页跳过来时并没有"个人主页"这个上下文。
 */
/**
 * 把 ISO 时间格式化成「2026年10月30日」，用于支付成功弹窗的起止时间。
 *
 * 只到「日」，不显示时分（2026-10-30 用户要求）：
 * 学生关心的是"哪天到哪天"，把 15:12 印出来反而像在强调精确到分钟，
 * 一旦手机时区/系统时间有偏差还会显得与平台记录对不上。
 * 精确时间仍然完整保存在 `payment_orders.paid_at` 与 `profiles.membership_expires_at`。
 * 无效/空值返回 null（弹窗据此决定这一行要不要显示）。
 */
function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function MembershipPage({ embedded = false }: { embedded?: boolean }) {
  const { navigate } = useApp();
  const { session } = useAuth();
  const [m, setM] = useState<Membership | null>(null);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loading, setLoading] = useState(true);
  /** 学生点过的方案（**只是选中**，还没建单） */
  const [chosen, setChosen] = useState<PlanId | null>(null);
  /** 确认支付面板（2026-10-28 起**不再**在点档位时自动滚到这里，见 pickPlan） */
  const panelRef = useRef<HTMLElement | null>(null);
  /** 已经建好的待付订单 */
  const [order, setOrder] = useState<{ no: string; tier: PlanId; cents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  /** 复制客服微信（经济困难免单那个按钮） */
  const [copiedSupport, setCopiedSupport] = useState(false);
  /** 支付面板是否展开（学生点「收起」后不再自动弹出） */
  const [panelOpen, setPanelOpen] = useState(true);
  /** 从收银台跳回来时只自动确认一次，避免反复打接口 */
  const autoChecked = useRef(false);
  /**
   * 支付成功弹窗（2026-10-28）。
   *
   * 只在**真的查到这笔已付**时打开 —— 平台回调、主动查单、扫码轮询三条路
   * 最后都走 finishPaid()，所以弹窗一定跟着"会员确实开通了"出现，
   * 不会出现"付了没开通却弹成功"的情况。
   */
  const [successOpen, setSuccessOpen] = useState(false);
  /** 成功弹窗里显示的方案（订单上的 tier；拿不到就只显示有效期） */
  const [paidTier, setPaidTier] = useState<PlanId | null>(null);
  /**
   * 刚刚付成功那笔的**支付时间**（2026-10-30）。
   * 弹窗要显示"有效期起止"，起点就是它 —— 用"现在"代替会在跨天/跨时区时对不上。
   */
  const [paidAt, setPaidAt] = useState<string | null>(null);
  /**
   * 正在等结果的订单号（2026-10-30）。
   *
   * 这是**唯一**的"等付款"信号，来自三处：刚下单、页面挂载时读 localStorage 的现场、
   * 以及二维码订单。之前只有"二维码弹层开着"才轮询，学生一关弹层就彻底失去反馈；
   * 支付宝还是整页跳收银台，回来时连轮询都没启动过。
   */
  const [awaitingNo, setAwaitingNo] = useState<string | null>(
    // 挂载时先把 localStorage 里的现场接上：从支付宝收银台跳回来是**整页重载**，
    // 内存里的 state 全没了，只有这条记录还知道"刚刚在付哪一单"。
    () => readPendingPay()?.orderNo ?? null,
  );

  /** 学生选的支付方式。null = 还没选/服务端一种都没开 */
  const [method, setMethod] = useState<PayType | null>(null);
  /** 服务端当前真正能用的支付方式 */
  const [methods, setMethods] = useState<PayMethod[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  /**
   * 当前「微信支付」是不是**官方 JSAPI**（2026-10-27）。
   *
   * 为什么要判：微信内有两种完全不同的微信支付体验 ——
   *   · 官方 JSAPI：原地弹微信付款面板，没有二维码
   *   · 易支付：跳到第三方收银台，要「长按识别二维码」
   * 两者共用同一个 `wxpay` 这个 id，前端必须靠服务端返回的 `note` 区分，
   * 否则会给 JSAPI 用户弹一个"长按识别二维码"的错误提示。
   *
   * 服务端在官方通道下返回的 note 是「点击后直接唤起微信付款」，
   * 易支付分支的 note 是空串（见 pay_service.py 的 /api/pay/channels）。
   */
  const wxpayOfficial = useMemo(
    () => methods.some((m) => m.id === 'wxpay' && m.note.includes('唤起')),
    [methods],
  );

  /** 服务端明确说"一种支付方式都不可用"时的原因（如「没有找到可用支付账号」）*/
  const [noChannelReason, setNoChannelReason] = useState('');
  /** 微信 Native 生成的二维码（dataURL）+ 对应订单号；Native 权限开通后才用得上 */
  const [qr, setQr] = useState<{ url: string; orderNo: string; tier: PlanId } | null>(null);
  /** 微信内 JSAPI 支付需要 openid（网页授权静默获取） */
  const [openid, setOpenid] = useState<string | null>(null);
  const [inWechat, setInWechat] = useState(false);
  /**
   * 这次进页面是不是"上次付到一半跑掉了又回来"。
   * 只在挂载时读一次 —— 读的是 localStorage 里的现场记录（lib/payResume.ts）。
   */
  const [resumed] = useState(() => Boolean(readPendingPay()));

  /**
   * 问一次服务端能用哪些支付方式。
   *
   * ⚠️ 2026-10-27 修一个**正在误导学生**的 bug：
   *
   *   原来的写法是 `if (r.ok && r.methods.length > 0) { 用服务端的 } else { 兜底两个都可用 }`。
   *   于是**服务端明确回答"没有任何可用通道"（methods: []）时，反而走进了兜底分支**，
   *   把支付宝和微信都标成 `available: true`。
   *
   *   学生看到的：两个选项都正常 → 点「确认支付」→ 平台回「没有找到可用支付账号」。
   *   我加通道探测的初衷就是"通道不可用就别让人点"，结果被这段兜底整个抵消掉了。
   *
   * 现在把两种失败**分开**：
   *
   *   ① `r.ok === true && methods.length === 0`
   *      = 服务端**查过了**，明确说没有可用通道 → **诚实显示不可用**，
   *        并把服务端给的原因（如「没有找到可用支付账号」）原样带出来。
   *   ② `r.ok === false`
   *      = 接口本身没通（网络抖动 / 服务重启）→ 这时候不知道真相，
   *        仍然兜底给两个选项（宁可让学生试一次，也别因为一次抖动就关掉收款）。
   *
   * 判据的差别：**"查过了没有" 和 "没查成" 是两件事，不能都当成"没有"。**
   */
  useEffect(() => {
    void (async () => {
      const r = await fetchPayChannels();
      const isWx = /micromessenger/i.test(navigator.userAgent);

      if (r.ok) {
        // 服务端答复是可信的 —— 无论有几种，都照它说的来
        setInWechat(r.in_wechat);
        setMethods(r.methods);
        if (r.methods.length > 0) {
          // 2026-10-30：不再"优先选支付宝" —— 现在只有微信可用，硬选支付宝
          // 会留一个不在列表里的选中态（点确认支付必然 503）。
          // 规则改成：当前选中项还在列表里就保留，否则落到第一个。
          const first = r.methods[0];
          setMethod((cur) => (
            cur && r.methods.some((m) => m.id === cur) ? cur : (first.id as PayType)
          ));
        } else {
          // 一种都没有 —— 把服务端的原因留下来给用户看
          const reason = r.all.find((m) => m.note)?.note ?? '';
          setNoChannelReason(reason);
        }
      } else {
        // 接口没通：不确定真相，兜底只给「微信」。
        //
        // 2026-10-30 起只保留官方通道（易支付已下线），而支付宝官方还没签约 ——
        // 兜底里再摆一个支付宝，学生点了必然失败。宁可只显示一条确定能付的路。
        setInWechat(isWx);
        const fallback: PayMethod[] = [
          { id: 'wxpay', label: '微信支付', available: true, note: '' },
        ];
        setMethods(fallback);
        setMethod((cur) => cur ?? (fallback[0].id as PayType));
      }
      setChannelsLoaded(true);
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    if (session) {
      const [mm, oo] = await Promise.all([myMembership(), myOrders()]);
      setM(mm);
      setOrders(oo);
    } else {
      setM({ logged_in: false });
      setOrders([]);
    }
    setLoading(false);
  }, [session]);

  useEffect(() => { load(); }, [load]);

  /**
   * 付款确实到账后的收尾（2026-10-28）。
   *
   * 三条路都会汇到这里：平台回调后主动查单、从收银台跳回来的自动确认、
   * 扫码后的轮询。统一收尾的好处是**成功弹窗的触发条件只有一个** ——
   * 必须是 `recheckOrder` 明确回答 paid，绝不在"刚点完支付"时就弹，
   * 否则会出现"弹了成功但会员没开"这种最伤信任的假象。
   *
   * 这里顺手把页面上跟"还没付"有关的状态全部清掉（选中态、订单、面板）：
   * 否则弹窗关掉之后，下面还摊着一个同方案的「确认订单」面板，
   * 学生会以为没付成功、又付一次。
   */
  const finishPaid = useCallback(async (tier: PlanId | null, orderNo?: string | null) => {
    setOrder(null);
    setChosen(null);
    setQr(null);
    setAwaitingNo(null);        // 停下轮询
    setPanelOpen(false);
    setNotice('');
    clearPendingPay();          // 付完了就别再把人往这页送

    // 自己拉一次最新数据（不再走 load()，因为这里要用返回的订单算"有效期起算点"）
    const [mm, oo] = await Promise.all([myMembership(), myOrders()]);
    setM(mm);
    setOrders(oo);
    setLoading(false);

    /*
     * 有效期起算点 = 这笔订单的 paid_at（2026-10-30）。
     *
     * 为什么不直接用「现在」：支付宝/微信的 paid_at 是平台时间，学生手机时间可能偏几分钟，
     * 跨零点时用"现在"会把起始日算成第二天，看起来像多给了一天。
     * 找不到就退回当前时间 —— 宁可差几分钟，也不能空着。
     */
    const hit = orderNo
      ? oo.find((o) => o.order_no === orderNo)
      : oo.find((o) => o.status === 'paid' && o.paid_at);
    setPaidAt(hit?.paid_at ?? new Date().toISOString());

    setPaidTier(tier);
    setSuccessOpen(true);
  }, []);

  // 诊断：确认「授权回来后的 hash 跳转」是否真的把用户送到了会员页（2026-10-27）
  useEffect(() => {
    reportDiag('membership_mounted', { hash: window.location.hash });
  }, []);

  /**
   * 微信内：进页面就静默拿 openid（2026-10-27）。
   *
   * JSAPI 下单必须要 openid。它靠网页授权拿，而**授权会让页面重新加载** ——
   * 所以不能在"点确认支付"时才去授权，那样学生点一下页面就跳走了。
   *
   * 正确做法：一进会员页（微信内）就 `snsapi_base` 静默授权（用户无感、不弹框），
   * 回来后 openid 缓存在 sessionStorage，付款时直接用。
   * 拿不到也照常显示页面，点付款时会再试一次。
   */
  useEffect(() => {
    if (!inWechat) return;
    /*
     * 嵌在个人主页 tab 里时**绝不自动跳授权**（2026-10-28 审计发现）。
     *
     * 微信 OAuth 是整页跳转。这个 effect 原来在"打开会员页且没 openid"时
     * 静默跳一次，独立页面下还能接受；但现在会员界面长在「个人资料 → 会员」
     * 里，用户只是点个 tab 看看档位，就被整页弹走、回来还落在独立会员页 ——
     * 正是用户这次抱怨的"点会员直接跳到另一个界面"。
     *
     * 需要 openid 的真正时刻是"点确认支付"，confirmPay 里有 need_openid 分支会补跳，
     * 所以这里直接返回不会导致付不了款。
     */
    if (embedded) return;
    void (async () => {
      /*
       * 2026-10-27 改：这里**不再自己跳授权**，只读缓存。
       *
       * 授权改由 App 层统一处理（`captureWechatOpenidOnBoot`）——
       * 因为 redirect_uri 现在是根路径，回调落在**首页**，会员页可能还没挂载。
       * 若这里也跳授权，会出现"进会员页就跳走"和"App 层同时跳"两个入口抢着跳。
       *
       * 真正需要授权时（点付款发现没 openid），confirmPay 里会跳一次；
       * 回来后 App 层捕获 openid 并自动带回会员页。
       */
      /*
       * 取 openid 的三级优先（2026-10-27 定稿）：
       *
       *   ① 服务端（账号上绑过的）—— **最优**，登录用户完全不跳转
       *   ② sessionStorage 缓存     —— 本次微信会话内有效
       *   ③ 都没有 → 静默授权一次，拿到后**立刻回写服务端**
       *
       * 这样 openid 只在「这个账号第一次在微信里支付」时拿一次，
       * 之后永久免授权。用户反馈的"支付流程老是跳"就是从这根治的。
       */
      const fromServer = await fetchMyOpenid();
      if (fromServer) {
        cacheOpenid(fromServer);
        setOpenid(fromServer);
        reportDiag('openid_from_server', {});
        return;
      }

      const openidNow = await resolveWechatOpenid();
      if (openidNow) {
        setOpenid(openidNow);
        void bindOpenidToAccount(openidNow);   // 顺便存到账号，下次免授权
        return;
      }

      /*
       * 前两级都没有 → **现在就静默授权**（2026-10-27 再改）。
       *
       * 为什么不在"点档位"或"点支付"时才授权：
       * 微信 OAuth 是**整页跳转**，无论放在哪个操作点上，用户都会看到
       * "点了一下，页面跳回首页"的打断感。实测用户两次反馈这个问题。
       *
       * 正确的时机是**用户还没操作时** —— 打开会员页就把 openid 备好，
       * 之后选档位、点支付全程不跳转。
       *
       * 代价：进会员页会静默跳一次（snsapi_base 不弹授权框，只重载页面）。
       * 但这个代价发生在"页面刚打开"，比发生在"我要付钱"时轻得多。
       *
       * oauthTriedTooMany() 兜底：真授权不通时别无限跳，直接放弃让用户用别的路径。
       */
      if (oauthTriedTooMany()) return;
      const url = await fetchWechatOAuthUrl('/#/membership');
      if (url) window.location.href = url;
    })();
    /*
     * ⚠️ 2026-10-27 修：依赖**必须**是 [inWechat]，不能是 []。
     *
     * `inWechat` 的初值是 false，要等 fetchPayChannels 返回才知道是不是微信内。
     * 依赖写 [] 时，首次执行会因为 `if (!inWechat) return` 直接退出，
     * 而等 inWechat 变成 true 之后这个 effect **再也不会重跑** ——
     * 于是 openid 永远是 null，create 永远返回 400 need_openid。
     * 用户看到的就是"点确认支付毫无反应"（其实是在反复跳授权 / 被防死循环拦住）。
     */
  }, [inWechat, embedded]);

  /**
   * 授权回来：把用户"刚才选的那一档"恢复出来（2026-10-27）。
   *
   * pickPlan 里跳授权前会记下 tier，这里回来后自动选中并展开确认面板 ——
   * 用户感觉就是"选完档位、页面闪了一下、继续"。
   */
  const resumePlanRef = useRef(false);
  useEffect(() => {
    if (!openid || resumePlanRef.current) return;
    let tier: PlanId | null = null;
    try {
      const raw = sessionStorage.getItem('ctbu:wx-resume-plan');
      if (raw) { tier = raw as PlanId; sessionStorage.removeItem('ctbu:wx-resume-plan'); }
    } catch { /* 忽略 */ }
    if (!tier) return;
    resumePlanRef.current = true;
    reportDiag('resume_plan', { tier });
    setChosen(tier);
    setPanelOpen(true);
  }, [openid]);

  /**
   * 授权回来自动续付（2026-10-27）。
   *
   * 场景：用户点了「确认支付」→ 没有 openid → 跳微信授权（整页跳转，现场全丢）
   * → 回来 openid 有了，但用户得再点一次才付 —— 实测用户以为"失败了"。
   *
   * 这里在 openid 就绪后检查有没有存下的待付意图，有就**自动接着付**，
   * 让用户整个流程只需要点一次。
   *
   * 保护：意图带 10 分钟有效期（见 savePendingIntent），取走即删，
   * 所以不会出现"半小时后莫名扣款"或重复下单。
   */
  const autoResumedRef = useRef(false);
  useEffect(() => {
    if (!openid || autoResumedRef.current) return;
    const intent = takePendingIntent();
    if (!intent) return;
    autoResumedRef.current = true;
    reportDiag('auto_resume_pay', { orderNo: intent.orderNo, tier: intent.tier });
    const t = { no: intent.orderNo, tier: intent.tier as PlanId, cents: intent.cents };
    setOrder(t);
    setChosen(t.tier);
    setPanelOpen(true);
    // 显式把订单传进去：不依赖 state 是否已生效，避免重复下单
    window.setTimeout(() => { void confirmPay(t); }, 60);
    // confirmPay 是稳定的回调（内部只依赖 ref/state 快照），不放进依赖避免重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openid]);

  /**
   * 二维码出现后自动轮询查单（2026-10-27）。
   *
   * 学生扫码付完，如果平台回调慢或丢了，页面会一直停在"待付款"看着像坏了。
   * 这里每 5 秒主动问一次（最多 2 分钟），成功就自动开通 + 清掉二维码。
   * Native 权限开通后才会走到这里，但先把逻辑备好，届时只改配置即可。
   */
  /**
   * 等付款结果：统一轮询（2026-10-30 重做）。
   *
   * 以前只有"二维码弹层开着"才轮询（依赖 `qr`），带来两个真实的漏：
   *   ① 学生关掉二维码弹层去扫码，页面就彻底不再问 —— 付了也没人知道；
   *   ② 支付宝电脑网站支付是**整页跳到收银台**，回来时组件重新挂载，
   *      从来没有启动过轮询。
   *
   * 现在改成依赖 `awaitingNo`：只要有"一笔正在等结果"的单子就轮询，
   * 与弹层开不开、页面怎么回来的都无关。
   */
  useEffect(() => {
    if (!awaitingNo) return;
    let cancelled = false;
    let tries = 0;

    const tick = async () => {
      if (cancelled) return;
      // 页面在后台就不打接口 —— 学生切到支付宝/微信 App 付款时正是这个状态
      if (document.visibilityState === 'hidden') return;
      tries += 1;
      if (tries > 60) {           // ≈5 分钟后停止自动问，避免无意义轮询
        setAwaitingNo(null);
        return;
      }
      const r = await recheckOrder(awaitingNo);
      if (cancelled) return;
      if (r.ok && r.status === 'paid') {
        await finishPaid(null, awaitingNo);
      }
    };

    const timer = window.setInterval(() => void tick(), 5000);
    /*
     * 从微信付款面板切回来时立刻查一次，不要让学生干等 5 秒。
     * （支付宝是整页跳转，不涉及这条路径，但微信 JSAPI / 扫码都用得上。）
     */
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVis);
    void tick();                  // 进来先问一次

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [awaitingNo, finishPaid]);

  /**
   * 付完回来：直接看订单表判断"刚付成功且还没提示过"，立刻弹窗（2026-10-30）。
   *
   * 这条是补上面轮询的"来不及"：
   *   支付宝付完会跳回本站，而平台回调往往在**跳回之前**就已经到了，
   *   数据库里那笔订单已经是 `paid`。原来的"自动确认"只找 `status === 'pending'`
   *   的订单 —— 已 paid 的直接被跳过，于是出现"钱付了、会员开了、页面一句话没有"。
   *   用户遇到的就是这个。
   *
   * 判据三条同时满足才弹：已支付 / 支付时间在 30 分钟内 / 这笔没弹过窗。
   * 「没弹过」记在 localStorage，避免每刷新一次就弹一次。
   */
  useEffect(() => {
    if (!session || orders.length === 0) return;
    const now = Date.now();
    const fresh = orders.find((o) => {
      if (o.status !== 'paid' || !o.paid_at) return false;
      const t = new Date(o.paid_at).getTime();
      if (!Number.isFinite(t) || now - t > 30 * 60 * 1000) return false;
      return !isPaidNotified(o.order_no);
    });
    if (!fresh) return;
    markPaidNotified(fresh.order_no);
    void finishPaid((fresh.tier as PlanId) ?? null, fresh.order_no);
  }, [session, orders, finishPaid]);

  /** 订单列表里最近一笔待支付订单 —— 从收银台跳回来时靠它恢复现场 */
  const pendingOrder = useMemo(() => {
    const p = orders.find((o) => o.status === 'pending');
    return p ? { no: p.order_no, tier: p.tier as PlanId, cents: p.amount_cents } : null;
  }, [orders]);

  /**
   * 待确认的方案：学生刚点的那个（还没建单）。
   * 已经有订单时不再显示草稿，避免同一个面板出现两份金额。
   */
  const draft = useMemo(() => {
    if (order || pendingOrder) return null;
    if (!chosen) return null;
    const p = PLANS.find((x) => x.id === chosen);
    return p ? { tier: p.id as PlanId, cents: p.priceCents } : null;
  }, [chosen, order, pendingOrder]);

  /** 支付面板要展示的对象：优先已建单的，其次刚选中的方案 */
  const payTarget = order ?? pendingOrder ?? draft;
  /** 这份金额是否已经有订单号了（决定按钮文案是「确认支付」还是「去付款」） */
  const hasOrderNo = Boolean(order || pendingOrder);

  /**
   * 主动查单：问支付平台这笔到底付了没，付了就当场开通。
   *
   * `tierHint` 只是给成功弹窗显示"买的是哪一档"用的，不影响开通逻辑本身
   * （开通是服务端按订单做的）。所以拿不到也不传，弹窗里就只显示有效期。
   */
  const checkPaid = useCallback(async (orderNo: string, quiet = false, tierHint?: PlanId) => {
    if (busy) return;
    setBusy(true);
    if (!quiet) setNotice('');
    const r = await recheckOrder(orderNo);
    setBusy(false);
    if (r.ok && r.status === 'paid') {
      await finishPaid(tierHint ?? null, orderNo);
      return;
    }
    if (r.ok) {
      if (!quiet) {
        setNotice('支付平台还没收到这笔款。刚付完可以等 10 秒再点一次；已付款超过 1 分钟仍没开通，请联系管理员。');
      }
      return;
    }
    // 进页面时的自动查单是"顺手确认"，失败不该弹红字吓人 —— 学生根本没点任何东西。
    // 只有他自己按了「我已完成付款」才把失败说出来。
    if (!quiet) {
      // query_failed = 平台没有可用的"查单"接口（88yyw 这版只有下单接口）。
      // 这时真正靠得住的是平台的异步回调，别把学生引到"反复点按钮"上。
      setNotice(
        r.reason === 'query_failed'
          ? '这笔订单暂时没法在线核对。如果你刚付完，会员通常几秒内会自动到账；超过 10 分钟还没开通，请联系管理员并提供订单号。'
          : '查询支付状态失败，请稍后再试。'
      );
    }
  }, [busy, finishPaid]);

  /** 从收银台跳回来 → 自动确认一次 */
  useEffect(() => {
    if (autoChecked.current || !session || !pendingOrder) return;
    autoChecked.current = true;
    void checkPaid(pendingOrder.no, true, pendingOrder.tier);
  }, [session, pendingOrder, checkPaid]);

  /**
   * 点方案卡片 = **只选中**。
   * 不建单、不跳转 —— 学生要先看见"多少钱、用什么付"，再自己按确认。
   */
  /**
   * 选方案。
   *
   * 🔴 2026-10-27 关键改动：**在这个时刻就把 openid 准备好**。
   *
   * 原来的流程是"点确认支付时才检查 openid"，没有就跳微信授权 ——
   * 而授权是**整页跳转**，用户看到的画面是：点支付 → 页面闪一下（回首页那一瞬）
   * → 回到会员页 → 支付面板才弹出来。用户原话：
   * 「支付弹窗一跳出来，但背后的页面已经跳回首页了」。
   *
   * 实际上 URL 全程都是 #/membership（日志可证），那是整页重载的视觉残影。
   *
   * 现在把授权提前到"选方案"：用户点档位（意图已经很明确）时静默授权一次，
   * 等真正点「确认支付」时 openid 已就绪 → **不跳转、不闪动，直接弹面板**。
   */
  const pickPlan = async (tier: PlanId) => {
    setNotice('');
    setPanelOpen(true);
    if (!session) { navigate({ name: 'login' }); return; }
    setChosen(tier);

    /*
     * ⚠️ 2026-10-28 用户要求：**点档位时不要自动下滑**。
     *
     * 原来这里有一句 `panelRef.scrollIntoView({block:'center'})`，
     * 本意是"点了档位就把确认面板带进视野"，但实际体感是：
     * 手指刚点下去，整个页面自己往下滑一段 —— 像页面在抢控制权。
     * 用户明确说「点击一次会出现自动下滑的问题，把这个改掉，不需要它」。
     *
     * 去掉之后靠"选中态足够明显"来告诉用户点上了（描边 + 轻微放大，见下方卡片样式），
     * 想付款时自己往下滑即可。宁可少一点"聪明"，也不要页面自己动。
     */

    /*
     * 这里**不再跳授权**（2026-10-27）。
     *
     * 授权已经提前到"打开会员页"那一刻做了。用户点档位时 openid 应该就绪，
     * 直接在下方展开确认面板即可。
     *
     * 如果极端情况（缓存被清 / 授权失败）到这里还没有 openid，
     * 也不在这里跳 —— 等用户点「确认支付」时由 confirmPay 兜底处理，
     * 让"需要授权"这件事最多发生在他真正要付款那一刻，而不是选档位时。
     */
  };

  /**
   * 确认支付：真正建单（如果还没有）+ 取收银台地址 + 跳过去。
   * 这是全流程里**唯一**会把学生带走的地方。
   */
  /**
   * @param explicitTarget 明确指定要付哪一单。
   *
   * 为什么需要：授权回来自动续付时，`setOrder()` 刚执行、state 还没生效，
   * 此时读 `order` 拿到的是旧值（null），会走「新建订单」分支 → **重复下单**。
   * 所以自动续付要把订单**显式传进来**，不依赖 state。
   */
  const confirmPay = async (explicitTarget?: { no: string; tier: PlanId; cents: number }) => {
    if (busy) return;
    // 微信里选支付宝是走不通的，别让学生白跳一次
    if (method === 'alipay' && inWechat) {
      setNotice('微信里打不开支付宝。请改选「微信支付」，或点右上角「在浏览器打开」后再选支付宝。');
      return;
    }
    let target = explicitTarget ?? order ?? pendingOrder;
    setBusy(true);
    setNotice('');
    try {
      if (!target) {
        const tier = chosen ?? draft?.tier;
        if (!tier) { setNotice('请先选择方案。'); return; }
        const r = await createPaymentOrder(tier);
        if (!r.ok || !r.order_no) {
          setNotice(
            r.reason === 'too_many_pending'
              ? '你有多个待支付订单，请先把其中一笔付掉，或联系管理员取消后再下单。'
              : '创建订单失败，请稍后重试。'
          );
          return;
        }
        target = { no: r.order_no, tier, cents: r.amount_cents ?? 0 };
        setOrder(target);
      }

      // 微信里选微信支付：先把话说在前头。不然学生点完跳到一个要"长按识别"的
      // 页面，长按没反应就卡住了，根本不知道还有「在浏览器打开」这条路。
      //
      // 🔴 2026-10-27：**只在"跳转第三方收银台"时才弹这个提示**。
      // 微信官方 JSAPI 是原地弹付款面板，压根没有二维码可长按 ——
      // 留着这段会让学生以为要长按识别，反而找不到付款按钮。
      //
      // 判据：`wxpayOfficial` 为真 = 服务端已配微信官方通道且当前在微信内，
      // 此时走 JSAPI，跳过这段提示。（见下方 channels 探测结果）
      if (method === 'wxpay' && isWechatBrowser() && !wxpayOfficial) {
        const go = await confirmDialog(
          '当前为微信内置浏览器环境。\n\n' +
          '微信支付一般可通过长按识别二维码完成；若长按无响应，' +
          '请点击右上角「···」→「在浏览器打开」后再行付款。\n\n' +
          '该订单在有效期内保留，再次通过本链接进入时将返回本页面。',
          { confirmLabel: '继续付款' },
        );
        if (!go) { setBusy(false); return; }
      }

      /*
       * ⚠️ 2026-10-27：openid **不能只信 state**。
       *
       * state 有竞态风险（effect 还没跑完用户就点了付款 / 组件重挂载导致 state 丢失），
       * 而 sessionStorage 里的才是已经换到手的真值。
       * 所以发请求前再读一次缓存，优先级：缓存 > state。
       */
      const freshOpenid = readCachedOpenid() ?? openid;
      // 排查期把 openid 原样报上来 —— 只有拿到真实 openid 才能在服务器上直接调
      // create_jsapi，验证「商户号与 AppID 是否已绑定」这个最可疑的点。
      // （openid 是用户在本服务号下的标识，不是密码；诊断接口排查完会删。）
      reportDiag('confirm_pay_start', {
        method, stateOpenid: Boolean(openid), freshOpenid: Boolean(freshOpenid),
        openid: freshOpenid || '(none)',
      });
      if (freshOpenid && freshOpenid !== openid) setOpenid(freshOpenid);
      const pay = await createPaySession(target.no, method ?? undefined, freshOpenid);
      if (pay.ok) {
        /*
         * 从这里开始"等这一单的结果"（2026-10-30）。
         * 放在渠道分支**之前**，因为四种渠道的后续动作完全不同：
         *   JSAPI 原地弹面板 / Native 出二维码 / 支付宝整页跳走。
         * 但无论哪一种，都应该有一条轮询在跑 —— 学生关掉二维码、或者
         * 从支付宝跳回来，都还能收到结果。
         */
        setAwaitingNo(target.no);
        // 跳走之前把现场存下来：学生出去扫一扫、再点链接回来时，
        // App.tsx 会读这条记录把他送回本页（见 lib/payResume.ts 的说明）。
        rememberPendingPay({
          orderNo: target.no, tier: target.tier, cents: target.cents,
          method: method ?? undefined,
        });

        reportDiag('create_ok', { channel: pay.channel, hasJsapi: Boolean(pay.jsapi) });
        // ── 微信官方 JSAPI：原地弹付款面板，不跳转（2026-10-27 上线）──
        // 这是用户要的主路径：微信里点付费 → 直接弹微信付款界面，不用扫码。
        if (pay.channel === 'wechat_jsapi' && pay.jsapi) {
          const r = await wechatJsapiPay(pay.jsapi);
          if (r.ok) {
            resetOauthTries();   // 授权链路是通的，清掉失败计数
            setNotice('付款完成，正在确认…');
            void checkPaid(target.no, true, target.tier);
          } else if (r.reason === 'cancelled') {
            setNotice('已取消付款。订单仍在，可稍后继续。');
          } else if (r.reason === 'no_bridge' || r.reason === 'timeout') {
            setNotice('微信付款组件没能加载起来，请退出重进，或点右上角「在浏览器打开」后再付款。');
          } else {
            setNotice('付款未完成，请重试或联系客服。');
          }
          return;
        }

        // ── 微信 Native（扫码）：2026-10-30 权限已开通，浏览器端主路径 ──
        if (pay.channel === 'wechat_native') {
          if (pay.qr_image) {
            setQr({ url: pay.qr_image, orderNo: target.no, tier: target.tier });
            setNotice('');
          } else {
            // 权限是通的，走到这里说明后端渲染二维码失败（依赖缺失等）
            setNotice('没能生成付款二维码，请重试一次；仍不行请联系客服。');
          }
          return;
        }

        // ── 微信 H5（手机浏览器）：跳转到微信的付款页 ──
        // 与 Native 的区别：H5 是"跳出去付款再跳回来"，Native 是"原地扫码"。
        // 用户的场景要求（2026-10-30）：所有手机浏览器都走 H5，不要给二维码。
        if (pay.channel === 'wechat_h5' && pay.h5_url) {
          gotoCashier(pay.h5_url);
          return;
        }

        // ── 其余渠道：跳转收银台（支付宝官方）──
        if (pay.pay_url) {
          gotoCashier(pay.pay_url);
          return;
        }
        setNotice('下单成功，但没有拿到可用的付款方式，请稍后重试。');
        return;
      }

      // need_openid：微信官方通道已启用但拿不到 openid（授权被拒 / 缓存丢失）。
      // 补一次静默授权，而不是把技术错误甩给学生。
      if (pay.reason === 'need_openid') {
        // ⚠️ 2026-10-27：**已经试过 2 次还拿不到，就别再跳了**。
        // 否则会陷入"点支付 → 跳授权 → 回来还是没有 → 再点再跳"的死循环，
        // 用户只看到页面反复刷新、永远付不了，还以为是网不好。
        // 这种情况几乎一定是配置问题（网页授权域名没配 / AppSecret 不对），
        // 直接说清楚比让他无限刷新有用。
        if (oauthTriedTooMany()) {
          setNotice(
            '微信授权一直没成功（已重试 2 次）。请点右上角「···」→「在浏览器打开」后再付款，' +
            '或稍后重试；若持续不行请联系客服。',
          );
          return;
        }
        setNotice('正在获取微信授权，请稍候…');
        // 授权会整页跳转，把现场冲掉；先记下这一单，回来自动续付
        if (target) {
          savePendingIntent({ orderNo: target.no, tier: target.tier, cents: target.cents });
        }
        const url = await fetchWechatOAuthUrl('/#/membership');
        if (url) { window.location.href = url; return; }
        setNotice('微信授权没成功，请退出重进，或点右上角「在浏览器打开」后再付款。');
        return;
      }
      reportDiag('create_failed', { reason: pay.reason, message: (pay.message || '').slice(0, 120) });
      setNotice(payMessage(pay.reason, pay.message));
    } catch {
      setNotice('网络异常，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(m?.invite_code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* 剪贴板不可用时静默 */ }
  };

  const doCopySupport = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_WECHAT);
      setCopiedSupport(true);
      window.setTimeout(() => setCopiedSupport(false), 2000);
    } catch { /* 剪贴板不可用就让他自己长按复制 */ }
  };

  const doClaimInvite = async () => {
    setBusy(true);
    const r = await claimInviteRewards();
    setBusy(false);
    await load();
    setNotice(
      r && r.months_granted_now > 0
        ? `已发放 ${r.months_granted_now} 个月会员奖励。`
        : `当前有效邀请 ${r?.valid_invites ?? 0} 人，再邀请 ${r?.next_reward_in ?? INVITES_PER_MONTH} 人可得 1 个月。`
    );
  };

  if (loading) {
    return (
      <div className="pt-24 pb-20 min-h-screen flex items-start justify-center">
        <Loader2 className="w-5 h-5 text-gray-700 animate-spin" />
      </div>
    );
  }

  const isMember = Boolean(m?.is_member);
  const valid = m?.invite?.valid_invites ?? 0;
  const toNext = m?.invite?.next_reward_in ?? INVITES_PER_MONTH;
  const invitePct = Math.round(((INVITES_PER_MONTH - toNext) / INVITES_PER_MONTH) * 100);

  return (
    <div className={embedded ? '' : 'min-h-screen bg-page pb-24 pt-[73px]'}>
      {/*
        微信 Native 扫码弹层（2026-10-30 补）。

        ⚠️ 之前 `qr` 这个状态**只被 set、从来没有渲染**：Native 下单成功后
           页面什么都不显示（按钮变回「确认支付」），学生以为卡住了。
           也就是说电脑端的扫码主路径一直是死的 —— 后端能出 code_url，
           前端却没地方显示。这次补上。

        手机浏览器也会走到这里（H5 权限批不下来，见交接 §1.1），
        所以文案要兼顾「拿另一台手机扫」和「长按识别」两种情况。
      */}
      {qr && (
        <ModalShell
          open
          onClose={() => setQr(null)}
          labelledBy="pay-qr-title"
          panelClassName="w-full max-w-sm rounded-2xl bg-ink-850 p-6 text-center shadow-2xl"
        >
          <h3 id="pay-qr-title" className="text-base font-semibold text-gray-900">微信扫码支付</h3>
          <p className="mt-1 text-sm text-gray-500">
            {(() => {
              const plan = PLANS.find((p) => p.id === qr.tier);
              return plan ? `${plan.name} · ¥${formatYuan(plan.priceCents)}` : '';
            })()}
          </p>
          <img
            src={qr.url}
            alt="微信支付二维码"
            width={208}
            height={208}
            className="mx-auto mt-4 h-52 w-52 rounded-xl bg-white p-2"
          />
          <p className="mt-4 text-sm leading-relaxed text-gray-600">
            请用微信「扫一扫」完成付款，付完会自动开通本页权益。
          </p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            如果你就在手机上操作：可长按上方二维码识别；识别不了请在微信里打开本站。
          </p>
          <div className="mt-5 flex gap-2">
            <button
              onClick={() => setQr(null)}
              className="flex-1 rounded-lg border border-hairline/[0.08] px-4 py-2.5 text-sm text-gray-600 transition-colors hover:bg-solid-hover/[0.03]"
            >
              关闭
            </button>
            <button
              onClick={() => void checkPaid(qr.orderNo, false, qr.tier)}
              className="flex-1 rounded-lg bg-solid px-4 py-2.5 text-sm font-medium text-on-solid transition-colors hover:bg-solid-hover"
            >
              我已完成付款
            </button>
          </div>
        </ModalShell>
      )}
      <div className={embedded ? '' : 'max-w-3xl mx-auto px-5 sm:px-8'}>

        {/* 返回首页：只在独立路由页出现。嵌在个人主页 tab 里时「返回」没有意义 —— 
            用户本来就在自己的页面里，再给一个"返回首页"只会让人以为跳走了。 */}
        {!embedded && (
          <button
            onClick={() => navigate({ name: 'home' })}
            className="mt-8 mb-10 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> 返回首页
          </button>
        )}

        {/* 标题区：左对齐，不居中。
            嵌入式就把上方留白收掉 —— 上面紧接着就是个人页的 tab 栏，不需要再空一大段。 */}
        <header className={embedded ? 'mb-8' : 'mb-12'}>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-400">Membership</p>
          <h1 className="mt-1.5 text-[26px] font-medium tracking-[-0.03em] text-gray-900">会员</h1>
          <p className="mt-2.5 max-w-[52ch] text-[14px] leading-relaxed text-gray-500">
            免费额度用完后再看真题，需要开通会员。价格按覆盖成本定的，不为盈利。
          </p>
        </header>

        {/* 当前状态 */}
        <section className="mb-12">
          <div className="rounded-xl border border-hairline/[0.08] bg-ink-850 p-6 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)]">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-4">
                {/*
                  ⚠️ 2026-10-28 用户报的 bug：「暗黑模式下当前身份前面的图标和
                  ‘你已是永久会员’左边的图标颜色不一致」。
                  根因是这里写死了 `bg-amber-50` —— **amber-50 没被主题变量重映射**
                  （只有 gray 那一条被重映射过），它在深色主题下仍是近白的米色，
                  于是同一个 ∞ 图标：上面是"米白底 + 灰字"，下面是"透明底 + 亮字"。
                  现在两处统一成「10% 琥珀底 + amber-600 图标」，深浅主题都对得上。
                */}
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                  m?.is_lifetime ? 'bg-amber-400/[0.10]' : isMember ? 'bg-elevate/[0.06]' : 'bg-elevate/[0.03]'
                }`}>
                  {m?.is_lifetime
                    ? <InfinityIcon className="w-5 h-5 text-amber-600" />
                    : isMember ? <Crown className="w-5 h-5 text-gray-700" /> : <Clock className="w-5 h-5 text-gray-500" />}
                </div>
                <div>
                  <p className="text-xs text-gray-500">
                    {m?.logged_in ? '当前身份' : '未登录'}
                  </p>
                  <p className="text-lg font-semibold text-gray-900 mt-0.5">
                    {m?.logged_in ? tierLabel(m.tier) : '登录后可查看会员状态'}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    {m?.logged_in ? `有效期：${formatExpiry(m)}` : '登录后免费额度会记录在你的账号上'}
                  </p>
                </div>
              </div>

              {m?.is_founder && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-400/[0.10] px-3 py-2 rounded-lg">
                  <BadgeCheck className="w-4 h-4" />
                  {/*
                    2026-10-30 修：这句原来写死「前 100 名免费试用 1 个月」，
                    而下面那张卡片对永久账号写的是「已永久免费」—— 同一页两句话打架。

                    背景：创始会员有过两套规则。
                      · 2026-10-20 15:15 之前注册的 → membership_expires_at='infinity'（永久）
                      · 之后注册的 → now() + 1 month（试用），后来统一延到 2026-12-31
                    用户当时明确「已有 founder 保持永久，只让新注册的按 1 个月」，
                    所以老号（infinity）必须显示「永久免费」，不能对他说只试用 1 个月。
                  */}
                  {/*
                    创始会员徽标（2026-10-30 按用户要求重排优先级）。

                    规则（从高到低，与到期逻辑严格对应）：
                      ① 永久权益（expires = infinity）
                         ← 管理员手动授予，或「创始永久 → 单月」机制调整前注册的老账号
                         → 只说「永久免费」，**不再提"前 N 名"**。
                           把"名额"和"永久"连在一起会让人以为前 200 名都永久，
                           实际只有极少数（老账号/手动授予）是这样。

                      ② 已付费延长（tier 不再是 founder）
                         → 只说"创始会员"，到期时间由「有效期」那行如实显示。

                      ③ 仍在试用（tier = founder 且非永久）
                         → 明说是"前 200 名 · 免费试用至 2026 年 12 月 31 日"。
                  */}
                  {m?.is_lifetime
                    ? '创始会员 · 永久免费'
                    : m?.tier === 'founder'
                      ? `创始会员 · 前 ${FOUNDER_SLOTS} 名 · 免费试用${FOUNDER_TRIAL}`
                      : '创始会员'}
                </span>
              )}
            </div>

            {!m?.logged_in && (
              <button
                onClick={() => navigate({ name: 'login' })}
                className="mt-5 w-full rounded-lg bg-solid px-5 py-3 text-[14px] font-medium text-on-solid transition-colors hover:bg-solid-hover sm:w-auto"
              >
                登录 / 注册
              </button>
            )}
          </div>
        </section>

        {/* 已是永久会员（含创始会员）：不再展示购买入口。
            之前对所有人一视同仁地显示付费按钮，导致一位「创始会员（永久免费）」
            真的付了 ¥3.8 —— 这是实际发生过的损失，必须拦住。 */}
        {m?.is_lifetime && (
          <section className="mb-12">
            <div className="rounded-xl border border-hairline/[0.08] p-6">
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-amber-400/[0.10] flex items-center justify-center shrink-0">
                  <InfinityIcon className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-base font-medium text-gray-900">
                    {/* 书面表述（2026-10-30）：原来写「你是创始会员，已永久免费」，
                        这是正式权益说明，用第二人称显得随意 */}
                    {m.is_founder ? '本账号已获创始会员永久免费权益' : '本账号已开通永久会员'}
                  </p>
                  <p className="text-sm text-gray-500 mt-2 leading-relaxed max-w-[46ch]">
                    无需再次付费，站内全部资料长期可查阅。
                    会员权益随账号保留，不受后续调价影响。
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 定价（仅对尚未永久免费的账号显示）*/}
        {!m?.is_lifetime && (
        <section className="mb-12">
          <h2 className="mb-2 text-[20px] font-medium tracking-[-0.025em] text-gray-900">选择方案</h2>
          <p className="text-sm text-gray-500 mb-6">
            定价覆盖运营成本 · 一次付费 · 长期维护
          </p>

          {/*
            三档并排（2026-10-27 重做）
            ------------------------------------------------------------
            用户要求：「没必要搞得非常粗非常宽，能不能并排坐」「让确认支付和三个档位
            在同一个手机界面上，不用往下滑」。

            改前：`grid gap-3 sm:grid-cols-3` —— `sm:` 是 ≥640px 才三列，
                  **手机上其实是一列纵向堆叠**，三张卡片 p-5 撑得很高，
                  把「确认支付」顶到屏幕外。
            改后：手机上也 `grid-cols-3`，卡片瘦身到 p-3，
                  内容从「名称/价格/周期/说明」四行压到三行，说明去掉
                  （`desc` 挪到面板里显示，那里本来就有金额和方案）。

            选中态（2026-10-28 用户改稿）
            ------------------------------------------------------------
            用户原话：「我感觉这个特效并不是很好，最好是轻微放大加一个边框」。
            所以把上一版那套"上浮 + 顶部细线 + 价格字号变大 + 背景提亮"全部撤掉 ——
            那几个效果叠在一起，看着像卡片在跳，而且价格字号变大会让三张卡的
            数字互相不对齐（同一行数字粗细不同，最显廉价）。

            现在只做两件事，且只动 transform / border，不触发重排：
              · 放大到 1.02（幅度小到像"被按实"，不像"弹起来"）
              · 边框换成实心 accent（唯一强调色，只给当前选中）
            文字色仍然从 gray-600 → gray-900，作为"这一张是活的"的补充信号。
          */}
          <div className="grid grid-cols-3 gap-2">
            {PLANS.map((p) => {
              const isChosen = chosen === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => void pickPlan(p.id)}
                  disabled={busy}
                  aria-pressed={isChosen}
                  className={`relative rounded-xl border text-left p-3 transition-[transform,border-color,background-color] duration-150 ease-out will-change-transform disabled:opacity-60 ${
                    isChosen
                      ? 'border-accent bg-elevate/[0.05] scale-[1.02]'
                      : 'border-hairline/[0.08] bg-ink-850 hover:border-hairline/[0.22] hover:bg-ink-800'
                  }`}
                >
                  <p className={`text-[11px] font-medium tracking-[-0.01em] transition-colors ${
                    isChosen ? 'text-gray-900' : 'text-gray-600'
                  }`}>
                    {p.name.replace('会员', '')}
                  </p>
                  <p className="mt-2 font-mono text-[20px] leading-none tracking-[-0.02em] tabular-nums text-gray-800">
                    <span className="text-[11px] text-gray-500">¥</span>{p.price}
                  </p>
                  {/*
                    第三行用 desc 而不是 unit（2026-10-27 用户反馈）。
                    unit 是「1 个月 / 12 个月 / 永久有效」—— 和上面的档位名
                    （单月 / 年度 / 永久）完全重复，等于白占一行。
                    换成有信息量的一句：先试一个月 / 月均 ¥0.73 / 一次买断。
                  */}
                  <p className="mt-1.5 text-[10px] leading-tight text-gray-500 tabular-nums">{p.desc}</p>
                  {p.highlight && !isChosen && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-amber-400/15 px-1 py-[1px] font-mono text-[9px] text-amber-600">荐</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 面板展开时提示在面板里显示，避免两处重复 */}
          {notice && !(panelOpen && payTarget) && (
            <p className="mt-4 text-sm text-gray-500 leading-relaxed">{notice}</p>
          )}
        </section>
        )}


        {/*
          确认支付面板（2026-10-21 重做）
          --------------------------------------------------------------
          学生点方案后落在这里，而不是被直接拉进支付宝：
            金额 / 方案 / 订单号 → **支付方式二选一** → 「确认支付」
          订单号只在已经建单后才显示（草稿阶段还没有单号）。
        */}
        {panelOpen && payTarget && !m?.is_lifetime && (
          <section className="mb-12" ref={panelRef}>
            <div className="rounded-xl border border-hairline/[0.12] bg-ink-850 p-4 sm:p-5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.07)]">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-5 h-5 text-gray-700" />
                <h2 className="text-base font-semibold text-gray-900">
                  {hasOrderNo ? '确认支付' : '确认订单'}
                </h2>
              </div>

              {/* 上次付到一半出去了，现在回来了 —— 先给一句定心话 */}
              {resumed && hasOrderNo && (
                <p className="mb-3 text-[12px] leading-relaxed text-emerald-600">
                  上次的订单仍在有效期内，可直接继续付款。
                </p>
              )}

              {/*
                微信内已改用官方 JSAPI（原地弹面板，没有二维码），
                原来那段"长按识别二维码 / 去浏览器打开"的说明已经过时且占地方，
                压缩成一行提示，只保留"授权后会自动回来"这句有用的。
              */}
              {inWechat && (
                <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
                  微信内将直接弹出付款面板；授权后会自动回到本页。
                </p>
              )}

              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">应付金额</dt>
                  <dd className="font-semibold text-gray-900">¥{formatYuan(payTarget.cents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">方案</dt>
                  <dd className="text-gray-900">{tierLabel(payTarget.tier)}</dd>
                </div>
                {'no' in payTarget && payTarget.no && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500 shrink-0">订单号</dt>
                    <dd className="font-mono text-xs text-gray-900 break-all text-right">{payTarget.no}</dd>
                  </div>
                )}
              </dl>

              {/* ── 支付方式 ── */}
              <div className="mt-6">
                <p className="text-sm text-gray-500 mb-3">支付方式</p>
                {!channelsLoaded ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> 正在获取可用方式…
                  </div>
                ) : methods.length === 0 ? (
                  /*
                    服务端**查过了**，明确说一种支付方式都不可用（2026-10-27）。
                    这里必须说清"是通道维护，不是你的问题"，并给出可执行的下一步 ——
                    否则学生只会觉得网站坏了就走了。
                  */
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
                    <p className="text-sm leading-relaxed text-gray-800">
                      支付通道正在维护，暂时无法付款。
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
                      {noChannelReason
                        ? `通道返回：${noChannelReason}。`
                        : ''}
                      这不是你的账号问题。可以稍后再试，或联系客服 QQ{' '}
                      <strong className="select-all text-gray-800">{APPEAL_QQ}</strong>
                      （工作时间内会尽快恢复）。
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {methods.map((opt) => {
                      const active = method === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => { setMethod(opt.id as PayType); }}
                          className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                            active
                              ? 'border-hairline/[0.30] bg-elevate/[0.06]'
                              : 'border-hairline/[0.08] hover:border-hairline/[0.2] hover:bg-solid-hover/[0.03]'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                              active ? 'border-gray-900' : 'border-gray-300'
                            }`}
                          >
                            {active && <span className="h-2 w-2 rounded-full bg-gray-900" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm text-gray-900">{opt.label}</span>
                            {opt.note && (
                              <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">{opt.note}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/*
                2026-10-28 改文案：原来写"支付通道可能对标价作出几分钱的细微调整"。
                那句话在 2026-10-15 关掉金额尾数**之后就已经不成立了**（应付金额 = 标价），
                留着它等于先给学生一个"可能多收"的预期 —— 这类含糊其辞最伤信任。
                现在只陈述事实：付多少、什么时候到账、出问题找谁。
              */}
              <p className="mt-5 text-xs text-gray-500 leading-relaxed">
                <Lock className="mr-1 inline h-3 w-3 align-[-1px]" />
                点击「确认支付」后会跳转到收银台，实付金额与上方标价一致，
                <span className="text-gray-900 font-medium">没有手续费，也不会多收</span>。
              </p>
              <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                付款成功后会员资格<span className="text-gray-900 font-medium">自动开通</span>，通常在 10 秒内生效。
                若已付款但未开通，点「我已完成付款」会立即向支付平台核对一次；
                仍未到账请联系客服 QQ{' '}
                <strong className="select-all text-gray-800">{APPEAL_QQ}</strong>
                （提供订单号，我们会核对后手工开通）。
              </p>
              {/* 支付平台审核要求站内有明确的售后规则，这里指向服务条款（2026-10-30） */}
              <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                完成支付即表示您已阅读并同意
                <button
                  type="button"
                  onClick={() => navigate({ name: 'terms' })}
                  className="mx-0.5 text-gray-800 underline underline-offset-2"
                >
                  《会员服务条款》
                </button>
                ，其中载明退款条件与内容使用范围。
              </p>

              {notice && (
                <p className="mt-4 rounded-lg border border-hairline/[0.08] bg-elevate/[0.03] px-4 py-3 text-sm leading-relaxed text-gray-700">
                  {notice}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={() => void confirmPay()}
                  disabled={busy || methods.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-solid px-6 py-3 text-[14px] font-medium text-on-solid transition-all hover:bg-solid-hover active:scale-[0.98] disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />}
                  {busy ? '处理中…' : hasOrderNo ? '确认支付' : '确认订单并支付'}
                </button>
                {'no' in payTarget && payTarget.no && (
                  <button
                    onClick={() => checkPaid(payTarget.no, false, payTarget.tier)}
                    disabled={busy}
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] disabled:opacity-50 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    我已完成付款
                  </button>
                )}
                <button
                  onClick={() => {
                    setPanelOpen(false);
                    setNotice('');
                    setChosen(null);
                    // 收起 = 「我现在不付」。把"回来就跳回本页"的现场清掉，
                    // 否则学生只是随便逛逛也会被一直送回会员页。
                    clearPendingPay();
                    if (!order && !pendingOrder) setOrder(null);
                  }}
                  className="px-5 py-3 rounded-lg border border-hairline/[0.08] text-sm text-gray-500 hover:bg-solid-hover/[0.03] transition-colors"
                >
                  收起
                </button>
              </div>
            </div>
          </section>
        )}

        {/* 邀请 */}
        <section className="mb-12">
          <h2 className="mb-2 text-[20px] font-medium tracking-[-0.025em] text-gray-900">邀请同学</h2>
          <p className="text-sm text-gray-500 mb-6">
            每邀请 {INVITES_PER_MONTH} 位同学注册成功，你得 1 个月会员，可以一直累积。
          </p>

          <div className="rounded-xl border border-hairline/[0.08] p-6">
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-elevate/[0.03] flex items-center justify-center shrink-0">
                <Users className="w-5 h-5 text-gray-500" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="text-sm text-gray-500">有效邀请</p>
                  <p className="text-sm text-gray-900">
                    <span className="text-lg font-semibold">{valid}</span> 人
                  </p>
                </div>

                <div className="mt-3 h-1.5 rounded-full bg-elevate/[0.03] overflow-hidden">
                  <div className="h-full bg-accent transition-all" style={{ width: `${invitePct}%` }} />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  再邀请 {toNext} 人可得 1 个月
                  {m?.invite_months_granted ? ` · 已累计获得 ${m.invite_months_granted} 个月` : ''}
                </p>
              </div>
            </div>

            {m?.invite_code && (
              <div className="mt-6 pt-6 border-t border-hairline/[0.08]">
                <p className="text-xs text-gray-500 mb-2">你的专属邀请链接</p>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="text-xs text-gray-900 bg-elevate/[0.03] px-3 py-2 rounded-lg break-all flex-1 min-w-[200px]">
                    {inviteLink(m.invite_code)}
                  </code>
                  <button
                    onClick={doCopy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
                  >
                    {copied ? <Check className="w-4 h-4 text-gray-700" /> : <Copy className="w-4 h-4" />}
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  邀请码 <span className="font-mono text-gray-900">{m.invite_code}</span> · 对方注册时填写即可
                </p>
              </div>
            )}

            <button
              onClick={doClaimInvite}
              disabled={busy}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-solid px-5 py-3 text-[14px] font-medium text-on-solid transition-all hover:bg-solid-hover active:scale-[0.98] disabled:opacity-50"
            >
              <Gift className="w-4 h-4" />
              检查邀请奖励
            </button>
          </div>
        </section>

        {/*
          经济困难同学免单通道（2026-10-21 加，2026-10-27 调整位置）。
          ---------------------------------------------------------------
          位置：**页面最下方**（比「邀请同学」还靠后）。
          2026-10-27 用户反馈：原来它夹在「选择方案」和「确认支付」中间，
          学生选完档位、正准备付款时被这段插在眼前，把付款动作和档位选择割断了。
          移到最底既不打乱付款动线，也不让需要它的人找不到。
          语气：平视、不施舍。"经困生"是校内黑话，正文里换成"家庭经济困难的同学"，
          招生办/资助中心的正式叫法也是这个；标签上不写"贫困生"。
          做法：不放链接、不放表单，只给一个微信号 + 复制按钮 ——
          这类事情越少留痕越好，私下说比填表体面。
        */}
        {!m?.is_lifetime && (
          <section className="mb-12">
            <div className="rounded-xl border border-hairline/[0.08] bg-ink-850 p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-wash">
                  <HandHeart className="h-5 w-5 text-accent" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-gray-900">
                    家庭经济困难学生可免费获得会员资格
                  </p>
                  <p className="mt-2 max-w-[46ch] text-[13px] leading-relaxed text-gray-500">
                    添加客服微信说明情况，经核验后即可开通，无需在页面提交任何证明材料。
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <code className="select-all rounded-lg border border-hairline/[0.08] bg-elevate/[0.03] px-3 py-2 font-mono text-[13px] text-gray-900">
                      {SUPPORT_WECHAT}
                    </code>
                    <button
                      type="button"
                      onClick={() => void doCopySupport()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-hairline/[0.08] px-3 py-2 text-[13px] text-gray-800 transition-colors hover:bg-solid-hover/[0.03]"
                    >
                      {copiedSupport ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedSupport ? '已复制' : '复制微信号'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 我的订单 */}
        {orders.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900 mb-6">我的订单</h2>
            <ul className="divide-y divide-hairline/[0.06] border-y border-hairline/[0.08]">
              {orders.map((o) => (
                <li key={o.order_no} className="py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-900">{tierLabel(o.tier)}</p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5 break-all">{o.order_no}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm text-gray-900">¥{formatYuan(o.amount_cents)}</p>
                    <p className="text-xs mt-0.5 text-gray-500">
                      {o.status === 'paid' ? '已开通' : o.claimed_at ? '待管理员核对' : '待付款'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 说明 */}
        <section className="rounded-xl bg-elevate/[0.03] p-6">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-2">
              <p>
                本站为个人整理的学习资料分享，与任何学校、机构无隶属关系。资料仅供个人复习参考。
              </p>
              <p>
                开通会员只是开放站内已收录资料的查看权限，不代表任何官方认可，也不提供任何形式的成绩承诺。
              </p>
              <p>
                {FOUNDER_SLOTS} 名之后的注册用户按上方价格开通；前 {FOUNDER_SLOTS} 名注册即赠会员试用，
                有效期{FOUNDER_TRIAL}（该日期之后需开通或续费才能继续查看）。
              </p>
            </div>
          </div>
        </section>

      </div>

      {/*
        支付成功弹窗（2026-10-28 用户要求）。
        挂在页面根节点下、内容区之外，避免受 max-w-3xl 与滚动容器影响。
      */}
      <PaymentSuccessModal
        open={successOpen}
        planLabel={paidTier ? tierLabel(paidTier) : m?.is_member ? tierLabel(m.tier) : null}
        /* 起止时间：起点=这笔订单的支付时间，终点=会员到期时间（2026-10-30 用户要求） */
        validFrom={fmtDate(paidAt)}
        validTo={fmtDate(m?.expires_at)}
        lifetime={Boolean(m?.is_lifetime)}
        expiry={m?.logged_in ? formatExpiry(m) : null}
        onClose={() => setSuccessOpen(false)}
      />
    </div>
  );
}
