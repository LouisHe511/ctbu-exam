import { useEffect, useRef, useState } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════
 * 滚动方向感知：往下滚隐藏、往上滚出现
 * ═══════════════════════════════════════════════════════════════
 * 2026-10-22：从 `Layout.tsx` 的 Header 里抽出来，因为四六级试卷页的
 * 「提交答案」吸顶条也要用同一套逻辑。
 *
 * 为什么必须共用同一份：
 *   之前吸顶条写死 `top-[64px]` —— 那是"假设导航栏永远在那儿"。
 *   但导航栏往下滚会藏起来，吸顶条却还停在 64px，
 *   结果屏幕顶部永远空着一条，风一吹就露馅（用户指出的就是这个）。
 *   两边用同一个 hook，状态天然一致：导航藏，提交条也跟着贴到 0。
 *
 * 参数与判据（和 Header 完全一致，改一处两边都变）：
 *   · 位移超过 6px 才算"换方向" —— 触摸板惯性会制造大量 ±1px 抖动
 *   · 顶部 80px 内永远显示 —— 首屏必须看得见导航
 *
 * @param offsetPx 触发隐藏前的最小滚动距离，默认 80
 * @returns hidden = 是否应该隐藏
 */
export function useScrollHide(offsetPx = 80): boolean {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastY.current;

      // 抖动阈值 6px：触摸板的惯性滚动会产生大量 ±1px 的抖动，不设阈值会疯狂闪
      if (Math.abs(delta) > 6) {
        setHidden(delta > 0 && y > offsetPx);
        lastY.current = y;
      } else if (y <= 10) {
        setHidden(false);
        lastY.current = y;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [offsetPx]);

  return hidden;
}
