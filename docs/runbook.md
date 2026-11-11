# 部署与恢复手册

本文件记录部署、后续发布与恢复流程。试点入口为 `https://sales.omfreight.vip`，API 仅监听本机 `3106` 端口。实际发布与验收结果见 [上线记录](deployment-2026-11-11.md)。部署使用独立目录、服务、数据库和运行账号，不能覆盖已有运输站点。

## 1. 发布结构

生产使用 Node.js 24.22.2 和 PostgreSQL 16.15。本地另在 PostgreSQL 18 验证；目标服务器的隔离 PostgreSQL 16 验收已通过。升级运行时或数据库版本前应重新验证。

```text
/opt/sales-workbench/
  runtime/node/              # Linux 上安装的独立 Node 24 运行时
  releases/<release-id>/     # 发布包解压位置，服务账号不可写
  current -> releases/<release-id>
/etc/sales-workbench/
  api.env                   # root:root 0600，由 systemd 读取为服务环境
  migration.env             # 0600，仅运维所有者可读
  bootstrap.json            # 0600，初始管理员创建后移出/清除
```

创建专用 `sales-workbench` 系统账号，不授予管理员权限。运行账号只需读取发布目录；生产的 `api.env` 由 root 所有的 systemd 管理器读取并注入服务环境，服务账号不直接读取该文件。先核对磁盘、内存、数据库连接数、3106 端口和现有站点健康状态。发布包校验后解压，将 `/opt/sales-workbench/runtime/node/bin` 加入当前运维终端 PATH，进入该版本目录执行 `npm ci --omit=dev`；数据库操作脚本已编译到 `dist/api/scripts/`，无需在生产安装开发依赖。

## 2. 独立数据库和角色

1. 用运维连接创建 UTF-8 数据库 `sales_workbench`，所有者为独立迁移账号。迁移账号需有在本库创建结构、创建/管理两个专用数据库角色的权限，应用运行不使用此账号。
2. 在受保护的 `migration.env` 保存 `MIGRATION_DATABASE_URL` 和公司 `TENANT_ID`。不得在命令行、日志、Git 或聊天中写真实口令。
3. 在发布目录执行显式迁移：

```sh
/opt/sales-workbench/runtime/node/bin/node --env-file=/etc/sales-workbench/migration.env dist/api/scripts/migrate.js --confirm-target=sales_workbench
```

脚本核对数据库名称、实际连接目标、已登记迁移，使用迁移锁。仅空库创建 v1 结构；已为 v1 时不会重建或清空数据。部分结构未经登记时直接拒绝。SQL 迁移不预置客户或演示用户。

`database/roles.sql` 创建 `sales_workbench_api` 登录角色和 `sales_workbench_maintenance` 非登录角色。运行角色无建表/删除权限，对跟进、阶段、审计只有插入/读取权限。由运维通过安全交互或密钥管理方式设置运行口令，保持两种连接分离。

仅撤销旧库的显式授权不足以隔离 PUBLIC CONNECT。部署时核对角色继承与 `pg_hba.conf`，在已有宽泛规则之前为**新运行账号**添加精确规则，例如使用本机 TCP：

```text
host sales_workbench sales_workbench_api 127.0.0.1/32 scram-sha-256
host all             sales_workbench_api 127.0.0.1/32 reject
host all             sales_workbench_api ::1/128       reject
local all            sales_workbench_api              reject
```

此示例选择 IPv4；如果实际连接选 IPv6，应先为目标库添加对应允许规则。不要改变旧账号的规则。重载后以新运行账号实际验证：可连接销售库、不可连接旧运输库、不可执行 DDL/DELETE/修改历史。此步骤不能由本地测试替代。

## 3. 初始管理员

创建只有运维本人可读的 `bootstrap.json`：

```json
{
  "username": "由公司指定的管理员账号",
  "displayName": "管理员姓名",
  "password": "由密码管理器生成的至少14位唯一初始密码"
}
```

```sh
chmod 600 /etc/sales-workbench/bootstrap.json
/opt/sales-workbench/runtime/node/bin/node --env-file=/etc/sales-workbench/migration.env dist/api/scripts/bootstrap.js --credentials /etc/sales-workbench/bootstrap.json
```

只允许在尚无员工的库中初始化。首次登录必须修改密码；创建后移出或安全清除临时凭据文件。管理员随后在界面创建团队和员工，员工的一次性临时密码只展示一次，通过公司的安全渠道交付。生产不运行 `demo:setup`。

## 4. 应用配置

### 团队批量开户

正式员工名单和临时密码不得进入公开 Git 仓库或发布包。在 `/etc/sales-workbench/.private/`（root 所有、0700）保存 `members.json`（0600），格式如下，示例不是正式人员：

```json
{
  "teamName": "试点团队",
  "members": [
    {
      "username": "example-manager",
      "displayName": "示例主管",
      "role": "manager"
    },
    { "username": "example-sales", "displayName": "示例销售", "role": "sales" }
  ]
}
```

在公司记录已经创建的独立数据库中执行：

```sh
/opt/sales-workbench/runtime/node/bin/node --env-file=/etc/sales-workbench/migration.env dist/api/scripts/provision-team.js --members /etc/sales-workbench/.private/members.json --credentials-out /etc/sales-workbench/.private/initial-credentials.json --confirm-target=sales_workbench
```

每人使用独立随机临时密码，首次登录必须改密。整批账号与审计在同一事务中完成；已有同名账号的姓名、团队、角色和启用状态必须一致，否则整批拒绝。重复执行不会重置已有密码，且必须使用新的凭据输出文件名。输出只包含本次新增账号；全部跳过时没有新的开户审计。若提示提交结果不确定，应核对输出的 operationId 与审计，再决定是否分发，不能直接重新生成密码。

凭据文件由管理员保存，并通过公司认可的方式逐人交付；禁止提交、打包或群发整组密码。

`api.env` 至少包含下面项目，真实口令填写在服务器受保护文件中：

```dotenv
NODE_ENV=production
DATA_SOURCE=postgres
HOST=127.0.0.1
PORT=3106
APP_ORIGIN=https://sales.omfreight.vip
TENANT_ID=szzhhq
STATIC_DIR=dist/client
DATABASE_URL=<专用运行角色的PostgreSQL连接>
CSRF_SECRET=<独立随机值，至少32字符>
```

迁移连接不要放进服务环境。数据库在远程时按提供方要求验证 TLS。生产启动会拒绝演示模式、非 HTTPS 来源、非回环监听、缺失密钥和缺失数据库；就绪检查会核对结构版本。数据库故障不会展示示例数据。

安装 `deploy/sales-workbench.service`，核对 `ExecStart` 的 Linux Node 路径、目录所有者与保护权限，启动后检查：

```sh
systemctl daemon-reload
systemctl enable --now sales-workbench
curl --fail http://127.0.0.1:3106/health/live
curl --fail http://127.0.0.1:3106/health/ready
```

将 `deploy/nginx.conf` 作为新增站点配置，在 `http` 上下文引入。先完成域名和证书，再 `nginx -t` 并重载。配置代理来自本机、覆盖转发地址并只记录无查询参数的路径，避免手机号搜索进入访问日志。

可使用 `dist/api/scripts/verify-live.js --config <私有配置文件>` 从 HTTPS 域名检查登录、强制改密、退出、深链接静态回退、品牌资源和 Cookie Secure/HttpOnly/SameSite。配置文件必须由当前执行用户所有且权限为 0600，内容为 `baseUrl` 与 `accounts` 数组；每项包含 `username`、`password`、`role` 和 `mustChangePassword`，一次最多 12 人。验证只读取数据及登录/退出，不改密或写入客户；仍需另行检查刷新客户详情和生产无演示条。写入/角色/并发验收放独立预发布库；正式库只执行必要的真实账号设置和业务操作。同步复查两个原站点的页面、健康和统计。

## 5. 备份、恢复和回滚

由专用备份账号通过受保护的 PGPASSFILE 使用 `bash deploy/backup.sh`。它需要 Linux 的 `pg_dump`、`pg_restore`、`sha256sum`；设置 `PGDATABASE=sales_workbench` 与私有 `BACKUP_DIR`。不要使用应用运行账号备份。

若使用本机 Docker 中的 PostgreSQL，可由 root 执行 `deploy/backup-container.sh`；仅允许目标库为 `sales_workbench`。配套 `sales-workbench-backup.service` 与 `.timer` 在上海时间每天 03:15 之后五分钟内备份到服务器私有目录。安装前核对容器名。脚本不自动删除旧备份，也不代替异地加密备份，应监控磁盘并制定保留策略。

建议每日完整备份并加密异地存储，保留 30 天；实际频率依据可接受的数据损失确定。备份脚本目前只生成并校验目录清单，**不等于完成恢复验收**。

恢复演练必须创建独立 `sales_workbench_restore_<date>` 数据库，再执行：

```sh
pg_restore --exit-on-error --no-owner --no-acl --dbname=<隔离恢复库> <备份文件>
```

由运维核对表/记录数量、外键与状态约束、随机客户和完整跟进历史、登录撤销逻辑，再在恢复库应用角色授权并检查程序读取。记录备份时间、恢复耗时和结果。严禁用恢复演练覆盖正在使用的数据库。

发布前保留上一版本、完整备份和迁移记录。当前 v1 不含破坏性升级。若代码健康失败且结构兼容，将 `current` 切回上个版本并重启；已经执行的结构变化不能只靠切链接撤销，需要经过验证的恢复或前向修复方案。初次发布没有旧版本可切回，应停用新服务并保留数据库以排查，不影响其他站点。

## 6. 清理与监控

`dist/api/scripts/maintenance.js` 只删除过期会话及幂等缓存，不删除客户/活动/历史。为维护作业创建单独登录账号并授予 `sales_workbench_maintenance`，同样限制其只能连接销售库，将 `MAINTENANCE_DATABASE_URL` 存于受保护环境文件后显式运行。建议每天执行一次。不得向 API 运行账号授予该维护角色。

监控就绪、接口 5xx、延时、数据库连接、磁盘、备份失败与证书到期。服务日志仅含请求编号、路由模板和错误码；不记录请求体、密码、Cookie 和完整连接串。请求编号可与界面报错对应。告警接收人、备份保留策略和权限交接需要在实际发布时落实。

## 7. 内部试点

先由一位销售、一位主管和管理员使用 2–3 天，检查真实客户归属、统计口径、重复手机号和交接流程。收集问题并修正后再逐步开通同事账号。配套 [使用指南](user-guide.md) 可用于培训；当前没有向任何同事自动发送通知。
