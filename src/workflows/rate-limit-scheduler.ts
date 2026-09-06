import type { GetAccountRateLimitsResponse } from "../../schemas/v2/GetAccountRateLimitsResponse";
import { WorkflowEngine } from "./workflow-engine";
import type { Workflow } from "./workflow-schema";

export type Sleeper = (milliseconds: number) => Promise<void>;
export type RateLimitClient = {
  getAccountRateLimits(): Promise<GetAccountRateLimitsResponse>;
};

export class RateLimitScheduler {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly client: RateLimitClient,
    private readonly sleep: Sleeper = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now = () => Date.now(),
  ) {}
  async waitForAvailability(workflow: Workflow): Promise<Workflow> {
    let current = workflow;
    while (current.state === "PAUSED_RATE_LIMIT") {
      current = await this.engine.reload(current);
      if (
        current.state !== "PAUSED_RATE_LIMIT" ||
        current.cancellationRequestedAt
      )
        return current;
      const persistedCheck = current.rateLimit?.nextCheckAt
        ? Date.parse(current.rateLimit.nextCheckAt)
        : 0;
      while (persistedCheck > this.now()) {
        await this.sleep(Math.min(1000, persistedCheck - this.now()));
        current = await this.engine.reload(current);
        if (
          current.state !== "PAUSED_RATE_LIMIT" ||
          current.cancellationRequestedAt
        )
          return current;
      }
      current = await this.engine.reload(current);
      if (
        current.state !== "PAUSED_RATE_LIMIT" ||
        current.cancellationRequestedAt
      )
        return current;
      const limits = await this.client.getAccountRateLimits();
      const snapshots = [
        limits.rateLimits,
        ...Object.values(limits.rateLimitsByLimitId ?? {}),
      ].filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> =>
          snapshot !== undefined && snapshot !== null,
      );
      if (!snapshots.some((snapshot) => snapshot.rateLimitReachedType !== null))
        return this.engine.resumePaused(current);
      const attempts = (current.rateLimit?.attempts ?? 0) + 1;
      // App Server exposes Unix seconds; JavaScript clocks and timers use milliseconds.
      const resetAt = snapshots
        .flatMap((snapshot) => [
          snapshot.primary?.resetsAt,
          snapshot.secondary?.resetsAt,
        ])
        .filter(
          (value): value is number => value !== null && value !== undefined,
        )
        .map((seconds) => seconds * 1_000)
        .filter((milliseconds) => milliseconds > this.now())
        .sort((a, b) => a - b)[0];
      const fallback = Math.min(
        300_000,
        5_000 * 2 ** Math.min(attempts - 1, 6),
      );
      const delay = resetAt
        ? Math.min(300_000, Math.max(1_000, resetAt - this.now()))
        : fallback;
      current = await this.engine.updateRateLimit(
        current,
        limits,
        new Date(this.now() + delay).toISOString(),
        attempts,
      );
    }
    return current;
  }
}
