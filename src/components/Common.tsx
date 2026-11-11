import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Empty,
  Pagination,
  Skeleton,
  Tag,
  Form,
  Input,
  Modal,
} from "antd";
import {
  CheckCircleOutlined,
  IdcardOutlined,
  UserAddOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { ApiError } from "../api";
import {
  statusLabels,
  sourceLabels,
  sourceColors,
  judgeLabels,
  resultLabels,
  type Status,
  type Source,
  type Judge,
} from "../model";
dayjs.extend(utc);
dayjs.extend(timezone);
export const shanghai = (value?: string) => dayjs(value).tz("Asia/Shanghai");
export const formatDate = (value?: string | null) =>
  value ? shanghai(value).format("YYYY-MM-DD HH:mm") : "—";
export const todayBounds = () => ({
  dateFrom: shanghai().startOf("day").format(),
  dateTo: shanghai().startOf("day").add(1, "day").format(),
});
export function useDebounce<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}
export function useMobile() {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 768px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 768px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}
export function Panel({
  title,
  extra,
  children,
  className = "",
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-header">
        <h2>{title}</h2>
        {extra}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
export function StatusBadge({ status }: { status: Status }) {
  const icons = {
    added: <UserAddOutlined />,
    opened: <IdcardOutlined />,
    shipped: <CheckCircleOutlined />,
  };
  return (
    <span className={`status-badge ${status}`}>
      <i />
      {icons[status]}
      {statusLabels[status]}
    </span>
  );
}
export function SourceTag({ source }: { source: Source }) {
  return (
    <span className="source-tag">
      <i style={{ background: sourceColors[source] }} />
      {sourceLabels[source]}
    </span>
  );
}
export function ResultTag({ result }: { result: string }) {
  return (
    <Tag
      color={
        result === "contact_added" || result.includes("interested")
          ? "green"
          : result.includes("rejected")
            ? "red"
            : result.includes("deferred")
              ? "orange"
              : undefined
      }
    >
      {resultLabels[result] || result}
    </Tag>
  );
}
export function JudgeTag({ judge }: { judge: Judge }) {
  return (
    <Tag
      color={
        judge === "revisit" ? "green" : judge === "defer" ? "orange" : "red"
      }
    >
      {judgeLabels[judge]}
    </Tag>
  );
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  const e = error instanceof Error ? error : new Error("请求失败");
  const conflict = error instanceof ApiError && error.status === 409;
  return (
    <Alert
      className="error-notice"
      type="error"
      showIcon
      message={conflict ? "资料已发生变化" : e.message}
      description={
        <>
          {conflict ? (
            <div>
              {e.message}。已保留您的输入，请查看最新资料后再决定如何修改。
            </div>
          ) : null}
          {error instanceof ApiError && error.requestId ? (
            <small>请求编号：{error.requestId}</small>
          ) : null}
        </>
      }
      action={
        retry ? (
          <Button size="small" icon={<ReloadOutlined />} onClick={retry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}
export function Loading() {
  return (
    <div className="loading-panel">
      <Skeleton active paragraph={{ rows: 5 }} />
    </div>
  );
}
export function Blank({
  title = "暂无记录",
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <>
          <strong>{title}</strong>
          {description ? <p>{description}</p> : null}
        </>
      }
    >
      {action}
    </Empty>
  );
}
export function Pager({
  page,
  total,
  onChange,
  pageSize = 20,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  pageSize?: number;
}) {
  return (
    <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        onChange={onChange}
        showSizeChanger={false}
        showTotal={(n) => `共 ${n} 条`}
        size="small"
      />
    </div>
  );
}
export function ReasonModal({
  open,
  title,
  description,
  onCancel,
  onSubmit,
  busy,
  error,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
  busy?: boolean;
  error?: unknown;
  children?: ReactNode;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={busy}
      destroyOnHidden
      afterClose={() => form.resetFields()}
      okText="确认"
      cancelText="取消"
    >
      <p className="muted">{description}</p>
      <ErrorNotice error={error} />
      {children}
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => void onSubmit(v.reason).catch(() => {})}
      >
        <Form.Item
          name="reason"
          label="操作原因"
          rules={[
            { required: true, whitespace: true, message: "请填写操作原因" },
            { max: 500 },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
