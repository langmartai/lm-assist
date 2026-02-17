/**
 * Visual Editor Types
 *
 * Types for the Vibe Mode visual editor, including element selection,
 * floating prompt bar, and LLM-generated content.
 */

// ============================================================================
// Editor Mode
// ============================================================================

export type EditorMode = 'vibe' | 'advanced';

export interface EditorModeState {
  mode: EditorMode;
  isPersisted: boolean;
  hasSeenAdvancedTip: boolean;
  hasSeenVibeIntro: boolean;
}

// ============================================================================
// Element Selection
// ============================================================================

export interface SelectedElement {
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  ariaLabel?: string;
  placeholder?: string;
  type?: string;
  role?: string;
  alt?: string;
  src?: string;
  selector: string;
  componentName?: string;
  filePath?: string;
  lineNumber?: number;
  rect: {
    width: number;
    height: number;
    top: number;
    left: number;
    bottom: number;
    right: number;
  };
}

// ============================================================================
// LLM-Generated Element Info
// ============================================================================

export interface QuickAction {
  label: string;
  icon: string;
  promptTemplate: string;
}

export interface VibeElementInfo {
  friendlyName: string;
  description: string;
  quickActions: QuickAction[];
  promptSuggestions: string[];
}

export interface VibeElementInfoRequest {
  element: {
    tagName: string;
    id?: string;
    className?: string;
    textContent?: string;
    ariaLabel?: string;
    placeholder?: string;
    selector: string;
    componentName?: string;
    type?: string;
    role?: string;
    alt?: string;
    rect?: { width: number; height: number };
  };
  context?: {
    pageTitle?: string;
    pageUrl?: string;
    nearbyElements?: string[];
  };
}

export interface VibeElementInfoResponse {
  friendlyName: string;
  description: string;
  quickActions: QuickAction[];
  promptSuggestions: string[];
  cached?: boolean;
}

// ============================================================================
// LLM-Generated Suggestions
// ============================================================================

export interface VibeSuggestRequest {
  partialPrompt: string;
  element: {
    tagName: string;
    textContent?: string;
    type?: string;
    role?: string;
  };
  mode: EditorMode;
}

export interface VibeSuggestResponse {
  suggestions: string[];
  cached?: boolean;
}

// ============================================================================
// LLM-Generated Progress
// ============================================================================

export interface VibeProgressRequest {
  technicalStatus: string;
  executionId?: string;
}

export interface VibeProgressResponse {
  message: string;
}

// ============================================================================
// LLM-Generated Result Description
// ============================================================================

export interface VibeResultRequest {
  userPrompt: string;
  success: boolean;
  filesChanged?: string[];
}

export interface VibeResultResponse {
  summary: string;
  nextSuggestions: string[];
}

// ============================================================================
// Floating Prompt Bar State
// ============================================================================

export interface FloatingPromptPosition {
  x: number;
  y: number;
}

export type PositionMode = 'auto' | 'manual';

export interface FloatingPromptState {
  isVisible: boolean;
  isExpanded: boolean;
  position: FloatingPromptPosition;
  positionMode: PositionMode;
  prompt: string;
  selectedElement: SelectedElement | null;
  isExecuting: boolean;
  progress: number;
  statusMessage: string;
  savedPositions: Record<string, FloatingPromptPosition>;
}

// ============================================================================
// Model Selection
// ============================================================================

export type ModelSelection = 'auto' | 'fast' | 'balanced' | 'quality';

export interface VibeModelConfig {
  defaultSelection: ModelSelection;
  modelMap: {
    fast: string;
    balanced: string;
    quality: string;
  };
}

// ============================================================================
// Cache Configuration
// ============================================================================

export interface VibeCacheConfig {
  elementInfoCacheTtl: number;  // milliseconds
  suggestionCacheTtl: number;   // milliseconds
  maxCacheSize: number;         // max entries
}

// ============================================================================
// Rate Limiting
// ============================================================================

export interface VibeRateLimitConfig {
  maxElementInfoCalls: number;
  maxSuggestionCalls: number;
  maxProgressCalls: number;
  elementInfoRateLimit: number;  // per second
  suggestionRateLimit: number;   // per second
}

export interface VibeRateLimitState {
  elementInfoCalls: number;
  suggestionCalls: number;
  progressCalls: number;
  sessionStart: number;
}

// ============================================================================
// Visual Editor API
// ============================================================================

export interface VisualEditorApi {
  // Element info
  getElementInfo(request: VibeElementInfoRequest): Promise<VibeElementInfoResponse>;

  // Suggestions
  getSuggestions(request: VibeSuggestRequest): Promise<VibeSuggestResponse>;

  // Progress translation
  translateProgress(request: VibeProgressRequest): Promise<VibeProgressResponse>;

  // Result description
  describeResult(request: VibeResultRequest): Promise<VibeResultResponse>;

  // Cache management
  clearCache(): void;
  getCacheStats(): { hits: number; misses: number; size: number };
}

// ============================================================================
// Fallback Responses
// ============================================================================

export const FALLBACK_ELEMENT_INFO: VibeElementInfo = {
  friendlyName: 'Selected Element',
  description: 'Click to describe what you\'d like to change',
  quickActions: [
    { label: 'Describe change', icon: 'edit', promptTemplate: '' },
  ],
  promptSuggestions: [
    'What would you like to change about this?',
  ],
};

export const FALLBACK_SUGGESTIONS: string[] = [
  '...change the appearance',
  '...add an effect',
  '...modify the content',
];

export const FALLBACK_PROGRESS_MESSAGE = 'Making changes...';

export const FALLBACK_RESULT = {
  summary: 'Changes applied!',
  nextSuggestions: ['Try another change'],
};
