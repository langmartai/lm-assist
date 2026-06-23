/** Minimal loopback HTTP to THIS Core (prod :3100 / dev :3200), carrying the api-token. */
import { lmAuthHeaders } from '../auth/api-token';

function basePort(): number {
  return __dirname.includes('node_modules') ? 3100 : 3200;
}
function url(pathname: string): string {
  return `http://127.0.0.1:${basePort()}${pathname}`;
}

export async function coreGet(pathname: string): Promise<any> {
  const res = await fetch(url(pathname), { headers: { ...lmAuthHeaders() } });
  return res.json();
}
export async function corePost(pathname: string, body: any): Promise<any> {
  const res = await fetch(url(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}
