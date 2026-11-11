import { useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
} from "antd";
import {
  CalendarOutlined,
  ClockCircleOutlined,
  EditOutlined,
  FlagFilled,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
  SendOutlined,
  SwapOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { Dayjs } from "dayjs";
import { useQueryClient } from "@tanstack/react-query";
import {
  customerCreateSchema,
  followUpSchema,
  convertSchema,
  type CustomerInput,
} from "../../shared/contracts";
import { ApiError, request, useApi, useWrite, queryString } from "../api";
import { useWork, useUnsaved } from "../context";
import {
  type Activity,
  type Assignee,
  type Customer,
  type FollowUp,
  type FollowAction,
  type Status,
  type Source,
  statusLabels,
  sourceLabels,
  actionLabels,
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
  shanghai,
  SourceTag,
  StatusBadge,
  useDebounce,
  useMobile,
} from "../components/Common";
const emptyCustomer: CustomerInput = {
  name: "",
  contact: "",
  phone: "",
  altPhone: "",
  wechat: "",
  email: "",
  source: "call",
  address: "",
  needs: "",
  note: "",
  highIntent: false,
};
const customerFieldLabels: Record<keyof CustomerInput, string> = {
  name: "客户名称",
  contact: "联系人",
  phone: "联系电话",
  altPhone: "备用电话",
  wechat: "微信号",
  email: "邮箱",
  source: "客户来源",
  address: "客户地址",
  needs: "主营 / 需求",
  note: "备注",
  highIntent: "高意向",
};
const fields = Object.keys(emptyCustomer) as (keyof CustomerInput)[];
function customerValues(c: Partial<Customer> | CustomerInput): CustomerInput {
  return Object.fromEntries(
    fields.map((k) => [k, c[k] ?? emptyCustomer[k]]),
  ) as CustomerInput;
}
export function CustomersPage() {
  const { user, scope } = useWork();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  const search = useDebounce(keyword);
  const [prevSearch, setPrevSearch] = useState(search);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const rawStatus = params.get("status");
  const status = rawStatus && rawStatus in statusLabels ? rawStatus : undefined;
  const source = params.get("source") || undefined;
  const archived = params.get("archived") === "true";
  const reminder = params.get("reminder") || undefined;
  useEffect(() => {
    if (search !== prevSearch) {
      setPrevSearch(search);
      const q = new URLSearchParams(params);
      q.delete("page");
      setParams(q, { replace: true });
    }
  }, [search, prevSearch, params, setParams]);
  const query = useApi<Customer[]>(
    [
      "customers",
      user.id,
      scope,
      {
        keyword: search,
        status,
        statusGte: params.get("statusGte"),
        source,
        archived,
        reminder,
        sort: params.get("sort"),
        page,
      },
    ],
    "/customers?" +
      queryString({
        ...scope,
        keyword: search,
        status,
        statusGte: status ? undefined : params.get("statusGte") || undefined,
        source,
        archived,
        reminder,
        sort: params.get("sort") || "lastFollowAt:desc",
        page,
      }),
  );
  const records = query.data?.data || [];
  const total = query.data?.meta.total || 0;
  const rest = (useParams()["*"] || "").split("/").filter(Boolean);
  const id = rest[0] && rest[0] !== "new" ? rest[0] : undefined;
  const editing = rest[0] === "new" || rest[1] === "edit";
  const change = (key: string, value?: string) => {
    const q = new URLSearchParams(params);
    q.delete("page");
    if (key === "status") q.delete("statusGte");
    if (value) q.set(key, value);
    else q.delete(key);
    setParams(q);
  };
  const clear = () => {
    setKeyword("");
    setParams({});
  };
  const listSearch = () => {
    const q = new URLSearchParams(params);
    q.delete("fromActivityId");
    return q.toString() ? "?" + q.toString() : "";
  };
  const close = () => navigate("/customers" + listSearch());
  const open = (customerId: string) =>
    navigate("/customers/" + customerId + listSearch());
  const columns = [
    {
      title: "客户",
      key: "name",
      render: (_: unknown, c: Customer) => (
        <div>
          <button className="table-link" onClick={() => open(c.id)}>
            {c.highIntent ? <FlagFilled className="intent-flag" /> : null}
            {c.name}
          </button>
          <div className="cell-sub">联系人：{c.contact || "—"}</div>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (s: Status) => <StatusBadge status={s} />,
    },
    {
      title: "来源",
      dataIndex: "source",
      render: (s: Source) => <SourceTag source={s} />,
    },
    {
      title: "联系电话",
      dataIndex: "phone",
      render: (p: string) => <span className="mono">{p}</span>,
    },
    {
      title: "最近跟进",
      dataIndex: "lastFollowAt",
      render: (v: string | null) => (
        <span className="date-cell">{formatDate(v)}</span>
      ),
    },
    {
      title: "跟进提醒",
      key: "next",
      render: (_: unknown, c: Customer) => <Reminder customer={c} />,
    },
    {
      title: "操作",
      key: "action",
      render: (_: unknown, c: Customer) => (
        <Button
          type="text"
          icon={c.archivedAt ? <FolderOpenOutlined /> : <EditOutlined />}
          aria-label={c.archivedAt ? "查看归档客户" : "编辑客户"}
          onClick={(e) => {
            e.stopPropagation();
            navigate(
              "/customers/" +
                c.id +
                (c.archivedAt ? "" : "/edit") +
                listSearch(),
            );
          }}
        />
      ),
    },
  ];
  return (
    <>
      <PageHead
        title="客户管理"
        description="把客户资料、沟通记录和下一次跟进放在一起"
        actions={
          <>
            {user.role !== "sales" ? (
              <Button
                icon={<FolderOpenOutlined />}
                onClick={() =>
                  change("archived", archived ? undefined : "true")
                }
              >
                {archived ? "返回客户列表" : "归档客户"}
              </Button>
            ) : null}
            <Link to={"/customers/new" + listSearch()}>
              <Button type="primary" icon={<PlusOutlined />}>
                新增客户
              </Button>
            </Link>
          </>
        }
      />
      <section className="panel customer-list-panel">
        <div className="list-toolbar">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索客户名称 / 电话 / 联系人"
            aria-label="搜索客户"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="search-input"
          />
          <span className="list-count">
            {archived ? "归档客户" : "客户列表"} <strong>{total}</strong> 位
          </span>
          <Select
            aria-label="客户排序"
            value={params.get("sort") || "lastFollowAt:desc"}
            onChange={(v) => change("sort", v)}
            options={[
              { value: "lastFollowAt:desc", label: "最近跟进优先" },
              { value: "nextFollowAt:asc", label: "下次跟进优先" },
              { value: "status:asc", label: "按客户状态" },
            ]}
          />
        </div>
        <div className="filter-rows">
          <div className="filter-row">
            <span className="filter-label">客户状态</span>
            <div className="filter-chips">
              <Button
                size="small"
                type={!status && !params.get("statusGte") ? "primary" : "text"}
                onClick={() => change("status")}
              >
                全部
              </Button>
              {options(statusLabels).map((o) => (
                <Button
                  size="small"
                  key={o.value}
                  type={status === o.value ? "primary" : "text"}
                  onClick={() => change("status", o.value)}
                >
                  {o.label}
                </Button>
              ))}
              {params.get("statusGte") ? (
                <Tag closable onClose={() => change("statusGte")}>
                  已开户及已走货
                </Tag>
              ) : null}
            </div>
          </div>
          <div className="filter-row">
            <span className="filter-label">客户来源</span>
            <div className="filter-chips">
              <Button
                size="small"
                type={!source ? "primary" : "text"}
                onClick={() => change("source")}
              >
                全部
              </Button>
              {options(sourceLabels).map((o) => (
                <Button
                  size="small"
                  key={o.value}
                  type={source === o.value ? "primary" : "text"}
                  onClick={() => change("source", o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
          {reminder ? (
            <div className="filter-row">
              <Tag closable color="orange" onClose={() => change("reminder")}>
                近期及逾期待跟进
              </Tag>
            </div>
          ) : null}
        </div>
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        {query.isLoading ? (
          <Loading />
        ) : records.length ? (
          <>
            <div className="desktop-table">
              <Table<Customer>
                rowKey="id"
                columns={columns}
                dataSource={records}
                pagination={false}
                size="middle"
                onRow={(c) => ({
                  onClick: () => open(c.id),
                  className: "clickable-row",
                })}
              />
            </div>
            <div className="mobile-cards">
              {records.map((c) => (
                <div className="customer-card" key={c.id}>
                  <div className="card-title">
                    <button className="table-link" onClick={() => open(c.id)}>
                      {c.highIntent ? (
                        <FlagFilled className="intent-flag" />
                      ) : null}
                      {c.name}
                    </button>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="card-meta">
                    <SourceTag source={c.source} />
                    <span>{c.contact || "未填写联系人"}</span>
                    <span className="mono">{c.phone}</span>
                  </div>
                  <div className="card-footer">
                    <Reminder customer={c} />
                    <Button size="small" onClick={() => open(c.id)}>
                      查看详情
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Pager
              total={total}
              page={page}
              onChange={(n) => {
                const q = new URLSearchParams(params);
                q.set("page", String(n));
                setParams(q);
              }}
            />
          </>
        ) : (
          <Blank
            title={
              search || status || source || reminder
                ? "无匹配结果"
                : archived
                  ? "暂无归档客户"
                  : "暂无客户"
            }
            description="可以调整筛选条件，或添加第一位客户。"
            action={
              <Space>
                <Button onClick={clear}>清除筛选</Button>
                <Button
                  type="primary"
                  onClick={() => navigate("/customers/new")}
                >
                  新增客户
                </Button>
              </Space>
            }
          />
        )}
      </section>
      {editing ? (
        <CustomerEditor
          key={id || params.get("fromActivityId") || "new"}
          id={id}
          activityId={params.get("fromActivityId") || undefined}
          onClose={close}
          onSaved={(customerId) =>
            navigate("/customers/" + customerId + listSearch())
          }
        />
      ) : id ? (
        <CustomerDetail
          key={id}
          id={id}
          onClose={close}
          onEdit={() => navigate("/customers/" + id + "/edit" + listSearch())}
        />
      ) : null}
    </>
  );
}
function Reminder({ customer }: { customer: Customer }) {
  const due = customer.nextFollowAt;
  if (!due)
    return (
      <span className="reminder muted">
        <ClockCircleOutlined /> 暂无安排
      </span>
    );
  const overdue = shanghai(due).isBefore(shanghai());
  return (
    <span className={`reminder ${overdue ? "overdue" : ""}`}>
      <CalendarOutlined /> {overdue ? "已逾期 · " : ""}
      {shanghai(due).format("M-DD HH:mm")}
    </span>
  );
}
function CustomerEditor({
  id,
  activityId,
  onClose,
  onSaved,
}: {
  id?: string;
  activityId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { user, setDirty } = useWork();
  const { message } = App.useApp();
  const mobile = useMobile();
  const [form] = Form.useForm<CustomerInput>();
  const [changed, setChanged] = useState(false);
  useUnsaved(changed);
  const [mode, setMode] = useState<"create" | "link">("create");
  const [ownerId, setOwnerId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [linkKeyword, setLinkKeyword] = useState("");
  const linkSearch = useDebounce(linkKeyword);
  const [duplicates, setDuplicates] = useState<
    { id: string; name: string; archived: boolean }[]
  >([]);
  const [localError, setLocalError] = useState<Error | null>(null);
  const [initialized, setInitialized] = useState(false);
  const baseline = useRef<CustomerInput>(emptyCustomer);
  const initialVersion = useRef<number | undefined>(undefined);
  const expectedVersion = useRef<number | undefined>(undefined);
  const w = useWrite();
  const customer = useApi<Customer>(
    ["customer", user.id, id],
    "/customers/" + id,
    !!id,
  );
  const activity = useApi<Activity>(
    ["activity", user.id, activityId],
    "/activities/" + activityId,
    !!activityId,
  );
  const assignees = useApi<Assignee[]>(
    ["assignees", user.id],
    "/assignees",
    !!activityId && user.role !== "sales",
  );
  const candidates = useApi<Customer[]>(
    ["convert-candidates", user.id, linkSearch],
    "/customers?" +
      queryString({
        keyword: linkSearch,
        scope:
          user.role === "admin"
            ? "company"
            : user.role === "manager"
              ? "team"
              : "mine",
        pageSize: 20,
      }),
    !!activityId && mode === "link",
  );
  useEffect(() => {
    if (initialized) return;
    if (id && !customer.data) return;
    if (activityId && !activity.data) return;
    const a = activity.data?.data;
    const initial = id
      ? customerValues(customer.data!.data)
      : a
        ? {
            ...emptyCustomer,
            name: a.customerName,
            phone: a.phone,
            address: a.address,
            source: a.type,
          }
        : emptyCustomer;
    baseline.current = initial;
    initialVersion.current = customer.data?.data.version;
    expectedVersion.current = customer.data?.data.version;
    form.setFieldsValue(initial);
    setInitialized(true);
  }, [id, activityId, customer.data, activity.data, form, initialized]);
  async function duplicateCheck() {
    const phone = form.getFieldValue("phone")?.replace(/\s/g, "");
    if (!/^1[3-9]\d{9}$/.test(phone || "")) {
      setDuplicates([]);
      return;
    }
    try {
      const result = await request<{ duplicates: typeof duplicates }>(
        "/customers/duplicate-check",
        {
          method: "POST",
          body: JSON.stringify({ phone, excludeCustomerId: id }),
        },
      );
      setDuplicates(result.data.duplicates);
    } catch (e) {
      setLocalError(e as Error);
    }
  }
  const success = (customerId: string) => {
    setChanged(false);
    setDirty(false);
    void message.success(
      id ? "客户资料已保存" : activityId ? "已转为客户" : "客户已添加",
    );
    onSaved(customerId);
  };
  async function save(values: CustomerInput) {
    setLocalError(null);
    try {
      const parsed = customerCreateSchema.safeParse(customerValues(values));
      if (!parsed.success) {
        form.setFields(
          parsed.error.issues.map((i) => ({
            name: i.path,
            errors: [i.message],
          })) as Parameters<typeof form.setFields>[0],
        );
        form.scrollToField(parsed.error.issues[0].path as string[]);
        return;
      }
      if (id) {
        const c = customer.data!.data;
        const input = parsed.data;
        const changes = Object.fromEntries(
          fields
            .filter((k) => input[k] !== baseline.current[k])
            .map((k) => [k, input[k]]),
        );
        if (!Object.keys(changes).length) {
          success(id);
          return;
        }
        const r = await w.write<Customer>(
          "/customers/" + id,
          { expectedVersion: expectedVersion.current, changes },
          "PATCH",
        );
        success(r.data.id);
      } else if (activityId) {
        const a = activity.data!.data;
        const { source: _, ...customerInput } = parsed.data;
        const payload = {
          expectedVersion: a.version,
          mode: "create" as const,
          customer: customerInput,
          ...(ownerId ? { ownerId } : {}),
        };
        convertSchema.parse(payload);
        const r = await w.write<{ customer: Customer }>(
          "/activities/" + activityId + "/convert",
          payload,
          "POST",
          true,
        );
        success(r.data.customer.id);
      } else {
        const r = await w.write<Customer>(
          "/customers",
          parsed.data,
          "POST",
          true,
        );
        success(r.data.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.fieldErrors)
        form.setFields(
          Object.entries(e.fieldErrors).map(([name, errors]) => ({
            name,
            errors,
          })) as Parameters<typeof form.setFields>[0],
        );
      if (!(e instanceof ApiError)) setLocalError(e as Error);
    }
  }
  async function link() {
    if (!selectedId) {
      setLocalError(new Error("请选择要关联的客户"));
      return;
    }
    try {
      const r = await w.write<{ customer: Customer }>(
        "/activities/" + activityId + "/convert",
        {
          expectedVersion: activity.data!.data.version,
          mode: "link",
          customerId: selectedId,
        },
        "POST",
        true,
      );
      success(r.data.customer.id);
    } catch {
      /* retained by write */
    }
  }
  return (
    <Drawer
      open
      width={mobile ? "100%" : 660}
      placement={mobile ? "bottom" : "right"}
      height={mobile ? "94dvh" : undefined}
      title={
        <>
          <strong>
            {id ? "编辑客户" : activityId ? "转为客户" : "新增客户"}
          </strong>
          <div className="drawer-subtitle">
            {activityId
              ? "确认资料后建档，或关联已有客户"
              : "带 * 的项目为必填项"}
          </div>
        </>
      }
      onClose={onClose}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <span className="muted">
            {id ? "只保存本次修改的资料" : "新客户以「已添加」状态建档"}
          </span>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              loading={w.busy}
              disabled={!initialized || !!activity.data?.data.converted}
              onClick={() => (mode === "link" ? void link() : form.submit())}
            >
              {mode === "link" ? "确认关联" : "保存客户"}
            </Button>
          </Space>
        </div>
      }
    >
      <ErrorNotice
        error={customer.error || activity.error || localError || w.error}
      />
      {w.error instanceof ApiError && w.error.status === 409 ? (
        <Button
          className="spaced-bottom"
          onClick={() => {
            void (async () => {
              if (id) {
                const latest = await customer.refetch();
                if (latest.data)
                  expectedVersion.current = latest.data.data.version;
              }
              if (activityId) await activity.refetch();
              w.clearError();
              setLocalError(null);
            })();
          }}
        >
          查看最新资料（保留当前输入）
        </Button>
      ) : null}
      {id &&
      customer.data &&
      initialVersion.current !== customer.data.data.version ? (
        <Alert
          className="spaced-bottom"
          showIcon
          type="warning"
          message="其他同事更新了资料，请核对后再保存"
          description={
            <>
              <p>
                以下是同事更新后的资料。当前输入已保留，再次保存只更新您修改的内容。
              </p>
              {fields
                .filter((k) => customer.data!.data[k] !== baseline.current[k])
                .map((k) => (
                  <div key={k}>
                    <strong>{customerFieldLabels[k]}：</strong>
                    {typeof customer.data!.data[k] === "boolean"
                      ? customer.data!.data[k]
                        ? "是"
                        : "否"
                      : String(customer.data!.data[k] || "未填写")}
                  </div>
                ))}
            </>
          }
        />
      ) : null}
      {!initialized ? (
        <Loading />
      ) : (
        <>
          {activityId ? (
            <>
              <Radio.Group
                className="mode-switch"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setChanged(true);
                }}
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: "create", label: "新建客户" },
                  { value: "link", label: "关联已有客户" },
                ]}
              />
              {activity.data?.data.converted ? (
                <Alert
                  type="warning"
                  showIcon
                  message="这条记录已经转为客户"
                  description={
                    activity.data.data.customerLinkVisible &&
                    activity.data.data.convertedCustomerId ? (
                      <Link
                        to={
                          "/customers/" + activity.data.data.convertedCustomerId
                        }
                      >
                        查看已关联的客户
                      </Link>
                    ) : (
                      "当前无权查看已关联客户，请返回沟通记录。"
                    )
                  }
                />
              ) : null}
            </>
          ) : null}
          {mode === "link" ? (
            <>
              <Form layout="vertical">
                <Form.Item label="选择已有客户" required>
                  <Select
                    showSearch
                    filterOption={false}
                    placeholder="输入客户名称或手机号搜索"
                    onSearch={setLinkKeyword}
                    value={selectedId}
                    onChange={(v) => {
                      setSelectedId(v);
                      setChanged(true);
                    }}
                    loading={candidates.isLoading}
                    options={(candidates.data?.data || []).map((c) => ({
                      value: c.id,
                      label: `${c.name} · ${c.phone}`,
                    }))}
                  />
                  <p className="muted">
                    搜索您有权限维护的客户。关联不会覆盖客户资料。
                  </p>
                </Form.Item>
              </Form>
              <ErrorNotice error={candidates.error} />
            </>
          ) : (
            <Form
              form={form}
              layout="vertical"
              onFinish={(v) => void save(v)}
              onValuesChange={() => setChanged(true)}
              scrollToFirstError
            >
              <div className="form-section-title">基本资料</div>
              <div className="form-grid">
                <Form.Item
                  name="name"
                  label="客户名称"
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      message: "请填写客户名称",
                    },
                    { max: 200 },
                  ]}
                >
                  <Input placeholder="公司或客户名称" maxLength={200} />
                </Form.Item>
                <Form.Item name="contact" label="联系人">
                  <Input placeholder="联系人姓名" maxLength={100} />
                </Form.Item>
                <Form.Item
                  name="phone"
                  label="联系电话"
                  rules={[
                    { required: true, message: "请填写手机号码" },
                    {
                      validator: (_, v) =>
                        /^1[3-9]\d{9}$/.test(String(v || "").replace(/\s/g, ""))
                          ? Promise.resolve()
                          : Promise.reject(new Error("请输入有效的大陆手机号")),
                    },
                  ]}
                >
                  <Input
                    inputMode="tel"
                    placeholder="11位手机号码"
                    onBlur={() => void duplicateCheck()}
                  />
                </Form.Item>
                <Form.Item name="altPhone" label="备用电话">
                  <Input
                    inputMode="tel"
                    placeholder="手机或座机（可选）"
                    maxLength={50}
                  />
                </Form.Item>
                <Form.Item name="wechat" label="微信号">
                  <Input placeholder="微信号（可选）" maxLength={100} />
                </Form.Item>
                <Form.Item
                  name="email"
                  label="邮箱"
                  rules={[{ type: "email", message: "请输入有效邮箱" }]}
                >
                  <Input placeholder="邮箱（可选）" maxLength={254} />
                </Form.Item>
              </div>
              {duplicates.length ? (
                <Alert
                  className="spaced-bottom"
                  type="warning"
                  showIcon
                  message="发现相同联系方式"
                  description={
                    <>
                      {duplicates.map((d) => (
                        <div key={d.id}>
                          {d.name}
                          {d.archived ? "（已归档）" : ""}
                        </div>
                      ))}
                      <small>请核对是否已有客户。仍可继续保存新档案。</small>
                    </>
                  }
                />
              ) : null}
              <div className="form-section-title">客户分类</div>
              <Form.Item name="source" label="客户来源">
                <Radio.Group
                  optionType="button"
                  className="wrapped-radio"
                  options={options(sourceLabels)}
                  disabled={!!activityId}
                />
              </Form.Item>
              <div className="form-inline">
                <span>客户状态</span>
                <StatusBadge status={customer.data?.data.status || "added"} />
                <span className="muted">阶段变更请在客户详情操作</span>
              </div>
              <Form.Item name="highIntent" valuePropName="checked">
                <Checkbox>
                  <FlagFilled className="intent-flag" /> 高意向客户
                </Checkbox>
              </Form.Item>
              {activityId && user.role !== "sales" ? (
                <Form.Item label="客户负责人（留空沿用活动录入人）">
                  <Select
                    allowClear
                    value={ownerId}
                    onChange={(v) => {
                      setOwnerId(v);
                      setChanged(true);
                    }}
                    placeholder="原录入人停用时，请指定启用负责人"
                    options={(assignees.data?.data || []).map((a) => ({
                      value: a.id,
                      label: a.displayName,
                    }))}
                  />
                </Form.Item>
              ) : null}
              <div className="form-section-title">业务信息</div>
              <Form.Item name="address" label="客户地址">
                <Input maxLength={500} placeholder="省市、街道及详细地址" />
              </Form.Item>
              <Form.Item name="needs" label="主营 / 货代需求">
                <Input.TextArea
                  maxLength={2000}
                  rows={3}
                  placeholder="主营产品、航线、运输方式或预计货量"
                />
              </Form.Item>
              <Form.Item name="note" label="备注">
                <Input.TextArea
                  maxLength={4000}
                  rows={3}
                  placeholder="其他需要留意的信息"
                />
              </Form.Item>
            </Form>
          )}
        </>
      )}
    </Drawer>
  );
}
interface FollowValues {
  action: FollowAction;
  content: string;
  reminderMode: "unchanged" | "set" | "clear";
  date?: Dayjs;
}
function CustomerDetail({
  id,
  onClose,
  onEdit,
}: {
  id: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { user, setDirty } = useWork();
  const { message } = App.useApp();
  const mobile = useMobile();
  const [dirty, setLocalDirty] = useState(false);
  useUnsaved(dirty);
  const [form] = Form.useForm<FollowValues>();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<
    "archive" | "restore" | "owner" | "status" | null
  >(null);
  const [ownerId, setOwnerId] = useState<string>();
  const [targetStatus, setTargetStatus] = useState<Status>();
  const [reason, setReason] = useState("");
  const [statusError, setStatusError] = useState<Error | null>(null);
  const [pendingFollow, setPendingFollow] = useState<FollowValues | null>(null);
  const w = useWrite();
  const q = useApi<Customer>(["customer", user.id, id], "/customers/" + id);
  const history = useApi<FollowUp[]>(
    ["followups", user.id, id, page],
    "/customers/" + id + "/follow-ups?page=" + page,
  );
  const assignees = useApi<Assignee[]>(
    ["assignees", user.id],
    "/assignees",
    user.role !== "sales",
  );
  const c = q.data?.data;
  const reminderMode = Form.useWatch("reminderMode", form);
  const nextStatus: Status | undefined =
    c?.status === "added"
      ? "opened"
      : c?.status === "opened"
        ? "shipped"
        : undefined;
  async function saveFollow(values: FollowValues, upgrade = false) {
    if (!c) return;
    const payload = {
      expectedVersion: c.version,
      action: values.action,
      content: values.content,
      ...(values.reminderMode === "clear"
        ? { nextFollowAt: null }
        : values.reminderMode === "set" && values.date
          ? {
              nextFollowAt:
                values.date.format("YYYY-MM-DD") + "T10:00:00+08:00",
            }
          : {}),
      ...(upgrade && nextStatus
        ? { statusChange: { toStatus: nextStatus, confirmed: true as const } }
        : {}),
    };
    const parsed = followUpSchema.safeParse(payload);
    if (!parsed.success) {
      setStatusError(new Error(parsed.error.issues[0].message));
      return;
    }
    try {
      await w.write(
        "/customers/" + id + "/follow-ups",
        parsed.data,
        "POST",
        true,
      );
      setPendingFollow(null);
      form.resetFields();
      setLocalDirty(false);
      setDirty(false);
      setPage(1);
      void message.success("跟进记录已保存");
    } catch {
      /* keep inputs */
    }
  }
  async function operation(op: string, why: string) {
    if (!c) return;
    if (op === "owner" && !ownerId) {
      setStatusError(new Error("请选择新负责人"));
      return;
    }
    await w.write(
      "/customers/" + id + "/" + op,
      {
        expectedVersion: c.version,
        reason: why,
        ...(op === "owner" ? { ownerId } : {}),
      },
      op === "owner" ? "PATCH" : "POST",
    );
    setAction(null);
    setStatusError(null);
    void message.success(
      op === "archive"
        ? "客户已归档"
        : op === "restore"
          ? "客户已恢复"
          : "客户已转交",
    );
    if (op === "archive" || op === "owner") {
      setLocalDirty(false);
      setDirty(false);
      onClose();
      if (op === "owner") {
        qc.removeQueries({ queryKey: ["business", "customer", user.id, id] });
        qc.removeQueries({ queryKey: ["business", "followups", user.id, id] });
      }
    }
  }
  async function changeStatus() {
    if (!c || !targetStatus) return;
    const isBack =
      ["added", "opened", "shipped"].indexOf(targetStatus) <
      ["added", "opened", "shipped"].indexOf(c.status);
    if (isBack && !reason.trim()) {
      setStatusError(new Error("状态回退必须填写原因"));
      return;
    }
    try {
      await w.write(
        "/customers/" + id + "/status",
        {
          expectedVersion: c.version,
          toStatus: targetStatus,
          confirmed: true,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
        "PATCH",
      );
      setAction(null);
      void message.success("客户阶段已更新");
    } catch {
      /* displayed */
    }
  }
  return (
    <Drawer
      open
      width={mobile ? "100%" : 660}
      placement={mobile ? "bottom" : "right"}
      height={mobile ? "94dvh" : undefined}
      title={
        <>
          <strong>{c?.name || "客户详情"}</strong>
          <div className="drawer-subtitle">
            负责人：{c?.ownerName || "—"} · 最近跟进{" "}
            {formatDate(c?.lastFollowAt)}
          </div>
        </>
      }
      onClose={onClose}
      destroyOnHidden
      footer={
        c ? (
          <div className="drawer-footer">
            <span className="muted">
              创建于 {shanghai(c.createdAt).format("YYYY-MM-DD")}
            </span>
            <Space wrap>
              {user.role !== "sales" ? (
                <Button
                  icon={<SwapOutlined />}
                  onClick={() => {
                    setAction("owner");
                    setStatusError(null);
                  }}
                >
                  转交
                </Button>
              ) : null}
              {c.archivedAt ? (
                <Button
                  type="primary"
                  disabled={user.role === "sales"}
                  onClick={() => setAction("restore")}
                >
                  恢复客户
                </Button>
              ) : (
                <>
                  <Button danger onClick={() => setAction("archive")}>
                    归档
                  </Button>
                  <Button
                    type="primary"
                    icon={<EditOutlined />}
                    onClick={onEdit}
                  >
                    编辑资料
                  </Button>
                </>
              )}
            </Space>
          </div>
        ) : null
      }
    >
      <ErrorNotice error={q.error} retry={() => void q.refetch()} />
      {q.isLoading ? (
        <Loading />
      ) : c ? (
        <>
          <div className="detail-badges">
            <StatusBadge status={c.status} />
            <SourceTag source={c.source} />
            {c.highIntent ? (
              <Tag color="gold" icon={<FlagFilled />}>
                高意向
              </Tag>
            ) : null}
            {c.archivedAt ? <Tag>已归档</Tag> : null}
            {!c.archivedAt ? (
              <Button
                size="small"
                onClick={() => {
                  setTargetStatus(nextStatus || "opened");
                  setAction("status");
                  setReason("");
                  setStatusError(null);
                }}
                disabled={c.status === "shipped" && user.role === "sales"}
              >
                变更阶段
              </Button>
            ) : null}
          </div>
          <div className="form-section-title">客户资料</div>
          <Descriptions
            className="customer-data"
            size="small"
            column={mobile ? 1 : 2}
            items={[
              { key: "contact", label: "联系人", children: c.contact || "—" },
              {
                key: "phone",
                label: "联系电话",
                children: <span className="mono">{c.phone}</span>,
              },
              { key: "alt", label: "备用电话", children: c.altPhone || "—" },
              { key: "wechat", label: "微信号", children: c.wechat || "—" },
              { key: "email", label: "邮箱", children: c.email || "—" },
              { key: "address", label: "客户地址", children: c.address || "—" },
              {
                key: "needs",
                label: "主营 / 需求",
                children: c.needs || "—",
                span: 2,
              },
              { key: "note", label: "备注", children: c.note || "—", span: 2 },
              {
                key: "next",
                label: "下次跟进",
                children: formatDate(c.nextFollowAt),
                span: 2,
              },
            ]}
          />
          <div className="form-section-title">跟进时间线</div>
          <ErrorNotice
            error={history.error}
            retry={() => void history.refetch()}
          />
          {history.isLoading ? (
            <Loading />
          ) : history.data?.data.length ? (
            <>
              <Timeline
                items={history.data.data.map((f) => ({
                  color: f.action === "order" ? "green" : "#2E7BC4",
                  children: (
                    <div className="timeline-entry">
                      <header>
                        <strong>{actionLabels[f.action]}</strong>
                        <time>{formatDate(f.occurredAt)}</time>
                      </header>
                      <p>{f.content}</p>
                      <small>
                        {f.actorName || "员工"}
                        {f.reminderAction === "set"
                          ? " · 下次跟进 " + formatDate(f.nextFollowAt)
                          : f.reminderAction === "clear"
                            ? " · 已取消跟进提醒"
                            : ""}
                      </small>
                    </div>
                  ),
                }))}
              />
              <Pager
                page={page}
                total={history.data.meta.total || 0}
                onChange={setPage}
              />
            </>
          ) : (
            <Blank
              title="暂无跟进记录"
              description="记录沟通要点，方便下一次继续跟进"
            />
          )}
          {!c.archivedAt ? (
            <>
              <div className="form-section-title">添加跟进</div>
              <ErrorNotice error={w.error || statusError} />
              {w.error instanceof ApiError && w.error.status === 409 ? (
                <Button
                  className="spaced-bottom"
                  onClick={() => {
                    void q.refetch();
                    w.clearError();
                    void message.info("已保留输入，请核对最新资料后再提交。");
                  }}
                >
                  查看最新客户资料
                </Button>
              ) : null}
              <Form
                form={form}
                layout="vertical"
                initialValues={{
                  action: "greeting",
                  reminderMode: "unchanged",
                }}
                onValuesChange={() => setLocalDirty(true)}
                onFinish={(v) =>
                  v.action === "order" && nextStatus
                    ? setPendingFollow(v)
                    : void saveFollow(v)
                }
              >
                <Form.Item name="action" label="跟进动作">
                  <Radio.Group
                    optionType="button"
                    className="wrapped-radio"
                    options={options(actionLabels)}
                  />
                </Form.Item>
                <Form.Item
                  name="content"
                  label="跟进内容"
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      message: "请填写跟进内容",
                    },
                    { max: 4000 },
                  ]}
                >
                  <Input.TextArea
                    rows={3}
                    placeholder="记录沟通要点、客户反馈等"
                    maxLength={4000}
                  />
                </Form.Item>
                <Form.Item name="reminderMode" label="下次跟进安排">
                  <Radio.Group
                    options={[
                      { value: "unchanged", label: "保持原安排" },
                      { value: "set", label: "设置日期" },
                      { value: "clear", label: "取消安排" },
                    ]}
                  />
                </Form.Item>
                {reminderMode === "set" ? (
                  <Form.Item
                    name="date"
                    label="跟进日期"
                    extra="按公司时间（上海）当天上午10:00提醒"
                    rules={[{ required: true, message: "请选择日期" }]}
                  >
                    <DatePicker
                      disabledDate={(d) =>
                        d.format("YYYY-MM-DD") < shanghai().format("YYYY-MM-DD")
                      }
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                ) : null}
                <Button
                  block
                  type="primary"
                  htmlType="submit"
                  icon={<SendOutlined />}
                  loading={w.busy}
                >
                  添加跟进记录
                </Button>
              </Form>
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message="客户已归档，历史记录完整保留。恢复后可以继续跟进。"
            />
          )}
        </>
      ) : null}
      <ReasonModal
        open={
          action === "archive" || action === "restore" || action === "owner"
        }
        title={
          action === "archive"
            ? "归档客户"
            : action === "restore"
              ? "恢复客户"
              : "转交客户"
        }
        description={
          action === "archive"
            ? "归档后从普通列表隐藏，资料和跟进历史保留。"
            : action === "restore"
              ? "恢复后沿用原有阶段和提醒安排，可能立即显示逾期。"
              : "客户资料和跟进历史将交由新负责人管理。转交后关闭当前详情。" +
                (dirty ? "尚未保存的跟进内容将丢弃。" : "")
        }
        onCancel={() => setAction(null)}
        busy={w.busy}
        error={w.error || statusError}
        onSubmit={(reason) => operation(action!, reason)}
      >
        {action === "owner" ? (
          <Form layout="vertical">
            <Form.Item label="新负责人" required>
              <Select
                placeholder="选择启用员工"
                value={ownerId}
                onChange={setOwnerId}
                options={(assignees.data?.data || [])
                  .filter((a) => a.id !== c?.ownerId)
                  .map((a) => ({ value: a.id, label: a.displayName }))}
              />
            </Form.Item>
          </Form>
        ) : null}
      </ReasonModal>
      <Modal
        open={action === "status"}
        title="确认客户阶段"
        okText="确认变更"
        cancelText="返回"
        onCancel={() => setAction(null)}
        onOk={() => void changeStatus()}
        confirmLoading={w.busy}
      >
        <ErrorNotice error={w.error || statusError} />
        <p className="muted">请核实客户实际情况。阶段变更不会生成走货票数。</p>
        <Select
          className="full-width spaced-bottom"
          value={targetStatus}
          onChange={setTargetStatus}
          options={(["added", "opened", "shipped"] as Status[])
            .filter(
              (s) =>
                s !== c?.status &&
                (s === nextStatus ||
                  (user.role !== "sales" &&
                    ["added", "opened", "shipped"].indexOf(s) <
                      ["added", "opened", "shipped"].indexOf(
                        c?.status || "added",
                      ))),
            )
            .map((s) => ({ value: s, label: statusLabels[s] }))}
        />
        <Input.TextArea
          placeholder="变更原因（回退必填）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </Modal>
      <Modal
        open={!!pendingFollow}
        title="客户下单 · 更新阶段"
        onCancel={() => setPendingFollow(null)}
        footer={
          <Space wrap>
            <Button onClick={() => setPendingFollow(null)}>返回编辑</Button>
            <Button
              loading={w.busy}
              onClick={() => pendingFollow && void saveFollow(pendingFollow)}
            >
              仅记录跟进
            </Button>
            <Button
              type="primary"
              loading={w.busy}
              onClick={() =>
                pendingFollow && void saveFollow(pendingFollow, true)
              }
            >
              升级并记录
            </Button>
          </Space>
        }
      >
        <ErrorNotice error={w.error} />
        <p>
          将「{c?.name}」从{c ? statusLabels[c.status] : ""}升级为
          {nextStatus ? statusLabels[nextStatus] : ""}？
        </p>
        <p className="muted">
          {nextStatus === "shipped"
            ? "请确认客户已经实际走货。只有下单记录时，请选择“仅记录跟进”。"
            : "请确认客户已经完成开户。也可以仅保存本次跟进。"}
        </p>
      </Modal>
    </Drawer>
  );
}
