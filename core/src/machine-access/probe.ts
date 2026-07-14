/**
 * Reachability probe for an ssh access method.
 *
 * Pure argv builder + result classifier (unit-tested); the actual spawn is done
 * by the route via the shared `runCmd` (execFile, no shell). Security posture:
 *  - BatchMode=yes  → never prompts, never hangs on a password.
 *  - StrictHostKeyChecking=yes → an unknown/changed host key is SURFACED, never
 *    silently accepted; the probe never writes to known_hosts.
 *  - IdentitiesOnly=yes + -i → use ONLY the declared key (no agent key spray).
 *  - argv array + trailing `--` + literal `true` remote command → no shell, no
 *    option/command injection (leading-dash fields are already rejected at write).
 */
import type { SshAccess, LastCheck } from './store';

export interface ProbeOpts {
  connectTimeout: number; // seconds
}

/** Build the ssh argv for a non-interactive reachability probe. */
export function buildSshProbeArgs(a: SshAccess, opts: ProbeOpts): string[] {
  const args = [
    '-oBatchMode=yes',
    `-oConnectTimeout=${opts.connectTimeout}`,
    '-oStrictHostKeyChecking=yes',
  ];
  if (a.identityFile) {
    args.push('-oIdentitiesOnly=yes', '-i', a.identityFile);
  }
  if (a.port && a.port !== 22) {
    args.push('-p', String(a.port));
  }
  args.push(`${a.user}@${a.host}`, '--', 'true');
  return args;
}

/** Classify an ssh exit code + stderr into a stable status. */
export function classifyProbe(code: number, stderr: string): LastCheck {
  const at = new Date().toISOString();
  const s = stderr || '';
  const tail = s.trim().split('\n').slice(-3).join(' ').slice(0, 300) || undefined;
  if (code === 0) return { status: 'ok', at };
  if (/Permission denied|publickey|password|Authentication failed/i.test(s)) {
    return { status: 'auth-failed', detail: tail, at };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:ECDSA|RSA|ED25519) host key is known/i.test(s)) {
    return { status: 'host-key-unverified', detail: tail, at };
  }
  if (/Could not resolve|Name or service not known|Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out/i.test(s)) {
    return { status: 'unreachable', detail: tail, at };
  }
  return { status: 'error', detail: tail, at };
}
