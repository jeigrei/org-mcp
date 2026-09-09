import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrgStore } from "./store.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "org-mcp-test-"));
  const store = new OrgStore(dir);
  await store.init();

  console.log("dir:", dir);

  const task = await store.capture({
    headline: "Buy groceries",
    todo: "TODO",
    priority: "B",
    tags: ["errand", "home"],
    scheduled: "2026-08-20",
    body: "Milk, eggs, bread.",
  });
  assert(task.id, "capture returns an id");
  console.log("captured:", task.headline, task.id);

  const child = await store.capture({
    headline: "Buy milk specifically oat milk",
    parentId: task.id!,
  });
  assert(child.level === task.level + 1, "child nested one level deeper");

  const note = await store.capture({
    file: "notes.org",
    headline: "Idea: org-mcp server",
    body: "Build an MCP server backed by org files.",
  });
  assert(note.todo === null, "plain note has no todo keyword");

  const deadlineTask = await store.capture({
    headline: "File taxes",
    todo: "TODO",
    priority: "A",
    deadline: "2026-08-19",
  });

  const files = await store.listFiles();
  assert(files.includes("inbox.org"), "inbox.org tracked");
  assert(files.includes("notes.org"), "notes.org tracked");
  console.log("files:", files);

  const raw = await fs.readFile(path.join(dir, "inbox.org"), "utf8");
  console.log("--- inbox.org ---\n" + raw + "--- end ---");

  const todos = await store.listTodos();
  assert(todos.length === 2, `expected 2 open todos, got ${todos.length}`);
  assert(todos[0].priority === "A", "priority A (File taxes) sorts first");
  console.log(
    "todos:",
    todos.map((t) => `${t.priority}/${t.headline}`)
  );

  const agendaToday = await store.agenda("2026-08-19", "2026-08-19");
  console.log("agenda today:", JSON.stringify(agendaToday, null, 2));
  assert(
    agendaToday.some((i) => i.entry.id === deadlineTask.id && i.reason === "deadline"),
    "deadline task appears in today's agenda"
  );

  const agendaWeek = await store.agenda("2026-08-19", "2026-08-25");
  assert(
    agendaWeek.some((i) => i.entry.id === task.id && i.reason === "scheduled"),
    "scheduled groceries task appears in week agenda"
  );

  const updated = await store.updateState(deadlineTask.id!, "DONE");
  assert(updated.todo === "DONE", "state updated to DONE");
  assert(updated.closed !== null, "CLOSED timestamp set");
  console.log("after DONE:", updated);

  const todosAfterDone = await store.listTodos();
  assert(todosAfterDone.length === 1, "DONE task no longer in open todos");

  const rescheduled = await store.schedule(task.id!, { scheduled: "2026-08-22" });
  assert(rescheduled.scheduled?.date === "2026-08-22", "reschedule applied");

  const cleared = await store.schedule(task.id!, { scheduled: null });
  assert(cleared.scheduled === null, "schedule cleared");
  assert((cleared as any).planningLine === undefined, "clean entry hides internal offsets");

  const withNote = await store.addNote(task.id!, "Called the store, they're out of oat milk.");
  assert(withNote.body.includes("Called the store"), "note appended to body");
  console.log("entry with note body:\n" + withNote.body);

  const searchResults = await store.search("oat milk");
  assert(searchResults.length >= 1, "search finds note mentioning oat milk");

  const archived = await store.archiveEntry(deadlineTask.id!);
  assert(archived.archivedTo === "inbox_archive.org", "archived to companion file");
  const stillFindable = await store.getEntry(deadlineTask.id!);
  assert(stillFindable !== null, "archived entry still fetchable via getEntry(includeArchive)");
  const todosAfterArchive = await store.listTodos();
  assert(
    !todosAfterArchive.some((t) => t.id === deadlineTask.id),
    "archived entry no longer in active todos"
  );

  const rawAfterArchive = await fs.readFile(path.join(dir, "inbox.org"), "utf8");
  console.log("--- inbox.org after archive ---\n" + rawAfterArchive + "--- end ---");
  const rawArchive = await fs.readFile(path.join(dir, "inbox_archive.org"), "utf8");
  console.log("--- inbox_archive.org ---\n" + rawArchive + "--- end ---");

  // --- Hand-edited file: repeater/time-range preservation + lazy ID assignment ---
  const handWritten = [
    "* TODO Take out recycling",
    "  SCHEDULED: <2026-08-20 Thu +1w>",
    "",
    "* TODO Standup",
    "  SCHEDULED: <2026-08-20 Thu 10:00-10:15>",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "recurring.org"), handWritten, "utf8");

  const agendaHand = await store.agenda("2026-08-20", "2026-08-20");
  const recycling = agendaHand.find((i) => i.entry.headline === "Take out recycling");
  const standup = agendaHand.find((i) => i.entry.headline === "Standup");
  assert(recycling !== undefined, "repeater-scheduled entry appears in agenda (was silently dropped)");
  assert(recycling!.entry.scheduled?.date === "2026-08-20", "repeater entry date parsed correctly");
  assert(standup !== undefined, "time-range-scheduled entry appears in agenda");
  assert(standup!.entry.id !== null, "hand-written entry was lazily assigned an id by agenda()");
  console.log("hand-written entries after lazy id assignment:", {
    recycling: recycling!.entry.id,
    standup: standup!.entry.id,
  });

  const doneRecycling = await store.updateState(recycling!.entry.id!, "DONE");
  assert(doneRecycling.closed !== null, "CLOSED stamp added");
  const rawRecurring = await fs.readFile(path.join(dir, "recurring.org"), "utf8");
  console.log("--- recurring.org after marking recycling DONE ---\n" + rawRecurring + "--- end ---");
  assert(rawRecurring.includes("+1w"), "repeater cookie survived a state change that touched CLOSED");

  const rescheduledStandup = await store.schedule(standup!.entry.id!, { deadline: "2026-08-21" });
  assert(rescheduledStandup.deadline?.date === "2026-08-21", "deadline added alongside existing schedule");
  const rawAfterSchedule = await fs.readFile(path.join(dir, "recurring.org"), "utf8");
  assert(rawAfterSchedule.includes("10:00-10:15"), "time-range on an untouched field survived a schedule() call");
  console.log("--- recurring.org after scheduling standup deadline ---\n" + rawAfterSchedule + "--- end ---");

  // --- CleanEntry should never leak internal line-offset bookkeeping ---
  const cleanKeys = Object.keys(rescheduledStandup);
  for (const leaky of ["startLine", "endLine", "headlineLine", "planningLine", "scheduledRaw"]) {
    assert(!cleanKeys.includes(leaky), `CleanEntry must not expose internal field "${leaky}"`);
  }

  console.log("\nALL TESTS PASSED");
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
