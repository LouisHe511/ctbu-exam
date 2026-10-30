import { AlertTriangle } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';

/**
 * 通用确认弹窗（2026-10-20）
 *
 * ⚠️ 为什么不用 `window.confirm`：Chrome 在「阻止此页面创建更多对话框」生效时，
 *    `confirm` 不报错、直接返回 false，用户看到的是"点了没反应"。
 *    （项目坑位 2 记过这个，见 AGENT-交接 §6 坑 2）
 *
 * 2026-10-28：遮罩/焦点/Esc 交给 `ModalShell`，这里只保留卡片长什么样。
 *
 * 用法：受控组件，父级持有 open 与 onConfirm/onCancel。
 */
export function ConfirmModal({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** danger=红（删设备/退出）；default=青（普通确认） */
  tone?: 'danger' | 'default';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      labelledBy="confirm-modal-title"
      panelClassName="w-full max-w-sm rounded-2xl bg-ink-850 shadow-2xl"
    >
      <div className="flex items-start gap-3 p-5">
        <AlertTriangle
          className={`mt-0.5 h-5 w-5 shrink-0 ${tone === 'danger' ? 'text-red-500' : 'text-accent'}`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 id="confirm-modal-title" className="text-base font-semibold text-gray-900">{title}</h3>
          {description && (
            <div className="mt-1.5 text-sm leading-relaxed text-gray-500">{description}</div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 p-4">
        <button
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          {cancelText}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-60 ${
            tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-deep'
          }`}
        >
          {busy ? '处理中…' : confirmText}
        </button>
      </div>
    </ModalShell>
  );
}
