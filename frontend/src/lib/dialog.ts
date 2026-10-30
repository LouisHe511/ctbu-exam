/**
 * 页面内确认/提示弹窗。
 *
 * 为什么不用 window.confirm / window.alert：
 * 浏览器（尤其 Chrome）在"阻止此页面创建更多对话框"生效时，不会报错，
 * 而是让 confirm() 直接返回 false、alert() 什么都不显示。
 * 结果是删除按钮点了"没任何反应"，用户以为按钮坏了。
 * 这里用自绘浮层代替，行为完全由我们自己掌控。
 *
 * 只用内联样式，不依赖 Tailwind 是否扫描到本文件。
 */

const OVERLAY_STYLE =
  'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
  'justify-content:center;background:rgba(17,24,39,0.55);padding:16px;';

const BOX_STYLE =
  'width:100%;max-width:380px;background:#fff;border-radius:16px;' +
  'padding:20px;box-shadow:0 24px 48px rgba(0,0,0,0.24);';

const TEXT_STYLE =
  'margin:0 0 18px;font-size:14px;line-height:1.65;color:#111827;' +
  'word-break:break-word;white-space:pre-wrap;';

const ROW_STYLE = 'display:flex;gap:8px;justify-content:flex-end;';

const BTN_BASE =
  'border:0;border-radius:10px;padding:9px 18px;font-size:14px;' +
  'font-weight:500;cursor:pointer;font-family:inherit;';

type Kind = 'confirm' | 'alert';

function makeButton(
  label: string,
  bg: string,
  color: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = `${BTN_BASE}background:${bg};color:${color};`;
  b.addEventListener('click', onClick);
  return b;
}

function showDialog(
  message: string,
  kind: Kind,
  confirmLabel: string,
  danger = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = OVERLAY_STYLE;

    const box = document.createElement('div');
    box.style.cssText = BOX_STYLE;

    const text = document.createElement('p');
    text.textContent = message; // textContent：不解析 HTML，避免注入
    text.style.cssText = TEXT_STYLE;

    const row = document.createElement('div');
    row.style.cssText = ROW_STYLE;

    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(kind === 'alert'); // 提示框按 Esc 视为已读；确认框视为取消
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };

    if (kind === 'confirm') {
      row.appendChild(makeButton('取消', '#f3f4f6', '#374151', () => finish(false)));
      row.appendChild(
        makeButton(confirmLabel, danger ? '#dc2626' : '#0f766e', '#ffffff', () => finish(true)),
      );
    } else {
      row.appendChild(makeButton('知道了', '#0f766e', '#ffffff', () => finish(true)));
    }

    // 点遮罩空白处：确认框等同于取消（避免误删），提示框等同于已读
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(kind === 'alert');
    });
    document.addEventListener('keydown', onKey, true);

    box.appendChild(text);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const primary = row.querySelector('button:last-child') as HTMLButtonElement | null;
    if (primary) primary.focus();
  });
}

/** 页内确认框。返回 true 表示用户点了确认按钮。 */
export function confirmDialog(
  message: string,
  options?: { confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  return showDialog(message, 'confirm', options?.confirmLabel ?? '确定', options?.danger ?? false);
}

/** 页内提示框（替代 window.alert）。 */
export async function alertDialog(message: string): Promise<void> {
  await showDialog(message, 'alert', '知道了');
}
