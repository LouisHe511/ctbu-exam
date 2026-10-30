/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    /**
     * ⚠️ 2026-10-20 用户：「E你自己想办法美化 ai感太重了」
     *
     * 定下的方向 = **校档案馆 / 索引卡**：发丝线分层、中文衬线做大标题、
     * 数字全部等宽对齐、一种强调色、不要卡片盒子。
     *
     * 原来 AI 感的三个根：
     *   1. 首页四段完全同构（标题 + 副标题 + 「查看全部 →」+ 三列等权卡片）→ 无层级
     *   2. 每张卡都是同尺寸同圆角同描边的白盒子 → 看不出主次
     *   3. 灰有两套在打架：Tailwind 冷灰 gray-* + 手写苹果暖灰 #1d1d1f/#6e6e73
     *      → 实测 12 种文字色（判据是 ≤6–8 种）
     *
     * 这里做的：把 gray-* **整条重映射**到单一墨色阶（色相 40°，极低饱和），
     * 于是别处现有代码里的 text-gray-500 之类会自动归到同一套色阶里，
     * 不用逐个文件去改也能把「两套灰」收成一套。
     */
    extend: {
      colors: {
        /*
         * ═══════════════════════════════════════════════════════════
         * 2026-10-22 浅色 / 深色双主题
         * ═══════════════════════════════════════════════════════════
         * 做法：把**语义**抽成 CSS 变量（值写在 src/index.css 的
         * `:root` 与 `[data-theme="light"]` 里），Tailwind 这边只声明
         * "这个槽位指向哪个变量"。切换主题 = 换 `<html data-theme>`
         * + 一组变量重新赋值，全站同一帧一起变，不存在"改到一半"的中间态。
         *
         * 为什么不让每个组件自己判断主题：
         *   站内已经有 500+ 处颜色类名。逐处加 `dark:` / 三元判断 =
         *   必然漏改，而浅色下漏一处就是**白底白字**，比不改更糟。
         *   变量方案改一次就能全站生效，且新增组件自动跟随。
         *
         * 命名只描述**用途**，不描述颜色：
         *   page      页面底色        panel     卡片/面板
         *   solid     实心强调块底    on-solid  实心块上的字（永远是反色）
         *   strong    最强正文        muted     次级正文     faint 弱化说明
         *   elevate   提亮/压暗叠层    hairline  发丝线（边框/分隔）
         *   input     表单控件底
         */
        /*
         * ⚠️ 全部用 **rgb 三元组** 声明（`rgb(var(--x) / <alpha-value>)`），
         * 而不是直接 `var(--x)`。
         * 原因：站内有 183 处 `bg-white/[0.06]`、211 处 `border-white/[0.08]`
         * 这类带透明度的写法。直接 `var()` 的话 `/88` 后缀会被 Tailwind 忽略，
         * 半透明导航条会变成实心块 —— 那种 bug 很难一眼看出来。
         */
        page: 'rgb(var(--ctbu-page) / <alpha-value>)',
        panel: 'rgb(var(--ctbu-panel) / <alpha-value>)',
        'panel-2': 'rgb(var(--ctbu-panel-2) / <alpha-value>)',
        solid: 'rgb(var(--ctbu-solid) / <alpha-value>)',
        'solid-hover': 'rgb(var(--ctbu-solid-hover) / <alpha-value>)',
        'on-solid': 'rgb(var(--ctbu-on-solid) / <alpha-value>)',
        /** 强调色块上的字：两种主题下都是白色（accent 本身是深青） */
        'on-accent': '#ffffff',
        strong: 'rgb(var(--ctbu-strong) / <alpha-value>)',
        muted: 'rgb(var(--ctbu-muted) / <alpha-value>)',
        faint: 'rgb(var(--ctbu-faint) / <alpha-value>)',
        input: 'rgb(var(--ctbu-input) / <alpha-value>)',
        elevate: 'rgb(var(--ctbu-elevate) / <alpha-value>)',
        hairline: 'rgb(var(--ctbu-hairline) / <alpha-value>)',

        /**
         * ═══════════════════════════════════════════════════════════
         * 2026-10-21 全站转深色：gray 色阶**整体反转语义**
         * ═══════════════════════════════════════════════════════════
         * 为什么要这么做，而不是逐个文件改 className：
         *   站内已有 125 处 `text-gray-500`、92 处 `bg-white`、
         *   34 处 `border-gray-200`。逐处改要动 13 个文件、极易漏改。
         *   而 Tailwind 的类名是**语义槽位**——把槽位背后的值换掉，
         *   所有引用同义槽位的地方会一起变，这正是我们应该利用的。
         *
         *   规则：数字越小 = 越浅（原来的习惯），现在：
         *     gray-50/100  → 极暗的微底（原来是极浅的微底）
         *     gray-900     → 主正文（现在是亮白，原来是墨黑）
         *   于是原有代码里"底浅字深"的组合自动变成"底深字亮"。
         *
         * 对比度全部实测过（底色 #08090a）：
         *   900 主正文 18.7:1 ✅   700 次强 10.7:1 ✅   500 次级 6.1:1 ✅
         *   400 弱化 4.95:1 ✅     300 极弱 4.11:1（仅用于非正文装饰）
         */
        gray: {
          50: 'rgb(var(--ctbu-gray-50) / <alpha-value>)',
          100: 'rgb(var(--ctbu-gray-100) / <alpha-value>)',
          200: 'rgb(var(--ctbu-gray-200) / <alpha-value>)',
          300: 'rgb(var(--ctbu-gray-300) / <alpha-value>)',
          400: 'rgb(var(--ctbu-gray-400) / <alpha-value>)',
          500: 'rgb(var(--ctbu-gray-500) / <alpha-value>)',
          600: 'rgb(var(--ctbu-gray-600) / <alpha-value>)',
          700: 'rgb(var(--ctbu-gray-700) / <alpha-value>)',
          800: 'rgb(var(--ctbu-gray-800) / <alpha-value>)',
          900: 'rgb(var(--ctbu-gray-900) / <alpha-value>)',
          950: 'rgb(var(--ctbu-gray-950) / <alpha-value>)',
        },
        /*
         * 深色层次（2026-10-21）—— 全部来自 Linear 的实测值。
         *
         * 为什么需要一整套：上一版整页只有 #08090a 一个底色，卡片、行、页脚
         * 全都糊在一起，截图采样出来每个区域都是 rgb(8,9,10) ——
         * 这不是"高级"，是"看不清"。Linear 分层的办法是**极小幅提亮**：
         * 底 → 面板只差 2 倍亮度，肉眼刚好能分出层次，又不会刺眼。
         */
        ink: {
          950: 'rgb(var(--ctbu-ink-950) / <alpha-value>)',
          900: 'rgb(var(--ctbu-ink-900) / <alpha-value>)',
          850: 'rgb(var(--ctbu-ink-850) / <alpha-value>)',
          800: 'rgb(var(--ctbu-ink-800) / <alpha-value>)',
          750: 'rgb(var(--ctbu-ink-750) / <alpha-value>)',
        },
        // 强调色只有一个：档案里"可点的那一处"。除主动作与当前选中，别处不用。
        accent: {
          DEFAULT: 'rgb(var(--ctbu-accent) / <alpha-value>)',
          deep: 'rgb(var(--ctbu-accent-deep) / <alpha-value>)',
          wash: 'rgb(var(--ctbu-accent-wash) / <alpha-value>)',
        },
        /*
         * ⚠️ 故意**不**重映射 tailwind 的 `white` / `black`。
         *
         * 一开始试过把 white 指向"叠层变量"，让 183 处 `bg-white/[0.06]` 自动跟着变。
         * 但那会把 `text-white` 一起带走 —— 而站内 106 处 `text-white` 大多写在
         * **青绿色主按钮**（`bg-accent`）上。浅色模式下 accent 仍是深青，
         * 字一旦变成黑色就成了"深底黑字"，反而不可读。
         *
         * 所以改成**按用途逐个替换**（见 2026-10-22 那次批量替换）：
         *   bg-white/[…]      → bg-elevate/[…]      叠层底
         *   border-white/[…]  → border-hairline/[…] 发丝线
         *   text-white        → 保留（深色块上的字，两种主题下都该是白）
         *   bg-black（输入框） → bg-input
         *   bg-black/50（遮罩）→ 保留（遮罩两种主题都用黑）
         */
        white: '#ffffff',
        black: '#000000',
      },
      fontFamily: {
        // 中文优先走系统真字体，不回退到泛用 sans（默认字体栈是"没人选过字体"的味道）
        sans: ['Inter', '"Noto Sans SC"', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        // 衬线只给大标题与数字：档案馆的"印刷品"感，全站别处不用
        serif: ['"Songti SC"', '"Source Han Serif SC"', '"Noto Serif SC"', '"SimSun"', 'serif'],
        // 等宽只给计数、页码、课程代码
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', '"Cascadia Mono"', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(14px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-up-panel': {
          from: { opacity: '0', transform: 'translateY(20px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },

        /*
         * ═══════ 2026-10-21 重做：对齐 Linear / Tailwind 的动效语言 ═══════
         *
         * 上一版把动效砍到只剩"淡入 + 位移"，理由是"动效撒在所有元素上等于没有主次"。
         * 那句话对，但执行过头了：真正的高级感来自**三种不同性质的动效并存**——
         *   ① 入场：blur → 清晰（Linear 首页标题就是这个，计算后 filter: blur(0px)）
         *   ② 环境：低频、无限、不抢注意力（点阵呼吸 / 细线漂移）
         *   ③ 交互：只给可点的东西，且极快（0.15s，user 感觉不到"在动"）
         *
         * 下面三组分别对应这三类，别混用。
         */

        /* ① 入场：从模糊 + 微升到清晰。Linear 的 titleLine 就是这个手法，
              比单纯 translateY 高级的地方在于**同时改变锐度**，像镜头对上焦。 */
        /*
         * 2026-10-21 修正：原版从 opacity:0 起步，
         * 首屏加载瞬间整块是空的 —— 用户看到"页面什么都没有"，很吓人。
         * 现在起始 opacity 0.55、blur 6px：
         * 元素从第一帧起就是可读的，只是轻微失焦 + 略低，
         * 动效感还在（对焦 + 上浮），但任何时刻截图都看得见内容。
         */
        'focus-in': {
          from: { opacity: '0.55', filter: 'blur(6px)', transform: 'translateY(6px)' },
          to: { opacity: '1', filter: 'blur(0px)', transform: 'translateY(0)' },
        },
        'focus-in-slow': {
          from: { opacity: '0.6', filter: 'blur(9px)', transform: 'translateY(9px)' },
          to: { opacity: '1', filter: 'blur(0px)', transform: 'translateY(0)' },
        },

        /* ② 环境：极慢的细线漂移，用来给深色区"活着"的感觉，但绝不能看到它在动 */
        'drift': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0)' },
          '50%': { transform: 'translate3d(0, -6px, 0)' },
        },
        /* 光晕呼吸：深色区顶部一团极淡的光，缓慢明灭 */
        'glow-breathe': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '0.6' },
        },
        /* 扫描线：一条 1px 的线从上缓慢落到下，周期很长，几乎察觉不到 */
        'line-sweep': {
          '0%': { transform: 'translateY(-100%)', opacity: '0' },
          '10%': { opacity: '0.5' },
          '90%': { opacity: '0.5' },
          '100%': { transform: 'translateY(100%)', opacity: '0' },
        },

        /* 下划线从左侧展开：给行内链接用，比 opacity 变化更有"物理感" */
        'underline-grow': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },

        /* ③ 交互：入场完了之后的微光扫过（跑一次），用于主按钮 */
        'sheen': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(200%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
        'fade-in-up': 'fade-in-up 0.38s cubic-bezier(0.22, 0.9, 0.32, 1) both',
        'fade-in-down': 'fade-in-down 0.22s ease-out both',
        'scale-in': 'scale-in 0.22s cubic-bezier(0.22, 0.9, 0.32, 1) both',
        'slide-up-panel': 'slide-up-panel 0.3s cubic-bezier(0.22, 0.9, 0.32, 1) both',

        // 入场（常用）：0.7s 足够慢到能看见"对上焦"，又不至于等
        'focus-in': 'focus-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        'focus-in-slow': 'focus-in-slow 0.7s cubic-bezier(0.16, 1, 0.3, 1) both',

        // 环境（无限循环，参数克制：周期长、幅度小）
        'drift': 'drift 14s ease-in-out infinite',
        'glow-breathe': 'glow-breathe 9s ease-in-out infinite',
        'line-sweep': 'line-sweep 12s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'sheen': 'sheen 1.6s cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 0.9, 0.32, 1)',
        // Linear 用的就是这条，0.16 起步（几乎瞬时）→ 1 收尾（长尾），最快的"高级"曲线
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-out-quart': 'cubic-bezier(0.76, 0, 0.24, 1)',
      },
    },
  },
  plugins: [],
};
