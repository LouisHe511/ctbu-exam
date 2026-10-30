/**
 * 「付到一半跑掉了」的现场保存（2026-10-21）
 * ═══════════════════════════════════════════════════════════════
 * 学生真实碰到的问题（用户原话）：
 *   「如果用户在微信里面打开我的链接，那他要付费、要用微信支付的话，
 *     就需要退出页面再点扫一扫。但他再点我的链接回来，就没办法回到刚刚
 *     那个页面了。」
 *
 * 为什么会这样：微信里点「确认支付」会跳到支付平台的收银台（另一个域名）。
 * 收银台在微信里往往提示"长按识别"，但有的机型长按没反应 → 学生退出微信
 * 去扫一扫 → 再点链接回来，微信重新打开的是**首页**，
 * 订单、金额、支付方式全没了，学生不知道还该不该付、付给谁。
 *
 * 这里做的事很小：离开本站去收银台之前，把「哪一笔单子」存到 localStorage。
 * 下次进站时（App.tsx 里）读出来，直接把他送回会员页，并说明"订单还在，放心付"。
 *
 * 为什么用 localStorage 而不是 sessionStorage：
 *   微信退出 webview 后 sessionStorage 经常直接没了；localStorage 能跨进程留住。
 *
 * 为什么带时间戳：
 *   订单会过期。留一个超过有效期的"僵尸订单"会把学生送到一个付不了的页面，
 *   比不送还糟。所以过期就不再自动跳转（但仍允许他自己进会员页看）。
 */

const KEY = 'ctbu:pending-pay';

/** 多久之内算"刚离开不久"，进来就自动送回会员页 */
const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 小时

export interface PendingPay {
  /** 我们自己的订单号 */
  orderNo: string;
  /** 方案 id（monthly / yearly / lifetime） */
  tier: string;
  /** 金额（分） */
  cents: number;
  /** 选的支付方式 */
  method?: 'alipay' | 'wxpay';
  /** 存下来的时间戳 */
  at: number;
}

/** 记住"学生正要去付这一单"。跳收银台之前调用。 */
export function rememberPendingPay(p: Omit<PendingPay, 'at'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    /* 隐私模式/配额满：存不下就算了，不影响付款本身 */
  }
}

/** 读出来。超时的自动清掉并返回 null。 */
export function readPendingPay(): PendingPay | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingPay;
    if (!p?.orderNo || typeof p.at !== 'number') {
      localStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() - p.at > RESUME_WINDOW_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

/** 付成功 / 明确放弃时清掉，别再把人往会员页送。 */
export function clearPendingPay(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

/* ──────────────────────────────────────────────────────────────
 * 「这笔已付、并且已经弹过窗了」（2026-10-30）
 *
 * 背景：会员页每次挂载都会扫一遍订单，发现"刚付成功且没提示过"的就弹窗。
 * 不记下来的话，学生每刷新一次页面就再弹一次「支付成功」——看起来像系统出 bug。
 *
 * 只记最近一个订单号就够：付费是低频动作，不需要留历史。
 * ────────────────────────────────────────────────────────────── */
const ACK_KEY = 'ctbu:paid-ack';

export function markPaidNotified(orderNo: string): void {
  try {
    localStorage.setItem(ACK_KEY, orderNo);
  } catch {
    /* 隐私模式：不记也能用，最多下次刷新多弹一次 */
  }
}

export function isPaidNotified(orderNo: string): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === orderNo;
  } catch {
    return false;
  }
}

/** 是否在微信内置浏览器里 */
export function isWechatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /micromessenger/i.test(navigator.userAgent);
}

/**
 * 是不是"刚从外面回来"。
 *
 * 淘宝式判断不可靠，这里只用两个强信号：
 *   · document.referrer 为空 —— 从微信聊天/收藏点链接进来，通常是空的；
 *   · referrer 是支付平台 —— 说明是从收银台按返回键回来的。
 * 从搜索引擎/别的网站点进来（referrer 是别人的域名）就不打扰他。
 */
export function isFreshEntryFromOutside(): boolean {
  if (typeof document === 'undefined') return true;
  const ref = document.referrer || '';
  if (!ref) return true;
  if (/88yyw\.cn/i.test(ref)) return true;
  // 同站内的跳转不重载页面，所以走到这里基本只剩"外部来源"
  return false;
}
