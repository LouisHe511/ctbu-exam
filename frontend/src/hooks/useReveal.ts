import { useEffect, useRef, useState } from 'react';

/**
 * 滚动入场：元素进入视口后才播放动画。
 *
 * 为什么不用 `animate-*` 直接挂上去：
 *   把入场动画写死在 class 上，页面一加载**所有**元素同时播完 ——
 *   用户在首屏看到的只有第一屏，下面几屏等他滚到时早就播完了，等于没有动效。
 *   真正的做法是 `IntersectionObserver`：滚到才播。
 *
 * 为什么带 `once`：
 *   滚过去又滚回来不该重播。重播会让人觉得页面在"抖动"。
 *
 * 为什么 threshold 是 0.15：
 *   元素露出 15% 就触发。等 50% 会显得迟钝（用户已经看到它了，动画才开始）。
 *
 * 用法：
 *   const { ref, shown } = useReveal();
 *   <div ref={ref} className={shown ? 'animate-focus-in' : 'opacity-0'}>
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(options?: {
  /** 露出多少比例触发，默认 0.15 */
  threshold?: number;
  /** 只播一次，默认 true */
  once?: boolean;
}) {
  const { threshold = 0.15, once = true } = options ?? {};
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 老浏览器 / 无 IO 环境兜底：直接显示，别让内容永远藏着
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            if (once) io.unobserve(e.target);
          } else if (!once) {
            setShown(false);
          }
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold, once]);

  return { ref, shown };
}

/**
 * 给列表做错峰入场：返回内联 animationDelay，第 n 个元素晚 n*60ms 出现。
 * 60ms 是实测比较舒服的间隔：再小看不出参差，再大最后几个要等太久。
 */
export function staggerDelay(index: number, stepMs = 60): React.CSSProperties {
  return { animationDelay: `${index * stepMs}ms` };
}
