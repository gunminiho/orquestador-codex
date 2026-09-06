import type { ZodType } from "zod";

import {
  parseStructuredOutput,
  toCodexJsonSchema,
} from "../protocol/structured-output";

import type { ThreadStartParams } from "../../schemas/v2/ThreadStartParams";
import type { ThreadStartResponse } from "../../schemas/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../../schemas/v2/ThreadResumeResponse";

import {
  CodexAppServerClient,
  type RunTurnResult,
  type TurnOptions,
} from "../codex/app-server-client";

const ARCHITECT_INSTRUCTIONS = `
You are the Software Architect and technical lead of a multi-agent software engineering team.

Your responsibilities are:

- communicate with the project owner
- understand product and technical requirements
- maintain the global architectural vision
- define technical specifications
- define API and cross-repository contracts
- decompose features into implementation tasks
- delegate backend tasks to the Backend Senior Engineer
- delegate frontend tasks to the Frontend Senior Engineer
- inspect implementation reports
- inspect code, diffs, tests and CI evidence
- request corrections when acceptance criteria are not satisfied
- approve tasks only after verification
- maintain consistency between frontend and backend

Important operating rules:

- Do not declare developer work complete merely because the developer reports it as complete.
- Verify implementation evidence before approval, always use definition of done to approve a task.
- Do not silently alter product requirements.
- Do not implement normal product features yourself.
- Your primary role is architecture, planning, coordination and review.
- Cross-repository decisions belong to you.
- Backend and Frontend agents must report their work to you.
- When a decision requires product-owner input, explicitly request that decision.
`;

export class ArchitectAgent {
  private threadId: string | null = null;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly cwd: string,
    private readonly context = "",
  ) {}

  async start(existingThreadId?: string): Promise<{
    mode: "created" | "resumed";
    response: ThreadStartResponse | ThreadResumeResponse;
  }> {
    if (existingThreadId) {
      console.log(`[ARCHITECT] Resuming thread ${existingThreadId}...`);

      try {
        const response = await this.client.resumeThread({
          threadId: existingThreadId,

          cwd: this.cwd,

          developerInstructions: ARCHITECT_INSTRUCTIONS + this.context,

          excludeTurns: true,
        });

        this.threadId = response.thread.id;

        return {
          mode: "resumed",
          response,
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("no rollout found for thread id")
        )
          throw error;
      }
    }

    console.log("[ARCHITECT] No persisted thread found. Creating one...");

    const params: ThreadStartParams = {
      cwd: this.cwd,

      developerInstructions: ARCHITECT_INSTRUCTIONS + this.context,

      ephemeral: false,
    };

    const response = await this.client.startThread(params);

    this.threadId = response.thread.id;

    await this.client.runTurn(
      response.thread.id,
      "Materialize this persistent thread. Do not inspect files, run commands, or modify anything. Reply ARCHITECT_READY.",
    );

    return {
      mode: "created",
      response,
    };
  }

  async send(message: string): Promise<RunTurnResult> {
    if (!this.threadId) {
      throw new Error("Architect thread has not been started.");
    }

    return this.client.runTurn(this.threadId, message);
  }

  async sendStructured<T>(
    message: string,
    schema: ZodType<T>,
    options?: TurnOptions,
  ): Promise<{
    data: T;
    raw: RunTurnResult;
  }> {
    if (!this.threadId) {
      throw new Error("Architect thread has not been started.");
    }

    const outputSchema = toCodexJsonSchema(schema);

    const raw = await this.client.runTurn(
      this.threadId,
      message,
      outputSchema,
      options,
    );

    const data = parseStructuredOutput(schema, raw.text);

    return {
      data,
      raw,
    };
  }

  getThreadId(): string {
    if (!this.threadId) {
      throw new Error("Architect thread has not been started.");
    }

    return this.threadId;
  }
}
