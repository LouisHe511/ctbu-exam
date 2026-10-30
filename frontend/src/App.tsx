import { AuthProvider, useAuth } from '@/context/AuthContext';
import { AppProvider, useApp } from '@/context/AppContext';
import { FounderExtendedNotice } from '@/components/FounderExtendedNotice';
import { captureWechatOpenidOnBoot, readOAuthState, reportDiag } from '@/lib/pay';
import { PapersProvider } from '@/context/PapersContext';
import { AccessProvider } from '@/context/AccessContext';
import { Header, Footer, MobileNav } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HomePage } from '@/pages/HomePage';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { readPendingPay, isFreshEntryFromOutside } from '@/lib/payResume';

/**
 * ═══════════════════════════════════════════════════════════
 * 2026-10-21 路由级代码分割
 * ═══════════════════════════════════════════════════════════
 * 之前 13 个页面全部静态导入 → 首页必须下载**整个应用**的 JS（460KB），
 * 其中包含 PDF 阅读器（pdfjs 341KB + worker 1.3MB）、四六级听力、
 * 管理后台等首页完全用不到的东西。实测首屏要 1.4 秒才开始渲染。
 *
 * 现在只静态导入首页（首屏必须要它），其余按需加载：
 *   · 首页首屏只需要 HomePage + Layout + 几个 context
 *   · 点进真题库才下载 LibraryPage
 *   · 点进试卷才下载 pdfjs（约 1.6MB，只在真正看卷子时需要）
 *
 * 为什么不给 HomePage 也加 lazy：
 *   首屏页面 lazy 会多一次「请求 chunk」的往返，
 *   深色背景在 chunk 到达前是白的，会闪一下。首页必须同步。
 */
// ─────────────────────────────────────────────────────────────
// 每个懒加载页面单独命名一个 loader。
// 为什么不像以前那样写成 inline `() => import(...)`：
//   ① 需要在首屏之后**预取**这些 chunk（见下面的 preloadAllPages），
//      inline 写法拿不到那个 loader 函数；
//   ② 微信内置浏览器里网络抖一下，chunk 拿不到就会走 vite:preloadError
//      → 触发一次整页刷新 —— 用户看到的就是「点一下刷新两次」。
//      提前把 chunk 放进缓存，这条路基本不会再被走到。
// ─────────────────────────────────────────────────────────────
const loadLibrary = () => import('@/pages/LibraryPage').then(m => ({ default: m.LibraryPage }));
const loadCourse = () => import('@/pages/CourseDetailPage').then(m => ({ default: m.CourseDetailPage }));
const loadReader = () => import('@/pages/ExamReaderPage').then(m => ({ default: m.ExamReaderPage }));
const loadProfile = () => import('@/pages/ProfilePage').then(m => ({ default: m.ProfilePage }));
const loadMembership = () => import('@/pages/MembershipPage').then(m => ({ default: m.MembershipPage }));
const loadAuth = () => import('@/pages/AuthPage').then(m => ({ default: m.AuthPage }));
const loadAdmin = () => import('@/pages/AdminPage').then(m => ({ default: m.AdminPage }));
const loadPrivacy = () => import('@/pages/PrivacyPage').then(m => ({ default: m.PrivacyPage }));
const loadTerms = () => import('@/pages/ServiceTermsPage').then(m => ({ default: m.ServiceTermsPage }));
const loadCetHome = () => import('@/pages/CetHomePage').then(m => ({ default: m.CetHomePage }));
const loadCet = () => import('@/pages/CetPage').then(m => ({ default: m.CetPage }));
const loadCetPaper = () => import('@/pages/CetPaperPage').then(m => ({ default: m.CetPaperPage }));
const loadReset = () => import('@/pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage }));
const loadMistakes = () => import('@/pages/MistakesPage').then(m => ({ default: m.MistakesPage }));

const LibraryPage = lazy(loadLibrary);
const CourseDetailPage = lazy(loadCourse);
const ExamReaderPage = lazy(loadReader);
const ProfilePage = lazy(loadProfile);
const MembershipPage = lazy(loadMembership);
const AuthPage = lazy(loadAuth);
const AdminPage = lazy(loadAdmin);
const PrivacyPage = lazy(loadPrivacy);
const ServiceTermsPage = lazy(loadTerms);
const CetHomePage = lazy(loadCetHome);
const CetPage = lazy(loadCet);
const CetPaperPage = lazy(loadCetPaper);
const ResetPasswordPage = lazy(loadReset);
const MistakesPage = lazy(loadMistakes);

/**
 * 首屏画完之后，把其余页面的 chunk 挨个预取到浏览器缓存里。
 *
 * 目的（2026-10-22 用户反馈「微信里点底部导航会刷新两次」）：
 *   原来点导航 → 页面是 lazy 的 → 要现下 chunk → 期间 Suspense 给一块空深色
 *   → chunk 到了再淡入。手上有缓存时这一段几乎看不见；网络一慢就是
 *   「闪一下再加载」的观感，在微信里尤其明显。
 *   预取之后，点导航基本是同步切换。
 *
 * 顺序刻意从「最常点的」开始：真题库 → 四六级 → 个人中心 → 会员。
 * 单个失败不影响其它（各自 catch 掉），也不会抛到 React。
 */
/*
 * 预取顺序（2026-10-28 收窄）。
 *
 * 原来把 13 个页面全预取了，累计 600KB+：其中 AdminPage（57KB）对 99% 的用户
 * 完全没用，Reader/Auth/Reset 也不是"进去就要翻"的页。移动流量下这是白付。
 * 现在只预取**导航栏能点到**的 4 个高频页；其余在真正跳转时再加载（有 loading 态）。
 */
const PRELOAD_ORDER = [
  loadLibrary, loadCetHome, loadCet, loadCourse, loadProfile, loadMembership,
];

function preloadAllPages(): void {
  let i = 0;
  const step = () => {
    const next = PRELOAD_ORDER[i++];
    if (!next) return;
    next()
      .catch(() => { /* 预取失败无所谓：真正跳转时会再试一次 */ })
      .finally(() => {
        // 一页一页来，别和首屏抢带宽
        if (i < PRELOAD_ORDER.length) setTimeout(step, 120);
      });
  };
  step();
}

function AppContent() {
  const { page, navigate } = useApp();
  const { loading, isPasswordRecovery, profile } = useAuth();

  /**
   * 「付到一半出去了，回来接着付」（2026-10-21）
   * ---------------------------------------------------------------
   * 在微信里点「确认支付」会跳到支付平台的收银台。学生退出微信去扫一扫，
   * 再点链接回来时，微信打开的是**首页** —— 订单、金额全没了，
   * 他既不知道钱付给谁，也不敢再付一次（用户原话反馈的就是这件事）。
   *
   * 所以跳走前会把订单号存进 localStorage（见 lib/payResume.ts），
   * 这里在**整页加载**时读一次：有未过期的待付单、且是"从外面点链接进来"，
   * 就直接把人送回会员页。页面内路由切换不会触发（ref 只跑一次）。
   */
  // 首屏之后预取其余页面（见上面 preloadAllPages 的说明）
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(() => preloadAllPages(), { timeout: 3000 });
    } else {
      const t = setTimeout(preloadAllPages, 1200);
      return () => clearTimeout(t);
    }
  }, []);

  /**
   * **全局**捕获微信 OAuth 回调带回的 code → 换 openid（2026-10-27）。
   *
   * 为什么必须在 App 层：为了让 redirect_uri 不带 hash（微信对带 # 的地址处理不可靠），
   * 后端现在把它设成根路径 `https://louisnb.cn/`，所以**授权回调落在首页**。
   * 如果只在会员页组件里读 code，首页时组件没挂载 → code 白丢 →
   * 用户点支付只会看到"跳一下又回来"，永远拿不到 openid。
   *
   * 换到 openid 后跳回会员页，把用户送回他本来要去的地方。
   */
  const wxBootRef = useRef(false);
  useEffect(() => {
    if (wxBootRef.current) return;
    wxBootRef.current = true;
    void (async () => {
      // 先把回程路由读出来 —— 后端把它放在 state 里（如 `/#/membership`）
      const back = readOAuthState();
      reportDiag('boot_enter', { back, hasCode: /[?&]code=/.test(window.location.href) });
      const gotIt = await captureWechatOpenidOnBoot();
      reportDiag('boot_after_capture', { back, gotIt });
      if (!gotIt) { reportDiag('boot_abort', { reason: 'capture_failed' }); return; }

      /*
       * 换到 openid 后把用户送回他要去的页面。
       *
       * 优先用 state 里的路由（哪个页面发起的授权就回哪），
       * 拿不到时退回会员页 —— 因为目前只有会员页会发起微信授权。
       *
       * 用 `window.location.hash = ...` 而不是 navigate()：
       * hash 变更会触发路由系统自己的监听，比手工拼 page 对象更可靠，
       * 也不用在这里维护一份「路由 → page 对象」的映射。
       */
      /*
       * 回程用 `navigate()` 而不是裸改 `window.location.hash`。
       *
       * 裸改 hash 依赖 hashchange 监听回填，而那个监听有 `ignoreNextHashRef`
       * 防抖逻辑（navigate 自己写的 hash 会被跳过）。授权回来是整页加载，
       * 万一这个 ref 的时序有偏差，hash 改了但页面不切 —— 用户就"停在首页"。
       *
       * navigate() 直接 setPage + 改 hash，是站内唯一的正规入口，不会出这种偏差。
       */
      reportDiag('boot_redirect', { back, currentHash: window.location.hash });
      navigate({ name: 'membership' });
    })();
    // page.name 故意不进依赖：只在整页加载后跑一次，避免换页时重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resumeChecked = useRef(false);
  useEffect(() => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    if (!readPendingPay()) return;
    if (!isFreshEntryFromOutside()) return;
    if (page.name !== 'home') return;   // 深链到具体页面时不打扰
    navigate({ name: 'membership' });
  }, [navigate, page.name]);

  if (loading) {
    return (
      /* 启动等待页：深色底，避免白屏一闪 */
      <div className="flex min-h-screen items-center justify-center bg-page">
        <Loader2 className="h-5 w-5 animate-spin text-gray-500" aria-hidden="true" />
      </div>
    );
  }

  if (isPasswordRecovery) {
    return <ResetPasswordPage />;
  }

  const isReader = page.name === 'reader';
  // 四六级听力/全卷有吸底播放器，页脚会和它叠在一起 → 这些页面都不渲染页脚
  const noFooter = isReader || page.name === 'cet' || page.name === 'cetlisten' || page.name === 'cetpaper';
  const isAuthPage = page.name === 'login' || page.name === 'register' || page.name === 'forgot';

  // 切页动画的 key：同一页面换参数（换课程、换试卷）也要重新播放
  const pageKey =
    page.name === 'course' ? `course-${page.courseId}`
    : page.name === 'reader' ? `reader-${page.paperId}`
    : page.name === 'cetpaper' ? `cetpaper-${page.slug}`
    : page.name === 'cetlisten' ? `cetlisten-${page.slug}`
    : page.name === 'library' ? `library-${page.category ?? 'all'}`
    : page.name;

  return (
    <div className="min-h-screen flex flex-col bg-ink-850">
      {!isAuthPage && <Header />}
      <main className="flex-1">
        {/* 只用透明度做切页动画：带 transform 的动画会给 fixed 子元素造出新的包含块，容易出怪问题 */}
        <div key={pageKey} className="animate-fade-in">
          {/*
            Suspense 包住 lazy 页面。fallback 必须是深色背景 ——
            否则 chunk 下载的几百毫秒里会闪一块白，比"等"更难看。
            首页是静态导入，不经过这里，所以首屏不受影响。
          */}
          {/*
            ErrorBoundary 必须包在 Suspense 外面（层级上更外层）：
            lazy 加载失败是在**渲染期**抛错的，只有父级边界能接住。
            没有它的话 React 会卸载整棵树 → #root 变空 → 整页黑屏
            （2026-10-21 学生登录后点「四六级」就踩到了这个）。
            resetKey 用 pageKey：换页时自动复位，一次报错不会把后续页面全卡死。
          */}
          <ErrorBoundary resetKey={pageKey}>
          <Suspense fallback={<div className="min-h-[60vh] bg-page" />}>
          {page.name === 'home' && <HomePage />}
          {page.name === 'library' && <LibraryPage />}
          {page.name === 'course' && <CourseDetailPage courseId={page.courseId} />}
          {page.name === 'reader' && <ExamReaderPage paperId={page.paperId} />}
          {page.name === 'membership' && <MembershipPage />}
          {page.name === 'profile' && <ProfilePage />}
          {page.name === 'login' && <AuthPage mode="login" />}
          {page.name === 'register' && <AuthPage mode="register" />}
          {page.name === 'forgot' && <AuthPage mode="forgot" />}
          {page.name === 'cet' && <CetHomePage />}
          {page.name === 'cetlisten' && <CetPage slug={page.slug} />}
          {page.name === 'cetpaper' && <CetPaperPage slug={page.slug} />}
          {page.name === 'privacy' && <PrivacyPage />}
          {page.name === 'terms' && <ServiceTermsPage />}
          {page.name === 'mistakes' && <MistakesPage />}
          {page.name === 'admin' && <AdminPage />}
          </Suspense>
          </ErrorBoundary>
        </div>
      </main>
      {!noFooter && !isAuthPage && <Footer />}
      {/*
        移动端底部导航：**所有页面都挂**，包括登录/注册/找回密码。
        未登录访客在这几个页面需要一个出口（首页 / 真题库 / 四六级），
        否则只能靠浏览器返回。
        留出底部内边距，避免页面内容被吸底栏盖住。
      */}
      <MobileNav />
      <div className="h-[var(--ctbu-mobile-nav-h)] md:hidden" aria-hidden="true" />

      {/*
        创始会员试用期延长通知（2026-10-23）。
        组件内部自己判断：是不是创始会员、是不是永久会员、是不是已经看过。
        挂在这里而不是某个页面里，因为用户可能从**任何**链接进来 ——
        只挂首页会漏掉从收藏夹/分享链接直接到真题库的人。
      */}
      <FounderExtendedNotice
        isFounder={Boolean(profile?.is_founder)}
        tier={profile?.membership_tier}
        /*
          永久 = tier 是 lifetime，或有效期是 infinity。
          ⚠️ `infinity` 经后端 `_jsonable` 序列化后是 `9999-12-31T23:59:59…`，
             所以既要认字符串 'infinity'，也要认 9999 年（psycopg2 会把
             timestamptz 的 infinity 转成 datetime.max）。
        */
        isLifetime={
          profile?.membership_tier === 'lifetime'
          || profile?.membership_expires_at === 'infinity'
          || String(profile?.membership_expires_at ?? '').startsWith('9999')
        }
      />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <PapersProvider>
        <AccessProvider>
          <AppProvider>
            <AppContent />
          </AppProvider>
        </AccessProvider>
      </PapersProvider>
    </AuthProvider>
  );
}

export default App;
