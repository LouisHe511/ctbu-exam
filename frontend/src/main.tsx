import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installPromiseWithResolvers } from './lib/pdfPolyfill';
import { ErrorBoundary, autoReloadOnce } from './components/ErrorBoundary';
import { ThemeProvider } from './context/ThemeContext';

// 必须早于任何 PDF 阅读：pdfjs-dist 4.8 直接依赖这个 ES2024 方法。
// 旧版 Safari / Chrome 没有它 → 阅读器整页报「PDF 暂时无法显示」。
// 详见 lib/pdfPolyfill.ts 的说明（worker 侧补丁在 lib/pdf-worker-entry.ts）。
installPromiseWithResolvers();

/**
 * chunk 加载失败 → 自动刷新一次。
 *
 * Vite 5 在动态 import 拿不到目标文件时会派发 `vite:preloadError`。
 * 这是「部署后旧 HTML 指向已删除的哈希文件」最可靠的信号：
 * 比等 React.lazy 抛错更早，而且**事件回调里的错误不会被 ErrorBoundary 接住**，
 * 所以必须在这里单独处理。
 */
window.addEventListener('vite:preloadError', (event) => {
  // 阻止 Vite 默认的"抛出到控制台"，我们自己决定怎么恢复
  event.preventDefault();
  autoReloadOnce();
});

/**
 * 移除 index.html 里那份「静态备案号副本」（2026-10-23）。
 *
 * 那份是为了让**网页源码**里能直接搜到备案号（管局审核会看源码），
 * 而本站是 SPA，页脚是 React 渲染的、源码里没有。
 * React 一挂载就把副本删掉，页面上只剩页脚那一份，不会重复。
 *
 * 如果 JS 挂了，副本不会被删 —— 那时它就是唯一的备案号，正好兜底。
 */
function dropStaticIcp() {
  const el = document.getElementById('static-icp');
  if (el) el.remove();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 根边界：兜住 provider 层（AuthProvider 等）初始化时的意外错误，
        否则整个应用会静默白屏/黑屏 */}
    <ErrorBoundary resetKey="root">
      {/* ThemeProvider 放最外层：错误边界里那个"回首页"按钮也要能跟随主题 */}
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
);

// React 已经从 #root 开始接管，把 HTML 里那份静态副本撤掉（避免两份备案号）
dropStaticIcp();
