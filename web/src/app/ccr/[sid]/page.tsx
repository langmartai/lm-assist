'use client';

import { CcrPage } from '@/components/ccr/CcrPage';

// Deep-link a session at /ccr/<sid>. CcrPage reads the sid from the URL on mount
// (window.location) and drives forward navigation via history.pushState, so this
// route and /ccr render the same component — a hard refresh / shared link resolves here.
export default function CcrSessionRoute() {
  return <CcrPage />;
}
