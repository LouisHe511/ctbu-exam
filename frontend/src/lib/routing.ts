import type { PageView } from '@/types';

/**
 * 把页面状态与 URL 的 hash 互相转换。
 *
 * 为什么需要：这个项目没有路由库（历史决策，不换技术栈），页面切换靠 AppContext 的 state。
 * 后果是 —— **刷新就回首页，而且没法把某一份试卷的链接发给同学**。
 * 对学生"互相传真题"这个核心场景，那是硬伤。
 *
 * 这里只用 URL hash（`#/paper/<id>`），不引入任何依赖：
 *   - 刷新后能回到同一页
 *   - 可以把某份试卷的链接直接发给别人
 *   - 浏览器前进/后退可用
 *
 * 编码格式（保持可读，方便手工改）：
 *   #/                    首页
 *   #/library             真题库
 *   #/library/math        真题库（指定分类）
 *   #/course/c001         某门课程
 *   #/paper/<试卷id>      某份试卷的阅读器
 *   #/cet                 **四六级真题选择页**（四级/六级 × 24 套）
 *   #/cet/listen/<套>     某套的听力页，如 #/cet/listen/cet4-2024-12-1
 *   #/cet-paper/<套>      某套的整套交互试卷
 *   #/profile #/login #/register #/forgot #/privacy #/admin
 */

const SIMPLE_PAGES = ['profile', 'membership', 'login', 'register', 'forgot', 'privacy', 'terms', 'mistakes', 'admin'] as const;
type SimplePage = (typeof SIMPLE_PAGES)[number];

function isSimplePage(s: string): s is SimplePage {
  return (SIMPLE_PAGES as readonly string[]).includes(s);
}

export function pageToHash(page: PageView): string {
  switch (page.name) {
    case 'home':
      return '#/';
    case 'library':
      return page.category ? `#/library/${page.category}` : '#/library';
    case 'course':
      return `#/course/${page.courseId}`;
    case 'reader':
      return `#/paper/${page.paperId}`;
    // ⚠️ 这一条曾经漏了：'cet' 不在 SIMPLE_PAGES 里，落到 default 会返回 '#/'，
    //    于是 navigate({name:'cet'}) 先把状态设成四六级页、却把 hash 写成 '#/'，
    //    紧接着 hashchange 又把状态解析回首页 —— 表现为「点导航『四六级』永远回首页」，
    //    连带全卷页的「← 真题列表」返回键失效。2026-10-16 修。
    case 'cet':
      return '#/cet';
    case 'cetlisten':
      return `#/cet/listen/${page.slug}`;
    case 'cetpaper':
      return `#/cet-paper/${page.slug}`;
    default:
      return isSimplePage(page.name) ? `#/${page.name}` : '#/';
  }
}

/** 解析 hash；无法识别时返回 null（调用方回退到首页） */
export function hashToPage(hash: string): PageView | null {
  // 先剥掉 ?ref=xxx 这类查询串，否则 'register?ref=ABC' 会被当成未知页面而回退首页
  const rawAll = (hash || '').replace(/^#\/?/, '').trim();
  const qIdx = rawAll.indexOf('?');
  const raw = qIdx === -1 ? rawAll : rawAll.slice(0, qIdx);
  if (!raw) return { name: 'home' };

  const slash = raw.indexOf('/');
  const seg = slash === -1 ? raw : raw.slice(0, slash);
  const arg = slash === -1 ? '' : raw.slice(slash + 1);

  // 只取第一段参数，避免 URL 里带了多余内容导致匹配失败
  const value = arg.split('/')[0];

  switch (seg) {
    case 'library':
      return value ? { name: 'library', category: value } : { name: 'library' };
    case 'course':
      return value ? { name: 'course', courseId: value } : null;
    case 'paper':
      return value ? { name: 'reader', paperId: value } : null;
    case 'cet-paper':
      // 例：#/cet-paper/cet4-2024-12-1
      return value ? { name: 'cetpaper', slug: value } : null;
    case 'cet': {
      // #/cet                → 四六级真题选择页
      // #/cet/listen/<套>     → 该套的听力页
      if (arg.startsWith('listen/')) {
        const sl = arg.slice('listen/'.length).split('/')[0];
        return sl ? { name: 'cetlisten', slug: sl } : { name: 'cet' };
      }
      return { name: 'cet' };
    }
    default:
      return isSimplePage(seg) ? ({ name: seg } as PageView) : null;
  }
}

/** 读取当前地址栏对应的页面（首次加载用） */
export function currentPageFromLocation(): PageView {
  /*
   * 微信 OAuth 回调的初始路由（2026-10-27）。
   *
   * 授权回调长这样：`https://louisnb.cn/?code=xxx&state=%2F%23%2Fmembership`
   * —— 落在**根路径**，hash 是空的。按常规解析会先渲染首页，等 App 层
   * 捕获完 openid 再 navigate 到会员页，中间有约半秒的首页闪现，
   * 用户看到的就是"页面跳回首页"。
   *
   * 这里**在首次解析路由时就直接用 state 里的目标页**，
   * 让第一帧就是会员页，彻底没有"首页 → 会员页"那一跳。
   * 前提：state 必须是站内路由（以 / 开头），防开放重定向。
   */
  const st = window.location.href.match(/[?&]state=([^&#]+)/);
  if (st) {
    try {
      const back = decodeURIComponent(st[1]);
      if (back.startsWith('/') && back.includes('#')) {
        const fromState = hashToPage(back.slice(back.indexOf('#')));
        if (fromState) return fromState;
      }
    } catch { /* 解码失败就用常规逻辑 */ }
  }
  return hashToPage(window.location.hash) ?? { name: 'home' };
}
