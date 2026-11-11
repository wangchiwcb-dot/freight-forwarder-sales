import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  AuditOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Link, useParams } from "react-router-dom";
import type { Dayjs } from "dayjs";
import { useApi, useWrite, queryString, ApiError, request } from "../api";
import { useWork, useUnsaved } from "../context";
import {
  type User,
  type Team,
  type Impact,
  type Audit,
  type Role,
  type Assignee,
  statusLabels,
  sourceLabels,
  resultLabels,
  judgeLabels,
  actionLabels,
  roleLabels,
  options,
} from "../model";
import {
  Blank,
  ErrorNotice,
  formatDate,
  Loading,
  PageHead,
  Pager,
  ReasonModal,
  useDebounce,
  useMobile,
} from "../components/Common";
export function AdministrationPage() {
  const { section } = useParams();
  if (section === "teams") return <TeamsPage />;
  if (section === "audit") return <AuditPage />;
  return <UsersPage />;
}
interface UserValues {
  username: string;
  displayName: string;
  role: Role;
  teamId?: string;
  enabled: boolean;
  reason: string;
}
function UsersPage() {
  const { user, setDirty } = useWork();
  const { message, modal } = App.useApp();
  const [keyword, setKeyword] = useState("");
  const search = useDebounce(keyword);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [dirty, setLocalDirty] = useState(false);
  useUnsaved(dirty);
  const [secret, setSecret] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const [form] = Form.useForm<UserValues>();
  const [latestUser, setLatestUser] = useState<User | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const w = useWrite();
  const q = useApi<User[]>(
    ["users", user.id, search, page],
    "/users?" + queryString({ keyword: search, page }),
  );
  const teams = useApi<Team[]>(["teams", user.id], "/teams?pageSize=100");
  const target = editing && editing !== "new" ? editing : null;
  const impact = useApi<Impact>(
    ["user-impact", target?.id],
    "/users/" + target?.id + "/impact",
    !!target,
  );
  const formRole = Form.useWatch("role", form);
  useEffect(() => {
    setPage(1);
  }, [search]);
  function open(u: User | "new") {
    setLatestUser(null);
    setRefreshError(null);
    setEditing(u);
    setLocalDirty(false);
    w.clearError();
    form.resetFields();
    form.setFieldsValue(
      u === "new"
        ? { role: "sales", enabled: true }
        : {
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            teamId: u.teamId || undefined,
            enabled: u.enabled,
            reason: "",
          },
    );
  }
  function close() {
    const finish = () => {
      setLocalDirty(false);
      setDirty(false);
      setEditing(null);
    };
    if (dirty)
      modal.confirm({
        title: "放弃未保存的账号修改？",
        okText: "放弃",
        cancelText: "继续编辑",
        onOk: finish,
      });
    else finish();
  }
  async function save(v: UserValues) {
    try {
      if (editing === "new") {
        const r = await w.write<{ user: User; temporaryPassword: string }>(
          "/users",
          {
            username: v.username.trim(),
            displayName: v.displayName.trim(),
            role: v.role,
            ...(v.teamId ? { teamId: v.teamId } : {}),
          },
        );
        setSecret({
          username: r.data.user.username,
          password: r.data.temporaryPassword,
        });
      } else if (target) {
        const values = {
          displayName: v.displayName.trim(),
          role: v.role,
          teamId: v.teamId || null,
          enabled: v.enabled,
        };
        const changes = Object.fromEntries(
          Object.entries(values).filter(
            ([key, value]) => value !== target[key as keyof User],
          ),
        );
        if (!Object.keys(changes).length) {
          void message.info("未修改账号内容，无需保存。");
          return;
        }
        await w.write(
          "/users/" + target.id,
          { expectedVersion: target.version, changes, reason: v.reason },
          "PATCH",
        );
        void message.success("员工账号已更新");
      }
      setLocalDirty(false);
      setDirty(false);
      setEditing(null);
    } catch (e) {
      if (e instanceof ApiError && e.fieldErrors)
        form.setFields(
          Object.entries(e.fieldErrors).map(([name, errors]) => ({
            name,
            errors,
          })) as Parameters<typeof form.setFields>[0],
        );
    }
  }
  async function refreshUser() {
    if (!target) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latest = await request<User>("/users/" + target.id);
      setLatestUser(latest.data);
      setEditing({ ...target, version: latest.data.version });
      await impact.refetch();
      w.clearError();
    } catch (e) {
      setRefreshError(e as Error);
    } finally {
      setRefreshing(false);
    }
  }
  async function reset(reason: string) {
    if (!resetting) return;
    const r = await w.write<{ temporaryPassword: string }>(
      "/users/" + resetting.id + "/reset-password",
      { expectedVersion: resetting.version, reason },
    );
    setSecret({
      username: resetting.username,
      password: r.data.temporaryPassword,
    });
    setResetting(null);
  }
  return (
    <>
      <PageHead
        title="员工管理"
        description="每位同事使用独立账号，客户与记录按角色和团队分配"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => open("new")}
          >
            新增员工
          </Button>
        }
      />
      <section className="panel">
        <div className="list-toolbar">
          <Input
            allowClear
            className="search-input"
            value={keyword}
            prefix={<SearchOutlined />}
            placeholder="搜索姓名或账号"
            aria-label="搜索员工"
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="list-count">
            共 {q.data?.meta.total || 0} 位员工
          </span>
        </div>
        <ErrorNotice error={q.error} retry={() => void q.refetch()} />
        {q.isLoading ? (
          <Loading />
        ) : (
          <Table<User>
            className="admin-table"
            dataSource={q.data?.data || []}
            rowKey="id"
            pagination={false}
            scroll={{ x: 720 }}
            columns={[
              {
                title: "员工",
                dataIndex: "displayName",
                render: (v: string, u: User) => (
                  <div>
                    <strong>{v}</strong>
                    <div className="cell-sub">{u.username}</div>
                  </div>
                ),
              },
              {
                title: "角色",
                dataIndex: "role",
                render: (v: Role) => roleLabels[v],
              },
              {
                title: "团队",
                dataIndex: "teamId",
                render: (v: string | null, u: User) =>
                  u.teamName ||
                  (teams.data?.data || []).find((t) => t.id === v)?.name ||
                  "—",
              },
              {
                title: "状态",
                dataIndex: "enabled",
                render: (v: boolean) => (
                  <Tag color={v ? "green" : undefined}>
                    {v ? "启用" : "停用"}
                  </Tag>
                ),
              },
              {
                title: "操作",
                key: "actions",
                render: (_: unknown, u: User) => (
                  <Space>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => open(u)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      icon={<KeyOutlined />}
                      onClick={() => {
                        w.clearError();
                        setResetting(u);
                      }}
                    >
                      重置密码
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}
        <Pager page={page} total={q.data?.meta.total || 0} onChange={setPage} />
      </section>
      <Modal
        title={editing === "new" ? "新增员工" : "编辑员工账号"}
        open={!!editing}
        onCancel={close}
        okText={editing === "new" ? "创建账号" : "保存修改"}
        onOk={() => form.submit()}
        confirmLoading={w.busy}
        okButtonProps={{ disabled: !!target && impact.isLoading }}
        destroyOnHidden
      >
        <ErrorNotice error={w.error || refreshError || impact.error} />
        {target && w.error instanceof ApiError && w.error.status === 409 ? (
          <Button
            className="spaced-bottom"
            loading={refreshing}
            onClick={() => void refreshUser()}
          >
            查看最新资料（保留当前输入）
          </Button>
        ) : null}
        {latestUser ? (
          <Alert
            className="spaced-bottom"
            type="warning"
            showIcon
            message="请核对最新账号后再保存"
            description={
              <div>
                {latestUser.displayName} · {roleLabels[latestUser.role]} ·{" "}
                {latestUser.teamName ||
                  (teams.data?.data || []).find(
                    (t) => t.id === latestUser.teamId,
                  )?.name ||
                  "无团队"}{" "}
                · {latestUser.enabled ? "启用" : "停用"}
                <br />
                当前输入已保留，再次保存只更新您修改的内容。
              </div>
            }
          />
        ) : null}
        {target && impact.data ? (
          <Alert
            className="spaced-bottom"
            type="info"
            showIcon
            message="当前管理范围"
            description={
              <span>
                未归档客户 {impact.data.data.activeCustomerCount} 位 · 归档客户{" "}
                {impact.data.data.archivedCustomerCount} 位 · 历史活动{" "}
                {impact.data.data.activityCount}{" "}
                条。调组会改变这些记录的团队可见范围；停用后请安排客户交接。
              </span>
            }
          />
        ) : null}
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => void save(v)}
          onValuesChange={() => setLocalDirty(true)}
        >
          <div className="form-grid">
            <Form.Item
              name="username"
              label="登录账号"
              rules={[{ required: true, whitespace: true }, { max: 100 }]}
            >
              <Input
                disabled={editing !== "new"}
                autoComplete="off"
                maxLength={100}
              />
            </Form.Item>
            <Form.Item
              name="displayName"
              label="员工姓名"
              rules={[{ required: true, whitespace: true }, { max: 100 }]}
            >
              <Input maxLength={100} />
            </Form.Item>
          </div>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={options(roleLabels)} />
          </Form.Item>
          <Form.Item
            name="teamId"
            label="所属团队"
            rules={[
              {
                required: formRole !== "admin",
                message: "销售和主管必须选择团队",
              },
            ]}
          >
            <Select
              allowClear
              placeholder="选择团队"
              options={(teams.data?.data || [])
                .filter((t) => t.enabled || t.id === target?.teamId)
                .map((t) => ({
                  value: t.id,
                  label: t.name + (t.enabled ? "" : "（已停用）"),
                  disabled: !t.enabled,
                }))}
            />
          </Form.Item>
          {editing !== "new" ? (
            <>
              <Form.Item
                name="enabled"
                label="账号启用"
                valuePropName="checked"
              >
                <Switch checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
              <Form.Item
                name="reason"
                label="修改原因"
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: "请填写账号调整原因",
                  },
                  { max: 500 },
                ]}
              >
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
              <p className="muted">
                停用立即撤销会话；角色或团队调整会重新检查权限。
              </p>
            </>
          ) : (
            <p className="muted">
              创建后生成临时密码，同事首次登录必须修改密码。
            </p>
          )}
        </Form>
      </Modal>
      <ReasonModal
        open={!!resetting}
        title="重置临时密码"
        description={`重置 ${resetting?.displayName || ""} 的密码后，现有登录会话立即失效。`}
        onCancel={() => setResetting(null)}
        onSubmit={reset}
        busy={w.busy}
        error={w.error}
      />
      <Modal
        open={!!secret}
        title="临时密码已生成"
        footer={
          <Button type="primary" onClick={() => setSecret(null)}>
            我已妥善记录
          </Button>
        }
        onCancel={() => setSecret(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="此密码只展示一次，请通过公司认可的方式交给本人。"
        />
        <Descriptions
          className="spaced-top"
          column={1}
          items={[
            { key: "u", label: "账号", children: secret?.username },
            {
              key: "p",
              label: "临时密码",
              children: (
                <Typography.Text code copyable>
                  {secret?.password}
                </Typography.Text>
              ),
            },
          ]}
        />
        <p className="muted">关闭后无法再次查看。如遗失，请重新重置。</p>
      </Modal>
    </>
  );
}
function TeamsPage() {
  const { user, setDirty } = useWork();
  const { message, modal } = App.useApp();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [dirty, setLocalDirty] = useState(false);
  useUnsaved(dirty);
  const [form] = Form.useForm<{
    name: string;
    enabled: boolean;
    reason: string;
  }>();
  const [latestTeam, setLatestTeam] = useState<Team | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const w = useWrite();
  const q = useApi<Team[]>(
    ["teams-management", user.id, page],
    "/teams?page=" + page,
  );
  function open(t: Team | "new") {
    setLatestTeam(null);
    setRefreshError(null);
    setEditing(t);
    form.resetFields();
    form.setFieldsValue(t === "new" ? { enabled: true } : t);
    setLocalDirty(false);
    w.clearError();
  }
  function close() {
    const finish = () => {
      setEditing(null);
      setLocalDirty(false);
      setDirty(false);
    };
    if (dirty)
      modal.confirm({
        title: "放弃未保存的团队修改？",
        onOk: finish,
        okText: "放弃",
        cancelText: "继续编辑",
      });
    else finish();
  }
  async function save(v: { name: string; enabled: boolean; reason: string }) {
    try {
      if (editing === "new") await w.write("/teams", { name: v.name.trim() });
      else if (editing) {
        const values = { name: v.name.trim(), enabled: v.enabled };
        const changes = Object.fromEntries(
          Object.entries(values).filter(
            ([key, value]) => value !== editing[key as keyof Team],
          ),
        );
        if (!Object.keys(changes).length) {
          void message.info("未修改团队内容，无需保存。");
          return;
        }
        await w.write(
          "/teams/" + editing.id,
          { expectedVersion: editing.version, changes, reason: v.reason },
          "PATCH",
        );
      }
      setDirty(false);
      setLocalDirty(false);
      setEditing(null);
      void message.success("团队已保存");
    } catch {
      /* shown */
    }
  }
  async function refreshTeam() {
    if (!editing || editing === "new") return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latest = await request<Team>("/teams/" + editing.id);
      setLatestTeam(latest.data);
      setEditing({ ...editing, version: latest.data.version });
      w.clearError();
    } catch (e) {
      setRefreshError(e as Error);
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <>
      <PageHead
        title="团队管理"
        description="按团队组织销售协作，历史归属与记录持续保留"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => open("new")}
          >
            新增团队
          </Button>
        }
      />
      <section className="panel">
        <ErrorNotice error={q.error} retry={() => void q.refetch()} />
        {q.isLoading ? (
          <Loading />
        ) : (
          <Table<Team>
            rowKey="id"
            dataSource={q.data?.data || []}
            pagination={false}
            columns={[
              { title: "团队名称", dataIndex: "name" },
              {
                title: "状态",
                dataIndex: "enabled",
                render: (v: boolean) => (
                  <Tag color={v ? "green" : undefined}>
                    {v ? "启用" : "停用"}
                  </Tag>
                ),
              },
              {
                title: "操作",
                key: "edit",
                render: (_: unknown, t: Team) => (
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => open(t)}
                  >
                    编辑
                  </Button>
                ),
              },
            ]}
          />
        )}
        <Pager page={page} total={q.data?.meta.total || 0} onChange={setPage} />
      </section>
      <Modal
        open={!!editing}
        title={editing === "new" ? "新增团队" : "编辑团队"}
        onCancel={close}
        onOk={() => form.submit()}
        confirmLoading={w.busy}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <ErrorNotice error={w.error || refreshError} />
        {editing &&
        editing !== "new" &&
        w.error instanceof ApiError &&
        w.error.status === 409 ? (
          <Button
            className="spaced-bottom"
            loading={refreshing}
            onClick={() => void refreshTeam()}
          >
            查看最新资料（保留当前输入）
          </Button>
        ) : null}
        {latestTeam ? (
          <Alert
            className="spaced-bottom"
            showIcon
            type="warning"
            message="请核对最新团队后再保存"
            description={`${latestTeam.name} · ${latestTeam.enabled ? "启用" : "停用"}。当前输入已保留，再次保存只更新您修改的内容。`}
          />
        ) : null}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setLocalDirty(true)}
          onFinish={(v) => void save(v)}
        >
          <Form.Item
            name="name"
            label="团队名称"
            rules={[{ required: true, whitespace: true }, { max: 100 }]}
          >
            <Input maxLength={100} />
          </Form.Item>
          {editing !== "new" ? (
            <>
              <Form.Item
                name="enabled"
                label="团队启用"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                name="reason"
                label="修改原因"
                rules={[{ required: true, whitespace: true }, { max: 500 }]}
              >
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
              <Alert
                showIcon
                type="info"
                message="团队内仍有启用员工时不能停用，请先调整成员。"
              />
            </>
          ) : null}
        </Form>
      </Modal>
    </>
  );
}
const entities: Record<string, string> = {
  customer: "客户",
  customers: "客户",
  activity: "沟通记录",
  activities: "沟通记录",
  follow_up: "跟进",
  follow_ups: "跟进",
  user: "员工",
  users: "员工",
  team: "团队",
  teams: "团队",
  session: "登录会话",
};
const fields: Record<string, string> = {
  name: "名称",
  contact: "联系人",
  phone: "电话",
  altPhone: "备用电话",
  email: "邮箱",
  wechat: "微信",
  source: "来源",
  status: "阶段",
  ownerId: "负责人",
  note: "备注",
  needs: "主营/需求",
  address: "地址",
  highIntent: "高意向",
  nextFollowAt: "下次跟进",
  archivedAt: "归档时间",
  displayName: "员工姓名",
  role: "角色",
  teamId: "团队",
  enabled: "启用",
  type: "类型",
  customerName: "客户名称",
  result: "沟通结果",
  nextJudge: "下次判断",
  convertedCustomerId: "关联客户",
  customerId: "关联客户",
  activityId: "来源记录",
  ownerName: "负责人",
  actorId: "记录人",
  actorName: "记录人",
  username: "登录账号",
  teamName: "团队",
  content: "跟进内容",
  action: "跟进动作",
  reminderAction: "提醒安排",
  lastFollowAt: "最近跟进时间",
  occurredAt: "沟通时间",
  convertedAt: "转客户时间",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  reason: "原因",
};
const actionNames: Record<string, string> = {
  create: "新增",
  provision_team: "批量开通团队账号",
  update: "修改",
  archive: "归档",
  restore: "恢复",
  transfer: "转交",
  status: "阶段变更",
  status_change: "阶段变更",
  correct: "更正沟通记录",
  create_from_activity: "从沟通记录建档",
  convert: "转客户",
  follow_up: "新增跟进",
  login: "登录",
  logout: "退出",
  reset_password: "重置密码",
  change_password: "修改密码",
};
function AuditPage() {
  const { user } = useWork();
  const mobile = useMobile();
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<string>();
  const [action, setAction] = useState("");
  const searchedAction = useDebounce(action);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [selected, setSelected] = useState<Audit | null>(null);
  const q = useApi<Audit[]>(
    [
      "audit",
      user.id,
      page,
      entityType,
      searchedAction,
      range?.map((d) => d?.format()),
    ],
    "/audit-logs?" +
      queryString({
        page,
        entityType,
        action: searchedAction,
        dateFrom: range?.[0]?.startOf("day").format(),
        dateTo: range?.[1]?.startOf("day").add(1, "day").format(),
      }),
  );
  useEffect(() => {
    setPage(1);
  }, [entityType, searchedAction, range]);
  return (
    <>
      <PageHead
        title="操作审计"
        description="查看资料更正、归档、交接及账号调整的操作历史"
      />
      <section className="panel">
        <div className="list-toolbar">
          <Select
            aria-label="审计对象类型"
            allowClear
            placeholder="全部对象"
            value={entityType}
            onChange={setEntityType}
            options={[
              { value: "customer", label: "客户" },
              { value: "activity", label: "沟通记录" },
              { value: "user", label: "员工" },
              { value: "team", label: "团队" },
            ]}
          />
          <Select
            allowClear
            placeholder="全部操作"
            aria-label="审计操作类型"
            value={action || undefined}
            onChange={(value) => setAction(value || "")}
            options={Object.entries(actionNames)
              .filter(([key]) => !["status", "follow_up"].includes(key))
              .map(([value, label]) => ({ value, label }))}
            style={{ width: 180 }}
          />
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => setRange(v)}
            aria-label="审计日期范围"
          />
          <Button
            onClick={() => {
              setEntityType(undefined);
              setAction("");
              setRange(null);
            }}
          >
            清除
          </Button>
        </div>
        <ErrorNotice error={q.error} retry={() => void q.refetch()} />
        {q.isLoading ? (
          <Loading />
        ) : (
          <Table<Audit>
            rowKey="id"
            dataSource={q.data?.data || []}
            pagination={false}
            scroll={{ x: 720 }}
            columns={[
              {
                title: "操作时间",
                dataIndex: "createdAt",
                render: (v: string) => formatDate(v),
              },
              {
                title: "操作者",
                dataIndex: "actorName",
                render: (v: string | null, a: Audit) =>
                  v || (a.actorId ? "员工" : "系统"),
              },
              {
                title: "对象",
                dataIndex: "entityType",
                render: (v: string) => entities[v] || "其他记录",
              },
              {
                title: "操作",
                dataIndex: "action",
                render: (v: string) => actionNames[v] || "其他操作",
              },
              {
                title: "原因",
                dataIndex: "reason",
                render: (v: string) => v || "—",
              },
              {
                title: "详情",
                key: "details",
                render: (_: unknown, a: Audit) => (
                  <Button
                    size="small"
                    icon={<AuditOutlined />}
                    onClick={() => setSelected(a)}
                  >
                    查看
                  </Button>
                ),
              },
            ]}
          />
        )}
        <Pager page={page} total={q.data?.meta.total || 0} onChange={setPage} />
      </section>
      <Drawer
        open={!!selected}
        title="操作详情"
        width={mobile ? "100%" : 620}
        placement={mobile ? "bottom" : "right"}
        height={mobile ? "94dvh" : undefined}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <>
            <Descriptions
              column={1}
              items={[
                {
                  key: "at",
                  label: "时间",
                  children: formatDate(selected.createdAt),
                },
                {
                  key: "actor",
                  label: "操作者",
                  children: selected.actorName || "系统",
                },
                {
                  key: "action",
                  label: "操作",
                  children: actionNames[selected.action] || "其他操作",
                },
                {
                  key: "reason",
                  label: "原因",
                  children: selected.reason || "—",
                },
              ]}
            />
            <h3 className="form-section-title">变更记录</h3>
            <AuditChanges entry={selected} />
            <p className="muted">记录编号：{selected.requestId}</p>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
function AuditChanges({ entry }: { entry: Audit }) {
  const { user } = useWork();
  const assignees = useApi<Assignee[]>(["assignees", user.id], "/assignees");
  const teams = useApi<Team[]>(["teams", user.id], "/teams?pageSize=100");
  const changes = entry.changes;
  const before =
    changes.before && typeof changes.before === "object"
      ? (changes.before as Record<string, unknown>)
      : {};
  const after =
    changes.after && typeof changes.after === "object"
      ? (changes.after as Record<string, unknown>)
      : {};
  const labels: Record<string, Record<string, string>> = {
    status: statusLabels,
    source: sourceLabels,
    role: roleLabels,
    result: resultLabels,
    nextJudge: judgeLabels,
    action: actionLabels,
    type: { call: "电销", visit: "扫楼" },
    reminderAction: {
      unchanged: "保持原安排",
      set: "设置提醒",
      clear: "取消提醒",
    },
  };
  const value = (
    key: string,
    v: unknown,
    row: Record<string, unknown> = {},
  ) => {
    if (v === null || v === undefined || v === "") return "—";
    if (key === "customerId" || key === "convertedCustomerId")
      return <Link to={"/customers/" + String(v)}>查看关联客户</Link>;
    if (key === "activityId")
      return <Link to={"/call-records/" + String(v)}>查看来源记录</Link>;
    if (key === "ownerId" || key === "actorId")
      return String(
        row.ownerName ||
          row.actorName ||
          assignees.data?.data.find((a) => a.id === v)?.displayName ||
          "员工编号 …" + String(v).slice(-6),
      );
    if (key === "teamId")
      return String(
        row.teamName ||
          teams.data?.data.find((t) => t.id === v)?.name ||
          "团队编号 …" + String(v).slice(-6),
      );
    if (labels[key]) return labels[key][String(v)] || "—";
    if (key.endsWith("At") && typeof v === "string") return formatDate(v);
    if (typeof v === "boolean")
      return key === "enabled" ? (v ? "启用" : "停用") : v ? "是" : "否";
    return typeof v === "object" ? "已更新" : String(v);
  };
  const allowed = (key: string) =>
    key in fields && !(key === "source" && entry.entityType === "user");
  if (Object.keys(before).length || Object.keys(after).length) {
    const keys = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].filter(
      (key) =>
        allowed(key) &&
        before[key] !== after[key] &&
        !(key === "ownerId" && (before.ownerName || after.ownerName)) &&
        !(key === "actorId" && (before.actorName || after.actorName)) &&
        !(key === "teamId" && (before.teamName || after.teamName)),
    );
    return keys.length ? (
      <div className="audit-diff">
        {keys.map((key) => (
          <div key={key}>
            <strong>{fields[key]}</strong>
            <span className="old-value">{value(key, before[key], before)}</span>
            <span>→</span>
            <span>{value(key, after[key], after)}</span>
          </div>
        ))}
      </div>
    ) : (
      <Blank title="没有资料变更" />
    );
  }
  if ("before" in changes && "after" in changes) {
    const key = ["status", "status_change"].includes(entry.action)
      ? "status"
      : "archivedAt";
    return (
      <div className="audit-diff">
        <div>
          <strong>{fields[key]}</strong>
          <span className="old-value">{value(key, changes.before)}</span>
          <span>→</span>
          <span>{value(key, changes.after)}</span>
        </div>
      </div>
    );
  }
  const items = Object.entries(changes).filter(([key]) => allowed(key));
  return items.length ? (
    <Descriptions
      column={1}
      items={items.map(([key, v]) => ({
        key,
        label: fields[key],
        children: value(key, v),
      }))}
    />
  ) : (
    <Blank title="没有资料变更" />
  );
}
