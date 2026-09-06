import type { BackendAgent } from "../agents/backend";
import type { FrontendAgent } from "../agents/frontend";

import {
  TaskReportSchema,
  type TaskAssignment,
  type TaskReport,
} from "../protocol/team-messages";
import type { OwnershipVerifier } from "../projects/ownership";

export class TeamRouter {
  constructor(
    private readonly backend:
      BackendAgent,

    private readonly frontend:
      FrontendAgent,
    private readonly ownership?: OwnershipVerifier,
  ) {}

  async routeTask(
    assignment: TaskAssignment,
  ): Promise<TaskReport> {
    console.log(
      `[ROUTER] Routing task ${assignment.taskId} -> ${assignment.assignedTo.toUpperCase()}`,
    );

    const message =
      this.createDeveloperPrompt(
        assignment,
      );

    const result =
      assignment.assignedTo ===
      "backend"
        ? await this.backend.sendStructured(
            message,
            TaskReportSchema,
          )
        : await this.frontend.sendStructured(
            message,
            TaskReportSchema,
          );

    this.assertReportMatchesAssignment(
      assignment,
      result.data,
    );

    if (result.data.status === "READY_FOR_REVIEW" && this.ownership) {
      const validation = await this.ownership.validateGitDiff(assignment, result.data);
      if (!validation.ok) {
        throw new Error(`Ownership verification rejected TASK_REPORT:\n${validation.violations.join("\n")}`);
      }
    }

    console.log(
      `[ROUTER] Task report received: ${result.data.taskId} / ${result.data.status}`,
    );

    return result.data;
  }

  private createDeveloperPrompt(
    assignment: TaskAssignment,
  ): string {
    return `
You have received a formal TASK_ASSIGNMENT from the Software Architect.

The assignment below is authoritative.

TASK_ASSIGNMENT:
${JSON.stringify(
  assignment,
  null,
  2,
)}

Execute this task according to the assignment and your role instructions.

Important rules:

- Do not expand the scope.
- Do not modify forbidden paths.
- Do not modify shared architectural layers unless explicitly allowed by the assignment.
- Do not invent product or architectural decisions.
- If the task cannot be completed safely within the assignment, return BLOCKED.
- Run the requested validation commands when they are concrete and available.
- Never report APPROVED. Developers can only report READY_FOR_REVIEW, BLOCKED, or FAILED.
- Report exactly one TASK_REPORT when finished.

The TASK_REPORT must refer to taskId "${assignment.taskId}".

The agent field must be "${assignment.assignedTo}".
`;
  }

  private assertReportMatchesAssignment(
    assignment: TaskAssignment,
    report: TaskReport,
  ): void {
    if (
      report.taskId !==
      assignment.taskId
    ) {
      throw new Error(
        [
          "Developer report task mismatch.",
          `Expected: ${assignment.taskId}`,
          `Received: ${report.taskId}`,
        ].join("\n"),
      );
    }

    if (
      report.agent !==
      assignment.assignedTo
    ) {
      throw new Error(
        [
          "Developer report agent mismatch.",
          `Expected: ${assignment.assignedTo}`,
          `Received: ${report.agent}`,
        ].join("\n"),
      );
    }
  }
}
