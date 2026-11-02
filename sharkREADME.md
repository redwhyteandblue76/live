# Shark Tank Night — GitHub Pages + Supabase

A first functional implementation for one active event, with multiple investors and a separate rehearsal mode. No Google Apps Script required.

## Files

- `sharkindex.html` — landing page
- `sharkpresentation.html` — public projector, business history, investor panels, end-of-event summary
- `sharkhost.html` — protected host console, business ordering, invites, offer controls, reports
- `sharkinvestor.html` — invitation-code login, portfolio, offer submissions and withdrawals
- `sharkvote.html` — one audience vote per Supabase anonymous user per mode
- `sharkstyles.css` — navy/blue styling
- `sharkcore.js` — Supabase connection, shared state and real-time refresh
- `sharkconfig.js` — public Supabase credentials
- `schema.sql` — PostgreSQL schema and restricted RPC functions

## Installation (fresh Supabase project recommended)

1. Create a new project at [Supabase](https://supabase.com/dashboard). **Use a separate project from your existing games.**
2. Open **Authentication → Providers** and enable **Anonymous Sign-ins**. Without this, investors and voters cannot use the app. No email/password signup is needed.
3. In `schema.sql`, replace `CHANGE-THIS-ADMIN-CODE` with a unique secret admin passphrase. Avoid quotes in the code unless SQL escaped. Keep this code private.
4. Paste the entire `schema.sql` into **SQL Editor**, then run it **once on a fresh project**. The SQL creates the database, constraints, restricted API function and live-change publication.
5. In **Project Settings → API**, copy the **Project URL** and **publishable/anon key** into `sharkconfig.js`. **Never use the service_role / secret key in browser files.**
6. Upload all files **except `schema.sql`** (optional to keep privately) to a GitHub repository. For public repositories, keeping schema.sql is fine technically, but DO NOT publish an admin code that you intend to use. Best practice: remove `schema.sql` from the published repo after applying it or keep it in a private setup folder. Importantly: if the SQL file has your real admin code, rotate it before publishing.
7. In the GitHub repository, enable **Settings → Pages → Deploy from branch**, selecting your branch and `/ (root)`.
8. Open `https://YOUR-USERNAME.github.io/YOUR-REPO/sharkhost.html` and enter the private admin code.
9. Add investors, make rehearsal businesses, send investors their generated links, and check `sharkpresentation.html` in another browser.
10. When ready, switch to **LIVE mode**, set up business ideas, publish the first one, and open offers.

## Typical event workflow

1. Host creates businesses and orders them with drag-and-drop.
2. Host adds investors and copies each unique private link. An investor can log in on multiple devices using the same code; portfolios are attached to the investor profile, not the anonymous device identity.
3. Host publishes a business to the projector; then opens the business for offers.
4. Investors submit an offer. A revised offer withdraws the previous pending offer automatically. Offers appear on the public presentation and host dashboard.
5. Host accepts or rejects. Accepted offers subtract from the investor's budget; the host can undo an acceptance.
6. Host closes the pitch, selects the next business, and repeats.
7. Audience members visit `sharkvote.html` to vote; they can change their choice on the same anonymous account.
8. At the end, open the Event Summary on the projector and export CSVs from host Settings.

## Live updates

Supabase broadcasts changes to the small `st_signal` table; clients then fetch fresh, authoritative state from the database RPC. They also reconnect/refetch on tab focus and every 30 seconds as fallback. A button performs an immediate manual refresh. There are **no periodic Apps Script calls**.

## Security and operational notes

- Only the public signal table is directly readable. All application data is accessed via a narrow `st_api` RPC function with server-side code checks. RLS is enabled on all tables.
- This is **event-grade code access**, not strong identity verification. Anyone who possesses an investor code can act as that investor; anyone with the admin code can control the event. Share those codes privately.
- Anonymous Supabase sessions are created in the background. Logging out of the app clears the local investor code, but doesn't delete the browser's anonymous Supabase session. Codes can be reused on a different browser/device.
- Audience votes are per anonymous Supabase user, so a person with several browsers/devices can cast multiple votes. For a casual event, this is an acceptable limitation; stronger deduplication would need more identity friction.
- Rehearsal data and live data are separated for businesses, offers and votes. **Investor profiles and budget settings are shared** between both modes. All browser pages follow the selected mode.
- Investor personality titles are editable from their dashboard.
- A valid invitation code gives the ability to submit offers for that investor. This deliberately avoids traditional login accounts but is weaker than credential-bound sessions.
- The HTML pages are designed for Chrome, Edge, Safari, and mobile browsers. Supabase connectivity is required.
- Some browser extensions or privacy settings can block third-party CDN scripts. To make deployment self-contained, vendor the Supabase JS bundle if needed.
- Free Supabase projects can pause after inactivity. Test the site and live subscriptions before the event.
- Changes to the SQL should be treated as versioned migrations, not repeatedly run against an existing project without review.

## Verification checklist

- [ ] Anonymous sign-in enabled; browser reports no Auth errors.
- [ ] Rehearsal business shows on host and projector.
- [ ] Investor link opens and dashboard loads.
- [ ] Same code on two browsers shows the same portfolio.
- [ ] An offer appears on the projector and host page automatically.
- [ ] Accepting an offer subtracts money; undo restores it.
- [ ] An over-budget offer fails.
- [ ] Pausing disables new investor offers.
- [ ] Switching modes hides rehearsal offers from live mode.
- [ ] Audience vote counts update in host History.
- [ ] Live closing summary and CSV export work.

## Known limitations / follow-up improvements

- The current host UI uses a single admin passphrase and prompts for some actions. It doesn't include a password reset flow; change the admin hash through the SQL Editor if needed.
- The presentation history selector is controlled locally in the projector browser. Admin publishing changes the underlying active business, but if the projector has manually selected an old history entry, click **Follow Live** to resume.
- The app is a functional starter implementation, not a tested production deployment. Execute the checklist with your actual Supabase project before using it at an event.
