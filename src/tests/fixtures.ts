import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function gitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "worktree-test-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    exec("git", ["-C", repo, ...args], { windowsHide: true });
  await git("init");
  await git("config", "core.autocrlf", "false");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "user.name", "Fixture");
  await writeFile(path.join(repo, "old name.txt"), "original\n");
  await writeFile(path.join(repo, "modified.txt"), "original\n");
  await writeFile(path.join(repo, "deleted.txt"), "deleted original\n");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  return { root, repo, git };
}
