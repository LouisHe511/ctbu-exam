import { MonitorSmartphone, Info } from 'lucide-react';
import { APPEAL_QQ, MAX_DEVICES } from '@/lib/policy';

/**
 * 第二台设备登录提醒（2026-10-20 改写）
 *
 * 用户 2026-10-20 14:30 决定：**取消"两台设备不能同时查看"的判定与处罚**。
 * 现在规则只剩一条：一个账号最多 2 台设备登录。
 *
 * 所以这个弹窗不再是"警告"，而是**告知上限**——语气要平，
 * 别让学生以为又要被判违规了（上一版整屏都是处罚阶梯）。
 */
export function SecondDeviceNotice({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl bg-ink-850 shadow-2xl">
        <div className="flex items-start gap-3 border-b border-gray-100 p-5">
          <MonitorSmartphone className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">
              这是你的第 2 台设备
            </h3>
            <p className="mt-1 text-xs text-gray-500">
              一个账号最多 {MAX_DEVICES} 台设备登录
            </p>
          </div>
        </div>

        <div className="space-y-3 p-5 text-sm text-gray-900">
          <p>
            本服务不对同一账号的并发查阅作出限制，<strong>两台设备可同时查阅</strong>。
          </p>

          <div className="rounded-xl bg-elevate/[0.03] p-3.5 text-sm text-gray-500">
            <p className="flex items-center gap-1.5 font-medium text-gray-900">
              <Info className="h-4 w-4" />
              需要注意的两点
            </p>
            <ul className="mt-1.5 space-y-1">
              <li>· 同一账号最多 {MAX_DEVICES} 台设备处于登录状态；超出上限的登录将被拒绝。</li>
              <li>· 如需释放名额，请于「个人中心 → 我的设备」中移除一台已登录设备。</li>
            </ul>
          </div>

          <p className="text-xs text-gray-500">
            遇到问题可以联系客服 QQ：
            <strong className="select-all text-gray-900"> {APPEAL_QQ}</strong>
            （工作时间 9:00–23:00）
          </p>
        </div>

        <div className="border-t border-gray-100 p-4 text-right">
          <button
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}
