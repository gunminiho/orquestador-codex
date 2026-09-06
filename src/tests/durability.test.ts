import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newWorkflow } from "../workflows/workflow-schema";
import { WorkflowStore } from "../workflows/workflow-store";
import { OrchestratorStateStore } from "../state/orchestrator-state";
async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "durable-"));
}
test("V1 workflow migrates with durable V2 defaults and exact backup", async () => {
  const root = await fixture();
  const dir = path.join(root, ".orchestrator/workflows/p");
  await mkdir(dir, { recursive: true });
  const legacy = { ...newWorkflow("p", "task", "w"), version: 1 };
  const source = JSON.stringify(legacy);
  await writeFile(path.join(dir, "w.json"), source);
  const migrated = await new WorkflowStore(root).get("p", "w");
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.attempts, []);
  const backup = (await readdir(dir)).find((f) => f.endsWith(".bak"))!;
  assert.equal(await readFile(path.join(dir, backup), "utf8"), source);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, "w.json"), "utf8")).version,
    2,
  );
});
test("malformed V1 is preserved verbatim and never overwritten", async () => {
  const root = await fixture();
  const dir = path.join(root, ".orchestrator/workflows/p");
  await mkdir(dir, { recursive: true });
  const source = '{"version":1,"id":"w"}';
  await writeFile(path.join(dir, "w.json"), source);
  await assert.rejects(new WorkflowStore(root).get("p", "w"));
  assert.equal(await readFile(path.join(dir, "w.json"), "utf8"), source);
});
test("malformed JSON is preserved", async () => {
  const root = await fixture();
  const dir = path.join(root, ".orchestrator/workflows/p");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "w.json"), "{broken");
  await assert.rejects(new WorkflowStore(root).get("p", "w"));
  assert.equal(await readFile(path.join(dir, "w.json"), "utf8"), "{broken");
});
test("concurrent atomic workflow writes always produce complete JSON", async () => {
  const root = await fixture();
  const store = new WorkflowStore(root);
  const workflow = newWorkflow("p", "task", "w");
  await store.save(workflow);
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      store.save({ ...workflow, retryCount: i }),
    ),
  );
  assert.equal((await store.get("p", "w")).version, 2);
  assert.equal(
    (await readdir(path.join(root, ".orchestrator/workflows/p"))).filter((f) =>
      f.endsWith(".tmp"),
    ).length,
    0,
  );
});
test("atomic orchestrator-state persistence survives concurrent writes", async () => {
  const root = await fixture();
  const store = new OrchestratorStateStore(root);
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      store.save({
        version: 2,
        projects: { p: { agents: { backend: { threadId: String(i) } } } },
      }),
    ),
  );
  assert.equal((await store.load()).version, 2);
  assert.equal(
    (await readdir(path.join(root, ".orchestrator"))).filter((f) =>
      f.endsWith(".tmp"),
    ).length,
    0,
  );
});
test("independent state stores merge concurrent project and role thread updates", async () => {
  const root = await fixture();
  const first = new OrchestratorStateStore(root);
  const second = new OrchestratorStateStore(root);
  const staleFirst = await first.load();
  const staleSecond = await second.load();
  await Promise.all([
    first.saveAgent(staleFirst, "project-a", "architect", {
      threadId: "thread-a",
    }),
    second.saveAgent(staleSecond, "project-b", "backend", {
      threadId: "thread-b",
    }),
    first.saveAgent(staleFirst, "project-a", "frontend", {
      threadId: "thread-a-ui",
    }),
  ]);
  const state = await new OrchestratorStateStore(root).load();
  assert.equal(
    state.projects["project-a"]!.agents.architect!.threadId,
    "thread-a",
  );
  assert.equal(
    state.projects["project-a"]!.agents.frontend!.threadId,
    "thread-a-ui",
  );
  assert.equal(
    state.projects["project-b"]!.agents.backend!.threadId,
    "thread-b",
  );
});
test("fifty concurrent stale snapshots preserve every logically independent state update", async () => {
  const root = await fixture();
  const stores = [
    new OrchestratorStateStore(root),
    new OrchestratorStateStore(root),
  ];
  const snapshots = await Promise.all(stores.map((store) => store.load()));
  const updates = Array.from({ length: 50 }, (_, index) => {
    const projectId = `project-${index % 10}`;
    const role = (["architect", "backend", "frontend"] as const)[
      Math.floor(index / 10) % 3
    ]!;
    const threadId = `${projectId}-${role}`;
    return stores[index % stores.length]!.saveAgent(
      snapshots[index % snapshots.length]!,
      projectId,
      role,
      { threadId },
    );
  });
  await Promise.all(updates);
  const state = await new OrchestratorStateStore(root).load();
  for (let project = 0; project < 10; project += 1) {
    for (const role of ["architect", "backend", "frontend"] as const) {
      assert.equal(
        state.projects[`project-${project}`]!.agents[role]!.threadId,
        `project-${project}-${role}`,
      );
    }
  }
});
test("legacy orchestrator threads migrate with backup", async () => {
  const root = await fixture();
  await mkdir(path.join(root, ".orchestrator"));
  const source = JSON.stringify({
    agents: { backend: { threadId: "legacy-thread" } },
  });
  await writeFile(path.join(root, ".orchestrator/state.json"), source);
  const state = await new OrchestratorStateStore(root).load();
  assert.equal(
    state.projects["legacy-unassigned"]!.agents.backend!.threadId,
    "legacy-thread",
  );
  const backup = (await readdir(path.join(root, ".orchestrator"))).find((f) =>
    f.startsWith("state.legacy."),
  )!;
  assert.equal(
    await readFile(path.join(root, ".orchestrator", backup), "utf8"),
    source,
  );
});
test("unsafe workflow identifiers cannot escape persistence directory", async () => {
  const store = new WorkflowStore(await fixture());
  await assert.rejects(store.get("p", "../escape"));
  await assert.rejects(store.get("../p", "w"));
});
