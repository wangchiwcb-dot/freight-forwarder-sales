import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import {
  App,
  Alert,
  Button,
  Dropdown,
  Form,
  Input,
  Select,
  Tooltip,
} from "antd";
import {
  ApartmentOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BoxPlotOutlined,
  ContactsOutlined,
  LeftOutlined,
  LogoutOutlined,
  MenuUnfoldOutlined,
  PhoneOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UserAddOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useBlocker,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { request, resetSession, ApiError, useApi, queryString } from "./api";
import { WorkProvider, useWork } from "./context";
import {
  roleLabels,
  type User,
  type Team,
  type Assignee,
  type Dashboard,
  type Summary,
} from "./model";
import { ErrorNotice, Loading, shanghai } from "./components/Common";
const DashboardPage = lazy(() =>
  import("./features/Dashboard").then((m) => ({ default: m.DashboardPage })),
);
const CustomersPage = lazy(() =>
  import("./features/Customers").then((m) => ({ default: m.CustomersPage })),
);
const ActivitiesPage = lazy(() =>
  import("./features/Activities").then((m) => ({ default: m.ActivitiesPage })),
);
const LeadsPage = lazy(() =>
  import("./features/Activities").then((m) => ({ default: m.LeadsPage })),
);
const AdministrationPage = lazy(() =>
  import("./features/Administration").then((m) => ({
    default: m.AdministrationPage,
  })),
);
export function Application() {
  const [user, setUser] = useState<User | null | undefined>();
  const [error, setError] = useState<Error | null>(null);
  const qc = useQueryClient();
  const load = () => {
    setError(null);
    void request<User>("/auth/me")
      .then((r) => setUser(r.data))
      .catch((e: Error) => {
        if (e instanceof ApiError && e.status === 401) setUser(null);
        else setError(e);
      });
  };
  useEffect(() => {
    load();
    const expired = () => {
      qc.clear();
      setUser(null);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  if (error)
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Brand />
          <h1>工作台暂时无法连接</h1>
          <ErrorNotice error={error} retry={load} />
        </div>
      </div>
    );
  if (user === undefined)
    return (
      <div className="auth-screen">
        <Loading />
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          resetSession();
          qc.clear();
          setUser(u);
        }}
      />
    );
  return (
    <WorkProvider key={user.id} user={user}>
      {user.mustChangePassword ? (
        <PasswordPage required />
      ) : (
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/change-password" element={<PasswordPage />} />
          <Route path="*" element={<WorkbenchLayout />} />
        </Routes>
      )}
    </WorkProvider>
  );
}
function Brand() {
  return (
    <div className="brand">
      <div className="brand-icon">
        <BoxPlotOutlined />
      </div>
      <div className="brand-text">
        <strong>中航环球</strong>
        <small>货代销售工作台</small>
      </div>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <Brand />
        <div className="auth-heading">
          <h1>欢迎回到销售工作台</h1>
          <p>记录每一次沟通，让客户跟进更有条理。</p>
        </div>
        <ErrorNotice error={error} />
        <Form
          layout="vertical"
          requiredMark={false}
          onFinish={async (v: { username: string; password: string }) => {
            setBusy(true);
            setError(null);
            try {
              const r = await request<User>("/auth/login", {
                method: "POST",
                body: JSON.stringify(v),
              });
              onLogin(r.data);
              if (location.pathname === "/login")
                navigate("/", { replace: true });
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            name="username"
            label="账号"
            rules={[{ required: true, message: "请输入账号" }]}
          >
            <Input
              autoComplete="username"
              prefix={<UserOutlined />}
              placeholder="请输入个人账号"
              size="large"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password
              autoComplete="current-password"
              placeholder="请输入密码"
              size="large"
            />
          </Form.Item>
          <Button
            htmlType="submit"
            type="primary"
            size="large"
            loading={busy}
            block
          >
            登录工作台
          </Button>
        </Form>
        <p className="auth-foot">
          <SafetyCertificateOutlined /> 仅供公司内部使用 · 账号问题请联系管理员
        </p>
      </div>
      <div className="auth-copyright">中航环球国际货运代理（深圳）</div>
    </div>
  );
}
function PasswordPage({ required = false }: { required?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { logout } = useWork();
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <Brand />
        <h1>{required ? "首次登录，请设置新密码" : "修改密码"}</h1>
        <p className="muted">使用至少14位的新密码。修改后需要重新登录。</p>
        <ErrorNotice error={error} />
        <Form
          layout="vertical"
          onFinish={async (v: {
            currentPassword: string;
            newPassword: string;
          }) => {
            setBusy(true);
            try {
              await request("/auth/change-password", {
                method: "POST",
                body: JSON.stringify({
                  currentPassword: v.currentPassword,
                  newPassword: v.newPassword,
                }),
              });
              resetSession();
              window.location.assign("/login");
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true }, { min: 14, message: "请至少输入14位" }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={["newPassword"]}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue("newPassword")
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次输入的密码不一致")),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button block type="primary" htmlType="submit" loading={busy}>
            保存新密码
          </Button>
        </Form>
        <div className="auth-links">
          {!required ? <Link to="/">返回工作台</Link> : null}
          <Button
            type="link"
            onClick={() => void logout().catch((e) => setError(e as Error))}
          >
            退出登录
          </Button>
        </div>
      </div>
    </div>
  );
}
const navigation = [
  { path: "/", label: "工作台", icon: <AppstoreOutlined /> },
  { path: "/customers", label: "客户管理", icon: <TeamOutlined /> },
  { path: "/leads", label: "电销·扫楼", icon: <PhoneOutlined /> },
  { path: "/call-records", label: "电销记录", icon: <UnorderedListOutlined /> },
];
function WorkbenchLayout() {
  const { user, scope, setScope, dirty, dirtyRef, logout } = useWork();
  const { modal, message } = App.useApp();
  const loc = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sales_sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const [fab, setFab] = useState(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current &&
      !(
        currentLocation.pathname === "/leads" &&
        nextLocation.pathname === "/leads"
      ),
  );
  useEffect(() => {
    if (blocker.state === "blocked") {
      const dialog = modal.confirm({
        title: "放弃尚未保存的内容？",
        content: "离开后当前输入不会保存。",
        okText: "放弃并离开",
        cancelText: "继续编辑",
        onOk: () => blocker.proceed(),
        onCancel: () => blocker.reset(),
      });
      return () => dialog.destroy();
    }
  }, [blocker, modal]);
  const stats = useApi<Dashboard>(
    ["nav", user.id, scope],
    "/dashboard?" + queryString(scope),
  );
  const summary = useApi<Summary>(
    ["nav-activities", user.id, scope],
    "/activities/summary?" + queryString(scope),
  );
  const teams = useApi<Team[]>(
    ["teams", user.id],
    "/teams?pageSize=100",
    user.role === "admin",
  );
  const assignees = useApi<Assignee[]>(
    ["assignees", user.id],
    "/assignees",
    user.role !== "sales",
  );
  const title = loc.pathname.startsWith("/customers")
    ? "客户管理"
    : loc.pathname.startsWith("/leads")
      ? "电销·扫楼"
      : loc.pathname.startsWith("/call-records")
        ? "电销记录"
        : loc.pathname.startsWith("/settings/users")
          ? "员工管理"
          : loc.pathname.startsWith("/settings/teams")
            ? "团队管理"
            : loc.pathname.startsWith("/settings/audit")
              ? "操作审计"
              : "工作台";
  const active = (path: string) =>
    path === "/" ? loc.pathname === "/" : loc.pathname.startsWith(path);
  const changeScope = (v: Partial<typeof scope>) => {
    if (dirty) {
      void message.warning("请先保存或关闭正在编辑的内容，再切换数据范围。");
      return;
    }
    setScope({ ...scope, ...v });
  };
  const signOut = () => {
    if (dirty) {
      modal.confirm({
        title: "放弃未保存内容并退出？",
        onOk: () => logout().catch((e) => message.error((e as Error).message)),
        okText: "退出",
        cancelText: "继续编辑",
      });
    } else void logout().catch((e) => message.error((e as Error).message));
  };
  function navItem(
    item: { path: string; label: string; icon: ReactNode },
    mobile = false,
  ) {
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={active(item.path) ? "page" : undefined}
        className={`${mobile ? "mobile-nav-item" : "nav-item"} ${active(item.path) ? "active" : ""}`}
        title={item.label}
      >
        {item.icon}
        <span>{item.label}</span>
        {!mobile && item.path === "/customers" ? (
          <b className="nav-count">{stats.data?.data.customers.total ?? "—"}</b>
        ) : null}
        {!mobile && item.path === "/call-records" ? (
          <b className="nav-count">{summary.data?.data.total ?? "—"}</b>
        ) : null}
      </Link>
    );
  }
  return (
    <div className={`workbench ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <Link to="/" className="brand-link">
          <Brand />
        </Link>
        <nav className="side-nav" aria-label="主导航">
          <div className="nav-section">销售</div>
          {navigation.map((i) => navItem(i))}
          {user.role === "admin" ? (
            <>
              <div className="nav-section">管理</div>
              {[
                {
                  path: "/settings/users",
                  label: "员工管理",
                  icon: <ContactsOutlined />,
                },
                {
                  path: "/settings/teams",
                  label: "团队管理",
                  icon: <ApartmentOutlined />,
                },
                {
                  path: "/settings/audit",
                  label: "操作审计",
                  icon: <AuditOutlined />,
                },
              ].map((i) => navItem(i))}
            </>
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <div className="user-avatar">{user.displayName.slice(0, 1)}</div>
          <div className="user-details">
            <strong>{user.displayName}</strong>
            <span>{roleLabels[user.role]}</span>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Button
            className="collapse-button"
            type="text"
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            icon={collapsed ? <MenuUnfoldOutlined /> : <LeftOutlined />}
            onClick={() => {
              setCollapsed(!collapsed);
              try {
                localStorage.setItem(
                  "sales_sidebar",
                  !collapsed ? "collapsed" : "expanded",
                );
              } catch {
                /* preference is optional */
              }
            }}
          />
          <span className="breadcrumb">
            销售工作台 <span>›</span> <strong>{title}</strong>
          </span>
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="topbar-right">
            <span className="today">{shanghai().format("YYYY年M月D日")}</span>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "password",
                    label: "修改密码",
                    icon: <SafetyCertificateOutlined />,
                    onClick: () => navigate("/change-password"),
                  },
                  ...(user.role === "admin"
                    ? [
                        {
                          key: "users",
                          label: "员工管理",
                          icon: <SettingOutlined />,
                          onClick: () => navigate("/settings/users"),
                        },
                        {
                          key: "teams",
                          label: "团队管理",
                          icon: <ApartmentOutlined />,
                          onClick: () => navigate("/settings/teams"),
                        },
                        {
                          key: "audit",
                          label: "操作审计",
                          icon: <AuditOutlined />,
                          onClick: () => navigate("/settings/audit"),
                        },
                      ]
                    : []),
                  {
                    key: "logout",
                    label: "退出登录",
                    icon: <LogoutOutlined />,
                    onClick: signOut,
                  },
                ],
              }}
            >
              <Button className="user-chip">
                <span className="user-avatar">
                  {user.displayName.slice(0, 1)}
                </span>
                <span className="user-chip-name">{user.displayName}</span>
              </Button>
            </Dropdown>
          </div>
        </header>
        <main className="content">
          {user.source === "demo" ? (
            <Alert
              className="demo-banner"
              banner
              type="info"
              message="演示环境 · 当前为虚构示例数据，请勿录入真实客户资料"
            />
          ) : null}
          <div className="scope-bar">
            <span>
              <span className="scope-dot" /> 数据范围
            </span>
            <Select
              aria-label="数据范围"
              value={scope.scope}
              onChange={(v) =>
                changeScope({ scope: v, teamId: undefined, ownerId: undefined })
              }
              options={[
                { value: "mine", label: "我的客户与记录" },
                ...(user.role === "manager"
                  ? [{ value: "team", label: "本团队" }]
                  : []),
                ...(user.role === "admin"
                  ? [{ value: "company", label: "全公司" }]
                  : []),
              ]}
            />
            {scope.scope === "company" ? (
              <Select
                allowClear
                placeholder="全部团队"
                aria-label="团队范围"
                value={scope.teamId}
                onChange={(teamId) =>
                  changeScope({ teamId, ownerId: undefined })
                }
                options={(teams.data?.data || []).map((t) => ({
                  value: t.id,
                  label: t.name,
                }))}
              />
            ) : null}
            {scope.scope !== "mine" ? (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="全部负责人"
                aria-label="负责人范围"
                value={scope.ownerId}
                onChange={(ownerId) => changeScope({ ownerId })}
                options={(assignees.data?.data || [])
                  .filter((a) => !scope.teamId || a.teamId === scope.teamId)
                  .map((a) => ({ value: a.id, label: a.displayName }))}
              />
            ) : null}
            <span className="scope-note">
              {scope.scope === "mine"
                ? "只显示您负责的数据"
                : "按当前团队与负责人归属统计"}
            </span>
          </div>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/customers/*" element={<CustomersPage />} />
              <Route path="/leads" element={<LeadsPage />} />
              <Route path="/call-records/*" element={<ActivitiesPage />} />
              <Route
                path="/settings/:section"
                element={
                  user.role === "admin" ? (
                    <AdministrationPage />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />
              <Route path="/:legacy.html" element={<LegacyRedirect />} />
              <Route
                path="*"
                element={
                  <div className="panel not-found">
                    <h1>页面不存在</h1>
                    <Link to="/">返回工作台</Link>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="底部导航">
        {navigation.map((i) => navItem(i, true))}
      </nav>
      {loc.pathname === "/" || loc.pathname === "/customers" ? (
        <div className="fab-wrap">
          {fab ? (
            <div className="fab-menu">
              <Link to="/customers/new" onClick={() => setFab(false)}>
                <UserAddOutlined /> 新增客户
              </Link>
              <Link to="/leads?tab=call" onClick={() => setFab(false)}>
                <PhoneOutlined /> 开始电销
              </Link>
              <Link to="/leads?tab=visit" onClick={() => setFab(false)}>
                <ApartmentOutlined /> 开始扫楼
              </Link>
            </div>
          ) : null}
          <Tooltip title="快捷操作">
            <Button
              type="primary"
              shape="circle"
              size="large"
              icon={<PlusOutlined rotate={fab ? 45 : 0} />}
              aria-label="快捷操作"
              onClick={() =>
                loc.pathname === "/customers"
                  ? navigate("/customers/new")
                  : setFab(!fab)
              }
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
function LegacyRedirect() {
  const loc = useLocation();
  const [q] = useSearchParams();
  const name = loc.pathname.split("/").pop();
  if (name === "index.html") return <Navigate replace to="/" />;
  if (name === "customers.html") {
    const id = q.get("id");
    const status = q.get("status");
    const map: Record<string, string> = {
      已添加: "added",
      已开户: "opened",
      已走货: "shipped",
    };
    return (
      <Navigate
        replace
        to={
          id
            ? `/customers/${encodeURIComponent(id)}`
            : q.get("new") === "1"
              ? "/customers/new"
              : `/customers${status && map[status] ? "?status=" + map[status] : ""}`
        }
      />
    );
  }
  if (name === "leads.html")
    return (
      <Navigate
        replace
        to={
          "/leads?tab=" +
          (["visit", "扫楼"].includes(q.get("tab") || "") ? "visit" : "call")
        }
      />
    );
  if (name === "call-records.html")
    return <Navigate replace to="/call-records" />;
  return <Navigate replace to="/" />;
}
