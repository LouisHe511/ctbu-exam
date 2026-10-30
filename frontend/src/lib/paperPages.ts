/**
 * 试卷「逐页图片」通道的客户端。
 *
 * 背景：扫描版试卷整份 2~2.5 MB，而 PDF.js 必须拿到**整份**才能渲染第一页 ——
 * 实测在 3 Mbps 上首屏要 7.9 秒。服务端把这类试卷切成了逐页 WebP（每页约 110 KB），
 * 实测首屏 134 毫秒。矢量版试卷**不走这条路**（图片化反而会变大 4 倍），
 * 服务端会回 kind='pdf'，调用方据此回退到原来的 PDF 阅读器。
 *
 * 为什么不在这里做任何权限判断：
 *   服务端返回的是**已签名的**图片链接，签名一旦发出就可访问。
 *   前端做多少检查都拦不住直接构造请求，所以授权只在服务端做，
 *   这里只负责"问一句有没有图片版"。
 */

/** 图片链接有效期（服务端签发时决定，这里只是给 React 做缓存提示用） */
export type PaperPagesResult =
  | { kind: 'images'; pages: number; urls: string[] }
  /**
   * 没有图片版，走 PDF。
   * `url` 是本机（自己服务器）的签名链接 —— 2026-10-17 起全部 PDF 已搬回国内，
   * 有值就优先用它，没有（过渡期或漏搬）则回退 Supabase。
   */
  | { kind: 'pdf'; pages: number; url?: string | null };

const TIMEOUT_MS = 10_000;

/**
 * 问服务端：这份试卷有没有逐页图片版？
 *
 * 任何异常（未登录 / 无权限 / 网络问题 / 超时）一律返回 null，
 * 由调用方回退到 PDF —— **不要**在这里弹错误提示：
 * 试卷本身能看（服务端只是没给图片版）时，把用户拦下来是更糟的体验。
 */
export async function fetchPaperPages(
  paperId: string,
  accessToken: string | null,
  which: 'paper' | 'answer' = 'paper',
): Promise<PaperPagesResult | null> {
  if (!paperId || !accessToken) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `/api/pay/paper-pages?paper_id=${encodeURIComponent(paperId)}` +
      (which === 'answer' ? '&which=answer' : '');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;                 // 401/403/404 等都走回退，不打扰用户
    const data = (await res.json()) as {
      ok?: boolean; kind?: string; pages?: number; urls?: string[]; url?: string | null;
    };
    if (!data?.ok) return null;
    if (data.kind === 'images' && Array.isArray(data.urls) && data.urls.length > 0) {
      return { kind: 'images', pages: data.urls.length, urls: data.urls };
    }
    return { kind: 'pdf', pages: Number(data.pages) || 0, url: data.url ?? null };
  } catch {
    // 超时、断网、JSON 解析失败 —— 全部静默回退
    return null;
  } finally {
    clearTimeout(timer);
  }
}
