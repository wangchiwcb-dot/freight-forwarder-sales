import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EditOutlined,
  EnvironmentOutlined,
  PhoneOutlined,
  PlusOutlined,
  SearchOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  activityCreateSchema,
  type ActivityInput,
  type ActivityResult,
} from "../../shared/contracts";
import { useApi, useWrite, queryString, ApiError } from "../api";
import { useWork, useUnsaved } from "../context";
import {
  type Activity,
  type ActivityType,
  type Judge,
  type Summary,
  resultLabels,
  judgeLabels,
  resultsByType,
  deriveJudge,
  options,
} from "../model";
import {
  Blank,
  ErrorNotice,
  formatDate,
  JudgeTag,
  Loading,
  PageHead,
  Pager,
  Panel,
  ResultTag,
  todayBounds,
  useDebounce,
  useMobile,
} from "../components/Common";
export function LeadsPage() {
  const { user, scope, setDirty } = useWork();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type: ActivityType = ["visit", "扫楼"].includes(params.get("tab") || "")
    ? "visit"
    : "call";
  const [form] = Form.useForm<ActivityInput>();
  const [dirty, setLocalDirty] = useState(false);
  useUnsaved(dirty);
  const [page, setPage] = useState(1);
  const drafts = useRef<Record<ActivityType, Partial<ActivityInput>>>({
    call: {},
    visit: {},
  });
  const [localError, setLocalError] = useState<Error | null>(null);
  const w = useWrite();
  const list = useApi<Activity[]>(
    ["today", user.id, scope, type, page],
    "/activities?" +
      queryString({ ...scope, types: [type], ...todayBounds(), page }),
  );
  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({ nextJudge: "revisit", ...drafts.current[type] });
    setPage(1);
  }, [type, form]);
  function changeType(v: ActivityType) {
    drafts.current[type] = form.getFieldsValue();
    setParams({ tab: v });
  }
  async function save(v: ActivityInput) {
    setLocalError(null);
    const payload = {
      ...v,
      type,
      ...(type === "call" ? { address: undefined } : {}),
    };
    const parsed = activityCreateSchema.safeParse(payload);
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
    try {
      const r = await w.write<Activity>(
        "/activities",
        parsed.data,
        "POST",
        true,
      );
      drafts.current[type] = {};
      form.resetFields();
      form.setFieldsValue({ nextJudge: "revisit" });
      const other = type === "call" ? "visit" : "call";
      const stillDirty = Object.entries(drafts.current[other]).some(
        ([k, v]) => k !== "nextJudge" && !!v,
      );
      setLocalDirty(stillDirty);
      setDirty(stillDirty);
      setPage(1);
      void message.success(
        type === "call" ? "电销记录已保存" : "扫楼记录已保存",
      );
      if (r.data.result === "contact_added")
        modal.confirm({
          title: "成功添加联系方式",
          content: `「${r.data.customerName}」已保存，是否立即转为客户建档？`,
          icon: <UserAddOutlined />,
          okText: "立即转客户",
          cancelText: "稍后再说",
          onOk: () => navigate("/customers/new?fromActivityId=" + r.data.id),
        });
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
  return (
    <>
      <PageHead
        title="电销·扫楼"
        description="先记沟通结论，再补联系方式 · 让每一次接触都有记录"
        actions={
          <Link to="/call-records">
            <Button>查看全部记录 →</Button>
          </Link>
        }
      />
      <Radio.Group
        className="lead-tabs"
        value={type}
        onChange={(e) => changeType(e.target.value)}
      >
        <Radio.Button value="call">
          <PhoneOutlined /> 电销
        </Radio.Button>
        <Radio.Button value="visit">
          <ApartmentOutlined /> 扫楼
        </Radio.Button>
      </Radio.Group>
      <div className="lead-columns">
        <Panel
          title={
            <>
              <span className={`panel-title-icon ${type}`}>
                {type === "call" ? <PhoneOutlined /> : <ApartmentOutlined />}
              </span>
              {type === "call" ? "快速记录电销" : "快速记录扫楼"}
            </>
          }
          extra={
            <Tag color="blue">{type === "call" ? "电话沟通" : "上门拜访"}</Tag>
          }
        >
          <ErrorNotice error={localError || w.error} />
          <Form
            form={form}
            layout="vertical"
            onFinish={(v) => void save(v)}
            onValuesChange={() => setLocalDirty(true)}
            initialValues={{ nextJudge: "revisit" }}
            scrollToFirstError
          >
            <Form.Item
              label="沟通结果"
              name="result"
              rules={[{ required: true, message: "请选择沟通结果" }]}
            >
              <Radio.Group
                className="result-choices"
                onChange={(e) => {
                  form.setFieldValue("nextJudge", deriveJudge(e.target.value));
                  setLocalDirty(true);
                }}
              >
                {resultsByType[type].map((r) => (
                  <Radio.Button key={r} value={r}>
                    {resultLabels[r]}
                  </Radio.Button>
                ))}
              </Radio.Group>
            </Form.Item>
            <Form.Item
              label="下次判断"
              name="nextJudge"
              extra="根据沟通结果建议，您可以手动调整。"
              rules={[{ required: true }]}
            >
              <Radio.Group optionType="button" options={options(judgeLabels)} />
            </Form.Item>
            <div className="form-divider" />
            <div className="form-grid">
              <Form.Item
                label="客户名称"
                name="customerName"
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
              <Form.Item
                label="联系方式"
                name="phone"
                rules={[
                  { required: type === "call", message: "请填写手机号码" },
                  {
                    validator: (_, v) =>
                      (!v && type === "visit") ||
                      /^1[3-9]\d{9}$/.test(String(v || "").replace(/\s/g, ""))
                        ? Promise.resolve()
                        : Promise.reject(new Error("请输入有效的大陆手机号")),
                  },
                ]}
              >
                <Input
                  inputMode="tel"
                  placeholder={
                    type === "call" ? "11位手机号码" : "手机号（可选）"
                  }
                />
              </Form.Item>
            </div>
            {type === "visit" ? (
              <Form.Item
                label="客户地址"
                name="address"
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: "请填写拜访地址",
                  },
                  { max: 500 },
                ]}
              >
                <Input
                  prefix={<EnvironmentOutlined />}
                  placeholder="园区、楼栋、楼层或详细地址"
                  maxLength={500}
                />
              </Form.Item>
            ) : null}
            <Form.Item label="沟通备注" name="note">
              <Input.TextArea
                rows={4}
                placeholder="记录客户需求、沟通要点或下次拜访注意事项"
                maxLength={4000}
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              icon={<CheckCircleOutlined />}
              loading={w.busy}
              block
            >
              保存{type === "call" ? "电销" : "扫楼"}记录
            </Button>
          </Form>
          <div className="form-footnote">
            每次实际沟通单独记录，保存后可继续录入下一条。
          </div>
        </Panel>
        <Panel
          title={
            <>
              今日记录 <small>{list.data?.meta.total || 0} 条</small>
            </>
          }
          extra={<Tag>{type === "call" ? "电销" : "扫楼"}</Tag>}
        >
          <ErrorNotice error={list.error} retry={() => void list.refetch()} />
          {list.isLoading ? (
            <Loading />
          ) : list.data?.data.length ? (
            <>
              <div className="today-records">
                {list.data.data.map((a) => (
                  <ActivityCard
                    key={a.id}
                    activity={a}
                    onOpen={() => navigate("/call-records/" + a.id)}
                    onConvert={() =>
                      navigate("/customers/new?fromActivityId=" + a.id)
                    }
                  />
                ))}
              </div>
              <Pager
                page={page}
                total={list.data.meta.total || 0}
                onChange={setPage}
              />
            </>
          ) : (
            <Blank
              title={"今日暂无" + (type === "call" ? "电销" : "扫楼") + "记录"}
              description="完成沟通后，在左侧记下第一条。"
            />
          )}
        </Panel>
      </div>
    </>
  );
}
function ActivityCard({
  activity: a,
  onOpen,
  onConvert,
}: {
  activity: Activity;
  onOpen: () => void;
  onConvert: () => void;
}) {
  return (
    <article className="activity-card">
      <span className={"activity-symbol " + a.type}>
        {a.type === "call" ? <PhoneOutlined /> : <ApartmentOutlined />}
      </span>
      <div className="activity-content">
        <div className="activity-heading">
          <button className="table-link" onClick={onOpen}>
            {a.customerName}
          </button>
          <ResultTag result={a.result} />
          <JudgeTag judge={a.nextJudge} />
        </div>
        <div className="activity-meta">
          {a.phone ? <span className="mono">{a.phone}</span> : null}
          {a.address ? (
            <span>
              <EnvironmentOutlined /> {a.address}
            </span>
          ) : null}
          <span>
            <ClockCircleOutlined /> {formatDate(a.occurredAt)}
          </span>
        </div>
        {a.note ? <p className="activity-note">{a.note}</p> : null}
        <div className="activity-actions">
          {a.converted ? (
            <Tag color="green" icon={<CheckCircleOutlined />}>
              已转客户
            </Tag>
          ) : a.result === "contact_added" ? (
            <Button size="small" icon={<UserAddOutlined />} onClick={onConvert}>
              转客户
            </Button>
          ) : null}
          <Button size="small" type="text" onClick={onOpen}>
            查看详情 →
          </Button>
        </div>
      </div>
    </article>
  );
}
export function ActivitiesPage() {
  const { user, scope } = useWork();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  const search = useDebounce(keyword);
  const [prevSearch, setPrevSearch] = useState(search);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const types = params.getAll("types");
  const results = params.getAll("results");
  const nextJudges = params.getAll("nextJudges");
  useEffect(() => {
    if (search !== prevSearch) {
      setPrevSearch(search);
      const q = new URLSearchParams(params);
      q.delete("page");
      setParams(q, { replace: true });
    }
  }, [search, prevSearch, params, setParams]);
  const filters = {
    keyword: search,
    types,
    results,
    nextJudges,
    dateFrom: params.get("dateFrom") || undefined,
    dateTo: params.get("dateTo") || undefined,
    page,
  };
  const summary = useApi<Summary>(
    ["activity-summary", user.id, scope],
    "/activities/summary?" + queryString(scope),
  );
  const list = useApi<Activity[]>(
    ["activities", user.id, scope, filters],
    "/activities?" + queryString({ ...scope, ...filters }),
  );
  const id = (useParams()["*"] || "").split("/")[0];
  const suffix = params.toString() ? "?" + params.toString() : "";
  function setFilter(key: string, values: string[]) {
    const q = new URLSearchParams(params);
    q.delete(key);
    q.delete("page");
    values.forEach((v) => q.append(key, v));
    if (key === "types") {
      const compatible = values.length
        ? new Set(values.flatMap((t) => resultsByType[t as ActivityType] || []))
        : new Set(Object.keys(resultLabels));
      const old = q.getAll("results");
      q.delete("results");
      old
        .filter((r) => compatible.has(r))
        .forEach((r) => q.append("results", r));
    }
    setParams(q);
  }
  const clear = () => {
    setKeyword("");
    setParams({});
  };
  const preset = (field?: string, value?: string) => {
    setKeyword("");
    setParams(field && value ? { [field]: value } : {});
  };
  const open = (a: Activity) => navigate("/call-records/" + a.id + suffix);
  const convert = (a: Activity) =>
    navigate("/customers/new?fromActivityId=" + a.id);
  const columns = [
    {
      title: "时间",
      dataIndex: "occurredAt",
      render: (v: string) => <span className="date-cell">{formatDate(v)}</span>,
    },
    {
      title: "类型",
      dataIndex: "type",
      render: (v: ActivityType) => (
        <Tag color={v === "call" ? "blue" : "green"}>
          {v === "call" ? "电销" : "扫楼"}
        </Tag>
      ),
    },
    {
      title: "客户名称",
      dataIndex: "customerName",
      render: (v: string, a: Activity) => (
        <button className="table-link" onClick={() => open(a)}>
          {v}
        </button>
      ),
    },
    {
      title: "联系方式",
      dataIndex: "phone",
      render: (v: string) => <span className="mono">{v || "—"}</span>,
    },
    {
      title: "地址",
      dataIndex: "address",
      render: (v: string) => <span className="truncated">{v || "—"}</span>,
    },
    {
      title: "沟通结果",
      dataIndex: "result",
      render: (v: string) => <ResultTag result={v} />,
    },
    {
      title: "下次判断",
      dataIndex: "nextJudge",
      render: (v: Judge) => <JudgeTag judge={v} />,
    },
    {
      title: "备注",
      dataIndex: "note",
      render: (v: string, a: Activity) =>
        v ? (
          <button className="note-button" onClick={() => open(a)}>
            {v.length > 14 ? v.slice(0, 14) + "…" : v}
          </button>
        ) : (
          "—"
        ),
    },
    {
      title: "转客户",
      key: "converted",
      render: (_: unknown, a: Activity) =>
        a.converted ? (
          a.convertedCustomerId && a.customerLinkVisible ? (
            <Link to={"/customers/" + a.convertedCustomerId}>
              <Tag color="green">已转客户</Tag>
            </Link>
          ) : (
            <Tag color="green">已转客户</Tag>
          )
        ) : a.result === "contact_added" ? (
          <Button size="small" onClick={() => convert(a)}>
            转客户
          </Button>
        ) : (
          <span className="muted">未转</span>
        ),
    },
  ];
  return (
    <>
      <PageHead
        title="电销记录"
        description="回顾每一次电销与扫楼 · 历史记录完整保留"
        actions={
          <Link to="/leads?tab=call">
            <Button type="primary" icon={<PlusOutlined />}>
              新增记录
            </Button>
          </Link>
        }
      />
      <ErrorNotice error={summary.error} retry={() => void summary.refetch()} />
      <div className="kpi-grid history-kpis">
        {[
          {
            title: "全部记录",
            value: summary.data?.data.total,
            icon: <ClockCircleOutlined />,
            tone: "blue",
            click: () => preset(),
          },
          {
            title: "电销",
            value: summary.data?.data.calls,
            icon: <PhoneOutlined />,
            tone: "blue",
            click: () => preset("types", "call"),
          },
          {
            title: "扫楼",
            value: summary.data?.data.visits,
            icon: <ApartmentOutlined />,
            tone: "green",
            click: () => preset("types", "visit"),
          },
          {
            title: "成功添加联系方式",
            value: summary.data?.data.contactAdded,
            icon: <UserAddOutlined />,
            tone: "orange",
            click: () => preset("results", "contact_added"),
          },
        ].map((k) => (
          <button className="kpi-card" onClick={k.click} key={k.title}>
            <div className="kpi-top">
              <span className={"kpi-icon " + k.tone}>{k.icon}</span>
              <span>{k.title}</span>
            </div>
            <div className="kpi-value">
              {k.value ?? "—"}
              <small> 条</small>
            </div>
            <div className="kpi-foot">全部记录统计</div>
          </button>
        ))}
      </div>
      <section className="panel history-list">
        <div className="list-toolbar">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            className="search-input"
            placeholder="搜索名称 / 电话 / 地址"
            aria-label="搜索电销记录"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            mode="multiple"
            aria-label="记录类型"
            placeholder="全部类型"
            value={types}
            onChange={(v) => setFilter("types", v)}
            options={[
              { value: "call", label: "电销" },
              { value: "visit", label: "扫楼" },
            ]}
            maxTagCount="responsive"
          />
          <Select
            mode="multiple"
            aria-label="沟通结果筛选"
            placeholder="全部沟通结果"
            value={results}
            onChange={(v) => setFilter("results", v)}
            options={(types.length
              ? [
                  ...new Set(
                    types.flatMap(
                      (t) => resultsByType[t as ActivityType] || [],
                    ),
                  ),
                ]
              : Object.keys(resultLabels)
            ).map((value) => ({ value, label: resultLabels[value] }))}
            maxTagCount="responsive"
          />
          <Select
            mode="multiple"
            aria-label="下次判断筛选"
            placeholder="全部下次判断"
            value={nextJudges}
            onChange={(v) => setFilter("nextJudges", v)}
            options={options(judgeLabels)}
            maxTagCount="responsive"
          />
          <Button type="text" onClick={clear}>
            清除
          </Button>
        </div>
        <div className="list-caption">
          <span>
            筛选结果 <strong>{list.data?.meta.total || 0}</strong> 条
          </span>
          {params.get("dateFrom") ? (
            <Tag
              closable
              color="blue"
              onClose={() => {
                const q = new URLSearchParams(params);
                q.delete("dateFrom");
                q.delete("dateTo");
                setParams(q);
              }}
            >
              日期范围：{formatDate(params.get("dateFrom")).slice(0, 10)}
            </Tag>
          ) : null}
          <span className="muted">按时间倒序</span>
        </div>
        <ErrorNotice error={list.error} retry={() => void list.refetch()} />
        {list.isLoading ? (
          <Loading />
        ) : list.data?.data.length ? (
          <>
            <div className="desktop-table">
              <Table<Activity>
                rowKey="id"
                dataSource={list.data.data}
                columns={columns}
                pagination={false}
                size="middle"
                scroll={{ x: 1100 }}
              />
            </div>
            <div className="mobile-cards">
              {list.data.data.map((a) => (
                <ActivityCard
                  key={a.id}
                  activity={a}
                  onOpen={() => open(a)}
                  onConvert={() => convert(a)}
                />
              ))}
            </div>
            <Pager
              total={list.data.meta.total || 0}
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
            title="暂无匹配记录"
            description="试试调整筛选条件，或开始记录新的沟通。"
            action={<Button onClick={clear}>清除筛选</Button>}
          />
        )}
      </section>
      {id ? (
        <ActivityDetail
          id={id}
          onClose={() => navigate("/call-records" + suffix)}
          onConvert={() => navigate("/customers/new?fromActivityId=" + id)}
        />
      ) : null}
    </>
  );
}
function ActivityDetail({
  id,
  onClose,
  onConvert,
}: {
  id: string;
  onClose: () => void;
  onConvert: () => void;
}) {
  const { user, setDirty } = useWork();
  const { message, modal } = App.useApp();
  const mobile = useMobile();
  const q = useApi<Activity>(["activity", user.id, id], "/activities/" + id);
  const a = q.data?.data;
  const [editing, setEditing] = useState(false);
  const [dirty, setLocalDirty] = useState(false);
  useUnsaved(dirty);
  const [form] = Form.useForm<ActivityInput & { reason: string }>();
  const w = useWrite();
  const editedType = Form.useWatch("type", form) || a?.type;
  const original = useRef<Activity | null>(null);
  const editVersion = useRef<number>(0);
  const [latestNotice, setLatestNotice] = useState(false);
  function startEdit() {
    if (!a) return;
    original.current = a;
    editVersion.current = a.version;
    setLatestNotice(false);
    form.setFieldsValue({
      type: a.type,
      customerName: a.customerName,
      phone: a.phone,
      address: a.address,
      result: a.result,
      nextJudge: a.nextJudge,
      note: a.note,
      reason: "",
    });
    setEditing(true);
    w.clearError();
  }
  function closeEdit() {
    const close = () => {
      setLocalDirty(false);
      setDirty(false);
      setEditing(false);
    };
    if (dirty)
      modal.confirm({
        title: "放弃本次更正？",
        okText: "放弃",
        cancelText: "继续编辑",
        onOk: close,
      });
    else close();
  }
  async function save(v: ActivityInput & { reason: string }) {
    if (!a) return;
    const { reason, ...input } = v;
    const parsed = activityCreateSchema.safeParse({
      ...input,
      ...(input.type === "call" ? { address: undefined } : {}),
    });
    if (!parsed.success) {
      form.setFields(
        parsed.error.issues.map((i) => ({
          name: i.path,
          errors: [i.message],
        })) as Parameters<typeof form.setFields>[0],
      );
      return;
    }
    const changes = Object.fromEntries(
      Object.entries(parsed.data).filter(
        ([k, value]) => value !== original.current?.[k as keyof Activity],
      ),
    );
    if (parsed.data.type === "call" && a.address) changes.address = "";
    if (!Object.keys(changes).length) {
      void message.info("未修改记录内容，无需保存。");
      return;
    }
    try {
      await w.write(
        "/activities/" + id,
        { expectedVersion: editVersion.current, changes, reason },
        "PATCH",
      );
      setLocalDirty(false);
      setDirty(false);
      setEditing(false);
      void message.success("记录已更正，原值已保留在审计中。");
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
  return (
    <Drawer
      open
      title="沟通记录详情"
      width={mobile ? "100%" : 660}
      placement={mobile ? "bottom" : "right"}
      height={mobile ? "94dvh" : undefined}
      onClose={onClose}
      footer={
        a ? (
          <div className="drawer-footer">
            <span className="muted">录入人：{a.ownerName}</span>
            <Space>
              {user.role === "admin" ? (
                <Button icon={<EditOutlined />} onClick={startEdit}>
                  更正记录
                </Button>
              ) : null}
              {!a.converted && a.result === "contact_added" ? (
                <Button
                  type="primary"
                  icon={<UserAddOutlined />}
                  onClick={onConvert}
                >
                  转为客户
                </Button>
              ) : null}
              {a.converted && a.customerLinkVisible && a.convertedCustomerId ? (
                <Link to={"/customers/" + a.convertedCustomerId}>
                  <Button type="primary">查看客户</Button>
                </Link>
              ) : null}
            </Space>
          </div>
        ) : null
      }
    >
      <ErrorNotice error={q.error} retry={() => void q.refetch()} />
      {q.isLoading ? (
        <Loading />
      ) : a ? (
        <>
          <h2 className="record-detail-name">{a.customerName}</h2>
          <div className="detail-badges">
            <Tag color={a.type === "call" ? "blue" : "green"}>
              {a.type === "call" ? "电销" : "扫楼"}
            </Tag>
            <ResultTag result={a.result} />
            <JudgeTag judge={a.nextJudge} />
            {a.converted ? <Tag color="green">已转客户</Tag> : null}
          </div>
          <Descriptions
            column={1}
            items={[
              {
                key: "time",
                label: "沟通时间",
                children: formatDate(a.occurredAt),
              },
              { key: "phone", label: "联系方式", children: a.phone || "—" },
              { key: "address", label: "客户地址", children: a.address || "—" },
              {
                key: "note",
                label: "沟通备注",
                children: <div className="pre-wrap">{a.note || "—"}</div>,
              },
              {
                key: "converted",
                label: "转客户时间",
                children: formatDate(a.convertedAt),
              },
            ]}
          />
          {a.converted && !a.customerLinkVisible ? (
            <Alert
              type="info"
              showIcon
              message="该记录已经转为客户，当前无权查看关联客户资料。"
            />
          ) : null}
        </>
      ) : null}
      <Modal
        open={editing}
        title="更正沟通记录"
        onCancel={closeEdit}
        okText="保存更正"
        cancelText="取消"
        onOk={() => form.submit()}
        confirmLoading={w.busy}
        destroyOnHidden
      >
        <Alert
          className="spaced-bottom"
          type="info"
          message="更正保留原值与原因，不会反向修改已关联客户资料。"
        />
        <ErrorNotice error={w.error} />
        {w.error instanceof ApiError && w.error.status === 409 ? (
          <Button
            className="spaced-bottom"
            onClick={() => {
              void q.refetch().then((r) => {
                if (r.data) {
                  editVersion.current = r.data.data.version;
                  setLatestNotice(true);
                  w.clearError();
                }
              });
            }}
          >
            查看最新资料（保留当前输入）
          </Button>
        ) : null}
        {latestNotice && a ? (
          <Alert
            className="spaced-bottom"
            type="warning"
            message="请核对最新记录后再保存"
            description={
              <div>
                {a.customerName} · {a.phone || "无电话"} ·{" "}
                {resultLabels[a.result]}
                <br />
                {a.address}
                <br />
                {a.note || "无备注"}
                <br />
                再次保存只更新您修改的内容。
              </div>
            }
          />
        ) : null}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setLocalDirty(true)}
          onFinish={(v) => void save(v)}
        >
          <Form.Item name="type" label="类型">
            <Radio.Group
              disabled={a?.converted}
              options={[
                { value: "call", label: "电销" },
                { value: "visit", label: "扫楼" },
              ]}
              onChange={() => form.setFieldValue("result", undefined)}
            />
          </Form.Item>
          <Form.Item
            name="customerName"
            label="客户名称"
            rules={[{ required: true, whitespace: true }, { max: 200 }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item
            name="phone"
            label="联系方式"
            rules={[{ required: editedType === "call" }]}
          >
            <Input inputMode="tel" />
          </Form.Item>
          {editedType === "visit" ? (
            <Form.Item
              name="address"
              label="地址"
              rules={[{ required: true, whitespace: true }]}
            >
              <Input maxLength={500} />
            </Form.Item>
          ) : null}
          <Form.Item
            name="result"
            label="沟通结果"
            rules={[{ required: true }]}
          >
            <Select
              disabled={a?.converted}
              options={(editedType
                ? resultsByType[editedType as ActivityType]
                : []
              ).map((value) => ({ value, label: resultLabels[value] }))}
            />
          </Form.Item>
          <Form.Item name="nextJudge" label="下次判断">
            <Radio.Group options={options(judgeLabels)} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} maxLength={4000} />
          </Form.Item>
          <Form.Item
            name="reason"
            label="更正原因"
            rules={[
              { required: true, whitespace: true, message: "请填写更正原因" },
              { max: 500 },
            ]}
          >
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  );
}
