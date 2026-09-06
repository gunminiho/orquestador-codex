import type { GetAccountRateLimitsResponse } from "../../schemas/v2/GetAccountRateLimitsResponse";
import { WorkflowEngine } from "./workflow-engine";
import type { Workflow } from "./workflow-schema";

export type Sleeper = (milliseconds: number) => Promise<void>;
export type RateLimitClient = { getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> };
export class RateLimitScheduler {
  constructor(private readonly engine: WorkflowEngine, private readonly client: RateLimitClient, private readonly sleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), private readonly now = () => Date.now()) {}
  async waitForAvailability(workflow: Workflow): Promise<Workflow> {
    let current = workflow; let attempts = 0;
    while (current.state === "PAUSED_RATE_LIMIT") {
      const limits = await this.client.getAccountRateLimits();
      const limited = [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId ?? {})].some((snapshot) => snapshot?.rateLimitReachedType !== null);
      if (!limited) return this.engine.resumePaused(current);
      const delay = Math.min(300_000, 5_000 * 2 ** Math.min(attempts++, 6));
      const nextCheckAt = new Date(this.now() + delay).toISOString();
      current = await this.engine.updateRateLimit(current, limits, nextCheckAt);
      await this.sleep(delay);
    }
    return current;
  }
}
