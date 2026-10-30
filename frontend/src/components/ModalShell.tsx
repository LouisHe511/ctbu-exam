import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 弹窗基座（2026-10-28）。
 *
 * 站内原来每个弹窗各写一遍遮罩 + 卡片，于是每个都缺同样的东西：
 *   · 没有 role="dialog" / aria-modal，读屏软件不知道"这里有个弹窗"
 *   · 焦点留在背后的页面上，Tab 能一路穿到遮罩下面
 *   · Esc 关不掉（鼠标用户无所谓，键盘用户被卡住）
 *   · 关掉之后焦点掉到 <body>，再想回到原来的按钮得重新 Tab 一遍
 *
 * 这些都只影响少数人，但影响的是"完全用不了"，所以统一收进这个组件。
 * 视觉部分完全交给调用方：status 卡片长什么样还是它自己决定。
 *
 * 用法：
 *   <ModalShell open={open} onClose={close} labelledBy="dlg-title">
 *     <div className="..."> ... </div>
 *   </ModalShell>
 */
export function ModalShell({
  open,
  onClose,
  children,
  labelledBy,
  /** 卡片本身的类名（宽高、圆角、背景由调用方决定） */
  panelClassName = '',
  /** 遮罩层的 z-index，默认 100（与原有弹窗一致） */
  zIndex = 100,
  /** 点遮罩是否关闭。默认 true；表单类弹窗建议 false，避免误触丢失输入 */
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  panelClassName?: string;
  zIndex?: number;
  closeOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;

    // 锁滚动：弹窗开着时背景还能滚，手机上滑一下就把弹窗"顶走"了
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 焦点移到面板内第一个可聚焦元素（没有就聚焦面板本身）
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((el) => el.offsetParent !== null);
    (focusables()[0] ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦点陷阱：在首尾之间循环，不跑到背后的页面去
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      // 归还焦点：回到触发弹窗的那个按钮，用户不用重新找位置
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60 px-4 animate-fade-in"
      style={{ zIndex }}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`outline-none ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
