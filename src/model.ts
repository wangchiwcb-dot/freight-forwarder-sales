import {
  resultLabels as sharedResults,
  deriveNextJudge,
  CALL_RESULTS,
  VISIT_RESULTS,
} from "../shared/contracts";
export type {
  Role,
  Status,
  Source,
  ActivityType,
  User,
  Customer,
  Activity,
  FollowUp,
  Team,
  Assignee,
  Dashboard,
  Impact,
} from "../shared/contracts";
export type {
  NextJudge as Judge,
  FollowUpAction as FollowAction,
  ActivitySummary as Summary,
  AuditLog as Audit,
  ApiResponse as Envelope,
} from "../shared/contracts";
export {
  statusLabels,
  sourceLabels,
  actionLabels,
  judgeLabels,
  roleLabels,
} from "../shared/contracts";
export const resultLabels: Record<string, string> = sharedResults;
export const sourceColors = {
  call: "#185492",
  visit: "#2E7BC4",
  friend_referral: "#1FA97C",
  customer_referral: "#13805F",
  xiaohongshu: "#E8942E",
  douyin: "#B56C16",
  other_online: "#8A95A3",
};
export const resultsByType = {
  call: [...CALL_RESULTS] as string[],
  visit: [...VISIT_RESULTS] as string[],
};
export const deriveJudge = deriveNextJudge;
export const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
export interface Scope {
  scope: "mine" | "team" | "company";
  teamId?: string;
  ownerId?: string;
}
