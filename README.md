# Zoho Timesheet MCP

An MCP server that files Zoho Projects timesheet entries by conversation instead of
through the Zoho UI.

**Core path (everyone):** `list_projects`, `get_my_tasks`, `create_task`, `log_time`,
`get_timesheet_status`, `delete_time_log`.

Runs two ways: as a **local stdio server** for one person, or as a **deployed HTTP
server with per-user OAuth** for a team — same tools either way. See
[Deploying for a team](#deploying-for-a-team-multi-user-oauth).

**Optional path (Zoho People users only):** `get_attendance`,
`plan_timesheet_from_attendance` — reads your check-in/check-out times and proposes
what is missing from the timesheet. Neither tool writes to Zoho. See
[Filling from attendance](#optional-filling-the-timesheet-from-zoho-people-attendance).

**Optional path (Omi users only):** `import_omi_conversations` — drafts proposed entries
from an Omi export. It never writes to Zoho. If you do not use Omi, ignore it entirely;
it needs no extra configuration and the core tools do not depend on it.

## Design notes worth knowing before you use it

- **It never logs to a guessed task.** `log_time` matches a spoken name against your
  open tasks and writes only when the best candidate scores highly *and* is clearly
  ahead of the runner-up. Otherwise it returns the top three candidates and writes
  nothing, so Claude can ask you which one you meant.
- **Duplicate guard.** Before writing, it checks whether that task already has time on
  that date. If it does, it refuses and tells you, unless you pass
  `confirm_duplicate: true`. This is the guard against a retried tool call silently
  double-logging your day.
- **Everything is scoped to one user.** `ZOHO_USER_ID` is required. A self-client
  service account can see the entire portal's tasks; without that filter the match pool
  would be everyone's work and the fuzzy match would be dangerous.
- **Dates and hours are normalised to the portal's own settings.** Zoho wants `HH:MM`
  for hours and the portal's configured date format (`MM-dd-yyyy`, `dd-MM-yyyy`, …) for
  dates. The server reads the portal format once at startup and converts. You always
  speak ISO `YYYY-MM-DD` to the tools.
- **Every write attempt is audited**, including refusals and failures, as JSONL at
  `audit/timelog-audit.jsonl`. Diagnostics go to **stderr**, never stdout — stdout is
  the JSON-RPC channel and anything else there corrupts the protocol stream.

## Setup

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Get Zoho self-client credentials

1. Go to the **Zoho API Console** — <https://api-console.zoho.com> (use `.in`, `.eu`, etc.
   if your account is on another data centre; this must match `ZOHO_DOMAIN`).
2. **Add Client → Self Client → Create**. Copy the **Client ID** and **Client Secret**.
3. Open the **Generate Code** tab on that client and enter:

   **Scope**
   ```
   ZohoProjects.timesheets.ALL,ZohoProjects.tasks.ALL,ZohoProjects.projects.READ,ZohoProjects.portals.READ,ZohoProjects.users.READ,ZohoPeople.attendance.READ,ZohoPeople.forms.READ
   ```

   **Time Duration**: 10 minutes. **Scope Description**: anything.

4. Click **Create**, pick your portal, and copy the generated **code**. It expires in
   minutes — do the next step immediately.

5. Exchange the code for a refresh token:

   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=THE_GENERATED_CODE"
   ```

   The response contains `refresh_token` (long-lived — this is the one you store) and
   `access_token` (one hour — the server refreshes this itself from here on).

   > A grant code can only be exchanged **once**. If you get `invalid_code`, generate a
   > fresh code and retry.

### 3. Find your portal id and user id

With a valid access token:

```bash
curl -H "Authorization: Zoho-oauthtoken ACCESS_TOKEN" \
  "https://projects.zoho.com/restapi/portals/"
```

Take `portals[].id` → `ZOHO_PORTAL_ID`.

Then, for your own user id:

```bash
curl -H "Authorization: Zoho-oauthtoken ACCESS_TOKEN" \
  "https://projects.zoho.com/restapi/portal/PORTAL_ID/users/"
```

Find the entry with your email; its `id` (the zpuid) → `ZOHO_USER_ID`.

### 4. Configure

```bash
cp .env.example .env
```

Fill in the five required values. Set `ZOHO_DOMAIN` if you are not on `.com`.

### 5. Smoke-test before wiring it to Claude

```bash
node dist/index.js
```

It should print startup lines on stderr and then sit waiting on stdio. Ctrl-C to exit.
If the portal date format line appears, auth and portal access are both working.

## Connect it to Claude

### Claude Desktop

`claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "zoho-timesheet": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\Desktop\\Office\\Timesheet-MCP\\dist\\index.js"]
    }
  }
}
```

Use an absolute path. Restart Claude Desktop afterwards. The server reads `.env` from
its own package directory, so you do not need to duplicate the credentials into the
config — though you can, via an `"env"` block, if you prefer.

### Claude Code

```bash
claude mcp add zoho-timesheet -- node /absolute/path/to/dist/index.js
```

> Claude.ai (web) connects to *remote* MCP servers over HTTP, not local stdio ones. To
> use this from the web app you would need to front it with the SDK's HTTP transport and
> host it somewhere reachable. Desktop and Code work as-is.

## Using it

> "Log 3 hours to the ClientCo audit prep task for yesterday, note: reviewed Q3 ledgers"

> "Did I log any time last week?"

> "Show me everything I logged Monday, with the entries"

When a name is ambiguous you will get a list back rather than a write:

```
"audit prep" is ambiguous — nothing was logged. Ask the user which of these
they meant, then call log_time again with that task_id:
[ { "task_id": "…", "task_name": "Q3 audit prep — ClientCo", "score": 0.88 },
  { "task_id": "…", "task_name": "Q2 audit prep — ClientCo", "score": 0.86 } ]
```

Use `dry_run: true` on `log_time` to rehearse against a live portal without writing.


## Deploying for a team (multi-user OAuth)

Everything above describes the **single-account** setup: one person, one `.env`, run
locally. For a team, deploy the HTTP server instead — each person connects their own
Zoho account, and every entry is attributed to them correctly. Nobody installs anything.

### How it works

```
Claude  --/authorize-->  this server  --redirect-->  Zoho login
Zoho    --/callback--->  this server  (stores their refresh token, encrypted)
Claude  --/token----->   this server  (PKCE check, issues our own token)
Claude  --/mcp------->   this server  (token -> user -> their Zoho credentials)
```

The MCP client never sees a Zoho token. It gets an opaque token of ours that maps to a
stored, encrypted Zoho refresh token. Each request runs as whoever is calling.

### 1. Register a Zoho application

In the API Console (**api-console.zoho.in** for India), create a **Server-based
Application** — *not* a Self Client this time.

- **Authorized redirect URI:** `https://your-domain/callback`
- Copy the Client ID and Secret

You can register several redirect URIs on one app, so adding a custom domain later does
not mean starting over.

### 2. Deploy

Any host that gives you HTTPS. Railway and Render both work from the included
`Dockerfile` and `railway.json`:

```bash
git init && git add -A && git commit -m "zoho timesheet mcp"
# push to GitHub, then: Railway -> New Project -> Deploy from repo
```

Set these variables on the host:

| Variable | Value |
| --- | --- |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | from the Server-based app |
| `ZOHO_DOMAIN` | `in` (or your data centre) |
| `PUBLIC_URL` | the deployed HTTPS URL, no trailing slash |
| `TOKEN_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | Postgres connection string (Neon/Supabase free tier is fine) |

The service-account variables (`ZOHO_REFRESH_TOKEN`, `ZOHO_PORTAL_ID`, `ZOHO_USER_ID`,
`ZOHO_TIMELOG_OWNER_ID`) are **not needed** in this mode.

> **User connections live in Postgres**, not on disk, so the service can run on a host
> with an ephemeral filesystem (Render free tier included) without logging everyone out
> on redeploy. The schema is created automatically at boot.

> **Keep `TOKEN_ENCRYPTION_KEY` safe and unchanged.** Rotating it makes every stored
> refresh token undecryptable — same outcome.

Check it came up in the right mode:

```bash
curl https://your-domain/healthz
# {"ok":true,"mode":"oauth",...}
```

If that says `single-account`, one of `PUBLIC_URL` / `TOKEN_ENCRYPTION_KEY` is missing.

### 3. What each person does

Claude Desktop or claude.ai → **Settings → Connectors → Add custom connector** →
paste `https://your-domain/mcp` → **Connect** → Zoho login → done.

Claude Code:

```bash
claude mcp add --transport http zoho-timesheet https://your-domain/mcp
```

No Node, no files, no tokens to copy. Updates are a redeploy; nobody reinstalls.

### Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | The MCP endpoint. Bearer token required. |
| `GET /healthz` | Liveness + which mode it booted in |
| `/.well-known/oauth-protected-resource` | Tells clients where to authenticate |
| `/.well-known/oauth-authorization-server` | OAuth metadata |
| `POST /register` | Dynamic client registration |
| `GET /authorize` → `GET /callback` | The Zoho hand-off |
| `POST /token` | Code and refresh-token grants (PKCE, S256, mandatory) |
| `POST /revoke` | Token revocation |

### Security notes

- Refresh tokens are encrypted at rest with AES-256-GCM; the store file contains no
  plaintext credentials.
- PKCE (S256) is required — authorization requests without it are rejected.
- Authorization codes are single-use and expire in 5 minutes; access tokens last an hour.
- To disconnect someone, delete their user record; that also revokes every token issued
  to them.
- Users who connected before a scope change are repaired on their next request rather
  than being forced to reconnect — see `backfillPortalUserId`.
- The server is stateless per request and the store is Postgres, so it scales
  horizontally without further work.

### Honest limitations

- **The portal user id lookup is the one untested leg.** It needs
  `ZohoProjects.users.READ`, which is in the scope list, but could not be exercised
  against the live portal because the development token predates that scope. The code
  degrades safely: if the lookup fails, sign-in still works and only per-user timesheet
  filtering is affected.
- **Custody.** You are holding 100 people's Zoho refresh tokens. Get the deployment
  reviewed before it goes live.

## Optional: filling the timesheet from Zoho People attendance

Skip this if your organisation does not use Zoho People. Both tools are read-only.

### What it does

`get_attendance` reads your first check-in, last check-out and worked hours for a date
range. `plan_timesheet_from_attendance` goes further: it subtracts what you have
already logged in Zoho Projects and reports the shortfall per day, together with your
task list.

Neither tool writes anything. Attendance knows how long your day was; it cannot know
what the time was spent on. Splitting a day across tasks on your behalf would put
invented work into a system of record, so the plan stops at the point where a human
decision is needed and you are asked which task each day belongs to. You then confirm,
and `log_time` files it.

Hours come from People's own `TotalHours`, **not** from check-out minus check-in. That
span includes lunch and every other break, and logging it would overstate most days by
about an hour.

### Setup

1. Add `ZohoPeople.attendance.READ,ZohoPeople.forms.READ` to the scope list when you
   generate your token (they are already in the list under [Setup](#setup)). A token
   minted before these scopes existed keeps working for everything else and fails on
   these two tools with a message telling you to reconnect.
2. Nothing else in OAuth mode — your People employee record is found from the email on
   your connected account.
3. In single-account mode only, set `ZOHO_PEOPLE_EMPLOYEE_ID`, since a service account
   has no email to look up.

### Caveats

- **Employee id is a third id space.** People uses an employee record id, which is
  neither the `zpuid` that owns tasks nor the `600...` id that owns timelogs. Email is
  the bridge, so a mismatch between your People and Projects emails needs
  `ZOHO_PEOPLE_EMPLOYEE_ID` set by hand.
- **Not verified against a live People account.** The Projects side of this server was
  built against the real portal; the People endpoints and their response shapes come
  from the documentation. Field-name fallbacks are in place, but expect the first run to
  need a correction.
- **On-demand only.** Nothing runs on a schedule. The tools fire when you ask for them.

## Optional: importing from Omi

Skip this section entirely if you do not use Omi. Nothing here is required, no extra
environment variables exist for it, and the tool cannot write to Zoho.

### What it does

`import_omi_conversations` takes a raw Omi conversations JSON export and returns a
**draft**: for each conversation, the computed duration, the calendar day, and the Zoho
task it appears to correspond to. It then splits the results three ways.

| Bucket | Meaning |
| --- | --- |
| `suggested_entries` | Confidently matched, rolled up to one entry per task per day. Safe to file after you eyeball them. |
| `needs_review` | Ambiguous or unmatched. **Excluded from `suggested_entries` on purpose** — these must be resolved one at a time. |
| `skipped` | Discarded in Omi, too short, or missing timestamps. Each carries a reason. |

Filing is always a separate, explicit step: you approve entries, and Claude then calls
`log_time` once per approved entry with its `task_id`. There is no path by which this
tool writes to Zoho on its own, and the "file all" shortcut can only ever reach
`suggested_entries`.

### Where to get the JSON

Either of these works:

- **In-app export** — Omi app → **Settings → Data / Privacy → Export conversations**. This
  produces a JSON file; paste its contents, or hand Claude the file.
- **API** — `GET https://api.omi.me/v2/conversations?limit=100` with your Omi API key:

  ```bash
  curl -H "Authorization: Bearer YOUR_OMI_API_KEY" \
    "https://api.omi.me/v2/conversations?limit=100" > omi-week.json
  ```

  Keys come from the Omi developer settings. Check the current endpoint against Omi's
  docs — their API has changed shape across versions.

The parser is deliberately tolerant. It accepts a bare array, or an object wrapping the
list under `conversations`, `memories`, `results`, `data`, or `items`. Per conversation
it reads `structured.title` / `structured.overview` / `structured.category` where present
and falls back to top-level `title` / `summary` / `category`. Timestamps may be ISO
strings or epoch seconds/milliseconds. When `finished_at` is missing it derives the
duration from the last transcript segment's end offset.

### Options

| Input | Default | Why |
| --- | --- | --- |
| `min_minutes` | 5 | Omi captures a lot of short noise not worth a timesheet line. |
| `round_to_minutes` | 15 | Timesheets are not stopwatches. 0 keeps exact durations. |
| `utc_offset_minutes` | 0 | Decides which calendar day a conversation lands on. **Pass 330 for IST**, or your evening conversations will be filed to the previous day. |
| `include_others` | false | Match against the whole portal's tasks rather than just yours. |

### Typical use

> "Here's my Omi export for last week — draft timesheet entries from it, I'm in IST"

Claude calls the tool with `utc_offset_minutes: 330`, shows you the day-by-day draft,
and then files only what you approve.

### Caveats

- **It matches on the conversation title**, which is Omi's summary of what you talked
  about — not necessarily what you worked on. A conversation *about* the Q3 audit is not
  proof you spent that hour on the Q3 audit. Read the drafts.
- **The matcher errs toward review.** A title like "Q3 audit prep continued" against
  tasks "Q3 audit prep" and "Q2 audit prep" lands in `needs_review` rather than guessing,
  even though a human would pick the Q3 one. That is the intended bias.
- **Overlapping conversations are not deduplicated.** If Omi recorded two overlapping
  sessions, their hours both count. Check any day whose total looks too high.
- **Rounding is applied per conversation, then summed**, so six 8-minute conversations on
  one task become 6 × 0.25h = 1.5h, not 0.75h. Lower `round_to_minutes` if that matters.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `invalid_client` on startup | Client id/secret belong to a different data centre than `ZOHO_DOMAIN`. |
| `invalid_grant` / `invalid_code` | Refresh token revoked, or the grant code was already exchanged. Generate a new one. |
| 401 on every call, refresh works | `ZOHO_DOMAIN` mismatch — the token is DC-bound. |
| `get_my_tasks` returns nothing | `ZOHO_USER_ID` is not the zpuid, or you have no open tasks. Try `include_others: true` to confirm the portal is reachable. |
| Timelog rejected with code 6834 | Task is closed, or timesheet entry is restricted for this user on that project. |
| Dates land one day off | Portal date format is not one this server could parse; it fell back to `MM-dd-yyyy`. Check the startup line on stderr. |

## Known limitations

- **Timesheet approval workflows are not handled.** If your portal requires timesheets
  to be submitted and approved, entries created here land as unsubmitted logs; you still
  submit them in the UI. A `submit_timesheet` tool would be the next thing to add.
- **Single service account.** Every entry is attributed to `ZOHO_USER_ID`. This is not
  multi-user; pointing two people at one instance would misattribute their time.
- **No `update_time_log`.** Delete and re-log instead.
- Time is only logged against **tasks**, not bugs/issues or general logs.
- The Omi importer is **read-only by construction** — it has no code path to Zoho writes.
  It also does not fetch from Omi; you supply the JSON.
