import { api, apiRpc } from '@/lib/api';
import { withTimeout } from '@/lib/papers';

/** 定价（与数据库 create_payment_order 里的金额保持一致，单位：分） */
export const PLANS = [
  {
    id: 'monthly' as const,
    name: '单月会员',
    price: 3.8,
    priceCents: 380,
    unit: '1 个月',
    desc: '先试一个月',
    highlight: false,
  },
  {
    id: 'yearly' as const,
    name: '年度会员',
    price: 8.8,
    priceCents: 880,
    unit: '12 个月',
    desc: '月均 ¥0.73',
    highlight: true,
  },
  {
    id: 'lifetime' as const,
    name: '永久会员',
    price: 16.8,
    priceCents: 1680,
    unit: '永久有效',
    desc: '一次买断',
    highlight: false,
  },
] as const;

export type PlanId = (typeof PLANS)[number]['id'];

/** 每邀请多少人得 1 个月 —— 与数据库 settle_invite_rewards 里的 4 保持一致 */
export const INVITES_PER_MONTH = 4;

/**
 * 创始会员名额（演进：20 → 100 → 200 → 100 → **200**）。
 *
 * 2026-10-30 用户决定改回 200，并把试用期口径从「1 个月」改成「统一到 12 月 31 日」。
 *
 * ⚠️ 这个数字与后端 `handle_new_user()` 的 `v_quota` **必须保持一致**。
 *    改它要同时跑 `sql/2026-10-30-创始名额200与统一到期.sql`，否则前端说的
 *    和数据库实际给的会是两套。已经拿到 founder 的账号不受影响（不回收）。
 */
export const FOUNDER_SLOTS = 200;
/**
 * 创始会员试用期（人话，用于文案）。
 *
 * 2026-10-30 起不再是「1 个月」，而是**统一到 2026-12-31**（见数据库的
 * `v_founder_floor`）—— 覆盖四六级与期末。文案必须跟着改，否则页面写"1 个月"、
 * 实际给到年底，学生一算就发现对不上。
 */
export const FOUNDER_TRIAL = '至 2026 年 12 月 31 日';

export interface InviteProgress {
  valid_invites: number;
  months_granted_total: number;
  months_granted_now: number;
  next_reward_in: number;
}

export interface Membership {
  logged_in: boolean;
  tier?: string;
  expires_at?: string | null;
  is_lifetime?: boolean;
  is_member?: boolean;
  is_founder?: boolean;
  invite_code?: string | null;
  invite_months_granted?: number;
  joined_at?: string;
  invite?: InviteProgress;
}

export async function myMembership(): Promise<Membership | null> {
  try {
    const { data, error } = await withTimeout(
      apiRpc('my_membership'),
      20_000,
      '查询会员状态超时'
    );
    if (error) return null;
    return (data as Membership) ?? null;
  } catch {
    return null;
  }
}

export interface CreatedOrder {
  ok: boolean;
  reason?: string;
  order_no?: string;
  tier?: PlanId;
  amount_cents?: number;
}

export async function createPaymentOrder(tier: PlanId): Promise<CreatedOrder> {
  const { data, error } = await withTimeout(
    apiRpc('create_payment_order', { p_tier: tier }),
    25_000,
    '创建订单超时'
  );
  if (error) throw new Error(error.message);
  return data as CreatedOrder;
}

/** 用户点"我已付款"：只登记"已提交核对"，**不能**把自己变成已支付（那是管理员的权限） */
export async function markOrderClaimed(orderNo: string): Promise<boolean> {
  const { data, error } = await withTimeout(
    apiRpc('mark_order_claimed', { p_order_no: orderNo }),
    20_000,
    '提交核对超时'
  );
  if (error) return false;
  return Boolean((data as { ok?: boolean })?.ok);
}

export async function claimInviteRewards(): Promise<InviteProgress | null> {
  const { data, error } = await withTimeout(
    apiRpc('claim_invite_rewards'),
    20_000,
    '结算邀请奖励超时'
  );
  if (error) return null;
  return (data as InviteProgress) ?? null;
}

export interface MyOrder {
  order_no: string;
  tier: string;
  amount_cents: number;
  status: string;
  created_at: string;
  paid_at: string | null;
  claimed_at: string | null;
}

/** 我自己的订单（服务端只返回自己的） */
export async function myOrders(limit = 10): Promise<MyOrder[]> {
  try {
    const r = await api<{ orders: MyOrder[] }>(`/api/data/my-orders?limit=${limit}`);
    return r.orders ?? [];
  } catch {
    return [];
  }
}

// ==================== 管理员 ====================

export interface AdminStats {
  ok: boolean;
  reason?: string;
  members_active?: number;
  members_lifetime?: number;
  founders?: number;
  orders_pending?: number;
  orders_paid?: number;
  revenue_cents?: number;
  daily?: { day: string; orders: number; amount_cents: number }[];
}

export async function adminMembershipStats(): Promise<AdminStats | null> {
  const { data, error } = await withTimeout(
    apiRpc('admin_membership_stats'),
    20_000,
    '查询统计超时'
  );
  if (error) return null;
  return data as AdminStats;
}

export interface AdminOrder {
  order_no: string;
  claimed_at?: string | null;
  tier: string;
  amount_cents: number;
  status: string;
  created_at: string;
  paid_at: string | null;
  payer_note: string | null;
  email: string | null;
  phone?: string | null;
  display_name: string | null;
}

export async function adminListOrders(status = 'pending', limit = 50): Promise<AdminOrder[]> {
  const { data, error } = await withTimeout(
    apiRpc('admin_list_orders', { p_status: status, p_limit: limit }),
    20_000,
    '查询订单超时'
  );
  if (error) return [];
  return ((data as { orders?: AdminOrder[] })?.orders ?? []) as AdminOrder[];
}

export async function adminConfirmOrder(orderNo: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await withTimeout(
    apiRpc('admin_confirm_order', { p_order_no: orderNo }),
    25_000,
    '确认收款超时'
  );
  if (error) return { ok: false, reason: error.message };
  return data as { ok: boolean; reason?: string };
}

export async function adminCancelOrder(orderNo: string): Promise<boolean> {
  const { data, error } = await withTimeout(
    apiRpc('admin_cancel_order', { p_order_no: orderNo }),
    20_000,
    '取消订单超时'
  );
  if (error) return false;
  return Boolean((data as { ok?: boolean })?.ok);
}

export interface AdminMember {
  email: string | null;
  /** 手机号注册的账号没有邮箱，靠这个认人（2026-10-21） */
  phone?: string | null;
  display_name: string | null;
  tier: string;
  expires_at: string | null;
  is_founder: boolean;
  joined_at: string;
}

export async function adminListMembers(limit = 100): Promise<AdminMember[]> {
  const { data, error } = await withTimeout(
    apiRpc('admin_list_members', { p_limit: limit }),
    20_000,
    '查询会员超时'
  );
  if (error) return [];
  return ((data as { members?: AdminMember[] })?.members ?? []) as AdminMember[];
}

/**
 * 管理员手动开通 / 赠送会员。
 *
 * `ident` **可以是邮箱，也可以是手机号**（2026-10-22）。
 * 之前只认邮箱 —— 而站里一半账号是手机号注册的（没有 email），
 * 在后台那个输入框里根本没东西可填。
 *
 * 参数名 `p_email` 保留：数据库函数签名没改，只是值放宽了。
 * 判断逻辑在服务端（SQL 里按 `^1[3-9]\d{9}$` 认手机号），前端不用重复写。
 */
export async function adminGrantMembership(
  ident: string,
  tier: PlanId,
): Promise<{ ok: boolean; reason?: string; ident?: string }> {
  const { data, error } = await withTimeout(
    apiRpc('admin_grant_membership', { p_email: ident, p_tier: tier }),
    25_000,
    '开通会员超时'
  );
  if (error) return { ok: false, reason: error.message };
  return data as { ok: boolean; reason?: string; ident?: string };
}

// ==================== 展示辅助 ====================

export function tierLabel(tier?: string): string {
  switch (tier) {
    case 'monthly':
      return '单月会员';
    case 'yearly':
      return '年度会员';
    case 'lifetime':
      return '永久会员';
    case 'founder':
      return '创始会员';
    case 'invite':
      return '邀请奖励会员';
    default:
      return '免费用户';
  }
}

export function formatExpiry(m: Membership | null): string {
  if (!m?.logged_in) return '未登录';
  if (m.is_lifetime) return '永久有效';
  if (!m.expires_at) return '未开通';
  const d = new Date(m.expires_at);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

export function inviteLink(code?: string | null): string {
  const base = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '';
  return code ? `${base}#/register?ref=${code}` : base;
}
