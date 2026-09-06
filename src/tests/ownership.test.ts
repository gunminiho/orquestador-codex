import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
import { deltaPaths, parseGitDelta } from "../workflows/git-worktree-manager";
const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "t",
  assignedTo: "frontend" as const,
  title: "x",
  objective: "x",
  context: "",
  requirements: [],
  acceptanceCriteria: [],
  allowedPaths: ["allowed/**"],
  forbiddenPaths: [],
  validationCommands: [],
  notes: [],
};
const report = {
  type: "TASK_REPORT" as const,
  taskId: "t",
  agent: "frontend" as const,
  status: "READY_FOR_REVIEW" as const,
  summary: "x",
  filesChanged: [] as string[],
  testsChanged: [],
  validations: [],
  risks: [],
  blockers: [],
  notes: [],
};
function verifier(root: string) {
  return new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: root,
      repositories: [
        {
          id: "repo",
          root,
          metadata: {},
          ownership: [
            {
              pattern: "**",
              readableBy: ["frontend"],
              writableBy: ["frontend"],
              architectControlled: false,
            },
          ],
        },
      ],
      agentWorkspaces: {},
    }),
  );
}
for (const [oldPath, newPath] of [
  ["forbidden/old name", "allowed/new name"],
  ["allowed/old name", "forbidden/new name"],
]) {
  test(`rename validates ${oldPath!.startsWith("forbidden") ? "old" : "new"} path against assignment`, () => {
    const actual = deltaPaths(parseGitDelta(`R100\0${oldPath}\0${newPath}\0`));
    const result = verifier(os.tmpdir()).validateReport(
      assignment,
      { ...report, filesChanged: actual },
      actual,
      "git",
    );
    assert.equal(result.ok, false);
    assert.match(result.violations.join(), /outside TASK_ASSIGNMENT/);
  });
}
test("rename with spaces retains both allowed paths", () => {
  const files = deltaPaths(
    parseGitDelta("R100\0allowed/old name\0allowed/new name\0"),
  );
  const result = verifier(os.tmpdir()).validateReport(
    assignment,
    { ...report, filesChanged: files },
    files,
    "git",
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifiedFiles.length, 2);
});
test("omitted old rename path fails report verification", () => {
  const files = ["allowed/old", "allowed/new"];
  const result = verifier(os.tmpdir()).validateReport(
    assignment,
    { ...report, filesChanged: ["allowed/new"] },
    files,
    "git",
  );
  assert.match(result.violations.join(), /old: changed but omitted/);
});
test("unsafe reported paths produce ownership violations", () => {
  const result = verifier(os.tmpdir()).validateReport(assignment, {
    ...report,
    filesChanged: ["../outside"],
  });
  assert.equal(result.ok, false);
});
test("junction escaping the assigned repository is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ownership-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await symlink(
    outside,
    path.join(repo, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    verifier(repo).assertSafePath("repo", "escape/new.txt"),
    /escapes/,
  );
});
test("non-Git snapshot detects actual changes without claiming Git attribution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-"));
  await mkdir(path.join(root, "allowed"));
  const v = verifier(root);
  const before = await v.captureBaseline();
  await writeFile(path.join(root, "allowed/file.txt"), "new");
  const result = await v.validateTaskDelta(
    assignment,
    { ...report, filesChanged: ["repo:allowed/file.txt"] },
    before,
  );
  assert.equal(result.source, "snapshot");
  assert.equal(result.ok, true);
  assert.deepEqual(result.verifiedFiles, ["repo:allowed/file.txt"]);
});
