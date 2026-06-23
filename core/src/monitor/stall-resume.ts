/** Resume a stalled session by sending the literal `continue`. */
import { corePost } from './loopback';
import { cloudDrive } from '../terminal/ccr-cloud';

/** Local: POST /terminal/cc-sessions/:id/prompt {text:'continue', submit:true}
 *  (the cc-session driver — honors the idle-gate; returns delivered:false if not idle/no driver). */
export async function resumeLocal(sessionId: string, deps?: { post?: (p: string, b: any) => Promise<any> }): Promise<boolean> {
  const post = deps?.post ?? corePost;
  const r = await post(`/terminal/cc-sessions/${encodeURIComponent(sessionId)}/prompt`, { text: 'continue', submit: true });
  return !!(r?.data?.delivered ?? r?.delivered ?? r?.success);
}

/** Remote: cloudDrive a plain `continue` user turn. */
export async function resumeRemote(sid: string, deps?: { drive?: (o: { sid: string; text: string }) => Promise<{ delivered: boolean }> }): Promise<boolean> {
  const drive = deps?.drive ?? ((o) => cloudDrive(o));
  const r = await drive({ sid, text: 'continue' });
  return !!r?.delivered;
}
