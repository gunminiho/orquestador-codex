import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireDurableClaim,
  DurableClaimBusyError,
} from "../state/reconciliation-claim";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import {
  RepositoryBusyError,
  RepositoryLock,
  StaleForeignRepositoryLockError,
} from "../workflows/repository-lock";

const deadPid = 2147483647;

async function root(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function claim(targetPath: string, targetIdentity: string, overrides = {}) {
  return {
    sessionId: "dead-reconciler",
    pid: deadPid,
    hostname: os.hostname(),
    acquiredAt: "2000-01-01T00:00:00.000Z",
    targetPath,
    targetIdentity,
    ...overrides,
  };
}

test("orphaned state reconciliation claim is recovered before saveAgent", async () => {
  const fixture = await root("state-claim-");
  const directory = path.join(fixture, ".orchestrator");
  const lock = path.join(directory, "state.mutation.lock");
  const reconcile = path.join(directory, "state.mutation.reconcile");
  await mkdir(directory);
  await writeFile(
    lock,
    JSON.stringify({
      sessionId: "dead-state-owner",
      pid: deadPid,
      hostname: os.hostname(),
    }),
  );
  await writeFile(
    reconcile,
    JSON.stringify(claim(lock, `dead-state-owner:${deadPid}`)),
  );

  const store = new OrchestratorStateStore(fixture);
  await store.saveAgent(await store.load(), "project", "backend", {
    threadId: "restored-thread",
  });
  assert.equal(
    (await store.load()).projects.project!.agents.backend!.threadId,
    "restored-thread",
  );
  await assert.rejects(access(reconcile));
});

test("live and foreign reconciliation claims are never stolen", async () => {
  const fixture = await root("state-claim-");
  const file = path.join(fixture, ".orchestrator", "state.mutation.reconcile");
  const target = {
    targetPath: path.join(fixture, ".orchestrator", "state.mutation.lock"),
    targetIdentity: "target",
  };
  await mkdir(path.dirname(file), { recursive: true });
  const live = claim(target.targetPath, target.targetIdentity, {
    sessionId: "live-reconciler",
    pid: process.pid,
  });
  await writeFile(file, JSON.stringify(live));
  await assert.rejects(
    acquireDurableClaim(file, target),
    DurableClaimBusyError,
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), live);

  const foreign = claim(target.targetPath, target.targetIdentity, {
    sessionId: "foreign-reconciler",
    hostname: "foreign-host",
  });
  await writeFile(file, JSON.stringify(foreign));
  await assert.rejects(
    acquireDurableClaim(file, target),
    DurableClaimBusyError,
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), foreign);
});

test("foreign state reconciliation claims fail safely without a retry loop", async () => {
  const fixture = await root("state-claim-");
  const directory = path.join(fixture, ".orchestrator");
  const lock = path.join(directory, "state.mutation.lock");
  const reconcile = path.join(directory, "state.mutation.reconcile");
  await mkdir(directory);
  await writeFile(
    lock,
    JSON.stringify({
      sessionId: "dead-state-owner",
      pid: deadPid,
      hostname: os.hostname(),
    }),
  );
  const foreign = claim(lock, `dead-state-owner:${deadPid}`, {
    hostname: "foreign-host",
  });
  await writeFile(reconcile, JSON.stringify(foreign));
  const store = new OrchestratorStateStore(fixture);
  await assert.rejects(
    store.saveAgent(await store.load(), "project", "backend", {
      threadId: "blocked",
    }),
    DurableClaimBusyError,
  );
  assert.deepEqual(JSON.parse(await readFile(reconcile, "utf8")), foreign);
});

test("concurrent state recovery from an orphaned claim preserves both updates", async () => {
  const fixture = await root("state-claim-");
  const directory = path.join(fixture, ".orchestrator");
  const lock = path.join(directory, "state.mutation.lock");
  await mkdir(directory);
  await writeFile(
    lock,
    JSON.stringify({
      sessionId: "dead-state-owner",
      pid: deadPid,
      hostname: os.hostname(),
    }),
  );
  await writeFile(
    path.join(directory, "state.mutation.reconcile"),
    JSON.stringify(claim(lock, `dead-state-owner:${deadPid}`)),
  );
  const first = new OrchestratorStateStore(fixture);
  const second = new OrchestratorStateStore(fixture);
  const stale = await first.load();
  await Promise.all([
    first.saveAgent(stale, "first", "architect", { threadId: "one" }),
    second.saveAgent(stale, "second", "frontend", { threadId: "two" }),
  ]);
  const state = await first.load();
  assert.equal(state.projects.first!.agents.architect!.threadId, "one");
  assert.equal(state.projects.second!.agents.frontend!.threadId, "two");
  await assert.rejects(
    access(path.join(directory, "state.mutation.reconcile")),
  );
});

async function repositoryInput() {
  const physicalRoot = await root("repository-claim-");
  return {
    projectId: "project",
    repositoryId: "repository",
    physicalRoot,
    workflowId: "workflow",
    taskId: "task",
    attemptId: "attempt",
  };
}

async function deadRepositoryLease() {
  const input = await repositoryInput();
  const owner = new RepositoryLock();
  const lease = await owner.acquire(input);
  lease.owner.pid = deadPid;
  lease.owner.serverPid = null;
  await writeFile(
    path.join(input.physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify(lease),
  );
  return { input, lease };
}

test("orphaned repository reconciliation claim is recovered by one fresh owner", async () => {
  const { input, lease } = await deadRepositoryLease();
  const lockFile = path.join(
    input.physicalRoot,
    ".orchestrator-repository.lock",
  );
  const reconcile = `${lockFile}.reconcile`;
  await writeFile(
    reconcile,
    JSON.stringify(
      claim(
        lockFile,
        `${lease.owner.sessionId}:${lease.owner.pid}:${lease.owner.serverPid}`,
      ),
    ),
  );
  const contender = new RepositoryLock();
  const adopted = await contender.acquire(input);
  assert.equal(adopted.owner.sessionId, contender.sessionId);
  assert.deepEqual(await contender.inspect(input.physicalRoot), adopted);
  assert.equal(await contender.release(adopted), true);
  await assert.rejects(access(reconcile));
});

test("live and foreign repository reconciliation claims are not stolen", async () => {
  const { input, lease } = await deadRepositoryLease();
  const lockFile = path.join(
    input.physicalRoot,
    ".orchestrator-repository.lock",
  );
  const reconcile = `${lockFile}.reconcile`;
  const targetIdentity = `${lease.owner.sessionId}:${lease.owner.pid}:${lease.owner.serverPid}`;
  const live = claim(lockFile, targetIdentity, { pid: process.pid });
  await writeFile(reconcile, JSON.stringify(live));
  await assert.rejects(
    new RepositoryLock().acquire(input),
    RepositoryBusyError,
  );
  assert.deepEqual(JSON.parse(await readFile(reconcile, "utf8")), live);

  const foreign = claim(lockFile, targetIdentity, { hostname: "foreign-host" });
  await writeFile(reconcile, JSON.stringify(foreign));
  await assert.rejects(
    new RepositoryLock().acquire(input),
    StaleForeignRepositoryLockError,
  );
  assert.deepEqual(JSON.parse(await readFile(reconcile, "utf8")), foreign);
});

test("concurrent repository stale recovery elects exactly one adopter", async () => {
  const { input, lease } = await deadRepositoryLease();
  const lockFile = path.join(
    input.physicalRoot,
    ".orchestrator-repository.lock",
  );
  await writeFile(
    `${lockFile}.reconcile`,
    JSON.stringify(
      claim(
        lockFile,
        `${lease.owner.sessionId}:${lease.owner.pid}:${lease.owner.serverPid}`,
      ),
    ),
  );
  const first = new RepositoryLock();
  const second = new RepositoryLock();
  const outcomes = await Promise.allSettled([
    first.acquire(input),
    second.acquire(input),
  ]);
  const winners = outcomes.filter(
    (
      outcome,
    ): outcome is PromiseFulfilledResult<
      Awaited<ReturnType<RepositoryLock["acquire"]>>
    > => outcome.status === "fulfilled",
  );
  assert.equal(winners.length, 1);
  const winner = winners[0]!.value;
  const owner = winner.owner.sessionId === first.sessionId ? first : second;
  assert.deepEqual(await owner.inspect(input.physicalRoot), winner);
  assert.equal(await owner.release(winner), true);
});
