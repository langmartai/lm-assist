/**
 * Shared API helpers
 *
 * Common response wrappers used across all API implementations.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ApiResponse } from '../types/control-api';

export function wrapResponse<T>(data: T, startTime: number): ApiResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date(),
      requestId: uuidv4(),
      durationMs: Date.now() - startTime,
    },
  };
}

export function wrapError(code: string, message: string, startTime: number): ApiResponse<never> {
  return {
    success: false,
    error: { code, message },
    meta: {
      timestamp: new Date(),
      requestId: uuidv4(),
      durationMs: Date.now() - startTime,
    },
  };
}
