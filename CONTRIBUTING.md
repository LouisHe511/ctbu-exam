# 贡献指南

感谢愿意看这个项目。下面是最少必要的信息，让你能跑起来并提交一个能合并的改动。

## 先跑起来

```bash
# 前端
cd frontend && npm install && npm run dev

# 后端（可选，没有它只能看到界面）
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json /etc/ctbu-pay/config.json   # 然后填值
python3 pay_service.py
```

数据库初始化见 README 的「快速开始 → 数据库」。

## 提交前自检

```bash
cd frontend
npm run typecheck     # 必须过
npm run lint          # 新增代码不应引入新的 warning
npm run build         # 必须能构建
```

后端改动请至少确认服务能正常启动：

```bash
cd backend && python3 -m py_compile *.py && python3 pay_service.py
```

## 代码约定

**注释写「为什么」，不写「是什么」。**
这个项目的注释密度偏高，是因为很多决定来自踩过的坑：为什么支付回调不能只依赖前端轮询、为什么静态资源不能整体 `--delete`、为什么配置缺失只禁用通道而不退出进程。这类信息对下一个人（包括三个月后的自己）价值最大，请保持。

反过来，`// 给 i 加一` 这种注释不要写。

**前端**

- 组件放 `src/components/`，页面放 `src/pages/`，纯逻辑放 `src/lib/`
- 样式只用 Tailwind 原子类，不写独立 CSS 文件（主题色走 CSS 变量）
- 深色模式通过变量重映射实现，**不要**用 `dark:` 前缀逐处分叉
- 数据请求统一走 `src/lib/` 里的封装，不要在组件里裸写 `fetch`

**后端**

- 所有数据库访问走 `db.rpc()` 或参数化查询，**禁止字符串拼接 SQL**
- 支付相关的新逻辑，必须考虑「回调丢失」时的兜底路径
- 任何会写库的操作都要能承受重复调用（幂等）

**SQL**

- 业务判断尽量下沉为函数，保持可测试
- 新增迁移放到 `database/migrations/`，命名 `YYYY-MM-DD-说明.sql`

## 提交信息

用 `<type>: <说明>` 的形式，type 取以下之一：

```
feat  feat(pay): 支持支付宝手机网站支付
fix   fix(reader): 修正第 3 页之后图片加载失败
docs  文档
style 格式化（不影响逻辑）
refactor 重构
perf  性能
chore 构建 / 依赖 / 杂项
```

说明用中文或英文都可以，写清「改了什么」即可，不必套模板。

## Pull Request

PR 描述里请包含：

1. **改了什么** —— 一句话
2. **为什么** —— 解决什么问题（贴 Issue 号更好）
3. **怎么验证的** —— 截图 / 命令输出 / 手动步骤

涉及支付、会员、鉴权的改动，请额外说明**失败路径**是怎么处理的。

## 不要提交的内容

- 任何真实的 `.env`、密钥、私钥文件
- 试卷 PDF、听力音频、教材电子版（版权 + 体积）
- 数据库导出文件（含用户邮箱等个人信息）
- `node_modules/`、`dist/`

`.gitignore` 已经覆盖了大部分，但提交前还是看一眼 `git status`。

## 报告问题

- 功能缺陷 / 建议 → [Issues](../../issues)
- 安全问题 → 见 [SECURITY.md](SECURITY.md)，**不要**开公开 Issue
