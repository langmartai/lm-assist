/** Find the account's cloud CCR sessions stalled on a server error (monitor-node only). */
import { cloudListAccount, cloudRead } from '../terminal/ccr-cloud';
import { getOAuthStatus } from '../utils/claude-oauth';
import { isServerStall } from './stall-classify';

export interface RemoteStall { sid: string; category: string }

export async function findRemoteStalls(deps?: {
  hasCreds?: () => boolean;
  list?: () => Promise<{ sid: string; status: string }[]>;
  readText?: (sid: string) => Promise<string>;
}): Promise<RemoteStall[]> {
  const hasCreds = deps?.hasCreds ?? (() => {
    const st = getOAuthStatus();
    return !!st.present && !st.expired;
  });
  if (!hasCreds()) return []; // credless monitor degrades to local-only

  const list = deps?.list ?? (async () => {
    const sessions = await cloudListAccount();
    // skip clearly-terminal states; classify the rest
    return sessions.filter((s) => !/completed|stopped|failed|terminated|ended/i.test(s.status || ''));
  });
  const readText = deps?.readText ?? (async (sid: string) => {
    const r = await cloudRead({ sid, lastN: 6 });
    // last assistant text is where an API error surfaces
    const last = [...r.messages].reverse().find((m) => m.role === 'assistant');
    return last?.text || '';
  });

  const out: RemoteStall[] = [];
  for (const s of await list()) {
    const { retryable, category } = isServerStall(await readText(s.sid));
    if (retryable) out.push({ sid: s.sid, category });
  }
  return out;
}
