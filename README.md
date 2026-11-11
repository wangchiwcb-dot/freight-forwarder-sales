# 中航环球 · 货代销售工作台

基于四份 HTML 设计稿和 v1.1 技术文档实现的独立销售应用。包括工作台、客户管理、电销/扫楼录入、沟通记录、员工/团队管理和操作审计。代码仓库：<https://github.com/wangchiwcb-dot/freight-forwarder-sales>。

v0.2.0 已部署至阿里云，试点入口：[销售工作台](https://sales.omfreight.vip)。已使用公司 Logo，并为首批团队开通 16 个独立账号（1 位管理员、15 位销售）。员工以本人姓名登录，临时密码由管理员单独交付，首次登录必须改密。走货**票数**数据尚未接入，页面明确展示待接入；客户的“已走货”阶段可正常维护。

## 本地启动

需要 Node.js 24 或更高版本、npm。首次执行：

```sh
npm ci
cp .env.example .env
npm run demo:setup
```

在两个终端分别运行：

```sh
npm run dev:api
```

```sh
npm run dev
```

打开 <http://127.0.0.1:4193>。本地虚构数据账号为 `sales`、`sales2`、`manager`、`admin`，密码均为 `SalesDemo2026!local`。这些账号仅由显式执行的演示初始化创建，禁止用于生产。演示数据保存在 `.data/demo-db`，退出后保留；不要同时用多个 API 进程打开它。再次初始化不会覆盖已有数据。

生产构建也可单进程本地预览（先停止上面的 API）：

```sh
npm run build
DATA_SOURCE=demo PORT=4193 APP_ORIGIN=http://127.0.0.1:4193 STATIC_DIR=dist/client npm start
```

## 已实现功能

- 工作台：客户阶段统计、统计卡片下钻、今日电销添加率、逾期和近期跟进提醒。
- 客户：搜索/筛选/分页、建档与编辑、手机号重复提示、跟进时间线、提醒设置、逐级晋级、主管回退、归档恢复与负责人交接。
- 沟通：电销/扫楼独立表单、今日记录、历史筛选、继续转客户、新建或关联已有客户、管理员更正留痕。
- 管理：账号登录、首次修改密码、员工/团队管理、停用与调组影响预览、重置密码、操作审计。
- 手机：底部导航、卡片列表、适配抽屉、未保存离开提示。
- 后端：持久会话、角色和数据归属权限、CSRF、参数校验、幂等、版本冲突保护、事务、追加历史与受限数据库账号。

销售默认看自己；主管可切换本团队；管理员可切换全公司。所有角色初次进入均为“我的客户与记录”。手机号按当前文档支持大陆 11 位手机号，备用电话可填写座机等文本。日期按上海时间展示。

## 技术与目录

| 位置        | 内容                                              |
| ----------- | ------------------------------------------------- |
| `src/`      | React 19、TypeScript、Ant Design 5 页面与请求状态 |
| `server/`   | Fastify 5 API、认证、业务权限和 PostgreSQL 适配   |
| `shared/`   | 共用枚举、请求校验与数据类型                      |
| `database/` | 版本 1 数据结构和受限角色授权                     |
| `scripts/`  | 显式迁移、初始管理员、演示、测试和发布打包        |
| `tests/`    | API、真实 PostgreSQL 与浏览器端到端验收           |
| `deploy/`   | systemd、独立 Nginx 站点和备份脚本                |
| `docs/`     | 设计基线、实施说明、运维手册和同事使用指南        |

正式数据使用独立 PostgreSQL 数据库 `sales_workbench` / `crm` schema。演示使用 PGlite，只有显式选择 `DATA_SOURCE=demo` 时启用；生产禁止演示或故障自动回退。与已有运输时效、运输管理应用保持独立。

## 验证与发布包

```sh
npm run format:check
npm run typecheck
npm test
npm run test:postgres
npm run build
npx playwright install chromium
npm run test:e2e
npm audit
npm run package
```

`npm test` 运行 PGlite API 测试，原生 PostgreSQL 用例在未设置隔离环境时跳过；`npm run test:postgres` 启动仅监听本机随机端口的临时 PostgreSQL，创建 `sales_workbench_test` 并以受限运行账号执行测试，随后清理。禁止把测试脚本连接到生产。

浏览器验收使用 Chromium 和独立临时演示库，启动构建产物的 4195 端口，不读写开发演示数据。失败截图、跟踪和 HTML 报告位于忽略目录。GitHub Actions 执行以上核心检查并保存发布包。

`npm run package` 产生 `artifacts/freight-sales-*.tar.gz` 和 SHA-256；白名单打包不含 `.env`、数据库、客户信息、依赖目录和测试输出。生产依赖在目标服务器执行 `npm ci --omit=dev`，不要复制本机 `node_modules`。

## 进一步阅读

- [上线记录](docs/deployment-2026-11-11.md)
- [实施状态与验证边界](docs/implementation-status.md)
- [部署和恢复手册](docs/runbook.md)
- [同事使用指南](docs/user-guide.md)
- [设计文档索引](docs/design/README.md)
- [数据库设计](docs/design/database-design.md)
