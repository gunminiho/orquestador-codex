import { spawn } from "node:child_process";
import readline from "node:readline";
export class CodexAppServerClient {
    child = null;
    nextRequestId = 1;
    pendingRequests = new Map();
    notificationListeners = new Set();
    completedTurns = new Map();
    streamedAgentText = new Map();
    async start() {
        if (this.child) {
            throw new Error("Codex App Server is already running.");
        }
        console.log("[ORCHESTRATOR] Starting Codex App Server...");
        this.child = this.spawnCodexAppServer();
        const child = this.child;
        const rl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity,
        });
        rl.on("line", (line) => {
            this.handleServerLine(line);
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text) {
                console.error(`[CODEX STDERR] ${text}`);
            }
        });
        child.on("exit", (code, signal) => {
            console.log(`[CODEX] App Server exited. code=${String(code)} signal=${String(signal)}`);
            this.rejectAllPendingRequests(new Error(`Codex App Server exited. code=${String(code)} signal=${String(signal)}`));
            this.child = null;
        });
        await new Promise((resolve, reject) => {
            child.once("spawn", () => {
                console.log("[CODEX] Process started.");
                resolve();
            });
            child.once("error", reject);
        });
        const initializeParams = {
            clientInfo: {
                name: "codex_orchestrator",
                title: "Codex Multi-Agent Orchestrator",
                version: "0.1.0",
            },
            capabilities: null,
        };
        console.log("[CODEX] Sending initialize...");
        const initializeResponse = await this.request("initialize", initializeParams);
        console.log("[CODEX] initialize accepted.");
        const initializedNotification = {
            method: "initialized",
        };
        this.notify(initializedNotification);
        console.log("[CODEX] initialized notification sent.");
        console.log("[ORCHESTRATOR] Codex App Server READY.");
        return initializeResponse;
    }
    async startThread(params) {
        return this.request("thread/start", params);
    }
    async resumeThread(params) {
        return this.request("thread/resume", params);
    }
    async runTurn(threadId, text) {
        const params = {
            threadId,
            input: [
                {
                    type: "text",
                    text,
                    text_elements: [],
                },
            ],
        };
        const response = await this.request("turn/start", params);
        const turnId = response.turn.id;
        console.log(`[CODEX] Turn started: ${turnId}`);
        const completed = await this.waitForTurnCompletion(threadId, turnId);
        if (completed.turn.error) {
            throw new Error(`Codex turn failed: ${JSON.stringify(completed.turn.error)}`);
        }
        const finalMessage = this.extractFinalAgentMessage(completed) ??
            this.streamedAgentText.get(this.turnKey(threadId, turnId)) ??
            "";
        this.completedTurns.delete(this.turnKey(threadId, turnId));
        this.streamedAgentText.delete(this.turnKey(threadId, turnId));
        return {
            turnId,
            text: finalMessage,
            turn: completed.turn,
        };
    }
    async request(method, params) {
        const id = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, {
                resolve: (value) => resolve(value),
                reject,
            });
            this.send({
                method,
                id,
                params,
            });
        });
    }
    notify(notification) {
        this.send(notification);
    }
    onNotification(listener) {
        this.notificationListeners.add(listener);
        return () => {
            this.notificationListeners.delete(listener);
        };
    }
    stop() {
        if (!this.child) {
            return;
        }
        console.log("[ORCHESTRATOR] Stopping Codex App Server...");
        this.child.stdin.end();
        this.child.kill();
        this.child = null;
    }
    waitForTurnCompletion(threadId, turnId, timeoutMs = 180_000) {
        const key = this.turnKey(threadId, turnId);
        const alreadyCompleted = this.completedTurns.get(key);
        if (alreadyCompleted) {
            return Promise.resolve(alreadyCompleted);
        }
        return new Promise((resolve, reject) => {
            const unsubscribe = this.onNotification((notification) => {
                if (notification.method !== "turn/completed") {
                    return;
                }
                const params = notification.params;
                if (params.threadId !== threadId ||
                    params.turn.id !== turnId) {
                    return;
                }
                clearTimeout(timeout);
                unsubscribe();
                resolve(params);
            });
            const timeout = setTimeout(() => {
                unsubscribe();
                reject(new Error(`Timed out waiting for turn ${turnId} to complete.`));
            }, timeoutMs);
        });
    }
    extractFinalAgentMessage(completed) {
        const messages = completed.turn.items.filter((item) => item.type === "agentMessage");
        if (messages.length === 0) {
            return null;
        }
        return messages[messages.length - 1]?.text ?? null;
    }
    spawnCodexAppServer() {
        if (process.platform === "win32") {
            const shell = process.env.ComSpec ?? "cmd.exe";
            return spawn(shell, [
                "/d",
                "/s",
                "/c",
                "codex app-server --stdio",
            ], {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        return spawn("codex", ["app-server", "--stdio"], {
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    send(message) {
        if (!this.child) {
            throw new Error("Codex App Server is not running.");
        }
        const serialized = JSON.stringify(message);
        this.child.stdin.write(`${serialized}\n`);
    }
    handleServerLine(line) {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch {
            console.error("[CODEX] Received invalid JSON:", trimmed);
            return;
        }
        if (this.isRpcResponse(message)) {
            this.handleRpcResponse(message);
            return;
        }
        if (this.isServerNotification(message)) {
            this.handleNotification(message);
            return;
        }
        console.log("[CODEX SERVER MESSAGE]", message);
    }
    handleRpcResponse(message) {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
            console.warn(`[CODEX] Received response for unknown request id ${String(message.id)}.`);
            return;
        }
        this.pendingRequests.delete(message.id);
        if ("error" in message) {
            pending.reject(new Error(`Codex RPC error ${message.error.code}: ${message.error.message}`));
            return;
        }
        pending.resolve(message.result);
    }
    handleNotification(notification) {
        if (notification.method ===
            "item/agentMessage/delta") {
            const params = notification.params;
            const key = this.turnKey(params.threadId, params.turnId);
            const previous = this.streamedAgentText.get(key) ?? "";
            this.streamedAgentText.set(key, previous + params.delta);
        }
        if (notification.method === "turn/completed") {
            const params = notification.params;
            this.completedTurns.set(this.turnKey(params.threadId, params.turn.id), params);
        }
        for (const listener of this.notificationListeners) {
            listener(notification);
        }
    }
    isRpcResponse(value) {
        if (typeof value !== "object" ||
            value === null) {
            return false;
        }
        const candidate = value;
        return (("id" in candidate &&
            "result" in candidate) ||
            ("id" in candidate &&
                "error" in candidate));
    }
    isServerNotification(value) {
        if (typeof value !== "object" ||
            value === null) {
            return false;
        }
        const candidate = value;
        return (!("id" in candidate) &&
            typeof candidate.method === "string" &&
            "params" in candidate);
    }
    turnKey(threadId, turnId) {
        return `${threadId}:${turnId}`;
    }
    rejectAllPendingRequests(error) {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
}
//# sourceMappingURL=app-server-client.js.map