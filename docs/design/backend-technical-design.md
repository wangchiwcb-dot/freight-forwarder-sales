# 货代销售工作台｜后端技术设计

> 这是保留的 v1.1 设计基线。已完成内容及验证范围见 [实施状态](../implementation-status.md)，实际代码以本仓库为准。

版本：v1.1 建议实施基线；日期：2026-11-11；状态：设计文档，尚未实现、迁移或部署。

配套：[文档入口与实施顺序](README.md) · [前端技术文档](frontend-technical-design.md)。

数据库专题：[表关系、设计取舍与复核结果](database-design.md)。§5是本组文档唯一的DDL结构草案，专题文档不另维护一套SQL。

本文件与前端技术文档共同约束后续开发。标为“建议基线”的规则是为正式多人使用补齐的方案，不表示用户已经逐项确认；实施中调整规则应同步两份文档和接口契约。

## 1. 设计依据、范围与现状

设计稿位于 `/Users/wangchi/Desktop/workbuddy/freight-forwarder-design/design/workbench/`，包含 `index.html`、`customers.html`、`leads.html`、`call-records.html`、`app.js`、`workbench.css` 和 `README.md`。
原型使用浏览器 localStorage 和虚构数据，是人工录入与跟进工具；“电销记录”不是录音文件，“电销”不包含自动拨号。

| 层级         | 一期范围                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| 设计稿业务   | 客户建档/编辑/归档、跟进时间线、三阶段状态、电销与扫楼录入、转客户、列表筛选、工作台统计  |
| 多人使用补充 | 个人账号、销售/主管/管理员权限、团队范围、客户交接、归档恢复、审计、并发保护、登录与退出  |
| 上线必需     | 分页查询、真实数据库、错误处理、备份恢复、HTTPS、监控、试点验收                           |
| 暂不实施     | 自动外呼、录音、AI、转写、附件、批量导入、微信/短信提醒、订单系统、收费结算、外部客户门户 |
| 二期依赖     | 走货量真实来源与销售归属对接；一期保留“待接入”，不新增票量录入系统                        |

现有 `backend/` 是运输时效管理端，不是本销售工作台。其 2026-11-10 部署记录记载 `effective.omfreight.vip` 与 `transit.omfreight.vip` 已上线，本次只读取本地资料，未重新验证服务器状态。
现有管理端仅有一个配置管理员、进程内会话和全量 `/api/state`；正式销售工作台不复用这三项设计。可复用其技术栈、受限数据库角色、版本检查、事务审计与独立发布方式。

## 2. 架构与部署边界

建议后续代码在当前工作区新增独立 `workbench/` 应用，包含 `src/`、`server/`、`shared/`、`database/`、`deploy/`、`tests/`；本轮不创建应用代码。

| 项目       | 建议基线                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------- |
| 前端       | React 19、TypeScript、Ant Design 5；与前端文档保持一致                                      |
| API        | Node.js 24 LTS、Fastify 5、TypeScript、Zod、`pg`；锁文件固定经过验证的补丁版本              |
| 数据库     | 复用现有 PostgreSQL 实例，独立数据库 `sales_workbench`，业务 schema `crm`                   |
| 域名与端口 | 拟 `https://sales.omfreight.vip`，API 监听 `127.0.0.1:3106`；部署前核验 DNS、证书和端口占用 |
| API 前缀   | `/api/v1`；同域网页与 API，生产不开放任意跨域访问                                           |
| 运行方式   | 独立 `sales-workbench.service`、非特权用户 `sales-workbench`、Nginx HTTPS 反向代理          |
| 访问规模   | 先按小型公司团队设计；容量目标须通过测试，不承诺未验证并发能力                              |

请求链路：员工浏览器 → Nginx HTTPS → Fastify 认证/权限/校验 → 业务事务 → `sales_workbench.crm`。
API 角色 `sales_workbench_api` 不应连接现有 `freight_times` 库，且无 `freight`/`freight_admin` 写权限。不能仅凭“未显式 GRANT”认定隔离成功：部署检查角色继承、PUBLIC CONNECT 和 pg_hba 顺序，必要时对该新角色先允许 sales_workbench、再拒绝其他数据库；不改旧角色访问路径。迁移角色与运行角色分开，运行角色没有建表或修改结构权限。
一期不引入 Redis、消息队列或独立任务进程：所有业务写入是短事务，统计直接聚合。会话清理由系统定时任务调用受限清理入口或专用脚本完成，不影响业务成功与否。
生产必须显式选择 PostgreSQL；配置缺失、结构不符或数据库故障时返回不可用，不切换到演示数据。演示环境使用隔离数据库与虚构数据，并有明显标记。

## 3. 身份、团队与访问范围

公司键一期为 `szzhhq`，存储为 `tenant_id`，从认证用户取得；客户端不能自行指定公司、操作者、创建时间或审计内容。UUID 为稳定资源 ID，不以电话或公司名称作主键。

| 角色           | 默认范围                      | 允许动作                                                                           |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `sales` 销售   | 本人客户、本人的电销/扫楼记录 | 创建、编辑本人客户、逐级晋级、添加跟进、归档本人客户、创建记录、转客户             |
| `manager` 主管 | 本人，可切自己团队            | 团队内客户维护/交接、晋级/回退、归档恢复、查看团队统计；不能管理账号或修改记录原文 |
| `admin` 管理员 | 本人，可切全公司              | 以上全部、账号/团队管理、跨团队交接、活动纠错、审计查询                            |

所有角色默认 `scope=mine`；主管可切 `scope=team`；管理员可切 `scope=company` 并按团队/负责人筛选。传入越权 scope 或负责人返回 403，不静默扩大范围。
范围统一参数为 `scope,teamId?,ownerId?`，适用于客户列表、活动列表、活动summary和dashboard。`teamId` 仅管理员在company范围可传；主管team范围由服务端取自己的团队，不接受客户端换团队。ownerId必须属于所选范围；teamId与ownerId同时传入时必须相符，否则422。mine范围只允许当前用户，任何范围参数都只能收窄会话权限。
团队以负责人当前所属团队判断；客户交接后客户和其跟进历史整体随新负责人可见。活动归属保留录入人，不因客户交接自动转移。关联客户已不可见时，只返回 `customerLinkVisible:false`，不返回其名称/电话或可点击详情。
员工调组会使其客户与历史活动整体改变团队可见范围；必须展示受影响数量、二次确认并审计。当前团队筛选是“现由该团队管理的数据”，不代表事件发生时的团队业绩；一期不建设历史团队业绩报表。
主管不能把客户交给团队外人员；管理员可以。停用员工前展示未归档客户数量并提示交接；未交接不阻止立即停用和撤销会话，剩余客户由主管/管理员继续接管。新建、转交、转换及恢复的客户负责人必须启用；不能给停用人员新分配客户。归档客户可先转交给启用员工再恢复。
客户详情、跟进、活动、统计、电话去重、转化关联和审计查询都执行同一范围检查；不能只隐藏前端按钮。无权访问的具体资源统一返回 404，避免泄露存在性。
一期不做公开注册或共享账号。管理员创建个人账户，提供一次性初始化凭据，首次登录仅允许改密/退出；改密成功后才能读取业务数据。

## 4. 字段与枚举契约

接口使用 camelCase，数据库使用 snake_case；中文展示由共享元数据映射。枚举值保持稳定，不把中文标签用作数据库关联键。

| 字段          | 值 → 展示                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `added` 已添加；`opened` 已开户；`shipped` 已走货                                                                                                                            |
| `source`      | `call` 电销；`visit` 扫楼；`friend_referral` 朋友介绍；`customer_referral` 客户介绍；`xiaohongshu` 小红书；`douyin` 抖音；`other_online` 其他网络平台                        |
| `action`      | `greeting` 正常问候；`quote` 发报价表；`inquiry` 客户询价；`order` 客户下单                                                                                                  |
| `type`        | `call` 电销；`visit` 扫楼                                                                                                                                                    |
| 电销 `result` | `unanswered` 未接通；`invalid_number` 空号·停机；`call_rejected` 已接通·拒绝；`call_deferred` 已接通·暂缓；`call_interested` 已接通·有意向；`contact_added` 成功添加联系方式 |
| 扫楼 `result` | `no_entry` 无人·未进门；`visit_rejected` 已沟通·拒绝；`visit_deferred` 已沟通·暂缓；`visit_interested` 已沟通·有意向；`contact_added` 成功添加联系方式                       |
| `nextJudge`   | `revisit` 可再访；`defer` 暂缓；`reject` 拒绝                                                                                                                                |

默认下次判断：拒绝结果→`reject`，暂缓结果→`defer`，其他→`revisit`；用户可覆盖。`invalid_number` 仍按原型默认可再访，此为业务选择，不是号码有效性判断。

| 字段                    | 约束                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `name` / `customerName` | 必填，去首尾空白后 1–200 字符                                                               |
| `contact`               | 可空，最多 100 字符                                                                         |
| 客户 `phone`            | 必填；去空白后匹配 `^1[3-9]\d{9}$`，仅大陆手机号                                            |
| 活动 `phone`            | 电销必填；扫楼选填，有填同样校验大陆手机号                                                  |
| `altPhone`              | 可空，最多 50 字符；允许座机等自由文本，不套主手机规则                                      |
| `wechat` / `email`      | 最多 100 / 254 字符；邮箱非空时校验格式                                                     |
| `address`               | 最多 500 字符；扫楼记录必填，普通客户可空                                                   |
| `needs` / `note`        | 最多 2,000 / 4,000 字符                                                                     |
| 跟进 `content`          | 必填，1–4,000 字符                                                                          |
| 操作 `reason`           | 回退、交接、归档/恢复、活动纠错必填，1–500 字符                                             |
| `highIntent`            | 布尔值，默认 false，不从沟通结果自动推断                                                    |
| `nextFollowAt`          | ISO 8601 带时区时间或 null；省略表示不改，null 表示明确取消提醒；新设置日期不能早于上海当天 |

服务端实施相同校验，禁止静默截断。允许为空的文本统一存空字符串；未知时间存 null。电话重复只警告，不创建唯一手机号约束。
电销活动的address由前端省略，后端固定为空字符串；不接收null或隐藏的扫楼草稿地址，非空值返回422。扫楼地址按必填规则校验。
用户若只在 UI 选择日期，前端将其转换为该日上海时间 10:00（`+08:00`），并在界面说明；服务端不再二次猜测日期。今日10:00已经过去时仍允许选择并显示逾期；已有逾期提醒不因普通编辑被拒绝。时间落库 `timestamptz`，响应 ISO 8601。
一期跟进与活动发生时间由服务端生成，暂不支持补记历史日期；创建时间和更新时间均由服务端控制。

## 5. 数据模型与 SQL 约束

以下是DDL结构草案，不是生产迁移或已上线结构。结构约束可在隔离数据库验证；正式开发仍须交付版本化迁移、权限脚本、事务代码以及真实PostgreSQL的并发/执行计划测试。

```sql
CREATE SCHEMA crm;
CREATE TABLE crm.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm.tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE crm.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0), enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE TABLE crm.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id),
  team_id uuid, username varchar(100) NOT NULL CHECK (length(btrim(username)) > 0),
  display_name varchar(100) NOT NULL CHECK (length(btrim(display_name)) > 0),
  role text NOT NULL CHECK (role IN ('sales','manager','admin')),
  password_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true, session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES crm.teams(tenant_id,id),
  CHECK (role = 'admin' OR team_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_login_idx ON crm.users (tenant_id,lower(username));
CREATE TABLE crm.sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32), tenant_id text NOT NULL, user_id uuid NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0), csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, FOREIGN KEY (tenant_id,user_id) REFERENCES crm.users(tenant_id,id),
  CHECK (expires_at > created_at), CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_user_idx ON crm.sessions (tenant_id,user_id);
CREATE TABLE crm.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, owner_id uuid NOT NULL,
  name varchar(200) NOT NULL CHECK (length(btrim(name)) > 0), contact varchar(100) NOT NULL DEFAULT '',
  phone varchar(11) NOT NULL CHECK (phone ~ '^1[3-9][0-9]{9}$'), alt_phone varchar(50) NOT NULL DEFAULT '',
  wechat varchar(100) NOT NULL DEFAULT '', email varchar(254) NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('call','visit','friend_referral','customer_referral','xiaohongshu','douyin','other_online')),
  status text NOT NULL DEFAULT 'added' CHECK (status IN ('added','opened','shipped')),
  address varchar(500) NOT NULL DEFAULT '', needs varchar(2000) NOT NULL DEFAULT '',
  note varchar(4000) NOT NULL DEFAULT '', high_intent boolean NOT NULL DEFAULT false,
  last_follow_at timestamptz, next_follow_at timestamptz, archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,owner_id) REFERENCES crm.users(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id uuid NOT NULL,
  actor_id uuid NOT NULL, action text NOT NULL CHECK (action IN ('greeting','quote','inquiry','order')),
  content varchar(4000) NOT NULL CHECK (length(btrim(content)) > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(), next_follow_at timestamptz,
  reminder_action text NOT NULL CHECK (reminder_action IN ('unchanged','set','clear')),
  CHECK ((reminder_action = 'set' AND next_follow_at IS NOT NULL)
    OR (reminder_action IN ('unchanged','clear') AND next_follow_at IS NULL)),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, owner_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('call','visit')),
  customer_name varchar(200) NOT NULL CHECK (length(btrim(customer_name)) > 0),
  phone varchar(11) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '', result text NOT NULL,
  next_judge text NOT NULL CHECK (next_judge IN ('revisit','defer','reject')),
  note varchar(4000) NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  converted_customer_id uuid, converted_at timestamptz, converted_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_id) REFERENCES crm.users(tenant_id,id),
  FOREIGN KEY (tenant_id,converted_customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,converted_by) REFERENCES crm.users(tenant_id,id),
  CHECK (phone = '' OR phone ~ '^1[3-9][0-9]{9}$'),
  CHECK ((type = 'call' AND phone <> '' AND address = '') OR (type = 'visit' AND length(btrim(address)) > 0)),
  CHECK ((type = 'call' AND result IN ('unanswered','invalid_number','call_rejected','call_deferred','call_interested','contact_added'))
    OR (type = 'visit' AND result IN ('no_entry','visit_rejected','visit_deferred','visit_interested','contact_added'))),
  CHECK ((converted_customer_id IS NULL AND converted_at IS NULL AND converted_by IS NULL)
    OR (converted_customer_id IS NOT NULL AND converted_at IS NOT NULL AND converted_by IS NOT NULL AND result = 'contact_added')),
  CHECK (converted_at IS NULL OR converted_at >= created_at)
);
CREATE TABLE crm.customer_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id uuid NOT NULL,
  from_status text NOT NULL CHECK (from_status IN ('added','opened','shipped')),
  to_status text NOT NULL CHECK (to_status IN ('added','opened','shipped')), actor_id uuid NOT NULL,
  reason varchar(500), follow_up_id uuid, at timestamptz NOT NULL DEFAULT now(),
  CHECK ((from_status,to_status) IN (('added','opened'),('opened','shipped'),('opened','added'),('shipped','opened'),('shipped','added'))),
  CHECK ((from_status,to_status) IN (('added','opened'),('opened','shipped'))
    OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  CHECK (follow_up_id IS NULL OR (from_status,to_status) IN (('added','opened'),('opened','shipped'))),
  FOREIGN KEY (tenant_id,customer_id,follow_up_id) REFERENCES crm.follow_ups(tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id), actor_id uuid,
  entity_type text NOT NULL, entity_id uuid, action text NOT NULL, request_id text NOT NULL,
  reason varchar(500), changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.idempotency_keys (
  tenant_id text NOT NULL, user_id uuid NOT NULL,
  request_target varchar(300) NOT NULL CHECK (length(btrim(request_target)) > 0), key uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','completed')),
  response_status integer, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,user_id,request_target,key), CHECK (expires_at > created_at),
  CHECK ((state = 'processing' AND response_status IS NULL AND response_body IS NULL)
    OR (state = 'completed' AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)),
  FOREIGN KEY (tenant_id,user_id) REFERENCES crm.users(tenant_id,id)
);
CREATE INDEX users_team_idx ON crm.users (tenant_id,team_id,id);
CREATE INDEX customers_owner_follow_idx ON crm.customers (tenant_id,owner_id,last_follow_at DESC NULLS LAST,id DESC) WHERE archived_at IS NULL;
CREATE INDEX customers_company_follow_idx ON crm.customers (tenant_id,last_follow_at DESC NULLS LAST,id DESC) WHERE archived_at IS NULL;
CREATE INDEX customers_reminder_idx ON crm.customers (tenant_id,owner_id,next_follow_at,id) WHERE archived_at IS NULL AND next_follow_at IS NOT NULL;
CREATE INDEX customers_phone_idx ON crm.customers (tenant_id,phone);
CREATE INDEX follow_ups_customer_idx ON crm.follow_ups (tenant_id,customer_id,occurred_at DESC,id);
CREATE INDEX activities_owner_time_idx ON crm.activities (tenant_id,owner_id,occurred_at DESC,id);
CREATE INDEX activities_company_time_idx ON crm.activities (tenant_id,occurred_at DESC,id DESC);
CREATE INDEX status_events_customer_idx ON crm.customer_status_events (tenant_id,customer_id,at DESC,id DESC);
CREATE INDEX audit_tenant_time_idx ON crm.audit_logs (tenant_id,created_at DESC,id);
CREATE INDEX sessions_expiry_idx ON crm.sessions (expires_at);
CREATE INDEX idempotency_expiry_idx ON crm.idempotency_keys (expires_at);
```

状态事件通过公司、客户、跟进三元外键绑定同一客户；不能仅凭 UUID 存在就接受关联。CHECK拒绝同阶段变化、跨级晋升和无原因回退；操作者角色及关联跟进必须为order等跨表业务规则仍由事务校验。跟进reminder_action记录本次修改意图：unchanged/clear时next_follow_at为空，set时必须有值；客户表保存当前生效安排。
客户没有嵌入跟进数组，时间线单独分页。`last_follow_at` 为最新有效跟进时间的缓存，写入时与跟进同事务更新；归档保留所有历史。
客户ID代表一份销售档案，姓名/电话都不唯一。总客户统计按档案ID计数，不代表去重后的企业数；幂等只防同一请求重试，不解决不同活动对同一企业重复建档。一期保留软提示与人工选择关联，不提供自动合并。客户时间线只展示follow_ups，converted_customer_id是转化关系，不自动把所有外呼归入客户时间线。
只为已确认的真实统计来源新增关联表；不预先把运输柜表复制成销售订单。手机号/备用号规范化后的重复检查可增加专门检索列，不以备注文本解析归属。
查询性能先用上述索引与实际数据规模测试；模糊中文搜索先用有范围限制的参数化 `ILIKE`，规模需要时再明确启用 `pg_trgm`，不默认开启未经验证的扩展。

权限脚本是迁移交付物：运行角色对customers/activities/users/teams拥有所需SELECT/INSERT/UPDATE，对follow_ups/customer_status_events/audit_logs只允许SELECT/INSERT，不能UPDATE/DELETE历史；tenant/migrations只读。sessions/idempotency_keys的过期删除由独立受限维护脚本完成，应用只创建、读取或按约定更新；所有业务表不授予物理DELETE。迁移角色独立保管，应用不得继承它。测试须直接以运行角色验证拒绝修改审计、拒绝DDL及拒绝访问旧库。

## 6. 认证、安全与请求约定

密码使用 scrypt（可复用现有经验证参数），只存哈希；初始化密码至少 14 字符，不能记录明文。会话采用 32 字节以上随机 token，库内只存 token 哈希。
生产 Cookie 为 `__Host-sales_workbench`，配置 `Secure; HttpOnly; SameSite=Strict; Path=/`，不设置 Domain。建议有效期 8 小时，登录轮换 token；退出、停用、重置密码、改密、角色变化撤销旧会话。
每次请求同时检查用户启用状态、会话过期/撤销状态与 `sessionVersion`，角色和团队从当前数据库读取，不长期缓存过期权限。首次改密账号只能访问认证相关接口。
`GET /auth/csrf` 返回当前会话的 CSRF token，变更请求使用 `X-CSRF-Token`，同时验证精确 Origin 与 Fetch Metadata；登录接口无登录态 token，单独执行精确 Origin/Fetch Metadata 校验和限流，防止登录 CSRF。
CSRF token 定义为 `base64url(HMAC-SHA256(CSRF_SECRET,原始session token))`；登录时保存此值的 SHA-256 到 csrf_hash。GET 使用请求 Cookie 中已验证的原始 token 重算返回，写请求对提交值的 SHA-256 与 csrf_hash 做固定时间比较。CSRF_SECRET 使用独立32字节以上随机密钥，轮换时撤销现有会话；不与密码或其他用途复用。接口返回 `Cache-Control: no-store`。
只信任本机反向代理，Nginx 覆盖转发来源头。登录限流按账号/IP组合并有整体并发上限，日志不输出密码、Cookie、正文、电话、搜索关键词、数据库地址或初始化凭据。
所有 SQL 参数化；排序字段与枚举白名单。普通 body 上限建议 64 KiB。用户输入只作为数据，错误不暴露驱动栈与 SQL。

### 通用响应

```json
{
  "data": [],
  "meta": {
    "requestId": "req-123",
    "serverTime": "2026-11-11T02:00:00Z",
    "page": 1,
    "pageSize": 20,
    "total": 0
  }
}
```

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "记录已被更新，请刷新后重试"
  },
  "meta": { "requestId": "req-123", "serverTime": "2026-11-11T02:00:00Z" }
}
```

`fieldErrors` 可为 `{ "phone": ["请输入有效的大陆手机号"] }`。统一错误：400 请求结构错误、401 未登录/失效、403 无动作权限、404 资源不可见、409 版本/幂等冲突、422 字段或业务规则无效、429 限流、503 数据源不可用。
所有列表返回 `data` 数组与 `meta.page/pageSize/total`，默认 20、最大 100；非法分页拒绝。稳定排序追加 ID，默认不返回完整跟进数组或审计正文。
创建客户、创建活动、添加跟进、转客户必须提供 `Idempotency-Key`（UUID）。request_target是HTTP方法+规范化的具体资源路径（含实际UUID，不是路由模板），例如`POST /api/v1/customers/实际UUID/follow-ups`；摘要包含方法、路径与规范化JSON正文。相同作用域/键/目标但正文不同返回 `IDEMPOTENCY_CONFLICT`，不同资源不得误重放对方结果。
同一事务先插入processing占位；唯一键竞争等待先请求提交或回滚。竞争者发现已有completed记录时检查摘要、当前权限后重放，不执行业务；如先请求回滚，竞争者可以继续。占位、业务写入、审计、更新completed及结果在同一事务提交，禁止单独提交processing。失败整体回滚；锁等待超时返回可重试错误，不另造幂等键。建议保存24小时，客户端重试沿用原键。
所有幂等重放先重新认证和检查资源权限，不能在交接或降权后泄露旧响应。24 小时后重试须先查询结果，不能假定键仍防重。
PATCH/归档/恢复携带 `expectedVersion`；事务内验证并递增 `version`。409 后前端展示差异并要求重新提交，不能自动拿新版本覆盖旧编辑内容。

## 7. API 清单

下表省略公共前缀 `/api/v1`。所有业务接口需要已完成首次改密的有效登录态。

| 方法与路径                            | 作用与权限                                                      |
| ------------------------------------- | --------------------------------------------------------------- |
| `POST /auth/login`                    | `{username,password}`；返回用户摘要并设置 Cookie                |
| `POST /auth/logout`                   | 撤销当前会话；重复退出成功                                      |
| `GET /auth/me`                        | 用户、角色、团队、允许范围、`mustChangePassword`                |
| `GET /auth/csrf`                      | 获取当前登录会话 CSRF token                                     |
| `POST /auth/change-password`          | `{currentPassword,newPassword}`；改密并撤销会话，重新登录       |
| `GET /metadata`                       | 枚举、字段上限、公司时区、可用能力；不含凭据                    |
| `GET /dashboard`                      | 当前权限范围的客户、今日电销、阶段、待跟进、票量接入状态        |
| `GET /customers`                      | 搜索、来源/状态、归档、负责人、分页与排序                       |
| `POST /customers`                     | 客户建档，状态固定 added、负责人默认当前用户                    |
| `POST /customers/duplicate-check`     | `{phone,excludeCustomerId?}`；只返回可见重复客户摘要            |
| `GET /customers/:id`                  | 完整客户资料及 version，不包含全部跟进                          |
| `PATCH /customers/:id`                | `{expectedVersion,changes}`；只修改允许的资料字段               |
| `PATCH /customers/:id/status`         | `{expectedVersion,toStatus,confirmed:true,reason?}`             |
| `PATCH /customers/:id/owner`          | `{expectedVersion,ownerId,reason}`；主管团队内/管理员           |
| `POST /customers/:id/archive`         | `{expectedVersion,reason}`；软归档                              |
| `POST /customers/:id/restore`         | `{expectedVersion,reason}`；主管/管理员恢复                     |
| `GET /customers/:id/follow-ups`       | 时间线分页，按 occurredAt DESC、id DESC                         |
| `POST /customers/:id/follow-ups`      | 新增跟进，可原子更新提醒和逐级晋级                              |
| `GET /activities`                     | 电销/扫楼记录分页与组合筛选                                     |
| `GET /activities/summary`             | 全部记录、电销、扫楼、成功添加总数                              |
| `POST /activities`                    | 手工录入，发生时间服务端生成                                    |
| `GET /activities/:id`                 | 转客户前的预填数据、version 与转化状态                          |
| `POST /activities/:id/convert`        | 新建或关联客户，成功后才设置已转                                |
| `PATCH /activities/:id`               | `{expectedVersion,changes,reason}`；仅管理员纠错，审计原值      |
| `GET/POST /users`                     | 管理员分页查询/创建员工                                         |
| `GET /users/:id/impact`               | 管理员查看调组/停用影响：版本、团队、未归档/归档客户数、活动数  |
| `PATCH /users/:id`                    | 管理员修改姓名、团队、角色、启用状态，含 expectedVersion/reason |
| `POST /users/:id/reset-password`      | 管理员重置临时密码、要求改密、撤销全部会话；含 reason           |
| `GET/POST /teams`, `PATCH /teams/:id` | 管理员管理团队；有在职成员的团队不能直接停用                    |
| `GET /audit-logs`                     | 管理员按实体/操作人/时间分页查审计                              |

创建员工 `{username,displayName,role,teamId?}` 返回 `{user,temporaryPassword}`；重置密码 `{expectedVersion,reason}` 返回一次性 `temporaryPassword`。临时密码服务端生成、仅哈希落库，不存入幂等响应缓存；响应丢失只能再次重置。用户名唯一约束防止重复建号，409时引导打开员工详情。
一期不提供公开找回密码接口。管理员重置密码必须同时通过有效会话、管理员角色、CSRF、Origin、版本与原因校验，重置立即撤销目标用户会话；审计不记录临时密码或哈希。
团队创建 `{name}`、修改 `{expectedVersion,changes:{name?,enabled?},reason}`；用户修改采用 `{expectedVersion,changes:{displayName?,role?,teamId?,enabled?},reason}`。管理员不能停用/降权公司最后一个启用管理员，团队不提供物理删除。
组织变更不能只靠expectedVersion：事务先取得按公司隔离的事务咨询锁，再按UUID顺序锁涉及的团队和用户，重算启用管理员数、团队成员及调组影响；没有启用管理员或将启用成员加入停用团队时拒绝提交。统一使用`SELECT pg_advisory_xact_lock(hashtextextended('sales_workbench:org:' || $1, 0))`，$1为服务端认定的tenant_id。保持tenants只读，不能对它使用需要UPDATE权限的FOR UPDATE。锁在事务结束时释放，所有创建/启用/调组/角色变更/停用路径遵守同一锁顺序；公司级锁只用于组织管理，不用于每条销售录入。
影响查询返回`data:{userId,version,teamId,activeCustomerCount,archivedCustomerCount,activityCount}`，只用于操作前展示；实际修改在锁内重新检查，不把旧计数当授权或并发保证。
角色与负责人选择需要员工候选：`GET /assignees` 返回操作者可交接范围内的启用用户 `{id,displayName,teamId}`，不开放管理员 `/users` 的密码/登录状态等信息。
健康检查使用独立 `/health/live` 与 `/health/ready`，不带 `/api/v1`；前者进程存活，后者检查数据库与最低迁移版本，公开仅返回简洁状态。

### 筛选与返回口径

客户查询支持 `keyword,status,statusGte,source,ownerId,teamId,scope,archived,reminder,sort,page,pageSize`；`status` 与 `statusGte` 互斥。`statusGte=opened` 同时匹配 opened/shipped，供“开户客户”卡下钻；`archived=true` 列表仅主管/管理员。
`sort` 仅 `lastFollowAt:desc`、`nextFollowAt:asc`、`status:asc`、`createdAt:desc`；状态按 added→opened→shipped 显式序号排序，不能按英文字符排序。null 跟进时间排末尾，来源/状态为单选，搜索匹配客户名、电话、联系人。
活动支持 `keyword,types,results,nextJudges,dateFrom,dateTo,ownerId,teamId,scope,page,pageSize`；多选数组用重复参数，如 `types=call&types=visit`。同字段 OR，不同字段 AND，空数组表示不限制。
`dateFrom`/`dateTo` 为 ISO 8601 带时区时间、开始含结束不含；日期选择转换为上海日界。“今日”即当日00:00至次日00:00。搜索匹配客户名、电话、地址，默认 occurredAt DESC、id DESC；未选择日期时为所有日期。
API 查询可使用编码后的 keyword，但访问日志必须去掉完整查询串；浏览器地址栏、历史记录、分享链接不保存 keyword。其他筛选与资源 ID 可进入页面 URL。
汇总页统计卡仅使用当前 scope/teamId/ownerId 范围，忽略列表的日期、keyword、类型、结果、判断筛选；列表显示独立筛选结果数，前端明确“全部记录总览”。点击卡片先清除原列表筛选再应用该预设，“全部”卡清空全部列表条件但保留权限范围。`GET /activities/summary` 的data固定为 `{total,calls,visits,contactAdded}` 四个整数，data非数组；dashboard支持同一组范围参数。

### 请求示例

```text
POST /api/v1/customers
{"name":"示例客户","phone":"13800000000","contact":"联系人","source":"call","highIntent":false}

PATCH /api/v1/customers/客户UUID
{"expectedVersion":3,"changes":{"contact":"新联系人","needs":"美线整柜咨询","nextFollowAt":null}}

POST /api/v1/customers/客户UUID/follow-ups
{"expectedVersion":3,"action":"order","content":"客户确认下单，已核对开户情况","nextFollowAt":"2026-11-13T10:00:00+08:00","statusChange":{"toStatus":"opened","confirmed":true}}

POST /api/v1/activities
{"type":"visit","customerName":"示例客户","address":"深圳市某园区","phone":"","result":"contact_added","nextJudge":"revisit","note":"已添加微信，待补充手机"}

POST /api/v1/activities/活动UUID/convert
{"expectedVersion":1,"mode":"create","customer":{"name":"示例客户","phone":"13800000000","address":"深圳市某园区"}}

POST /api/v1/activities/活动UUID/convert
{"expectedVersion":1,"mode":"link","customerId":"客户UUID"}
```

示例姓名和号码仅用于说明格式，不导入生产。实际 HTTP body 不包含示例中的方法/路径行。
客户普通 changes 允许 name/contact/phone/altPhone/wechat/email/source/address/needs/note/highIntent/nextFollowAt；不允许 status/ownerId/归档/创建人/时间/version。
转化 `customer` 接受上述资料但不接受 source、status、ownerId、nextFollowAt；source 从活动type派生，status=added。mode=create的请求顶层可有ownerId，但仅主管/管理员可指定其授权范围内的启用员工；省略时沿用活动录入人。若原录入人停用且未指定新负责人，返回422 `OWNER_INACTIVE`，要求选择负责人后重试。活动原录入人保持不变，不能自动占为操作者自己。mode=link不接受ownerId、不改变已有客户归属。
客户创建/修改/状态变更返回完整客户；新增跟进返回 `{followUp,customer}`；转化返回 `{activity,customer}`；归档恢复返回客户；活动纠错返回活动。统一均放入 `data`。
客户去重返回 `data:{duplicates:[{id,name,archived}]}`，只包含可见记录；没有可见重复时返回空数组，不另给“其他团队存在重复”的提示。重复不会阻断保存。
活动返回 `convertedCustomerId,convertedAt,convertedBy` 及派生 `converted`；目标不可见时屏蔽 ID 并返回 `customerLinkVisible:false`。成功添加联系方式和成功转客户分别统计。

## 8. 事务、状态与并发实现

创建/修改统一流程：认证 → 动作权限 → 参数校验 → 开事务 → 重查资源范围/版本 → 更新 → 审计 → 幂等结果 → 提交。响应发送失败后客户端可同键重试。
权限检查与修改必须在同一事务内保持一致：锁定操作者、目标负责人和业务记录，或在 UPDATE 条件中重新约束当前团队/owner；不能检查后再用裸 ID 更新。
给客户建立或恢复有效负责人时，事务持有涉及用户行的`FOR SHARE`锁并重查enabled；不能用无法阻止普通字段更新的FOR KEY SHARE替代。人员停用/调组更新同一行须等待该锁。业务记录操作与用户变更按统一锁顺序实施，避免检查负责人后其被停用仍产生新分配。用户锁按UUID排序；已有客户/活动的锁序固定，创建新客户的转化可在用户锁之后先锁活动。真实PostgreSQL需验证这些并发场景，CHECK本身不能实现跨行串行化。

### 客户状态

新客户固定 added。正向只能 added→opened→shipped，一步一确认，不能直接 added→shipped。历史已开户/走货客户也先建档后逐级确认；本期不引入导入豁免。
`PATCH /status` 必须 `confirmed:true`；正向 reason 可选，回退仅主管/管理员且 reason 必填。回退可以到更早阶段，但必须保留完整原/新状态事件。
跟进 `action=order` 可以附带 `statusChange`，仅允许一步正向、confirmed=true；其他 action 不允许附带 statusChange。未附带时只记跟进，不改状态。
“已走货”是人工登记的客户业务阶段，不由下单文字自动推断，也不生成销售票量。状态事件、客户版本、跟进、提醒和审计在同一事务提交。

### 转客户

首先重新认证并检查成功幂等键是否可安全重放；没有成功结果时开事务锁定活动，验证可见范围与type/result，只有 `contact_added` 可转换。先处理下述“已转换”分支；仅对未转换活动校验expectedVersion，再执行创建/关联。`mode=create` 校验客户完整必填项；扫楼无手机号时先补，不用微信号代替手机号。
`mode=link` 验证目标客户存在、未归档且操作者可编辑；不覆写目标资料/状态/source/owner。两个对象均需授权，不能利用转换接口读取他人客户。
创建客户或关联成功后更新 converted 字段、版本与审计。任何一步失败全部回滚；关闭页面、取消表单或预填请求不会写“已转”。
已转换活动同键同内容重试且仍有权限时返回原结果。新键的mode=link仅在customerId与已关联目标相同且当前可编辑该客户时返回当前结果，不再校验转换前的旧版本。新键mode=create或link其他目标一律返回409 `ALREADY_CONVERTED`，不创建、不替换；前端重读活动并按当前权限显示现有关联。错误正文不带不可见客户资料。活动行锁保证两个并发新建只产生一个客户，第二个请求按上述已转换分支处理。
已转活动不可通过纠错修改 type/result 或转换关联；只允许管理员更正名字/电话/地址/判断/备注，不反向同步客户。撤销关联属于后续独立流程。

### 跟进、归档与交接

新增跟进永远追加，更新lastFollowAt时使用`GREATEST(现值,本次occurredAt)`，避免事务等待后较早的时间覆盖较新的时间；同事务写入跟进与客户。nextFollowAt缺省不变、null清除、有值设置；follow_ups.reminder_action保存这三种语义。普通PATCH直接改提醒同样记录审计，不伪造一条沟通跟进。
归档客户停止出现在默认列表、KPI 和待跟进，禁止新增跟进/转换关联，但历史完整保留；恢复后保留原状态/提醒，可能立即显示逾期。
交接写 owner 变更、原因与审计；并发打开的原负责人编辑页因版本冲突或权限变化拒绝保存。活动归属不自动随客户转移。
管理员纠错活动使用 expectedVersion、字段白名单和 reason；记录完整差异，不物理删除。联系人与备注变更不触发任何电话或消息发送。

## 9. 工作台统计合同

所有统计由后端在同一权限范围下计算，返回 `scope,timeZone,asOf`，避免前端只对当前页数组计算 KPI。公司时区固定 Asia/Shanghai。
一次dashboard请求使用只读一致性快照（例如短REPEATABLE READ事务），避免并发写入造成卡片与阶段总数在同一响应中不相等；不同请求之间真实新增导致数量变化是正常行为，前端以asOf提示数据时间。

| 指标                               | 计算规则                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `customers.total`                  | 未归档客户档案ID数，不是去重企业数                                                    |
| `customers.opened`                 | 当前 opened + shipped，累计口径；下钻 statusGte=opened                                |
| `customers.shipped`                | 当前 shipped；下钻 status=shipped                                                     |
| `customers.openedRate/shippedRate` | 对 total 的百分比；total=0 时 null，前端“—”                                           |
| `stages.added/opened/shipped`      | 三个互斥的当前状态数量，总和=total；标注“当前阶段分布”                                |
| `todayCalls.total`                 | 上海当日 type=call 活动条数，不去重电话，不含扫楼                                     |
| `todayCalls.contactAdded`          | 上述范围内 result=contact_added 条数                                                  |
| `todayCalls.rate`                  | contactAdded/total×100；total=0 时 null；不是转客户率                                 |
| `pendingFollowUps`                 | 未归档、有 nextFollowAt，全部逾期+今日+未来7个自然日，时间升序，首页取前4，另返回总数 |
| `shipmentVolume`                   | 没有接入来源时 dataStatus=not_connected，total/buckets=null，不伪装成0                |

逾期定义 nextFollowAt < asOf，不能丢掉逾期一天以上的客户。首页“更多”跳到相同范围的 `GET /customers?reminder=due_soon`；统一查询 nextFollowAt < 上海当天起点加8日，无下界，覆盖未来第7日全天。
建议 `GET /dashboard` 返回：

```json
{
  "data": {
    "scope": "mine",
    "timeZone": "Asia/Shanghai",
    "asOf": "2026-11-11T02:00:00Z",
    "customers": {
      "total": 0,
      "opened": 0,
      "shipped": 0,
      "openedRate": null,
      "shippedRate": null
    },
    "stages": { "added": 0, "opened": 0, "shipped": 0 },
    "todayCalls": { "total": 0, "contactAdded": 0, "rate": null },
    "pendingFollowUps": { "items": [], "total": 0 },
    "shipmentVolume": {
      "dataStatus": "not_connected",
      "week": { "total": null, "buckets": null },
      "month": { "total": null, "buckets": null }
    }
  },
  "meta": { "requestId": "req-123", "serverTime": "2026-11-11T02:00:00Z" }
}
```

二期接入后，真实无业务返回 dataStatus=ready、total=0 和补零日期桶；失败返回 dataStatus=unavailable、null，不与真实0混淆。单位必须明确“票”。
周统计按周一至周日7个自然日，月统计按本月与自然周相交形成4–6个桶，首尾截断到月界，不硬编码4周；当日高亮按真实日期判断。
现有运输表没有销售客户/负责人归属，现有柜数、批次和公开时效样本不能直接成为本图数据源。接入前须确定唯一票号、走货业务日、客户/销售归属、取消/重复规则。

## 10. 发布、备份与运行维护

拟发布目录 `/opt/sales-workbench/releases/<version>/` 与 `current` 链接；配置 `/etc/sales-workbench/api.env`，只允许受限运维账号读取，不写入 Git 或前端构建产物。
配置项至少包括 NODE_ENV、PORT、DATABASE_URL、APP_ORIGIN、TENANT_ID、CSRF_SECRET、LOG_LEVEL；原始会话 token 使用安全随机生成并只存哈希，无需额外签名密钥。实际值通过受限文件提供，不写入本文或命令参数。
新站点不覆盖现有 Nginx server block、systemd 服务、数据库角色和运维目录；创建前检查同名资源并人工比对。健康路径不能回退 SPA index.html。

1. 在本地/CI完成类型、契约、真实 PostgreSQL 集成、构建和浏览器验收，生成含校验值的版本包；不打包客户、凭据、测试数据库或备份。
2. 核验 ECS 余量、PostgreSQL 版本/连接数、DNS、3106端口及证书；域名与端口本文件仅为候选。
3. 创建隔离预发布库，执行新的 CRM 迁移与最小权限脚本，初始化测试账号并用虚构数据验证完整流程。
4. 建立生产独立库及角色，显式执行新迁移；不运行现有 `database/baseline/` 或 `009_admin.sql`，应用启动不迁移/seed。
5. 上线前完成备份恢复演练、首个管理员初始化、配置文件权限和登录/退出/越权检查；生产不导入原型示例。
6. 启用 HTTPS、服务开机自启、日志轮转、健康监控；通过版本链接切换发布，静态资源带内容摘要，入口 HTML 不长缓存。
7. 生产仅做授权只读验收与账号真实使用验证；新增/转化/并发写测试放隔离预发布。核对原有两个站点健康与运输统计未受影响。

建议试点备份策略：每日加密备份新库，保存7份日备份+4份周备份，异机/对象存储保留独立副本；上线前与每次结构变更前额外备份，每月恢复演练。
该策略是待落地目标，现有旧系统一次性备份不能算工作台已经有定时备份。试点目标 RPO≤24小时、RTO≤4小时须通过演练；若不能接受一天数据损失，在全员推广前增加 WAL/PITR 或更高频备份。
监控关注错误率、延时、数据库连接、磁盘/备份失败、证书到期、异常登录；告警接收人和渠道部署前确定。日志仅保留 requestId、路由模板、状态、耗时及必要内部ID。
代码回退：停止新写入，保存当前状态，确认数据库向后兼容后切回前一版本。不得为了回退代码删除 CRM 表或恢复旧备份覆盖试点新数据。
数据库回退必须另定恢复点、增量数据保留和补录方案；新迁移优先可兼容的新增字段，删除/重命名字段分阶段实施。

## 11. 验收与公司内部试点

| 场景       | 通过标准                                                                       |
| ---------- | ------------------------------------------------------------------------------ |
| 权限       | 两名销售互不可读写；主管仅本团队；管理员全公司；列表/详情/统计/去重/转换无旁路 |
| 账号       | 首次必须改密；停用、改密和角色变化立即撤销旧会话；服务重启仍按会话有效期工作   |
| 创建与并发 | 重复提交只创建一次；两个版本并发编辑一个成功、一个409，原数据不被静默覆盖      |
| 转化       | 取消不标已转；两人并发转化只生成一位客户；关联已有客户不覆写资料               |
| 状态       | 初建added；晋级一步确认；order只记跟进时不升级；销售不能回退；回退必须原因     |
| 统计       | 开户累计与下钻一致；阶段分布相加=总数；电销不混扫楼；零分母返回null            |
| 日期       | 上海午夜、周一、跨月/跨年、4/5/6周月桶、长期逾期和提醒清除均有测试             |
| 数据保留   | 归档后历史存在；恢复可查；交接后旧负责人失权；活动纠错有前后审计               |
| 部署       | 数据库故障不回退示例；备份可恢复；新应用不能写旧运输库；既有站点兼容           |

性能先以50名员工、10万客户、100万接触记录的隔离合成数据测量，建议目标为20并发下常见列表 p95≤1秒、仪表盘 p95≤2秒（不含公网传输）；这是测试目标，达不到时先优化或调整容量，不宣称已支持。
测试组合：Vitest 单元/服务测试、真实 PostgreSQL 约束与权限测试、Playwright 核心链路；不能仅依赖内存数据库证明生产权限正确。发布流程必须经过备份恢复及跨角色验收。
先由2–5位销售和1位主管试用3–5个工作日，准备个人账户、访问入口和一页操作指引：录记录→转客户→写跟进→设提醒→查看工作台。
每日记录登录成功、首次建档、首条跟进、录入失败、误转化、统计争议等反馈；主管指定业务规则负责人，管理员负责账号/故障反馈。推广内容不包含真实客户截图或共享密码。
全员推广条件：无阻断登录/保存问题、无越权、核心流程可复现、备份恢复成功、统计口径确认。通知同事和发送邀请属于后续推广动作，本轮仅规划，不发送消息。

## 12. 实施前待确认与顺序

待确认：团队与主管名单、是否采用本人/团队数据隔离、状态回退权限、手机号码范围、提醒10:00默认值、首批试点人员、数据保留期限、备份目标及真实走货来源。
域名 `sales.omfreight.vip`、端口3106、资源余量与部署账户需要实施时核验；这些不阻碍先按基线开发本地演示与接口，但生产发布必须据实际环境调整。
开发顺序：共享契约/数据库 → 多账号登录与权限 → 客户/跟进/状态 → 活动/事务转化 → 真实统计与未接入状态 → 管理账号/交接/审计 → 验收/部署/试点。
每阶段都同步前端契约和业务验收，不以“页面可点”代替数据持久化与权限验证。完成实施后记录实际版本、迁移、部署结果和剩余限制，更新本文件状态。
