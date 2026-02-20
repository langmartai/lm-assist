'use client';

import { useMachineContext } from '@/contexts/MachineContext';

export function usePlatform() {
  const { selectedMachine } = useMachineContext();
  const isWindows = selectedMachine?.platform === 'win32';
  return { isWindows, platform: selectedMachine?.platform || 'linux' };
}
