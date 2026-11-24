/**
 * Generate an age key pair for backups. Run on YOUR computer, not on the server:
 *   npm run backup:keygen
 * Put the PUBLIC key (age1…) in Railway as BACKUP_AGE_RECIPIENT.
 * Keep the PRIVATE key (AGE-SECRET-KEY-1…) offline (password manager / printed). Without it,
 * backups cannot be restored; with it, anyone can read them.
 */
import { generateX25519Identity, identityToRecipient } from "age-encryption";

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);
console.log("Public key  (BACKUP_AGE_RECIPIENT):", recipient);
console.log("Private key (keep offline, never upload):", identity);
