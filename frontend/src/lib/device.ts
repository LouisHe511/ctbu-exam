/**
 * 设备标识（2026-10-17 · 登录设备限制）
 *
 * ## 为什么要有它
 * 一个账号最多 2 台设备同时在线，用来防「把账号借给同学」。
 * 判定依据**不能是 IP**：校园网/宿舍 WiFi 都是 NAT，几十人共用一个出口 IP，
 * 按 IP 限 2 会误伤同宿舍的人；而借号者若在同一 WiFi，IP 根本一模一样。
 *
 * ## device_id 怎么来
 * 首次访问生成一个 UUID 存在 localStorage，之后一直复用：
 *   - 同一浏览器关掉再开、换网络 → 还是同一台设备（不占新名额）
 *   - 清缓存 / 无痕模式 / 换浏览器 → 变成"新设备"（会占名额）
 * 这是刻意的：想靠清缓存绕过限制，只会更快把自己的名额用光。
 *
 * ⚠️ 它只是个"标识"，不是安全凭证 —— 真正的权限判断永远在服务端会话表上。
 */

const DEVICE_KEY = 'ctbu_device_id';

/** 取（必要时生成）本机 device_id */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // 隐身模式禁用存储：退化成"每次都是新设备"，会被名额拦住，但不会崩
    return 'no-storage';
  }
}

/** 人话设备名，给用户在「我的设备」里认领（"Safari · macOS"） */
export function getDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (!ua) return '未知设备';

  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '未知系统';

  const browser = /MicroMessenger/i.test(ua)
    ? '微信'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '浏览器';

  return `${browser} · ${os}`;
}

/** 登录/注册时随请求一起发（服务端据此登记设备） */
export function devicePayload(): { device_id: string; device_name: string } {
  return { device_id: getDeviceId(), device_name: getDeviceName() };
}

/** 把 ISO 时间写成「3 分钟前 / 昨天 / 10-15」，让用户认得出是哪台设备 */
export function formatLastSeen(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
