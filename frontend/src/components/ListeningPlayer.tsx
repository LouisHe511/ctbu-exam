import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Play, Pause, RotateCcw, RotateCw, Loader2, Lock, SkipBack, SkipForward,
} from 'lucide-react';
import { fmtTime, pieceAt, signMedia, type PlayerPiece } from '@/lib/cet';

/**
 * 四六级听力 · 吸底播放器
 *
 * 这个组件的每一条设计都有理由（对照原站 懒笔记 的听力页实测抄来的"科学"做法）：
 *
 * 1. **吸底常驻** —— 学生往下看题/看 PDF 时，播放控制始终在屏幕底部，不用滚回去找。
 * 2. **±10 秒快退快进** —— 听力练习最刚需：漏听一句必须能立刻倒回去。
 *    固定 10 秒是听力题的天然节奏（一句话 3~8 秒），比拖进度条精确得多。
 * 3. **倍速播放** —— 精听用 0.75x、泛听用 1.25/1.5x，练听力必须有变速。
 * 4. **进页面就预取，点播放立刻出声（2026-10-19 提速）** ——
 *    音频是 m4a（AAC，moov 在文件头 = faststart），浏览器发 Range 只取
 *    头部 + 第一段就能出声。签名一回来就把 `preload` 切成 `auto` 并 `load()`
 *    （见下面的 useEffect），把"第一次点击"也压进 1 秒。
 *    冷缓存实测（`&_=随机` 作废缓存）`点击→出声`：进页面 3s 后点 **308 ms**、
 *    0.8s 后点 **908 ms**；不预取的老行为是 1.5s / 4.0s。
 *    省流网络（saveData / 2G）自动跳过预取，退回"点了才下" —— 出口只有 3Mbps，这条不能不算。
 * 5. **playsinline / webkit-playsinline / x5-playsinline** —— 微信内置浏览器（X5）
 *    默认会把音频全屏接管，加上这三个才不会跳出页面。
 * 6. **上一段 / 下一段** —— 按「篇」跳，而不是靠拖。（原站是按篇组织的）
 * 7. **记住上次听到哪** —— 一套听力 20 多分钟，学生中途退出很常见。
 * 8. **时间轴只用来定位，不参与计算** —— 分段秒数来自抓取的人工时间轴（资产）。
 */

const RATES = [0.75, 1.0, 1.25, 1.5] as const;
const SKIP_SECONDS = 10;

export interface PlayerHandle {
  /** 跳到第 index 段并播放（页面上的分段列表 / 题号导航调它） */
  playPiece: (index: number) => void;
}

interface Props {
  /** 受保护音频路径（如 /media/cet4/xxx.mp3），播放前换签名链接 */
  audio: string;
  /** 套号，用于「记住上次听到哪」的本地存储键 */
  slug: string;
  pieces: PlayerPiece[];
  /** 当前所在篇（由播放进度算出来，页面用它高亮） */
  onActivePiece: (index: number) => void;
}

type Status = 'idle' | 'loading' | 'ready' | 'locked' | 'failed';

const POS_KEY = (slug: string) => `cet-pos:${slug}`;

export const ListeningPlayer = forwardRef<PlayerHandle, Props>(function ListeningPlayer(
  { audio, slug, pieces, onActivePiece },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [reason, setReason] = useState('');
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<number | null>(null); // 想跳到的时间点（等元数据）
  // 上次听到哪 —— **只作为可选按钮显示，绝不自动跳**（2026-10-19 修）
  const [resumeAt, setResumeAt] = useState(0);
  /**
   * 2026-10-19 修「点了播放却从 8 分钟开始、而且很慢」：
   *
   * 原来这里初始是 'none'，靠 useEffect 里签名回来后再改成 'auto'。问题是
   * `<audio>` 首次渲染时 preload 还是 'none'，`el.src = url` 那一刻浏览器
   * 不会主动缓冲，要等紧接着的 `el.load()`。而如果用户手快，在 React
   * 还没跑完那个 effect 时就点了播放，`toggle()` 里会 `await ensureReady()`
   * —— 于是声音要等到一次全新的签名 + 缓冲才出来，体感就是"慢"。
   *
   * 改成用惰性初始化直接定死初值：非省流网络从**第一次渲染**就是 'auto'，
   * `src` 一装好浏览器就自己开始下，少一次往返。
   */
  const [preloadMode] = useState<'none' | 'auto'>(() => {
    const conn = (navigator as unknown as {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    const thrifty = conn?.saveData === true
      || conn?.effectiveType === 'slow-2g'
      || conn?.effectiveType === '2g';
    return thrifty ? 'none' : 'auto';
  });

  const signedUrl = useRef<string>('');
  const signedAt = useRef(0);
  /** 正在进行中的签名请求 —— 进页面那次和点击那次共用，避免并发重复签、把 src 重设两次 */
  const signing = useRef<Promise<boolean> | null>(null);

  /** 确保音频已就绪（链接已由预取装好，这里只兜底重新换一次并等元数据） */
  const ensureReady = useCallback(async (): Promise<boolean> => {
    const el = audioRef.current;
    if (!el) return false;

    // 正常情况下 src 已经预装好；只有过期/被清掉时才需要重新换
    const fresh = signedUrl.current && Date.now() - signedAt.current < 5.5 * 3600 * 1000;
    if (!fresh || !el.src) {
      /* 2026-10-19 修「点播放很慢」的第三处：去重并发签名。
       * 进页面的 useEffect 刚发出 signMedia，用户 0.3 秒就点了播放 ——
       * 老代码会再发一次请求，回来后又 `el.src = url` 把已缓冲的数据全废掉。
       * 现在后来的调用直接复用前一个 Promise，只装一次 src。
       */
      if (!signing.current) {
        signing.current = (async () => {
          setStatus('loading');
          const r = await signMedia(audio);
          signing.current = null;
          if (!r.ok) {
            setStatus(r.reason === 'not_a_member' || r.reason === 'not_logged_in' ? 'locked' : 'failed');
            setReason(r.reason);
            return false;
          }
          signedUrl.current = r.url;
          signedAt.current = Date.now();
          const box = audioRef.current;
          if (box) box.src = r.url;
          return true;
        })();
      }
      const okSign = await signing.current;
      if (!okSign) return false;
    }

    // 元数据已在（预取跑完了）→ 直接可播，绝不再 load()
    if (el.readyState >= 1) { setStatus('ready'); return true; }

    /* 2026-10-19 修「点播放很慢」的第二处：
     * 原逻辑不管三七二十一都 `el.load()`。`load()` 的语义是**重新加载资源**，
     * 会把已经缓冲的字节全丢掉、从 Range 0 重新握手。用户点得快时预取刚下到
     * 一两百 KB，这一 `load()` 等于白下，于是又要等一轮 → 体感"点了半天没声"。
     *
     * 现在的判据是 `networkState`：
     * - NETWORK_LOADING(2) → 预取正在跑，**什么都别动**，等它的 loadedmetadata；
     * - 其它（IDLE/NO_SOURCE）→ 说明压根没在下载（省流模式下 preload='none' 就是这种），
     *   这时才需要把 preload 提到 'auto' 并 `load()` 起个头。
     */
    if (el.networkState !== HTMLMediaElement.NETWORK_LOADING) {
      el.preload = 'auto';
      el.load();
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        el.removeEventListener('loadedmetadata', done);
        el.removeEventListener('canplay', done);
        resolve();
      };
      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('canplay', done, { once: true });
      window.setTimeout(done, 12000);   // 兜底，避免一直卡住
    });
    setDur(el.duration || 0);
    setStatus(el.readyState >= 1 ? 'ready' : 'failed');
    return el.readyState >= 1;
  }, [audio]);

  /** 跳到某个时间点并播放 */
  const seekPlay = useCallback(async (sec: number) => {
    const el = audioRef.current;
    if (!el) return;
    setPending(sec);
    const ok = await ensureReady();
    if (!ok) { setPending(null); return; }
    try { el.currentTime = Math.max(0, sec); } catch { /* 某些浏览器元数据未就绪时会抛 */ }
    el.playbackRate = rate;
    try { await el.play(); } catch { /* 用户未交互等，忽略 */ }
    setPending(null);
  }, [ensureReady, rate]);

  useImperativeHandle(ref, () => ({
    playPiece: (i: number) => {
      const p = pieces[i];
      if (p) void seekPlay(p.start);
    },
  }), [pieces, seekPlay]);

  // 换套卷：清掉上一套的链接与进度
  useEffect(() => {
    signedUrl.current = '';
    signedAt.current = 0;
    signing.current = null;
    setStatus('idle'); setReason(''); setPlaying(false);
    setCur(0); setDur(0); setActive(0); setPending(null);
    /* 2026-10-19 修「响应还是很慢」的关键一处：
     * 这里原来有 `setPreloadMode('none')`。它在挂载时**紧接着**签名请求发出后执行，
     * React 会把 `preload="none"` 真的写回 DOM —— 浏览器收到这个属性会
     * **取消正在进行的缓冲**，然后上面的 effect 再把 'auto' 设回来，等于
     * 一来一回白白丢掉刚下的一两百 KB。切网/切卷时同理。
     * preload 该由"网络状况"决定，跟"哪一套"无关，所以这里不再动它。
     */
    const el = audioRef.current;
    if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
    // 恢复上次听到哪 —— **只记下来做「续听」按钮，不自动跳**（2026-10-19 修）
    const saved = Number(localStorage.getItem(POS_KEY(slug)) || 0);
    setResumeAt(saved > 5 ? saved : 0);
    setCur(0);
    onActivePiece(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  /**
   * ⚠️ 关键：**进页面就把签名链接换好并装上 src**，而不是等用户点了播放才去换。
   *
   * 为什么必须这样（踩过）：浏览器要求 `play()` 必须在"用户手势"的有效期内调用
   * （Chrome 只有几秒）。若点击时才 `await` 签名接口 + 等音频加载元数据，
   * 等回来时手势早过期 → `play()` 抛 `NotAllowedError`，表现就是"点了没反应"。
   *
   * 预取后点击路径上没有 await，`play()` 就在手势里同步触发。
   * 配合下面的预加载：签名一回来就让浏览器开始缓冲（`preload="auto"`），
   * 不再等用户点播放才下第一个字节。会员校验也顺带在进页面时就完成 ——
   * 不是会员能立刻看到锁，而不是点了才发现。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      /* 复用 ensureReady()：① 只签一次（点击再快也共用同一个 Promise，不重设 src、不丢缓冲）；
       * ② preload 初值就是 'auto'，`src` 一装好浏览器就自己开始缓冲，这里**不再** `load()`
       *    —— 多调一次 `load()` 只会把刚开始的缓冲推倒重来，正是"点了半天没声"的成因。
       */
      const ok = await ensureReady();
      if (!alive || !ok) return;
      setStatus('idle');
    })();
    return () => { alive = false; };
    // slug 也要依赖：姐妹套（第 3 套沿用第 1 套）的 audio 路径完全相同，
    // 只依赖 ensureReady 的话切套后不会重新预取 —— 上面刚把 src 清空了。
  }, [ensureReady, slug]);

  /** 播放/暂停 */
  const toggle = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); return; }
    /**
     * 2026-10-19 修 BUG「点播放却从 8 分钟开始、而且卡很久」：
     *
     * 这里原来有一句 `if (cur > 5 && |el.currentTime - cur| > 2) el.currentTime = cur;`
     * —— 本意是"恢复到上次听到的地方"，但 `cur` 是**进度条状态**，
     * 换套卷时被 `setCur(saved)` 直接写成了上次的位置（8 分 32 秒）。
     * 结果：学生第一次点播放，音频被硬跳到 8:32，浏览器要重新发一个
     * `Range: bytes≈3400000-` 请求去那个位置取数据 —— 既"从 8 分钟开始"
     * 又"慢"，就是用户反馈的两个症状。
     *
     * 现在不再自动跳。要续听有明确入口（播放器右侧「续听 8:32」按钮）。
     * 这里只负责：确保 ready → 原速播 → 从当前位置 0 起播。
     */
    const ok = await ensureReady();
    if (!ok) return;
    el.playbackRate = rate;
    try { await el.play(); } catch { /* 忽略 */ }
  }, [playing, ensureReady, rate]);

  const skip = useCallback(async (delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    if (status !== 'ready') { const ok = await ensureReady(); if (!ok) return; }
    el.currentTime = Math.max(0, Math.min(el.duration || 1e9, el.currentTime + delta));
  }, [status, ensureReady]);

  /** 上一段 / 下一段：按「篇」跳。若当前不在段首（已播 3 秒以上），先回到本段开头 —— 与原站"换"的直觉一致 */
  const stepPiece = useCallback(async (dir: 1 | -1) => {
    const el = audioRef.current;
    const curIdx = active;
    const p = pieces[curIdx];
    if (dir === -1 && p && el && el.currentTime - p.start > 3) {
      void seekPlay(p.start);
      return;
    }
    const next = Math.min(pieces.length - 1, Math.max(0, curIdx + dir));
    void seekPlay(pieces[next].start);
  }, [active, pieces, seekPlay]);

  /** 点「续听」：明确跳到上次的位置，跳完按钮消失（不点就永远从头播） */
  const resumePlay = useCallback(async () => {
    const at = resumeAt;
    setResumeAt(0);
    await seekPlay(at);
  }, [resumeAt, seekPlay]);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    // 拖动中不让 timeupdate 抢进度条（否则手指还没松就被旧位置拽回去）
    if (dragging.current) return;
    setCur(el.currentTime);
    if (Number.isFinite(el.duration) && el.duration > 0) setDur(el.duration);
    const idx = pieceAt(pieces, el.currentTime);
    setActive((prev) => {
      if (prev !== idx) onActivePiece(idx);
      return prev === idx ? prev : idx;
    });
    // 每 5 秒记一次位置，退出后能接着听
    if (Math.floor(el.currentTime) % 5 === 0) {
      localStorage.setItem(POS_KEY(slug), String(el.currentTime));
    }
  }, [pieces, slug, onActivePiece]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  const locked = status === 'locked';
  const curPiece = pieces[active];

  /* ── 进度条拖动（2026-10-19 重做）────────────────────────────────
   * 用户的抱怨："拖到另一个地方，已经拖过去了，却还在播放原来的音频，有延迟。"
   *
   * 原来的实现只在 `onClick` 里设一次 `currentTime`，有两个致命问题：
   * ① **完全没有拖动**：按下 → 拖动 → 松手，全程只有松手那一下触发 click，
   *    拖的过程中进度条不动，学生看不到自己在拖哪；
   * ② **拖动期间不停播**：手指按着的那一两秒，音频还在放旧位置；
   *    松手后才发一个 `Range: bytes≈N-` 请求去新位置，出口 3Mbps 下还要再等
   *    一两秒 —— 这段"旧声音还在响"就是用户说的"延迟"。
   *
   * 现在按标准音频播放器的做法：
   * - pointerdown 就**立即暂停**并记下"拖动前的播放状态"；
   * - pointermove 实时更新进度条与时间显示（拖动时只改 UI，**不**每帧设 currentTime，
   *   否则每个像素都发一个 Range 请求，反而更卡）；
   * - pointerup 才真正落 `currentTime`，并等 `seeked` 事件（不是固定 sleep）再恢复播放。
   *   这样"手指停在哪，就跳哪，跳完立刻继续"，中间不留旧声音。
   */
  const dragging = useRef(false);
  const dragRatio = useRef(0);
  const wasPlaying = useRef(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  /** 松手后正在等目标位置的数据（拖动到未缓冲区域时会有一两秒） */
  const [seeking, setSeeking] = useState(false);

  /** 把指针位置换算成 0~1 的比例 */
  const ratioOf = (clientX: number, box: DOMRect) =>
    Math.min(1, Math.max(0, (clientX - box.left) / box.width));

  const onBarPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el) return;
    // 元数据还没到（刚进页面就拖）→ 先去把链接和时长拿到，这次拖动忽略
    if (dur <= 0) { void ensureReady(); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    wasPlaying.current = !el.paused;
    // 按下的瞬间就静音停住 —— 不让旧位置的声音继续放
    if (!el.paused) el.pause();
    const r = ratioOf(e.clientX, e.currentTarget.getBoundingClientRect());
    dragRatio.current = r;
    setDragPct(r * 100);
    setCur(r * dur);          // 时间显示立刻跟手
  }, [dur, ensureReady]);

  const onBarPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const r = ratioOf(e.clientX, e.currentTarget.getBoundingClientRect());
    dragRatio.current = r;
    setDragPct(r * 100);
    setCur(r * dur);
  }, [dur]);

  const onBarPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    const el = audioRef.current;
    if (!el) { setDragPct(null); return; }
    const target = dragRatio.current * (el.duration || dur || 0);
    el.currentTime = target;
    setCur(target);

    const finish = () => {
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('canplay', onCanplay);
      window.clearTimeout(timer);
      setDragPct(null);
      setSeeking(false);
      if (wasPlaying.current) {
        el.playbackRate = rate;
        void el.play().catch(() => { /* 手势过期等，忽略 */ });
      }
    };
    /* 拖到还没缓冲的位置时，只等 `seeked` 是不够的 —— 它可能先停在最近的缓冲点，
     * 真正出声还要等目标位置的字节到达（出口 3Mbps，跳几 MB 要一两秒）。
     * 所以：先等 seeked，再等 readyState >= HAVE_FUTURE_DATA 才恢复播放，
     * 期间进度条显示"跳转中"，学生知道在加载，而不是以为卡死了。
     */
    const onSeeked = () => {
      if (el.readyState >= 3) { finish(); return; }   // HAVE_FUTURE_DATA
      el.addEventListener('canplay', onCanplay, { once: true });
    };
    const onCanplay = () => finish();
    const timer = window.setTimeout(finish, 8000);
    setSeeking(true);
    el.addEventListener('seeked', onSeeked, { once: true });
  }, [dur, rate]);

  /** 键盘：左右箭头 ±5 秒（无障碍 + 精细控制） */
  const onBarKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    void skip(e.key === 'ArrowLeft' ? -5 : 5);
  }, [skip]);


  return (
    /*
     * 移动端要**让开底部导航**（导航 z-50 且同样贴 bottom:0，否则会把播放器整条盖住，
     * 实测只露出约 11px）。md 以上没有那个导航，所以回到 bottom-0。
     * 偏移量与导航高度共用同一个变量，避免两处各写一个数字后漂移。
     */
    <div className="fixed inset-x-0 bottom-[var(--ctbu-mobile-nav-h)] z-40 border-t border-hairline/[0.08] bg-ink-950 text-gray-900 md:bottom-0">
      {/* 进度条：可点可拖。拖动时暂停并实时跟手，松手 seek 完立刻续播（见上面 onBarPointer*） */}
      <div
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(cur)}
        aria-valuetext={`${fmtTime(cur)} / ${fmtTime(dur)}`}
        tabIndex={0}
        className="group h-6 -mb-3 cursor-pointer relative touch-none select-none"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
        onPointerCancel={onBarPointerUp}
        onKeyDown={onBarKeyDown}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-elevate/20">
          <div
            className="h-full bg-ink-750"
            style={{ width: `${dragPct ?? pct}%` }}
          />
        </div>
        <div
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full bg-ink-750 shadow-[0_0_0_2px_rgba(8,9,10,0.9)]"
          style={{ left: `${dragPct ?? pct}%` }}
        />
        {/* 跳转中：目标位置的数据还在路上（出口 3Mbps，跳得远要一两秒）。
            不给反馈的话，学生会以为"拖了没反应"—— 这正是他抱怨的体感 */}
        {seeking && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-300" />
          </div>
        )}
      </div>

      <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-2 sm:gap-3">
        {locked ? (
          <div className="flex-1 flex items-center gap-2 text-sm">
            <Lock className="h-4 w-4 shrink-0 text-amber-400/80" aria-hidden="true" />
            <span className="text-white/90">听力是会员内容</span>
            <a href="#/membership" className="font-medium text-amber-300 hover:underline">去开通会员</a>
          </div>
        ) : (
          <>
            <button
              type="button" onClick={() => void stepPiece(-1)}
              className="p-2 rounded-lg hover:bg-solid-hover/[0.06] transition-colors"
              aria-label="上一段录音" title="上一段"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              type="button" onClick={() => void skip(-SKIP_SECONDS)}
              className="p-2 rounded-lg hover:bg-solid-hover/[0.06] transition-colors"
              aria-label={`快退 ${SKIP_SECONDS} 秒`} title={`后退 ${SKIP_SECONDS} 秒`}
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              type="button" onClick={() => void toggle()}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-solid text-on-solid transition-all hover:bg-solid-hover active:scale-95"
              aria-label={playing ? '暂停' : '播放'}
            >
              {status === 'loading' || pending !== null
                ? <Loader2 className="w-5 h-5 animate-spin" />
                : playing ? <Pause className="w-5 h-5" fill="currentColor" /> : <Play className="w-5 h-5 ml-0.5" fill="currentColor" />}
            </button>

            <button
              type="button" onClick={() => void skip(SKIP_SECONDS)}
              className="p-2 rounded-lg hover:bg-solid-hover/[0.06] transition-colors"
              aria-label={`快进 ${SKIP_SECONDS} 秒`} title={`前进 ${SKIP_SECONDS} 秒`}
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <button
              type="button" onClick={() => void stepPiece(1)}
              className="p-2 rounded-lg hover:bg-solid-hover/[0.06] transition-colors"
              aria-label="下一段录音" title="下一段"
            >
              <SkipForward className="w-4 h-4" />
            </button>

            {/* 当前段 + 总量：让学生知道"现在在哪、还有多少" */}
            <div className="hidden sm:block min-w-0 flex-1 pl-1">
              <p className="text-xs text-white/60 truncate">
                全卷共 {pieces.length} 篇录音
              </p>
              <p className="text-xs text-white/90 truncate">{curPiece?.label ?? ''}</p>
            </div>

            <span className="text-xs text-white/75 tabular-nums shrink-0 ml-auto sm:ml-0">
              {fmtTime(cur)} / {fmtTime(dur)}
            </span>

            {/* 倍速 */}
            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="bg-elevate/10 text-white text-xs rounded-lg px-1.5 py-1.5 outline-none hover:bg-solid-hover/[0.10] transition-colors"
              aria-label="播放速度"
            >
              {RATES.map((r) => <option key={r} value={r} className="text-black">{r.toFixed(2).replace(/0$/, '')}x</option>)}
            </select>
          </>
        )}
      </div>

      {/* 续听：上次听到哪，**学生自己点才跳**，默认永远从头播（2026-10-19 加）
          单独占一行，避免手机上把播放器主行挤爆 */}
      {!locked && resumeAt > 5 && (
        <div className="max-w-3xl mx-auto px-4 pb-2 flex items-center gap-2">
          <button
            type="button" onClick={() => void resumePlay()}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-elevate/10 hover:bg-solid-hover/[0.10] text-gray-300 transition-colors tabular-nums"
          >
            续听上次位置 {fmtTime(resumeAt)}
          </button>
          <button
            type="button"
            onClick={() => {
              setResumeAt(0);
              // 一并清掉本地记录，否则下次进这套卷按钮又会冒出来
              localStorage.removeItem(POS_KEY(slug));
            }}
            className="text-xs px-2 py-1.5 rounded-lg text-white/50 hover:text-strong/80 transition-colors"
          >
            从头开始
          </button>
        </div>
      )}

      {status === 'failed' && (
        <p className="max-w-3xl mx-auto px-4 pb-2 text-xs text-amber-300">
          音频加载失败（{reason || '未知原因'}）。可以点播放重试；若一直不行请反馈。
        </p>
      )}

      {/* 真正的音频元素：签名一回来就把 preload 切成 auto（见上面的 useEffect）——
          原来写死 preload="none"，点播放才从零开始下，在 3Mbps 出口下必然慢 */}
      <audio
        ref={audioRef}
        preload={preloadMode}
        playsInline
        // 微信 X5 内核的私有属性：不加会被全屏接管，跳出我们的页面
        webkit-playsinline="true"
        x5-playsinline="true"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration || 0); setStatus('ready'); }}
        onError={() => { if (status !== 'locked') { setStatus('failed'); setReason('load_error'); } }}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
});
