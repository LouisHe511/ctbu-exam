import { useEffect, useState, useMemo } from 'react';
import { Loader2, Trash2, BookOpen, Lock, ChevronLeft } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { fetchMistakes, removeMistake, setReaderHandoff, type Mistake } from '@/lib/study';

/**
 * 错题本（2026-10-25 · 站点优化③）
 *
 * 数据：/api/data/mistakes（免费用户 10 条上限，会员不限 —— 后端拦，这里只做提示）。
 * 「去问 AI」走 sessionStorage 交接（lib/study.ts setReaderHandoff）：
 * 阅读器挂载后自动翻到对应页、把「第N题怎么做」填进 AI 输入框。
 */
export function MistakesPage() {
  const { session } = useAuth();
  const { navigate } = useApp();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Mistake[]>([]);
  const [isMember, setIsMember] = useState(false);
  const [freeLimit, setFreeLimit] = useState(10);
  const [removing, setRemoving] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetchMistakes();
      if (!alive) return;
      if (r) {
        setItems(r.mistakes);
        setIsMember(r.isMember);
        setFreeLimit(r.freeLimit);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const grouped = useMemo(() => {
    const m = new Map<string, Mistake[]>();
    for (const it of items) {
      const key = it.course_name || '其他';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return [...m.entries()];
  }, [items]);

  const del = async (id: number) => {
    setRemoving(id);
    await removeMistake(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
    setRemoving(null);
  };

  const goView = (m: Mistake) => {
    setReaderHandoff(m.paper_id, { page: m.page, question: null });
    navigate({ name: 'reader', paperId: m.paper_id });
  };

  const nearLimit = !isMember && items.length >= freeLimit - 2;

  return (
    <div className="pt-[73px] max-w-3xl mx-auto px-4 pb-16">
      <div className="flex items-center gap-3 pt-6 pb-2">
        <button
          onClick={() => navigate({ name: 'home' })}
          className="p-1.5 -ml-1.5 rounded-lg text-muted hover:bg-solid-hover/[0.08] transition-colors"
          title="返回"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-xl font-bold text-strong">错题本</h1>
        <span className="text-xs text-muted">{items.length} 条{!isMember && ` · 免费上限 ${freeLimit} 条`}</span>
      </div>
      <p className="text-[13px] text-muted pb-4">
        复习时翻这里：点「去看题」直接跳回那道题所在的页。
      </p>

      {!session && !loading && (
        <div className="rounded-xl border border-solid-hover/20 bg-page p-8 text-center">
          <p className="text-muted text-sm mb-4">登录后才能使用错题本</p>
          <button
            onClick={() => navigate({ name: 'login' })}
            className="rounded-lg bg-solid px-5 py-2 text-[13px] font-medium text-on-solid hover:bg-solid-hover transition-colors"
          >
            去登录
          </button>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      )}

      {!loading && session && items.length === 0 && (
        <div className="rounded-xl border border-solid-hover/20 bg-page p-10 text-center">
          <BookOpen className="w-8 h-8 text-muted mx-auto mb-3" />
          <p className="text-muted text-sm">还没有错题。看卷子时点顶栏的「记错题」，或问完 AI 后一键收藏这道题。</p>
        </div>
      )}

      {!loading && nearLimit && (
        <div className="mb-4 rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3 flex items-center gap-2">
          <Lock className="w-4 h-4 text-accent shrink-0" />
          <p className="text-[12px] text-muted flex-1">
            免费用户最多记 {freeLimit} 道错题{items.length >= freeLimit ? '（已满）' : ''}，会员不限量。
          </p>
          <button
            onClick={() => navigate({ name: 'membership' })}
            className="rounded-lg bg-solid px-3 py-1.5 text-[12px] font-medium text-on-solid hover:bg-solid-hover transition-colors shrink-0"
          >
            开通会员
          </button>
        </div>
      )}

      {grouped.map(([course, list]) => (
        <div key={course} className="mb-6">
          <h2 className="text-[13px] font-semibold text-muted mb-2">{course}</h2>
          <div className="space-y-2">
            {list.map((m) => (
              <div
                key={m.id}
                className="group rounded-xl border border-solid-hover/15 bg-page px-4 py-3 flex items-center gap-3 hover:border-solid-hover/30 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium text-strong truncate">
                    {m.course_name || '未知课程'} · <span className="text-accent">{m.question || '整页'}</span>
                  </p>
                  <p className="text-[12px] text-muted mt-1 truncate">
                    {m.title || '未命名试卷'}{m.year ? `（${m.year}）` : ''} · 第 {m.page} 页
                  </p>
                  <p className="text-[10.5px] text-muted mt-0.5">
                    记于 {new Date(m.created_at).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                <button
                  onClick={() => goView(m)}
                  className="rounded-lg border border-hairline/[0.14] px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-hairline/[0.3] hover:text-strong flex items-center gap-1 shrink-0"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  去看题
                </button>
                <button
                  onClick={() => del(m.id)}
                  disabled={removing === m.id}
                  className="p-2 rounded-lg text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
                  title="删除"
                >
                  {removing === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
