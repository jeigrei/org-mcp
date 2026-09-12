import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrgStore } from "./store.js";
import { IdentityResolver, IdentityError, sanitizeUserId } from "./identity.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function testOrganizeTools(baseDir: string) {
  console.log("\n=== refile / tags / edit ===");
  const dir = path.join(baseDir, "organize");
  const store = new OrgStore(dir);
  await store.init();

  // --- refile a leaf under a parent in the same file ---
  const project = await store.capture({ headline: "Kitchen renovation" });
  const task = await store.capture({ headline: "Get quote", todo: "TODO" });
  const moved = await store.refile(task.id!, { parentId: project.id! });
  assert(moved.level === 2, `expected level 2, got ${moved.level}`);
  assert(moved.file === "inbox.org", "stayed in the same file");
  assert((await store.getEntry(task.id!))!.headline === "Get quote", "still reachable by id");

  // --- refile a parent WITH children: the whole subtree must shift ---
  const area = await store.capture({ headline: "Home" });
  await store.refile(project.id!, { parentId: area.id! });
  const projectAfter = (await store.getEntry(project.id!))!;
  const taskAfter = (await store.getEntry(task.id!))!;
  assert(projectAfter.level === 2, `project should be level 2, got ${projectAfter.level}`);
  assert(
    taskAfter.level === 3,
    `child should have shifted to level 3, got ${taskAfter.level} (subtree was flattened)`
  );
  console.log("inbox.org after nesting:\n" + (await store.readFile("inbox.org")));

  // --- cycle guard ---
  let cycleRejected = false;
  try {
    await store.refile(area.id!, { parentId: taskAfter.id! });
  } catch {
    cycleRejected = true;
  }
  assert(cycleRejected, "refiling an entry under its own descendant must be rejected");

  // --- refile across files, carrying children along ---
  await store.refile(project.id!, { file: "home.org" });
  const projectMoved = (await store.getEntry(project.id!))!;
  const taskMoved = (await store.getEntry(task.id!))!;
  assert(projectMoved.file === "home.org", `expected home.org, got ${projectMoved.file}`);
  assert(projectMoved.level === 1, "top level in the destination file");
  assert(taskMoved.file === "home.org", "child came along to the new file");
  assert(taskMoved.level === 2, `child re-leveled under its parent, got ${taskMoved.level}`);
  const inboxAfter = await store.readFile("inbox.org");
  assert(!inboxAfter.includes("Kitchen renovation"), "entry left the source file");
  assert(!/\n\n\n/.test(inboxAfter), "no stray blank-line pileup in the source file");

  // --- tags ---
  await store.setTags(task.id!, ["home", "errand"]);
  assert(
    JSON.stringify((await store.getEntry(task.id!))!.tags) === JSON.stringify(["home", "errand"]),
    "tags set"
  );
  await store.updateState(task.id!, "DONE");
  assert(
    (await store.getEntry(task.id!))!.tags.length === 2,
    "tags survive a headline rebuild from updateState"
  );
  await store.setTags(task.id!, ["home"]);
  assert((await store.getEntry(task.id!))!.tags.length === 1, "tags replaced, not merged");
  await store.setTags(task.id!, []);
  assert((await store.getEntry(task.id!))!.tags.length === 0, "tags cleared");

  await store.setTags(project.id!, ["home", "reno"]);
  await store.setTags(area.id!, ["home"]);
  const tags = await store.listTags();
  const home = tags.find((t) => t.tag === "home");
  assert(home?.count === 2, `expected home used twice, got ${JSON.stringify(tags)}`);
  assert(tags.some((t) => t.tag === "reno"), "reno counted");
  console.log("tag inventory:", tags);

  // --- editEntry ---
  const scheduled = await store.capture({
    headline: "call contractor",
    todo: "TODO",
    priority: "C",
    tags: ["home"],
    scheduled: "2026-10-01",
    body: "original body",
  });
  const renamed = await store.editEntry(scheduled.id!, {
    headline: "Get bathroom quote from Sarah",
  });
  assert(renamed.headline === "Get bathroom quote from Sarah", "headline changed");
  assert(renamed.id === scheduled.id, "id is stable across a rename");
  assert(renamed.todo === "TODO", "todo keyword preserved");
  assert(renamed.priority === "C", "priority preserved");
  assert(renamed.tags.includes("home"), "tags preserved");
  assert(renamed.scheduled?.date === "2026-10-01", "SCHEDULED preserved");
  assert(renamed.body.includes("original body"), "body untouched when not passed");

  const reprioritized = await store.editEntry(scheduled.id!, { priority: "A" });
  assert(reprioritized.priority === "A", "priority changed");
  const unprioritized = await store.editEntry(scheduled.id!, { priority: null });
  assert(unprioritized.priority === null, "priority cleared");

  const rebodied = await store.editEntry(scheduled.id!, { body: "new body\nsecond line" });
  assert(rebodied.body.includes("second line"), "body replaced");
  assert(!rebodied.body.includes("original body"), "old body gone");
  const debodied = await store.editEntry(scheduled.id!, { body: null });
  assert(debodied.body.trim() === "", "body cleared");

  // --- editing a parent's body must not eat its children ---
  const withKids = (await store.getEntry(project.id!))!;
  await store.editEntry(withKids.id!, { body: "project context goes here" });
  const kidStillThere = await store.getEntry(task.id!);
  assert(kidStillThere !== null, "child survived the parent's body edit");
  assert(kidStillThere!.level === 2, "child kept its level");
  console.log("home.org after body edit:\n" + (await store.readFile("home.org")));

  console.log("refile / tags / edit OK");
}

async function testIdentityMapping(dir: string) {
  console.log("\n=== identity mapping ===");

  assert(sanitizeUserId("Alice") === "alice", "sanitize lowercases");
  assert(sanitizeUserId("alice@gmail.com") === "alice_gmail.com", "sanitize rewrites @");
  assert(sanitizeUserId("  spaced name  ") === "spaced_name", "sanitize trims and joins");
  let threw = false;
  try {
    sanitizeUserId("!!!");
  } catch {
    threw = true;
  }
  assert(threw, "sanitize rejects an identity with nothing usable in it");

  // With no map configured, behavior is unchanged: each claim gets its own directory.
  const permissive = await IdentityResolver.load(undefined);
  assert(!permissive.isStrict, "no map means non-strict");
  assert(permissive.resolve("alice") === "alice", "unmapped claim passes through");
  assert(
    permissive.resolve("alice@gmail.com") === "alice_gmail.com",
    "without a map, the same human's two claims split into two ids (the bug the map fixes)"
  );

  const mapPath = path.join(dir, "identities.json");
  await fs.writeFile(
    mapPath,
    JSON.stringify({
      grayson: "grayson",
      "j.g.cupit@gmail.com": "grayson",
      "Alice-Laptop": "alice",
      "alice@example.com": "alice",
    }),
    "utf8"
  );
  const strict = await IdentityResolver.load(mapPath);

  assert(strict.isStrict, "configured map means strict");
  assert(strict.size === 4, `expected 4 claims, got ${strict.size}`);
  assert(
    strict.resolve("grayson") === strict.resolve("j.g.cupit@gmail.com"),
    "service token and email claims converge on one id"
  );
  assert(strict.resolve("grayson") === "grayson", "canonical id is the mapped value");
  assert(strict.resolve("alice@example.com") === "alice", "second user maps independently");
  assert(strict.resolve("ALICE-LAPTOP") === "alice", "lookup is case-insensitive");
  assert(strict.resolve("  alice@example.com ") === "alice", "lookup tolerates whitespace");
  assert(
    JSON.stringify(strict.userIds) === JSON.stringify(["alice", "grayson"]),
    `expected deduped user ids, got ${JSON.stringify(strict.userIds)}`
  );

  let rejected = false;
  try {
    strict.resolve("mallory@evil.com");
  } catch (err) {
    rejected = err instanceof IdentityError;
  }
  assert(rejected, "unmapped identity is rejected with IdentityError, not given a directory");

  // Malformed maps must fail loudly at load, not at request time.
  const badPath = path.join(dir, "bad.json");
  await fs.writeFile(badPath, "{ not json", "utf8");
  let loadFailed = false;
  try {
    await IdentityResolver.load(badPath);
  } catch {
    loadFailed = true;
  }
  assert(loadFailed, "invalid JSON fails at load");

  const arrayPath = path.join(dir, "array.json");
  await fs.writeFile(arrayPath, '["alice"]', "utf8");
  loadFailed = false;
  try {
    await IdentityResolver.load(arrayPath);
  } catch {
    loadFailed = true;
  }
  assert(loadFailed, "a non-object map fails at load");

  loadFailed = false;
  try {
    await IdentityResolver.load(path.join(dir, "does-not-exist.json"));
  } catch {
    loadFailed = true;
  }
  assert(loadFailed, "a missing map file fails at load");

  console.log("identity mapping OK");
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

  await testOrganizeTools(dir);
  await testIdentityMapping(dir);

  console.log("\nALL TESTS PASSED");
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
