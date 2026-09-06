import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import readline from "node:readline";

import type { InitializeParams } from "../../schemas/InitializeParams";
import type { InitializeResponse } from "../../schemas/InitializeResponse";
import type { ClientNotification } from "../../schemas/ClientNotification";
import type { ServerNotification } from "../../schemas/ServerNotification";

import type { JsonValue } from "../../schemas/serde_json/JsonValue";

import type { ThreadResumeParams } from "../../schemas/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "../../schemas/v2/ThreadResumeResponse";
import type { ThreadStartParams } from "../../schemas/v2/ThreadStartParams";
import type { ThreadStartResponse } from "../../schemas/v2/ThreadStartResponse";
import type { TurnStartParams } from "../../schemas/v2/TurnStartParams";
import type { TurnStartResponse } from "../../schemas/v2/TurnStartResponse";
import type { TurnCompletedNotification } from "../../schemas/v2/TurnCompletedNotification";
import type { AgentMessageDeltaNotification } from "../../schemas/v2/AgentMessageDeltaNotification";
import type { Turn } from "../../schemas/v2/Turn";
import type { GetAccountRateLimitsResponse } from "../../schemas/v2/GetAccountRateLimitsResponse";

type RpcId =
  | number
  | string;

type RpcSuccessResponse = {
  id: RpcId;
  result: unknown;
};

type RpcErrorResponse = {
  id: RpcId;

  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type RpcResponse =
  | RpcSuccessResponse
  | RpcErrorResponse;

type PendingRequest = {
  resolve: (
    value: unknown,
  ) => void;

  reject: (
    error: Error,
  ) => void;
};

type NotificationListener = (
  notification: ServerNotification,
) => void;

export type RunTurnResult = {
  turnId: string;
  text: string;
  turn: Turn;
};

export class CodexAppServerClient {
  private child:
    ChildProcessWithoutNullStreams
    | null = null;

  private nextRequestId = 1;

  private readonly pendingRequests =
    new Map<
      RpcId,
      PendingRequest
    >();

  private readonly notificationListeners =
    new Set<
      NotificationListener
    >();

  private readonly exitListeners = new Set<(error: Error) => void>();

  private readonly completedTurns =
    new Map<
      string,
      TurnCompletedNotification
    >();

  private readonly streamedAgentText =
    new Map<
      string,
      string
    >();

  async start(): Promise<InitializeResponse> {
    if (this.child) {
      throw new Error(
        "Codex App Server is already running.",
      );
    }

    console.log(
      "[ORCHESTRATOR] Starting Codex App Server...",
    );

    this.child =
      this.spawnCodexAppServer();

    const child =
      this.child;

    const rl =
      readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

    rl.on(
      "line",
      (line) => {
        this.handleServerLine(
          line,
        );
      },
    );

    child.stderr.on(
      "data",
      (chunk: Buffer) => {
        const text =
          chunk
            .toString()
            .trim();

        if (text) {
          console.error(
            `[CODEX STDERR] ${text}`,
          );
        }
      },
    );

    child.on(
      "exit",
      (
        code,
        signal,
      ) => {
        console.log(
          `[CODEX] App Server exited. code=${String(
            code,
          )} signal=${String(
            signal,
          )}`,
        );

        this.rejectAllPendingRequests(
          new Error(
            `Codex App Server exited. code=${String(
              code,
            )} signal=${String(
              signal,
            )}`,
          ),
        );

        const error = new Error(`Codex App Server exited. code=${String(code)} signal=${String(signal)}`);
        for (const listener of this.exitListeners) listener(error);

        this.child = null;
      },
    );

    await new Promise<void>(
      (
        resolve,
        reject,
      ) => {
        child.once(
          "spawn",
          () => {
            console.log(
              "[CODEX] Process started.",
            );

            resolve();
          },
        );

        child.once(
          "error",
          reject,
        );
      },
    );

    const initializeParams:
      InitializeParams = {
        clientInfo: {
          name:
            "codex_orchestrator",

          title:
            "Codex Multi-Agent Orchestrator",

          version:
            "0.1.0",
        },

        capabilities: null,
      };

    console.log(
      "[CODEX] Sending initialize...",
    );

    const initializeResponse =
      await this.request<InitializeResponse>(
        "initialize",
        initializeParams,
      );

    console.log(
      "[CODEX] initialize accepted.",
    );

    const initializedNotification:
      ClientNotification = {
        method:
          "initialized",
      };

    this.notify(
      initializedNotification,
    );

    console.log(
      "[CODEX] initialized notification sent.",
    );

    console.log(
      "[ORCHESTRATOR] Codex App Server READY.",
    );

    return initializeResponse;
  }

  async startThread(
    params: ThreadStartParams,
  ): Promise<ThreadStartResponse> {
    return this.request<ThreadStartResponse>(
      "thread/start",
      params,
    );
  }

  async resumeThread(
    params: ThreadResumeParams,
  ): Promise<ThreadResumeResponse> {
    return this.request<ThreadResumeResponse>(
      "thread/resume",
      params,
    );
  }

  async runTurn(
    threadId: string,
    text: string,
    outputSchema?: JsonValue,
    options?: { timeoutMs?: number },
  ): Promise<RunTurnResult> {
    const params:
      TurnStartParams = {
        threadId,

        input: [
          {
            type: "text",
            text,
            text_elements: [],
          },
        ],

        outputSchema:
          outputSchema ?? null,
      };

    const response =
      await this.request<TurnStartResponse>(
        "turn/start",
        params,
      );

    const turnId =
      response.turn.id;

    console.log(
      `[CODEX] Turn started: ${turnId}`,
    );

    const completed =
      await this.waitForTurnCompletion(
        threadId,
        turnId,
        options?.timeoutMs,
      );

    if (
      completed.turn.error
    ) {
      throw new Error(
        `Codex turn failed: ${JSON.stringify(
          completed.turn.error,
        )}`,
      );
    }

    const finalMessage =
      this.extractFinalAgentMessage(
        completed,
      ) ??
      this.streamedAgentText.get(
        this.turnKey(
          threadId,
          turnId,
        ),
      ) ??
      "";

    this.completedTurns.delete(
      this.turnKey(
        threadId,
        turnId,
      ),
    );

    this.streamedAgentText.delete(
      this.turnKey(
        threadId,
        turnId,
      ),
    );

    return {
      turnId,
      text:
        finalMessage,
      turn:
        completed.turn,
    };
  }

  async getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined);
  }

  async request<T>(
    method: string,
    params: unknown,
  ): Promise<T> {
    const id =
      this.nextRequestId++;

    return new Promise<T>(
      (
        resolve,
        reject,
      ) => {
        this.pendingRequests.set(
          id,
          {
            resolve:
              (value) =>
                resolve(
                  value as T,
                ),

            reject,
          },
        );

        this.send({
          method,
          id,
          params,
        });
      },
    );
  }

  notify(
    notification:
      ClientNotification,
  ): void {
    this.send(
      notification,
    );
  }

  onNotification(
    listener:
      NotificationListener,
  ): () => void {
    this.notificationListeners.add(
      listener,
    );

    return () => {
      this.notificationListeners.delete(
        listener,
      );
    };
  }

  stop(): void {
    if (
      !this.child
    ) {
      return;
    }

    console.log(
      "[ORCHESTRATOR] Stopping Codex App Server...",
    );

    this.child.stdin.end();

    this.child.kill();

    this.child = null;
  }

  private waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs?: number,
  ): Promise<TurnCompletedNotification> {
    const key =
      this.turnKey(
        threadId,
        turnId,
      );

    const alreadyCompleted =
      this.completedTurns.get(
        key,
      );

    if (
      alreadyCompleted
    ) {
      return Promise.resolve(
        alreadyCompleted,
      );
    }

    return new Promise(
      (
        resolve,
        reject,
      ) => {
        const unsubscribe =
          this.onNotification(
            (
              notification,
            ) => {
              if (
                notification.method !==
                "turn/completed"
              ) {
                return;
              }

              const params =
                notification.params as TurnCompletedNotification;

              if (
                params.threadId !==
                  threadId ||
                params.turn.id !==
                  turnId
              ) {
                return;
              }

              if (timeout) clearTimeout(timeout);

              unsubscribe();
              this.exitListeners.delete(onExit);

              resolve(
                params,
              );
          },
        );

        const onExit = (error: Error) => {
          if (timeout) clearTimeout(timeout);
          unsubscribe();
          this.exitListeners.delete(onExit);
          reject(error);
        };
        this.exitListeners.add(onExit);

        const timeout = timeoutMs === undefined ? undefined : setTimeout(
            () => {
              unsubscribe();
              this.exitListeners.delete(onExit);

              reject(
                new Error(
                  `Timed out waiting for turn ${turnId} to complete.`,
                ),
              );
            },

            timeoutMs,
          );
      },
    );
  }

  private extractFinalAgentMessage(
    completed:
      TurnCompletedNotification,
  ): string | null {
    const messages =
      completed.turn.items.filter(
        (item) =>
          item.type ===
          "agentMessage",
      );

    if (
      messages.length === 0
    ) {
      return null;
    }

    return (
      messages[
        messages.length - 1
      ]?.text ?? null
    );
  }

  private spawnCodexAppServer():
    ChildProcessWithoutNullStreams {
    if (
      process.platform ===
      "win32"
    ) {
      const shell =
        process.env.ComSpec ??
        "cmd.exe";

      return spawn(
        shell,
        [
          "/d",
          "/s",
          "/c",
          "codex app-server --stdio",
        ],
        {
          stdio: [
            "pipe",
            "pipe",
            "pipe",
          ],

          windowsHide:
            true,
        },
      );
    }

    return spawn(
      "codex",
      [
        "app-server",
        "--stdio",
      ],
      {
        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      },
    );
  }

  private send(
    message: unknown,
  ): void {
    if (
      !this.child
    ) {
      throw new Error(
        "Codex App Server is not running.",
      );
    }

    const serialized =
      JSON.stringify(
        message,
      );

    this.child.stdin.write(
      `${serialized}\n`,
    );
  }

  private handleServerLine(
    line: string,
  ): void {
    const trimmed =
      line.trim();

    if (
      !trimmed
    ) {
      return;
    }

    let message:
      unknown;

    try {
      message =
        JSON.parse(
          trimmed,
        );
    } catch {
      console.error(
        "[CODEX] Received invalid JSON:",
        trimmed,
      );

      return;
    }

    if (
      this.isRpcResponse(
        message,
      )
    ) {
      this.handleRpcResponse(
        message,
      );

      return;
    }

    if (
      this.isServerNotification(
        message,
      )
    ) {
      this.handleNotification(
        message,
      );

      return;
    }

    console.log(
      "[CODEX SERVER MESSAGE]",
      message,
    );
  }

  private handleRpcResponse(
    message:
      RpcResponse,
  ): void {
    const pending =
      this.pendingRequests.get(
        message.id,
      );

    if (
      !pending
    ) {
      console.warn(
        `[CODEX] Received response for unknown request id ${String(
          message.id,
        )}.`,
      );

      return;
    }

    this.pendingRequests.delete(
      message.id,
    );

    if (
      "error" in
      message
    ) {
      pending.reject(
        new Error(
          `Codex RPC error ${message.error.code}: ${message.error.message}`,
        ),
      );

      return;
    }

    pending.resolve(
      message.result,
    );
  }

  private handleNotification(
    notification:
      ServerNotification,
  ): void {
    if (
      notification.method ===
      "item/agentMessage/delta"
    ) {
      const params =
        notification.params as AgentMessageDeltaNotification;

      const key =
        this.turnKey(
          params.threadId,
          params.turnId,
        );

      const previous =
        this.streamedAgentText.get(
          key,
        ) ?? "";

      this.streamedAgentText.set(
        key,
        previous +
          params.delta,
      );
    }

    if (
      notification.method ===
      "turn/completed"
    ) {
      const params =
        notification.params as TurnCompletedNotification;

      this.completedTurns.set(
        this.turnKey(
          params.threadId,
          params.turn.id,
        ),
        params,
      );
    }

    for (
      const listener
      of this.notificationListeners
    ) {
      listener(
        notification,
      );
    }
  }

  private isRpcResponse(
    value: unknown,
  ): value is RpcResponse {
    if (
      typeof value !==
        "object" ||
      value === null
    ) {
      return false;
    }

    const candidate =
      value as Record<
        string,
        unknown
      >;

    return (
      (
        "id" in candidate &&
        "result" in candidate
      ) ||
      (
        "id" in candidate &&
        "error" in candidate
      )
    );
  }

  private isServerNotification(
    value: unknown,
  ): value is ServerNotification {
    if (
      typeof value !==
        "object" ||
      value === null
    ) {
      return false;
    }

    const candidate =
      value as Record<
        string,
        unknown
      >;

    return (
      !(
        "id" in
        candidate
      ) &&
      typeof candidate.method ===
        "string" &&
      "params" in
        candidate
    );
  }

  private turnKey(
    threadId: string,
    turnId: string,
  ): string {
    return `${threadId}:${turnId}`;
  }

  private rejectAllPendingRequests(
    error: Error,
  ): void {
    for (
      const pending
      of this.pendingRequests.values()
    ) {
      pending.reject(
        error,
      );
    }

    this.pendingRequests.clear();
  }
}
