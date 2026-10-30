import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import type { PageView, UserFavorite, RecentView } from '@/types';
import { api, apiMaybe } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { pageToHash, hashToPage, currentPageFromLocation } from '@/lib/routing';
import { patchLibraryState } from '@/lib/listState';

interface AppState {
  page: PageView;
  navigate: (page: PageView) => void;
  /**
   * 阅读器左上角「返回」。
   * 必须回到**用户进来前所在的那一页**（通常是真题库「按试卷」），
   * 而不是这份卷子所属的课程页 —— 后者会让用户丢掉搜索词、筛选和滚动位置。
   */
  backFromReader: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  favorites: UserFavorite[];
  /** 返回 'error' 表示服务端没成功、界面已回滚（调用方应提示用户） */
  toggleFavorite: (paperId: string) => Promise<'added' | 'removed' | 'needs-login' | 'error'>;
  isFavorite: (paperId: string) => boolean;
  recentViews: RecentView[];
  addRecentView: (paperId: string) => void;
  /** 吸底浮层（AI 面板等）占用底部导航区域时置 true → 导航隐藏（2026-10-26 根治遮挡） */
  bottomBarOccupied: boolean;
  setBottomBarOccupied: (v: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;

  // 初始页从地址栏 hash 读，这样刷新/别人发来的链接都能落到正确页面
  const [page, setPage] = useState<PageView>(() => currentPageFromLocation());
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState<UserFavorite[]>([]);
  const [recentViews, setRecentViews] = useState<RecentView[]>([]);
  const [bottomBarOccupied, setBottomBarOccupied] = useState(false);

  // 读者进来之前在哪个页面 —— 用于「返回」时原地回去（含真题库的筛选与滚动，见 lib/listState）
  const pageRef = useRef<PageView>(page);
  /**
   * 「从哪一页点进试卷的」——退出阅读器时回到那一页。
   *
   * 2026-10-22 用户反馈：微信里打开试卷后退出，会乱跳回真题库/首页。
   * 原因是这个来源只存在 **ref** 里 —— 任何一次整页加载（微信重载、分享链接打开、
   * 刷新）都会把它清零。现在同时写进 sessionStorage：
   *   · ref   → 本次会话内即时可用
   *   · sessionStorage → 扛得住重载，且关掉标签页就自动没了（不会误导下一次访问）
   */
  const ORIGIN_KEY = 'ctbu:reader-origin';
  const readOrigin = (): PageView | null => {
    try {
      const h = sessionStorage.getItem(ORIGIN_KEY);
      if (!h) return null;
      const p = hashToPage(h);
      return p && p.name !== 'reader' ? p : null;
    } catch {
      return null;
    }
  };
  const readerOriginRef = useRef<PageView | null>(readOrigin());
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  /** 自己写 hash 时先置位，避免 hashchange 再把同一页 setPage 一次 */
  const ignoreNextHashRef = useRef(false);

  const navigate = useCallback((p: PageView) => {
    // 目标页与当前页完全一致 → 什么都不做。
    // 为什么必须挡：以前重复点同一导航、或 hashchange 回填，会把同一个页面 setPage 两次；
    // 页面对象是新建的，引用变了 → 下游 useEffect 全部重跑。Safari 上表现为"来回刷"。
    const cur = pageRef.current;
    if (pageToHash(cur) === pageToHash(p)) {
      return;
    }

    // 只在「真正进入阅读器」的那一刻记来源：从阅读器再点去登录、改密码等，不覆盖来源
    if (p.name === 'reader' && cur.name !== 'reader') {
      readerOriginRef.current = cur;
      try {
        sessionStorage.setItem(ORIGIN_KEY, pageToHash(cur));
      } catch {
        /* 隐私模式：记不住就退回 ref，不影响本次会话 */
      }
    }
    // 离开真题库前先记住滚动位置 —— 必须在这里做：
    // 下面的 window.scrollTo(0) 会先把页面拉回顶部，等组件卸载时再读就是 0 了（踩过）
    if (cur.name === 'library') {
      patchLibraryState({ scrollY: window.scrollY });
    }
    setPage(p);
    // ⚠️ pageRef 必须**同步**更新：它原来只在 useEffect 里同步，比 setPage 慢一拍。
    // 连续两次 navigate（例如登录后立刻跳页）时，第二次读到的还是旧页，
    // 幂等判断失效 → 又走一遍 setPage + 改 hash → hashchange 再回填，形成抖动。
    pageRef.current = p;
    // 同步到地址栏：刷新不丢、可以把单份试卷的链接发给别人、前进后退可用
    const nextHash = pageToHash(p);
    if (window.location.hash !== nextHash) {
      ignoreNextHashRef.current = true;
      window.location.hash = nextHash;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const backFromReader = useCallback(() => {
    // 直接打开分享链接时没有来源 → 回真题库（默认「按试卷」），而不是空白首页
    navigate(readerOriginRef.current ?? { name: 'library' });
  }, [navigate]);

  // 浏览器前进/后退、或手动改地址栏 -> 跟着切页
  useEffect(() => {
    const onHashChange = () => {
      // navigate() 自己写的 hash：已经 setPage 过了，这里跳过，否则同一页被设两次
      if (ignoreNextHashRef.current) {
        ignoreNextHashRef.current = false;
        return;
      }
      const next = hashToPage(window.location.hash);
      // 再挡一次：hash 解析出的页与当前页相同就不重复 setPage（Safari 会重复派发 hashchange）
      if (next && pageToHash(next) !== pageToHash(pageRef.current)) {
        pageRef.current = next;   // 同步更新，避免下一次 navigate 读到旧值
        setPage(next);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 登录后从本地服务器拉收藏与浏览记录（2026-10-17 · 阶段 5）
  useEffect(() => {
    if (!userId) {
      setFavorites([]);
      setRecentViews([]);
      return;
    }

    /*
     * 用 cancelled 标记丢弃过期响应（2026-10-28）。
     * 场景：A 退出、B 登录（或弱网下 userId 连变两次），A 的请求晚到会把
     * B 的收藏覆盖掉 —— 表现是"登进去看到别人的收藏"。
     */
    let cancelled = false;
    (async () => {
      const [fav, rec] = await Promise.all([
        apiMaybe<{ favorites: { paper_id: string; created_at: string }[] }>('/api/data/favorites'),
        apiMaybe<{ recent: { paper_id: string; viewed_at: string }[] }>('/api/data/recent'),
      ]);
      if (cancelled) return;

      setFavorites(
        (fav?.favorites || []).map((f) => ({
          paperId: f.paper_id,
          addedAt: f.created_at,
        })),
      );
      setRecentViews(
        (rec?.recent || []).map((r) => ({
          paperId: r.paper_id,
          viewedAt: r.viewed_at,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const toggleFavorite = useCallback(
    async (paperId: string): Promise<'added' | 'removed' | 'needs-login' | 'error'> => {
      if (!userId) {
        return 'needs-login';
      }

      const exists = favorites.some((f) => f.paperId === paperId);
      // 乐观更新：先让图标立刻响应，失败再回滚（2026-10-28）
      setFavorites((prev) => (
        exists
          ? prev.filter((f) => f.paperId !== paperId)
          : [{ paperId, addedAt: new Date().toISOString() }, ...prev.filter((f) => f.paperId !== paperId)]
      ));
      try {
        const r = await api<{ action: 'added' | 'removed'; created_at?: string }>(
          '/api/data/favorites/toggle',
          { method: 'POST', body: { paper_id: paperId } },
        );
        // 以服务端结果为准（服务端是幂等 toggle，可能与我们猜的相反）
        if (r.action === 'removed') {
          setFavorites((prev) => prev.filter((f) => f.paperId !== paperId));
        } else {
          setFavorites((prev) => [
            { paperId, addedAt: r.created_at || new Date().toISOString() },
            ...prev.filter((f) => f.paperId !== paperId),
          ]);
        }
        return r.action;
      } catch (e) {
        /*
         * 回滚（2026-10-28 改）。
         *
         * 原来这里"失败当成功"，把图标留在用户点的那个状态：
         * 断网/401 时点了收藏，图标变实、刷新后消失 —— 用户会认为"收藏丢了"，
         * 这是最容易被当成数据丢失的一类反馈。现在恢复原状并返回 'error'，
         * 调用方可以提示"收藏没成功，请检查网络"。
         */
        console.warn('[favorites] 切换失败：', e instanceof Error ? e.message : e);
        setFavorites((prev) => (
          exists
            ? [{ paperId, addedAt: new Date().toISOString() }, ...prev.filter((f) => f.paperId !== paperId)]
            : prev.filter((f) => f.paperId !== paperId)
        ));
        return 'error';
      }
    },
    [userId, favorites],
  );

  const isFavorite = useCallback(
    (paperId: string) => favorites.some((f) => f.paperId === paperId),
    [favorites],
  );

  const addRecentView = useCallback(
    async (paperId: string) => {
      if (!userId) return;

      const r = await apiMaybe<{ viewed_at?: string }>('/api/data/recent', {
        method: 'POST',
        body: { paper_id: paperId },
      });

      setRecentViews((prev) => {
        const filtered = prev.filter((item) => item.paperId !== paperId);
        return [
          { paperId, viewedAt: r?.viewed_at || new Date().toISOString() },
          ...filtered,
        ].slice(0, 20);
      });
    },
    [userId],
  );

  return (
    <AppContext.Provider
      value={{ page, navigate, backFromReader, searchQuery, setSearchQuery, favorites, toggleFavorite, isFavorite, recentViews, addRecentView, bottomBarOccupied, setBottomBarOccupied }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
