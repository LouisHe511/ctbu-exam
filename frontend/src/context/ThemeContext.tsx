import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════
 * 主题（深色 / 浅色）—— 自动按时间 + 用户可手动覆盖
 * ═══════════════════════════════════════════════════════════════
 * 规则（2026-10-22 用户定）：
 *   · 08:00 – 19:00  → 浅色（白天看得清，纸白不刺眼）
 *   · 19:00 – 次日 08:00 → 深色
 *   · 用户可以随时手动切；**手动选择在当段有效**，跨过下一个时间界
 *     就回到自动 —— 这样"自动"始终是默认行为，不会因为某天点了一次
 *     就永久锁死（这点很关键，否则第二天白天他还是黑的，像坏了）。
 *
 * 为什么保留 localStorage 但不存"主题"而是存"决定"：
 *   只存 `dark/light` 的话，无法区分"用户自己选的"和"按时间算的"，
 *   下次打开就不知道该不该覆盖。所以存 { theme, until }：
 *   until = 手动选择失效的时刻（下一个 8:00 或 19:00）。
 */

export type Theme = 'dark' | 'light';
/** 主题从哪来：按时间自动 / 用户手动 */
export type ThemeSource = 'auto' | 'manual';

const STORAGE_KEY = 'ctbu:theme';
/** 切换过渡时长，必须与 index.css 里 .theme-switching 的 220ms 一致 */
const TRANSITION_MS = 220;

/** 白天从几点开始（含） */
const DAY_START_HOUR = 8;
/** 白天到几点结束（不含）—— 19 点起算夜间 */
const DAY_END_HOUR = 19;

/** 按当前时间该用哪个主题（只在设备偏好拿不到时兜底） */
export function autoThemeAt(d: Date = new Date()): Theme {
  const h = d.getHours();
  return h >= DAY_START_HOUR && h < DAY_END_HOUR ? 'light' : 'dark';
}

/**
 * 设备/系统的深浅偏好。返回 null = 这个环境读不到（很老的浏览器）。
 *
 * 优先级（2026-10-22 用户要求「跟着设备走」）：
 *   ① 用户手动选过 → 用它（只到下一个时间界为止）
 *   ② 设备偏好（prefers-color-scheme）
 *   ③ 都没有 → 按时间兜底
 *
 * 为什么设备优先于时间：手机开「深色模式」是用户自己的明确表达，
 * 比"现在几点"更贴近意图 —— 比如深夜开着台灯，手机仍是浅色；
 * 或者白天在户外强光下，用户手动开了深色。
 */
export function deviceTheme(): Theme | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return null;
  }
}

/**
 * 下一个时间界的时刻。
 * 手动选择记到这个时刻为止 —— 过了界就自动接管。
 *
 * 举例（DAY_START=8, DAY_END=19）：
 *   10:00 → 今天 19:00
 *   20:00 → 明天 08:00
 *   07:00 → 今天 08:00
 */
export function nextBoundary(from: Date = new Date()): Date {
  const d = new Date(from);
  const h = d.getHours();
  const at = (hh: number, dayOffset: number) => {
    const t = new Date(d);
    t.setDate(t.getDate() + dayOffset);
    t.setHours(hh, 0, 0, 0);
    return t;
  };
  if (h < DAY_START_HOUR) return at(DAY_START_HOUR, 0);      // 凌晨 → 今天 8 点
  if (h < DAY_END_HOUR) return at(DAY_END_HOUR, 0);          // 白天 → 今天 19 点
  return at(DAY_START_HOUR, 1);                              // 夜晚 → 明天 8 点
}

interface Stored {
  theme: Theme;
  /** 手动选择失效时间戳（ms）。0 或缺失 = 没有手动选择 */
  until: number;
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // 兼容上一版直接存 'light'/'dark' 的格式
    if (raw === 'light' || raw === 'dark') {
      return { theme: raw, until: nextBoundary().getTime() };
    }
    const p = JSON.parse(raw) as Partial<Stored>;
    if (p.theme !== 'light' && p.theme !== 'dark') return null;
    return { theme: p.theme, until: Number(p.until) || 0 };
  } catch {
    return null;
  }
}

/** 当前该用哪个主题 + 是自动还是手动 */
export function resolveTheme(now: Date = new Date()): { theme: Theme; source: ThemeSource } {
  const s = readStored();
  if (s && s.until > now.getTime()) return { theme: s.theme, source: 'manual' };
  // 设备偏好优先，读不到才按时间
  return { theme: deviceTheme() ?? autoThemeAt(now), source: 'auto' };
}

/** index.html 里也有一份等价逻辑（必须早于 React 跑），改这里记得同步那边 */
function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#fbfbfa' : '#08090a');
}

interface ThemeState {
  theme: Theme;
  source: ThemeSource;
  /** 手动切到另一套（记到下一个时间界为止） */
  toggle: () => void;
  /** 明确指定，并记到下一个时间界为止 */
  set: (t: Theme) => void;
  /** 放弃手动选择，立刻回到按时间自动 */
  followTime: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const init = resolveTheme();
  const [theme, setTheme] = useState<Theme>(init.theme);
  const [source, setSource] = useState<ThemeSource>(init.source);

  // 首帧对齐（index.html 已经设过一次，这里是双保险）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  const themeRef = useRef(theme);

  /**
   * 换主题的唯一入口 —— 所有改变都必须走这里。
   * 挂过渡类 → 改变量 → 220ms 后摘掉（摘掉后 hover 才不会变慢）。
   */
  const paint = useCallback((next: Theme) => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    setTheme(next);
    applyTheme(next);
    window.setTimeout(() => root.classList.remove('theme-switching'), TRANSITION_MS);
  }, []);

  /** 重新按"现在"算一次（跨过时间界、或从后台切回前台时用） */
  const recheck = useCallback(() => {
    const r = resolveTheme();
    setSource(r.source);
    if (r.theme !== themeRef.current) paint(r.theme);
    themeRef.current = r.theme;
  }, [paint]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  const commitManual = useCallback((next: Theme) => {
    const until = nextBoundary().getTime();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: next, until }));
    } catch {
      /* 隐私模式：记不住就本次会话内有效 */
    }
    setSource('manual');
    paint(next);
    themeRef.current = next;
  }, [paint]);

  const toggle = useCallback(() => {
    commitManual(themeRef.current === 'dark' ? 'light' : 'dark');
  }, [commitManual]);

  /**
   * 系统主题变化时跟随（2026-10-22）。
   * 只在"没有手动选择"时生效 —— 用户自己点过就尊重他的选择，别抢。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const s = readStored();
      if (s && s.until > Date.now()) return;   // 有手动选择，不跟
      const next = deviceTheme();
      if (next && next !== themeRef.current) {
        paint(next);
        themeRef.current = next;
      }
    };
    // Safari 14 以前只支持 addListener
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [paint]);

  const followTime = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    const next = deviceTheme() ?? autoThemeAt();
    setSource('auto');
    if (next !== themeRef.current) paint(next);
    themeRef.current = next;
  }, [paint]);

  /**
   * 定时跨界：页面开着不动也会在 8:00 / 19:00 自动切。
   *
   * 只对"自动"生效 —— 手动选择本来就有 until 兜底，
   * 而且用户手里刚点过，别在 20 分钟后突然改他的主意。
   */
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const ms = nextBoundary().getTime() - Date.now() + 1000; // 多给 1 秒避开边界抖动
      timer = window.setTimeout(() => {
        recheck();
        schedule();
      }, Math.max(30_000, Math.min(ms, 6 * 60 * 60 * 1000)));
    };
    schedule();

    // 从后台切回来时也要重算：手机上锁屏两小时，回来时可能早就跨界了
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recheck]);

  return (
    <ThemeContext.Provider value={{ theme, source, toggle, set: commitManual, followTime }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  // 理论上不会发生（Provider 在 main.tsx 最外层），但别让组件因为拿不到而崩
  if (!ctx) {
    return { theme: 'dark', source: 'auto', toggle: () => {}, set: () => {}, followTime: () => {} };
  }
  return ctx;
}
