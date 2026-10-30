/**
 * AI 学习助手面板（2026-10-25）
 *
 * 形态：阅读器内半屏底部抽屉 —— 上半屏仍是试卷，学生对照着题看讲解。
 * 学生不用抄题：面板自动带上「哪份卷 · 第几页」，直接问"第3题怎么做"，
 * 后端拿这页的 OCR 转录（免费缓存）+ 免费文本模型作答（见 pay-service/ai.py）。
 *
 * 交互细节每条都有来路：
 *  · 流式逐字输出 —— 20~30 秒的答案不能让屏幕干等；
 *  · 排队事件显示"前面还有 N 人" —— 期末周闸门削峰时给学生预期；
 *  · 「今日剩余 N 次」常驻 —— 限额透明；用完引导开会员（收费钩子）；
 *  · page_not_ready（页面还没转录）—— 给人话提示而不是报错。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, X, Send, Square, Loader2, FileText, BookOpen, Lock } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { askAi, fetchAiQuota, AiAskError, type AiQuota } from '@/lib/ai';
import { addMistake } from '@/lib/study';
import { Mic, BookmarkPlus } from 'lucide-react';
import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** 把文本里的 LaTeX 片段（$$…$$、$…$、\(…\)、\[…\]）渲染成真公式，其余原样。
 *  数学链路的回答满是 \frac/\oint，不渲染在学生眼里就是乱码（2026-10-25 用户反馈）。 */
function MathText({ text }: { text: string }) {
  const html = useMemo(() => {
    const out: string[] = [];
    /*
     * 四种定界符：$$…$$（行间）、$…$（行内）、\(…\)（行内）、\[…\]（行间）。
     *
     * ⚠️ 2026-10-28 修：上一版正则写的是 `\(\(...\)\)` / `\[...\]\]` ——
     * 那匹配的是**字面量** `((` 和 `]]`，而真实输入是 `\(x\)`、`\[x\]`；
     * 于是数学回答里用 LaTeX 定界符的那部分原样显示成源码。
     * 现在按"反斜杠 + 括号"匹配，和下面取值时的 slice(2,-2) 才对得上。
     */
    const re = /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;
    let last = 0, m: RegExpExecArray | null;
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    while ((m = re.exec(text))) {
      out.push(esc(text.slice(last, m.index)));
      const raw = m[0];
      const body = raw.startsWith('$$') ? raw.slice(2, -2)
        : raw.startsWith('$') ? raw.slice(1, -1)
        : raw.slice(2, -2);
      try {
        out.push(katex.renderToString(body, {
          throwOnError: false,
          displayMode: raw.startsWith('$$') || raw.startsWith('\\['),
        }));
      } catch {
        out.push(esc(raw));
      }
      last = m.index + raw.length;
    }
    out.push(esc(text.slice(last)));
    return out.join('');
  }, [text]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 语音识别的实例形状（⑨）。
 *
 * ⚠️ 2026-10-27 修一个**卡住整个前端上线**的类型错误：
 *   原来声明成 `const SpeechRec: unknown`。TS 里 `unknown` 参与 `&&` 之后，
 *   整个表达式类型仍是 `unknown`，而 JSX 只接受 ReactNode —— 于是
 *   `AiPanel.tsx(408,15): Type 'unknown' is not assignable to type 'ReactNode'`，
 *   **`npm run build` 直接失败**，AI 助手因此一直上不了线。
 *
 *   改成显式的构造器类型（或 null）：`SpeechRec && …` 的推导结果变成
 *   `null | JSX.Element`，既合法，也顺手去掉了下面那段丑陋的 `as new () => never`。
 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}

/** 语音识别：Safari/Chrome 支持，微信内核多半不支持 → 按钮自动隐藏 */
const SpeechRec: (new () => SpeechRecognitionLike) | null =
  typeof window !== 'undefined'
    ? ((window as {
          SpeechRecognition?: new () => SpeechRecognitionLike;
          webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        }).SpeechRecognition ??
        (window as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
          .webkitSpeechRecognition ??
        null)
    : null;

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  paperId: string;
  title: string;
  /** 当前页（1 基），翻页自动跟随 */
  page: number;
  which: 'paper' | 'answer';
  /** 本卷自带解析的起始页（有则给一个跳转提示，与库内容形成闭环） */
  solutionPage: number | null;
  /** 错题本页交接来的预填问题（如「第3题怎么做」），只消费一次 */
  prefill?: string | null;
  onClose: () => void;
  onJumpSolution: (page: number) => void;
}

export function AiPanel({ paperId, title, page, which, solutionPage, prefill, onClose, onJumpSolution }: Props) {
  const { navigate, setBottomBarOccupied } = useApp();
  // 手机上面板占满底部：让导航退出（根治 z-index 互相盖）
  useEffect(() => {
    setBottomBarOccupied(true);
    return () => setBottomBarOccupied(false);
  }, [setBottomBarOccupied]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'queueing' | 'streaming'>('idle');
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const [errTip, setErrTip] = useState<string | null>(null);
  const [quota, setQuota] = useState<AiQuota | null>(null);
  /** 永久会员专享（2026-10-25 用户拍板）：非永久会员打开面板只看得到专享说明 */
  const locked = quota != null && quota.allowed === false;
  const [doneMs, setDoneMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<Msg[]>([]);
  /** 关闭动画：先播 180ms 退出动画再真正卸载，避免面板「闪没」 */
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    if (closing) return;
    abortRef.current?.abort();          // 关面板顺手停掉还在流的回答
    setClosing(true);
    window.setTimeout(onClose, 180);
  }, [closing, onClose]);

  msgsRef.current = msgs;

  // 换卷清空对话
  useEffect(() => {
    setMsgs([]);
    setErrTip(null);
    setDoneMs(null);
  }, [paperId]);

  // 错题本交接（③）：进来时替学生把问题填好
  useEffect(() => {
    if (prefill) setInput(prefill);
  }, [prefill]);

  // ---- 语音输入（⑨）：按住说，松手填进输入框，学生自己确认再发送 ----
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  const toggleVoice = () => {
    if (!SpeechRec) return;
    if (listening) { recRef.current?.stop(); return; }
    const r = new SpeechRec();
    r.lang = 'zh-CN'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => {
      const t = e.results?.[0]?.[0]?.transcript;
      if (t) setInput((v) => (v ? `${v}${t}` : t));
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r;
    setListening(true);
    try { r.start(); } catch { setListening(false); }
  };

  // ---- 记到错题本（③）：把刚问过的这道题（当前页）存起来 ----
  const [mistakeTip, setMistakeTip] = useState<string | null>(null);
  const saveMistake = async () => {
    const lastQ = [...msgsRef.current].reverse().find((m) => m.role === 'user')?.content ?? '';
    setMistakeTip('保存中…');
    const r = await addMistake(paperId, page, lastQ.trim().slice(0, 60) || `第 ${page} 页`);
    setMistakeTip(r.ok ? '已记入 ✓' : (r.reason === 'limit' ? (r.message ?? '已达免费上限') : '没记上，稍后再试'));
  };

  // 打开时拿一次剩余次数
  useEffect(() => {
    void fetchAiQuota().then(setQuota);
  }, []);

  // 新内容滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, status, queuePos]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || status !== 'idle' || locked) return;
    setInput('');
    setErrTip(null);
    setDoneMs(null);
    setStatus('streaming');
    setQueuePos(null);

    const history = msgsRef.current.slice(-4).map((m) => ({ role: m.role, content: m.content }));
    const next: Msg[] = [...msgsRef.current, { role: 'user', content: q }, { role: 'assistant', content: '' }];
    setMsgs(next);
    // 增量改最后一条，避免每字重渲整个列表的 React 开销：直接函数式追加
    const appendDelta = (piece: string) => {
      setMsgs((cur) => {
        if (!cur.length) return cur;
        const cp = cur.slice();
        const last = cp[cp.length - 1];
        cp[cp.length - 1] = { ...last, content: last.content + piece };
        return cp;
      });
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await askAi({
        paperId,
        page,
        which,
        question: q,
        history,
        signal: ctrl.signal,
        onEvent: (ev) => {
          if (ev.t === 'meta') {
            setQueuePos(null);
            setStatus('streaming');
            // quota 为 null（打开面板那次没拿到）时用 meta 事件补上
            setQuota((c) => (c
              ? { ...c, trial: ev.trial, remaining: ev.remaining, quota: ev.quota }
              : { allowed: true, member: !ev.trial, trial: ev.trial, remaining: ev.remaining, quota: ev.quota }));
          } else if (ev.t === 'queue') {
            setStatus('queueing');
            setQueuePos(ev.pos);
          } else if (ev.t === 'delta') {
            appendDelta(ev.c);
          } else if (ev.t === 'done') {
            setQuota((c) => (c ? { ...c, remaining: ev.remaining } : c));
            setDoneMs(ev.ms);
            // 试用这一问结束了：当场切到锁定引导态（下一次提问服务端也会拦）
            if (ev.trial_used) {
              setQuota((c) => (c ? { ...c, allowed: false, trial: false } : c));
            }
          } else if (ev.t === 'error') {
            setStatus('idle');
            setQueuePos(null);
            setErrTip(ev.message ?? '出错了，请稍后再试');
            // 出错的空回答别留着
            setMsgs((cur) => {
              const cp = cur.slice();
              if (cp.length && cp[cp.length - 1].role === 'assistant' && !cp[cp.length - 1].content) cp.pop();
              return cp;
            });
          }
        },
      });
    } catch (e) {
      if (e instanceof AiAskError) {
        if (e.reason === 'membership_required') {
          // 试用已用完：切锁定视图，比一条飘错的提示更明确
          setQuota({ allowed: false, member: false, message: e.message });
          setErrTip(null);
        } else {
          setErrTip(e.message);
        }
      } else if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setErrTip('网络不稳定，请重试');
      }
      setMsgs((cur) => {
        const cp = cur.slice();
        if (cp.length && cp[cp.length - 1].role === 'assistant' && !cp[cp.length - 1].content) cp.pop();
        return cp;
      });
    } finally {
      setStatus('idle');
      setQueuePos(null);
      abortRef.current = null;
    }
  }, [input, status, paperId, page, which, locked]);

  const stop = () => abortRef.current?.abort();

  return (
    <div
      className={`ai-panel fixed inset-x-0 bottom-0 z-[60] flex justify-center md:inset-x-auto md:right-5 md:top-[84px] md:bottom-5 md:justify-end ${closing ? 'ai-closing' : ''}`}
      role="dialog"
      aria-label="AI 学习助手"
    >
      {/* 手机：底部半屏抽屉（62dvh，键盘弹出自动收缩）；
          桌面：右侧悬浮面板，试卷仍占大屏，对照着看 */}
      <div className="ai-h-sheet flex w-full max-w-3xl flex-col rounded-t-2xl border border-b-0 border-hairline/[0.12] bg-ink-900 shadow-2xl md:h-auto md:w-[420px] md:max-w-none md:rounded-2xl md:border-b">
        {/* 头部：上下文芯片（学生永远知道 AI 在看哪页） */}
        <div className="flex items-center gap-2 border-b border-hairline/[0.08] px-4 py-2.5">
          <Sparkles className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="flex min-w-0 items-center gap-1 truncate text-[12px] text-gray-400">
            <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{title}</span>
            <span className="shrink-0 text-gray-400">· 第 {page} 页{which === 'answer' ? '（答案）' : ''}</span>
          </span>
          <button
            onClick={requestClose}
            className="ml-auto shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-elevate/[0.08] hover:text-gray-800"
            title="收起"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 消息区 */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {locked && (
            <div className="pt-6 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-elevate/[0.08]">
                <Lock className="h-5 w-5 text-gray-400" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-medium text-gray-800">AI 答疑 · 会员专享</p>
              <p className="mx-auto mt-1.5 max-w-xs text-[12px] leading-relaxed text-gray-400">
                {quota?.message ?? '免费试用已用完。开通会员即可每日使用 AI 答疑。'}
              </p>
              <button
                onClick={() => navigate({ name: 'membership' })}
                className="mt-4 rounded-xl bg-solid px-5 py-2.5 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
              >
                开通会员
              </button>
            </div>
          )}
          {!locked && msgs.length === 0 && (
            <div className="pt-4 text-center">
              <p className="text-[13px] text-gray-400">这页哪道题不会？直接问，比如：</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {['第1题怎么做', '第3题考的是什么知识点', '帮我讲讲这页的填空题'].map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="rounded-full border border-hairline/[0.14] bg-elevate/[0.06] px-3 py-1.5 text-[12px] text-gray-400 transition-colors hover:border-hairline/[0.3] hover:text-gray-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="mt-4 text-[11px] text-gray-400">AI 由本页内容作答，讲解思路为主 · 内容仅供参考</p>
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={`ai-bubble flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-solid px-3.5 py-2 text-[13px] leading-relaxed text-on-solid'
                    : 'max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-elevate/[0.08] px-3.5 py-2.5 text-[13px] leading-relaxed text-gray-800'
                }
              >
                {m.role === 'assistant' && m.content ? <MathText text={m.content} /> :
                  m.content ||
                  (status === 'streaming' && i === msgs.length - 1 ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : null)}
                {m.role === 'assistant' && m.content && status === 'streaming' && i === msgs.length - 1 && (
                  <span className="animate-pulse text-accent" aria-hidden="true">▍</span>
                )}
              </div>
            </div>
          ))}

          {status === 'queueing' && (
            <div className="flex items-center justify-center gap-2 text-[12px] text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {queuePos != null && queuePos > 0 ? `排队中，前面还有 ${queuePos} 人` : '排队中…'}
            </div>
          )}

          {errTip && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-300">
              {errTip}
              {errTip.includes('会员') && (
                <button
                  onClick={() => navigate({ name: 'membership' })}
                  className="ml-2 rounded-md bg-solid px-2 py-1 text-[11px] font-medium text-on-solid"
                >
                  查看会员
                </button>
              )}
            </div>
          )}
        </div>

        {/* 底部：解析跳转 + 输入区 + 剩余次数（ai-safe 兼容 iPhone 底部小黑条） */}
        <div className="ai-safe shrink-0 border-t border-hairline/[0.08] px-4 pt-2">
          {msgs.length > 0 && (
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={() => void saveMistake()}
                className="inline-flex items-center gap-1 text-[11px] text-gray-400 transition-colors hover:text-gray-800"
              >
                <BookmarkPlus className="h-3 w-3" />
                把这道题记到错题本
              </button>
              {mistakeTip && <span className="text-[11px] text-gray-400">{mistakeTip}</span>}
            </div>
          )}
          {solutionPage != null && (
            <button
              onClick={() => onJumpSolution(solutionPage)}
              className="mb-2 inline-flex items-center gap-1 text-[11px] text-gray-400 transition-colors hover:text-gray-800"
            >
              <BookOpen className="h-3 w-3" />
              本卷自带参考解析（第 {solutionPage} 页起）
            </button>
          )}
          {locked ? (
            <button
              onClick={() => navigate({ name: 'membership' })}
              className="w-full rounded-xl bg-solid py-3 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
            >
              开通会员，获取每日额度
            </button>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={quota?.trial
                  ? '免费试用 · 问这一题：如「第3题怎么做」'
                  : status === 'idle' ? '问这页的题，如：第3题怎么做' : 'AI 正在回答…'}
                disabled={status !== 'idle'}
                className="max-h-24 flex-1 resize-none rounded-xl border border-hairline/[0.14] bg-elevate/[0.06] px-3.5 py-2.5 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-hairline/[0.35] focus:outline-none disabled:opacity-60"
              />
              {SpeechRec && status === 'idle' && (
                <button
                  onClick={toggleVoice}
                  className={`shrink-0 rounded-xl p-3 transition-colors ${listening ? 'bg-accent/15 text-accent' : 'bg-elevate/[0.08] text-gray-400 hover:bg-elevate/[0.16]'}`}
                  title={listening ? '正在听，点一下结束' : '语音输入'}
                >
                  <Mic className={`h-4 w-4 ${listening ? 'animate-pulse' : ''}`} />
                </button>
              )}
              {status === 'idle' ? (
                <button
                  onClick={() => void send()}
                  disabled={!input.trim()}
                  className="shrink-0 rounded-xl bg-solid p-3 text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-40"
                  title="发送"
                >
                  <Send className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={stop}
                  className="shrink-0 rounded-xl bg-elevate/[0.1] p-3 text-gray-700 transition-colors hover:bg-elevate/[0.16]"
                  title="停止"
                >
                  <Square className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-gray-400">
            {locked
              ? 'AI 答疑为会员专享'
              : quota?.trial
                ? '免费试用 1 次 · 开通会员每日使用'
                : quota
                  ? `今日剩余 ${quota.remaining ?? '-'} / ${quota.quota ?? '-'} 次${doneMs != null ? ` · 上次回答 ${(doneMs / 1000).toFixed(1)} 秒` : ''}`
                  : 'AI 答疑 · 会员专享'}
          </p>
        </div>
      </div>
    </div>
  );
}
