/**
 * 支付服务客户端（ctbu-pay）
 *
 * 架构：前端不直接对接任何支付平台，只对接我们自己的服务端 `/api/pay/*`：
 *   下单  → POST /api/pay/create   拿 pay_url，跳转到收银台
 *   兜底  → POST /api/pay/recheck  主动查单（回调丢了也能开通）
 *
 * 服务端在同域的 nginx 后面（https://your-domain.com/api/pay/*），
 * 所以默认用相对路径，不存在跨域问题。本地开发如需指向别处，
 * 在 .env 里设 VITE_PAY_API_BASE（例如 https://your-domain.com）。
 */

import { getToken } from '@/lib/api';

const BASE = (import.meta.env.VITE_PAY_API_BASE ?? '').replace(/\/$/, '');

/** 服务端要求带用户自己的会话 token —— 它据此确认「这是你的订单」 */
async function authHeaders(): Promise<Record<string, string>> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postJson<T>(path: string, body: unknown, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { ok: false, reason: 'bad_response', message: text.slice(0, 200) } as unknown as T;
    }
  } catch {
    return { ok: false, reason: 'network_error' } as unknown as T;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 下单结果。
 *
 * 2026-10-23：接微信官方支付后，`channel` 会多出三种，返回体也不再只有 `pay_url`：
 *   · epay / alipay_*  → 有 `pay_url`，直接跳
 *   · wechat_native    → 有 `code_url`（weixin:// 协议）+ `qr_image`（PNG dataURL）
 *   · wechat_jsapi     → 有 `jsapi`（WeixinJSBridge 唤起参数），**不跳转**
 */
export type PayCreateResult =
  | {
      ok: true;
      channel: string;
      /** 跳转型渠道才有 */
      pay_url?: string;
      pay_type?: string;
      amount_cents: number;
      order_no: string;
      /** 微信 Native：二维码内容（weixin://wxpay/bizpayurl?pr=...）*/
      code_url?: string;
      /** 微信 Native：后端渲染好的二维码图（data:image/png;base64,...）*/
      qr_image?: string;
      /** 微信 JSAPI：交给 WeixinJSBridge 的参数 */
      jsapi?: Record<string, string>;
      /** 微信 H5（手机浏览器）：跳转到微信付款页的地址 */
      h5_url?: string;
    }
  | { ok: false; reason: string; message?: string };

/**
 * 为订单创建支付会话，返回可直接跳转的收银台地址。
 *
 * reason 取值：
 *   need_browser        微信内无法跳转支付宝，需引导用户「在浏览器打开」
 *   no_channel_configured / epay_not_configured  服务端没配渠道
 *   not_logged_in / not_your_order / not_pending  身份或订单状态问题
 *   channel_error       渠道方报错（如「没有收款账号在线」）
 */
export function createPaySession(
  orderNo: string,
  payType?: PayType,
  openid?: string | null,
): Promise<PayCreateResult> {
  return postJson<PayCreateResult>('/api/pay/create', {
    order_no: orderNo,
    // 学生自己选的支付方式（2026-10-21 加）。服务端只认配置里真开着的，
    // 传了不支持的会退回到自动选择，不会报错。
    ...(payType ? { pay_type: payType } : {}),
    // 微信内 JSAPI 下单必须要 openid（2026-10-23）
    ...(openid ? { openid } : {}),
    // 设备类型：服务端据此选 Native（电脑）/ JSAPI（微信内）/ H5（手机浏览器）
    device: deviceKind(),
  });
}

/** 站内支持的支付方式（由服务端按当前渠道配置 + 浏览器环境决定） */
export type PayType = 'alipay' | 'wxpay';

export interface PayMethod {
  id: string;
  label: string;
  available: boolean;
  note: string;
}

export type ChannelsResult =
  | { ok: true; in_wechat: boolean; device?: 'pc' | 'mobile' | 'tablet'; methods: PayMethod[]; all: PayMethod[] }
  | { ok: false; reason: string };

/**
 * 问服务端「现在能用哪几种支付方式」。
 * 拿不到就退回到支付宝/微信两选一（宁可多给一个选项，也不要空着不给选）。
 */
export async function fetchPayChannels(): Promise<ChannelsResult> {
  try {
    const res = await fetch(`${BASE}/api/pay/channels?device=${deviceKind()}`,
      { headers: await authHeaders() });
    const text = await res.text();
    return JSON.parse(text) as ChannelsResult;
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

export type RecheckResult =
  | { ok: true; status: 'paid' | 'pending'; reason: string; tier?: string }
  | { ok: false; reason: string; detail?: unknown };

/** 主动查单：问支付平台「这笔到底付了没」，付了就当场开通 */
export function recheckOrder(orderNo: string): Promise<RecheckResult> {
  return postJson<RecheckResult>('/api/pay/recheck', { order_no: orderNo });
}

/** 把「去付款」变成一次跳转（服务端给的地址本身就带签名） */
export function gotoCashier(payUrl: string): void {
  window.location.href = payUrl;
}

/* ══════════════════════════════════════════════════════════════════
 * 微信官方支付（2026-10-23）
 * ══════════════════════════════════════════════════════════════════
 * 两种场景，两套流程：
 *
 *   ① 微信内置浏览器 → JSAPI
 *      需要 openid。流程：跳 oauth 授权 → 微信带 code 回到本页 →
 *      用 code 换 openid → 下单 → WeixinJSBridge 唤起付款面板。
 *      用户看到的是**直接弹出的微信付款界面**，不用扫码。
 *
 *   ② 电脑/手机浏览器 → Native
 *      下单拿到 code_url → 后端已渲染成 PNG → 页面显示二维码 → 用户微信扫。
 *
 * 为什么 openid 要缓存在 sessionStorage：
 *   oauth 跳转会让页面重新加载，openid 不存下来每次都要再跳一次授权。
 */

/** 拿微信网页授权地址（服务端生成，AppSecret 不下发前端） */
export async function fetchWechatOAuthUrl(back = '/#/membership'): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/pay/wx-oauth-url?back=${encodeURIComponent(back)}`);
    const j = (await res.json()) as { ok: boolean; url?: string };
    return j.ok && j.url ? j.url : null;
  } catch {
    return null;
  }
}

/** 用授权 code 换 openid */
export async function exchangeOpenid(code: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/pay/wx-openid?code=${encodeURIComponent(code)}`);
    const j = (await res.json()) as { ok: boolean; openid?: string };
    return j.ok && j.openid ? j.openid : null;
  } catch {
    return null;
  }
}

const OPENID_KEY = 'ctbu:wx-openid';
/**
 * 「发起过几次 OAuth 授权」的计数（2026-10-27）。
 *
 * 为什么需要：如果授权能跳过去、但 code 换不到 openid（配置错 / code 失效），
 * 那么"点支付 → 跳授权 → 回来拿不到 openid → 点支付 → 又跳授权"会**无限循环**。
 * 用户看到的就是"点一下刷新一下，永远付不了"。
 *
 * 所以超过 2 次就停手，改为明确提示 —— 让人知道是配置问题，
 * 而不是在那儿反复刷新猜。
 */
const OAUTH_TRIES_KEY = 'ctbu:wx-oauth-tries';

/** 从地址栏拿 oauth 回来的 code，换 openid 并缓存。返回该缓存的 openid。 */
export async function resolveWechatOpenid(): Promise<string | null> {
  /*
   * ⚠️ 2026-10-27 修一个**必然失败**的 bug（用户实测：点确认支付只是闪一下，不弹面板）。
   *
   * 根因：redirect_uri 是 `https://louisnb.cn/#/membership`（带 hash 路由）。
   * 微信 OAuth 回调会把参数拼在后面 →
   *     https://louisnb.cn/#/membership?code=xxx&state=ctbu
   * `?code=xxx` **在 hash 里面**，而 `window.location.search` 只返回 `?` 之前的部分，
   * 对上面这个 URL 是**空字符串** → code 永远读不到 → 换不到 openid →
   * 点支付又跳授权 → 死循环，表现为"点了就刷新一下，什么都没发生"。
   *
   * 修法：**从整个 href 抓 code**，不管它在 search 还是在 hash 里。
   */
  const href = window.location.href;
  const m = href.match(/[?&]code=([^&#]+)/);

  if (m) {
    const code = decodeURIComponent(m[1]);
    // 无论换成功与否，都必须把 code 从地址栏抹掉：
    // code 是一次性的，留在地址栏会导致每次刷新都重放 → 一律失败 → 死循环。
    stripOAuthParams();
    try {
      const n = Number(sessionStorage.getItem(OAUTH_TRIES_KEY) || '0') + 1;
      sessionStorage.setItem(OAUTH_TRIES_KEY, String(n));
    } catch { /* 隐私模式 */ }

    const openid = await exchangeOpenid(code);
    if (openid) {
      try { sessionStorage.setItem(OPENID_KEY, openid); } catch { /* 隐私模式 */ }
      return openid;
    }
  }

  // 用缓存的
  try {
    return sessionStorage.getItem(OPENID_KEY);
  } catch {
    return null;
  }
}

/**
 * 把 `code` / `state` 从地址栏抹掉，**同时保住 hash 路由**。
 *
 * 天真的用一条正则去删 code 会出问题：hash 里的 query 被删后
 * 可能留下 `#/membership?` 这种残缺尾巴，甚至把路由本身破坏掉（页面变空白）。
 * 所以分开处理 search 和 hash 两段各自的 query。
 * （注：这段注释里不能写含星号斜杠的正则字面量 —— 会提前结束块注释。）
 */
function stripOAuthParams(): void {
  try {
    const url = new URL(window.location.href);

    const sp = new URLSearchParams(url.search);
    sp.delete('code');
    sp.delete('state');
    const search = sp.toString();
    url.search = search ? `?${search}` : '';

    const hash = url.hash;            // 形如 "#/membership?code=xxx&state=ctbu"
    if (hash.includes('?')) {
      const [path, query] = hash.split('?');
      const hp = new URLSearchParams(query);
      hp.delete('code');
      hp.delete('state');
      const rest = hp.toString();
      url.hash = rest ? `${path}?${rest}` : path;
    }

    window.history.replaceState(null, '', url.toString());
  } catch {
    /* URL 解析失败就放弃清理 —— 下次进来 code 已过期，不会死循环 */
  }
}

/**
 * 在微信内唤起官方付款面板。
 *
 * WeixinJSBridge 在部分 Android 微信里不是立刻可用的，要等 `WeixinJSBridgeReady`
 * 事件（这是微信官方文档里明确写的兼容做法）。
 */
export function wechatJsapiPay(jsapi: Record<string, string>): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const invoke = () => {
      const bridge = (window as unknown as {
        WeixinJSBridge?: {
          invoke: (
            name: string,
            params: Record<string, string>,
            cb: (res: { err_msg?: string }) => void,
          ) => void;
        };
      }).WeixinJSBridge;

      // 详细诊断：微信支付唤起失败的原因极其难猜（权限 / 绑定 / 签名 / 版本），
      // 只能把 bridge 是否存在、参数是否完整、回调原话全部抛出来（2026-10-27）。
      reportDiag('jsapi_invoke_attempt', {
        hasBridge: Boolean(bridge),
        bridgeKeys: bridge ? Object.keys(bridge).slice(0, 12) : [],
        paramKeys: Object.keys(jsapi || {}),
        appId: (jsapi?.appId || '').slice(0, 24),
        packageHasPrepay: (jsapi?.package || '').startsWith('prepay_id='),
        signType: jsapi?.signType,
        paySignLen: (jsapi?.paySign || '').length,
        hasWeixinObj: typeof (window as unknown as { WeixinJSBridge?: unknown }).WeixinJSBridge,
      });

      if (!bridge) {
        resolve({ ok: false, reason: 'no_bridge' });
        return;
      }
      bridge.invoke('getBrandWCPayRequest', jsapi, (res) => {
        const msg = res?.err_msg ?? '';
        reportDiag('jsapi_invoke_result', { raw: JSON.stringify(res || {}).slice(0, 300) });
        if (msg === 'get_brand_wcpay_request:ok') resolve({ ok: true });
        else if (msg === 'get_brand_wcpay_request:cancel') resolve({ ok: false, reason: 'cancelled' });
        else resolve({ ok: false, reason: msg || 'failed' });
      });
    };

    const w = window as unknown as { WeixinJSBridge?: unknown };
    if (w.WeixinJSBridge) {
      invoke();
      return;
    }
    // 105 秒内等不到就放弃（正常几百毫秒内就绪）
    const timer = window.setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 8000);
    document.addEventListener(
      'WeixinJSBridgeReady',
      () => { window.clearTimeout(timer); invoke(); },
      { once: true },
    );
  });
}

/**
 * 授权是否已经失败太多次（2026-10-27）。
 *
 * 调用方据此决定：**别再跳授权了**，直接告诉用户是配置问题。
 * 阈值 2 次 —— 第一次失败可能是偶发（网络抖动 / code 刚好过期），
 * 第二次还不行就基本可以确定是配置错了（网页授权域名没配 / AppSecret 不对）。
 */
export function oauthTriedTooMany(): boolean {
  try {
    return Number(sessionStorage.getItem(OAUTH_TRIES_KEY) || '0') >= 2;
  } catch {
    return false;
  }
}

/**
 * **全局**捕获 OAuth 回调里带回的 openid（2026-10-27）。
 *
 * 为什么必须放在 App 层而不是会员页：
 * 微信授权回调的落点由 redirect_uri 决定。为了绕开"带 hash 的 redirect_uri 被
 * 微信截断"这个坑，现在 redirect_uri 是干净的根路径，So 回调一定落在**首页**。
 * 而首页时会员页组件根本没挂载 —— 如果只在会员页里读 code，就会漏掉。
 *
 * 实测事故：日志里 7 次「create 400 + wx-oauth-url 200」，却一次 wx-openid 请求都没有，
 * 就是这个原因（code 落在了首页，没人去换）。
 *
 * 返回值：本次是否真的换到了 openid（用于决定要不要跳回会员页）。
 */
/**
 * 前端诊断上报（2026-10-27 临时）。
 *
 * 微信 JSAPI 只在微信客户端里工作，浏览器和自动化工具都模拟不了；
 * 出问题时"前端走到哪一步"只能靠它自己说。排查完应连同后端
 * `/api/pay/diag` 一起删掉。
 *
 * 绝不阻塞：失败就静默忽略，不能因为诊断把正常流程拖慢。
 */
export function reportDiag(tag: string, extra: Record<string, unknown> = {}): void {
  try {
    void fetch(`${BASE}/api/pay/diag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag,
        ua: /micromessenger/i.test(navigator.userAgent) ? 'wechat' : 'other',
        url: window.location.href.slice(0, 300),
        hash: window.location.hash.slice(0, 120),
        search: window.location.search.slice(0, 200),
        cachedOpenid: Boolean(readCachedOpenid()),
        ...extra,
      }),
      keepalive: true,
    }).catch(() => { /* 忽略 */ });
  } catch { /* 忽略 */ }
}

export async function captureWechatOpenidOnBoot(): Promise<boolean> {
  if (!inWechat()) return false;

  /*
   * ⚠️ 2026-10-27 修：判断依据必须是「**URL 里有没有 code**」，
   * 不能用「缓存里之前有没有 openid」。
   *
   * 原来的写法 `Boolean(openid) && !before` 有个致命问题：
   * 只要 sessionStorage 里**已经缓存过** openid（用户测过几轮就一定有），
   * `before` 就非空 → 返回 false → **不跳回会员页** → 用户授权完停在首页，
   * 看到的就是"点了确认支付，结果被踢回开屏首页"。
   *
   * 正确判据：这次页面加载**是不是 OAuth 回调**（URL 带 code）。
   * 是回调且换到了 openid → 就该把用户送回他要去的页面。
   */
  const hadCode = /[?&]code=([^&#]+)/.test(window.location.href);
  if (!hadCode) return false;

  const openid = await resolveWechatOpenid();
  // 拿到就顺手绑到账号上 —— 下次无论从哪进来都不用再授权
  if (openid) void bindOpenidToAccount(openid);
  return Boolean(openid);
}

/**
 * 读取 OAuth 回调里带回的 `state`（后端把"回程路由"放在这里，如 `/#/membership`）。
 *
 * 为什么不把回程路由塞进 redirect_uri：带 `#` 的 redirect_uri 会被微信截断，
 * 回调落到根路径、code 也会丢（这个坑 2026-10-27 踩过两次）。放 state 里最稳。
 */
export function readOAuthState(): string | null {
  const m = window.location.href.match(/[?&]state=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 「授权前记下待付意图，授权回来自动续付」（2026-10-27）。
 *
 * 解决什么问题：微信 OAuth 授权会**整页跳转**，把用户点「确认支付」那一刻的
 * 现场全部冲掉。授权回来后 openid 有了，但用户得**再点一次**才付——
 * 实测用户以为"点了没反应/失败了"。
 *
 * 做法：跳授权前把订单号和方案存下来；回到站点、openid 就绪后自动接着付，
 * 用户只需要点**一次**。
 *
 * 用 sessionStorage 而不是 localStorage：授权跳转是同标签页内的，
 * sessionStorage 能跨这次跳转保留，但不会污染其他标签页 / 下次访问。
 */
const PENDING_INTENT_KEY = 'ctbu:wx-pending-intent';

export interface PendingPayIntent {
  orderNo: string;
  tier: string;
  cents: number;
  /** 记录时间，超过 10 分钟就作废，避免用户半小时后莫名被扣款 */
  at: number;
}

export function savePendingIntent(i: Omit<PendingPayIntent, 'at'>): void {
  try {
    sessionStorage.setItem(PENDING_INTENT_KEY, JSON.stringify({ ...i, at: Date.now() }));
  } catch { /* 隐私模式 */ }
}

export function takePendingIntent(): PendingPayIntent | null {
  try {
    const raw = sessionStorage.getItem(PENDING_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_INTENT_KEY);   // 一次性，取走即删
    const i = JSON.parse(raw) as PendingPayIntent;
    if (!i?.orderNo || Date.now() - (i.at || 0) > 10 * 60 * 1000) return null;
    return i;
  } catch {
    return null;
  }
}

export function clearPendingIntent(): void {
  try { sessionStorage.removeItem(PENDING_INTENT_KEY); } catch { /* 忽略 */ }
}

/**
 * 把 openid 绑定到账号（2026-10-27）。
 *
 * 这是「支付流程不再跳转」的核心：openid 存到账号上之后，
 * 无论何时何地、只要登录同一账号，服务端直接给 openid，**永久免授权**。
 *
 * 未登录时静默失败（401），不影响浏览。
 */
export async function bindOpenidToAccount(openid: string): Promise<void> {
  if (!openid) return;
  try {
    const res = await fetch(`${BASE}/api/pay/bind-openid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ openid }),
    });
    if (!res.ok) return;
    reportDiag('openid_bound', { ok: true });
  } catch { /* 忽略：绑定失败只影响"下次还要授权一次"，不影响当前支付 */ }
}

/**
 * 读服务端存的 openid（需要登录）。
 *
 * 支付前先问这里 —— 有值就完全不需要走 OAuth 授权，用户零感知。
 * 未登录返回 null。
 */
export async function fetchMyOpenid(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/pay/my-openid`, { headers: await authHeaders() });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok: boolean; openid?: string | null };
    return j.ok && j.openid ? j.openid : null;
  } catch {
    return null;
  }
}

/** 把 openid 写进 sessionStorage（供 App 层与会员页共用） */
export function cacheOpenid(openid: string): void {
  try { sessionStorage.setItem(OPENID_KEY, openid); } catch { /* 隐私模式 */ }
}

/** 读缓存的 openid（不触发授权） */
export function readCachedOpenid(): string | null {
  try {
    return sessionStorage.getItem(OPENID_KEY);
  } catch {
    return null;
  }
}

/** 付款成功后重置计数，避免下次正常付款被历史计数误伤 */
export function resetOauthTries(): void {
  try { sessionStorage.removeItem(OAUTH_TRIES_KEY); } catch { /* 忽略 */ }
}

/**
 * 设备类型（2026-10-30）。
 *
 * 为什么要前端判一遍、还要传给服务端：iPadOS 13 起 Safari 默认发**桌面 Mac 的 UA**，
 * 服务端只看 UA 会把 iPad 当成电脑，于是给一张二维码让另一台手机扫。
 * 这里用 `maxTouchPoints`（触屏 Mac 不存在，所以 >1 且 UA 是 Macintosh ≈ iPad）修正。
 *
 * 与服务端 `pay_service.resolve_device` 的判定保持一致；服务端会以自己的规则复核。
 */
export function deviceKind(): 'pc' | 'mobile' | 'tablet' {
  const ua = navigator.userAgent;
  const touchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
  const iPad = /ipad/i.test(ua) || (/macintosh/i.test(ua) && touchPoints > 1);
  if (iPad) return 'tablet';
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return 'tablet';
  if (/android|iphone|ipod|mobile/i.test(ua)) return 'mobile';
  return 'pc';
}

/** 是否是微信**电脑版**（UA 里同样带 MicroMessenger，但 JSAPI 拉不起付款面板） */
function isPcWechat(): boolean {
  const ua = navigator.userAgent;
  return /micromessenger/i.test(ua)
    && (/windowswechat|macwechat/i.test(ua) || (/windows nt|macintosh/i.test(ua) && deviceKind() === 'pc'));
}

/**
 * 是否在**手机/平板**微信内置浏览器里。
 *
 * ⚠️ 2026-10-30 改：微信电脑版返回 false。
 * 电脑版里 JSAPI 唤不起付款面板，服务端对它是走 Native 扫码的；
 * 如果这里仍返回 true，前端会去跳网页授权拿 openid（白跑一趟，还打断用户）。
 */
export function inWechat(): boolean {
  return /micromessenger/i.test(navigator.userAgent) && !isPcWechat();
}
