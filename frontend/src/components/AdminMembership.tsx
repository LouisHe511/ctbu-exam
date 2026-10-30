import { useCallback, useEffect, useState } from 'react';
import {
  Crown, Users, Clock, CheckCircle2, XCircle, Loader2,
  Infinity as InfinityIcon, TrendingUp, RefreshCw,
} from 'lucide-react';
import {
  adminMembershipStats, adminListOrders, adminConfirmOrder, adminCancelOrder,
  adminListMembers, adminGrantMembership,
  tierLabel, formatYuan,
  type AdminStats, type AdminOrder, type AdminMember,
} from '@/lib/membership';

/**
 * 管理员 · 会员面板
 *
 * 数据全部来自 SECURITY DEFINER 的 RPC，函数内部校验 is_admin()，
 * 所以即使有人直接调接口也拿不到数据。
 *
 * 视觉沿用站点的中性阶 + 单一 teal 强调色，左对齐，数据密度优先。
 */

type SubTab = 'orders' | 'members';

export function AdminMembership() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [sub, setSub] = useState<SubTab>('orders');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [grantIdent, setGrantIdent] = useState('');
  const [grantTier, setGrantTier] = useState<'monthly' | 'yearly' | 'lifetime'>('lifetime');

  const load = useCallback(async () => {
    setLoading(true);
    const [s, o, m] = await Promise.all([
      adminMembershipStats(),
      adminListOrders('all'),
      adminListMembers(),
    ]);
    setStats(s);
    setOrders(o);
    setMembers(m);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const confirm = async (no: string) => {
    setBusy(no);
    const r = await adminConfirmOrder(no);
    setBusy('');
    setMsg(r.ok ? `已确认收款并开通会员：${no}` : `确认失败：${r.reason ?? '未知原因'}`);
    await load();
  };

  const cancel = async (no: string) => {
    setBusy(no);
    const ok = await adminCancelOrder(no);
    setBusy('');
    setMsg(ok ? `已取消订单 ${no}` : '取消失败');
    await load();
  };

  const grant = async () => {
    const ident = grantIdent.trim();
    if (!ident) return;
    setBusy('grant');
    const r = await adminGrantMembership(ident, grantTier);
    setBusy('');
    if (r.ok) {
      // 服务端会把「实际认出来的标识」回传（手机号可能被规范化过，比如去掉横线）
      setMsg(`已给 ${r.ident ?? ident} 开通${tierLabel(grantTier)}`);
      setGrantIdent('');
    } else {
      setMsg(
        r.reason === 'user_not_found'
          ? `没找到这个账号：${ident}（邮箱和手机号都会找，确认一下有没有注册过）`
          : `开通失败：${r.reason ?? '未知原因'}`
      );
    }
    await load();
  };

  if (loading) {
    return (
      <div className="py-16 flex justify-center">
        <Loader2 className="w-5 h-5 text-accent animate-spin" />
      </div>
    );
  }

  const pending = orders.filter((o) => o.status === 'pending');
  const claimed = pending.filter((o) => o.claimed_at);
  /**
   * 最近 14 天的完整序列（2026-10-21 修）
   * ---------------------------------------------------------------
   * 服务端只回**有成交的那几天**（`stats.daily`）。直接画的话，
   * 某天只有 1 笔成交、其余 13 天没有 → 画面上就一根占满半屏的巨柱，
   * 看不出"每天多少"这件事（用户截图里那片黑就是这么来的，柱子还塌成了 2px）。
   * 这里补齐空白天，保证永远是 14 个等宽柱位，没有成交的那天就是 2px 的落脚点。
   *
   * ⚠️ 故意用 IIFE 而不是 useMemo：这段代码在 `if (loading) return ...` **之后**，
   * 条件调用 hook 会让 React 抛 #310（Rendered more hooks than during the previous render）。
   * 14 次循环根本不值当缓存，别再改回去。
   */
  const series = (() => {
    const byDay = new Map(
      (stats?.daily ?? []).map((d) => [String(d.day).slice(0, 10), d]),
    );
    const out: { day: string; orders: number; amount_cents: number }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const hit = byDay.get(key);
      out.push({ day: key, orders: hit?.orders ?? 0, amount_cents: hit?.amount_cents ?? 0 });
    }
    return out;
  })();
  const daily = series;
  const maxDaily = Math.max(1, ...daily.map((d) => d.orders));

  const statCards = [
    { label: '有效会员', value: stats?.members_active ?? 0, icon: Crown },
    { label: '永久会员', value: stats?.members_lifetime ?? 0, icon: InfinityIcon },
    { label: '创始会员', value: stats?.founders ?? 0, icon: Users },
    { label: '待核对订单', value: pending.length, icon: Clock },
  ];

  return (
    <div className="space-y-8">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((c) => (
          <div key={c.label} className="rounded-xl border border-hairline/[0.08] p-5">
            <div className="flex items-center gap-2 text-gray-500">
              <c.icon className="w-4 h-4" />
              <span className="text-xs">{c.label}</span>
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-900">{c.value}</p>
          </div>
        ))}
      </div>

      {/* 收入与每日付费 */}
      <div className="rounded-xl border border-hairline/[0.08] p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-gray-500">
              <TrendingUp className="w-4 h-4" />
              <span className="text-xs">累计收入（真实到账）</span>
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
              ¥{formatYuan(stats?.revenue_cents ?? 0)}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              共 {stats?.orders_paid ?? 0} 笔成交
            </p>
          </div>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-hairline/[0.08] text-sm text-gray-900 hover:bg-solid-hover/[0.03] transition-colors"
          >
            <RefreshCw className="w-4 h-4" /> 刷新
          </button>
        </div>

        <div className="mt-6">
          <p className="text-xs text-gray-500 mb-3">最近 14 天每日付费笔数</p>
          {daily.length === 0 ? (
            <p className="text-sm text-gray-500 py-6">还没有已成交的订单。</p>
          ) : (
            /*
             * ⚠️ 2026-10-21 修「柱子看不见、只剩一片黑」（用户截图问"为什么是黑色的"）。
             *
             * 原来的写法：父容器 `h-24` + `items-end`，每根柱子 `height: xx%`。
             * 问题在于柱子所在的那一列是 `flex flex-col` 且**高度是 auto** ——
             * 百分比高度要相对父元素算，父元素高度又是 auto，浏览器只能按 auto 处理，
             * 于是所有柱子都塌成 `min-h-[2px]`：底部一条 2px 细线，上面全是空的。
             * 表格本身没坏，是这张图根本画不出来。
             *
             * 现在：列给死高度（h-full，父容器 96px），柱子用**像素**算
             * （最多 76px，给下面那行日期留 20px），并 justify-end 让柱脚对齐同一条基线。
             */
            <div className="flex items-end gap-1.5 h-24">
              {daily.map((d) => {
                const h = Math.max(2, Math.round((d.orders / maxDaily) * 76));
                return (
                  <div
                    key={d.day}
                    className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
                  >
                    <div
                      className="w-full max-w-[26px] rounded-sm bg-accent"
                      style={{ height: `${h}px` }}
                      title={`${d.day}：${d.orders} 笔 / ¥${formatYuan(d.amount_cents)}`}
                    />
                    <span className="w-full truncate text-center text-[10px] tabular-nums text-gray-400">
                      {String(d.day).slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {msg && <p className="text-sm text-gray-900 bg-elevate/[0.03] rounded-lg px-4 py-3">{msg}</p>}

      {/* 手动开通 */}
      <div className="rounded-xl border border-hairline/[0.08] p-6">
        <p className="text-sm font-medium text-gray-900 mb-3">手动开通 / 赠送会员</p>
        <p className="mb-3 text-xs leading-relaxed text-gray-500">
          请输入用户注册时使用的<strong className="text-gray-800">手机号或电子邮箱</strong>。
          手机号可包含空格或连字符。
        </p>
        {/*
          ⚠️ 输入框必须显式给背景色：<input> 不写背景就是浏览器默认的**白底**，
          在深色界面上非常刺眼（用户 2026-10-22 截图指出）。
        */}
        <div className="flex flex-wrap gap-3">
          {/*
            2026-10-22：这里以前写死"用户邮箱"，但站里一半账号是**手机号注册**的
            （auth.users.email 为 NULL），他们在这个框里根本没东西可填。
            现在邮箱和手机号都能填，服务端按内容自己判断。
          */}
          <input
            value={grantIdent}
            onChange={(e) => setGrantIdent(e.target.value)}
            placeholder="用户邮箱 或 手机号"
            className="flex-1 min-w-[200px] px-4 py-3 text-sm rounded-lg border border-hairline/[0.08] bg-ink-900 text-gray-900 placeholder-gray-400 outline-none transition-colors focus:border-accent"
          />
          <select
            value={grantTier}
            onChange={(e) => setGrantTier(e.target.value as typeof grantTier)}
            className="px-4 py-3 text-sm rounded-lg border border-hairline/[0.08] focus:border-accent outline-none bg-ink-850"
          >
            <option value="monthly">单月</option>
            <option value="yearly">年度</option>
            <option value="lifetime">永久</option>
          </select>
          <button
            onClick={grant}
            disabled={busy === 'grant'}
            className="px-5 py-3 rounded-lg bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover disabled:opacity-50 transition-colors"
          >
            {busy === 'grant' ? '处理中…' : '开通'}
          </button>
        </div>
      </div>

      {/* 子标签 */}
      <div>
        <div className="flex gap-6 border-b border-hairline/[0.08]">
          {([
            ['orders', `订单核对${claimed.length ? `（${claimed.length} 已提交）` : ''}`],
            ['members', `会员列表（${members.length}）`],
          ] as [SubTab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSub(id)}
              className={`pb-3 text-sm -mb-px border-b-2 transition-colors ${
                sub === id
                  ? 'border-accent text-gray-900 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {sub === 'orders' && (
          <div className="mt-6">
            <p className="text-xs text-gray-500 mb-4 leading-relaxed">
              接入支付通道后，<span className="text-gray-900">付款成功会自动开通会员</span>，这里一般不需要手动确认。
              只有在自动开通没发生时，才用下面的「确认收款」补一下 —— 那时请对照平台订单号或学生填的备注，
              不要只看金额（同档订单金额是相同的标准价）。
            </p>
            {orders.length === 0 ? (
              <p className="text-sm text-gray-500 py-8">还没有任何订单。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-hairline/[0.08]">
                      <th className="py-3 pr-4 font-normal">用户</th>
                      <th className="py-3 pr-4 font-normal">方案</th>
                      <th className="py-3 pr-4 font-normal">金额</th>
                      <th className="py-3 pr-4 font-normal">状态</th>
                      <th className="py-3 pr-4 font-normal">下单时间</th>
                      <th className="py-3 font-normal text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline/[0.06]">
                    {orders.slice(0, 100).map((o) => (
                      <tr key={o.order_no}>
                        <td className="py-3 pr-4">
                          <p className="text-gray-900 truncate max-w-[180px]">
                            {o.email || o.phone || '—'}
                          </p>
                          <p className="text-[11px] text-gray-500 font-mono">{o.order_no}</p>
                        </td>
                        <td className="py-3 pr-4 text-gray-900">{tierLabel(o.tier)}</td>
                        <td className="py-3 pr-4 text-gray-900">¥{formatYuan(o.amount_cents)}</td>
                        <td className="py-3 pr-4">
                          {o.status === 'paid' ? (
                            <span className="text-accent">已开通</span>
                          ) : o.claimed_at ? (
                            <span className="text-gray-500">已提交核对</span>
                          ) : o.status === 'cancelled' ? (
                            <span className="text-gray-500">已取消</span>
                          ) : (
                            <span className="text-gray-500">待付款</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-xs text-gray-500">
                          {new Date(o.created_at).toLocaleString('zh-CN', {
                            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                          })}
                        </td>
                        <td className="py-3 text-right whitespace-nowrap">
                          {o.status === 'pending' && (
                            <>
                              <button
                                onClick={() => confirm(o.order_no)}
                                disabled={busy === o.order_no}
                                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-accent text-white text-xs hover:bg-accent-deep disabled:opacity-50 transition-colors"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> 确认收款
                              </button>
                              <button
                                onClick={() => cancel(o.order_no)}
                                disabled={busy === o.order_no}
                                className="ml-2 inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-hairline/[0.08] text-xs text-gray-500 hover:bg-solid-hover/[0.03] disabled:opacity-50 transition-colors"
                              >
                                <XCircle className="w-3.5 h-3.5" /> 取消
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {sub === 'members' && (
          <div className="mt-6">
            {members.length === 0 ? (
              <p className="text-sm text-gray-500 py-8">还没有会员。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-hairline/[0.08]">
                      {/* 这一列现在既有邮箱也有手机号，标题别写"邮箱" */}
                      <th className="py-3 pr-4 font-normal">账号</th>
                      <th className="py-3 pr-4 font-normal">身份</th>
                      <th className="py-3 pr-4 font-normal">有效期</th>
                      <th className="py-3 font-normal">注册时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline/[0.06]">
                    {members.map((m, i) => (
                      <tr key={`${m.email ?? m.phone ?? 'member'}-${i}`}>
                        {/* 手机号注册的账号 email 是 NULL —— 直接渲染会变成一整行空白，
                            管理员看到的就是"一排黑的"。回退显示手机号。 */}
                        <td className="py-3 pr-4 text-gray-900 truncate max-w-[220px]">
                          {m.email || m.phone || '—'}
                        </td>
                        <td className="py-3 pr-4">
                          <span className="text-gray-900">{tierLabel(m.tier)}</span>
                          {m.is_founder && <span className="ml-2 text-xs text-gray-500">创始</span>}
                        </td>
                        <td className="py-3 pr-4 text-gray-900">
                          {m.expires_at && String(m.expires_at).startsWith('infinity') ? '永久' : String(m.expires_at).slice(0, 10)}
                        </td>
                        <td className="py-3 text-xs text-gray-500">{String(m.joined_at).slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
