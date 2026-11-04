# Quizzy — Live Trivia (development branch)

Quizzy is a new live trivia game under `live.12one.page`, built to coexist with Shark Tank using the **same existing Supabase project**.

## Current status

**Code is committed but not activated.** This branch is separate from `main`. No Supabase SQL has been executed, and no browser-to-database end-to-end test or 100-player load test has been performed. Do **not merge** until setup and validation succeed.

## Pages

- `quizzy.html`: nickname + six-digit PIN + team joining
- `quizzyplay.html`: mobile participant interface
- `quizzyhost.html`: private-code host console, session creation and management
- `quizzyedit.html`: quiz editor and library, imports/exports, sharing and duplication
- `quizzyprojector.html`: QR-enabled projector, live questions and podium
- `quizzyresults.html`: results page
- `quizzycore.js`: Supabase-backed client logic, shared across pages
- `quizzystyles.css`: Quizzy styling using the 12one red-primary palette and Montserrat
- `quizzy-schema.sql`: isolated Quizzy migration and RPC (safe for existing Shark Tank tables, but still review before executing)

All pages reference the existing `sharkconfig.js`, containing the **publishable** key and URL. No service-role key should ever be placed in frontend code.

## One-time Supabase setup

1. Open the **existing Shark Tank** project in Supabase.
2. Verify that **anonymous sign-ins** are enabled under Authentication. Shark Tank already relies on them.
3. Open SQL Editor. Review and run `quizzy-schema.sql` **once**. It creates `quizzy_` tables, row-level security, a controlled `quizzy_api` RPC and a signal table for Realtime. The migration does not write to `st_` tables.
4. **Separately and privately** create the first host by running this SQL in the editor; replace the sample with a new strong secret code, and never commit the chosen code:

```sql
insert into public.quizzy_hosts(label,code_hash)
values ('Administrator', extensions.crypt('YOUR_NEW_PRIVATE_QUIZZY_HOST_CODE_12_PLUS_CHARACTERS',extensions.gen_salt('bf')));
```

5. Confirm database function `quizzy_api` exists, and that `quizzy_signal` is included in the `supabase_realtime` publication.
6. To enable a second host, sign in using the administrator code and call the RPC through an approved admin client, or insert a second bcrypt-hashed code with a new non-Administrator label via SQL Editor. **Do not reuse the Shark Tank administrator code.**
7. Test this branch through a **separate preview** (not production GitHub Pages main). This branch alone does not automatically deploy to `live.12one.page`.
8. Test two separate browser profiles / devices, start a quiz, answer questions, cancel one, pause/resume, test team scoring, remove a player, export CSV, edit a saved quiz while a session is active, and verify the snapshot remains stable.
9. Run a load test with up to 100 connected clients to validate Realtime and database limits before calling the system event-ready.

## Host workflow

1. Open `quizzyhost.html`; enter your Quizzy host code.
2. Create a quiz in `quizzyedit.html`, then return to the host dashboard.
3. Create a new six-digit-PIN session; choose teams, scoring, phone display, and answer randomization.
4. Open `quizzyprojector.html?pin=123456` on the projector.
5. Participants join at `quizzy.html?pin=123456`, or via QR.
6. Host starts questions, reveals answers, shows rankings, and ends the game.
7. The host exports CSV/JSON results and can reopen previous sessions.

## Quiz formats

- Single-select, True/False, multiple-select (all-or-nothing or partial credit), poll, numeric with absolute tolerance.
- Per-question duration (5–300 seconds), point value, explanation.
- Per-game scoring: accuracy, speed bonus, optional streak bonus, solo or team, sum or average team scores.
- Questions are frozen into each session when it is created; future edits affect only future sessions.

## CSV import

Use a CSV with headers:

`question,type,options,correct,seconds,points,multi_scoring,value,tolerance,explanation`

For the `options` and `correct` cells, separate items with a pipe (`|`). Types are `single`, `tf`, `multi`, `poll`, `numeric`. For example:

```csv
question,type,options,correct,seconds,points,multi_scoring,value,tolerance,explanation
"Which planet is red?",single,"Mars|Earth|Jupiter","Mars",30,1000,all,,,"Mars is commonly called the Red Planet."
"How many continents?",numeric,,,30,1000,all,7,0,"Seven commonly recognized continents."
```

## Security notes

Quizzy is an **event-grade code-access system**, mirroring Shark Tank's design. Each host has a private bcrypt-hashed code checked server-side. This is simpler than full host account authentication, but possession of a host code grants that host's privileges. Host codes must be securely distributed and rotated if compromised.

All quiz data and answer records are accessed via the `quizzy_api` security-definer function. Direct table access is blocked by RLS. The public state endpoint withholds answer keys until reveal, and answer submission uses the authenticated anonymous Supabase user ID, a server-side deadline, and a unique-answer constraint. Players can resume from the same browser session only.

The current product is a **first implementation**, not a verified production release. Remaining validation includes SQL execution, real browser tests and load testing. For complex production use, a server-authoritative broadcast service, more thorough scoring revision history and stricter host credential rate limits are recommended.
