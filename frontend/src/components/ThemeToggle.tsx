import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

/**
 * 主题切换按钮。
 *
 * 两种用法：
 *   · 默认（header）：放进顶部功能栏，与收藏/分享/用户图标同高
 *   · floating：给没有 Header 的页面（登录/注册/找回密码）用，
 *     固定压在右上角，保证"任何页面都能切"
 *
 * 交互纪律：
 *   · 图标 = **当前主题的反面**（深色时显示太阳 = 点了会变亮），
 *     这是主流做法，别反过来 —— 反过来用户要想一秒
 *   · 只用图标不用文字：中英文都省，窄屏也放得下
 *   · aria-label 说清动作，不描述图标
 */
export function ThemeToggle({
  className = '',
  floating = false,
}: {
  className?: string;
  floating?: boolean;
}) {
  const { theme, source, toggle } = useTheme();
  const isDark = theme === 'dark';
  const Icon = isDark ? Sun : Moon;

  /*
   * title 里说明"现在是自动还是你手动选的"（2026-10-22）。
   * 不写明的话，用户白天点成深色、晚上回来发现变浅了会以为坏了 ——
   * 其实那是"手动选择只管到下一个时间界"的预期行为。
   */
  const label = isDark ? '切换到浅色模式' : '切换到深色模式';
  const hint = source === 'auto' ? '（当前按时间段自动）' : '（当前为你手动选择，切换时间段后恢复自动）';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label + hint}
      className={
        floating
          ? `fixed right-4 top-4 z-50 inline-flex h-10 w-10 items-center justify-center rounded-full border border-hairline/[0.12] bg-panel/80 text-gray-700 backdrop-blur-xl transition-colors hover:text-gray-900 ${className}`
          : `inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-elevate/[0.06] hover:text-gray-900 ${className}`
      }
    >
      <Icon className="h-[17px] w-[17px]" aria-hidden="true" />
    </button>
  );
}
