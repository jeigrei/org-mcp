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
  JWT against your Zero Trust team's public keys and reads the identity
  from the token's `common_name` (Service Tokens) or `email` (interactive
  logins, including Managed OAuth) claim.
- **A raw `X-Org-User` header** (local dev only): used automatically when
  `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` aren't set. There's no
  verification at all in this mode — anyone who can reach the port can
  claim to be anyone. Only use it on `127.0.0.1`.

### Identity mapping

One person reaches org-mcp under *different claims depending on the client*.
Claude Code authenticates with a Service Token, yielding its name
(`grayson`); claude.ai authenticates interactively via Managed OAuth,
yielding an email (`j.g.cupit@gmail.com`). Left alone those sanitize into two
different directories, so the same human would see two different sets of
tasks depending on which client they opened — which defeats the point of a
shared memory layer.

`ORG_MCP_IDENTITY_MAP` points at a JSON file mapping each raw claim to a
canonical user id:

```json
{
  "grayson": "grayson",
  "j.g.cupit@gmail.com": "grayson",
  "alice-laptop": "alice",
  "alice@example.com": "alice"
}
```

Lookups are case-insensitive and whitespace-tolerant. The mapping is
deliberately explicit rather than inferred — deriving an id by stripping an
email's domain would silently collapse `alice@gmail.com` and
`alice@work.com`, two different people, into one directory.

**When a map is configured, unmapped identities are rejected with a 403.**
You're already minting a Service Token per person by hand, so adding a line
here at the same time costs nothing, and a loud rejection beats silently
creating an empty directory and having the LLM report you have no tasks. The
map is read once at startup, so adding a user means restarting the process.

With no map configured, behavior is unchanged: every distinct claim gets its
own directory. That keeps local dev and single-identity setups zero-config.

On startup the server logs the claims it loaded and the user ids they
resolve to, and logs the resolved id each time a session opens — check those
before pointing a second client at a user that already has data.

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
| `ORG_MCP_IDENTITY_MAP` | *(unset)* | Path to a JSON file mapping Access claims to canonical user ids. See [Identity mapping](#identity-mapping). Unset means every claim gets its own directory. |

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
   with custom headers. See "Running under pm2" below for how to keep the
   server itself alive across reboots; start `cloudflared` with
   `sudo systemctl enable --now cloudflared` (or equivalent) so it survives
   one too.

Restart the server with `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` set once
this is wired up — from then on every request must carry a valid,
Cloudflare-signed identity.

### Connecting clients

Which clients can connect depends on how they authenticate, and the two
mechanisms need different Access configuration on the same application.

**Clients that can send static headers** (e.g. Claude Code) use the Service
Tokens above directly:

```bash
claude mcp add --transport http org-mcp https://org.example.com/mcp \
  --header "CF-Access-Client-Id: <client id>.access" \
  --header "CF-Access-Client-Secret: <client secret>"
```

**Chat clients** (claude.ai, Claude Desktop, mobile) can't send custom
headers — their custom-connector UI takes a URL and OAuth only. For those,
turn on **[Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)**
(Zero Trust → Access controls → Applications → your app → Edit → Advanced
settings → Managed OAuth). That makes Access itself the OAuth 2.0
authorization server: the client discovers it at
`https://org.example.com/.well-known/oauth-authorization-server`, the user
logs in through Access in a browser once, and Cloudflare resolves the
resulting opaque token server-side and forwards the *same*
`Cf-Access-Jwt-Assertion` header org-mcp already verifies. **No org-mcp code
changes are required** — Cloudflare's only requirement for enabling it is
that the origin validate that header, which this server does.

Alongside it you'll want to:

- Set **Allowed redirect URIs** to permit the chat client's callback.
- Set **Access token lifetime** to 5–15 minutes and **Grant session
  duration** to 1–2 weeks. Cloudflare recommends this pairing for agent
  clients: tokens refresh silently in the background, policies are
  re-evaluated on each refresh, and the user only re-authenticates every
  couple of weeks.
- Add an **interactive** rule (One-Time PIN or an IdP) to the application's
  policy. A Service Auth rule can't satisfy a browser login, so it can't
  carry the OAuth leg — you want both rules on the app, Service Auth for
  header-based clients and an interactive one for chat clients.

Since the two paths yield different identity claims for the same person, set
up [Identity mapping](#identity-mapping) before connecting the second client.

### Running under pm2

On a box that already runs other services under pm2 (e.g. alongside
MagicMirror), start org-mcp the same way rather than introducing a second
process manager or an ecosystem file:

```bash
export CF_ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com
export CF_ACCESS_AUD=<access-app-audience-tag>
pm2 start npm --name org-mcp --cwd ~/org-mcp -- start
pm2 save
```

`pm2 save` snapshots the resolved environment (including the two exported
vars above) into `~/.pm2/dump.pm2`, so `pm2 resurrect` — run automatically
by the `pm2-<user>` systemd service set up via `pm2 startup` — brings it
back with the same config after a reboot. No separate `.env` file or
ecosystem config needed.

### Redeploying

`deploy.sh` pulls, installs, builds, runs the tests, and restarts the pm2
process — aborting before the restart if any step fails, so a broken build
never replaces a working one. Run it from your own machine in one shot:

```bash
ssh pi 'cd ~/org-mcp && ./deploy.sh'
```

Worth aliasing, since that's the whole deploy. It pulls from `origin`, so
push your commits to GitHub first — otherwise it'll cheerfully redeploy the
code that's already running.

The script sources `nvm` itself before doing anything. `ssh host 'cmd'` runs a
non-interactive shell, which returns early from `~/.bashrc` before nvm's setup
— so `node`, `npm`, and `pm2` are all off `PATH` even though they work fine in
an interactive session. If node is installed some other way on your box, the
script says which command it couldn't find and where to add it.

Two things it deliberately refuses to do:

- **Deploy over uncommitted changes.** If the working tree on the Pi has
  modifications, it stops rather than pulling over them. Commit, stash, or
  discard them there first.
- **Refresh the process environment.** `pm2 restart` runs without
  `--update-env`, so the `CF_ACCESS_*` vars the process was started with
  survive the restart. Passing `--update-env` from a plain SSH session would
  replace them with that shell's empty environment and silently drop Access
  authentication. If you do need to change those vars, restart it by hand
  with them exported and re-run `pm2 save`.

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
