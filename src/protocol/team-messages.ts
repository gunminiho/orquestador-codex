import { z } from "zod";

/*
 * =======================================
 * SHARED
 * =======================================
 */

export const AgentRoleSchema =
  z.enum([
    "architect",
    "backend",
    "frontend",
  ]);

export type AgentRole =
  z.infer<
    typeof AgentRoleSchema
  >;

export const DeveloperRoleSchema =
  z.enum([
    "backend",
    "frontend",
  ]);

export type DeveloperRole =
  z.infer<
    typeof DeveloperRoleSchema
  >;

/*
 * =======================================
 * TASK ASSIGNMENT
 * Architect -> Developer
 * =======================================
 */

export const TaskAssignmentSchema =
  z.object({
    type: z.literal(
      "TASK_ASSIGNMENT",
    ),

    taskId: z.string().min(1),

    assignedTo:
      DeveloperRoleSchema,

    title: z.string().min(1),

    objective:
      z.string().min(1),

    context:
      z.string().default(""),

    requirements:
      z.array(
        z.string().min(1),
      ),

    acceptanceCriteria:
      z.array(
        z.string().min(1),
      ),

    allowedPaths:
      z.array(
        z.string().min(1),
      ),

    // V2 repository-aware scopes remove ambiguity for multi-repository projects.
    allowedScopes: z.array(z.object({ repositoryId: z.string().min(1), patterns: z.array(z.string().min(1)).min(1) })).optional(),

    forbiddenPaths:
      z.array(
        z.string().min(1),
      ),
    forbiddenScopes: z.array(z.object({ repositoryId: z.string().min(1), patterns: z.array(z.string().min(1)).min(1) })).optional(),

    validationCommands:
      z.array(
        z.string().min(1),
      ),

    notes:
      z.array(
        z.string(),
      ).default([]),
  });

export type TaskAssignment =
  z.infer<
    typeof TaskAssignmentSchema
  >;

/*
 * =======================================
 * TASK REPORT
 * Developer -> Architect
 * =======================================
 */

export const TaskReportSchema =
  z.object({
    type: z.literal(
      "TASK_REPORT",
    ),

    taskId:
      z.string().min(1),

    agent:
      DeveloperRoleSchema,

    status:
      z.enum([
        "READY_FOR_REVIEW",
        "BLOCKED",
        "FAILED",
      ]),

    summary:
      z.string().min(1),

    filesChanged:
      z.array(
        z.string(),
      ),

    testsChanged:
      z.array(
        z.string(),
      ),

    validations:
      z.array(
        z.object({
          command:
            z.string().min(1),

          status:
            z.enum([
              "PASSED",
              "FAILED",
              "NOT_RUN",
            ]),

          details:
            z.string().default(""),
        }),
      ),

    risks:
      z.array(
        z.string(),
      ),

    blockers:
      z.array(
        z.string(),
      ),

    notes:
      z.array(
        z.string(),
      ).default([]),
  });

export type TaskReport =
  z.infer<
    typeof TaskReportSchema
  >;

/*
 * =======================================
 * REVIEW RESULT
 * Architect -> Developer
 * =======================================
 */

export const ReviewResultSchema =
  z.object({
    type: z.literal(
      "REVIEW_RESULT",
    ),

    taskId:
      z.string().min(1),

    reviewedAgent:
      DeveloperRoleSchema,

    decision:
      z.enum([
        "APPROVED",
        "CHANGES_REQUESTED",
        "REJECTED",
      ]),

    summary:
      z.string().min(1),

    findings:
      z.array(
        z.string(),
      ),

    requiredChanges:
      z.array(
        z.string(),
      ),

    validationRequired:
      z.array(
        z.string(),
      ),
  });

export type ReviewResult =
  z.infer<
    typeof ReviewResultSchema
  >;

/*
 * =======================================
 * OWNER INPUT
 * Architect -> Product Owner
 * =======================================
 */

export const OwnerInputRequestSchema =
  z.object({
    type: z.literal(
      "OWNER_INPUT_REQUIRED",
    ),

    reason:
      z.string().min(1),

    question:
      z.string().min(1),

    options:
      z.array(
        z.string(),
      ).default([]),
  });

export type OwnerInputRequest =
  z.infer<
    typeof OwnerInputRequestSchema
  >;

/*
 * =======================================
 * ARCHITECT ACTION
 * =======================================
 */

export const ArchitectActionSchema =
  z.discriminatedUnion(
    "type",
    [
      TaskAssignmentSchema,
      ReviewResultSchema,
      OwnerInputRequestSchema,
    ],
  );

export type ArchitectAction =
  z.infer<
    typeof ArchitectActionSchema
  >;
