import { z } from "zod";
import {
  OwnerInputRequestSchema,
  ReviewResultSchema,
  TaskAssignmentSchema,
  TaskReportSchema,
} from "../protocol/team-messages";

export const WorkflowIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, "Unsafe workflow id")
  .refine((id) => id !== "." && id !== "..", "Unsafe workflow id");
export const ProjectIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Unsafe project id");
export const WorkflowStateSchema = z.enum([
  "PENDING",
  "PLANNING",
  "ASSIGNED",
  "IMPLEMENTING",
  "READY_FOR_REVIEW",
  "REVIEWING",
  "CHANGES_REQUESTED",
  "WAITING_FOR_OWNER_INPUT",
  "PAUSED_RATE_LIMIT",
  "PAUSED_TRANSIENT",
  "PAUSED_MANUAL",
  "BLOCKED",
  "FAILED",
  "APPROVED",
  "CANCELLED",
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export const TERMINAL_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "APPROVED",
  "FAILED",
  "CANCELLED",
]);

const ScopeSchema = z.object({
  repositoryId: z.string().min(1),
  patterns: z.array(z.string().min(1)).min(1),
});
const BaselineSchema = z.object({
  repositoryId: z.string(),
  head: z.string().nullable(),
  files: z.record(z.string(), z.string()),
  worktreePath: z.string().nullable(),
});
export const ImplementationAttemptSchema = z.object({
  attemptId: z.string(),
  workflowId: z.string(),
  taskId: z.string(),
  assignedAgent: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  repositoryId: z.string(),
  worktreePath: z.string().nullable(),
  baseCommitSha: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(["RUNNING", "INTERRUPTED", "COMPLETED", "CANCELLED"]),
  correctionAttempt: z.number().int().nonnegative(),
  reportPersisted: z.boolean(),
  reconciliationState: z.enum([
    "NONE",
    "REPORT_CONTINUE",
    "SAFE_RETRY",
    "RECONCILED",
  ]),
});
export type ImplementationAttempt = z.infer<typeof ImplementationAttemptSchema>;
const WorktreeSchema = z.object({
  repositoryId: z.string(),
  originalRepositoryRoot: z.string(),
  baseCommitSha: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  workflowId: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  originalBranch: z.string().default(""),
  createdByOrchestrator: z.literal(true),
});
export const DeliverySchema = z.object({
  repositoryId: z.string(),
  taskId: z.string(),
  baseCommitSha: z.string(),
  resultCommitSha: z.string(),
  branch: z.string(),
  originalRepositoryRoot: z.string(),
  originalBranch: z.string(),
  status: z.enum(["READY_TO_INTEGRATE", "INTEGRATED", "OWNER_ACTION_REQUIRED"]),
  finalizedAt: z.string(),
  integratedAt: z.string().nullable(),
  integrationReason: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;
const ManualReconciliationSchema = z.object({
  reason: z.string(),
  repositoryId: z.string(),
  physicalRoot: z.string(),
  ownerWorkflowId: z.string(),
  ownerTaskId: z.string(),
  detectedAt: z.string(),
});
export const WorkflowSchema = z.object({
  attempts: z.array(ImplementationAttemptSchema).default([]),
  worktrees: z.array(WorktreeSchema).default([]),
  deliveries: z.array(DeliverySchema).default([]),
  manualReconciliation: ManualReconciliationSchema.nullable().default(null),
  cancellationRequestedAt: z.string().nullable().default(null),
  activeTurn: z
    .object({
      workflowId: z.string(),
      attemptId: z.string().nullable(),
      role: z.string(),
      threadId: z.string(),
      turnId: z.string().nullable(),
      startedAt: z.string(),
    })
    .nullable()
    .default(null),
  version: z.literal(2),
  id: WorkflowIdSchema,
  projectId: ProjectIdSchema,
  ownerRequest: z.string().min(1),
  state: WorkflowStateSchema,
  phase: z.string().min(1),
  assignedAgent: z.string().nullable(),
  assignment: TaskAssignmentSchema.nullable(),
  reports: z.array(TaskReportSchema),
  reviews: z.array(ReviewResultSchema),
  retryCount: z.number().int().nonnegative(),
  threadIds: z.record(z.string(), z.string()),
  pendingAction: z.string().nullable(),
  ownershipValidations: z.array(
    z.object({
      at: z.string(),
      ok: z.boolean(),
      violations: z.array(z.string()),
      source: z.string(),
    }),
  ),
  validationResults: z.array(z.string()),
  rateLimit: z
    .object({
      pausedAt: z.string(),
      retryAfter: z.string().nullable(),
      snapshot: z.unknown().nullable(),
      previousState: WorkflowStateSchema.optional(),
      nextCheckAt: z.string().nullable().optional(),
      attempts: z.number().int().nonnegative().optional(),
      pendingAction: z.string().nullable().optional(),
      agentRole: z.string().nullable().optional(),
    })
    .nullable(),
  transient: z
    .object({
      previousState: WorkflowStateSchema,
      retryAt: z.string(),
      attempts: z.number().int().nonnegative(),
    })
    .nullable(),
  ownerInput: z
    .object({
      request: OwnerInputRequestSchema,
      priorState: WorkflowStateSchema,
      answer: z.string().nullable(),
    })
    .nullable(),
  baselines: z.array(BaselineSchema),
  allowedScopes: z.array(ScopeSchema),
  forbiddenScopes: z.array(ScopeSchema),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  checkpoints: z.array(
    z.object({ at: z.string(), action: z.string(), detail: z.string() }),
  ),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

const active: WorkflowState[] = [
  "PLANNING",
  "ASSIGNED",
  "IMPLEMENTING",
  "READY_FOR_REVIEW",
  "REVIEWING",
  "CHANGES_REQUESTED",
];
const allowed: Record<WorkflowState, WorkflowState[]> = {
  PENDING: [
    "PLANNING",
    "PAUSED_RATE_LIMIT",
    "PAUSED_TRANSIENT",
    "PAUSED_MANUAL",
    "CANCELLED",
    "FAILED",
  ],
  PLANNING: [
    "ASSIGNED",
    "WAITING_FOR_OWNER_INPUT",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ],
  ASSIGNED: ["IMPLEMENTING", "CANCELLED", "FAILED"],
  IMPLEMENTING: ["READY_FOR_REVIEW", "BLOCKED", "FAILED", "CANCELLED"],
  READY_FOR_REVIEW: ["REVIEWING", "FAILED", "CANCELLED"],
  REVIEWING: [
    "APPROVED",
    "CHANGES_REQUESTED",
    "WAITING_FOR_OWNER_INPUT",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ],
  CHANGES_REQUESTED: ["IMPLEMENTING", "CANCELLED", "FAILED"],
  WAITING_FOR_OWNER_INPUT: ["PLANNING", "REVIEWING", "CANCELLED", "FAILED"],
  PAUSED_RATE_LIMIT: [
    "PENDING",
    "PAUSED_TRANSIENT",
    ...active,
    "WAITING_FOR_OWNER_INPUT",
    "PAUSED_MANUAL",
    "CANCELLED",
    "FAILED",
  ],
  PAUSED_TRANSIENT: [
    "PENDING",
    "PAUSED_RATE_LIMIT",
    ...active,
    "WAITING_FOR_OWNER_INPUT",
    "PAUSED_MANUAL",
    "CANCELLED",
    "FAILED",
  ],
  PAUSED_MANUAL: [...active, "WAITING_FOR_OWNER_INPUT", "CANCELLED", "FAILED"],
  BLOCKED: ["PLANNING", "IMPLEMENTING", "CANCELLED", "FAILED"],
  FAILED: [],
  APPROVED: [],
  CANCELLED: [],
};
for (const state of active)
  allowed[state] = [
    ...allowed[state],
    "PAUSED_RATE_LIMIT",
    "PAUSED_TRANSIENT",
    "PAUSED_MANUAL",
  ];
export function isTerminal(state: WorkflowState) {
  return TERMINAL_WORKFLOW_STATES.has(state);
}
export function transition(
  workflow: Workflow,
  state: WorkflowState,
  detail: string,
): Workflow {
  if (isTerminal(workflow.state) && workflow.state !== state)
    throw new Error(
      `Terminal workflow cannot transition: ${workflow.state} -> ${state}`,
    );
  if (workflow.state !== state && !allowed[workflow.state].includes(state))
    throw new Error(
      `Invalid workflow transition ${workflow.state} -> ${state}`,
    );
  const now = new Date().toISOString();
  return {
    ...workflow,
    state,
    updatedAt: now,
    checkpoints: [
      ...workflow.checkpoints,
      { at: now, action: `${workflow.state}->${state}`, detail },
    ],
  };
}
export function newWorkflow(
  projectId: string,
  ownerRequest: string,
  id?: string,
): Workflow {
  const safeProjectId = ProjectIdSchema.parse(projectId);
  const workflowId = WorkflowIdSchema.parse(id ?? crypto.randomUUID());
  const now = new Date().toISOString();
  return {
    attempts: [],
    worktrees: [],
    deliveries: [],
    manualReconciliation: null,
    cancellationRequestedAt: null,
    activeTurn: null,
    version: 2,
    id: workflowId,
    projectId: safeProjectId,
    ownerRequest,
    state: "PENDING",
    phase: "planning",
    assignedAgent: null,
    assignment: null,
    reports: [],
    reviews: [],
    retryCount: 0,
    threadIds: {},
    pendingAction: "plan",
    ownershipValidations: [],
    validationResults: [],
    rateLimit: null,
    transient: null,
    ownerInput: null,
    baselines: [],
    allowedScopes: [],
    forbiddenScopes: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
    checkpoints: [{ at: now, action: "created", detail: "Workflow created" }],
  };
}
