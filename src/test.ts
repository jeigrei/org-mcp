import { deepStrictEqual } from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrgStore, OrgError, filterEntries, type EntryFilter } from "./store.js";
import { parseOrgFile } from "./orgFile.js";
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

async function testAtomicWrites(baseDir: string) {
  console.log("\n=== atomic writes & .bak ===");
  const dir = path.join(baseDir, "atomic");
  const store = new OrgStore(dir);
  await store.init();

  const inboxPath = path.join(dir, "inbox.org");
  const bakPath = `${inboxPath}.bak`;

  // First write: creates inbox.org, no .bak yet (no previous version).
  const first = await store.capture({ headline: "First task", todo: "TODO" });
  const v1 = await fs.readFile(inboxPath, "utf8");
  let bakExists = true;
  try {
    await fs.access(bakPath);
  } catch {
    bakExists = false;
  }
  assert(!bakExists, "no .bak created on initial file creation");

  // Second write: .bak holds v1, live file holds v2.
  await store.capture({ headline: "Second task", todo: "TODO" });
  const v2 = await fs.readFile(inboxPath, "utf8");
  assert(v2 !== v1, "second write updated inbox.org");
  assert((await fs.readFile(bakPath, "utf8")) === v1, ".bak holds previous version (v1)");

  // Third write: .bak rolls over to v2, live file holds v3.
  await store.updateState(first.id!, "DONE");
  const v3 = await fs.readFile(inboxPath, "utf8");
  assert(v3 !== v2, "third write updated inbox.org");
  assert((await fs.readFile(bakPath, "utf8")) === v2, ".bak rolled over to v2");

  // listFiles must ignore .bak and any hidden/tmp files.
  const listed = await store.listFiles(true);
  assert(
    JSON.stringify(listed) === JSON.stringify(["inbox.org"]),
    `listFiles should only return .org files, got ${JSON.stringify(listed)}`
  );

  // Failure before rename must leave the original untouched and clean up the temp file.
  let seenTmpInSameDir = false;
  let seenTmpHadNewHeadline = false;
  const failingStore = new OrgStore(dir, {
    beforeRename: async (tmpPath, targetPath) => {
      seenTmpInSameDir = path.dirname(tmpPath) === path.dirname(targetPath);
      const tmpContent = await fs.readFile(tmpPath, "utf8");
      seenTmpHadNewHeadline = tmpContent.includes("Should not land");
      throw new Error("simulated crash before rename");
    },
  });

  let failed = false;
  try {
    await failingStore.capture({ headline: "Should not land", todo: "TODO" });
  } catch (err: any) {
    failed = err?.message === "simulated crash before rename";
  }
  assert(failed, "capture propagated pre-rename failure");
  assert(seenTmpInSameDir, "temp file was created in the same directory as target");
  assert(seenTmpHadNewHeadline, "temp file contained the new content before rename");
  assert(
    (await fs.readFile(inboxPath, "utf8")) === v3,
    "original file is completely untouched after failure before rename"
  );

  const remaining = await fs.readdir(dir);
  assert(
    !remaining.some((name) => name.endsWith(".tmp")),
    `no leftover .tmp files after failure, found: ${JSON.stringify(remaining)}`
  );

  // Preserve existing file mode across writes.
  await fs.chmod(inboxPath, 0o600);
  await store.capture({ headline: "Mode preserved", todo: "TODO" });
  const modeAfter = (await fs.stat(inboxPath)).mode & 0o7777;
  assert(
    modeAfter === 0o600,
    `expected file mode 0600 to be preserved, got 0${modeAfter.toString(8)}`
  );

  // Follow symlinks: keep the symlink intact and write/backup in the real target's directory.
  const realDir = path.join(baseDir, "atomic-real");
  const linkDir = path.join(baseDir, "atomic-link");
  await fs.mkdir(realDir, { recursive: true });
  await fs.mkdir(linkDir, { recursive: true });
  const realInbox = path.join(realDir, "inbox.org");
  const linkInbox = path.join(linkDir, "inbox.org");
  const initialRealContent = "* TODO Initial real entry\n";
  await fs.writeFile(realInbox, initialRealContent, "utf8");
  await fs.symlink(realInbox, linkInbox);

  const linkStore = new OrgStore(linkDir);
  await linkStore.capture({ headline: "Written via symlink", todo: "TODO" });

  const linkStat = await fs.lstat(linkInbox);
  assert(linkStat.isSymbolicLink(), "symlink must remain a symlink after write");
  const realAfter = await fs.readFile(realInbox, "utf8");
  assert(
    realAfter.includes("Written via symlink"),
    "real target file must receive the new content"
  );
  assert(
    (await fs.readFile(`${realInbox}.bak`, "utf8")) === initialRealContent,
    ".bak must be created in the real target's directory with previous content"
  );
  const linkDirEntries = await fs.readdir(linkDir);
  assert(
    JSON.stringify(linkDirEntries) === JSON.stringify(["inbox.org"]),
    `symlink directory should only contain inbox.org, got ${JSON.stringify(linkDirEntries)}`
  );

  // Dangling symlink: fail loudly with OrgError and leave the symlink intact.
  const danglingDir = path.join(baseDir, "atomic-dangling");
  await fs.mkdir(danglingDir, { recursive: true });
  const danglingInbox = path.join(danglingDir, "inbox.org");
  const missingTarget = path.join(baseDir, "unmounted", "inbox.org");
  await fs.symlink(missingTarget, danglingInbox);

  const danglingStore = new OrgStore(danglingDir);
  let danglingError: unknown = null;
  try {
    await danglingStore.capture({ headline: "Should fail on dangling symlink", todo: "TODO" });
  } catch (err) {
    danglingError = err;
  }
  assert(
    danglingError instanceof OrgError,
    `expected OrgError when writing through dangling symlink, got ${danglingError}`
  );
  const danglingStat = await fs.lstat(danglingInbox);
  assert(danglingStat.isSymbolicLink(), "dangling symlink must remain a symlink after failed write");
  assert(
    (await fs.readlink(danglingInbox)) === missingTarget,
    "dangling symlink target must remain unchanged"
  );
  let missingTargetExists = true;
  try {
    await fs.access(missingTarget);
  } catch {
    missingTargetExists = false;
  }
  assert(!missingTargetExists, "missing symlink target must not be created");
  const danglingDirEntries = await fs.readdir(danglingDir);
  assert(
    JSON.stringify(danglingDirEntries) === JSON.stringify(["inbox.org"]),
    `dangling symlink directory should only contain inbox.org, got ${JSON.stringify(danglingDirEntries)}`
  );

  console.log("atomic writes & .bak OK");
}

async function testCaptureMatchesGetEntry(baseDir: string) {
  console.log("\n=== capture matches getEntry ===");
  const dir = path.join(baseDir, "capture-match");
  const store = new OrgStore(dir);
  await store.init();

  const cases = [
    await store.capture({
      headline: "Full entry",
      todo: "TODO",
      priority: "A",
      tags: ["work", "urgent!"],
      scheduled: "2026-11-15 09:30",
      deadline: "2026-11-20",
      body: "\nLine one\r\nLine two\n\n",
    }),
    await store.capture({
      headline: "Whitespace body",
      body: "   \n  ",
    }),
    await store.capture({
      file: "notes",
      headline: "Custom file without extension",
    }),
  ];

  const child = await store.capture({
    headline: "Nested child",
    todo: "NEXT",
    parentId: cases[0].id!,
    body: "Child notes",
  });
  cases.push(child);

  for (const captured of cases) {
    assert(captured.id, "captured entry has an id");
    const fetched = await store.getEntry(captured.id);
    deepStrictEqual(captured, fetched);
  }

  console.log("capture matches getEntry OK");
}

async function testParentIdAndPath(baseDir: string) {
  console.log("\n=== parentId and path ===");
  const dir = path.join(baseDir, "ancestry");
  const store = new OrgStore(dir);
  await store.init();

  // Top-level, nested (3 levels), and sibling headings via store.capture + store.getEntry
  const projA = await store.capture({ headline: "Project A" });
  assert(projA.parentId === null, "top-level entry has parentId null");
  deepStrictEqual(projA.path, []);

  const taskA1 = await store.capture({
    headline: "Task A1",
    todo: "TODO",
    parentId: projA.id!,
  });
  assert(taskA1.parentId === projA.id, "level-2 child has parentId === projA.id");
  deepStrictEqual(taskA1.path, [{ id: projA.id, headline: "Project A" }]);

  const subA1a = await store.capture({
    headline: "Subtask A1a",
    todo: "NEXT",
    parentId: taskA1.id!,
  });
  assert(subA1a.parentId === taskA1.id, "level-3 grandchild has parentId === taskA1.id");
  deepStrictEqual(subA1a.path, [
    { id: projA.id, headline: "Project A" },
    { id: taskA1.id, headline: "Task A1" },
  ]);

  const subA1b = await store.capture({
    headline: "Subtask A1b",
    todo: "TODO",
    parentId: taskA1.id!,
  });
  assert(subA1b.parentId === taskA1.id, "level-3 sibling shares parentId");
  deepStrictEqual(subA1b.path, [
    { id: projA.id, headline: "Project A" },
    { id: taskA1.id, headline: "Task A1" },
  ]);

  const taskA2 = await store.capture({
    headline: "Task A2",
    todo: "TODO",
    parentId: projA.id!,
  });
  assert(taskA2.parentId === projA.id, "level-2 sibling after level-3 subtree has parentId === projA.id");
  deepStrictEqual(taskA2.path, [{ id: projA.id, headline: "Project A" }]);

  const projB = await store.capture({ headline: "Project B" });
  assert(projB.parentId === null, "second top-level heading has parentId null");
  deepStrictEqual(projB.path, []);

  // Verify cleanEntry via getEntry and listTodos exposes the same parentId and path
  for (const entry of [projA, taskA1, subA1a, subA1b, taskA2, projB]) {
    const fetched = (await store.getEntry(entry.id!))!;
    assert(fetched.parentId === entry.parentId, `getEntry preserves parentId for ${entry.headline}`);
    deepStrictEqual(fetched.path, entry.path);
  }
  const todos = await store.listTodos();
  const fetchedSub = todos.find((t) => t.id === subA1a.id)!;
  assert(fetchedSub.parentId === taskA1.id, "listTodos exposes parentId");
  deepStrictEqual(fetchedSub.path, subA1a.path);

  // Refile updates parentId and path on both moved entry and its descendants
  const movedTaskA1 = await store.refile(taskA1.id!, { parentId: projB.id! });
  assert(movedTaskA1.parentId === projB.id, "refile updates parentId");
  deepStrictEqual(movedTaskA1.path, [{ id: projB.id, headline: "Project B" }]);
  const movedSubA1a = (await store.getEntry(subA1a.id!))!;
  assert(movedSubA1a.parentId === taskA1.id, "refiled descendant keeps immediate parentId");
  deepStrictEqual(movedSubA1a.path, [
    { id: projB.id, headline: "Project B" },
    { id: taskA1.id, headline: "Task A1" },
  ]);

  // Direct parseOrgFile test: skipped levels and entries without :ID:
  const raw = [
    "* Root",
    "  :PROPERTIES:",
    "  :ID: root-1",
    "  :END:",
    "*** Skipped Deep",
    "  :PROPERTIES:",
    "  :ID: deep-1",
    "  :END:",
    "** Mid Sibling",
    "  :PROPERTIES:",
    "  :ID: mid-1",
    "  :END:",
    "* Second Root",
    "** Child of IDless Root",
    "",
  ].join("\n");
  const parsed = parseOrgFile(raw, "test.org");
  assert(parsed.length === 5, `expected 5 parsed entries, got ${parsed.length}`);

  assert(parsed[0].parentId === null, "Root has parentId null");
  deepStrictEqual(parsed[0].path, []);

  assert(parsed[1].parentId === "root-1", "Skipped Deep attaches to Root");
  deepStrictEqual(parsed[1].path, [{ id: "root-1", headline: "Root" }]);

  assert(parsed[2].parentId === "root-1", "Mid Sibling pops Skipped Deep and attaches to Root");
  deepStrictEqual(parsed[2].path, [{ id: "root-1", headline: "Root" }]);

  assert(parsed[3].parentId === null, "Second Root has parentId null");
  deepStrictEqual(parsed[3].path, []);

  assert(parsed[4].parentId === null, "Child of ID-less Root has parentId null before ensureIds");
  deepStrictEqual(parsed[4].path, [{ id: null, headline: "Second Root" }]);

  console.log("parentId and path OK");
}

async function testDuplicateIdDetection(baseDir: string) {
  console.log("\n=== duplicate-id detection ===");
  const dir = path.join(baseDir, "dup-id");
  const store = new OrgStore(dir);
  await store.init();

  const task = await store.capture({
    headline: "Task to refile",
    todo: "TODO",
    body: "original body",
  });
  const id = task.id!;

  // Simulate a cross-file refile interrupted between writing the destination and removing the source.
  const origWriteLines = (store as any).writeLines.bind(store);
  let writes = 0;
  (store as any).writeLines = async (filename: string, lines: string[]) => {
    writes++;
    if (writes === 2) {
      throw new Error("Simulated crash between destination write and source write");
    }
    return origWriteLines(filename, lines);
  };

  let refileThrew = false;
  try {
    await store.refile(id, { file: "dest.org" });
  } catch {
    refileThrew = true;
  } finally {
    (store as any).writeLines = origWriteLines;
  }
  assert(refileThrew, "simulated interrupted refile threw");

  // Both dest.org and inbox.org now contain the same ID; getEntry must refuse to proceed.
  let getErr: unknown = null;
  try {
    await store.getEntry(id);
  } catch (err) {
    getErr = err;
  }
  assert(getErr instanceof OrgError, `getEntry must throw OrgError on duplicate ID, got ${getErr}`);
  assert(
    getErr.message.includes("dest.org:1") && getErr.message.includes("inbox.org:1"),
    `getEntry error must list both files and lines, got: ${getErr.message}`
  );

  // Updates must also refuse to proceed and leave files untouched.
  const inboxBefore = await store.readFile("inbox.org");
  const destBefore = await store.readFile("dest.org");

  let updateErr: unknown = null;
  try {
    await store.updateState(id, "DONE");
  } catch (err) {
    updateErr = err;
  }
  assert(updateErr instanceof OrgError, `updateState must throw OrgError on duplicate ID, got ${updateErr}`);
  assert(
    updateErr.message.includes("dest.org:1") && updateErr.message.includes("inbox.org:1"),
    `updateState error must list both files and lines, got: ${updateErr.message}`
  );

  let editErr: unknown = null;
  try {
    await store.editEntry(id, { headline: "Should not apply" });
  } catch (err) {
    editErr = err;
  }
  assert(editErr instanceof OrgError, `editEntry must throw OrgError on duplicate ID, got ${editErr}`);

  assert((await store.readFile("inbox.org")) === inboxBefore, "inbox.org unchanged after refused updates");
  assert((await store.readFile("dest.org")) === destBefore, "dest.org unchanged after refused updates");

  // Also test duplicate IDs within the same file (e.g. subtree copied in an editor).
  const sameFileId = "11111111-2222-3333-4444-555555555555";
  const copied = [
    "* TODO First copy",
    "  :PROPERTIES:",
    `  :ID: ${sameFileId}`,
    "  :END:",
    "",
    "* TODO Second copy",
    "  :PROPERTIES:",
    `  :ID: ${sameFileId}`,
    "  :END:",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "copied.org"), copied, "utf8");

  let sameFileErr: unknown = null;
  try {
    await store.getEntry(sameFileId);
  } catch (err) {
    sameFileErr = err;
  }
  assert(sameFileErr instanceof OrgError, "same-file duplicate ID must throw OrgError");
  assert(
    sameFileErr.message.includes("copied.org:1") && sameFileErr.message.includes("copied.org:6"),
    `same-file duplicate error must list both lines, got: ${sameFileErr.message}`
  );

  // Also test an interrupted archiveEntry (writes *_archive.org, fails before removing from source).
  const archiveDir = path.join(baseDir, "dup-id-archive");
  const archiveStore = new OrgStore(archiveDir);
  await archiveStore.init();

  const archTask = await archiveStore.capture({
    headline: "Task to archive",
    todo: "TODO",
    body: "archive body",
  });
  const archId = archTask.id!;

  const origArchiveWriteLines = (archiveStore as any).writeLines.bind(archiveStore);
  let archiveWrites = 0;
  (archiveStore as any).writeLines = async (filename: string, lines: string[]) => {
    archiveWrites++;
    if (archiveWrites === 2) {
      throw new Error("Simulated crash between archive write and source write");
    }
    return origArchiveWriteLines(filename, lines);
  };

  let archiveThrew = false;
  try {
    await archiveStore.archiveEntry(archId);
  } catch {
    archiveThrew = true;
  } finally {
    (archiveStore as any).writeLines = origArchiveWriteLines;
  }
  assert(archiveThrew, "simulated interrupted archiveEntry threw");

  const archInboxBefore = await archiveStore.readFile("inbox.org");
  const archFileBefore = await archiveStore.readFile("inbox_archive.org");

  let archUpdateErr: unknown = null;
  try {
    await archiveStore.updateState(archId, "DONE");
  } catch (err) {
    archUpdateErr = err;
  }
  assert(archUpdateErr instanceof OrgError, `updateState must throw OrgError on archive duplicate ID, got ${archUpdateErr}`);
  assert(
    archUpdateErr.message.includes("inbox.org:1") && archUpdateErr.message.includes("inbox_archive.org:1"),
    `updateState error must list inbox.org:1 and inbox_archive.org:1, got: ${archUpdateErr.message}`
  );

  let reArchiveErr: unknown = null;
  try {
    await archiveStore.archiveEntry(archId);
  } catch (err) {
    reArchiveErr = err;
  }
  assert(reArchiveErr instanceof OrgError, `second archiveEntry must throw OrgError on duplicate ID, got ${reArchiveErr}`);
  assert(
    reArchiveErr.message.includes("inbox.org:1") && reArchiveErr.message.includes("inbox_archive.org:1"),
    `second archiveEntry error must list inbox.org:1 and inbox_archive.org:1, got: ${reArchiveErr.message}`
  );

  assert((await archiveStore.readFile("inbox.org")) === archInboxBefore, "inbox.org unchanged after refused archive duplicate ops");
  assert((await archiveStore.readFile("inbox_archive.org")) === archFileBefore, "inbox_archive.org unchanged after refused archive duplicate ops");

  console.log("duplicate-id detection OK");
}

async function testOutline(baseDir: string) {
  console.log("\n=== outline ===");
  const dir = path.join(baseDir, "outline");
  const store = new OrgStore(dir);
  await store.init();

  // Empty store returns empty outline
  deepStrictEqual(await store.outline(), []);

  // Set up inbox.org with projects (untagged level-1 headings) and nested tasks
  const projA = await store.capture({ headline: "Project Alpha" });
  const taskA1 = await store.capture({
    headline: "Design API",
    todo: "TODO",
    tags: ["backend"],
    parentId: projA.id!,
  });
  const subA1a = await store.capture({
    headline: "Write schema",
    todo: "TODO",
    parentId: taskA1.id!,
  });
  await store.updateState(subA1a.id!, "DONE");
  const subA1b = await store.capture({
    headline: "Review PR",
    todo: "NEXT",
    parentId: taskA1.id!,
  });
  const noteA1c = await store.capture({
    headline: "Design notes",
    parentId: taskA1.id!,
  });
  const taskA2 = await store.capture({
    headline: "Deploy service",
    todo: "WAITING",
    parentId: projA.id!,
  });

  const projB = await store.capture({ headline: "Project Beta" });
  const taskB1 = await store.capture({
    headline: "Kickoff",
    todo: "TODO",
    parentId: projB.id!,
  });

  // Second file: notes.org
  const note1 = await store.capture({
    file: "notes.org",
    headline: "Architecture",
    tags: ["ref"],
  });
  await store.capture({
    headline: "Follow up",
    todo: "TODO",
    parentId: note1.id!,
  });

  // Archived entry should be excluded from default outline
  const toArchive = await store.capture({ headline: "Old project", todo: "TODO" });
  await store.updateState(toArchive.id!, "DONE");
  await store.archiveEntry(toArchive.id!);

  // 1. Default outline across all non-archive files
  const all = await store.outline();
  assert(all.length === 3, `expected 3 top-level nodes across inbox.org and notes.org, got ${all.length}`);
  assert(all[0].file === "inbox.org" && all[0].headline === "Project Alpha", "first node is Project Alpha");
  assert(all[1].file === "inbox.org" && all[1].headline === "Project Beta", "second node is Project Beta");
  assert(all[2].file === "notes.org" && all[2].headline === "Architecture", "third node is Architecture");

  // Verify exact node shape (no body or internal line offsets)
  deepStrictEqual(Object.keys(all[0]).sort(), [
    "children",
    "descendantCounts",
    "file",
    "headline",
    "id",
    "level",
    "tags",
    "todo",
  ]);

  // Verify full tree & descendantCounts on Project Alpha (noteA1c has todo: null so not counted)
  deepStrictEqual(all[0].descendantCounts, {
    TODO: 1,
    DONE: 1,
    NEXT: 1,
    WAITING: 1,
  });
  assert(all[0].children.length === 2, "Project Alpha has 2 direct children");
  assert(all[0].children[0].id === taskA1.id, "first child is Design API");
  deepStrictEqual(all[0].children[0].tags, ["backend"]);
  deepStrictEqual(all[0].children[0].descendantCounts, { DONE: 1, NEXT: 1 });
  assert(all[0].children[0].children.length === 3, "Design API has 3 grandchildren");
  assert(all[0].children[0].children[0].id === subA1a.id, "grandchild 1");
  assert(all[0].children[0].children[1].id === subA1b.id, "grandchild 2");
  assert(all[0].children[0].children[2].id === noteA1c.id, "grandchild 3 (plain note)");
  deepStrictEqual(all[0].children[0].children[0].descendantCounts, {});

  // 2. {file: "inbox.org", level: 1, maxDepth: 1} convention
  const projects = await store.outline({ file: "inbox.org", level: 1, maxDepth: 1 });
  assert(projects.length === 2, `expected 2 level-1 projects in inbox.org, got ${projects.length}`);
  assert(projects[0].headline === "Project Alpha", "Project Alpha listed");
  assert(projects[0].children.length === 2, "maxDepth: 1 includes direct children");
  assert(projects[0].children[0].id === taskA1.id, "direct child Design API present");
  deepStrictEqual(projects[0].children[0].children, []);
  // descendantCounts still reflects the full subtree despite maxDepth: 1
  deepStrictEqual(projects[0].descendantCounts, {
    TODO: 1,
    DONE: 1,
    NEXT: 1,
    WAITING: 1,
  });
  deepStrictEqual(projects[0].children[0].descendantCounts, { DONE: 1, NEXT: 1 });
  assert(projects[1].children[0].id === taskB1.id, "Project Beta direct child present");

  // 3. maxDepth: 0
  const topOnly = await store.outline({ file: "inbox", maxDepth: 0 });
  assert(topOnly.length === 2, "file without .org extension resolves");
  deepStrictEqual(topOnly[0].children, []);
  deepStrictEqual(topOnly[0].descendantCounts, {
    TODO: 1,
    DONE: 1,
    NEXT: 1,
    WAITING: 1,
  });

  // 4. rootId filtering
  const byRoot = await store.outline({ rootId: taskA1.id!, maxDepth: 1 });
  assert(byRoot.length === 1, "rootId returns single-element array");
  assert(byRoot[0].id === taskA1.id, "rootId node matches");
  assert(byRoot[0].level === 2, "rootId node preserves its actual level");
  assert(byRoot[0].children.length === 3, "rootId includes its children up to maxDepth");
  deepStrictEqual(byRoot[0].descendantCounts, { DONE: 1, NEXT: 1 });

  // rootId + level
  const subAtLevel3 = await store.outline({ rootId: projA.id!, level: 3 });
  assert(subAtLevel3.length === 3, "rootId + level: 3 returns the 3 level-3 descendants");
  assert(subAtLevel3[0].id === subA1a.id, "first level-3 node");

  // level without rootId
  const allLevel2 = await store.outline({ file: "inbox.org", level: 2, maxDepth: 0 });
  assert(allLevel2.length === 3, "level: 2 in inbox.org returns all 3 level-2 headings");
  assert(allLevel2[1].id === taskA2.id, "second level-2 heading is Deploy service (taskA2)");

  // 5. Hand-written file with skipped levels and no IDs
  const handWritten = [
    "* Hand Root",
    "*** TODO Skipped Deep",
    "** NEXT Mid Sibling",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "hand.org"), handWritten, "utf8");
  const handOutline = await store.outline({ file: "hand.org" });
  assert(handOutline.length === 1, "hand.org has 1 root");
  assert(
    handOutline[0].id !== null && handOutline[0].id.startsWith("tmp:hand.org:1:"),
    "outline returns temporary handle for ID-less heading"
  );
  assert(
    (await fs.readFile(path.join(dir, "hand.org"), "utf8")) === handWritten,
    "outline does not modify hand.org on disk"
  );
  assert(handOutline[0].children.length === 2, "both skipped-level and mid-level attach to root");
  assert(handOutline[0].children[0].level === 3 && handOutline[0].children[0].id !== null, "skipped-level child");
  assert(handOutline[0].children[1].level === 2 && handOutline[0].children[1].id !== null, "mid-level sibling");
  deepStrictEqual(handOutline[0].descendantCounts, { TODO: 1, NEXT: 1 });

  // Archived entry is reachable by rootId (matching org_get_entry)
  const archivedOutline = await store.outline({ rootId: toArchive.id! });
  assert(
    archivedOutline.length === 1 &&
      archivedOutline[0].id === toArchive.id &&
      archivedOutline[0].file === "inbox_archive.org",
    "rootId resolves archived entries"
  );

  // 6. Error cases
  for (const [label, fn] of [
    ["missing file", () => store.outline({ file: "nope.org" })],
    ["missing rootId", () => store.outline({ rootId: "does-not-exist" })],
    ["rootId in wrong file", () => store.outline({ file: "notes.org", rootId: projA.id! })],
    ["invalid level 0", () => store.outline({ level: 0 })],
    ["invalid maxDepth -1", () => store.outline({ maxDepth: -1 })],
  ] as const) {
    let threw = false;
    try {
      await fn();
    } catch (err) {
      threw = err instanceof OrgError;
    }
    assert(threw, `expected OrgError for ${label}`);
  }

  // 7. Duplicate ID within one file throws OrgError for both rootId and file+rootId
  const dupContent = [
    "* TODO First",
    ":PROPERTIES:",
    ":ID: dup-outline-id",
    ":END:",
    "",
    "* TODO Second",
    ":PROPERTIES:",
    ":ID: dup-outline-id",
    ":END:",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "dup.org"), dupContent, "utf8");
  for (const [label, params] of [
    ["rootId alone on duplicate", { rootId: "dup-outline-id" }],
    ["file+rootId on duplicate", { file: "dup.org", rootId: "dup-outline-id" }],
  ] as const) {
    let threw = false;
    try {
      await store.outline(params);
    } catch (err) {
      threw = err instanceof OrgError && err.message.includes("Duplicate id");
    }
    assert(threw, `expected duplicate-id OrgError for ${label}`);
  }

  console.log("outline OK");
}

async function testConsistentFilters(baseDir: string) {
  console.log("\n=== consistent filters (listTodos & search) ===");
  const dir = path.join(baseDir, "consistent-filters");
  const store = new OrgStore(dir);
  await store.init();

  // Build a multi-file, multi-level hierarchy where every entry shares "alpha" in its
  // headline/body so `search("alpha", filter)` and `listTodos(filter)` test the exact same
  // filter semantics side by side.
  const projA = await store.capture({
    file: "inbox.org",
    headline: "alpha Project A",
    todo: "TODO",
    priority: "A",
    tags: ["work"],
  });
  const childA1 = await store.capture({
    headline: "alpha Child A1",
    todo: "NEXT",
    priority: "B",
    tags: ["work", "urgent"],
    parentId: projA.id!,
  });
  const grandA1a = await store.capture({
    headline: "alpha Grandchild A1a",
    todo: "TODO",
    priority: "A",
    tags: ["work"],
    parentId: childA1.id!,
  });
  const grandA1bDone = await store.capture({
    headline: "alpha Grandchild A1b done",
    todo: "TODO",
    priority: "A",
    tags: ["work"],
    parentId: childA1.id!,
  });
  await store.updateState(grandA1bDone.id!, "DONE");

  const plainNoteUnderA = await store.capture({
    headline: "alpha Note under A",
    tags: ["work"],
    parentId: projA.id!,
  });

  const projB = await store.capture({
    file: "projects.org",
    headline: "alpha Project B",
    todo: "TODO",
    priority: "A",
    tags: ["work"],
  });
  const childB1 = await store.capture({
    headline: "alpha Child B1",
    todo: "NEXT",
    priority: "C",
    tags: ["home"],
    parentId: projB.id!,
  });

  const ids = (entries: { id: string | null }[]) => entries.map((e) => e.id).sort();

  const cases: Array<{
    name: string;
    filter: EntryFilter;
    expectedTodos: string[];
    expectedSearch: string[];
  }> = [
    {
      name: "state=DONE",
      filter: { state: "DONE" },
      expectedTodos: [grandA1bDone.id!],
      expectedSearch: [grandA1bDone.id!],
    },
    {
      name: "state=NEXT",
      filter: { state: "NEXT" },
      expectedTodos: [childA1.id!, childB1.id!],
      expectedSearch: [childA1.id!, childB1.id!],
    },
    {
      name: "tag=urgent",
      filter: { tag: "urgent" },
      expectedTodos: [childA1.id!],
      expectedSearch: [childA1.id!],
    },
    {
      name: "priority=A",
      filter: { priority: "A" },
      // listTodos defaults to open keywords (excludes DONE); search does not restrict state unless asked
      expectedTodos: [projA.id!, grandA1a.id!, projB.id!],
      expectedSearch: [projA.id!, grandA1a.id!, grandA1bDone.id!, projB.id!],
    },
    {
      name: "file=projects.org",
      filter: { file: "projects.org" },
      expectedTodos: [projB.id!, childB1.id!],
      expectedSearch: [projB.id!, childB1.id!],
    },
    {
      name: "file=projects (without .org suffix)",
      filter: { file: "projects" },
      expectedTodos: [projB.id!, childB1.id!],
      expectedSearch: [projB.id!, childB1.id!],
    },
    {
      name: "parentId=projA (includes all descendants, excludes parent itself)",
      filter: { parentId: projA.id! },
      // open todos under projA: childA1, grandA1a (excludes grandA1bDone because DONE, plainNoteUnderA because no todo, projA itself)
      expectedTodos: [childA1.id!, grandA1a.id!],
      // search under projA: all descendants matching "alpha", including DONE and plain notes, excluding projA itself
      expectedSearch: [childA1.id!, grandA1a.id!, grandA1bDone.id!, plainNoteUnderA.id!],
    },
    {
      name: "parentId=projA + state=DONE",
      filter: { parentId: projA.id!, state: "DONE" },
      expectedTodos: [grandA1bDone.id!],
      expectedSearch: [grandA1bDone.id!],
    },
    {
      name: "combined state+tag+priority+file+parentId",
      filter: {
        state: "TODO",
        tag: "work",
        priority: "A",
        file: "inbox.org",
        parentId: projA.id!,
      },
      expectedTodos: [grandA1a.id!],
      expectedSearch: [grandA1a.id!],
    },
  ];

  for (const tc of cases) {
    const gotTodos = ids(await store.listTodos(tc.filter));
    const gotSearch = ids(await store.search("alpha", tc.filter));
    deepStrictEqual(gotTodos, [...tc.expectedTodos].sort(), `listTodos(${tc.name})`);
    deepStrictEqual(gotSearch, [...tc.expectedSearch].sort(), `search(${tc.name})`);
  }

  // Verify shared filterEntries handles an ID-less intermediate ancestor by walking path ids
  const raw = [
    "* Root",
    "  :PROPERTIES:",
    "  :ID: root-id",
    "  :END:",
    "** ID-less Intermediate",
    "*** TODO Deep Leaf",
    "  :PROPERTIES:",
    "  :ID: leaf-id",
    "  :END:",
    "",
  ].join("\n");
  const parsed = parseOrgFile(raw, "manual.org");
  const descendants = filterEntries(parsed, { parentId: "root-id" });
  deepStrictEqual(
    descendants.map((e) => e.headline),
    ["ID-less Intermediate", "Deep Leaf"],
    "filterEntries walks path ids even across an ID-less intermediate heading"
  );

  console.log("consistent filters OK");
}

async function testExternalChangeDetection(baseDir: string) {
  console.log("\n=== external-change detection ===");
  const dir = path.join(baseDir, "external-change");

  class HookedStore extends OrgStore {
    onBeforeWriteCheck?: (filename: string) => Promise<void> | void;
    protected override async beforeWriteCheck(filename: string): Promise<void> {
      await this.onBeforeWriteCheck?.(filename);
    }
  }

  const store = new HookedStore(dir);
  await store.init();

  const task = await store.capture({
    file: "inbox.org",
    headline: "Server task",
    todo: "TODO",
    body: "initial body",
  });

  // 1. Single external edit between read and write: retries once and preserves both edits.
  let checks = 0;
  store.onBeforeWriteCheck = async (filename) => {
    if (filename === "inbox.org" && checks === 0) {
      checks++;
      const p = path.join(dir, "inbox.org");
      const cur = await fs.readFile(p, "utf8");
      await fs.writeFile(p, cur + "\n* TODO Editor task\n", "utf8");
    }
  };

  const updated = await store.updateState(task.id!, "DONE");
  store.onBeforeWriteCheck = undefined;
  assert(updated.todo === "DONE", "server update succeeded after retry");
  const afterSingleConflict = await fs.readFile(path.join(dir, "inbox.org"), "utf8");
  assert(
    afterSingleConflict.includes("* DONE Server task"),
    "server mutation applied on re-read"
  );
  assert(
    afterSingleConflict.includes("* TODO Editor task"),
    "editor save between read and write was not lost"
  );

  // 2. External edit on both attempts: throws OrgError and preserves the editor's latest save.
  let editNum = 0;
  store.onBeforeWriteCheck = async (filename) => {
    if (filename === "inbox.org") {
      editNum++;
      const p = path.join(dir, "inbox.org");
      const cur = await fs.readFile(p, "utf8");
      await fs.writeFile(p, cur + `\n* TODO Editor save ${editNum}\n`, "utf8");
    }
  };

  let conflictErr: unknown = null;
  try {
    await store.editEntry(task.id!, { headline: "Should fail instead of overwriting" });
  } catch (err) {
    conflictErr = err;
  } finally {
    store.onBeforeWriteCheck = undefined;
  }
  assert(
    conflictErr instanceof OrgError,
    `expected OrgError on repeated external edit, got ${conflictErr}`
  );
  const afterDoubleConflict = await fs.readFile(path.join(dir, "inbox.org"), "utf8");
  assert(
    afterDoubleConflict.includes("* TODO Editor save 2"),
    "editor's second save is preserved on disk"
  );
  assert(
    !afterDoubleConflict.includes("Should fail instead of overwriting"),
    "server mutation did not overwrite editor's save"
  );

  // 3. Cross-file refile with external edit on destination file: retries once and preserves both.
  await store.capture({
    file: "dest.org",
    headline: "Existing dest task",
    todo: "TODO",
  });
  let refileChecks = 0;
  store.onBeforeWriteCheck = async (filename) => {
    if (filename === "dest.org" && refileChecks === 0) {
      refileChecks++;
      const p = path.join(dir, "dest.org");
      const cur = await fs.readFile(p, "utf8");
      await fs.writeFile(p, cur + "\n* TODO Editor dest addition\n", "utf8");
    }
  };
  await store.refile(task.id!, { file: "dest.org" });
  store.onBeforeWriteCheck = undefined;
  const destAfterRefile = await fs.readFile(path.join(dir, "dest.org"), "utf8");
  assert(
    destAfterRefile.includes("* DONE Server task") &&
      destAfterRefile.includes("* TODO Editor dest addition"),
    "cross-file refile preserves editor save on destination file"
  );
  const inboxAfterRefile = await fs.readFile(path.join(dir, "inbox.org"), "utf8");
  assert(
    !inboxAfterRefile.includes("Server task"),
    "cross-file refile removes entry from source file"
  );

  // 4. Regression test for late-window race: external edit injected via beforeRename (after
  //    temp write, fsync, and .bak copy, immediately before rename) triggers retry and survives.
  let lateFired = false;
  const lateStore = new OrgStore(dir, {
    beforeRename: async (_tmpPath, targetPath) => {
      if (!lateFired && path.basename(targetPath) === "dest.org") {
        lateFired = true;
        const cur = await fs.readFile(targetPath, "utf8");
        await fs.writeFile(targetPath, cur + "\n* TODO Late beforeRename edit\n", "utf8");
      }
    },
  });
  const lateUpdated = await lateStore.updateState(task.id!, "NEXT");
  assert(lateFired, "beforeRename hook fired");
  assert(lateUpdated.todo === "NEXT", "server update succeeded after beforeRename retry");
  const destAfterLate = await fs.readFile(path.join(dir, "dest.org"), "utf8");
  assert(
    destAfterLate.includes("* NEXT Server task") &&
      destAfterLate.includes("* TODO Late beforeRename edit"),
    "late editor save during beforeRename survived in target file"
  );
  const bakAfterLate = await fs.readFile(path.join(dir, "dest.org.bak"), "utf8");
  assert(
    bakAfterLate.includes("* TODO Late beforeRename edit"),
    ".bak holds the verified content from the retry"
  );
  const leftoverTmp = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
  assert(leftoverTmp.length === 0, `no leftover .tmp files, found ${JSON.stringify(leftoverTmp)}`);

  // 5. Cross-file refile where second write (source) fails due to late external edit:
  //    throws OrgError mentioning both files and preserves the editor's save in source.
  const splitDir = path.join(baseDir, "external-change-split");
  let splitArmed = false;
  const splitStore = new OrgStore(splitDir, {
    beforeRename: async (_tmpPath, targetPath) => {
      if (splitArmed && path.basename(targetPath) === "inbox.org") {
        splitArmed = false;
        const cur = await fs.readFile(targetPath, "utf8");
        await fs.writeFile(targetPath, cur + "\n* TODO Editor save on source\n", "utf8");
      }
    },
  });
  await splitStore.init();
  const splitTask = await splitStore.capture({
    file: "inbox.org",
    headline: "Split task",
    todo: "TODO",
  });
  splitArmed = true;
  let splitErr: unknown = null;
  try {
    await splitStore.refile(splitTask.id!, { file: "other.org" });
  } catch (err) {
    splitErr = err;
  }
  assert(splitErr instanceof OrgError, `expected OrgError on second-write conflict, got ${splitErr}`);
  assert(
    splitErr.message.includes("other.org") && splitErr.message.includes("inbox.org"),
    `second-write conflict error must mention both files, got: ${splitErr.message}`
  );
  const splitInbox = await fs.readFile(path.join(splitDir, "inbox.org"), "utf8");
  assert(
    splitInbox.includes("* TODO Editor save on source"),
    "editor save on source file survived failed second write"
  );

  console.log("external-change detection OK");
}

async function testReadOnlyAndTempHandles(baseDir: string) {
  console.log("\n=== read-only mtime & temporary handles ===");
  const dir = path.join(baseDir, "readonly-tmp");
  const store = new OrgStore(dir);
  await store.init();

  const manualPath = path.join(dir, "manual.org");
  const initialContent = [
    "* Project Alpha  :work:",
    "** TODO Task One",
    "  SCHEDULED: <2026-08-20 Thu>",
    "  :PROPERTIES:",
    "  :EFFORT: 1h",
    "  :END:",
    "** NEXT Task Two",
    "* TODO Top Task",
    "",
  ].join("\n");
  await fs.writeFile(manualPath, initialContent, "utf8");

  // Backdate mtime by 60s so any unintended write is unambiguously visible.
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(manualPath, past, past);
  const mtimeBefore = (await fs.stat(manualPath)).mtimeMs;

  // Exercise every read-only operation.
  const todos = await store.listTodos();
  assert(todos.length === 3, `expected 3 todos, got ${todos.length}`);
  const taskOne = todos.find((t) => t.headline === "Task One")!;
  const taskTwo = todos.find((t) => t.headline === "Task Two")!;
  const topTask = todos.find((t) => t.headline === "Top Task")!;
  assert(taskOne.id !== null && taskOne.id.startsWith("tmp:manual.org:2:"), `unexpected tmp id: ${taskOne.id}`);
  assert(taskOne.parentId !== null && taskOne.parentId.startsWith("tmp:manual.org:1:"), "child has parent's tmp handle");
  assert(taskOne.path.length === 1 && taskOne.path[0].id === taskOne.parentId, "path carries parent's tmp handle");

  const searched = await store.search("Task");
  assert(searched.length === 3, "search finds all 3 tasks");

  const agendaItems = await store.agenda("2026-08-20", "2026-08-20");
  assert(agendaItems.length === 1 && agendaItems[0].entry.id === taskOne.id, "agenda returns tmp handle");

  const tags = await store.listTags();
  assert(tags.length === 1 && tags[0].tag === "work", "listTags works on ID-less entries");

  const out = await store.outline({ file: "manual.org" });
  assert(out.length === 2 && out[0].id === taskOne.parentId, "outline returns tmp handles");

  const fetched = await store.getEntry(taskOne.id!);
  assert(fetched !== null && fetched.headline === "Task One", "getEntry resolves tmp handle");

  const subOut = await store.outline({ rootId: taskOne.parentId! });
  assert(subOut.length === 1 && subOut[0].children.length === 2, "outline(rootId) resolves tmp handle");

  // Verify mtime, content, and absence of .bak after all read-only calls.
  const mtimeAfter = (await fs.stat(manualPath)).mtimeMs;
  assert(mtimeAfter === mtimeBefore, `read-only calls must not change mtime (${mtimeBefore} vs ${mtimeAfter})`);
  assert((await fs.readFile(manualPath, "utf8")) === initialContent, "read-only calls must not alter file content");
  let bakExists = true;
  try {
    await fs.access(`${manualPath}.bak`);
  } catch {
    bakExists = false;
  }
  assert(!bakExists, "read-only calls must not create .bak");

  // 1. Mutating via tmp handle with existing :PROPERTIES: inserts :ID: into that drawer (no duplicate drawer).
  const doneOne = await store.updateState(taskOne.id!, "DONE");
  assert(doneOne.id !== null && !doneOne.id.startsWith("tmp:"), "updateState materialized permanent ID");
  assert(doneOne.properties.EFFORT === "1h", "existing properties preserved");
  assert(doneOne.todo === "DONE", "mutation applied");
  const afterOne = await fs.readFile(manualPath, "utf8");
  assert(
    (afterOne.match(/:PROPERTIES:/g) ?? []).length === 1,
    "existing :PROPERTIES: drawer was reused rather than duplicated"
  );

  // 2. Stale tmp handle (line shifted or headline edited) must fail without modifying the file.
  let staleErr: unknown = null;
  try {
    await store.editEntry(topTask.id!, { headline: "Should fail" });
  } catch (err) {
    staleErr = err;
  }
  assert(
    staleErr instanceof OrgError && staleErr.message.includes("stale"),
    `expected stale OrgError when line shifted, got ${staleErr}`
  );
  assert(!afterOne.includes("Should fail"), "stale handle mutation did not touch file");

  // Also test stale handle when headline text at the same line was edited externally.
  const freshTop = (await store.listTodos()).find((t) => t.headline === "Top Task")!;
  await fs.writeFile(
    manualPath,
    (await fs.readFile(manualPath, "utf8")).replace("* TODO Top Task", "* TODO Top Task Edited"),
    "utf8"
  );
  let editedErr: unknown = null;
  try {
    await store.setTags(freshTop.id!, ["urgent"]);
  } catch (err) {
    editedErr = err;
  }
  assert(
    editedErr instanceof OrgError && editedErr.message.includes("stale"),
    `expected stale OrgError when headline edited, got ${editedErr}`
  );
  assert(!(await fs.readFile(manualPath, "utf8")).includes(":urgent:"), "edited-headline stale handle did not mutate");

  // 3. Other mutations via tmp handles: editEntry, addNote, setTags, capture(parentId), refile(both tmp), archiveEntry.
  const refreshedTodos = await store.listTodos();
  const curTwo = refreshedTodos.find((t) => t.headline === "Task Two")!;
  const curTopEdited = refreshedTodos.find((t) => t.headline === "Top Task Edited")!;

  const notedTwo = await store.addNote(curTwo.id!, "First note");
  assert(notedTwo.id !== null && !notedTwo.id.startsWith("tmp:"), "addNote materialized permanent ID");
  assert(notedTwo.body.includes("First note"), "addNote applied");

  const curTopEdited2 = (await store.listTodos()).find((t) => t.headline === "Top Task Edited")!;
  const taggedTop = await store.setTags(curTopEdited2.id!, ["home"]);
  assert(taggedTop.id !== null && !taggedTop.id.startsWith("tmp:"), "setTags materialized permanent ID");
  assert(taggedTop.tags.includes("home"), "setTags applied");

  // capture with tmp parentId
  const curOutline = await store.outline({ file: "manual.org" });
  const projAlphaNode = curOutline.find((n) => n.headline === "Project Alpha")!;
  assert(projAlphaNode.id!.startsWith("tmp:"), "Project Alpha still has tmp handle");
  const newChild = await store.capture({
    headline: "Captured under tmp parent",
    todo: "TODO",
    parentId: projAlphaNode.id!,
  });
  assert(newChild.parentId !== null && !newChild.parentId.startsWith("tmp:"), "parent materialized on capture");

  // refile when BOTH id and parentId are tmp handles in the same file (child above parent)
  const refileDir = path.join(baseDir, "refile-both-tmp");
  const refileStore = new OrgStore(refileDir);
  await refileStore.init();
  await fs.writeFile(
    path.join(refileDir, "inbox.org"),
    ["* TODO Upper Task", "* Lower Project", ""].join("\n"),
    "utf8"
  );
  const upper = (await refileStore.listTodos()).find((t) => t.headline === "Upper Task")!;
  const lower = (await refileStore.outline({ file: "inbox.org" })).find((n) => n.headline === "Lower Project")!;
  const refiled = await refileStore.refile(upper.id!, { parentId: lower.id! });
  assert(refiled.level === 2, "upper task refiled under lower project");
  assert(refiled.parentId !== null && !refiled.parentId.startsWith("tmp:"), "both tmp handles materialized on refile");

  // archiveEntry via tmp handle
  await fs.writeFile(path.join(refileDir, "arch.org"), "* DONE Old tmp task\n", "utf8");
  const oldTmp = (await refileStore.outline({ file: "arch.org" }))[0];
  assert(oldTmp.id!.startsWith("tmp:"), "arch.org entry has tmp handle");
  const archived = await refileStore.archiveEntry(oldTmp.id!);
  assert(!archived.id.startsWith("tmp:"), "archiveEntry materialized permanent ID");
  assert((await refileStore.getEntry(archived.id)) !== null, "archived entry reachable by permanent ID");

  // 4. External-change protection during materializeTmpId: concurrent editor save aborts write,
  // preserves editor save, and makes the held tmp handle stale on retry.
  const raceDir = path.join(baseDir, "tmp-race");
  let raceFired = false;
  const raceStore = new OrgStore(raceDir, {
    beforeRename: async (_tmpPath, targetPath) => {
      if (!raceFired && path.basename(targetPath) === "inbox.org") {
        raceFired = true;
        const cur = await fs.readFile(targetPath, "utf8");
        await fs.writeFile(targetPath, cur + "\n* TODO Editor concurrent task\n", "utf8");
      }
    },
  });
  await raceStore.init();
  await fs.writeFile(path.join(raceDir, "inbox.org"), "* TODO Race target\n", "utf8");
  const raceTodo = (await raceStore.listTodos())[0];
  let raceErr: unknown = null;
  try {
    await raceStore.updateState(raceTodo.id!, "DONE");
  } catch (err) {
    raceErr = err;
  }
  assert(raceFired, "beforeRename fired during tmp materialization");
  assert(
    raceErr instanceof OrgError && /stale/i.test(raceErr.message),
    `expected stale OrgError after concurrent editor save, got ${raceErr}`
  );
  const raceDisk = await fs.readFile(path.join(raceDir, "inbox.org"), "utf8");
  assert(raceDisk.includes("* TODO Editor concurrent task"), "editor save survived tmp materialization abort");
  assert(!raceDisk.includes("* DONE Race target"), "stale materialization did not mutate Race target");
  assert(!raceDisk.includes(":ID:"), "stale materialization did not write :ID:");

  // 5. Regression tests for duplicate-headline line-shift collisions (P1 and P1b).
  const p1Dir = path.join(baseDir, "tmp-p1");
  const p1Store = new OrgStore(p1Dir);
  await p1Store.init();
  const p1Path = path.join(p1Dir, "inbox.org");
  await fs.writeFile(
    p1Path,
    [
      "* TODO Pay invoice",
      "  :PROPERTIES:",
      "  :ID: real-1",
      "  :END:",
      "* TODO Follow up :acme:",
      "* TODO Follow up :globex:",
      "",
    ].join("\n"),
    "utf8"
  );
  const p1Todos = await p1Store.listTodos();
  const globex = p1Todos.find((t) => t.tags.includes("globex"))!;
  assert(globex.id !== null && globex.id.startsWith("tmp:inbox.org:6:"), `expected globex at line 6, got ${globex.id}`);
  await p1Store.updateState("real-1", "DONE");
  const p1BeforeArchive = await fs.readFile(p1Path, "utf8");
  let p1Err: unknown = null;
  try {
    await p1Store.archiveEntry(globex.id!);
  } catch (err) {
    p1Err = err;
  }
  assert(
    p1Err instanceof OrgError && /stale/i.test(p1Err.message),
    `P1: expected stale OrgError, got ${p1Err}`
  );
  assert((await fs.readFile(p1Path, "utf8")) === p1BeforeArchive, "P1: file unchanged after stale archiveEntry");
  let p1ArchExists = true;
  try {
    await fs.access(path.join(p1Dir, "inbox_archive.org"));
  } catch {
    p1ArchExists = false;
  }
  assert(!p1ArchExists, "P1: archive file was not created");

  // P1b: file with only tmp handles where an earlier write shifts a twin onto the target line.
  const p1bDir = path.join(baseDir, "tmp-p1b");
  const p1bStore = new OrgStore(p1bDir);
  await p1bStore.init();
  const p1bPath = path.join(p1bDir, "inbox.org");
  await fs.writeFile(
    p1bPath,
    [
      "* TODO Alpha",
      "* TODO Call mom",
      "about dad's birthday",
      "* TODO Beta",
      "* TODO Gamma",
      "* TODO Call mom",
      "about the car",
      "",
    ].join("\n"),
    "utf8"
  );
  const p1bTodos = await p1bStore.listTodos();
  const alpha = p1bTodos.find((t) => t.headline === "Alpha")!;
  const carMom = p1bTodos.find((t) => t.headline === "Call mom" && t.body.includes("car"))!;
  assert(carMom.id !== null && carMom.id.startsWith("tmp:inbox.org:6:"), `expected carMom at line 6, got ${carMom.id}`);
  await p1bStore.updateState(alpha.id!, "DONE");
  const p1bBeforeCar = await fs.readFile(p1bPath, "utf8");
  let p1bErr: unknown = null;
  try {
    await p1bStore.updateState(carMom.id!, "DONE");
  } catch (err) {
    p1bErr = err;
  }
  assert(
    p1bErr instanceof OrgError && /stale/i.test(p1bErr.message),
    `P1b: expected stale OrgError, got ${p1bErr}`
  );
  assert((await fs.readFile(p1bPath, "utf8")) === p1bBeforeCar, "P1b: file unchanged after stale updateState");

  // 6. Failed calls (e.g., invalid dates) must not materialize an :ID:.
  const failDir = path.join(baseDir, "tmp-fail");
  const failStore = new OrgStore(failDir);
  await failStore.init();
  const failPath = path.join(failDir, "inbox.org");
  const failInitial = "* TODO Unmaterialized task\n";
  await fs.writeFile(failPath, failInitial, "utf8");
  const failTodo = (await failStore.listTodos())[0];
  assert(failTodo.id !== null && failTodo.id.startsWith("tmp:"), "expected tmp handle");
  let schedErr: unknown = null;
  try {
    await failStore.schedule(failTodo.id!, { scheduled: "not a date" });
  } catch (err) {
    schedErr = err;
  }
  assert(
    schedErr instanceof Error && /Invalid date/i.test(schedErr.message),
    `expected Invalid date error for schedule, got ${schedErr}`
  );
  assert((await fs.readFile(failPath, "utf8")) === failInitial, "invalid schedule did not write :ID:");

  let capErr: unknown = null;
  try {
    await failStore.capture({ headline: "Child", parentId: failTodo.id!, scheduled: "not a date" });
  } catch (err) {
    capErr = err;
  }
  assert(
    capErr instanceof Error && /Invalid date/i.test(capErr.message),
    `expected Invalid date error for capture, got ${capErr}`
  );
  assert((await fs.readFile(failPath, "utf8")) === failInitial, "invalid capture did not write :ID: to parent");

  // Failed refile calls (missing parent, own subtree) must not materialize an :ID:.
  let refileMissingErr: unknown = null;
  try {
    await failStore.refile(failTodo.id!, { parentId: "no-such-id" });
  } catch (err) {
    refileMissingErr = err;
  }
  assert(
    refileMissingErr instanceof OrgError && /No entry found/i.test(refileMissingErr.message),
    `expected No entry found error for refile, got ${refileMissingErr}`
  );
  assert((await fs.readFile(failPath, "utf8")) === failInitial, "refile to missing parent did not write :ID:");

  let refileSelfErr: unknown = null;
  try {
    await failStore.refile(failTodo.id!, { parentId: failTodo.id! });
  } catch (err) {
    refileSelfErr = err;
  }
  assert(
    refileSelfErr instanceof OrgError && /own subtree/i.test(refileSelfErr.message),
    `expected own subtree error for self-refile, got ${refileSelfErr}`
  );
  assert((await fs.readFile(failPath, "utf8")) === failInitial, "self-refile did not write :ID:");

  // 7. Regression tests for inserting a same-text heading at the target's old line (R2 & R3).
  // R2: capture inserts a twin heading under Project right at oldHandle's line.
  const r2Dir = path.join(baseDir, "tmp-r2");
  const r2Store = new OrgStore(r2Dir);
  await r2Store.init();
  const r2Path = path.join(r2Dir, "inbox.org");
  await fs.writeFile(
    r2Path,
    [
      "* Project",
      "  :PROPERTIES:",
      "  :ID: proj",
      "  :END:",
      "* TODO Follow up",
      "Call the bank about the mortgage",
      "",
    ].join("\n"),
    "utf8"
  );
  const r2OldHandle = (await r2Store.listTodos()).find((t) => t.headline === "Follow up")!.id!;
  assert(r2OldHandle.startsWith("tmp:inbox.org:5:"), `R2: expected line 5 handle, got ${r2OldHandle}`);
  await r2Store.capture({
    headline: "Follow up",
    todo: "TODO",
    parentId: "proj",
    body: "new: email the landlord",
  });
  const r2BeforeUpdate = await fs.readFile(r2Path, "utf8");
  let r2Err: unknown = null;
  try {
    await r2Store.updateState(r2OldHandle, "DONE");
  } catch (err) {
    r2Err = err;
  }
  assert(
    r2Err instanceof OrgError && /stale/i.test(r2Err.message),
    `R2: expected stale OrgError, got ${r2Err}`
  );
  assert((await fs.readFile(r2Path, "utf8")) === r2BeforeUpdate, "R2: file unchanged after stale updateState");

  // R3: same-file refile moves another twin heading (c1) under Project right at oldHandle's line.
  const r3Dir = path.join(baseDir, "tmp-r3");
  const r3Store = new OrgStore(r3Dir);
  await r3Store.init();
  const r3Path = path.join(r3Dir, "inbox.org");
  await fs.writeFile(
    r3Path,
    [
      "* Project",
      "  :PROPERTIES:",
      "  :ID: proj",
      "  :END:",
      "* TODO Follow up",
      "Call the bank about the mortgage",
      "* Other",
      "** TODO Follow up",
      "   :PROPERTIES:",
      "   :ID: c1",
      "   :END:",
      "Chase the plumber",
      "",
    ].join("\n"),
    "utf8"
  );
  const r3OldHandle = (await r3Store.listTodos()).find(
    (t) => t.headline === "Follow up" && t.body.includes("mortgage")
  )!.id!;
  assert(r3OldHandle.startsWith("tmp:inbox.org:5:"), `R3: expected line 5 handle, got ${r3OldHandle}`);
  await r3Store.refile("c1", { parentId: "proj" });
  const r3BeforeArchive = await fs.readFile(r3Path, "utf8");
  let r3Err: unknown = null;
  try {
    await r3Store.archiveEntry(r3OldHandle);
  } catch (err) {
    r3Err = err;
  }
  assert(
    r3Err instanceof OrgError && /stale/i.test(r3Err.message),
    `R3: expected stale OrgError, got ${r3Err}`
  );
  assert((await fs.readFile(r3Path, "utf8")) === r3BeforeArchive, "R3: file unchanged after stale archiveEntry");
  let r3ArchExists = true;
  try {
    await fs.access(path.join(r3Dir, "inbox_archive.org"));
  } catch {
    r3ArchExists = false;
  }
  assert(!r3ArchExists, "R3: archive file was not created");

  // 8. R4: reusing a tmp handle after its own first write still works via materializedTmpHandles.
  const r4Dir = path.join(baseDir, "tmp-r4");
  const r4Store = new OrgStore(r4Dir);
  await r4Store.init();
  const r4Path = path.join(r4Dir, "inbox.org");
  await fs.writeFile(r4Path, "* TODO Reusable handle task\n", "utf8");
  const r4Handle = (await r4Store.listTodos())[0].id!;
  assert(r4Handle.startsWith("tmp:inbox.org:1:"), `R4: expected tmp handle, got ${r4Handle}`);
  const r4First = await r4Store.updateState(r4Handle, "NEXT");
  assert(r4First.todo === "NEXT" && r4First.id !== null && !r4First.id.startsWith("tmp:"), "R4: first write materialized ID");
  const r4Fetched = await r4Store.getEntry(r4Handle);
  assert(r4Fetched !== null && r4Fetched.id === r4First.id, "R4: getEntry(tmpHandle) resolves after materialization");
  const r4Second = await r4Store.schedule(r4Handle, { scheduled: "2026-09-01" });
  assert(r4Second.id === r4First.id && r4Second.scheduled?.date === "2026-09-01", "R4: second write via same tmp handle succeeded");

  // 9. Unrelated write to the same file makes a held tmp handle stale.
  const unrelDir = path.join(baseDir, "tmp-unrelated");
  const unrelStore = new OrgStore(unrelDir);
  await unrelStore.init();
  const unrelPath = path.join(unrelDir, "inbox.org");
  await fs.writeFile(
    unrelPath,
    [
      "* TODO Task A",
      "  :PROPERTIES:",
      "  :ID: id-a",
      "  :END:",
      "* TODO Task B",
      "",
    ].join("\n"),
    "utf8"
  );
  const unrelBHandle = (await unrelStore.listTodos()).find((t) => t.headline === "Task B")!.id!;
  assert(unrelBHandle.startsWith("tmp:inbox.org:5:"), `unrelated: expected line 5 handle, got ${unrelBHandle}`);
  await unrelStore.updateState("id-a", "DONE");
  const unrelBefore = await fs.readFile(unrelPath, "utf8");
  let unrelErr: unknown = null;
  try {
    await unrelStore.updateState(unrelBHandle, "DONE");
  } catch (err) {
    unrelErr = err;
  }
  assert(
    unrelErr instanceof OrgError && /stale/i.test(unrelErr.message),
    `unrelated write: expected stale OrgError, got ${unrelErr}`
  );
  assert((await fs.readFile(unrelPath, "utf8")) === unrelBefore, "unrelated write: file unchanged after stale updateState");

  // 10. H3, H3b, E1: no-ID twin inside a refiled subtree or swapped in editor must report stale.
  // H3: archiveEntry above + same-file refile moves no-ID twin onto target's line & ordinal.
  const h3Dir = path.join(baseDir, "tmp-h3");
  const h3Store = new OrgStore(h3Dir);
  await h3Store.init();
  const h3Path = path.join(h3Dir, "inbox.org");
  await fs.writeFile(
    h3Path,
    [
      "* DONE Old thing",
      "  :PROPERTIES:",
      "  :ID: old",
      "  :END:",
      "* Project",
      "  :PROPERTIES:",
      "  :ID: proj",
      "  :END:",
      "* TODO Follow up",
      "Call the bank",
      "* Errands",
      "  :PROPERTIES:",
      "  :ID: errands",
      "  :END:",
      "** TODO Follow up",
      "Chase the plumber",
      "",
    ].join("\n"),
    "utf8"
  );
  const h3Target = (await h3Store.listTodos()).find(
    (t) => t.headline === "Follow up" && t.body.includes("bank")
  )!.id!;
  assert(h3Target.startsWith("tmp:inbox.org:9:"), `H3: expected line 9 handle, got ${h3Target}`);
  await h3Store.archiveEntry("old");
  await h3Store.refile("errands", { parentId: "proj" });
  const h3Before = await fs.readFile(h3Path, "utf8");
  assert((await h3Store.getEntry(h3Target)) === null, "H3: getEntry(stale handle) returns null");
  let h3Err: unknown = null;
  try {
    await h3Store.updateState(h3Target, "DONE");
  } catch (err) {
    h3Err = err;
  }
  assert(
    h3Err instanceof OrgError && /stale/i.test(h3Err.message),
    `H3: expected stale OrgError, got ${h3Err}`
  );
  assert((await fs.readFile(h3Path, "utf8")) === h3Before, "H3: file unchanged after stale updateState");

  // H3b: editEntry shrinking body above + same-file refile, then archiveEntry(targetHandle).
  const h3bDir = path.join(baseDir, "tmp-h3b");
  const h3bStore = new OrgStore(h3bDir);
  await h3bStore.init();
  const h3bPath = path.join(h3bDir, "inbox.org");
  await fs.writeFile(
    h3bPath,
    [
      "* Notes",
      "  :PROPERTIES:",
      "  :ID: notes",
      "  :END:",
      "line 1",
      "line 2",
      "line 3",
      "* Project",
      "  :PROPERTIES:",
      "  :ID: proj",
      "  :END:",
      "* TODO Follow up",
      "Call the bank",
      "* Errands",
      "  :PROPERTIES:",
      "  :ID: errands",
      "  :END:",
      "** TODO Follow up",
      "Chase the plumber",
      "",
    ].join("\n"),
    "utf8"
  );
  const h3bTarget = (await h3bStore.listTodos()).find(
    (t) => t.headline === "Follow up" && t.body.includes("bank")
  )!.id!;
  assert(h3bTarget.startsWith("tmp:inbox.org:12:"), `H3b: expected line 12 handle, got ${h3bTarget}`);
  await h3bStore.editEntry("notes", { body: "" });
  await h3bStore.refile("errands", { parentId: "proj" });
  const h3bBefore = await fs.readFile(h3bPath, "utf8");
  let h3bErr: unknown = null;
  try {
    await h3bStore.archiveEntry(h3bTarget);
  } catch (err) {
    h3bErr = err;
  }
  assert(
    h3bErr instanceof OrgError && /stale/i.test(h3bErr.message),
    `H3b: expected stale OrgError, got ${h3bErr}`
  );
  assert((await fs.readFile(h3bPath, "utf8")) === h3bBefore, "H3b: file unchanged after stale archiveEntry");
  let h3bArchExists = true;
  try {
    await fs.access(path.join(h3bDir, "inbox_archive.org"));
  } catch {
    h3bArchExists = false;
  }
  assert(!h3bArchExists, "H3b: archive file was not created");

  // E1: external editor swaps two same-text sibling entries.
  const e1Dir = path.join(baseDir, "tmp-e1");
  const e1Store = new OrgStore(e1Dir);
  await e1Store.init();
  const e1Path = path.join(e1Dir, "inbox.org");
  await fs.writeFile(
    e1Path,
    [
      "* TODO Follow up",
      "Call the bank",
      "* TODO Follow up",
      "Chase the plumber",
      "",
    ].join("\n"),
    "utf8"
  );
  const e1BankHandle = (await e1Store.listTodos()).find((t) => t.body.includes("bank"))!.id!;
  assert(e1BankHandle.startsWith("tmp:inbox.org:1:"), `E1: expected line 1 handle, got ${e1BankHandle}`);
  const e1Swapped = [
    "* TODO Follow up",
    "Chase the plumber",
    "* TODO Follow up",
    "Call the bank",
    "",
  ].join("\n");
  await fs.writeFile(e1Path, e1Swapped, "utf8");
  let e1Err: unknown = null;
  try {
    await e1Store.updateState(e1BankHandle, "DONE");
  } catch (err) {
    e1Err = err;
  }
  assert(
    e1Err instanceof OrgError && /stale/i.test(e1Err.message),
    `E1: expected stale OrgError after editor swap, got ${e1Err}`
  );
  assert((await fs.readFile(e1Path, "utf8")) === e1Swapped, "E1: file unchanged after stale updateState");

  console.log("read-only mtime & temporary handles OK");
}

async function testSetProperties(baseDir: string) {
  console.log("\n=== setProperties ===");
  const dir = path.join(baseDir, "set-properties");
  const store = new OrgStore(dir);
  await store.init();

  // 1. Add, replace, remove, and mix in one call on a captured entry
  const entry = await store.capture({
    headline: "Implement org_set_properties",
    todo: "TODO",
    body: "Task details.",
  });
  const id = entry.id!;

  // Add
  const added = await store.setProperties(id, {
    KANBAN: "t_ffc25807",
    REPO: "org-mcp",
    PRIORITY_NOTE: "high",
  });
  deepStrictEqual(added, await store.getEntry(id), "add result deep-equals getEntry");
  assert(added.properties.KANBAN === "t_ffc25807", "KANBAN added");
  assert(added.properties.REPO === "org-mcp", "REPO added");
  assert(added.properties.PRIORITY_NOTE === "high", "PRIORITY_NOTE added");

  // Replace in place
  const replaced = await store.setProperties(id, { KANBAN: "t_updated" });
  deepStrictEqual(replaced, await store.getEntry(id), "replace result deep-equals getEntry");
  assert(replaced.properties.KANBAN === "t_updated", "KANBAN replaced");
  assert(replaced.properties.REPO === "org-mcp", "absent key REPO left unchanged");

  // Remove (including removing an absent key)
  const removed = await store.setProperties(id, {
    PRIORITY_NOTE: null,
    DOES_NOT_EXIST: null,
  });
  deepStrictEqual(removed, await store.getEntry(id), "remove result deep-equals getEntry");
  assert(!("PRIORITY_NOTE" in removed.properties), "PRIORITY_NOTE removed");
  assert(removed.properties.KANBAN === "t_updated", "KANBAN kept");
  assert(removed.properties.REPO === "org-mcp", "REPO kept");

  // Mix of add, replace, remove, and untouched in one call; verify key order preserved
  const mixed = await store.setProperties(id, {
    KANBAN: "t_final",
    REPO: null,
    OWNER: "junior",
    LENS: "contract",
  });
  deepStrictEqual(mixed, await store.getEntry(id), "mixed result deep-equals getEntry");
  assert(mixed.properties.KANBAN === "t_final", "KANBAN replaced in mix");
  assert(!("REPO" in mixed.properties), "REPO removed in mix");
  assert(mixed.properties.OWNER === "junior", "OWNER added in mix");
  assert(mixed.properties.LENS === "contract", "LENS added in mix");

  const rawInbox = await store.readFile("inbox.org");
  const drawerLines = rawInbox
    .split("\n")
    .filter((l) => /^\s*:(ID|CREATED|KANBAN|OWNER|LENS):/.test(l));
  deepStrictEqual(
    drawerLines.map((l) => l.trim().split(":")[1]),
    ["ID", "CREATED", "KANBAN", "OWNER", "LENS"],
    "existing key order preserved and new keys appended at end"
  );

  // 2. Preserve custom drawer indentation (4 spaces)
  const customIndentId = "22222222-3333-4444-5555-666666666666";
  await fs.writeFile(
    path.join(dir, "custom.org"),
    [
      "* TODO Custom indented drawer",
      "    :PROPERTIES:",
      `    :ID: ${customIndentId}`,
      "    :ALPHA: 1",
      "    :BETA: 2",
      "    :END:",
      "",
    ].join("\n"),
    "utf8"
  );
  const customUpdated = await store.setProperties(customIndentId, {
    ALPHA: "one",
    GAMMA: "three",
  });
  deepStrictEqual(
    customUpdated,
    await store.getEntry(customIndentId),
    "custom indent result deep-equals getEntry"
  );
  const customRaw = await store.readFile("custom.org");
  assert(
    customRaw ===
      [
        "* TODO Custom indented drawer",
        "    :PROPERTIES:",
        `    :ID: ${customIndentId}`,
        "    :ALPHA: one",
        "    :BETA: 2",
        "    :GAMMA: three",
        "    :END:",
        "",
      ].join("\n"),
    `custom drawer indentation and key order must be preserved, got:\n${customRaw}`
  );

  // 3. Create drawer on an entry without one via tmp: handle, in standard position
  const handWritten = [
    "* TODO Hand-written no drawer",
    "  SCHEDULED: <2026-08-20 Thu>",
    "Body line stays after drawer.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "hand.org"), handWritten, "utf8");
  const listed = await store.listTodos({ file: "hand.org" });
  const tmpId = listed[0].id!;
  assert(tmpId.startsWith("tmp:hand.org:1:"), "expected tmp handle");

  // Validation errors on a tmp handle must refuse without materializing :ID: or touching disk
  const expectRejected = async (
    targetId: string,
    props: Record<string, string | null>,
    label: string,
    fileToCheck: string,
    expectedContent: string
  ) => {
    let err: unknown = null;
    try {
      await store.setProperties(targetId, props);
    } catch (e) {
      err = e;
    }
    assert(err instanceof OrgError, `${label}: expected OrgError, got ${err}`);
    assert(
      (await store.readFile(fileToCheck)) === expectedContent,
      `${label}: file must remain byte-identical`
    );
  };

  await expectRejected(tmpId, { ID: "override" }, "refuse ID", "hand.org", handWritten);
  await expectRejected(tmpId, { id: "override" }, "refuse lowercase id", "hand.org", handWritten);
  await expectRejected(tmpId, { CREATED: "2026-01-01" }, "refuse CREATED", "hand.org", handWritten);
  await expectRejected(tmpId, { created: "2026-01-01" }, "refuse lowercase created", "hand.org", handWritten);
  await expectRejected(tmpId, { "": "val" }, "refuse empty key", "hand.org", handWritten);
  await expectRejected(tmpId, { "bad key": "val" }, "refuse space in key", "hand.org", handWritten);
  await expectRejected(tmpId, { "bad\tkey": "val" }, "refuse tab in key", "hand.org", handWritten);
  await expectRejected(tmpId, { "bad:key": "val" }, "refuse colon in key", "hand.org", handWritten);
  await expectRejected(tmpId, { foo: "1", FOO: "2" }, "refuse case-insensitive duplicate keys", "hand.org", handWritten);
  await expectRejected(tmpId, { KEY: "line1\nline2" }, "refuse LF in value", "hand.org", handWritten);
  await expectRejected(tmpId, { KEY: "line1\rline2" }, "refuse CR in value", "hand.org", handWritten);
  await expectRejected(tmpId, { KEY: "a\u2028b" }, "refuse U+2028 in value", "hand.org", handWritten);
  await expectRejected(tmpId, { KEY: "a\u2029b" }, "refuse U+2029 in value", "hand.org", handWritten);
  await expectRejected(tmpId, { KEY: "a\u0000b" }, "refuse NUL in value", "hand.org", handWritten);
  await expectRejected(tmpId, { END: "" }, "refuse END key (empty)", "hand.org", handWritten);
  await expectRejected(tmpId, { end: "x" }, "refuse lowercase end key", "hand.org", handWritten);
  await expectRejected(tmpId, { PROPERTIES: "" }, "refuse PROPERTIES key", "hand.org", handWritten);
  await expectRejected(
    customIndentId,
    { END: "", LATER: "x" },
    "refuse END with sibling key on existing drawer",
    "custom.org",
    [
      "* TODO Custom indented drawer",
      "    :PROPERTIES:",
      `    :ID: ${customIndentId}`,
      "    :ALPHA: one",
      "    :BETA: 2",
      "    :GAMMA: three",
      "    :END:",
      "",
    ].join("\n")
  );

  // 4. Unterminated :PROPERTIES: drawer must refuse without touching child entries or disk
  const parentD2Id = "33333333-4444-5555-6666-777777777777";
  const unterminatedD2 = [
    "* TODO P",
    "  :PROPERTIES:",
    `  :ID: ${parentD2Id}`,
    "** TODO child",
    "  :PROPERTIES:",
    "  :KANBAN: childcard",
    "  :END:",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "unterminated-d2.org"), unterminatedD2, "utf8");
  await expectRejected(
    parentD2Id,
    { KANBAN: "parentcard" },
    "refuse unterminated drawer spanning into child drawer (D2)",
    "unterminated-d2.org",
    unterminatedD2
  );
  const d2Entries = await store.listTodos({ file: "unterminated-d2.org" });
  const childAfterD2 = d2Entries.find((e) => e.headline === "child");
  assert(
    childAfterD2?.properties.KANBAN === "childcard",
    "child KANBAN must remain untouched after D2 refusal"
  );

  const parentDId = "55555555-6666-7777-8888-999999999999";
  const unterminatedD = [
    "* TODO P",
    "  :PROPERTIES:",
    `  :ID: ${parentDId}`,
    "** TODO child",
    "  :BETA: inchild",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "unterminated-d.org"), unterminatedD, "utf8");
  await expectRejected(
    parentDId,
    { BETA: "parent", NEW: "x" },
    "refuse unterminated drawer reaching EOF/child body (D)",
    "unterminated-d.org",
    unterminatedD
  );

  // Now set properties using the tmp: handle — creates drawer in standard position
  const createdDrawer = await store.setProperties(tmpId, { KANBAN: "t_ffc25807" });
  assert(createdDrawer.id !== null && !createdDrawer.id.startsWith("tmp:"), "tmp handle materialized");
  deepStrictEqual(
    createdDrawer,
    await store.getEntry(createdDrawer.id!),
    "created drawer result deep-equals getEntry"
  );
  const handLines = (await store.readFile("hand.org")).split("\n");
  assert(handLines[0] === "* TODO Hand-written no drawer", "headline at line 0");
  assert(handLines[1] === "  SCHEDULED: <2026-08-20 Thu>", "planning at line 1");
  assert(handLines[2] === "  :PROPERTIES:", "drawer starts at line 2 (standard position)");
  assert(handLines[3] === `  :ID: ${createdDrawer.id}`, "ID materialized in drawer");
  assert(handLines[4] === "  :KANBAN: t_ffc25807", "KANBAN appended to drawer");
  assert(handLines[5] === "  :END:", "drawer ends at line 5");
  assert(handLines[6] === "Body line stays after drawer.", "body follows drawer");

  // Reusing the same tmp: handle works via materializedTmpHandles
  const reused = await store.setProperties(tmpId, { STAGE: "review" });
  deepStrictEqual(reused, await store.getEntry(createdDrawer.id!), "reused tmp handle works");
  assert(reused.properties.STAGE === "review", "STAGE set on reused tmp handle");

  console.log("setProperties OK");
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

  // --- Hand-edited file: repeater/time-range preservation + temporary handles ---
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
  assert(
    standup!.entry.id !== null && standup!.entry.id.startsWith("tmp:recurring.org:4:"),
    "hand-written entry received a temporary handle from agenda()"
  );
  assert(
    (await fs.readFile(path.join(dir, "recurring.org"), "utf8")) === handWritten,
    "agenda() did not write to recurring.org"
  );
  console.log("hand-written entries with temporary handles:", {
    recycling: recycling!.entry.id,
    standup: standup!.entry.id,
  });

  const doneRecycling = await store.updateState(recycling!.entry.id!, "DONE");
  assert(doneRecycling.closed !== null, "CLOSED stamp added");
  assert(doneRecycling.id !== null && !doneRecycling.id.startsWith("tmp:"), "updateState assigned a permanent ID");
  const rawRecurring = await fs.readFile(path.join(dir, "recurring.org"), "utf8");
  console.log("--- recurring.org after marking recycling DONE ---\n" + rawRecurring + "--- end ---");
  assert(rawRecurring.includes("+1w"), "repeater cookie survived a state change that touched CLOSED");

  // Re-read agenda so Standup's temporary handle reflects the shifted line number.
  const agendaHand2 = await store.agenda("2026-08-20", "2026-08-20");
  const standup2 = agendaHand2.find((i) => i.entry.headline === "Standup");
  assert(standup2 !== undefined, "standup still in agenda");
  const rescheduledStandup = await store.schedule(standup2!.entry.id!, { deadline: "2026-08-21" });
  assert(rescheduledStandup.id !== null && !rescheduledStandup.id.startsWith("tmp:"), "schedule assigned a permanent ID");
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
  await testDuplicateIdDetection(dir);
  await testCaptureMatchesGetEntry(dir);
  await testParentIdAndPath(dir);
  await testConsistentFilters(dir);
  await testAtomicWrites(dir);
  await testOutline(dir);
  await testExternalChangeDetection(dir);
  await testReadOnlyAndTempHandles(dir);
  await testSetProperties(dir);

  console.log("\nALL TESTS PASSED");
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
