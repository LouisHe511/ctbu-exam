import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { api } from '@/lib/api';
import type { Profile } from '@/types';
import { usePapers } from '@/context/PapersContext';
import { UploadPaperForm } from '@/components/UploadPaperForm';
import { AdminMembership } from '@/components/AdminMembership';
import { BulkImportPapers } from '@/components/BulkImportPapers';
import { deletePaper } from '@/lib/papers';
import { confirmDialog, alertDialog } from '@/lib/dialog';
import {
  Shield, Users, FileText, Search,
  CheckCircle, XCircle, Loader2, AlertCircle, ArrowLeft, Crown,
} from 'lucide-react';
import { BarChart3 } from 'lucide-react';

type AdminTab = 'users' | 'papers' | 'membership' | 'stats';

export function AdminPage() {
  const { session, isAdmin, loading } = useAuth();
  const { navigate } = useApp();
  const { papers, refresh: refreshPapers, realPapers } = usePapers();
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<Profile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const r = await api<{ users: Profile[] }>('/api/data/admin/users');
      setUsers(r.users ?? []);
    } catch (e) {
      console.error('Failed to load users:', e instanceof Error ? e.message : e);
    }
    setUsersLoading(false);
  }, []);

  useEffect(() => {
    if (!loading && (!session || !isAdmin)) {
      navigate({ name: 'home' });
    }
  }, [session, isAdmin, loading, navigate]);

  useEffect(() => {
    // 只要是管理员就加载用户列表。
    // 原来只在「切到用户管理标签 且 列表为空」时加载，导致两个问题：
    //   ① 概览页的「注册用户」一直显示 '...'（没加载过）
    //   ② 有新用户注册后回来看也不刷新（users.length 已不为 0，条件不成立）
    // 真正的根因其实在数据库：profiles 只有 select_own_profile 策略，
    // 管理员读不到别人 → 已在 2026-10-15 补 select_admin_all_profiles。
    if (isAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  if (loading) {
    return (
      <div className="pt-[73px] min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gray-700 animate-spin" />
      </div>
    );
  }

  if (!session || !isAdmin) {
    return (
      <div className="pt-[73px] min-h-screen flex items-center justify-center px-4">
        <div className="text-center">
          <Shield className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 font-medium mb-2">无权访问</p>
          <p className="text-gray-500 text-sm mb-4">需要管理员账号登录后才能访问后台</p>
          <button
            onClick={() => navigate({ name: 'home' })}
            className="px-4 py-2 bg-solid text-on-solid rounded-lg text-sm font-medium hover:bg-solid-hover transition-colors"
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  /**
   * 用户搜索（2026-10-21 修）
   * ---------------------------------------------------------------
   * 原来的写法是 `u.display_name.toLowerCase()` / `u.student_id.toLowerCase()`。
   * **手机号注册的账号这两列是 NULL**（触发器建 profile 时只填了 id/email/邀请码），
   * 于是 `null.toLowerCase()` → TypeError → 整个后台白屏报错。
   * 用户反馈「打不开管理员页面」就是这个 —— 不是权限问题，是空值炸的。
   *
   * 现在：统一走 `String(值 ?? '')`，并把手机号也纳入搜索范围
   * （手机号账号没有邮箱，只按邮箱搜等于搜不到人）。
   */
  /**
   * 用户列表：**新的在最上面**（2026-10-23 用户第二次反馈）。
   *
   * 根因在后端：`data_admin_users` 用的是 `order by p.created_at`（升序），
   * 与订单表的 `desc` 不一致。已在 pay-service 里改成 `desc`。
   *
   * 这里**再排一次**做兜底 —— 前端不依赖后端返回顺序。
   * 用户明确要求「从上往下越来越旧」，这个约束应该在展示层也成立，
   * 否则哪天后端改了排序，界面又悄悄变回旧在前。
   */
  const filteredUsers = users
    .filter((u) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return [u.email, u.display_name, u.student_id, u.phone]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  const tabs: { id: AdminTab; label: string; icon: typeof Shield }[] = [
    { id: 'users', label: '用户管理', icon: Users },
    { id: 'papers', label: '试卷管理', icon: FileText },
    { id: 'membership', label: '会员管理', icon: Crown },
    { id: 'stats', label: '数据看板', icon: BarChart3 },
  ];

  return (
    <div className="pb-20 pt-[73px] md:pb-0 min-h-screen bg-page">
      {/* Admin header
          2026-10-21 bug：原来写 `bg-gray-900 text-white`。
          gray 色阶整体反转后 gray-900 变成了亮白 #f7f8f8，
          而 text-white 还是白 → 白底白字，整条看不见。
          改成明确的面板色 + 亮字，不再依赖任何"看起来像深色"的灰。 */}
      <div className="border-b border-hairline/[0.08] bg-ink-850">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate({ name: 'home' })}
              aria-label="返回首页"
              className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-solid-hover/[0.06] hover:text-gray-800"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-gray-500" aria-hidden="true" />
              <h1 className="text-[17px] font-medium tracking-[-0.02em] text-gray-900">管理后台</h1>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Tab navigation */}
        <div className="flex items-center gap-1 mb-6 border-b border-gray-200">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition-all border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? 'border-hairline/[0.2] text-gray-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Overview */}

        {/* Users */}
        {activeTab === 'users' && (
          <div className="space-y-4 animate-fade-in-up">
            {/* 注册总量统计条（2026-10-26 用户要求） */}
            <div className="flex flex-wrap items-center gap-2">
              {[
                { label: '注册总量', v: users.length, cls: 'text-strong' },
                { label: '今日新增', v: users.filter((u) => String(u.created_at ?? '').startsWith(new Date().toISOString().slice(0, 10))).length, cls: 'text-accent' },
              ].map((c) => (
                <div key={c.label} className="rounded-xl border border-hairline/[0.1] bg-ink-850 px-4 py-2">
                  <span className={`text-lg font-semibold ${c.cls}`}>{c.v}</span>
                  <span className="ml-1.5 text-[11px] text-muted">{c.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索邮箱、手机号、昵称、学号..."
                  className="w-full pl-10 pr-4 py-2 text-sm bg-ink-850 rounded-xl border border-gray-200 focus:border-hairline/[0.2] focus:ring-1 focus:ring-hairline/[0.08] outline-none transition-all"
                />
              </div>
              <button
                onClick={loadUsers}
                className="px-3 py-2 text-sm text-gray-600 bg-ink-850 border border-gray-200 rounded-xl hover:bg-page transition-colors"
              >
                刷新
              </button>
            </div>

            {usersLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-gray-700 animate-spin" />
              </div>
            ) : filteredUsers.length > 0 ? (
              <div className="bg-ink-850 rounded-2xl border border-gray-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-page border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-500">邮箱</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">昵称</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">学号</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">学院</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500 whitespace-nowrap">注册时间（新→旧）</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-page transition-colors">
                        {/* 手机号账号没有邮箱 —— 显示手机号，否则这一行看着像"空用户" */}
                        <td className="px-4 py-3 text-gray-900 font-medium">{u.email || u.phone || '-'}</td>
                        <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">{u.display_name || '-'}</td>
                        <td className="px-4 py-3 text-gray-600 hidden md:table-cell font-mono text-xs">{u.student_id || '-'}</td>
                        <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">{u.college || '-'}</td>
                        {/* 注册时间精确到分钟（2026-10-23）：
                            只显示日期时，同一天里"谁先谁后"根本看不出来 ——
                            而用户要的正是「从上往下越来越旧」这个可读的顺序感。
                            slice(0,16) 得到 "2026-10-23 09:07"，再补个 T 换成空格。 */}
                        <td className="px-4 py-3 text-gray-500 text-xs font-mono whitespace-nowrap">
                          {u.created_at
                            ? u.created_at.slice(0, 16).replace('T', ' ')
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-10 h-10 text-gray-300 mb-3" />
                <p className="text-gray-500 text-sm">暂无用户数据</p>
              </div>
            )}
          </div>
        )}

        {/* Papers */}
        {activeTab === 'membership' && <AdminMembership />}
        {activeTab === 'stats' && <StatsTab />}

        {activeTab === 'papers' && (
          <div className="space-y-4 animate-fade-in-up">
            {realPapers.length === 0 && (
              <div className="bg-elevate/[0.03] rounded-xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
                <p className="text-sm text-gray-500">数据库里还没有入库的试卷或复习资料。</p>
              </div>
            )}

            <BulkImportPapers />
            <UploadPaperForm />

            <div className="bg-ink-850 rounded-2xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-page border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">课程</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">年份</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">学期</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">类型</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">答案</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {papers.slice(0, 50).map((p) => (
                    <tr key={p.id} className="hover:bg-page transition-colors">
                      <td className="px-4 py-3 text-gray-900 font-medium">
                        {p.courseName}
                        {p.isReal && (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-elevate/[0.06] text-gray-700">已入库</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">{p.year ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600 hidden md:table-cell">{p.semester}</td>
                      <td className="px-4 py-3 text-gray-600">{p.examType}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {p.hasAnswer ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle className="w-3 h-3" />有</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-500"><XCircle className="w-3 h-3" />无</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {p.isReal ? (
                          <button
                            onClick={async () => {
                              const ok = await confirmDialog(
                                `确定删除《${p.courseName} ${p.year ? `${p.year}年` : ''}${p.examType}》吗？\n存储里的 PDF 文件会一并删除，此操作不可撤销。`,
                                { confirmLabel: '确定删除', danger: true },
                              );
                              if (!ok) return;
                              try {
                                await deletePaper(p);
                                await refreshPapers();
                              } catch (e) {
                                await alertDialog(
                                  `删除失败：${e instanceof Error ? e.message : '未知错误'}`,
                                );
                              }
                            }}
                            className="text-xs text-red-600 hover:text-red-700 hover:underline"
                          >
                            删除
                          </button>
                        ) : (
                          <span className="text-xs text-gray-300">演示</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {papers.length > 50 && (
              <p className="text-center text-xs text-gray-500">仅显示前 50 条，共 {papers.length} 套试卷</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════════
// 数据看板（⑧ · 2026-10-25）：GET /api/data/admin/stats
// 口径都是现成数据的重聚合（papers.view_count / ai_usage /
// profiles / reading_progress），没有新增埋点。
// ══════════════════════════════════════════════════════════
interface StatsPayload {
  top_papers?: { course_name: string; title: string; year: number | null; views: number }[];
  ai_by_course?: { course_name: string | null; asks: number; users: number }[];
  ai_daily?: { day: string; asks: number; users: number }[];
  signups_daily?: { day: string; n: number }[];
  tiers?: { membership_tier: string; n: number }[];
  today?: { readers_today: number; asks_today: number; mistakes_total: number; active_readers_week: number }[];
}

function StatsTab() {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ stats: StatsPayload }>('/api/data/admin/stats')
      .then((r) => setData(r.stats ?? {}))
      .catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-[13px] text-red-300">{err}</div>;
  if (!data) return <div className="p-8 text-center text-[13px] text-gray-500">加载中…</div>;
  const t = data.today?.[0];
  const row = 'flex items-center justify-between border-b border-hairline/[0.06] px-4 py-2.5';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: '今日打开过卷子（人）', v: t?.readers_today ?? 0 },
          { label: '今日 AI 提问（次）', v: t?.asks_today ?? 0 },
          { label: '本周在看的读者', v: t?.active_readers_week ?? 0 },
          { label: '错题本总条数', v: t?.mistakes_total ?? 0 },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-hairline/[0.1] bg-ink-850 p-4">
            <p className="text-2xl font-semibold text-strong">{c.v}</p>
            <p className="mt-1 text-[11px] text-gray-500">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <div className="min-w-0 overflow-hidden rounded-xl border border-hairline/[0.1] bg-ink-850">
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-muted">浏览 Top 20 试卷</p>
          {(data.top_papers ?? []).map((p, i) => (
            <div key={i} className={row}>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                {p.course_name} / {p.title || '—'}{p.year ? `（${p.year}）` : ''}
              </span>
              <span className="ml-3 shrink-0 text-[13px] font-semibold text-strong tabular-nums">{p.views}</span>
            </div>
          ))}
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-hairline/[0.1] bg-ink-850">
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-muted">AI 提问 · 按课程</p>
          {(data.ai_by_course ?? []).map((p, i) => (
            <div key={i} className={row}>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{p.course_name || '未知'}</span>
              <span className="ml-3 shrink-0 text-[13px] font-semibold text-strong tabular-nums">{p.asks} 次 · {p.users} 人</span>
            </div>
          ))}
          {!(data.ai_by_course ?? []).length && (
            <p className="px-4 py-3 text-[12px] text-gray-600">还没有 AI 提问记录</p>
          )}
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-hairline/[0.1] bg-ink-850">
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-muted">近 14 天 AI 提问</p>
          <div className="flex h-32 items-end gap-1.5 overflow-x-auto px-4 pb-3">
            {(data.ai_daily ?? []).map((d) => {
              const max = Math.max(...(data.ai_daily ?? []).map((x) => x.asks), 1);
              return (
                <div key={d.day} className="relative h-full w-4 shrink-0" title={`${d.day}：${d.asks} 次 / ${d.users} 人`}>
                  <div className="absolute inset-x-0 bottom-0 rounded-t bg-accent/60" style={{ height: `${Math.max((d.asks / max) * 100, 4)}%` }} />
                </div>
              );
            })}
            {!(data.ai_daily ?? []).length && <p className="text-[12px] text-gray-600">无数据</p>}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-hairline/[0.1] bg-ink-850">
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-muted">会员构成 / 注册（近 30 天）</p>
          <div className="flex flex-wrap gap-2 px-4 py-2">
            {(data.tiers ?? []).map((x) => (
              <span key={x.membership_tier} className="rounded-full bg-elevate/[0.08] px-2.5 py-1 text-[11px] text-gray-400">
                {x.membership_tier} · {x.n}
              </span>
            ))}
          </div>
          <p className="px-4 pb-3 text-[11px] text-gray-600">
            近 30 天新注册 {(data.signups_daily ?? []).reduce((a, b) => a + b.n, 0)} 人
          </p>
        </div>
      </div>
    </div>
  );
}
