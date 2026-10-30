import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 开发用：把「四六级解析数据」按生产同款路径喂给前端。
 *
 * 为什么需要：
 *   解析数据（答案详解）是**会员专属**，绝对不能放进 `public/` ——
 *   那是静态资源，谁拿到 URL 都能下，会员限制就白设了。
 *   生产环境它由国内服务器的 `GET /api/pay/cet-explain?slug=…` 校验会员后返回
 *   （nginx 反代到 pay_service）。
 *   但本地开发没有那台服务器，页面就永远拿不到解析、没法验证「看解析」这条路。
 *
 * 为什么不走「先拷进 public」的土办法：
 *   拷贝进 public 只要有人忘了删，就会随构建上线，等于把会员内容直接公开。
 *   这个插件只在 `vite dev` 生效，构建产物里不会出现任何解析数据
 *   （数据目录 `tools/四六级解析/` 也在另一个 git 仓库里）。
 *
 * 只读；slug 用白名单正则卡死，杜绝路径穿越。
 */
function cetExplainDevMock(): Plugin {
  return {
    name: 'cet-explain-dev-mock',
    apply: 'serve',
    configureServer(server) {
      const pdfDir = path.resolve(
        fileURLToPath(new URL('.', import.meta.url)), '..', 'tools', '四六级PDF',
      );

      server.middlewares.use('/api/pay/cet-explain', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const slug = (url.searchParams.get('slug') ?? '').trim();
        if (!/^cet[46]-\d{4}-\d{2}-\d$/.test(slug)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'bad_slug' }));
          return;
        }
        const dir = path.resolve(
          fileURLToPath(new URL('.', import.meta.url)), '..', 'tools', '四六级解析',
        );
        const file = path.join(dir, `${slug}.json`);
        if (!file.startsWith(dir) || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, reason: 'not_found' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(fs.readFileSync(file));
      });

      /**
       * 两个 PDF：生产上「原题」由 nginx 从 /var/www/ctbu-papers/ 公开挂在 /papers/ 下；
       * 「原题+解析」是会员文件，由 pay_service 签发短效签名链接、nginx 认签名后给文件。
       * 本地没有 nginx，就统一从 tools/四六级PDF/ 直接读，只为把前端那条下载路走通。
       */
      server.middlewares.use('/papers', (req, res, next) => {
        const name = path.basename((req.url ?? '').split('?')[0]);
        if (!/^cet[46]-\d{4}-\d{2}-\d-paper(-solution)?\.pdf$/.test(name)) { next(); return; }
        const file = path.join(pdfDir, name);
        if (!file.startsWith(pdfDir) || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.end(fs.readFileSync(file));
      });

      /**
       * 「原题+解析」的签名链接：生产上 pay_service 会**先验登录、再验会员**，
       * 通过才签发带 md5+expires 的短效链接。本地不模拟鉴权，直接给直链 ——
       * 只用于把前端那条路走通，不代表生产行为（非会员分支要在线上验）。
       */
      server.middlewares.use('/api/pay/cet-solution-url', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const slug = (url.searchParams.get('slug') ?? '').trim();
        if (!/^cet[46]-\d{4}-\d{2}-\d$/.test(slug)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'bad_slug' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ok: true, url: `/papers/${slug}-paper-solution.pdf` }));
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), cetExplainDevMock()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  /**
   * 本地开发把 /api 与 /papers 反代到线上服务器。
   *
   * 为什么要：前端的数据请求全是相对路径（`/api/data/papers`），
   * 生产上由 nginx 同域反代。本地 `npm run dev` 时这些路径没人接，
   * 首页就显示「0 份资料」，只能看空壳 —— 做视觉对比等于瞎改。
   *
   * 只代理读请求；写请求会被线上自己的鉴权挡掉，不会污染数据。
   */
  server: {
    /*
     * 代理目标用环境变量，**不写死某个服务器地址**。
     *
     * 改之前这里直接写着线上 IP —— 对本站开发最省事，但把地址公开出去
     * 既暴露了服务器，也让别人 clone 下来跑不通（连的是别人的库）。
     *
     * 本地开发：在 .env.local 里写
     *   VITE_DEV_API=http://127.0.0.1:8081
     * 不配则默认本机 8081（后端 pay-service 的默认端口）。
     */
    proxy: (() => {
      const target = process.env.VITE_DEV_API || 'http://127.0.0.1:8081';
      return {
        '/api': { target, changeOrigin: true },
        '/papers': { target, changeOrigin: true },
        // 逐页图片（带签名的 /pages/...）：dev 下也要走后端，否则阅读器里全是「这一页暂时显示不出来」
        '/pages': { target, changeOrigin: true },
      };
    })(),
  },
  /**
   * PDF.js 的 worker 是 ESM（pdf.worker.min.mjs），而 Vite 默认把 `?worker`
   * 打成 iife。必须用 'es'，否则 pdf.js 的 module worker 会在打包后失效。
   * 见 src/lib/pdf-worker-entry.ts（内含 Promise.withResolvers 补丁）。
   */
  worker: {
    format: 'es',
  },
});
