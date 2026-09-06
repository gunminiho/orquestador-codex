import { ProjectRuntime } from "./runtime/project-runtime";

const index = process.argv.indexOf("--project");
if (index < 0 || !process.argv[index + 1]) throw new Error("Missing project. Use: npm run dev -- --project <project-id>");
const runtime = await ProjectRuntime.create(process.cwd(), process.argv[index + 1]!.trim().toLowerCase());
for (const workflow of await runtime.store.recoverable(runtime.projectId)) {
  if (["WAITING_FOR_OWNER_INPUT", "PAUSED_MANUAL", "BLOCKED"].includes(workflow.state)) { console.log(`${workflow.id}: ${workflow.state}`); continue; }
  console.log(`${workflow.id}: ${(await runtime.execute(workflow.id)).state}`);
}
process.once("SIGINT", () => { void runtime.stop(); });
