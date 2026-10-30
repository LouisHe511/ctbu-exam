import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import type { AccessStatus } from '@/types';
import { useAuth } from '@/context/AuthContext';
import { myAccessStatus, unlockPaper, type UnlockResult } from '@/lib/papers';

/** 免费额度：每位新用户可免费查看 3 份试卷（按人计数，同一份重复看不重复计） */
export const FREE_LIMIT = 3;

interface AccessState {
  status: AccessStatus | null;
  loading: boolean;
  freeLimit: number;
  refresh: () => Promise<void>;
  /**
   * 申请查看一份试卷。
   * - 演示/公开参考资料不消耗额度
   * - 私有 PDF 必须有登录态；真题 PDF 再走服务端 unlock_paper() 扣额度/校验会员
   */
  requestAccess: (paperId: string, requiresUnlock: boolean, requiresPrivateAuth: boolean) => Promise<UnlockResult | null>;
  /** 未登录时的兜底判断 */
  isMember: boolean;
  freeRemaining: number;
}

const AccessContext = createContext<AccessState | null>(null);

export function AccessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setStatus({
        logged_in: false,
        is_member: false,
        member_until: null,
        free_used: 0,
        free_remaining: FREE_LIMIT,
      });
      return;
    }
    setLoading(true);
    const s = await myAccessStatus(FREE_LIMIT);
    setStatus(s);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const requestAccess = useCallback(
    async (paperId: string, requiresUnlock: boolean, requiresPrivateAuth: boolean): Promise<UnlockResult | null> => {
      // 真正的公开演示资料无需账号。私有 PDF 即使不扣额度，也必须有已登录身份
      // 才能由 Storage RLS 签发短时查看链接。
      if (!requiresPrivateAuth && !requiresUnlock) return null;
      if (!userId) {
        return { ok: false, reason: 'not_logged_in', free_remaining: FREE_LIMIT };
      }
      if (!requiresUnlock) {
        return { ok: true, reason: 'free', free_remaining: status?.free_remaining ?? FREE_LIMIT };
      }
      const result = await unlockPaper(paperId, FREE_LIMIT);
      await refresh();
      return result;
    },
    [userId, refresh, status?.free_remaining]
  );

  return (
    <AccessContext.Provider
      value={{
        status,
        loading,
        freeLimit: FREE_LIMIT,
        refresh,
        requestAccess,
        isMember: status?.is_member ?? false,
        freeRemaining: status?.free_remaining ?? FREE_LIMIT,
      }}
    >
      {children}
    </AccessContext.Provider>
  );
}

export function useAccess() {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error('useAccess must be used within AccessProvider');
  return ctx;
}
