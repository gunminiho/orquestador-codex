import { CodexAppServerClient, } from "../codex/app-server-client";
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
    client;
    cwd;
    threadId = null;
    constructor(client, cwd) {
        this.client = client;
        this.cwd = cwd;
    }
    async start(existingThreadId) {
        if (existingThreadId) {
            console.log(`[ARCHITECT] Resuming thread ${existingThreadId}...`);
            const response = await this.client.resumeThread({
                threadId: existingThreadId,
                cwd: this.cwd,
                developerInstructions: ARCHITECT_INSTRUCTIONS,
                excludeTurns: true,
            });
            this.threadId = response.thread.id;
            return {
                mode: "resumed",
                response,
            };
        }
        console.log("[ARCHITECT] No persisted thread found. Creating one...");
        const params = {
            cwd: this.cwd,
            developerInstructions: ARCHITECT_INSTRUCTIONS,
            ephemeral: false,
        };
        const response = await this.client.startThread(params);
        this.threadId = response.thread.id;
        return {
            mode: "created",
            response,
        };
    }
    async send(message) {
        if (!this.threadId) {
            throw new Error("Architect thread has not been started.");
        }
        return this.client.runTurn(this.threadId, message);
    }
    getThreadId() {
        if (!this.threadId) {
            throw new Error("Architect thread has not been started.");
        }
        return this.threadId;
    }
}
//# sourceMappingURL=architect.js.map