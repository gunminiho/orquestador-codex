import type { Workflow } from "../workflows/workflow-schema";

type RecoverableRuntime = {
  projectId: string;
  store: { recoverable(projectId: string): Promise<Workflow[]> };
  execute(workflowId: string): Promise<Workflow>;
  stop(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
};
type SignalSource = Pick<NodeJS.Process, "once" | "removeListener">;

/** Installs graceful signal handling before discovery can start long recovery work. */
export async function recoverProjectWorkflows(
  runtime: RecoverableRuntime,
  signals: SignalSource = process,
  write: (message: string) => void = console.log,
): Promise<void> {
  let stopping = false;
  const shutdown = () => {
    stopping = true;
    void (runtime.shutdown?.() ?? runtime.stop());
  };
  signals.once("SIGINT", shutdown);
  signals.once("SIGTERM", shutdown);

  try {
    const workflows = await runtime.store.recoverable(runtime.projectId);
    for (const workflow of workflows) {
      if (stopping) break;
      if (
        ["WAITING_FOR_OWNER_INPUT", "PAUSED_MANUAL", "BLOCKED"].includes(
          workflow.state,
        )
      ) {
        write(`${workflow.id}: ${workflow.state}`);
        continue;
      }
      const result = await runtime.execute(workflow.id);
      write(`${workflow.id}: ${result.state}`);
    }
  } finally {
    signals.removeListener("SIGINT", shutdown);
    signals.removeListener("SIGTERM", shutdown);
  }
}
