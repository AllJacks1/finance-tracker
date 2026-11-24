# Phase 2 Implementation Plan — Complete Financial Management

Status: **Approved** (Q1–Q7 defaults; Q8 changed: user chooses 3/6/9/12 months, see below). Implementation in progress.

---

## 0. Where Phase 1 stands (review summary)

| Area | Current state | What Phase 2 builds on |
|---|---|---|
| Ledger | `transactions` header + derived `transaction_entries`. Balances are always derived. Five types: income, expense, transfer, refund, adjustment. | Unchanged. Every new module records real money movement **only** through ordinary transactions. |
| Accounts | Types include `credit_card` and `loan` (liabilities; negative balance = owed). | Cards and debts become detail profiles attached to these existing liability accounts. |
| Obligations / reserves | `allocations` (reserve \| obligation). Payments link via `transactions.allocation_id`. Safe-to-Spend subtracts what's outstanding. | Superseded by Bills and Goals (see Q1). |
| Sync | Outbox → `/api/sync/push` (idempotent by `opId`, version conflicts, savepoint per op) → `/api/sync/pull` (by `change_seq`). Entity registry in `server/sync/entities.ts`. | New entities plug into the registry. Two backward-compatible protocol additions (§3). |
| Security | Ownership in the app + RLS (`FORCE`) + composite FKs; `ft_app` has no DELETE on financial tables. | Every new table gets the same three layers, plus tests. |
| Offline client | Encrypted per-user IndexedDB, coalescing outbox, Wi-Fi-only auto sync, PIN vault. | New entities are generic records, so no client storage changes are needed. One new `mutateGroup` (atomic multi-record change). |
| PWA / UI | Static `/app/*` shells precached by the service worker; bottom nav: Home · Activity · ＋ · Budgets · More. | New static pages are added to the precache list. |
| Deployment | **Not deployed yet.** Railway config for web + backup cron. | Adds one more cron service (reminders) and VAPID env vars. |

Because Phase 1 has **no production data yet**, restructuring obligations/reserves now is low-risk. The migration still converts existing rows correctly and is tested.

---

## 1. Core design decisions

| # | Decision | Why |
|---|---|---|
| P1 | **The ledger stays the single source of truth for actual balances.** Bills, schedules, goals, card statements and debt plans are metadata layers. They link to transactions but never move money themselves. | Phase 1 balance, budget and Safe-to-Spend logic keeps working unchanged, and double counting is structurally hard. |
| P2 | **Scheduled occurrences are computed, not generated.** A recurring rule produces *virtual* occurrences on the fly (pure function, same on server and client). Nothing is created until you confirm, pay, skip or edit one. | No background job means nothing to duplicate after restarts, offline/online transitions, multiple devices or repeated requests. |
| P3 | **Deterministic IDs for materialized occurrences:** `uuidv5(scheduleId + occurrenceDate + kind)`, backed by DB unique indexes `(workspace_id, schedule_id, occurrence_date)`. | Two devices confirming the same occurrence offline produce the *same* id. The server accepts one and the other becomes "duplicate" (identical data) or a visible conflict (different data). Duplicates are impossible at the database level. |
| P4 | **Three explicit states:** *scheduled* (virtual, future), *needs confirmation* (date reached, not yet confirmed), *completed* (a real transaction exists). Scheduled items never change actual balances. | Meets "must not reduce the actual balance until paid or confirmed". |
| P5 | **Bills are the single obligation mechanism.** Card payment dues and loan installments are bills linked to the card/debt. The calendar and Safe-to-Spend read obligations only from bills, so the same obligation is never listed twice. | Avoids counting a card due date, a card bill and a scheduled payment as three things. |
| P6 | **Atomic groups in the sync protocol.** Ops sharing a `groupId` are applied all-or-nothing in one savepoint (e.g. loan payment = principal transfer + interest expense). | Multi-record financial operations stay atomic, including those created offline. |
| P7 | **Immutable records** (net-worth snapshots): the server refuses updates; creating the same deterministic snapshot twice keeps the first. | Past snapshots are never silently rewritten. |

---

## 2. Modules and accounting rules

### 2.1 Bills
- **Bill** = one obligation instance: name, category, expected amount, actual amount (once known), due date, payment account, notes, kind (`general` \| `card_payment` \| `loan_installment`), optional link to a recurring schedule, card, or debt.
- **Payments are ordinary transactions** carrying `bill_id`: an expense (normal bill) or a transfer (card or loan payment). Multiple and partial payments are just multiple linked transactions.
- **Derived values:**
  - amount due = actual ?? expected
  - paid = Σ linked live payments
  - outstanding = max(due − paid, 0)
- **Status** is derived, never stored, except *cancelled*:

  | Condition | Status |
  |---|---|
  | cancelled | Cancelled |
  | paid ≥ due | Paid |
  | 0 < paid < due | Partially paid |
  | due date < today | Overdue |
  | due date = today | Due today |
  | otherwise | Upcoming |

  Deleting or restoring a payment updates the status automatically.
- **Recurring bills:** a schedule with kind `bill`. Occurrences stay virtual until acted on. Entering the actual amount, paying, attaching a receipt or cancelling materializes that occurrence with its deterministic id.
- **No double counting:**
  - The payment transaction is the only thing that affects balances and budgets.
  - The bill is the only thing that counts as an *outstanding obligation*.
  - Once paid, it no longer reduces Safe-to-Spend.
- **Payment history:** the bill detail page lists its linked transactions and receipts.

### 2.2 Recurring and scheduled transactions
- **Schedule** = rule + template: income / expense / transfer; amount, accounts, category, description, tags.
- **Frequencies:** once (one-time scheduled), daily, weekly, biweekly, monthly, yearly, custom (every N days, weeks or months).
- **Fields:** start date, optional end date or occurrence count, status (active / paused / cancelled).
- **Date rules:** month-end is clamped but the anchor day is kept (Jan 31 → Feb 28 → Mar 31). Feb 29 yearly falls back to Feb 28. All maths is on calendar dates in the workspace timezone.
- **Actions per occurrence:**
  - **Confirm** creates the real transaction (deterministic id, `schedule_id`, `occurrence_date`), optionally with an edited amount or date.
  - **Skip** records an exception.
  - **Edit this occurrence** records an override.
- **Pause / resume:** while paused there are no new occurrences. Resuming does **not** back-fill the paused period.
- **Edit future occurrences:** the old rule is ended the day before the change and a new rule starts on that date (linked by `previous_schedule_id`). Past confirmed transactions and history are untouched.
- **Cancel:** the schedule stops; confirmed transactions remain.
- **Occurrence history:** confirmed, skipped and overridden occurrences for each schedule.
- **No auto-posting.** Every occurrence needs a one-tap confirmation (Q4).

### 2.3 Savings goals and emergency fund
- **Goal:** name, kind (emergency, travel, education, home, vehicle, purchase, general), target amount, target date, optional linked account, description, status (active / completed / archived).
- **Goal entries:** contributions (+) and withdrawals or reallocations (−) with date and note. These are **earmarks, not ledger entries**: they never change balances or count as expenses.
  - "Contribute" can optionally also record the real transfer (e.g. bank → savings) in the same atomic group. The transfer is a transfer (not spending); the entry earmarks it.
  - Reallocation = a withdrawal from one goal plus a contribution to another in one group.
- **Progress** = allocated / target. Completed when allocated ≥ target (marked, kept in history).
- **Account vs. goals:** for each linked account the app shows balance, allocated to goals, and unallocated. If goal allocations exceed the account balance, it shows a warning.
- **Emergency fund coverage:**
  - Essential monthly expenses = average net spending over the last 3 full months in categories marked **essential**. Food, Transportation, Utilities, Health and Bills & Fees are marked by default (editable), and there's a manual override.
  - Coverage = emergency-fund allocated ÷ essential monthly expenses, shown as months with one decimal.
- **Safe-to-Spend:** goal allocations held in *spendable* accounts are subtracted (that money is earmarked). Allocations in non-spendable accounts (e.g. a savings account) are not, because they were never counted. Unlinked goals are tracked but not subtracted; the breakdown explains this.

### 2.4 Credit cards
Builds on the existing `credit_card` account type (liability).
- **Card profile:** credit limit, statement day, due day (or days after statement), minimum payment rule (% of balance with a floor), interest rate (APR), optional auto-created card bills.
- **Purchase** = expense on the card account. The liability goes up and it counts as an expense (Phase 1 behaviour).
- **Payment** = transfer bank → card. Both balances drop and it is **not an expense** (Phase 1 behaviour).
- **Derived values:**
  - outstanding = −card balance
  - available credit = limit − outstanding − unbilled installment principal (already inside outstanding, so it isn't subtracted twice)
- **Statements:**
  - Cycle dates come from the statement day.
  - The *computed* statement balance is derived from the ledger as of the closing date, minus installment principal not yet billed.
  - Each statement is a `card_payment` bill: expected = computed statement balance; actual = the amount on your bank statement, which takes precedence; minimum due shown.
  - Paying = transfer with `bill_id`. This prevents double counting: purchase = expense (once), bill = obligation (Safe-to-Spend only), payment = transfer (never an expense).
- **Installments** (e.g. 0% 12-month plans):
  - Plan: purchase transaction, principal, months, monthly amount, first billing cycle, fees/interest.
  - The full purchase reduces available credit immediately.
  - Only the monthly amortization is included in each statement bill.
  - Budget treatment: full expense on the purchase date (Q2).
- **Interest and fees:** recorded when they appear on the statement, as expenses on the card ("Interest & Fees" category). Interest is not auto-computed for cards.

### 2.5 Debts and loans
Builds on the existing `loan` account type. Creating a debt creates (or links) its liability account.
- **Debt:** creditor, kind (personal, bank, installment purchase, other), original principal, start date, interest rate, **interest method** (diminishing-balance amortized \| add-on/flat — common for PH consumer loans \| none), payment frequency, minimum payment, due day, term.
  - Outstanding = −account balance.
  - Expected payoff date is projected.
- **Payment** is one atomic group:
  - Transfer bank → loan account for the principal (not an expense).
  - Expense for the interest (counts as spending, "Interest & Fees" category).
  - The suggested split comes from the interest method and is editable to match the lender's receipt.
  - Linked to the installment bill if one exists.
- **Tracking:** principal paid, interest paid, remaining balance, progress %, payment history.
- **Installment schedules:** a debt can generate a `loan_installment` bill schedule (amount, frequency, due day).
- **Snowball vs. avalanche simulator** (pure function):
  - Inputs: debts including credit cards (Q7), each with balance, APR and minimum payment, plus an extra monthly amount.
  - Simulation:
    - Monthly interest is added.
    - Minimums are paid.
    - The extra amount goes to the target debt: smallest balance for snowball, highest APR for avalanche.
    - Freed-up minimums roll over to the next target.
  - Output per strategy: payoff month per debt, total months, total interest.
  - Flags debts whose minimum doesn't cover the interest.
  - Integer centavos (BigInt for the interest multiplication).
  - **Always labelled "Projection — estimate, not a guarantee".**

### 2.6 Financial calendar
- **One merged view (pure function) of:**
  - bills, real and virtual (this includes card dues and loan installments)
  - scheduled/recurring income, expenses and transfers
  - savings contribution targets (from goals with a target date and a suggested monthly amount)
- **Dedupe:** every item has a key (`bill:<id>`, `schedule:<id>:<date>`, …). A materialized occurrence replaces its virtual twin.
- **Views:** day, week, month (agenda list on phones; month grid on wider screens).
  - Overdue items are highlighted.
  - Opening an item shows details and actions (pay, confirm, skip).
- **Cash-flow strip:** projected spendable balance per day for the next 30/60/90 days, with the lowest point highlighted.
  - It starts from actual spendable balances.
  - It adds scheduled income, subtracts scheduled outflows and unpaid bills.
  - It is clearly labelled *projected*.

### 2.7 Safe-to-Spend v2 (extends Phase 1; same "no double deduction" guarantees)

```
Safe to spend = spendable balances
              − goal allocations held in spendable accounts
              − outstanding bills due by the horizon (real + virtual; includes card & loan dues; overdue included)
              − unconfirmed scheduled outflows from spendable accounts due by the horizon
                 (expenses, and transfers to non-spendable accounts)
```

What it does **not** do:
- **Scheduled income is not added.** Money not yet received isn't counted; it does appear in the cash-flow projection.
- **No overlap with bills.** A scheduled transfer marked "pays bill schedule X" counts zero, because the bill already counts.
- **Card liability is not subtracted separately.** Only its bill is.
- **Budgets are not subtracted.**

Horizon: end of month (default) or "until next scheduled income" (Q5).

### 2.8 Notifications and reminders
- **In-app notification center (always works, offline):** derived from local data. It covers upcoming, due-today and overdue bills; scheduled items needing confirmation; card due dates; loan installments; budget warnings; savings milestones (25/50/75/100%).
- **While the app is open:** system notifications through the Notification API / service worker, with your permission.
- **While the app is closed — Web Push (Q3):**
  - **Opt-in per device.**
  - A new `reminders` cron service runs daily at 08:00 Asia/Manila. For each user it opens *that user's* workspace context (`ft_app` + RLS, no privileged access), finds due items, and sends **generic text by default** ("2 bills are due tomorrow"). Amounts are opt-in.
  - De-duplicated by a `notification_log` key, so the same reminder is never sent twice.
  - Push payloads are end-to-end encrypted to the device (RFC 8291).
  - It only knows about data that has synced to the server.
- **Preferences** (synced): which types, days before a bill (0/1/3/7), show amounts in push (default off).
- **Documented platform limits:**
  - No browser can schedule local notifications for a closed app (the Notification Triggers API was never shipped).
  - Periodic Background Sync can't read the encrypted local data while locked.
  - iOS delivers Web Push only to Home-Screen-installed apps (iOS 16.4+) after a tap to allow.
  - Delivery timing is up to the OS.

### 2.9 Net worth
- **Assets:** account balances (cash, bank, savings, e-wallets) plus **manual assets** (investments, property, vehicle, other), each with dated valuations.
- **Liabilities:** card and loan account balances.
- **Net worth = assets − liabilities.**
- **Snapshots:**
  - Automatic month-end snapshots: created on the first app open after month end, as of the last day of that month, with a deterministic id so devices can't duplicate them.
  - Manual "take snapshot now".
  - They store totals plus a per-account breakdown.
  - **Immutable** (P7).
  - The UI always labels them "Recorded on …" vs. "Current (recalculated)". If later edits change the recalculated value for that date, it shows "differs from recorded snapshot" rather than rewriting the snapshot.

### 2.10 CSV import
- **Runs entirely on the device** (works offline).
  - Upload, then map columns: date (with chosen format), amount as signed or separate debit/credit columns, description, optional category by name.
  - Pick the destination account.
  - Preview with per-row validation. Amounts use the existing centavo parser plus `(1,234.00)`, trailing `-` and DR/CR. Invalid dates are rejected.
- **Duplicate detection:**
  - Within the file.
  - Against existing transactions in that account: same amount, date ±1 day, similar description.
  - Exact re-imports: a fingerprint stored on the transaction, with a DB unique index per account.
  - Duplicates and invalid rows are listed and **not selected by default**. Nothing is imported silently.
- **Import:** you confirm, then rows are created as one import batch with deterministic ids (re-running is safe). "Undo import" soft-deletes the batch. Column mappings can be saved per account.

### 2.11 Receipts (expanded)
- Attach to **transactions or bills** (exactly one).
- Offline queue: encrypted local blob, uploaded on Wi-Fi as in Phase 1.
- View, and **download** (`?download=1`).
- Owner-only via RLS, and tested.

---

## 3. Sync and offline considerations

| Need | Approach |
|---|---|
| New modules offline | Generic encrypted records + outbox; Wi-Fi policy unchanged. |
| Multi-record operations (loan payment, contribute + transfer, bill materialize + pay, reallocation) | **Atomic groups** (P6): `groupId` on ops. The client writes all records and ops in one IndexedDB transaction (`mutateGroup`); the server applies the whole group in one savepoint or rejects/conflicts it as a unit. Ops without `groupId` behave exactly as today. |
| Duplicate occurrences / snapshots across devices | Deterministic ids + unique indexes (P3). The server treats a create of an existing id with **identical data** as `duplicate` (new, generic). Different data becomes a normal conflict. |
| Recurring generation during transitions | Nothing is generated (P2). |
| Tombstones | Soft delete everywhere. A deleted occurrence transaction stays as a tombstone, so it isn't recreated. |
| Conflicts | Existing UI; the comparison view gets labels for the new entities. |
| Immutable snapshots | Server rejects update ops (`immutable`); the client offers only delete. |
| Service worker | New static pages added to the precache list. |

---

## 4. Database changes and migrations (all additive)

**New synced tables** (each gets `workspace_id`, version/change_seq/tombstone columns, composite FKs, RLS, `ft_app` grants without DELETE):
- `schedules` — rule, template, status, links to bill/card/debt, `previous_schedule_id`.
- `schedule_exceptions` — skip/override per `(schedule_id, occurrence_date)`; deterministic id; unique.
- `bills` — unique `(workspace_id, schedule_id, occurrence_date)` where scheduled.
- `credit_card_profiles` — 1:1 with a `credit_card` account.
- `installment_plans`
- `debts` — 1:1 with a `loan` account.
- `goals`
- `goal_entries`
- `manual_assets` — with a `valuations` JSON array.
- `net_worth_snapshots` — immutable.
- `import_batches`

**New non-financial tables** (user-scoped, no RLS needed):
- `push_subscriptions` — device-scoped; revoked with the device.
- `notification_log` — keys only, no amounts.

**New columns** (nullable, no rewrite of existing rows):
- `transactions`: `bill_id`, `schedule_id`, `occurrence_date`, `debt_id`, `installment_plan_id`, `group_id`, `import_batch_id`, `import_fingerprint`.
  - Unique `(workspace_id, schedule_id, occurrence_date)` where `schedule_id` is not null.
  - Unique `(workspace_id, account_id, import_fingerprint)`.
- `attachments.bill_id` — CHECK: exactly one of transaction/bill.
- `categories.is_essential` (default false).
- `workspaces.preferences` (jsonb: notification prefs, Safe-to-Spend horizon).

**Migrations:**

| File | Contents | Destructive? |
|---|---|---|
| `0002_phase2_schema.sql` (generated) | New tables, columns, indexes, constraints | No |
| `0003_phase2_security.sql` | Grants + RLS policies for new tables | No |
| `0004_phase2_data.sql` | Converts Phase 1 `allocations`: obligations → `bills` (same ids; `transactions.bill_id` set from `allocation_id`), reserves → `goals` + one opening `goal_entries` row. Converted rows get new `change_seq`/version so devices re-pull. Marks default essential categories; adds "Interest & Fees" category to existing workspaces. `allocations` and `allocation_id` are **kept** (deprecated, no longer written). | No deletes; one data conversion |

**Default categories:** new workspaces also get "Interest & Fees" (expense).

---

## 5. Centralized calculations (`src/lib/finance/`, pure, unit-tested)

| Module | Contents |
|---|---|
| `recurrence.ts` | Occurrences in a range, next occurrence, exceptions/overrides, pause windows, rule split |
| `bills.ts` | Due, paid, outstanding, status |
| `schedules.ts` | Virtual vs. confirmed occurrences, "needs confirmation" |
| `cashflow.ts` | Projected daily spendable balance |
| `safe-to-spend.ts` | v2 (Phase 1 tests kept and extended) |
| `cards.ts` | Cycle dates, computed statement, available credit, minimum due, installment billing |
| `debts.ts` | Interest methods, payment split, amortization, payoff projection, snowball/avalanche |
| `goals.ts` | Progress, over-allocation, emergency coverage |
| `networth.ts` | Current totals incl. manual assets, as-of-date totals, snapshot comparison |
| `calendar.ts` | Merge + dedupe + notifications derivation |
| `csv-import.ts` | Parse, map, validate, fingerprint, duplicate detection |

---

## 6. UI (mobile-first)

- **Bottom nav:** Home · Activity · ＋ · **Plan** · More (Q6).
  - **Plan** hub tabs: **Calendar · Bills · Budgets · Goals**.
  - **More** adds: Credit cards, Debts & loans, Net worth, Recurring, Import CSV, Notifications.
- **Dashboard additions:**
  - Notification bell.
  - "Needs confirmation" items.
  - Bills due in 7 days.
  - Net worth card.
  - Emergency-fund coverage.
  - Safe-to-Spend breakdown with the new lines.
- **Quick Add:** optional "This pays bill…" and "Card installment" options.
- **Pages:** all new pages are static shells added to the service worker precache.

---

## 7. Testing plan

- **Unit (finance-core):**
  - Recurrence edge cases: month-end, leap years, biweekly, custom, pause/resume, rule split, exceptions.
  - Bill status table: full, partial, multiple, overdue, cancelled, deleted payment.
  - Safe-to-Spend v2 no-double-count matrix: bill + payment, scheduled transfer paying a bill, card purchase + card bill + payment, goal in spendable vs. savings account.
  - Cards: statements, available credit, installments, minimum due.
  - Debts: both interest methods, payment split, snowball vs. avalanche on known examples, never-pays-off detection.
  - Goals: progress, reallocation, emergency coverage.
  - Net worth: totals, manual assets, snapshot-vs-current differences.
  - CSV: formats, mapping, validation, duplicates, fingerprints.
  - Calendar: dedupe.
- **Integration (real Postgres):**
  - User A/B isolation and admin-sees-zero-rows for **every new table**.
  - Unique indexes block duplicate occurrences from two devices with different op ids.
  - Identical-create returns `duplicate`.
  - Atomic groups: all-or-nothing, including a conflict inside a group.
  - Snapshots can't be updated.
  - Bill attachments are owner-only.
  - Push subscription endpoints are user-scoped.
  - Reminder job: isolates users and sends no amounts by default.
  - Migration `0004` converts Phase 1 data correctly.
  - Backup/restore includes the new tables.
- **Offline client:**
  - Confirm the same occurrence offline on two devices → exactly one transaction.
  - Pause/resume offline.
  - Bill partial payments offline, then sync.
  - CSV import offline, then sync; re-import blocked.
  - Bill receipts queued.
  - Cellular/unknown still pause auto sync.
- **E2E (production build):** bill with two partial payments; confirm a recurring salary; card purchase + payment with correct dashboard numbers; CSV import with duplicates flagged; calendar; offline flow across new modules.
- **Manual device checks:** push on Android and on an installed iPhone app, added to the device checklist.

---

## 8. Milestones (commit per milestone)

| # | Milestone |
|---|---|
| P2-M0 | Sync protocol additions (atomic groups, identical-create duplicate, immutable entities), `mutateGroup`, migrations 0002/0003, entity registry + zod schemas |
| P2-M1 | finance-core modules + unit tests (test-first) |
| P2-M2 | Data migration 0004 + tests |
| P2-M3 | Bills + recurring/scheduled transactions + confirm/skip flows + calendar & cash flow |
| P2-M4 | Credit cards + statements + installments |
| P2-M5 | Debts & loans + payment split + snowball/avalanche |
| P2-M6 | Goals + emergency fund + net worth + snapshots + manual assets |
| P2-M7 | CSV import + receipts for bills + download |
| P2-M8 | Notifications: in-app center, Notification API, Web Push + reminders cron, preferences |
| P2-M9 | Dashboard/Plan integration, Safe-to-Spend v2 in UI, SW precache, E2E, docs, BUILD-LOG |

**New dependencies:**
- `papaparse` — CSV parsing.
- `web-push` — server-side push.
- `uuid` — already present; v5 is used for deterministic ids.

**New env vars:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

**New Railway service:** `reminders` (cron).

---

## 9. Risks

1. **Double counting across bills, schedules, cards, goals and Safe-to-Spend.** Mitigated by one obligation mechanism (bills), the ledger as the only source of balances, and a dedicated test matrix.
2. **Recurrence date edge cases.** Mitigated by date-only maths in the workspace timezone and exhaustive unit tests.
3. **Notifications.** Closed-app delivery depends on Web Push and the OS. iOS requires installation and permission. Reminders reflect synced data only.
4. **Privacy nuance.** The reminder job reads bill dates server-side (as the user, through RLS). Payloads are generic by default. This is documented in SECURITY.md.
5. **Card and loan figures are estimates.** Bank statement amounts (actual) override computed ones. Lenders' interest methods vary, so add-on vs. diminishing is selectable. Projections are labelled.
6. **Phase 1 data conversion (0004).** Low risk because nothing is deployed, but tested anyway; Phase 1 columns are kept.
7. **Protocol extension.** It is backward compatible; old clients' ops have no `groupId`.
8. **Performance.** Virtual occurrences are computed over bounded windows (about ±13 months) and memoized.
9. **CSV variety** (BDO, BPI, GCash, Maya exports). Generic mapping with saved presets per account; no bank-specific parsers in Phase 2.

---

## 10. Open decisions (defaults in **bold**; I'll use the defaults unless you say otherwise)

| # | Question | Default |
|---|---|---|
| Q1 | Fold Phase 1 "obligations" into **Bills** and "reserves" into **Savings Goals** (converting existing rows), so there is one concept each? | **Yes** (Phase 1 isn't deployed, so there's no user data at risk) |
| Q2 | Card installment purchases: count the full purchase as an expense on the purchase date (budgets), with only the monthly amount billed? | **Yes.** Spreading the expense monthly in budgets → Phase 3 |
| Q3 | Closed-app reminders via **Web Push** (opt-in per device, generic text, amounts opt-in), plus the in-app notification center? | **Yes.** Alternative: in-app/open-app notifications only |
| Q4 | Scheduled/recurring items always need a one-tap **confirmation** (never auto-posted)? | **Yes** |
| Q5 | Safe-to-Spend horizon: keep **end of month**, add optional "until next scheduled income"? | **Yes** |
| Q6 | Replace the Budgets tab with a **Plan** hub (Calendar · Bills · Budgets · Goals)? | **Yes** |
| Q7 | Include credit cards in snowball/avalanche comparisons? | **Yes** |
| Q8 | Emergency-fund months | **Changed by user:** selectable **3 / 6 / 9 / 12 months** — both the coverage target (fund goal = N × essential monthly expenses, default 6) and the averaging window for essential expenses (default 3). Manual override kept. |

## 11. Out of scope (Phase 3)
Advanced net-worth history and analytics, investment tracking beyond manual valuations, reports/charts beyond the cash-flow strip, spreading installment expenses across budgets, bank-specific import parsers, automatic statement/interest computation for cards, receivables (money owed to you), multi-currency, shared workspaces.
