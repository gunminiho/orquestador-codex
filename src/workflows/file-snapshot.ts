import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** Non-Git evidence only; this does not claim Git attribution. Never follows symlinks. */
export async function fileSnapshot(
  root: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        [".git", ".orchestrator", "node_modules"].includes(entry.name) ||
        entry.name.startsWith(".orchestrator-repository.lock")
      )
        continue;
      const relative = prefix + entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative + "/");
      else if (entry.isSymbolicLink())
        files[relative] = "link:" + (await readlink(absolute));
      else if (entry.isFile())
        files[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
    }
  }
  await visit(root);
  return files;
}
