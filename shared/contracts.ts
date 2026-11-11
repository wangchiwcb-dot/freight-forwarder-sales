import { z } from "zod";

export const STATUSES = ["added", "opened", "shipped"] as const;
export const SOURCES = [
  "call",
  "visit",
  "friend_referral",
  "customer_referral",
  "xiaohongshu",
  "douyin",
  "other_online",
] as const;
export const ACTIONS = ["greeting", "quote", "inquiry", "order"] as const;
export const CALL_RESULTS = [
  "unanswered",
  "invalid_number",
  "call_rejected",
  "call_deferred",
  "call_interested",
  "contact_added",
] as const;
export const VISIT_RESULTS = [
  "no_entry",
  "visit_rejected",
  "visit_deferred",
  "visit_interested",
  "contact_added",
] as const;
export const RESULTS = [
  ...CALL_RESULTS,
  "no_entry",
  "visit_rejected",
  "visit_deferred",
  "visit_interested",
] as const;
export const JUDGES = ["revisit", "defer", "reject"] as const;
export const ROLES = ["sales", "manager", "admin"] as const;
export type Status = (typeof STATUSES)[number];
export type Source = (typeof SOURCES)[number];
export type FollowUpAction = (typeof ACTIONS)[number];
export type ActivityType = "call" | "visit";
export type ActivityResult = (typeof RESULTS)[number];
export type NextJudge = (typeof JUDGES)[number];
export type Role = (typeof ROLES)[number];
export type Scope = "mine" | "team" | "company";
export const statusLabels: Record<Status, string> = {
  added: "已添加",
  opened: "已开户",
  shipped: "已走货",
};
export const sourceLabels: Record<Source, string> = {
  call: "电销",
  visit: "扫楼",
  friend_referral: "朋友介绍",
  customer_referral: "客户介绍",
  xiaohongshu: "小红书",
  douyin: "抖音",
  other_online: "其他网络平台",
};
export const actionLabels: Record<FollowUpAction, string> = {
  greeting: "正常问候",
  quote: "发报价表",
  inquiry: "客户询价",
  order: "客户下单",
};
export const resultLabels: Record<ActivityResult, string> = {
  unanswered: "未接通",
  invalid_number: "空号·停机",
  call_rejected: "已接通·拒绝",
  call_deferred: "已接通·暂缓",
  call_interested: "已接通·有意向",
  contact_added: "成功添加联系方式",
  no_entry: "无人·未进门",
  visit_rejected: "已沟通·拒绝",
  visit_deferred: "已沟通·暂缓",
  visit_interested: "已沟通·有意向",
};
export const judgeLabels: Record<NextJudge, string> = {
  revisit: "可再访",
  defer: "暂缓",
  reject: "拒绝",
};
export const roleLabels: Record<Role, string> = {
  sales: "销售顾问",
  manager: "销售主管",
  admin: "管理员",
};
export const typeLabels: Record<ActivityType, string> = {
  call: "电销",
  visit: "扫楼",
};
export function deriveNextJudge(result: string): NextJudge {
  return result.endsWith("_rejected")
    ? "reject"
    : result.endsWith("_deferred")
      ? "defer"
      : "revisit";
}
export const metadata = {
  statuses: statusLabels,
  sources: sourceLabels,
  actions: actionLabels,
  results: resultLabels,
  judges: judgeLabels,
  roles: roleLabels,
  timeZone: "Asia/Shanghai",
  callResults: CALL_RESULTS,
  visitResults: VISIT_RESULTS,
};

const text = (max: number) => z.string().trim().max(max, `不能超过${max}字`);
export const phoneSchema = z
  .string()
  .transform((v) => v.replace(/\s/g, ""))
  .pipe(z.string().regex(/^1[3-9]\d{9}$/, "请输入有效的大陆手机号"));
export const reasonSchema = text(500).min(1, "请填写操作原因");
export const nextFollowAtSchema = z.iso.datetime({ offset: true }).nullable();
export const customerFields = {
  name: text(200).min(1, "请填写客户名称"),
  contact: text(100).optional(),
  phone: phoneSchema,
  altPhone: text(50).optional(),
  wechat: text(100).optional(),
  email: text(254)
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "请输入有效邮箱")
    .optional(),
  source: z.enum(SOURCES),
  address: text(500).optional(),
  needs: text(2000).optional(),
  note: text(4000).optional(),
  highIntent: z.boolean().optional(),
};
export const customerCreateSchema = z.object(customerFields).strict();
export const customerChangesSchema = z
  .object(customerFields)
  .partial()
  .extend({ nextFollowAt: nextFollowAtSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "请提交修改内容");
export const statusChangeSchema = z
  .object({
    toStatus: z.enum(STATUSES),
    confirmed: z.literal(true),
    reason: reasonSchema.optional(),
  })
  .strict();
export const followUpSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(ACTIONS),
    content: text(4000).min(1, "请填写跟进内容"),
    nextFollowAt: nextFollowAtSchema.optional(),
    statusChange: statusChangeSchema.optional(),
  })
  .strict()
  .refine(
    (v) => !v.statusChange || v.action === "order",
    "只有客户下单可以同时晋级",
  );
export const activityFields = {
  type: z.enum(["call", "visit"]),
  customerName: text(200).min(1, "请填写客户名称"),
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  address: text(500).optional(),
  result: z.enum(RESULTS),
  nextJudge: z.enum(JUDGES).optional(),
  note: text(4000).optional(),
};
export const activityCreateSchema = z
  .object(activityFields)
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === "call" && !v.phone)
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: "电销记录需要手机号",
      });
    if (v.type === "call" && v.address)
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "电销记录不填写扫楼地址",
      });
    if (v.type === "visit" && !v.address)
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "请填写扫楼地址",
      });
    const options: readonly string[] =
      v.type === "call" ? CALL_RESULTS : VISIT_RESULTS;
    if (!options.includes(v.result))
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "沟通结果与记录类型不一致",
      });
  });
const conversionCustomer = z
  .object(customerFields)
  .omit({ source: true })
  .strict();
export const convertSchema = z.discriminatedUnion("mode", [
  z
    .object({
      expectedVersion: z.number().int().positive(),
      mode: z.literal("create"),
      customer: conversionCustomer,
      ownerId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      expectedVersion: z.number().int().positive(),
      mode: z.literal("link"),
      customerId: z.uuid(),
    })
    .strict(),
]);
export type CustomerInput = z.infer<typeof customerCreateSchema>;
export type CustomerChanges = z.infer<typeof customerChangesSchema>;
export type ActivityInput = z.infer<typeof activityCreateSchema>;
export type FollowUpInput = z.infer<typeof followUpSchema>;
export type ConvertInput = z.infer<typeof convertSchema>;

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  teamId: string | null;
  teamName?: string | null;
  enabled: boolean;
  mustChangePassword: boolean;
  version: number;
  allowedScopes?: Scope[];
  source?: "demo" | "postgres";
}
export interface Team {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  createdAt?: string;
}
export interface Customer {
  id: string;
  name: string;
  contact: string;
  phone: string;
  altPhone: string;
  wechat: string;
  email: string;
  source: Source;
  status: Status;
  address: string;
  needs: string;
  note: string;
  highIntent: boolean;
  ownerId: string;
  ownerName: string;
  lastFollowAt: string | null;
  nextFollowAt: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface FollowUp {
  id: string;
  customerId: string;
  actorId: string;
  actorName?: string;
  action: FollowUpAction;
  content: string;
  occurredAt: string;
  nextFollowAt: string | null;
  reminderAction: "unchanged" | "set" | "clear";
}
export interface Activity {
  id: string;
  ownerId: string;
  ownerName: string;
  type: ActivityType;
  customerName: string;
  phone: string;
  address: string;
  result: ActivityResult;
  nextJudge: NextJudge;
  note: string;
  occurredAt: string;
  createdAt: string;
  version: number;
  converted: boolean;
  convertedCustomerId: string | null;
  convertedAt: string | null;
  convertedBy?: string | null;
  customerLinkVisible: boolean;
}
export interface Assignee {
  id: string;
  displayName: string;
  teamId: string | null;
}
export interface Dashboard {
  scope: Scope;
  timeZone: string;
  asOf: string;
  customers: {
    total: number;
    opened: number;
    shipped: number;
    openedRate: number | null;
    shippedRate: number | null;
  };
  stages: Record<Status, number>;
  todayCalls: { total: number; contactAdded: number; rate: number | null };
  pendingFollowUps: { items: Customer[]; total: number };
  shipmentVolume: {
    dataStatus: "not_connected";
    week: { total: null; buckets: null };
    month: { total: null; buckets: null };
  };
}
export interface ActivitySummary {
  total: number;
  calls: number;
  visits: number;
  contactAdded: number;
}
export interface AuditLog {
  id: string;
  actorId: string | null;
  actorName?: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  requestId: string;
  reason: string | null;
  changes: Record<string, unknown>;
  createdAt: string;
}
export interface Impact {
  userId: string;
  version: number;
  teamId: string | null;
  activeCustomerCount: number;
  archivedCustomerCount: number;
  activityCount: number;
}
export interface Meta {
  requestId: string;
  serverTime: string;
  page?: number;
  pageSize?: number;
  total?: number;
}
export interface ApiResponse<T> {
  data: T;
  meta: Meta;
}
export interface ApiFailure {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
  meta: Meta;
}
