# org-mcp

An MCP server that gives an LLM org-capture and org-agenda style workflows,
backed by plain-text `.org` files on local disk. No database — every entry
lives in a human-readable, hand-editable org file you can also open in Emacs.

It speaks **MCP over Streamable HTTP**, with support for isolating multiple
users' data behind [Cloudflare Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) —
built for running on a small always-on box (e.g. a Raspberry Pi) exposed
through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

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

Every captured entry gets a stable `:ID:` (a UUID) so it can be looked up,
rescheduled, or marked done later regardless of edits elsewhere in the file.
Hand-written entries (e.g. typed directly into the file in Emacs) that lack
an `:ID:` are lazily assigned one the first time a listing tool (agenda,
search, list-todos) encounters them — after that they're addressable too.

Repeaters and time ranges in timestamps (`<2026-08-20 Thu +1w>`,
`<2026-08-20 Thu 10:00-11:00>`) are preserved verbatim across edits — a
state change or a reschedule of one field never rewrites the other.

## Multi-user isolation

Every request must resolve to an identity, which maps to a subdirectory:

```
<ORG_MCP_DIR>/
  alice/
    inbox.org
    projects.org
  bob/
    inbox.org
```

A single running server instance serves everyone; each user only ever sees
their own subdirectory. There's no cross-user tool for browsing or sharing
files — isolation is total.

Identity comes from one of two places:

- **Cloudflare Access** (production): every request that passes an Access
  policy carries a `Cf-Access-Jwt-Assertion` header. org-mcp verifies that
  JWT against your Zero Trust team's public keys and derives the user id
  from the token's `common_name` (Service Tokens) or `email` (Access apps
  using an IdP login) claim.
- **A raw `X-Org-User` header** (local dev only): used automatically when
  `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` aren't set. There's no
  verification at all in this mode — anyone who can reach the port can
  claim to be anyone. Only use it on `127.0.0.1`.

## Setup

```bash
npm install
npm run build
```

Run it:

```bash
ORG_MCP_DIR=/home/pi/org-data \
CF_ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com \
CF_ACCESS_AUD=<access-app-audience-tag> \
node dist/server.js
```

By default it listens on `127.0.0.1:3000` — deliberately loopback-only, so
the only way in is through `cloudflared` running on the same box. Don't
change `HOST` to `0.0.0.0` unless you have another reason to trust your LAN.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on. |
| `HOST` | `127.0.0.1` | Interface to bind. Keep this loopback-only; let `cloudflared` do the exposing. |
| `ORG_MCP_DIR` | `~/org-mcp-data` | Base directory. Each user gets a subdirectory under it. |
| `ORG_MCP_DEFAULT_FILE` | `inbox.org` | Default capture target filename, per user. |
| `CF_ACCESS_TEAM_DOMAIN` | *(unset)* | Your Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`. Required together with `CF_ACCESS_AUD` to enable real auth. |
| `CF_ACCESS_AUD` | *(unset)* | The Access Application's Audience (AUD) tag. |

Setting only one of `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` is a startup
error — they're required together or not at all.

## Exposing it via Cloudflare Tunnel + Access

1. **Install and run `cloudflared`** on the same machine as org-mcp, and
   point an ingress rule at the local port:
   ```yaml
   # ~/.cloudflared/config.yml
   tunnel: <your-tunnel-id>
   credentials-file: /home/pi/.cloudflared/<your-tunnel-id>.json
   ingress:
     - hostname: org.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```
   ```bash
   cloudflared tunnel route dns <your-tunnel-id> org.example.com
   cloudflared tunnel run <your-tunnel-id>
   ```
2. **Create a Zero Trust Access application** (dash.cloudflare.com → Zero
   Trust → Access → Applications) for `org.example.com`. Note its
   **Audience (AUD) tag** from the app's Overview page — that's
   `CF_ACCESS_AUD`. Your **team domain** (Settings → Custom Pages, or the
   URL of your Zero Trust dashboard) is `CF_ACCESS_TEAM_DOMAIN`.
3. **Create one Service Token per user** (Zero Trust → Access → Service
   Auth → Service Tokens). Each token is a Client ID / Client Secret pair
   with no login flow attached. Give the user's token a name you'll
   recognize (this name becomes their org-mcp user id, sanitized into a
   directory name — e.g. a token named "Alice" isolates into `alice/`).
4. **Add an Access policy** on the application allowing those Service
   Tokens (policy action: Service Auth, selector: the tokens you created).
5. **Give each user their pair.** Their MCP client needs to send it as
   request headers on every call to `https://org.example.com/mcp`:
   ```
   CF-Access-Client-Id: <client id>.access
   CF-Access-Client-Secret: <client secret>
   ```
   How you configure that depends on the client — e.g. a `headers` field
   in the MCP server config for clients that support remote HTTP servers
   with custom headers. Run `node dist/server.js` and start `cloudflared`
   with `sudo systemctl enable --now cloudflared` (or equivalent) so both
   survive a reboot.

Restart the server with `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` set once
this is wired up — from then on every request must carry a valid,
Cloudflare-signed identity.

## Local development (no Cloudflare)

```bash
npm run dev   # runs src/server.ts directly via tsx, dev-mode auth
```

Without `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` set, identity comes from an
unauthenticated `X-Org-User` header (defaulting to `"default"` if omitted) —
useful for testing multi-user isolation locally, e.g.:

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'x-org-user: alice' \
  -H 'mcp-session-id: ...' \
  -d '{"jsonrpc":"2.0", ...}'
```

`GET /healthz` returns `{"ok":true}` unauthenticated, for uptime checks.

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
| `org_read_file` | Read the raw text of one tracked org file. |
| `org_list_files` | List tracked org files (for the requesting user). |

## Development

```bash
npm run dev    # run server.ts directly via tsx
npm test       # run the store's functional test suite (uses a temp dir)
```

`npm test` exercises `OrgStore` directly (parsing, capture, agenda,
scheduling, archiving, lazy ID assignment) — it doesn't cover the HTTP/auth
layer in `server.ts`, so changes there are worth a manual smoke test against
a running server.
