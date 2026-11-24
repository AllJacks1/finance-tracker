# Permission matrix

Implemented in [`src/lib/permissions.ts`](../src/lib/permissions.ts) (shared by server and UI) and
tested cell-by-cell in `src/lib/permissions.test.ts` and `tests/integration/auth.test.ts`.

Every account — including Super Admins and Managers — has **one private finance workspace that only
they can access**. Administrative permissions never extend to anyone else's workspace. There is no
permission that grants financial access.

| Capability | Super Admin | Manager | User |
|---|---|---|---|
| `users.view` — list users (name, email, role, status, last sign-in, device count) | ✅ | if granted | ❌ |
| `users.create` — create users (role "User" only for Managers) | ✅ | if granted | ❌ |
| `users.deactivate` — deactivate / reactivate | ✅ | if granted, regular users only | ❌ |
| `users.reset_password` — issue a temporary password | ✅ | if granted, regular users only | ❌ |
| `users.revoke_devices` — sign out devices (wipes their local data on next contact) | ✅ | if granted, regular users only | ❌ |
| `roles.assign` — change roles, create admins | ✅ | never | ❌ |
| `permissions.grant` — grant Manager permissions | ✅ | never | ❌ |
| `system.settings` — sign-in notice, backup retention | ✅ | never | ❌ |
| `system.health` — DB status, sessions, sync failure counts, backup status | ✅ | if granted | ❌ |
| `backups.view` — backup history | ✅ | if granted | ❌ |
| `backups.trigger` — reserved (backups run from the Railway backup service) | ✅ | never | ❌ |
| `audit.view` — audit log | ✅ | if granted | ❌ |
| **Another user's financial data** | ❌ | ❌ | ❌ |
| Own financial workspace | ✅ own only | ✅ own only | ✅ own only |

Rules
- Managers can act only on regular users, never on Super Admins or other Managers.
- Nobody can deactivate themselves or change their own role/permissions.
- The last active Super Admin cannot be deactivated or demoted (serialised with an advisory lock;
  tested with two Super Admins demoting each other concurrently).
- Deactivation revokes all sessions and devices. Role changes revoke the user's sessions.
- Every administrative action is written to the audit log without financial details.
