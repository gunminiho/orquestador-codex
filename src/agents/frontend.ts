import type { ZodType } from "zod";
import {
  parseStructuredOutput,
  toCodexJsonSchema,
} from "../protocol/structured-output";
import type { ThreadStartResponse } from "../../schemas/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../../schemas/v2/ThreadResumeResponse";
import {
  CodexAppServerClient,
  type TurnOptions,
  type RunTurnResult,
} from "../codex/app-server-client";
const BASE = `You are the Senior Frontend Engineer. You report to the Software Architect. Implement only assigned work, respect project topology, accessibility and existing patterns, write tests, report evidence and blockers. Developers end at READY_FOR_REVIEW; only Architect approves.`;
export class FrontendAgent {
  private threadId: string | null = null;
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly cwd: string,
    private readonly context = "",
  ) {}
  async start(
    existingThreadId?: string,
  ): Promise<{
    mode: "created" | "resumed";
    response: ThreadStartResponse | ThreadResumeResponse;
  }> {
    if (existingThreadId)
      try {
        const response = await this.client.resumeThread({
          threadId: existingThreadId,
          cwd: this.cwd,
          developerInstructions: BASE + this.context,
          excludeTurns: true,
        });
        this.threadId = response.thread.id;
        return { mode: "resumed", response };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("no rollout found for thread id")
        )
          throw error;
      }
    const response = await this.client.startThread({
      cwd: this.cwd,
      developerInstructions: BASE + this.context,
      ephemeral: false,
    });
    this.threadId = response.thread.id;
    await this.client.runTurn(
      this.threadId,
      "Materialize this persistent thread. Do not inspect files, run commands, or modify anything. Reply FRONTEND_READY.",
    );
    return { mode: "created", response };
  }
  async send(message: string): Promise<RunTurnResult> {
    return this.client.runTurn(this.requireThread(), message);
  }
  async sendStructured<T>(
    message: string,
    schema: ZodType<T>,
    options?: TurnOptions,
  ): Promise<{ data: T; raw: RunTurnResult }> {
    const raw = await this.client.runTurn(
      this.requireThread(),
      message,
      toCodexJsonSchema(schema),
      options,
    );
    return { data: parseStructuredOutput(schema, raw.text), raw };
  }
  getThreadId(): string {
    return this.requireThread();
  }
  private requireThread() {
    if (!this.threadId)
      throw new Error("Frontend thread has not been started.");
    return this.threadId;
  }
}
