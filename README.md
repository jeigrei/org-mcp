# org-mcp

An MCP server that gives an LLM org-capture and org-agenda style workflows,
backed by plain-text `.org` files on local disk. No database — every entry
lives in a human-readable, hand-editable org file you can also open in Emacs.

## Data model

Entries are ordinary org headlines:

```org
* TODO [#A] File taxes
  DEADLINE: <2026-08-19 Wed>
  :PROPERTIES:
  :ID:       8ece9756-205b-414d-a675-f7def6e231fa
  :CREATED:  [2026-08-19 Wed 00:21]
  :END:
```

Every captured entry gets a stable `:ID:` (UUID) so it can be looked up,
rescheduled, or marked done later regardless of edits elsewhere in the file.

By default all org files live in `~/org-mcp-data/`. Capture writes to
`inbox.org` unless another filename is given. Archiving an entry moves its
subtree to a companion `<file>_archive.org`.

## Tools

| Tool | Purpose |
|---|---|
| `org_capture` | Append a new entry (task, note, or event) to a file, org-capture style. Supports `parent_id` to nest under an existing entry. |
| `org_agenda` | Org-agenda style view: entries scheduled/due in a date range, plus overdue open items. |
| `org_list_todos` | List open TODO-like entries, sorted by priority/due date, filterable by state/tag/priority. |
| `org_search` | Full-text search across headlines, body, and tags. |
| `org_get_entry` | Fetch one entry's full details by id. |
| `org_update_state` | Change an entry's TODO keyword (e.g. mark DONE); stamps/clears `CLOSED`. |
| `org_schedule` | Set/change/clear `SCHEDULED` and/or `DEADLINE`. |
| `org_add_note` | Append a timestamped note to an entry's body. |
| `org_archive_entry` | Move an entry's subtree to `<file>_archive.org`. |
| `org_list_files` | List tracked org files. |

## Setup

```bash
npm install
npm run build
```

Configure your MCP client to run it over stdio:

```json
{
  "mcpServers": {
    "org": {
      "command": "node",
      "args": ["/Users/grayson/projects/org-mcp/dist/server.js"],
      "env": {
        "ORG_MCP_DIR": "/Users/grayson/org"
      }
    }
  }
}
```

### Environment variables

- `ORG_MCP_DIR` — directory holding the org files (default `~/org-mcp-data`).
- `ORG_MCP_DEFAULT_FILE` — default capture target filename (default `inbox.org`).

## Development

```bash
npm run dev    # run server.ts directly via tsx
npm test       # run the store's functional test suite (uses a temp dir)
```
