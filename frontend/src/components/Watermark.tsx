interface WatermarkProps {
  text: string;
  className?: string;
}

export function Watermark({ text, className = '' }: WatermarkProps) {
  const pattern = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 2 }, (_, j) => (
      <span
        key={`${i}-${j}`}
        /*
         * ⚠️ 颜色写死，不跟主题（2026-10-22）：
         *   水印永远压在**扫描件的白纸**上，而纸张在两种主题下都是白的。
         *   原来用 `text-gray-200`，浅色模式下 gray-200 变成 #e7e7e4 ——
         *   白纸上等于没有水印，防盗链的意义直接丢了。
         *   这里固定成深灰 + 低透明度：深色页面上看不出来，白纸上有痕迹。
         */
        className="absolute select-none pointer-events-none whitespace-nowrap"
        style={{
          color: '#4a4f57',
          transform: `rotate(-25deg)`,
          fontSize: '12px',
          fontWeight: 500,
          /*
           * 2026-10-21 从 0.4 降到 0.22（用户反馈"有点影响浏览"）。
           *
           * 水印单独看还可以，但它是 #232629（反转后的 gray-200 其实是深灰）
           * 压在白色 PDF 页面上：0.4 时混合出来 ≈ #a9abad，与白底 2.30:1，
           * 和试卷正文（黑色小四号）抢视线，读起来累。
           *
           * 0.22 时混合色 ≈ #cecfcf，对比 1.56:1 ——
           * 近看仍能辨认是谁的水印（防盗链目的保留），远看几乎隐去。
           */
          opacity: 0.15,
          top: `${i * 32 + 12}%`,
          left: `${j * 50 + 8}%`,
        }}
      >
        {text}
      </span>
    ))
  );

  return (
    <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}>
      {pattern}
    </div>
  );
}
