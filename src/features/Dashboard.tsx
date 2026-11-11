import { Link } from "react-router-dom";
import { Button, Progress, Tag } from "antd";
import {
  ArrowUpOutlined,
  ClockCircleOutlined,
  ContainerOutlined,
  IdcardOutlined,
  PhoneOutlined,
  PlusOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useApi, queryString } from "../api";
import { useWork } from "../context";
import type { Dashboard, Status } from "../model";
import { statusLabels } from "../model";
import {
  Blank,
  ErrorNotice,
  formatDate,
  Loading,
  PageHead,
  Panel,
  shanghai,
  todayBounds,
} from "../components/Common";
export function DashboardPage() {
  const { user, scope } = useWork();
  const query = useApi<Dashboard>(
    ["dashboard", user.id, scope],
    "/dashboard?" + queryString(scope),
  );
  if (query.isLoading) return <Loading />;
  const d = query.data?.data;
  return (
    <>
      <PageHead
        title="工作台"
        description="客户阶段与今日沟通概览 · 让每一次跟进都有回应"
        actions={
          <>
            <Link to="/leads?tab=call">
              <Button icon={<PhoneOutlined />}>开始电销</Button>
            </Link>
            <Link to="/customers/new">
              <Button type="primary" icon={<PlusOutlined />}>
                新增客户
              </Button>
            </Link>
          </>
        }
      />
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {d ? (
        <>
          <div className="kpi-grid dashboard-kpis">
            {[
              {
                title: "总客户",
                value: d.customers.total,
                to: "/customers",
                icon: <TeamOutlined />,
                tone: "blue",
                foot: `客户池 · 待开户 ${d.stages.added} 个`,
              },
              {
                title: "开户客户",
                value: d.customers.opened,
                to: "/customers?statusGte=opened",
                icon: <IdcardOutlined />,
                tone: "orange",
                foot: `开户率 ${d.customers.openedRate === null ? "—" : Math.round(d.customers.openedRate) + "%"} · 含走货客户`,
              },
              {
                title: "走货客户",
                value: d.customers.shipped,
                to: "/customers?status=shipped",
                icon: <ContainerOutlined />,
                tone: "green",
                foot: `走货率 ${d.customers.shippedRate === null ? "—" : Math.round(d.customers.shippedRate) + "%"}`,
              },
            ].map((k) => (
              <Link className="kpi-card" to={k.to} key={k.title}>
                <div className="kpi-top">
                  <span className={`kpi-icon ${k.tone}`}>{k.icon}</span>
                  <span>{k.title}</span>
                  <ArrowUpOutlined rotate={45} className="kpi-arrow" />
                </div>
                <div className="kpi-value">{k.value.toLocaleString()}</div>
                <div className="kpi-foot">
                  <ArrowUpOutlined />
                  {k.foot}
                </div>
              </Link>
            ))}
          </div>
          <div className="dashboard-columns">
            <div className="stack">
              <Panel
                title={
                  <>
                    走货量 <small>票数</small>
                  </>
                }
                extra={<Tag>待接入</Tag>}
              >
                <div className="shipment-placeholder">
                  <ContainerOutlined />
                  <h3>走货量待接入</h3>
                  <p>
                    接入真实销售票数后，在这里查看
                    <br />
                    本周及本月的走货趋势。
                  </p>
                  <div className="shipment-periods">
                    <span>本周按天</span>
                    <span>本月按周</span>
                  </div>
                </div>
              </Panel>
              <Panel
                title={
                  <>
                    待跟进客户{" "}
                    <small>{d.pendingFollowUps.total} 位待跟进</small>
                  </>
                }
                extra={
                  <Link to="/customers?reminder=due_soon&sort=nextFollowAt%3Aasc">
                    更多客户 →
                  </Link>
                }
              >
                {d.pendingFollowUps.items.length ? (
                  d.pendingFollowUps.items.map((c) => {
                    const overdue =
                      !!c.nextFollowAt &&
                      shanghai(c.nextFollowAt).isBefore(shanghai(d.asOf));
                    return (
                      <Link
                        to={`/customers/${c.id}`}
                        className="follow-row"
                        key={c.id}
                      >
                        <span className="client-avatar">
                          {(c.contact || c.name).slice(0, 1)}
                        </span>
                        <span className="follow-info">
                          <strong>{c.name}</strong>
                          <small>下次跟进 {formatDate(c.nextFollowAt)}</small>
                        </span>
                        <Tag color={overdue ? "orange" : "blue"}>
                          {overdue ? "已逾期" : "待跟进"}
                        </Tag>
                        <span>›</span>
                      </Link>
                    );
                  })
                ) : (
                  <Blank
                    title="暂无待跟进"
                    description="未来安排会在这里提醒您"
                  />
                )}
              </Panel>
            </div>
            <div className="stack">
              <Panel
                title="今日电销"
                extra={<Link to="/leads?tab=call">开始录入 →</Link>}
              >
                <div className="today-calls">
                  <Progress
                    type="circle"
                    size={116}
                    percent={d.todayCalls.rate || 0}
                    strokeColor="#2E7BC4"
                    strokeWidth={7}
                    trailColor="#EEF1F6"
                    format={() => (
                      <div>
                        <strong>
                          {d.todayCalls.rate === null
                            ? "—"
                            : `${Math.round(d.todayCalls.rate)}%`}
                        </strong>
                        <small>添加率</small>
                      </div>
                    )}
                  />
                  <div className="call-legend">
                    <Link
                      to={
                        "/call-records?" +
                        queryString({ types: ["call"], ...todayBounds() })
                      }
                    >
                      <i className="blue-dot" />
                      <span>今日打电话量</span>
                      <b>
                        {d.todayCalls.total}
                        <small> 通</small>
                      </b>
                    </Link>
                    <Link
                      to={
                        "/call-records?" +
                        queryString({
                          types: ["call"],
                          results: ["contact_added"],
                          ...todayBounds(),
                        })
                      }
                    >
                      <i className="green-dot" />
                      <span>成功添加联系方式</span>
                      <b>
                        {d.todayCalls.contactAdded}
                        <small> 个</small>
                      </b>
                    </Link>
                    <div>
                      <i />
                      <span>成功添加 / 电销记录</span>
                      <b>
                        {d.todayCalls.rate === null
                          ? "—"
                          : `${Math.round(d.todayCalls.rate)}%`}
                      </b>
                    </div>
                  </div>
                </div>
                {d.todayCalls.total === 0 ? (
                  <p className="muted centered">
                    暂无电销记录，完成沟通后记一笔。
                  </p>
                ) : null}
              </Panel>
              <Panel
                title={
                  <>
                    客户状态分布 <small>当前阶段</small>
                  </>
                }
              >
                {(["added", "opened", "shipped"] as Status[]).map((s) => (
                  <Link
                    key={s}
                    to={"/customers?status=" + s}
                    className={`stage-row ${s}`}
                  >
                    <span>{statusLabels[s]}</span>
                    <div className="stage-track">
                      <div
                        style={{
                          width: `${d.customers.total && d.stages[s] > 0 ? Math.max(4, (d.stages[s] / d.customers.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <b>{d.stages[s]}</b>
                  </Link>
                ))}
                <p className="panel-note">
                  按客户当前阶段统计，每个客户计入一个阶段。
                </p>
              </Panel>
            </div>
          </div>
          <div className="updated-at">
            <ClockCircleOutlined /> 更新于 {formatDate(d.asOf)} · 上海时间
          </div>
        </>
      ) : null}
    </>
  );
}
