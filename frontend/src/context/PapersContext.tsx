import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import type { ExamPaper } from '@/types';
import { fetchPapersBundle } from '@/lib/papers';
import { useAuth } from '@/context/AuthContext';

interface PapersState {
  /** 页面上实际展示的已入库试卷和资料；数据库为空时显示 demo */
  papers: ExamPaper[];
  /** 私有 Supabase 入库记录 */
  realPapers: ExamPaper[];
  /** 正在加载 */
  loading: boolean;
  /** 数据库里还没有上传资料 */
  isDemo: boolean;
  /** 匿名时：每门课还有多少套是登录后才能看的 */
  loginOnlyByCourse: Record<string, number>;
  /** 匿名时：登录可见的试卷总数 */
  loginOnlyTotal: number;
  /** 全库总份数（匿名时由服务端额外下发；登录后等于 papers.length） */
  totalPapers: number;
  /** 全库含答案份数（同上） */
  totalWithAnswer: number;
  /** 重新从数据库拉取 */
  refresh: () => Promise<void>;
  getPaperById: (id: string) => ExamPaper | undefined;
}

const PapersContext = createContext<PapersState | null>(null);

/**
 * 2026-10-21：首页那三个数字（课程数 / 份数 / 含答案）不要等接口。
 *
 * 用户原话：「真题套数能够在用户打开的时候不要加载，一下就能看到」。
 * 原来流程是：挂载 → fetchPapersBundle()（要拉整个试卷列表）→ setTotal → 数字出现。
 * 网络慢时首页会先显示 0，一两秒后才跳到 104 —— 观感和截图都难看。
 *
 * 改法：把上一次拿到的数字写进 localStorage，下次打开**同步读出来**当初始值，
 * 然后在后台刷新校正。数字来源仍是服务端真实值，只是把"上次的值"当占位，
 * 不是写死常量 —— 题库更新后第二次访问就是新数字。
 */
const TOTALS_CACHE_KEY = 'ctbu_library_totals_v1';

type TotalsCache = { papers: number; withAnswer: number; courses: number };

/**
 * 读首屏数字，优先级：
 *   1. window.__CTBU_TOTALS__ —— index.html 的 <head> 脚本预取的（最早、最准）
 *   2. localStorage            —— 上次访问留下的
 *   3. 0                       —— 前面都没有才从 0 开始
 *
 * 为什么要读全局而不是自己发请求：
 *   <head> 里的脚本在 React bundle 下载**之前**就发出了请求，
 *   等 React 挂载时（通常几百 ms 后）结果多半已经到了，可以直接同步读到。
 *   这样用户看到的就是"打开即有数字"，而不是"打开 → 空 → 跳数"。
 */
function readTotalsCache(): TotalsCache | null {
  try {
    const prefetched = (window as unknown as { __CTBU_TOTALS__?: TotalsCache }).__CTBU_TOTALS__;
    if (prefetched && prefetched.papers > 0) {
      return { papers: prefetched.papers, withAnswer: prefetched.withAnswer || 0, courses: prefetched.courses || 0 };
    }
    const raw = localStorage.getItem(TOTALS_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as TotalsCache;
    if (typeof v.papers === 'number' && v.papers > 0) return v;
    return null;
  } catch {
    return null;
  }
}

function writeTotalsCache(v: TotalsCache) {
  try {
    localStorage.setItem(TOTALS_CACHE_KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

export function PapersProvider({ children }: { children: ReactNode }) {
  const [realPapers, setRealPapers] = useState<ExamPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [loginOnlyByCourse, setLoginOnlyByCourse] = useState<Record<string, number>>({});
  const [loginOnlyTotal, setLoginOnlyTotal] = useState(0);
  // 初始值优先用上次缓存的数字 → 首帧就有数，不留 0
  const cachedTotals = useRef<TotalsCache | null>(readTotalsCache());
  const [totalPapers, setTotalPapers] = useState(cachedTotals.current?.papers ?? 0);
  const [totalWithAnswer, setTotalWithAnswer] = useState(cachedTotals.current?.withAnswer ?? 0);
  const { session, loading: authLoading } = useAuth();
  const token = session?.access_token ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const b = await fetchPapersBundle();
      setRealPapers(b.papers);
      setLoginOnlyByCourse(b.loginOnlyByCourse);
      setLoginOnlyTotal(b.loginOnlyTotal);

      // 服务端给了全库数字就用它（匿名时更准）；没给说明是登录态，用本地长度
      const nextPapers = b.totalPapers ?? b.papers.length;
      const nextWithAnswer = b.totalWithAnswer ?? b.papers.filter((p) => p.hasAnswer).length;

      /**
       * ⚠️ 只有拿到「非零」结果才覆盖 state 和缓存。
       *
       * 接口失败 / 被墙 / 离线时，fetch 可能成功但返回空数组（totalPapers=0），
       * 也可能直接抛异常。两种情况都不能把已有的 104 冲成 0 ——
       * 否则用户每次打开首页都先看到「0 份真题」，等网络好了再跳回 104。
       * 2026-10-21 实测踩到的就是这个坑。
       */
      if (nextPapers > 0) {
        setTotalPapers(nextPapers);
        setTotalWithAnswer(nextWithAnswer);
        writeTotalsCache({ papers: nextPapers, withAnswer: nextWithAnswer, courses: 0 });
      }
    } catch (err) {
      // 网络异常：保留上一次的数字（初始值已从缓存读出），不做任何覆盖
      if (import.meta.env.DEV) console.warn('[papers] 拉取失败，保留缓存数字', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载先拉一次（不等登录态，保证首屏快）
  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * 监听 <head> 预取脚本的校正结果。
   * 如果预取比 React 挂载更晚返回（慢网），这个事件会把数字补上，
   * 用户不需要刷新页面就能看到真实数字。
   */
  useEffect(() => {
    const onTotals = (e: Event) => {
      const d = (e as CustomEvent<TotalsCache>).detail;
      if (d && d.papers > 0) {
        setTotalPapers(d.papers);
        setTotalWithAnswer(d.withAnswer || 0);
      }
    };
    window.addEventListener('ctbu:totals', onTotals);
    return () => window.removeEventListener('ctbu:totals', onTotals);
  }, []);

  /**
   * 登录态变化时重新拉取（2026-10-17 修）。
   *
   * 为什么必须：`visibility='login'` 的卷**只有带 token 才返回**。
   * 旧实现只在挂载时拉一次，于是「先匿名打开 → 再登录」的人，
   * 列表永远停在匿名的 11 份，会计学/统计学这些登录可见的卷整门课都看不到，
   * 表现成「真题不见了」。登出同理（要收回登录可见的卷）。
   *
   * 初值设 null（视为已按匿名拉过一次），所以匿名用户不会重复请求。
   */
  const lastToken = useRef<string | null>(null);
  useEffect(() => {
    if (authLoading) return;
    if (lastToken.current === token) return;
    lastToken.current = token;
    refresh();
  }, [authLoading, token, refresh]);

  // ⚠️ 曾经这里是 `if (realPapers.length > 0) return realPapers; return demoPapers;`
  // 那个兜底在「登录可见」上线后变成了有害的：
  // 匿名用户被 RLS 挡住 → 查到 0 条 → 兜底显示 24 份**内置演示试卷**，
  // 于是匿名访客看到一堆假数据，而真正的"还有 N 份登录可见"提示反而不出现。
  //
  // 现在数据库里已有真实试卷，演示兜底没有存在价值，只会掩盖真实状态。
  // 查不到就是查不到 —— 空列表 + 登录提示才是诚实的呈现。
  const papers = realPapers;

  const isDemo = realPapers.length === 0;

  // 面向学生的「演示数据」提示已全部移除（2026-10-14，用户明确要求）。
  // 但数据库为空时页面其实仍会退回内置演示数据 —— 这条只在浏览器控制台可见，
  // 让站长能察觉异常，而不会让学生看到"这些数据是假的"这种话。
  useEffect(() => {
    if (!loading && isDemo) {
      console.warn(
        '[papers] 数据库里没有已发布的试卷，页面正在显示内置演示数据。' +
          '如果是意外情况，请检查服务器数据库里的 papers 表（psql ctbu）。',
      );
    }
  }, [loading, isDemo]);

  const getPaperById = useCallback(
    (id: string) => papers.find((p) => p.id === id),
    [papers]
  );

  return (
    <PapersContext.Provider
      value={{
        papers,
        realPapers,
        loading,
        isDemo,
        loginOnlyByCourse,
        loginOnlyTotal,
        totalPapers,
        totalWithAnswer,
        refresh,
        getPaperById,
      }}
    >
      {children}
    </PapersContext.Provider>
  );
}

export function usePapers() {
  const ctx = useContext(PapersContext);
  if (!ctx) throw new Error('usePapers must be used within PapersProvider');
  return ctx;
}
