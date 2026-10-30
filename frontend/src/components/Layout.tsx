import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { Search, Library, Home, User, ChevronLeft, LogOut, Shield, BookOpen, ListTodo,
} from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useState, useEffect } from 'react';
import { useScrollHide } from '@/hooks/useScrollHide';

export function Header() {
  const { page, navigate, searchQuery, setSearchQuery } = useApp();
  const { session, isAdmin, signOut } = useAuth();
  /**
   * 2026-10-21 用户：「往下滑不要出现搜索框，往上滑才出现，跟其他网站一样」。
   *
   * 这是移动端/现代站点的通用约定（Linear、Stripe、几乎所有 App 都这么干）：
   *   · 往下滚 = 用户在读内容 → 导航让开，把屏幕还给内容
   *   · 往上滚 = 用户想导航/搜索 → 导航立刻回来
   *
   * 实现要点：
   *   1. 记录上一次 scrollY，比较差值判断方向；差值小于阈值不算（防抖动）
   *   2. 顶部 80px 内永远显示（首屏必须能看到导航）
   *   3. 用 transform 而不是 display，才能过渡动画
   */
  /**
   * 方向感知的显隐（2026-10-22 抽出成 useScrollHide）。
   * 抽出去的原因：四六级试卷页的「提交答案」吸顶条要用**完全相同**的判据 ——
   * 两边各写一份就会出现"导航藏了、提交条还停在 64px"的错位。
   */
  const hidden = useScrollHide(80);

  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);


  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate({ name: 'library' });
  };

  const isAuthPage = page.name === 'login' || page.name === 'register' || page.name === 'forgot' || page.name === 'admin';

  const navItems = [
    { label: '首页', icon: Home, view: { name: 'home' as const }, active: page.name === 'home' },
    { label: '真题库', icon: Library, view: { name: 'library' as const }, active: page.name === 'library' },
    // 「四六级」= 真题入口（选套页），不是听力页。学生从导航进来先看到 24 套清单，
    // 再决定"做整套"还是"只练听力"（用户明确否掉了"从听力页顺便跳整套"的结构）
    {
      label: '四六级', icon: BookOpen, view: { name: 'cet' as const },
      active: page.name === 'cet' || page.name === 'cetlisten' || page.name === 'cetpaper',
    },
  ];

  /**
   * 导航栏搜索框的显示条件。
   *
   * 原来：首页永远显示 → 跟 hero 里那个大搜索框重复，一屏两个搜索框。
   * 现在：**只有滚过 hero（scrolled）才出现** —— 此时大搜索框已经滚出视口，
   *       导航栏这个小的正好接班，用户任何时候想搜都能搜到。
   *       配合下面的"下滑隐藏导航"，效果就是：
   *         顶部    → 大搜索框（hero 里）
   *         往下滑  → 导航收起，搜索框不见
   *         往上滑  → 导航回来，搜索框出现
   */
  // 2026-10-21 用户：「首页不需要搜索栏，首页中间就有搜索了」
  // 所以首页导航栏里**永不**显示搜索框；其他页面也不需要（各有各的搜索）。
  const showSearch = false;
  /**
   * 2026-10-21 用户：「主要在做画面中心，没衔接到导航栏」。
   *
   * 原问题：Header 永远白底，Hero 黑底 → 相接处一条硬边界，像两个页面被粘在一起。
   * 大厂做法（Linear / Vercel 都一样）：**首页让导航透明叠在深色区上**，
   * 深色区滚过去之后，导航才浮起来变成一条有底色的条。
   * 这样首屏是一个连续的深色场，而不是"白条 + 黑块 + 白块"。
   *
   * 注意只在 home 生效：别的页没有深色底，透明导航会看不清。
   */
  const isHome = page.name === 'home';


  return (
    <>
    <header
      className={`${
        // 2026-10-21：首页的 logo **随页面滚走**（absolute，不是 fixed）。
        // 用户的澄清：「就像一张图一样几个字，往下翻它会消失」——
        // 它不需要吸顶，也不参与下滑隐藏，就是一个普通页面元素。
        isHome ? 'absolute' : 'fixed'
      } top-0 left-0 right-0 z-50 transition-[transform,background-color,border-color] duration-300 ease-out-expo ${
        isHome ? 'translate-y-0' : hidden ? '-translate-y-full' : 'translate-y-0'
      } ${
        /* 首页仍旧透明叠在 hero 上；其他页始终有底条，保证导航永远可读 */
        scrolled
          ? 'bg-page/88 backdrop-blur-2xl border-b border-hairline/[0.08]'
          : isHome
            ? 'bg-transparent border-b border-transparent'
            : 'bg-page/88 backdrop-blur-2xl border-b border-hairline/[0.08]'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-[73px]">
          {/* Logo */}
          {/*
            2026-10-21 用户：「左上角图标太丑了」。
            丑的根源不是颜色，是**形状语言**：
              原来 = 36×36 圆角方块 + 白色图标 + 两行文字
              Linear = 单色图形，无背景块，无副标题，整体宽 88px

            大厂 logo 的共同点：
              · 不给自己套一个彩色方块（那是 App Icon 的做法，不是导航 logo）
              · 单色，跟着导航文字一起变色（深底白、浅底墨）
              · 旁边最多一行字，绝不放两行（两行会把导航栏撑高、且抢注意力）

            现在：图标本身 = 单色 SVG，文字一行 15px/500，副标题删掉。
          */}
          {/*
            2026-10-21 换成用户手写签名（Louis）。
            C 方案：签名在上、站名小字在下 —— 签名本身没有识别度，
            必须配一行「工商真题库」让学生知道这是什么站。
            图片是白色透明 PNG（public/logo-signature.png），
            在深色底上直接用，不需要 filter。
          */}
          <button
            onClick={() => navigate({ name: 'home' })}
            className="group flex shrink-0 items-center"
            aria-label="工商真题库 首页"
          >
            <span className="flex flex-col items-start gap-[3px]">
              <img
                src="/logo-signature.png"
                alt="Louis"
                width={72}
                height={28}
                className="h-[26px] w-auto opacity-90 transition-opacity duration-200 group-hover:opacity-100"
              />
              <span className="pl-[2px] font-mono text-[9px] uppercase tracking-[0.22em] text-gray-500 transition-colors group-hover:text-gray-700">
                工商真题库
              </span>
            </span>
          </button>

          {/* 主导航（2026-10-21 从移动端底部移到顶部）
              用户要求：① 像其他网页一样在哪都能点 ② 去掉图标只留文字 ③ 不要底部导航 */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              return (
                <button
                  key={item.label}
                  onClick={() => navigate(item.view)}
                  className={`relative px-3 py-1.5 text-[13px] font-normal transition-colors duration-150 ${
                    item.active ? 'text-strong' : 'text-muted hover:text-strong'
                  }`}
                >
                  {item.label}
                  {/* 激活态：底部一条 2px 短横，比整块底色克制得多（Linear 用的是文字变白，这里加一条线强化当前位置） */}
                  {item.active && (
                    <span
                      aria-hidden="true"
                      className={`absolute inset-x-3 -bottom-[1px] h-[1.5px] rounded-full ${
                        'bg-ink-750'
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Desktop search — only on home */}
          {showSearch && (
            <form onSubmit={onSearch} className="hidden lg:flex flex-1 max-w-md mx-4">
              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="搜索课程、真题"
                  placeholder="搜索课程、真题..."
                  className={`w-full pl-10 pr-4 py-2 text-[13px] rounded-lg border outline-none transition-all duration-200 ${
                    'bg-input border-hairline/[0.12] text-strong placeholder-faint/45 focus:border-hairline/[0.28] focus:ring-1 focus:ring-hairline/[0.08]'
                  }`}
                />
              </div>
            </form>
          )}

          {/* 右侧动作：首页也显示 */}
          <div className="flex shrink-0 items-center gap-2">
            {/*
              主题开关放在这一组的最前面（2026-10-22 用户要求：
              「切换按键需要在所有页面上，可以放在上面的功能栏」）。
              左于管理/个人中心，是因为它管的是"整个站怎么显示"，
              优先级比"进哪个页面"更高。
            */}
            <ThemeToggle />

            {isAdmin && (
              <button
                onClick={() => navigate({ name: 'admin' })}
                className={`p-2 rounded-lg transition-colors ${page.name === 'admin' ? 'bg-accent-wash text-accent' : 'text-gray-600 hover:bg-gray-100'}`}
                title="管理后台"
              >
                <Shield className="w-5 h-5" />
              </button>
            )}

            {session ? (
              <>
                <button
                  onClick={() => navigate({ name: 'mistakes' })}
                  className={`p-2 rounded-lg transition-colors ${page.name === 'mistakes' ? 'bg-accent-wash text-accent' : 'text-gray-600 hover:bg-gray-100'}`}
                  title="错题本"
                >
                  <ListTodo className="w-5 h-5" />
                </button>
                <button
                  onClick={() => navigate({ name: 'profile' })}
                  className={`p-2 rounded-lg transition-colors ${page.name === 'profile' ? 'bg-accent-wash text-accent' : 'text-gray-600 hover:bg-gray-100'}`}
                  title="个人中心"
                >
                  <User className="w-5 h-5" />
                </button>
                {/*
                  2026-10-22 删掉「用户名长按钮」。
                  它和个人中心图标（左边的 User 按钮）作用完全一样，
                  都是 navigate({ name: 'profile' })，只是多显示了名字。
                  两个挨着放，右侧动作区显得臃肿。
                  现在只留图标 —— 名字在个人中心页面里能看到。
                */}
                <button
                  onClick={() => signOut()}
                  className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors"
                  title="退出登录"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </>
            ) : (
              !isAuthPage && (
                <button
                  onClick={() => navigate({ name: 'login' })}
                  className="flex items-center gap-1.5 rounded-lg bg-solid px-4 py-2 text-[13px] font-medium text-on-solid transition-all duration-150 hover:bg-solid-hover active:scale-[0.97]"
                >
                  登录
                </button>
              )
            )}
          </div>
        </div>

        {/* Mobile search — only on home */}
        {showSearch && (
          <form onSubmit={onSearch} className="lg:hidden pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="搜索课程、真题"
                placeholder="搜索课程、真题..."
                className="w-full pl-10 pr-4 py-2 text-sm bg-gray-100 rounded-lg border border-transparent focus:bg-ink-850 focus:border-accent outline-none transition-all"
              />
            </div>
          </form>
        )}
      </div>

    </header>
    </>
  );
}

/**
 * 移动端底部导航（独立组件）
 *
 * 2026-10-21 从 Header 里抽出来。
 *
 * 原来它嵌在 <header> 的 JSX 里，而 App 在登录 / 注册 / 找回密码页
 * 不渲染 Header —— 于是未登录访客在这些页面看不到底部栏，
 * 想从登录页跳去"真题库""四六级"或返回首页都没有入口。
 *
 * 抽成独立组件后由 App 单独挂载，登录页同样显示。
 * 高度沿用 --ctbu-mobile-nav-h：吸底听力播放器要按这个高度让位。
 */
export function MobileNav() {
  const { page, navigate } = useApp();
  const { session, isAdmin } = useAuth();
  // AI 面板等吸底浮层打开时，导航整体退出（translate-y-full）而非被盖住：
  // 两者不再争夺同一块屏幕，关面板时滑回来（2026-10-26 根治遮挡）
  const { bottomBarOccupied } = useApp();

  const items = [
    { label: '首页', icon: Home, view: { name: 'home' as const }, active: page.name === 'home' },
    { label: '真题库', icon: Library, view: { name: 'library' as const }, active: page.name === 'library' },
    {
      label: '四六级', icon: BookOpen, view: { name: 'cet' as const },
      active: page.name === 'cet' || page.name === 'cetlisten' || page.name === 'cetpaper',
    },
  ];

  return (
    <nav
      className={`fixed bottom-0 left-0 right-0 z-50 h-[var(--ctbu-mobile-nav-h)] border-t border-hairline/[0.08] bg-ink-950 backdrop-blur-2xl transition-transform duration-200 ease-out md:hidden ${
        bottomBarOccupied ? 'translate-y-full' : 'translate-y-0'
      }`}
    >
      <div className="flex h-full items-center justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              onClick={() => navigate(item.view)}
              className={`flex flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] transition-colors duration-150 ${
                item.active ? 'text-strong' : 'text-muted'
              }`}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
        {isAdmin && (
          <button
            onClick={() => navigate({ name: 'admin' })}
            className={`flex flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] transition-colors duration-150 ${
              String(page.name) === 'admin' ? 'text-strong' : 'text-muted'
            }`}
          >
            <Shield className="h-[18px] w-[18px]" aria-hidden="true" />
            管理
          </button>
        )}
        <button
          onClick={() => navigate({ name: 'mistakes' })}
          className={`flex flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] transition-colors duration-150 ${
            page.name === 'mistakes' ? 'text-strong' : 'text-muted'
          }`}
        >
          <ListTodo className="h-[18px] w-[18px]" aria-hidden="true" />
          错题
        </button>
        <button
          onClick={() => navigate({ name: 'profile' })}
          className={`flex flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] transition-colors duration-150 ${
            page.name === 'profile' ? 'text-strong' : 'text-muted'
          }`}
        >
          <User className="h-[18px] w-[18px]" aria-hidden="true" />
          {session ? '我的' : '登录'}
        </button>
      </div>
    </nav>
  );
}

export function BackBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { navigate } = useApp();
  /*
   * BackBar 也要跟着导航显隐（2026-10-22）。
   * 它是用户从课程页退回去的唯一出口之一：导航收起后如果还停在 73px，
   * 屏幕顶端会留一条空档，看起来像"卡住了"。
   */
  const hideTopBar = useScrollHide(80);
  return (
    <div
      className={`sticky z-40 border-b border-hairline/[0.07] bg-page/90 backdrop-blur-xl transition-[top] duration-200 ease-out ${
        hideTopBar ? 'top-0' : 'top-[73px]'
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <button
          onClick={() => navigate({ name: 'library' })}
          aria-label="返回"
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-elevate/[0.06] hover:text-strong active:scale-90"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-medium tracking-[-0.01em] text-strong">{title}</h1>
          {subtitle && <p className="truncate font-mono text-[11px] text-faint">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

export function Footer() {
  const { navigate } = useApp();

  const quickLinks = [
    { label: '首页', action: () => navigate({ name: 'home' }) },
    { label: '真题库', action: () => navigate({ name: 'library' }) },
    { label: '个人中心', action: () => navigate({ name: 'profile' }) },
    { label: '服务条款', action: () => navigate({ name: 'terms' }) },
    { label: '隐私政策', action: () => navigate({ name: 'privacy' }) },
  ];

  return (
    /* 2026-10-21：页脚改成深色，与首屏 hero 首尾呼应。
       原来浅灰页脚 + 白色内容区 + 黑色 hero = 三种底色，页面被切成三段。
       现在首屏与页脚同为 #08090a，中间内容区白 → 整体读起来是"深—浅—深"的一个完整包裹。 */
    <footer className="relative mt-auto overflow-hidden bg-page">
      {/* 页脚顶部一条极淡的渐变光，和 hero 里那团呼应，避免纯黑块显得死 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-20 md:pb-14">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 text-sm">
          <div>
            {/* 2026-10-21：与顶部导航同一套 brand —— 手写签名 + 小字站名，
                页脚和导航保持一致，不再用任何色块或图标。 */}
            <div className="mb-4 flex flex-col items-start gap-1">
              <img
                src="/logo-signature.png"
                alt="Louis"
                width={62}
                height={24}
                className="h-[22px] w-auto opacity-70"
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted">工商真题库</span>
            </div>
            {/* 品牌列只留联系方式（用户 2026-10-20 要求删掉"个人整理…分享平台"那句） */}
            <div className="mt-3 space-y-1.5 text-[12px] text-muted leading-relaxed">
              <p>
                商务合作请微信联系：
                <span className="select-all font-medium text-faint">+852 95533954</span>
              </p>
              <p>
                客服 QQ：
                <span className="select-all font-medium text-faint">3673683474</span>
              </p>
              <p>工作时间 9:00–23:00</p>
            </div>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted mb-3">快速链接</p>
            <ul className="space-y-1 text-faint text-[13px]">
              {quickLinks.map((link) => (
                <li key={link.label}>
                  <button
                    onClick={link.action}
                    className="inline-flex items-center min-h-[24px] text-faint hover:text-strong transition-colors"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted mb-3">免责声明</p>
            <p className="text-muted text-[12px] leading-[1.75]">
              本站为个人整理的学习资料分享站点，与任何学校、机构均无隶属关系，不代表其立场。
              资料仅供个人学习参考；相关版权归原作者与学校所有。
              如权利人认为内容不妥，可联系本站下架。
            </p>
          </div>
        </div>
        <div className="mt-14 pt-7 border-t border-hairline/[0.08] flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-muted">
          <p className="font-mono tracking-[0.02em]">© 2026 工商真题库 · 仅供学习交流使用</p>
          {/* 备案号（管局硬性要求：首页底部展示，并链接工信部网站）。
              2026-10-21 备案通过，已填真实号：渝ICP备2026026074号-1 */}
          <p>
            <a
              href="https://beian.miit.gov.cn/"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center min-h-[24px] text-muted hover:text-strong/60 transition-colors font-mono"
            >
              渝ICP备2026026074号-1
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
