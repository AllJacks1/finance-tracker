# Real-device test checklist

Automated tests run in Chromium with an emulated phone viewport and a **mocked** Network Information
API. They cannot prove real Wi-Fi/cellular detection, iOS behaviour, safe areas or the keyboard.
Run this on real hardware against the deployed (HTTPS) app before calling a phase complete.

Record: device, OS version, browser, date, pass/fail, notes.

## Android — Chrome (and installed PWA)
- [ ] Install: browser menu → *Install app* (or the install prompt). Icon and name look right; opens standalone, status bar colour matches.
- [ ] Sign in (first time with a temporary password → forced change).
- [ ] On **Wi-Fi**: the sync chip shows *Synced* without tapping anything.
- [ ] Turn Wi-Fi off, mobile data on: add a transaction → chip shows **Paused – Mobile data**, count 1. Wait 2 minutes: still not synced (check on another device).
- [ ] Tap *Sync now* → the data-charges warning appears; *Not now* keeps it pending; *Sync anyway* syncs.
- [ ] Turn Wi-Fi back on with a pending change → syncs automatically within ~1 minute.
- [ ] Set an offline PIN (Security). Airplane mode → close the app fully → reopen → lock screen → PIN → data visible.
- [ ] In airplane mode: add, edit and delete transactions; add an account; view budgets and dashboard.
- [ ] Reboot the phone while still offline with pending changes → reopen → changes still there → reconnect on Wi-Fi → synced, no duplicates.
- [ ] Wrong PIN 5× → wait message appears.
- [ ] Inputs don't zoom the page; amount fields show a decimal keypad; bottom bar clears the gesture bar.

## iPhone — Safari and Home Screen app
- [ ] Safari → Share → *Add to Home Screen*. Launch from the icon (standalone).
- [ ] Note: Safari and the Home Screen app have **separate storage** — sign in and set a PIN in the app itself.
- [ ] Chip shows **Paused – Connection unknown** (iOS never reports Wi-Fi). *Sync now* shows the warning and syncs on confirm.
- [ ] Airplane mode → close app (swipe away) → reopen → PIN → data visible and editable.
- [ ] Content isn't hidden under the notch / home indicator; dark mode looks right.
- [ ] After a new deployment: reopen the app → *A new version is available* → Update.

## Desktop Chrome/Edge
- [ ] Install from the address bar. Chip shows *Paused – Connection unknown*; manual sync works.
- [ ] Two different users on the same browser profile cannot see each other's data (sign out → keep data → sign in as the other user).

## Admin
- [ ] Administration pages work on the phone; admins see no financial data of other users.
- [ ] Revoke a phone from Security → Devices on another device → the phone, when next online, is signed out and its local data removed.

## Phase 2 (both phones)
- [ ] Bills: add a monthly bill; pay part of it, then the rest → *Partially paid* → *Paid*; payment history shows both.
- [ ] Airplane mode: pay a bill partly, confirm a scheduled salary, add a card purchase → reconnect on Wi-Fi → everything syncs once (check on a second device: no duplicates).
- [ ] Same occurrence confirmed on two phones while both offline → after both sync there is **one** transaction (or a visible conflict if amounts differ).
- [ ] Credit card: purchase increases what you owe; payment from a bank account lowers it and is **not** counted as spending in budgets.
- [ ] Loan payment splits into principal and interest; the loan balance drops by the principal only.
- [ ] Emergency fund: switch target 3 / 6 / 9 / 12 months → coverage and target update.
- [ ] Calendar month view: tap a day with dots → its items; cash-flow chart scrolls/zooms well on the phone.
- [ ] CSV import: pick a bank CSV from Files/Downloads, map columns, import; import the same file again → rows marked *already imported*.
- [ ] Bill receipt: attach a photo from the camera to a bill; view it online.
- [ ] Notifications (Android Chrome / installed app): More → Notifications → *Turn on push* → allow. With a bill due, wait for the 08:00 reminder (or run the `reminders` service) → notification arrives; lock-screen text is generic; tapping opens Bills.
- [ ] Notifications (iPhone): push works **only** from the Home Screen app on iOS 16.4+; in Safari the page says push isn't supported.
- [ ] Sign out → push stops for that phone; another user signing in on that phone doesn't get the first user's reminders.
