import { ProjectRuntime } from "./runtime/project-runtime";
import { recoverProjectWorkflows } from "./runtime/startup";

const index = process.argv.indexOf("--project");
if (index < 0 || !process.argv[index + 1]) {
  throw new Error(
    "Missing project. Use: npm run dev -- --project <project-id>",
  );
}
const runtime = await ProjectRuntime.create(
  process.cwd(),
  process.argv[index + 1]!.trim().toLowerCase(),
);
await recoverProjectWorkflows(runtime);
