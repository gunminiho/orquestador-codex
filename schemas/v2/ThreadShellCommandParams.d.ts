export type ThreadShellCommandParams = {
    threadId: string;
    /**
     * Shell command string evaluated by the thread's configured shell.
     * Unlike `command/exec`, this intentionally preserves shell syntax
     * such as pipes, redirects, and quoting. This runs unsandboxed with full
     * access rather than inheriting the thread sandbox policy.
     */
    command: string;
    /**
     * Maximum execution time in milliseconds. Defaults to one hour when omitted
     * or null. Must be non-negative; zero requests an immediate timeout, not
     * unlimited execution. Does not affect the immediate RPC acknowledgement.
     */
    timeoutMs?: number | null;
};
//# sourceMappingURL=ThreadShellCommandParams.d.ts.map