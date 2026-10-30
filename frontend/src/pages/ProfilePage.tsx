import { ConfirmModal } from '@/components/ConfirmModal';
import { ContributeModal } from '@/components/ContributeModal';
import { useState, useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { useAuth, type DeviceInfo } from '@/context/AuthContext';
import { usePapers } from '@/context/PapersContext';
import { api, ApiError } from '@/lib/api';
import { formatLastSeen } from '@/lib/device';
import { MembershipPage } from '@/pages/MembershipPage';
import {
  User, FileText, Bookmark, Clock, Monitor, Smartphone,
  LogOut, ChevronRight, Eye,
  Shield, BookOpen, Loader2, Mail, Calendar, KeyRound, Crown,
  Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Tab = 'profile' | 'member' | 'favorites' | 'recent';

export function ProfilePage() {
  const { favorites, recentViews, navigate, toggleFavorite, isFavorite } = useApp();
  const { session, profile, signOut, isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  // 2026-10-20：个人页右上角「我要投稿」
  const [contributeOpen, setContributeOpen] = useState(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!session) {
      navigate({ name: 'login' });
    }
  }, [session, navigate]);

  if (!session) {
    return (
      <div className="pt-[73px] min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gray-700 animate-spin" />
      </div>
    );
  }

  // 手机号登录的账号 email 为 null（2026-10-21）：显示手机号，别让个人页顶着一片空白
  const userPhone = session.user?.phone || '';
  const displayName =
    profile?.display_name || session.user?.email?.split('@')[0] || (userPhone ? '手机用户' : '用户');
  const userEmail = session.user?.email || '';
  const joinDate = profile?.created_at ? profile.created_at.slice(0, 10) : '';

  const tabs: { id: Tab; label: string; icon: LucideIcon; count?: number }[] = [
    { id: 'profile', label: '个人资料', icon: User },
    { id: 'member', label: '会员', icon: Crown },
    { id: 'favorites', label: '我的收藏', icon: Bookmark, count: favorites.length },
    { id: 'recent', label: '最近浏览', icon: Clock, count: recentViews.length },
  ];

  return (
    <div className="pb-20 pt-[73px] md:pb-0 min-h-screen bg-page">
      {/* ═══ 个人中心头部 ═══
          2026-10-21：原来是一块彩色渐变（`bg-gradient-to-br`）+ 白字，
          批量替换把它误改成纯白底 → 白字白底，整块看不见。
          现在按全站语言重做：深色 + 冷光 + 左对齐，头像用边框而不是彩色块。 */}
      <div className="relative overflow-hidden border-b border-hairline/[0.06]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 left-1/4 h-[340px] w-[640px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(120,142,158,0.12),transparent_70%)] blur-3xl"
        />
        {/* 2026-10-20 用户要求：个人页面右上角「我要投稿」 */}
        <button
          onClick={() => setContributeOpen(true)}
          className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-lg border border-hairline/[0.12] bg-elevate/[0.04] px-3 py-1.5 text-[12px] font-medium text-gray-600 transition-colors hover:border-hairline/[0.2] hover:text-gray-900"
        >
          <Upload className="h-4 w-4" />
          我要投稿
        </button>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-hairline/[0.14] bg-elevate/[0.06] text-[20px] font-medium text-gray-800 sm:h-16 sm:w-16">
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[24px] font-medium tracking-[-0.025em] text-gray-900">{displayName}</h1>
                {isAdmin && (
                  <span className="inline-flex items-center gap-1 rounded border border-amber-400/25 bg-amber-400/[0.10] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-amber-600">
                    <Shield className="w-3 h-3" />
                    管理员
                  </span>
                )}
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[12px] text-gray-500">
                {userEmail ? (
                  <>
                    <Mail className="w-3.5 h-3.5" />
                    {userEmail}
                  </>
                ) : (
                  <>
                    <Smartphone className="w-3.5 h-3.5" />
                    {userPhone ? userPhone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '未绑定'}
                  </>
                )}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] text-gray-500">
                {profile?.school && (
                  <span className="flex items-center gap-1">
                    <BookOpen className="w-3.5 h-3.5" />
                    {profile.school}
                  </span>
                )}
                {profile?.college && <span>{profile.college}</span>}
                {profile?.student_id && <span className="font-mono">{profile.student_id}</span>}
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-2 gap-3 mt-6">
            <div className="rounded-xl border border-hairline/[0.08] bg-ink-850 p-4">
              <p className="font-mono text-[22px] font-medium leading-none text-gray-900 tabular-nums">{favorites.length}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">收藏真题</p>
            </div>
            <div className="rounded-xl border border-hairline/[0.08] bg-ink-850 p-4">
              <p className="font-mono text-[22px] font-medium leading-none text-gray-900 tabular-nums">{recentViews.length}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">浏览记录</p>
            </div>
          </div>
        </div>
      </div>

      {/* 我要投稿弹窗（2026-10-20） */}
      {contributeOpen && <ContributeModal onClose={() => setContributeOpen(false)} />}

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Tab navigation */}
        <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  /*
                   * 2026-10-28 用户改回来了：**「会员」就是本页的一个 tab，不跳走。**
                   *
                   * 10-27 那版是直接 `navigate('membership')`，理由是"少点一步"。
                   * 用户原话：「在个人主页界面点击会员后直接会跳转到另一个界面，
                   * 我本意不是这样，而是把这个会员的界面直接移植到上面」。
                   * 也就是说他要的是"在个人页里就地看到会员档位"，而不是被弹到另一个页面；
                   * 顶部功能栏（导航）该跳别的页面还是照常跳。
                   *
                   * 实现上没有再写一份会员 UI，而是复用 `<MembershipPage embedded />`，
                   * 见 MembershipPage 顶部的注释（两套 UI 必然分叉）。
                   */
                  setActiveTab(tab.id);
                }}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-ink-850 text-gray-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                    activeTab === tab.id ? 'bg-elevate/[0.06] text-gray-700' : 'bg-elevate/[0.07] text-gray-500'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div key={activeTab} className="animate-fade-in-up">
          {activeTab === 'profile' && <ProfileTab profile={profile} joinDate={joinDate} userEmail={userEmail} userPhone={userPhone} onSignOut={signOut} navigate={navigate} isAdmin={isAdmin} />}
          {/* 会员：整块复用会员页（embedded 关掉它的顶栏留白 / 返回首页 / 最大宽度） */}
          {activeTab === 'member' && <MembershipPage embedded />}
          {activeTab === 'favorites' && (
            <FavoritesTab
              favorites={favorites}
              isFavorite={isFavorite}
              toggleFavorite={toggleFavorite}
              navigate={navigate}
            />
          )}
          {activeTab === 'recent' && (
            <RecentTab recentViews={recentViews} navigate={navigate} />
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileTab({
  profile, joinDate, userEmail, userPhone, onSignOut, navigate, isAdmin,
}: {
  // 这几列在手机号注册的账号上是 NULL，类型跟着数据库说实话（2026-10-21）
  profile: {
    display_name: string | null;
    student_id: string | null;
    school: string | null;
    college: string | null;
  } | null;
  joinDate: string;
  userEmail: string;
  userPhone: string;
  onSignOut: () => void;
  navigate: (p: { name: 'admin' }) => void;
  isAdmin: boolean;
}) {
  const { updateProfile } = useAuth();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [studentId, setStudentId] = useState(profile?.student_id || '');
  const [school, setSchool] = useState(profile?.school || '重庆工商大学');
  const [college, setCollege] = useState(profile?.college || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 2026-10-20：退出登录前先确认
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const { error } = await updateProfile({ display_name: displayName, student_id: studentId, school, college });
    if (error) setSaveError(error);
    else setEditing(false);
    setSaving(false);
  };

  const fields = [
    userEmail
      ? { label: '邮箱', value: userEmail, icon: Mail }
      : { label: '手机号', value: userPhone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') || '未绑定', icon: Smartphone },
    { label: '学号', value: profile?.student_id || '未填写', icon: User },
    { label: '学校', value: profile?.school || '重庆工商大学', icon: BookOpen },
    { label: '学院', value: profile?.college || '未填写', icon: BookOpen },
    { label: '注册时间', value: joinDate || '未知', icon: Calendar },
  ];

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5 sm:p-6 space-y-4">
          <h3 className="text-base font-semibold text-gray-900">编辑个人资料</h3>
          {saveError && (
            <div className="bg-red-500/10 text-red-700 text-sm rounded-xl p-3">{saveError}</div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">昵称</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-4 py-3 text-sm bg-page rounded-xl border border-gray-200 focus:border-hairline/[0.2] focus:bg-ink-850 focus:ring-1 focus:ring-hairline/[0.08] outline-none transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">学号</label>
            <input
              type="text"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="w-full px-4 py-3 text-sm bg-page rounded-xl border border-gray-200 focus:border-hairline/[0.2] focus:bg-ink-850 focus:ring-1 focus:ring-hairline/[0.08] outline-none transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">学校</label>
            <input
              type="text"
              value={school}
              onChange={(e) => setSchool(e.target.value)}
              className="w-full px-4 py-3 text-sm bg-page rounded-xl border border-gray-200 focus:border-hairline/[0.2] focus:bg-ink-850 focus:ring-1 focus:ring-hairline/[0.08] outline-none transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">学院</label>
            <input
              type="text"
              value={college}
              onChange={(e) => setCollege(e.target.value)}
              className="w-full px-4 py-3 text-sm bg-page rounded-xl border border-gray-200 focus:border-hairline/[0.2] focus:bg-ink-850 focus:ring-1 focus:ring-hairline/[0.08] outline-none transition-all"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 bg-solid text-on-solid rounded-xl text-sm font-medium hover:bg-solid-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              保存
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 py-2.5 bg-elevate/[0.04] text-gray-600 rounded-xl text-sm font-medium hover:bg-solid-hover/[0.07] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">基本信息</h3>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-gray-700 hover:text-gray-700 font-medium"
            >
              编辑
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.label} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                  <div className="w-9 h-9 rounded-lg bg-page flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-gray-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-gray-500">{f.label}</p>
                    <p className="text-sm font-medium text-gray-900 truncate">{f.value}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ChangePasswordCard />

      <DevicesCard />

      <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5 sm:p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">账号操作</h3>
        <div className="space-y-1">
          {isAdmin && (
            <button
              onClick={() => navigate({ name: 'admin' })}
              className="flex items-center justify-between w-full px-3 py-3 rounded-lg text-sm font-medium text-gray-700 hover:bg-solid-hover/[0.06] transition-colors"
            >
              <span className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                管理后台
              </span>
              <ChevronRight className="w-4 h-4 text-gray-500" />
            </button>
          )}
          <button
            onClick={() => setConfirmSignOut(true)}
            className="flex items-center justify-between w-full px-3 py-3 rounded-lg text-sm font-medium text-red-600 hover:bg-red-500/10 transition-colors"
          >
            <span className="flex items-center gap-2">
              <LogOut className="w-4 h-4" />
              退出登录
            </span>
            <ChevronRight className="w-4 h-4 text-gray-500" />
          </button>
        </div>
      </div>

      {/* 退出登录确认（2026-10-20） */}
      <ConfirmModal
        open={confirmSignOut}
        title="确定要退出登录吗？"
        description="退出后需要重新输入邮箱和密码才能查看真题。你的收藏、浏览记录与会员状态都会保留。"
        confirmText="退出登录"
        tone="danger"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => { setConfirmSignOut(false); onSignOut(); }}
      />
    </div>
  );
}

function FavoritesTab({
  favorites, toggleFavorite, navigate,
}: {
  favorites: { paperId: string; addedAt: string }[];
  /** 收藏状态由列表自己从 favorites 里判断即可，这个回调目前不用（保留签名以免改动调用方） */
  isFavorite?: (id: string) => boolean;
  toggleFavorite: (id: string) => void;
  navigate: (p: { name: 'reader'; paperId: string }) => void;
}) {
  const { papers } = usePapers();
  const getPaperById = (id: string) => papers.find((p) => p.id === id);

  if (favorites.length === 0) {
    return <EmptyTab icon={Bookmark} text="还没有收藏任何真题" hint="在真题库中点击书签图标即可收藏" />;
  }

  const sorted = [...favorites].sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  return (
    <div className="space-y-3">
      {sorted.map((fav) => {
        const paper = getPaperById(fav.paperId);
        if (!paper) return null;
        const dateOnly = fav.addedAt.slice(0, 10);
        return (
          <div
            key={fav.paperId}
            onClick={() => navigate({ name: 'reader', paperId: fav.paperId })}
            className="bg-ink-850 rounded-xl border border-gray-100 p-4 flex items-center gap-3 hover:border-gray-200 hover:shadow-sm transition-all cursor-pointer group"
          >
            <div className="w-10 h-12 rounded-lg bg-elevate/[0.03] border border-hairline/[0.08] flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-gray-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-gray-900 group-hover:text-gray-700 transition-colors truncate">
                {paper.courseName}
              </h4>
              <p className="text-xs text-gray-500 mt-0.5">
                {[paper.year ? `${paper.year}年` : null, paper.semester, paper.examType]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">收藏于 {dateOnly}</p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(fav.paperId);
              }}
              className="p-1.5 rounded-lg hover:bg-solid-hover/[0.04] transition-colors shrink-0"
            >
              <Bookmark className="w-4 h-4 fill-accent text-gray-700" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RecentTab({
  recentViews, navigate,
}: {
  recentViews: { paperId: string; viewedAt: string }[];
  navigate: (p: { name: 'reader'; paperId: string }) => void;
}) {
  const { papers } = usePapers();
  const getPaperById = (id: string) => papers.find((p) => p.id === id);

  if (recentViews.length === 0) {
    return <EmptyTab icon={Clock} text="还没有浏览记录" hint="前往真题库浏览" />;
  }

  return (
    <div className="space-y-3">
      {recentViews.map((view, idx) => {
        const paper = getPaperById(view.paperId);
        if (!paper) return null;
        const dateStr = typeof view.viewedAt === 'string' && view.viewedAt.length >= 16
          ? view.viewedAt.slice(0, 16).replace('T', ' ')
          : view.viewedAt;
        return (
          <div
            key={`${view.paperId}-${idx}`}
            onClick={() => navigate({ name: 'reader', paperId: view.paperId })}
            className="bg-ink-850 rounded-xl border border-gray-100 p-4 flex items-center gap-3 hover:border-gray-200 hover:shadow-sm transition-all cursor-pointer group"
          >
            <div className="w-10 h-12 rounded-lg bg-elevate/[0.03] border border-hairline/[0.08] flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-gray-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-gray-900 group-hover:text-gray-700 transition-colors truncate">
                {paper.courseName}
              </h4>
              <p className="text-xs text-gray-500 mt-0.5">
                {[paper.year ? `${paper.year}年` : null, paper.semester, paper.examType]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-gray-500 flex items-center gap-0.5">
                <Eye className="w-3 h-3" />
                {dateStr}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyTab({ icon: Icon, text, hint }: { icon: LucideIcon; text: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 rounded-full bg-elevate/[0.04] flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-gray-300" />
      </div>
      <p className="text-gray-500 text-sm mb-1">{text}</p>
      <p className="text-gray-500 text-xs">{hint}</p>
    </div>
  );
}

/**
 * 我的设备（2026-10-17 · 登录设备限制）
 *
 * 一个账号最多 2 台设备同时在线，用来防「把账号借给同学」。
 * 判定依据是 device_id（不是 IP —— 校园网 NAT 下几十人共用一个出口 IP，
 * 按 IP 限会误伤同宿舍的人，反而发现不了同 WiFi 借号）。
 *
 * 这里是用户自救的唯一入口：换手机、旧手机丢了，都靠它腾名额。
 */
function DevicesCard() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [maxDevices, setMaxDevices] = useState(2);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    try {
      const r = await api<{ devices: DeviceInfo[]; max_devices: number }>('/api/auth/devices');
      setDevices(r.devices ?? []);
      setMaxDevices(r.max_devices ?? 2);
    } catch {
      /* 读不到就空着，不打扰用户 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 2026-10-20：点「退出」先弹确认，确认后才真正吊销
  const [pending, setPending] = useState<DeviceInfo | null>(null);

  const revoke = async (d: DeviceInfo) => {
    if (busy) return;
    setBusy(d.device_id);
    setMsg(null);
    try {
      await api('/api/auth/devices/revoke', {
        method: 'POST',
        body: { device_id: d.device_id },
      });
      setMsg({ kind: 'ok', text: `已退出「${d.device_name || '该设备'}」，名额已释放` });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : '操作失败，请稍后重试' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Monitor className="w-4 h-4 text-gray-500" />
          我的设备
        </h3>
        {!loading && (
          <span className="text-xs text-gray-500">
            {devices.length} / {maxDevices} 台
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        一个账号最多 {maxDevices} 台设备同时登录。换设备时，在这里退出旧设备即可腾出名额。
      </p>

      {loading ? (
        <div className="py-4 flex justify-center">
          <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
        </div>
      ) : devices.length === 0 ? (
        <p className="text-sm text-gray-500 py-2">还没有登记的设备（重新登录后会出现在这里）</p>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li
              key={d.device_id}
              className="flex items-center justify-between gap-3 px-3 py-3 rounded-lg bg-page"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {/iPhone|iPad|iOS|Android/i.test(d.device_name || '') ? (
                  <Smartphone className="w-4 h-4 text-gray-500 shrink-0" />
                ) : (
                  <Monitor className="w-4 h-4 text-gray-500 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {d.device_name || '未知设备'}
                    {d.current && (
                      <span className="ml-2 text-[11px] font-normal text-gray-700 bg-elevate/[0.06] px-1.5 py-0.5 rounded">
                        本机
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    最后活跃 {formatLastSeen(d.last_seen_at) || '—'}
                    {d.last_ip ? ` · ${d.last_ip}` : ''}
                  </p>
                </div>
              </div>
              {!d.current && (
                <button
                  onClick={() => setPending(d)}
                  disabled={busy === d.device_id}
                  className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 px-2 py-1"
                >
                  {busy === d.device_id ? '退出中…' : '退出'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.kind === 'ok' ? 'text-gray-700' : 'text-red-600'}`}>
          {msg.text}
        </p>
      )}

      {/* 删除已登录设备确认（2026-10-20） */}
      <ConfirmModal
        open={!!pending}
        title={`确定要退出「${pending?.device_name || '该设备'}」吗？`}
        description={
          <>
            退出后，该设备需重新登录方可查阅文档。
            {pending?.current && (
              <span className="mt-1.5 block text-amber-700">
                该设备为您当前正在使用的设备，退出后将立即返回登录页。
              </span>
            )}
          </>
        }
        confirmText="确定退出"
        tone="danger"
        busy={!!busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const d = pending;
          setPending(null);
          if (d) void revoke(d);
        }}
      />
    </div>
  );
}

/**
 * 登录密码（设置 / 修改）
 * ---------------------------------------------------------------
 * 2026-10-21 用户反馈：「手机号注册的用户没办法再输密码了」。
 * 根因：手机号注册时服务端塞的是一个**随机密码**，用户不知道 → 永远只能用验证码登录。
 * 这里补上"设置密码"的入口；登录页那边也加了「手机号 + 密码」的选项。
 *
 * 卡片标题会变：从没设过 → 「设置登录密码」，设过 → 「修改密码」。
 * 判据是 session.user.password_set（服务端按 raw_user_meta_data 下的标记算），
 * **不是** password_hash 存不存在 —— 手机号账号的 password_hash 一直是有值的。
 */
function ChangePasswordCard() {
  const { session, updatePassword } = useAuth();
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  /** 当前密码：已设过密码的账号改密必须验一下（2026-10-28 服务端强制） */
  const [curPwd, setCurPwd] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 刚设完密码时本地先当"已设置"，不用等刷新页面 */
  const [justSet, setJustSet] = useState(false);
  const hasPassword = Boolean(session?.user?.password_set) || justSet;

  const submit = async () => {
    setMsg(null);
    if (pwd.length < 8) {
      setMsg({ kind: 'err', text: '新密码至少 8 位（建议字母 + 数字）' });
      return;
    }
    if (pwd !== pwd2) {
      setMsg({ kind: 'err', text: '两次输入的密码不一致' });
      return;
    }
    if (hasPassword && !curPwd) {
      setMsg({ kind: 'err', text: '请先输入当前密码' });
      return;
    }
    setBusy(true);
    const { error } = await updatePassword(pwd, curPwd);
    setBusy(false);
    if (error) {
      setMsg({ kind: 'err', text: error });
    } else {
      setMsg({
        kind: 'ok',
        text: hasPassword
          ? '密码已修改，下次登录请用新密码'
          : '密码已设置。以后登录页选「手机号 → 密码登录」就能用这个密码进来。',
      });
      setJustSet(true);
      setPwd('');
      setPwd2('');
      setCurPwd('');
      setOpen(false);
    }
  };

  return (
    <div className="bg-ink-850 rounded-2xl border border-gray-100 p-5 sm:p-6 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-gray-500" />
          {hasPassword ? '修改密码' : '设置登录密码'}
        </h3>
        <button
          onClick={() => { setOpen((v) => !v); setMsg(null); }}
          className="text-sm text-gray-700 hover:text-gray-700 font-medium"
        >
          {open ? '收起' : hasPassword ? '修改' : '设置'}
        </button>
      </div>

      {!hasPassword && !open && (
        <p className="mt-2 text-[13px] leading-relaxed text-gray-500">
          当前账号通过短信验证码完成登录。设置密码后，即可在登录页使用
          <span className="text-gray-800">「手机号 + 密码」</span>方式登录，无需每次等待验证码。
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3">
          {hasPassword && (
            <input
              type="password"
              value={curPwd}
              onChange={(e) => setCurPwd(e.target.value)}
              placeholder="当前密码"
              autoComplete="current-password"
              aria-label="当前密码"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hairline/[0.08]"
            />
          )}
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="新密码（至少 8 位）"
            autoComplete="new-password"
            aria-label="新密码"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hairline/[0.08]"
          />
          <input
            type="password"
            value={pwd2}
            onChange={(e) => setPwd2(e.target.value)}
            placeholder="再输一次新密码"
            autoComplete="new-password"
            aria-label="确认新密码"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hairline/[0.08]"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-solid text-on-solid text-sm font-medium hover:bg-solid-hover transition-colors disabled:opacity-50"
          >
            {busy ? '提交中…' : hasPassword ? '确认修改' : '设置密码'}
          </button>
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-sm ${msg.kind === 'ok' ? 'text-gray-700' : 'text-red-600'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/*
 * 原来的 `MemberTab`（会员状态卡 + 「查看 / 续费会员」按钮）已删除（2026-10-28）。
 *
 * 它存在的意义是"有个入口指向会员页"，而现在整个会员界面就长在 tab 里，
 * 再留一张状态卡 + 一个按钮就是同一件事说两遍。
 * 保留会让页面出现两个"当前身份"（一个在 tab 内容里，一个在会员页里），
 * 迟早显示得不一致 —— 这也是用户这次报的图标颜色 bug 的同一类问题。
 */
