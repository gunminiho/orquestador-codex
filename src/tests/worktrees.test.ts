import { gitFixture } from "./fixtures";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GitWorktreeManager,
  readGitDelta,
  deltaPaths,
} from "../workflows/git-worktree-manager";
const exec = promisify(execFile);
test("pre-existing uncommitted user changes remain untouched", async () => {
  const f = await gitFixture();
  await writeFile(path.join(f.repo, "modified.txt"), "user's unfinished work");
  const manager = new GitWorktreeManager(f.root);
  const worktree = (await manager.create("repo", f.repo, "dirty", "t", "a"))!;
  assert.equal(
    await readFile(path.join(worktree.worktreePath, "modified.txt"), "utf8"),
    "original\n",
  );
  await writeFile(
    path.join(worktree.worktreePath, "modified.txt"),
    "developer implementation",
  );
  await manager.cleanup(worktree);
  assert.equal(
    await readFile(path.join(f.repo, "modified.txt"), "utf8"),
    "user's unfinished work",
  );
});
test("distinct task worktrees leave original checkout untouched and reuse deterministically", async () => {
  const f = await gitFixture();
  const manager = new GitWorktreeManager(f.root);
  const a = (await manager.create("repo", f.repo, "w", "t", "a"))!;
  const b = (await manager.create("repo", f.repo, "w2", "t", "a"))!;
  assert.notEqual(a.worktreePath, b.worktreePath);
  await writeFile(path.join(a.worktreePath, "modified.txt"), "changed");
  assert.equal(
    await readFile(path.join(f.repo, "modified.txt"), "utf8"),
    "original\n",
  );
  assert.equal(
    (await manager.create("repo", f.repo, "w", "t", "a"))!.worktreePath,
    a.worktreePath,
  );
  await manager.cleanup(a);
  await manager.cleanup(a);
  await manager.cleanup(b);
});
test("structured delta includes modified added untracked deleted and both spaced rename paths", async () => {
  const f = await gitFixture();
  const manager = new GitWorktreeManager(f.root);
  const w = (await manager.create("repo", f.repo, "w", "t", "a"))!;
  await exec("git", [
    "-C",
    w.worktreePath,
    "mv",
    "old name.txt",
    "new name.txt",
  ]);
  await writeFile(path.join(w.worktreePath, "modified.txt"), "changed");
  await unlink(path.join(w.worktreePath, "deleted.txt"));
  await writeFile(path.join(w.worktreePath, "added.txt"), "added");
  await exec("git", ["-C", w.worktreePath, "add", "added.txt"]);
  await writeFile(path.join(w.worktreePath, "untracked file.txt"), "new");
  const delta = await readGitDelta(w.worktreePath, w.baseCommitSha);
  for (const [kind, file] of [
    ["modified", "modified.txt"],
    ["added", "added.txt"],
    ["added", "untracked file.txt"],
    ["deleted", "deleted.txt"],
  ]) {
    assert.ok(
      delta.some((d) => d.kind === kind && "path" in d && d.path === file),
    );
  }
  assert.ok(
    delta.some(
      (d) =>
        d.kind === "renamed" &&
        d.oldPath === "old name.txt" &&
        d.newPath === "new name.txt",
    ),
  );
  assert.ok(deltaPaths(delta).includes("old name.txt"));
  assert.ok(deltaPaths(delta).includes("new name.txt"));
  await manager.cleanup(w);
});
