import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowStore } from "../workflows/workflow-store";
const args = process.argv.slice(2); const command = args[0]; const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; }; const project = value("--project"); const id = value("--workflow"); const store = new WorkflowStore(process.cwd()); const engine = new WorkflowEngine(store);
if (!command || !project) throw new Error("Usage: workflow:<action> --project <id>");
if (command === "list") console.log(JSON.stringify(await store.list(project), null, 2));
else if (command === "show") { if (!id) throw new Error("--workflow required"); console.log(JSON.stringify(await store.get(project, id), null, 2)); }
else if (command === "start") { const request = value("--request"); if (!request) throw new Error("--request required"); console.log(JSON.stringify(await engine.create(project, request), null, 2)); }
else if (command === "cancel") { if (!id) throw new Error("--workflow required"); await engine.transition(await store.get(project, id), "CANCELLED", "Cancelled by owner"); }
else if (command === "answer") { const answer = value("--answer"); if (!id || !answer) throw new Error("--workflow and --answer required"); await engine.answerOwnerInput(await store.get(project, id), answer); }
else if (command === "resume") { if (!id) throw new Error("--workflow required"); console.log(JSON.stringify(await engine.resumePaused(await store.get(project, id)), null, 2)); }
else throw new Error(`Unknown workflow command: ${command}`);
