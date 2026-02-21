'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

// ============================================================================
// Types
// ============================================================================

export type ScreenCategory =
  | 'small-phone'
  | 'phone'
  | 'large-phone'
  | 'tablet'
  | 'large-tablet'
  | 'desktop';

export type ViewMode = 'mobile' | 'tablet' | 'desktop';

export interface DeviceInfo {
  // Hardware detection
  isMobileDevice: boolean;
  hasTouch: boolean;
  hasHover: boolean;
  isCoarsePointer: boolean;

  // Screen (physical display in CSS px)
  screenWidthCSS: number;
  screenHeightCSS: number;
  devicePixelRatio: number;

  // Viewport (current layout area)
  viewportWidth: number;
  viewportHeight: number;

  // Derived categories
  screenCategory: ScreenCategory;
  orientation: 'portrait' | 'landscape';

  // View mode
  viewMode: ViewMode;

  // Keyboard
  isKeyboardVisible: boolean;
}

// ============================================================================
// SSR defaults (desktop)
// ============================================================================

const SSR_DEFAULTS: DeviceInfo = {
  isMobileDevice: false,
  hasTouch: false,
  hasHover: true,
  isCoarsePointer: false,
  screenWidthCSS: 1920,
  screenHeightCSS: 1080,
  devicePixelRatio: 1,
  viewportWidth: 1920,
  viewportHeight: 1080,
  screenCategory: 'desktop',
  orientation: 'landscape',
  viewMode: 'desktop',
  isKeyboardVisible: false,
};

// ============================================================================
// Helpers
// ============================================================================

function detectIsMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  // Modern API (Chromium 90+)
  const uaData = (navigator as any).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') {
    return uaData.mobile;
  }

  // Fallback: user-agent string
  const ua = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)
    || (navigator.maxTouchPoints > 0 && /Macintosh/i.test(ua)); // iPad Safari
}

function detectHasTouch(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}

function detectHasHover(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(hover: hover)').matches;
}

function detectIsCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function getScreenCategory(viewportWidth: number): ScreenCategory {
  if (viewportWidth < 375) return 'small-phone';
  if (viewportWidth < 480) return 'phone';
  if (viewportWidth < 768) return 'large-phone';
  if (viewportWidth < 1024) return 'tablet';
  if (viewportWidth < 1280) return 'large-tablet';
  return 'desktop';
}

function getOrientation(): 'portrait' | 'landscape' {
  if (typeof window !== 'undefined') {
    // Use window dimensions for orientation — screen.orientation.type reports the
    // physical display orientation which is always landscape on desktop monitors,
    // even when the browser window is taller than wide (DevTools device mode, etc.)
    return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
  }
  return 'landscape';
}

function deriveViewMode(
  screenCategory: ScreenCategory,
  orientation: 'portrait' | 'landscape',
): ViewMode {
  if (screenCategory === 'desktop' || screenCategory === 'large-tablet') return 'desktop';
  if (screenCategory === 'tablet') {
    return orientation === 'landscape' ? 'desktop' : 'tablet';
  }
  if (screenCategory === 'large-phone') {
    return orientation === 'landscape' ? 'tablet' : 'mobile';
  }
  // small-phone, phone
  return 'mobile';
}

function detectKeyboardVisible(): boolean {
  if (typeof window === 'undefined') return false;
  const vv = window.visualViewport;
  if (vv) {
    return vv.height < window.innerHeight * 0.7;
  }
  return false;
}

function measureDevice(): DeviceInfo {
  const isMobileDevice = detectIsMobileDevice();
  const hasTouch = detectHasTouch();
  const hasHover = detectHasHover();
  const isCoarsePointer = detectIsCoarsePointer();
  const dpr = window.devicePixelRatio || 1;
  const screenWidthCSS = Math.round(screen.width / dpr);
  const screenHeightCSS = Math.round(screen.height / dpr);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const screenCategory = getScreenCategory(viewportWidth);
  const orientation = getOrientation();
  const viewMode = deriveViewMode(screenCategory, orientation);
  const isKeyboardVisible = detectKeyboardVisible();

  return {
    isMobileDevice,
    hasTouch,
    hasHover,
    isCoarsePointer,
    screenWidthCSS,
    screenHeightCSS,
    devicePixelRatio: dpr,
    viewportWidth,
    viewportHeight,
    screenCategory,
    orientation,
    viewMode,
    isKeyboardVisible,
  };
}

// ============================================================================
// Hook
// ============================================================================

export function useDeviceInfo(): DeviceInfo {
  const [info, setInfo] = useState<DeviceInfo>(SSR_DEFAULTS);
  const [mounted, setMounted] = useState(false);

  // Initial measurement on mount
  useEffect(() => {
    setInfo(measureDevice());
    setMounted(true);
  }, []);

  // Debounced resize handler
  useEffect(() => {
    if (!mounted) return;

    let resizeTimer: ReturnType<typeof setTimeout>;

    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setInfo(measureDevice());
      }, 100);
    };

    const handleOrientationChange = () => {
      // Orientation change often fires before resize, wait a tick
      setTimeout(() => {
        setInfo(measureDevice());
      }, 50);
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);

    // Visual viewport resize (keyboard show/hide)
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleResize);
    }

    // Media query listeners for hover/pointer changes
    const hoverMQ = window.matchMedia('(hover: hover)');
    const pointerMQ = window.matchMedia('(pointer: coarse)');

    const handleMediaChange = () => setInfo(measureDevice());
    hoverMQ.addEventListener('change', handleMediaChange);
    pointerMQ.addEventListener('change', handleMediaChange);

    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      if (vv) vv.removeEventListener('resize', handleResize);
      hoverMQ.removeEventListener('change', handleMediaChange);
      pointerMQ.removeEventListener('change', handleMediaChange);
    };
  }, [mounted]);

  return info;
}
