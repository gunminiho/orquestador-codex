import { CodexAppServerClient } from "./codex/app-server-client";
import { OrchestratorStateStore } from "./state/orchestrator-state";
import { ArchitectAgent } from "./agents/architect";
const client = new CodexAppServerClient();
const stateStore = new OrchestratorStateStore(process.cwd());
try {
    const serverInfo = await client.start();
    console.log("");
    console.log("========================================");
    console.log(" CODEX APP SERVER CONNECTED");
    console.log("========================================");
    console.log(`User Agent : ${serverInfo.userAgent}`);
    console.log(`Platform   : ${serverInfo.platformOs}`);
    console.log("========================================");
    console.log("");
    const architect = new ArchitectAgent(client, process.cwd());
    console.log("[ARCHITECT] Creating persistent thread...");
    const state = await stateStore.load();
    const architectSession = await architect.start(state.agents.architect?.threadId);
    const architectThread = architectSession.response.thread;
    console.log(`[ARCHITECT] Mode: ${architectSession.mode.toUpperCase()}`);
    console.log(`[ARCHITECT] Thread ID: ${architectThread.id}`);
    console.log(`[ARCHITECT] Ephemeral: ${architectThread.ephemeral}`);
    if (architectSession.mode === "created") {
        state.agents.architect = {
            threadId: architectThread.id,
        };
        await stateStore.save(state);
        console.log("[ARCHITECT] Thread ID persisted.");
    }
    console.log(`[ARCHITECT] Thread created.`);
    console.log("");
    console.log("[ARCHITECT] Sending first turn...");
    const result = await architect.send(`
Confirm that you understand your role in this multi-agent system.

For this connectivity test, do not inspect files and do not execute commands.

Respond with exactly one short sentence identifying your role.
`);
    console.log("");
    console.log("========================================");
    console.log(" ARCHITECT RESPONSE");
    console.log("========================================");
    console.log(result.text);
    console.log("========================================");
    console.log("");
    client.stop();
}
catch (error) {
    console.error("[ORCHESTRATOR] Startup failed:", error);
    client.stop();
    process.exitCode = 1;
}
//# sourceMappingURL=index.js.map