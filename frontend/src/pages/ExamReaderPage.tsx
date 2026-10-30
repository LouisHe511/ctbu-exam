import { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { saveProgress, fetchProgress, consumeReaderHandoff, addMistake } from '@/lib/study';
import { useApp } from '@/context/AppContext';
import { usePapers } from '@/context/PapersContext';
import { useAccess } from '@/context/AccessContext';
import { useAuth } from '@/context/AuthContext';
import { usePaperById } from '@/components/Cards';
import { getPaperContent } from '@/data/papers';
import { getPrivatePdfBytes, incrementPaperView, consumesQuota } from '@/lib/papers';
import { confirmDialog } from '@/lib/dialog';
import { Watermark } from '@/components/Watermark';
import { PaywallModal, AnnouncementModal } from '@/components/Modals';
import { PdfCanvasViewer } from '@/components/PdfCanvasViewer';
// 逐页图片通道（2026-10-17 新增）：扫描卷走图片、矢量卷仍走 PDF。
// 服务端决定用哪条，前端只负责按 kind 渲染。
import { ImagePageViewer } from '@/components/ImagePageViewer';
import { fetchPaperPages, type PaperPagesResult } from '@/lib/paperPages';
// AI 学习助手（2026-10-25）：只挂在逐页图片版的卷子上 —— AI 读的就是这些页面图。
/**
 * AI 面板按需加载（2026-10-28）。
 *
 * AiPanel 顶层 `import katex from 'katex'` + 它那份 30KB 的字体 CSS，
 * 静态引入等于让**每一份**试卷都背 310KB —— 而 AI 只在"逐页图片版 + 非手写卷"
 * 才出现，打开矢量 PDF 卷的人根本用不到。改成 lazy 之后阅读器主包能瘦一大截。
 */
const AiPanel = lazy(() => import('@/components/AiPanel').then((m) => ({ default: m.AiPanel })));
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Bookmark, Share2, ListTodo,
  CheckCircle, FileText, Loader2, Info, BookOpen, Sparkles,
} from 'lucide-react';

export function ExamReaderPage({ paperId }: { paperId: string }) {
  const { navigate, backFromReader, isFavorite, toggleFavorite, addRecentView } = useApp();
  const { loading: papersLoading } = usePapers();
  const { requestAccess, freeRemaining, freeLimit } = useAccess();
  const { session } = useAuth();
  const paper = usePaperById(paperId);

  const [currentPage, setCurrentPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pdfPage, setPdfPage] = useState<number | null>(null);
  /**
   * 跳页请求序号（2026-10-22 修「底部缩略图点了没反应」）。
   *
   * 只传 `pdfPage=3` 是不行的：连点两次第 3 页时值没变，
   * 阅读器里的 useEffect 依赖不变 → 不重跑 → 看起来"按钮坏了"。
   * 每次点击都 +1，保证是一个新请求。
   */
  const [jumpNonce, setJumpNonce] = useState(0);
  /** 阅读器回报的当前真实页码（1 基），用于缩略图高亮与页码显示 */
  const [viewerPage, setViewerPage] = useState(1);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  // ---- 逐页图片版（2026-10-17 新增）----
  // 有图片版时**完全不下载 PDF**：这是这条通道存在的意义。
  // 拿到了就不再看 pdfData，两者互斥。
  const [pageImages, setPageImages] = useState<PaperPagesResult | null>(null);
  const [answerImages, setAnswerImages] = useState<PaperPagesResult | null>(null);
  // ---- 独立答案 PDF（2026-10-16 新增）----
  // 答案单独存一份文件（papers.answer_path）。**按需加载**：只有用户点了「查看答案」
  // 才去私有桶拉字节，不预加载 —— 学生只想做题时不该为答案浪费一次配额与流量。
  const [answerData, setAnswerData] = useState<Uint8Array | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [gate, setGate] = useState<'checking' | 'granted' | 'denied' | 'error'>('checking');
  const [fileError, setFileError] = useState<string | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [loadingHint, setLoadingHint] = useState('正在校验查看权限…');
  const [elapsed, setElapsed] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const gatedRef = useRef<string | null>(null);

  /**
   * 2026-10-20 用户决定：**取消"两台设备不能同时查看"**。
   * 原来这里会打心跳并弹违规弹窗；现在完全停用（连请求都不发）。
   * 阅读页不再有任何心跳 / 违规判定 / 处罚弹窗。
   */

  // 转圈时显示已等待秒数：弱网下让用户知道"还在动"，而不是以为卡死了
  useEffect(() => {
    if (gate !== 'checking') return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [gate, retryTick]);

  // 鉴权：真实试卷要过一遍服务端的免费额度校验；演示数据直接放行
  useEffect(() => {
    if (!paper) return;
    if (retryTick === 0 && gatedRef.current === paper.id) return;
    // 本地开发鉴权豁免（2026-10-25 用户要求）：跳过 unlock 校验等待。
    // import.meta.env.DEV 在生产构建里恒为 false，整段会被打包器剔除，不会上线。
    // ⚠️ 不设置 gatedRef：StrictMode 双挂载（仅 dev）会先跑一遍再 cleanup 重跑，
    //    若第一次就把 ref 占住，第二次挂载会在此守卫处直接 return → gate 卡 checking 永不加载。
    if (import.meta.env.DEV) {
      // 豁免的只是「额度校验」，内容加载照旧（图片页 → 回退 PDF）
      setGate('checking');
      setPdfData(null);
      setFileError(null);
      let cancelledDev = false;
      (async () => {
        try {
          const imgs = await fetchPaperPages(paper.id, session?.access_token ?? null, 'paper');
          if (cancelledDev) return;
          if (imgs?.kind === 'images') {
            setPageImages(imgs);
            setGate('granted');
            return;
          }
          if (paper.filePath) {
            setLoadingHint('正在读取试卷文件…');
            const bytes = await getPrivatePdfBytes(
              paper.filePath, 90_000, imgs?.kind === 'pdf' ? imgs.url : null);
            if (cancelledDev) return;
            setPdfData(bytes);
          }
          setGate('granted');
        } catch (e) {
          setFileError(e instanceof Error ? e.message : '文件读取失败');
          setGate('error');
        }
      })();
      return () => { cancelledDev = true; };
    }
    gatedRef.current = paper.id;

    let cancelled = false;
    (async () => {
      setGate('checking');
      setPdfData(null);
      setFileError(null);
      try {
        const privateStorageFile = !!paper.filePath && !paper.filePath.startsWith('/') && !paper.filePath.startsWith('http');
        setLoadingHint('正在校验查看权限…');

        // 2026-10-20 提速：**并发**发起图片页请求与额度校验。
        // 以前是「先等额度 → 再问图片页」，两个 RTT 串行；
        // 而 /api/pay/paper-pages 在服务端**自己就会验权限**（会员或已解锁），
        // 所以这里并发不会泄露内容：没权限时它照样返回 403，我们只是白跑一次请求。
        // 换来的是弱网下首屏少等一个 RTT（实测 300~900ms）。
        const pagesPromise = fetchPaperPages(paper.id, session?.access_token ?? null, 'paper');

        const result = await requestAccess(
          paper.id,
          consumesQuota(paper),
          privateStorageFile
        );
        if (cancelled) return;
        if (result === null || result.ok) {
          // 图片页请求可能已在上面的额度校验期间完成（并发红利）
          const imgs = await pagesPromise;
          if (cancelled) return;
          if (imgs?.kind === 'images') {
            setPageImages(imgs);
            setGate('granted');
            return;
          }
          // 没有图片版（矢量卷，图片化反而更大）→ 走 PDF 通路。
          // imgs.url 是本机签名链接（全部 PDF 已搬回国内）；没有则回退 Supabase。
          if (paper.filePath) {
            setLoadingHint('正在读取试卷文件…');
            const bytes = await getPrivatePdfBytes(
              paper.filePath,
              90_000,
              imgs?.kind === 'pdf' ? imgs.url : null,
            );
            if (cancelled) return;
            setPdfData(bytes);
          }
          setGate('granted');
        } else {
          setGate('denied');
          setPaywallOpen(true);
        }
      } catch (e) {
        if (cancelled) return;
        // 网络超时/失败走这里：给出可重试的错误，而不是永远转圈
        setFileError(e instanceof Error ? e.message : '加载失败，请重试');
        setGate('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // requestAccess 会随额度刷新而变，这里只用 paper.id 触发（retryTick 用于手动重试）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper?.id, retryTick]);

  useEffect(() => {
    if (!paper) return;
    addRecentView(paper.id);
    if (paper.isReal) incrementPaperView(paper.id);
  }, [paper?.id, addRecentView, paper?.isReal]);

  /**
   * 打开第一份试卷之后，才弹「新用户免费看 3 份」的公告（只弹一次）。
   *
   * ⚠️ 2026-10-20 修 bug：这个弹窗原来**对所有人**弹，文案写的是「注册即可免费查看」。
   * 已登录（甚至创始会员）的用户看到它，会以为"我还得注册/登录才能看" ——
   * 用户原话：「注册登陆后 进入第一个真题浏览还是会跳出来让我去注册或登录的弹窗」。
   * 现在只对**未登录访客**弹：它的作用本来就是引导访客注册，登录用户看这个毫无意义。
   */
  useEffect(() => {
    if (gate !== 'granted') return;
    if (session) return;          // 已登录：不弹「去注册」
    try {
      if (!localStorage.getItem('ctbu_announce_seen')) setAnnounceOpen(true);
    } catch {
      /* 隐私模式下 localStorage 不可用，忽略 */
    }
  }, [gate, session]);

  const dismissAnnounce = () => {
    try {
      localStorage.setItem('ctbu_announce_seen', '1');
    } catch {
      /* ignore */
    }
    setAnnounceOpen(false);
  };

  useEffect(() => {
    setCurrentPage(0);
    setPdfPage(null);
    // 换试卷时页码高亮也要回到第 1 页，否则会停在上一份的第 7 页
    setViewerPage(1);
    setJumpNonce(0);
    setPdfData(null);
    setFileError(null);
    // 换了一份试卷就要把答案状态一并清掉，否则会把上一份的答案显示给这一份
    setAnswerData(null);
    setShowAnswer(false);
    setAnswerError(null);
    // 换卷时退出"解析模式"：下一份卷默认从试题开始，按钮也该显示「查看解析」
    setSolutionMode(false);
    // 图片版同理：上一份的图片链接不能留给下一份（而且签名的有效期也不同）
    setPageImages(null);
    setAnswerImages(null);
  }, [paperId]);

  /**
   * 当前是不是停在"解析"那一屏（2026-10-28）。
   *
   * 用户要求：把「查看解析」和「回到试题」两个按钮并成一个**会变身的**按钮 ——
   * 点查看解析后它自己变成"回到试题"，点回来再变回"查看解析"。
   * 按钮长什么样只用左边那个（实心）的样式，右边那个描边版删掉。
   *
   * 为什么用显式状态而不是"当前页码 ≥ solutionPage"来推导：
   *   解析往往跨好几页，学生在解析里翻页时页码一直变；用状态记"我是从解析入口进来的"，
   *   按钮就不会在他翻到解析第 3 页时突然跳回"查看解析"。
   *   换卷时重置（见上面的 paperId effect）。
   */
  const [solutionMode, setSolutionMode] = useState(false);

  /** 跳到解析：图片版与 PDF 版都用「页码锚点」（2026-10-18 修） */
  const goToSolution = () => {
    const sp = paper?.solutionPage;
    // ⚠️ 以前这里只判 isPdf，图片版（扫描卷，站点里绝大多数）点「查看解析」毫无反应 —— 真 bug。
    if (sp) {
      setPdfPage(sp);
      setSolutionMode(true);
      return;
    }
    const idx = content.pages.findIndex((pg) => pg.isAnswer);
    if (idx >= 0) {
      setCurrentPage(idx);
      setSolutionMode(true);
    }
  };

  const backToQuestions = () => {
    setPdfPage(1);
    setSolutionMode(false);
  };

  /**
   * 切换「试卷 ↔ 独立答案」（2026-10-16 新增）。
   * 答案文件与试卷是两份独立的 PDF，来回切换都要把页码复位到第 1 页，
   * 否则从"试卷第 8 页"切到答案（可能只有 3 页）会落在空白处。
   */
  const toggleAnswer = async () => {
    const path = paper?.answerPath;
    if (!path) return;
    setPdfPage(1);
    if (showAnswer) {
      setShowAnswer(false);
      return;
    }
    setShowAnswer(true);
    // 图片版答案同样按需取：先问服务端有没有，有就跳过 PDF
    let answerLocalUrl: string | null = null;
    if (!answerImages) {
      try {
        const imgs = await fetchPaperPages(paper.id, session?.access_token ?? null, 'answer');
        if (imgs?.kind === 'images') {
          setAnswerImages(imgs);
          return;
        }
        // 没有图片版 → 记下本机 PDF 的签名链接，下面优先用它
        if (imgs?.kind === 'pdf') answerLocalUrl = imgs.url ?? null;
      } catch {
        /* 取不到就继续走 PDF 通路，不打扰用户 */
      }
    } else {
      return;                          // 答案已经是图片版且已拿到
    }
    if (answerData) return;          // 已经拉过一次就不重复拉
    setAnswerLoading(true);
    setAnswerError(null);
    try {
      const bytes = await getPrivatePdfBytes(path, 90_000, answerLocalUrl);
      setAnswerData(bytes);
    } catch (e) {
      setAnswerError(e instanceof Error ? e.message : '答案文件读取失败');
    } finally {
      setAnswerLoading(false);
    }
  };

  const content = useMemo(() => getPaperContent(paperId), [paperId]);

  // ⚠️ 这两个 hook 必须放在下面的 `if (!paper) return` **之前**：
  // React 要求同一组件每次渲染的 hooks 数量与顺序一致，
  // 放在提前 return 之后会因为 paper 未加载时少执行两个 hook 而报
  // "Rendered more hooks than during the previous render" 并导致整页白屏。
  //
  // 动态水印：带上「看的人是谁 + 什么时候看的」。固定水印追不到泄露源头；
  // 带上账号和时间后，截图流出去能定位到具体账号，比"技术防下载"有效得多。
  const watermarkText = useMemo(() => {
    // 手机号注册的账号没有邮箱 —— 只用 email 会显示成「未登录」，
    // 截图外流时就追不到人了（2026-10-21 修）
    const who = session?.user?.email || session?.user?.phone || '未登录';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `工商真题库 · ${who} · ${stamp}`;
  }, [session?.user?.email, session?.user?.phone]);

  /**
   * 手写卷**不出 AI 入口**（2026-10-26 用户要求）。
   *
   * 手写笔记是个人笔迹整理，页面上本来就没有结构化题干，AI 读图提问只会把
   * 连笔字认成乱码再把错字喂回给用户 —— 没价值还有风险，直接不给入口。
   * 全库 121 卷逐页核过，手写只有下面这一份，所以按 id 白名单最省事；
   * 以后新收手写资料，把 id 加进来即可（别改成按标题「笔记」判，印刷版习题集
   * 也叫笔记，会误伤）。
   *
   * ⚠️ 必须和上面几个 useMemo 一起待在 `if (!paper) return` **之前**——
   * 2026-10-26 第一次改时放到了 return 之后，线上直接 React #310 整页打不开。
   */
  const handwrittenIds = useMemo(
    () => new Set([
      '7e7448d0-5538-4d43-90e5-24079959c0b5', // 财政学超全笔记（c032，全 50 页手写）
    ]),
    [],
  );

  const [shareTip, setShareTip] = useState('');

  // ---- AI 学习助手（2026-10-25）：半屏面板 + 右下角悬浮按钮 ----
  const [aiOpen, setAiOpen] = useState(false);

  // ---- 继续阅读（④）+ 错题本（③）· 2026-10-25 ----
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [mistakeQ, setMistakeQ] = useState('');
  const [mistakeSaving, setMistakeSaving] = useState(false);
  const [mistakeTip, setMistakeTip] = useState('');
  const [aiPrefill, setAiPrefill] = useState<string | null>(null);
  const savedPageRef = useRef<number | null>(null);   // 本卷上次看到哪页
  const resumedRef = useRef<string | null>(null);     // 防重复跳页

  // 换卷：拉上次进度 + 消费错题本页的交接（翻页 + 预填问题）
  useEffect(() => {
    resumedRef.current = null;
    savedPageRef.current = null;
    setAiPrefill(null);
    let alive = true;
    if (session?.user) {
      fetchProgress().then((ps) => {
        if (!alive) return;
        const hit = ps.find((x) => x.paper_id === paperId);
        if (hit) savedPageRef.current = hit.page;
      });
    }
    const hand = consumeReaderHandoff(paperId);
    if (hand) {
      savedPageRef.current = hand.page;      // 交接指定的页优先于历史进度
      if (hand.question) setAiPrefill(hand.question);
    }
    return () => { alive = false; };
  }, [paperId, session?.user]);

  // 进度保存：翻页 1.2s 后落库（防抖；未登录/未放行不存）
  useEffect(() => {
    if (!session?.user || gate !== 'granted' || viewerPage < 1) return;
    const t = setTimeout(
      () => { void saveProgress(paperId, viewerPage, showAnswer ? 'answer' : 'paper'); }, 1200);
    return () => clearTimeout(t);
  }, [paperId, viewerPage, gate, showAnswer, session?.user]);

  // 自动续读：内容就绪后跳回上次页（每卷一次）；带预填问题时顺手开 AI 面板
  useEffect(() => {
    if (gate !== 'granted' || resumedRef.current === paperId) return;
    if (!pageImages && !pdfData) return;
    resumedRef.current = paperId;
    const pg = savedPageRef.current;
    if (pg && pg > 1) {
      setViewerPage(pg);
      setPdfPage(pg);
      setJumpNonce((v) => v + 1);
    }
    if (aiPrefill) {
      setAiOpen(true);
      setAiPrefill(null);
    }
  }, [gate, paperId, pageImages, pdfData, aiPrefill]);

  if (!paper) {
    return (
      <div className="pt-[73px] flex items-center justify-center min-h-screen">
        <div className="text-center">
          {papersLoading ? (
            <Loader2 className="w-6 h-6 text-gray-700 animate-spin mx-auto" />
          ) : (
            <>
              <p className="text-gray-500 mb-4">试卷不存在</p>
              <button onClick={() => navigate({ name: 'library' })} className="rounded-lg bg-solid px-4 py-2 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover">
                返回真题库
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const fav = isFavorite(paperId);

  const saveMistakeHere = async () => {
    setMistakeSaving(true);
    const r = await addMistake(paperId, viewerPage, mistakeQ.trim() || `第 ${viewerPage} 页`);
    setMistakeSaving(false);
    setMistakeTip(r.ok ? '已记入 ✓' : (r.reason === 'limit' ? (r.message ?? '已达免费上限') : '没记上，稍后再试'));
    if (r.ok) window.setTimeout(() => { setMistakeOpen(false); setMistakeTip(''); setMistakeQ(''); }, 900);
  };
  const isPdf = !!paper.filePath && !!pdfData;
  /**
   * 当前该显示的「逐页图片版」，null 表示走 PDF 或演示数据。
   * 答案优先：切到答案但答案图片还没拿到时，继续显示试卷图片（与 PDF 通路的行为一致，
   * 避免切换瞬间闪白）。
   */
  const activeImages = showAnswer && answerImages?.kind === 'images'
    ? answerImages
    : pageImages?.kind === 'images'
      ? pageImages
      : null;
  /** AI 只服务逐页图片版的**印刷卷**；矢量 PDF 卷没有页面图可读，手写卷不提供 */
  const aiAvailable =
    gate === 'granted' && activeImages != null && !handwrittenIds.has(paperId);
  const totalPages = paper.filePath ? paper.pages : content.pages.length;
  const page = content.pages[currentPage];

  /**
   * 跳到第 n 页（**1 基**）。
   *
   * 2026-10-22 前的 bug：底部缩略图调的是 `goToPage(idx)`（**0 基**），
   * 而它只 `setCurrentPage()` —— 那只对「演示文本」那条路有效。
   * 站点里真正的试卷是逐页图片（或 PDF），页码由阅读器内部的 state 控制，
   * 外面只能通过 `requestedPage` 告诉它 —— 这条链路当时根本没接。
   * 所以点 1 2 3 4 5 毫无反应，一直是坏的。
   */
  const jumpToPage = (n1Based: number) => {
    const n = Math.max(1, Math.min(totalPages, n1Based));
    setCurrentPage(n - 1);          // 演示文本那套是 0 基
    setPdfPage(n);                  // 真正的阅读器是 1 基
    setJumpNonce((v) => v + 1);     // 同一个目标页再点一次也要生效
    setViewerPage(n);
  };

  const handleFavClick = async () => {
    const result = await toggleFavorite(paperId);
    if (result === 'needs-login') {
      if (
        await confirmDialog('登录后才能收藏真题，收藏会保存到你的账号里。现在去登录吗？', {
          confirmLabel: '去登录',
        })
      ) {
        navigate({ name: 'login' });
      }
      return;
    }
    if (result === 'error') {
      void confirmDialog('收藏没有保存成功，可能是网络问题。要重试一次吗？', {
        confirmLabel: '重试',
      }).then((again) => { if (again) void toggleFavorite(paperId); });
    }
  };

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setShareTip('链接已复制');
    } catch {
      // 部分浏览器/非 HTTPS 下剪贴板不可用，退化成让用户手动复制
      setShareTip(url);
    }
    window.setTimeout(() => setShareTip(''), 2500);
  };

  return (
    <div className="flex min-h-screen flex-col bg-page pb-20 pt-[73px] md:pb-0">
      <PaywallModal
        open={paywallOpen}
        onClose={() => {
          setPaywallOpen(false);
          navigate({ name: 'library' });
        }}
        onLogin={() => navigate({ name: session ? 'profile' : 'login' })}
        onGoPricing={() => navigate({ name: 'membership' })}
        freeLimit={freeLimit}
        freeRemaining={freeRemaining}
        isLoggedIn={!!session}
      />

      <AnnouncementModal
        open={announceOpen}
        onClose={dismissAnnounce}
        freeLimit={freeLimit}
        onLogin={() => {
          dismissAnnounce();
          navigate({ name: session ? 'profile' : 'register' });
        }}
      />

      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 border-b border-hairline/[0.08] bg-ink-850 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={backFromReader}
            className="shrink-0 rounded-md p-1.5 text-gray-500 transition-colors hover:bg-solid-hover/[0.06] hover:text-gray-800"
            title="返回上一页"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-medium tracking-[-0.01em] text-gray-800">
              {/* 2026-10-20：优先显示具体标题（如「财政学模拟试题1-5」），课程名降为上下文 */}
              {paper.title ?? paper.courseName}
              {paper.title && (
                <span className="font-normal text-gray-500"> · {paper.courseName}</span>
              )}
              {(() => {
                const rest = [paper.year ? `${paper.year}年` : null, paper.semester, paper.examType]
                  .filter(Boolean).join(' · ');
                return rest ? <span className="font-normal text-gray-500"> · {rest}</span> : null;
              })()}
            </h1>
            <p className="font-mono text-[11px] text-gray-500">
              {paper.resourceType === 'study_guide'
                ? '课程复习资料'
                : `${paper.hasAnswer ? '含答案' : '无答案'} · 共 ${totalPages} 页${paper.sourceType === 'recall' ? ' · 回忆版' : ''}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {paper.sourceSchool && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-amber-500/15 text-amber-600 border border-amber-500/30">
              <Info className="w-3 h-3" />
              来源：{paper.sourceSchool}
            </span>
          )}
          {paper.hasSolution && (
            /*
              一个按钮，两种状态（2026-10-28 用户要求）：
                试题态 → 「查看解析」（书图标，实心）
                解析态 → 「回到试题」（左箭头，同样实心）
              原来这里是「查看解析 + 回到试题」两个并排按钮 —— 同一件事的两个方向，
              并排放等于让用户先判断"我现在在哪"，多一步思考。
              现在只留一个，点一下就走，标签自己变。
            */
            <button
              onClick={solutionMode ? backToQuestions : goToSolution}
              className="inline-flex items-center gap-1 rounded-md bg-solid px-2.5 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
              title={solutionMode ? '回到试题第 1 页' : '跳到解析那一页'}
              aria-label={solutionMode ? '回到试题' : '查看解析'}
            >
              {solutionMode
                ? <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                : <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{solutionMode ? '回到试题' : '查看解析'}</span>
            </button>
          )}
          {/* 独立答案 PDF：只有入库时配了答案文件才出现（2026-10-16 新增） */}
          {paper.answerPath && (
            <button
              onClick={() => void toggleAnswer()}
              disabled={answerLoading}
              className="inline-flex items-center gap-1 rounded-md bg-solid px-2.5 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-50"
              title={showAnswer ? '回到试卷' : '查看答案与评分标准'}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {answerLoading ? '加载中…' : showAnswer ? '返回试卷' : '查看答案'}
              </span>
            </button>
          )}
          {answerError && (
            <span className="hidden sm:inline text-[11px] text-red-300" title={answerError}>
              答案读取失败
            </span>
          )}
          <div className="relative">
            <button
              onClick={() => { setMistakeOpen((v) => !v); setMistakeTip(''); }}
              className="p-2 rounded-lg transition-colors hover:bg-solid-hover/[0.08]"
              title="记到错题本"
            >
              <ListTodo className={`w-4 h-4 ${mistakeOpen ? 'text-accent' : 'text-gray-500'}`} />
            </button>
            {mistakeOpen && (
              <div className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-solid-hover/25 bg-ink-900 p-3 shadow-2xl z-50">
                <p className="text-[12px] text-gray-400 mb-2">记第 {viewerPage} 页的哪道题？</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      onClick={() => setMistakeQ(`第${n}题`)}
                      className={`rounded-md border px-2 py-1 text-[12px] transition-colors ${mistakeQ === `第${n}题` ? 'border-accent/60 text-accent' : 'border-solid-hover/25 text-gray-500 hover:text-gray-300'}`}
                    >
                      第{n}题
                    </button>
                  ))}
                </div>
                <input
                  value={mistakeQ}
                  onChange={(e) => setMistakeQ(e.target.value.slice(0, 30))}
                  placeholder="或自己填备注，如：第3题 行列式"
                  className="mb-2 w-full rounded-lg border border-solid-hover/25 bg-page px-2.5 py-1.5 text-[12px] text-gray-300 placeholder:text-gray-600 focus:border-accent/50 focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void saveMistakeHere()}
                    disabled={mistakeSaving}
                    className="rounded-lg bg-solid px-3 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-50"
                  >
                    {mistakeSaving ? '保存中…' : '保存'}
                  </button>
                  {mistakeTip && <span className="flex-1 text-[11px] text-gray-400">{mistakeTip}</span>}
                </div>
                <button
                  onClick={() => navigate({ name: 'mistakes' })}
                  className="mt-2 text-[11px] text-gray-500 transition-colors hover:text-gray-300"
                >
                  查看错题本 →
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleFavClick}
            className="p-2 rounded-lg transition-colors hover:bg-solid-hover/[0.08]"
            title="收藏"
          >
            <Bookmark className={`w-4 h-4 ${fav ? 'fill-accent text-gray-700' : 'text-gray-500'}`} />
          </button>
          <button
            onClick={handleShare}
            className="p-2 rounded-lg transition-colors hover:bg-solid-hover/[0.08] hidden sm:block"
            title="复制这份试卷的链接"
          >
            <Share2 className="w-4 h-4 text-gray-500" />
          </button>
        </div>
      </div>

      {shareTip && (
        <div className="px-3 pb-2">
          <p className="text-xs text-gray-300 break-all">{shareTip}</p>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 flex items-stretch justify-center p-4 sm:p-6 overflow-auto">
        {gate === 'checking' && (
          <div className="flex items-center justify-center w-full">
            <div className="text-center">
              <Loader2 className="w-6 h-6 text-gray-700 animate-spin mx-auto" />
              <p className="mt-3 text-sm text-gray-500">{loadingHint}</p>
              {elapsed >= 3 && (
                <p className="mt-1 text-xs text-gray-500 tabular-nums">
                  已等待 {elapsed} 秒…网络较慢时请再稍等
                </p>
              )}
              {elapsed >= 20 && (
                <button
                  onClick={() => setRetryTick((t) => t + 1)}
                  className="mt-3 px-4 py-2 rounded-lg bg-elevate/[0.08] text-gray-800 hover:bg-solid-hover/[0.14] hover:text-strong"
                >
                  等太久了，重新加载
                </button>
              )}
            </div>
          </div>
        )}

        {gate === 'error' && (
          <div className="flex items-center justify-center w-full">
            <div className="text-center max-w-sm rounded-2xl border border-red-500/25 bg-ink-850 p-6">
              <p className="text-red-300 mb-2">PDF 暂时无法打开</p>
              <p className="text-sm text-gray-500 mb-4">{fileError || '请重试'}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setRetryTick((t) => t + 1)}
                  className="rounded-lg bg-solid px-4 py-2 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
                >
                  重试
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 rounded-lg bg-elevate/[0.08] text-gray-800 hover:bg-solid-hover/[0.14] hover:text-strong"
                >
                  刷新页面
                </button>
              </div>
            </div>
          </div>
        )}

        {gate === 'denied' && (
          <div className="flex items-center justify-center w-full">
            <div className="text-center max-w-sm">
              <p className="text-gray-300 mb-2">免费额度已用完</p>
              <p className="text-sm text-gray-500 mb-4">
                开通会员即可全站不限量查看
              </p>
              <button
                onClick={() => setPaywallOpen(true)}
                className="rounded-lg bg-solid px-5 py-3 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
              >
                查看会员方案
              </button>
            </div>
          </div>
        )}

        {/* 逐页图片版（扫描卷）：不加载 PDF，也不加载约 1.7 MB 的 PDF.js 运行库 */}
        {gate === 'granted' && activeImages && (
          <ImagePageViewer
            // 切换试卷/答案时强制重建：两套图是完全不同的集合，
            // 复用实例会把页码、预取目标留在上一套的状态上
            key={showAnswer && answerImages?.kind === 'images' ? 'answer-images' : 'paper-images'}
            urls={activeImages.urls}
            title={[
              paper.title ?? paper.courseName,
              paper.year ? `${paper.year}年` : null,
              paper.semester,
              paper.examType,
              showAnswer && answerImages?.kind === 'images' ? '答案与评分标准' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            watermark={watermarkText}
            requestedPage={pdfPage}
            requestNonce={jumpNonce}
            onPageChange={setViewerPage}
            // 图片签名过期（2 小时）时重跑一次加载流程，换一批新链接（2026-10-28）
            onStale={() => setRetryTick((t) => t + 1)}
          />
        )}

        {gate === 'granted' && !activeImages && isPdf && pdfData && (
          <PdfCanvasViewer
            // 切换试卷/答案时**强制重建组件**：两者是不同的 PDF 文档，
            // 只换 data 的话 PDF.js 的文档句柄与 canvas 会停在中间态
            //（实测：切到答案后按钮和标题都变了，但画布是空白的，且控制台无报错）。
            // 用 key 让 React 卸载旧实例、挂全新实例，加载与渲染都从头来。
            key={showAnswer && answerData ? 'answer' : 'paper'}
            // 显示答案时换成答案文件；答案还没拉回来就先继续显示试卷，避免闪白
            data={showAnswer && answerData ? answerData : pdfData}
            title={[
              paper.title ?? paper.courseName,
              paper.year ? `${paper.year}年` : null,
              paper.semester,
              paper.examType,
              showAnswer && answerData ? '答案与评分标准' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            watermark={watermarkText}
            requestedPage={pdfPage}
            requestNonce={jumpNonce}
            onPageChange={setViewerPage}
          />
        )}

        {gate === 'granted' && !activeImages && !isPdf && (
          <div
            className="relative bg-ink-850 rounded-lg shadow-2xl transition-all duration-300 mx-auto"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center',
              width: '100%',
              maxWidth: '720px',
              minHeight: '500px',
            }}
          >
            <Watermark text={watermarkText} />

            <div className="relative p-6 sm:p-10 lg:p-12">
              <pre className="text-sm sm:text-base text-gray-800 font-serif leading-relaxed whitespace-pre-wrap break-words font-[Georgia,serif]">
                {page.content}
              </pre>
            </div>

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
              <span className="text-xs text-gray-500 bg-page px-3 py-1 rounded-full border border-gray-100">
                {currentPage + 1} / {totalPages}
              </span>
            </div>

            {page.isAnswer && (
              <div className="absolute top-4 right-4">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[0.10] px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                  <CheckCircle className="w-3 h-3" />
                  参考答案
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        Bottom controls —— 真实 PDF 用阅读器自带的翻页/缩放，这里只给演示数据用。

        2026-10-21：**逐页图片版也不再用这一排**。
        原因有两个，第二个是真 bug：
          ① 图片阅读器自己已经有翻页/缩放/双页，这一排是重复的；
          ② 一旦在阅读器里打开「双页」，这排的「下一页」还是 +1 ——
             点下去目标页落在当前跨页内部，画面纹丝不动，看着像按钮坏了。
        缩略图那一条保留：它是唯一能"跳到第 N 页"的入口，图片版尤其需要。
      */}
      {gate === 'granted' && !isPdf && (
        // ⚠️ 这条原来写 `bg-gray-800 border-gray-700` —— 2026-10-21 全站转深色时把 gray 色阶
        //    整体反转了语义，`bg-gray-800` 现在是**浅灰 #dfe2e6**，于是它在深色页面上
        //    是一整块白板（用户 2026-10-22 截图指出）。深色底上别再用 gray-800 当深背景。
        <div className="border-t border-hairline/[0.07] bg-ink-900 px-4 py-3">
          {!activeImages && (
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <button
              onClick={() => jumpToPage(viewerPage - 1)}
              disabled={viewerPage <= 1}
              className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-25 disabled:cursor-not-allowed bg-elevate/[0.08] text-gray-800 hover:bg-solid-hover/[0.14] hover:text-strong"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">上一页</span>
            </button>

            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}
                className="p-2 rounded-lg bg-elevate/[0.06] text-gray-800 hover:bg-solid-hover/[0.12] hover:text-strong transition-colors"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs text-gray-300 w-12 text-center tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(2.0, z + 0.1))}
                className="p-2 rounded-lg bg-elevate/[0.06] text-gray-800 hover:bg-solid-hover/[0.12] hover:text-strong transition-colors"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <div className="w-px h-6 bg-elevate/[0.12] hidden sm:block" />
              <span className="text-xs text-gray-300 hidden sm:block tabular-nums">
                {viewerPage}/{totalPages}
              </span>
            </div>

            <button
              onClick={() => jumpToPage(viewerPage + 1)}
              disabled={viewerPage >= totalPages}
              className="flex items-center gap-1 rounded-lg bg-solid px-3 py-2 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-30"
            >
              <span className="hidden sm:inline">下一页</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          )}

          {/*
            页码缩略图（2026-10-22 修「点了没反应」）
            ---------------------------------------------------------------
            原来它调的是 `goToPage(idx)`（0 基），而那只改 `currentPage`
            —— 那只对「演示文本」这条路有效。站点里真实的试卷是逐页图片
            或 PDF，页码在阅读器内部，外面只能通过 `requestedPage` 告诉它，
            这条链路当时**根本没接**，所以点 1 2 3 4 5 一直毫无反应。

            现在：统一走 `jumpToPage(n)`（1 基），并带上自增的 `jumpNonce`
            —— 否则连续点同一个页码时 requestedPage 没变、effect 不重跑，
            看起来还是"坏了"。
          */}
          <div className={`max-w-3xl mx-auto flex items-center gap-1.5 overflow-x-auto pb-1 ${activeImages ? '' : 'mt-3'}`}>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => {
              const active = n === viewerPage;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => jumpToPage(n)}
                  aria-label={`跳到第 ${n} 页`}
                  aria-current={active ? 'page' : undefined}
                  className={`shrink-0 w-10 h-14 rounded-lg border-2 flex flex-col items-center justify-center text-xs font-medium transition-all ${
                    active
                      ? 'border-hairline/[0.45] bg-elevate/[0.16] text-strong'
                      : 'border-hairline/[0.12] bg-elevate/[0.06] text-gray-500 hover:border-hairline/[0.28] hover:text-strong'
                  }`}
                >
                  <FileText className="w-3 h-3 mb-0.5" />
                  <span className="text-xs tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* AI 学习助手（2026-10-25）：右下角悬浮按钮，仅逐页图片卷出现。
          手机上抬高一截，避开底部的页码缩略图那一条。 */}
      {aiAvailable && !aiOpen && (
        <button
          onClick={() => setAiOpen(true)}
          className="ai-btn fixed bottom-24 right-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-solid px-4 py-2.5 text-[13px] font-medium text-on-solid shadow-lg transition-transform duration-200 hover:scale-105 active:scale-95 md:bottom-6"
          title="不会的题？问 AI"
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          问 AI
        </button>
      )}

      {aiAvailable && aiOpen && (
        <Suspense fallback={null}>
        <AiPanel
          paperId={paperId}
          title={paper.title ?? paper.courseName}
          page={viewerPage}
          prefill={aiPrefill}
          which={showAnswer && answerImages?.kind === 'images' ? 'answer' : 'paper'}
          solutionPage={paper.solutionPage ?? null}
          onClose={() => setAiOpen(false)}
          onJumpSolution={jumpToPage}
        />
        </Suspense>
      )}

    </div>
  );
}
