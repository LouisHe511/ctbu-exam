import { Gift, MessageCircle, Upload, X } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import { APPEAL_QQ } from '@/lib/policy';

/**
 * 「我要投稿」弹窗（2026-10-20）
 *
 * 用户要求：暂未开放自助投稿，引导通过负责人 QQ 联系，并写明"采纳后给予奖励"。
 *
 * 为什么不直接做上传表单：
 *   自助投稿要先解决"是不是真题 / 有没有答案 / 版权是否允许"三件事，
 *   没有人工审核环节会把错卷、重复卷塞进库里（历史上已经吃过一次亏）。
 *   先在 QQ 上过一遍，成本低、可控。
 */
export function ContributeModal({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell
      open
      onClose={onClose}
      labelledBy="contribute-title"
      closeOnBackdrop={false}
      panelClassName="w-full max-w-md rounded-2xl bg-ink-850 shadow-2xl"
    >
        <div className="flex items-start gap-3 border-b border-gray-100 p-5">
          <Upload className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 id="contribute-title" className="text-base font-semibold text-gray-900">我要投稿</h3>
            <p className="mt-1 text-xs text-gray-500">暂时通过人工方式收集，确保每份资料都准确</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5 text-sm text-gray-900">
          <p className="rounded-lg bg-amber-400/10 px-3 py-2.5 text-sm text-amber-600">
            暂未开放自助投稿方式，请通过网站负责人投稿。
          </p>

          <div className="rounded-xl border border-hairline/[0.08] p-3.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <MessageCircle className="h-4 w-4 text-accent" />
              投稿联系方式
            </p>
            <p className="mt-1.5 text-sm text-gray-500">
              负责人 QQ：
              <strong className="select-all text-base text-gray-900">{APPEAL_QQ}</strong>
            </p>
            <p className="mt-1 text-xs text-gray-500">工作时间 9:00–23:00</p>
          </div>

          <div className="rounded-xl bg-accent-wash p-3.5 text-sm text-accent-deep">
            <p className="flex items-center gap-1.5 font-medium">
              <Gift className="h-4 w-4" />
              采纳后有奖励
            </p>
            <p className="mt-1 text-accent-deep/85">
              经核实确认可用（真实真题、含答案更佳）并通过审核后，会给予相应奖励。
              重复或无法核实的资料不计。
            </p>
          </div>

          <p className="text-xs text-gray-500 leading-relaxed">
            投稿时请尽量说明：课程名称、学年学期、是否含答案、来源（例如哪位老师、哪个校区）。
            如果是拍照件，请保证页面完整、字迹清晰。
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
    </ModalShell>
  );
}
