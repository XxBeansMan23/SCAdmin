# SCAdmin

A private admin panel **and team chat** for a small group of devs, testers and friends: member profiles, crews, per-game stat editing, moderation, cloud saves, and a Slack-style chat with channels, DMs and file sharing.

> Independent hobby project. Not affiliated with, endorsed by, or connected to Rockstar Games. It only manages the accounts and data you create inside your own SCAdmin instance.

Zero dependencies: just Node 20+ (no `npm install`).

## Features

| Area | What it does |
|---|---|
| **Chat** | Channels (`#general`, `#dev`, `#testers`, `#bugs`, `#builds`), private channels, DMs, file/build/screenshot sharing, unread badges, edit/delete |
| **Members** | Profile, team tag (Dev / Tester / QA…), linked accounts, admin notes, roles, password reset, sign-out-everywhere |
| **Support Logs** | Per-member audit trail (Profile / Email / Security / Nickname / Password / Stats / Moderation) |
| **StatMaster** | Edit rank, cash, kills etc. per game. A reason is mandatory and every change is logged |
| **Moderation** | Suspend / ban with reason and expiry, flag queue, report from crews |
| **Crews** | Leader + ranks, add/remove, transfer leadership |
| **Cloud Saves** | Upload and download save files per member |
| **Storage** | No upload size limit (streamed to disk). Optional **Google Drive storage**: Owner tools -> Google Drive storage (see below) |
| **Audit log** | Global searchable log of every change |

Add games or stat fields in the `GAMES` array at the top of `server.js`.

### Google Drive storage (local Node server)

Uploads (chat files, clips, cloud saves) can go to **your Google Drive** instead of the server's disk. The owner sets it up in **Owner tools -> Google Drive storage**; credentials are typed into that page and saved to `data/drive.json` (git-ignored), never sent anywhere but Google.

1. console.cloud.google.com -> new project -> **APIs & Services -> Library** -> enable **Google Drive API**.
2. **OAuth consent screen**: External, add an app name and your email, and set **Publishing status -> In production** (in "Testing" Google expires the sign-in after 7 days; `drive.file` needs no verification).
3. **Credentials -> Create credentials -> OAuth client ID**, type **"TVs and Limited Input devices"**. Paste the client ID and secret into Owner tools.
4. Click **Connect Google Drive**, open google.com/device, enter the code, pick your account, Allow.

SCAdmin only gets the `drive.file` scope, so it can see only files it created itself (in a folder called *SCAdmin Files*), never the rest of your Drive. Every upload, any size, streams through the server to Drive as a chunked resumable upload (8 MiB chunks, each retried on network/5xx errors, no `Content-Length` needed, about one chunk of memory per upload); downloads support Range requests, so videos still seek. The card has **Test connection** (uploads, reads back and deletes a 4 KB file) and **Move them to Drive**, which moves everything still on the server's disk into Drive in the background. **Pause** or **Disconnect** sends new uploads back to local disk, and if Drive is unreachable at the moment of an upload, that one file is kept locally and can be moved later.

### Permissions (local Node server)

The **owner** (the first account) can do everything. Everyone else, admins included, starts with none of these and only gets them when the owner ticks them in **Owner tools**:

| Permission | Lets the person |
|---|---|
| Channels | create and delete channels |
| Delete msgs | delete any chat message (editing your own message is always allowed) |
| See emails | see and change other accounts' email addresses (everyone always sees their own) |

Hidden emails are redacted on the server everywhere (member lists, profiles, search, email history, audit logs), not just in the UI. **Owner tools** also has sign-ups on/off, an announcement banner, role changes, delete account, sign-out-everyone and a JSON backup. Chat plays videos (mp4/webm/mov) inline with seeking instead of downloading them.

These permissions are not implemented in the Supabase/Pages variant.

## Run it

```bash
node server.js          # http://localhost:8080
```

First run prints a one-time **setup code** in the console. Open the site, enter the code and create the owner account. Then add people from **Members → Add member** and give them a temporary password.

Environment variables: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR` (./data), `SETUP_CODE` (use a fixed first-run code on a host where you cannot read the console).

## Hosting on GitHub Pages (+ Supabase)

The UI lives in `docs/` and is served by **GitHub Pages**. Pages only serves files, so accounts, chat, uploads and logs are stored in a free **Supabase** project (Auth + Postgres with row-level security + Storage). `docs/supa-api.js` maps the UI's calls onto Supabase.

One-time setup:

1. Create a free project at supabase.com.
2. **Authentication -> Providers -> Email -> turn OFF "Confirm email"** (SCAdmin logs in by nickname, not a real inbox).
3. **SQL Editor -> New query**, paste all of `supabase/schema.sql`, Run. The result grid at the end shows your **setup_code** and **invite_code**.
4. Put the project URL and the **anon public** key (Project Settings -> API) into `docs/config.js`. The anon key is meant to be public: it can only do what the row-level-security rules allow. **Never** use the `service_role` key.
5. Repo **Settings -> Pages -> Source: Deploy from a branch -> `main` / `/docs`**.
6. Open the site, **Create account** with the setup code (you become the owner). Give friends the site link and the invite code (Members page -> Invite friends).

Limits of this mode: no admin-created accounts (people sign up with the invite code), sign-ins don't record IP addresses, Supabase free tier = 1 GB storage / 50 MB per file (SCAdmin caps at 25 MB) and projects pause after a week of no activity.

## Running the local Node server instead

`node server.js` with an empty `docs/config.js` serves the same UI backed by `data/` on your own PC (see above). It can also run in GitHub Codespaces (`.devcontainer`) or on any always-on Node host (`DATA_DIR`, `SETUP_CODE`).

## Security notes

- Passwords are hashed with scrypt; sessions are HttpOnly + SameSite=Strict cookies; sign-in is rate limited; state-changing calls require a custom header.
- There is no built-in HTTPS. Use a host or tunnel that terminates TLS before exposing it to the internet.
- Everything lives in `data/` (JSON + uploaded files). It is git-ignored: **never commit it**. Back it up yourself.
- Chat is not end-to-end encrypted; the server owner can read everything in it.
