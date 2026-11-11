import { z } from "zod";
import {
  customerCreateSchema,
  customerChangesSchema,
  activityCreateSchema,
  followUpSchema,
  convertSchema,
  reasonSchema,
  nextFollowAtSchema,
  STATUSES,
  SOURCES,
  ACTIONS,
  RESULTS,
  CALL_RESULTS,
  VISIT_RESULTS,
  phoneSchema,
  deriveNextJudge,
} from "../shared/contracts.js";
export const statuses = STATUSES;
export const sources = SOURCES;
export const actions = ACTIONS;
export const results = RESULTS;
export const callResults = CALL_RESULTS;
export const visitResults = VISIT_RESULTS;
export const phone = phoneSchema;
export const reason = reasonSchema;
export const expectedVersion = z.number().int().positive();
export const customerCreate = customerCreateSchema;
export const customerPatch = z
  .object({ expectedVersion, changes: customerChangesSchema })
  .strict();
export const activityCreate = activityCreateSchema;
export const followUp = followUpSchema;
export const convert = convertSchema;
export const nextFollowAt = nextFollowAtSchema;
export const deriveJudge = deriveNextJudge;
