import { serverAuthHeader } from '@/lib/server-auth';

// assist-api.langmart.ai → https://auth.langmart.ai (dev: xeenhub.com alike).
// The node's hub decides the issuer — no separate config to drift.
export async function deriveIssuer(): Promise<string | null> {
  const apiPort = process.env.LM_LOCAL_API_PORT || process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  try {
    const r = await fetch(`http://localhost:${apiPort}/hub/status`, { headers: serverAuthHeader() });
    const j = await r.json();
    const hubUrl: string | undefined = j?.data?.hubUrl || j?.hubUrl;
    if (!hubUrl) return null;
    const host = new URL(hubUrl.replace(/^ws/, 'http')).hostname;      // assist-api.langmart.ai
    const domain = host.split('.').slice(-2).join('.');                 // langmart.ai
    if (domain !== 'langmart.ai' && domain !== 'xeenhub.com') return null;
    return `https://auth.${domain}`;
  } catch { return null; }
}
