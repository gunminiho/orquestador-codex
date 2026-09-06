export class RuntimeShutdownError extends Error {
  constructor() {
    super("Runtime shutdown requested");
    this.name = "RuntimeShutdownError";
  }
}

export function throwIfShutdown(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RuntimeShutdownError) throw signal.reason;
  throw new RuntimeShutdownError();
}

/** Lets injected test sleepers participate in shutdown even if they cannot cancel timers. */
export async function sleepUntil(
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfShutdown(signal);
  if (!signal) return sleep(milliseconds);
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new RuntimeShutdownError());
    signal.addEventListener("abort", abort, { once: true });
    void sleep(milliseconds, signal).then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function abortableTimeout(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfShutdown(signal);
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new RuntimeShutdownError());
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
