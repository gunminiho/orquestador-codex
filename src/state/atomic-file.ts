import { rename } from "node:fs/promises";

/** Windows readers/antivirus can briefly deny replacement; never unlink the destination. */
export async function atomicReplace(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (
        attempt >= 8 ||
        !["EPERM", "EBUSY", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, 10 * 2 ** attempt)),
      );
    }
  }
}
