export const LEDGER_API_URL = process.env.LEDGER_API_URL ?? 'http://localhost:7575'

// An unauthenticated participant has no token claims to default the ledger
// user from and rejects every submission that omits it.
export const LEDGER_USER_ID = process.env.LEDGER_USER_ID ?? 'participant_admin'

// A short timeout rather than the default: an unreachable participant is the
// expected case, and it must cost the run seconds, not a hung socket.
export async function probeSandbox(): Promise<boolean> {
  try {
    const res = await fetch(`${LEDGER_API_URL}/v2/version`, {
      signal: AbortSignal.timeout(2_000),
    })
    return res.ok
  } catch {
    return false
  }
}
