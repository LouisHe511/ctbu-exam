import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { fetchCaptcha } from '@/lib/captcha';

interface Props {
  /** 验证码内容变化时回调（父组件存下来，提交时一并带给服务端） */
  onChange: (v: { id: string; code: string }) => void;
  /** 外部触发刷新（例如提交失败后） */
  refreshKey?: number;
  className?: string;
}

/**
 * 图形验证码。
 *
 * 交互：图片本身可点刷新（约定俗成的做法），输入框右侧也有刷新按钮。
 * 提交失败后父组件应该把 refreshKey +1 —— 验证码是**一次性**的，
 * 服务端校验过就删了（无论对错），不刷新必然对不上。
 */
export function Captcha({ onChange, refreshKey = 0, className = '' }: Props) {
  const [img, setImg] = useState<string>('');
  const [id, setId] = useState<string>('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>('');
  /** 输入框里**显示**的值（组合中的原文也照此回显，见下方 normalize 前的长注释） */
  const [draft, setDraft] = useState('');
  /** 是否正处于输入法组合中（中文/日文输入法打字母时） */
  const composingRef = useRef(false);
  const seq = useRef(0);
  // 当前这张图的 id。用 ref 是为了在 `setCode` 的那一刻就能读到最新值 ——
  // 如果依赖 state，输入后立刻点「发送验证码」会读到上一轮的 id
  // （useEffect 要等渲染完才跑，中间有一个 tick 的时间差）。
  const idRef = useRef('');

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setErr('');
    try {
      const c = await fetchCaptcha();
      if (my !== seq.current) return;      // 竞态：只认最后一次请求
      setImg(c.image);
      setId(c.id);
      idRef.current = c.id;
    } catch (e) {
      if (my !== seq.current) return;
      setErr(e instanceof Error ? e.message : '验证码加载失败');
      setImg('');
      setId('');
      idRef.current = '';
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 换图就清空输入框：旧字符对应的是上一张图，留着只会让人以为"我填过了"
    setDraft('');
    void load();
  }, [load, refreshKey]);

  // 每次 id / code 变化都同步给父组件（兜底：换图、清空等场景）
  useEffect(() => {
    onChange({ id, code });
  }, [id, code, onChange]);

  /**
   * 输入时**同步**推给父组件。
   * 只靠上面的 useEffect 会有时间差：React 要等这次事件处理完、重渲染后才跑 effect，
   * 用户「输完立刻点发送」时父组件拿到的还是旧 code（实测会报「请先填写人机验证码」）。
   */
  const changeCode = (v: string) => {
    setCode(v);
    onChange({ id: idRef.current, code: v });
  };

  /*
   * ═══════════════════════════════════════════════════════════════════
   * 中文输入法下「打一个字母跳出两三个相同字母」（2026-10-28 用户反馈）
   * ═══════════════════════════════════════════════════════════════════
   *
   * 现象：微信内置浏览器打开登录页，输入法停在中文状态时输入图形验证码，
   *       敲一下会出现 2~3 个相同的字符。
   *
   * 原因不是「事件绑了两次」，而是**受控输入框在输入法组合期间改写了内容**：
   *   中文输入法打字母时，字母先在 composition buffer 里（还没"上屏"）。
   *   旧代码在 onChange 里无条件 `.toUpperCase()` + 过滤 → 把 DOM 的 value 改写成
   *   另一个字符串，而输入法仍持有原来的 composition buffer。
   *   等到上屏（compositionend）那一刻，输入法把 buffer **再提交一遍**，
   *   于是同一个字母被插了第二次、第三次。
   *   `maxLength={6}` 还会在这期间抢着截断，让 WebKit 的行为更不可预测。
   *
   * 桌面 Chrome 上少见，因为它的 keydown/composition/input 顺序更"讲道理"；
   * 微信 iOS（WKWebView）与安卓（X5）的顺序不同，所以只有微信里暴露。
   * 
   * 修法（业界通行做法）：
   *   · 组合期间（composing）**原样回显**用户看到的东西，一个字符都不改；
   *   · 组合结束（compositionend）才做"大写 + 只留字母数字 + 截断"；
   *   · 去掉 maxLength 属性，改在规范化函数里 slice —— 避免和输入法抢 DOM。
   */
  const normalize = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 6);

  /** 落定一个值：写回输入框 + 同步给父组件 */
  const commit = (v: string) => {
    const n = normalize(v);
    setDraft(n);
    setCode(n);
    onChange({ id: idRef.current, code: n });
  };

  const clearAndReload = () => {
    composingRef.current = false;
    setDraft('');
    changeCode('');
    void load();
  };

  return (
    <div className={className}>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={clearAndReload}
          title="点击换一张"
          aria-label="点击换一张验证码"
          className="relative h-[46px] w-[132px] shrink-0 overflow-hidden rounded-lg border border-hairline/[0.10] bg-[#101113] transition-colors hover:border-hairline/[0.22]"
        >
          {loading ? (
            <span className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            </span>
          ) : img ? (
            <img src={img} alt="图形验证码" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <span className="flex h-full items-center justify-center text-[11px] text-white/40">加载失败</span>
          )}
        </button>

        <div className="relative flex-1">
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={draft}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              // 上屏这一下才做规范化。注意用 currentTarget.value 而不是拼 buffer，
              // 这样即使输入法一次性提交多个字符（选词）也不会错位。
              composingRef.current = false;
              commit(e.currentTarget.value);
            }}
            onChange={(e) => {
              // 组合期间原样回显：不转大写、不过滤、不截断（见上方长注释）
              if (composingRef.current) { setDraft(e.target.value); return; }
              commit(e.target.value);
            }}
            placeholder="输入图中字符"
            aria-label="图形验证码"
            className="h-[46px] w-full rounded-lg border border-hairline/[0.10] bg-input px-3 pr-10 text-[14px] tracking-[0.18em] text-strong placeholder-faint/35 outline-none transition-all duration-200 focus:border-hairline/[0.28] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
          />
          <button
            type="button"
            onClick={clearAndReload}
            title="换一张"
            aria-label="换一张验证码"
            className="absolute right-1 top-1 flex h-[38px] w-[38px] items-center justify-center rounded-md text-white/40 transition-colors hover:bg-solid-hover/[0.06] hover:text-white/70"
          >
            <RefreshCw className={`h-[15px] w-[15px] ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {err && <p className="mt-1.5 text-[11px] text-red-400/80">{err}</p>}
    </div>
  );
}
