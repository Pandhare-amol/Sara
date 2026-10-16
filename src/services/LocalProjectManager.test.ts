import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalProjectManager } from "./LocalProjectManager";

test("general project and task data persist independently in the local store", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-projects-"));
  const storagePath = path.join(directory, "general-projects.json");
  try {
    const manager = new LocalProjectManager(storagePath);
    const project = manager.createProject({ title: "Website refresh", description: "Plan and ship a small redesign." });
    const task = manager.createTask({ projectId: project.id, title: "Audit current pages", priority: "high" });
    manager.updateTask(task.id, { status: "done" });

    const reopened = new LocalProjectManager(storagePath);
    const detail = reopened.getProject(project.id);
    assert.equal(detail?.project.title, "Website refresh");
    assert.equal(detail?.tasks.length, 1);
    assert.equal(detail?.tasks[0].status, "done");
    assert.deepEqual(reopened.listProjects()[0]?.completedTaskCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt project stores fail closed and are never overwritten as an empty store", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-projects-corrupt-"));
  const storagePath = path.join(directory, "projects.json");
  const manager = new LocalProjectManager(storagePath);
  const corruptContents = "{\"projects\":[";
  try {
    fs.writeFileSync(storagePath, corruptContents, "utf8");
    assert.throws(() => manager.listProjects(), /invalid JSON/i);
    assert.throws(() => manager.createProject({ title: "Do not replace the damaged store" }), /invalid JSON/i);
    assert.equal(fs.readFileSync(storagePath, "utf8"), corruptContents);
    assert.deepEqual(fs.readdirSync(directory), ["projects.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid project records and unsupported stores are preserved for recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-projects-invalid-"));
  const storagePath = path.join(directory, "projects.json");
  const invalidContents = JSON.stringify({ version: 1, projects: [{ id: "p1", title: "Incomplete" }], tasks: [] });
  const manager = new LocalProjectManager(storagePath);
  try {
    fs.writeFileSync(storagePath, invalidContents, "utf8");
    assert.throws(() => manager.createProject({ title: "Do not discard invalid records" }), /invalid project record/i);
    assert.equal(fs.readFileSync(storagePath, "utf8"), invalidContents);

    const unsupportedContents = JSON.stringify({ version: 2, projects: [], tasks: [] });
    fs.writeFileSync(storagePath, unsupportedContents, "utf8");
    assert.throws(() => manager.listProjects(), /unsupported version/i);
    assert.equal(fs.readFileSync(storagePath, "utf8"), unsupportedContents);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verified project workflow requires approval, commits atomically, and is idempotent on retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-project-workflow-"));
  const storagePath = path.join(directory, "projects.json");
  const manager = new LocalProjectManager(storagePath);
  const draft = {
    workflowId: "workflow-test-001",
    project: { title: "Quarterly report", description: "Prepare and verify a local report." },
    tasks: [
      { title: "Collect metrics", priority: "high" },
      { title: "Review findings", priority: "normal" },
    ],
  };
  try {
    assert.throws(() => manager.applyProjectWorkflow(draft, false), /explicit approval/i);
    assert.equal(fs.existsSync(storagePath), false);

    const preview = manager.previewProjectWorkflow(draft);
    assert.equal(preview.tasks.length, 2);
    const first = manager.applyProjectWorkflow(draft, true);
    assert.equal(first.alreadyApplied, false);
    assert.equal(first.tasks.length, 2);

    const reopened = new LocalProjectManager(storagePath);
    const retry = reopened.applyProjectWorkflow(draft, true);
    assert.equal(retry.alreadyApplied, true);
    assert.equal(retry.project.id, first.project.id);
    assert.deepEqual(retry.tasks.map((task) => task.id), first.tasks.map((task) => task.id));

    const stored = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    assert.equal(stored.projects.length, 1);
    assert.equal(stored.tasks.length, 2);
    assert.equal(stored.workflowApplications.length, 1);
    assert.equal(reopened.getProject(first.project.id)?.tasks.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a workflow retry with a changed plan is rejected without adding duplicate records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-project-workflow-conflict-"));
  const storagePath = path.join(directory, "projects.json");
  const manager = new LocalProjectManager(storagePath);
  try {
    const base = {
      workflowId: "workflow-test-002",
      project: { title: "Research" },
      tasks: [{ title: "Read source material" }],
    };
    manager.applyProjectWorkflow(base, true);
    assert.throws(() => manager.applyProjectWorkflow({
      ...base,
      tasks: [{ title: "Different task" }],
    }, true), /different plan/i);
    const stored = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    assert.equal(stored.projects.length, 1);
    assert.equal(stored.tasks.length, 1);
    assert.equal(stored.tasks[0].title, "Read source material");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid project workflow drafts are rejected before any data is written", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-project-workflow-invalid-"));
  const storagePath = path.join(directory, "projects.json");
  const manager = new LocalProjectManager(storagePath);
  try {
    assert.throws(() => manager.previewProjectWorkflow({
      workflowId: "workflow-invalid",
      project: { title: "Invalid" },
      tasks: [],
    }), /between 1 and 50 tasks/i);
    assert.equal(fs.existsSync(storagePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("project manager validates user input and keeps archive as a reversible state change", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-projects-"));
  const manager = new LocalProjectManager(path.join(directory, "projects.json"));
  try {
    assert.throws(() => manager.createProject({ title: "   " }), /title is required/i);
    const project = manager.createProject({ title: "Research" });
    manager.updateProject(project.id, { status: "archived" });
    assert.equal(manager.listProjects().length, 0);
    assert.equal(manager.listProjects({ includeArchived: true }).length, 1);
    assert.throws(() => manager.createTask({ projectId: project.id, title: "Do work" }), /completed or archived/i);
    assert.equal(fs.existsSync(path.join(directory, "projects.json")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
