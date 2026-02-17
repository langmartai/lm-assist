/**
 * Template System Type Definitions
 *
 * Types for the multi-template system supporting:
 * - Project templates (complete project starters)
 * - Tier templates (framework-specific per tier)
 * - Component templates (reusable patterns)
 */

import type { TierName, ImplementationTierName, DocumentTierName } from './instruction-protocol';

// ============================================================================
// Template Categories
// ============================================================================

/**
 * Type of template
 */
export type TemplateType = 'project' | 'tier' | 'component';

/**
 * Template category for organization
 */
export type TemplateCategory =
  | 'business'     // SaaS, e-commerce, etc.
  | 'content'      // Blog, CMS, etc.
  | 'utility'      // API-only, CLI tools, etc.
  | 'blank'        // Minimal starter
  | 'framework'    // Framework-specific
  | 'pattern';     // Reusable patterns

// ============================================================================
// Base Template Interface
// ============================================================================

/**
 * Base interface for all templates
 */
export interface TemplateBase {
  /** Unique template ID */
  id: string;

  /** Template type */
  type: TemplateType;

  /** Human-readable name */
  name: string;

  /** Template version */
  version: string;

  /** Description */
  description: string;

  /** Category for organization */
  category: TemplateCategory;

  /** Tags for search/filtering */
  tags: string[];

  /** Author or maintainer */
  author?: string;

  /** License */
  license?: string;

  /** Documentation URL */
  docsUrl?: string;

  /** Repository URL */
  repoUrl?: string;

  /** Preview image URL */
  previewUrl?: string;
}

// ============================================================================
// Project Templates
// ============================================================================

/**
 * Complete project template
 */
export interface ProjectTemplate extends TemplateBase {
  type: 'project';

  /** Default tier template selections */
  defaultTiers: ProjectTierDefaults;

  /** Compatible tier templates per tier */
  compatibleTiers: ProjectTierCompatibility;

  /** Features included in this template */
  features: string[];

  /** Pre-loaded spec paths (if any) */
  preloadedSpecs?: string[];

  /** Pre-loaded task paths (if any) */
  preloadedTasks?: string[];

  /** Environment variables template */
  envTemplate?: Record<string, string>;

  /** Post-init commands */
  postInitCommands?: string[];
}

/**
 * Default tier template selections for a project template
 */
export interface ProjectTierDefaults {
  spec?: string;      // e.g., 'default', 'detailed'
  task?: string;      // e.g., 'default', 'agile'
  web?: string;       // e.g., 'nextjs', 'react-vite'
  api?: string;       // e.g., 'hono', 'express'
  database?: string;  // e.g., 'postgresql', 'mongodb'
  deploy?: string;    // e.g., 'docker-compose', 'kubernetes'
}

/**
 * Compatible tier templates for each tier
 */
export interface ProjectTierCompatibility {
  spec?: string[];
  task?: string[];
  web?: string[];
  api?: string[];
  database?: string[];
  deploy?: string[];
}

// ============================================================================
// Tier Templates
// ============================================================================

/**
 * Tier-specific template
 */
export interface TierTemplate extends TemplateBase {
  type: 'tier';

  /** Target tier */
  tier: TierName;

  /** Framework information */
  framework?: FrameworkInfo;

  /** Features provided by this template */
  features: string[];

  /** Compatible templates for other tiers */
  compatibleWith: TierCompatibility;

  /** Port configuration */
  ports?: {
    dev?: number;
    preview?: number;
    production?: number;
  };

  /** Scripts provided */
  scripts?: Record<string, string>;

  /** Required environment variables */
  requiredEnvVars?: string[];

  /** Dependencies */
  dependencies?: Record<string, string>;

  /** Dev dependencies */
  devDependencies?: Record<string, string>;
}

/**
 * Framework information
 */
export interface FrameworkInfo {
  /** Main framework name */
  name: string;

  /** Framework version */
  version?: string;

  /** Language */
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'sql';

  /** CSS/styling framework */
  styling?: string;

  /** Build tool */
  buildTool?: string;
}

/**
 * Tier compatibility configuration
 */
export interface TierCompatibility {
  /** Compatible web tier templates */
  web?: string[];

  /** Compatible API tier templates */
  api?: string[];

  /** Compatible database tier templates */
  database?: string[];

  /** Compatible deploy tier templates */
  deploy?: string[];

  /** Compatible spec tier templates */
  spec?: string[];

  /** Compatible task tier templates */
  task?: string[];
}

// ============================================================================
// Component Templates
// ============================================================================

/**
 * Reusable component template (e.g., auth, payments)
 */
export interface ComponentTemplate extends TemplateBase {
  type: 'component';

  /** Tiers this component affects */
  affectedTiers: TierName[];

  /** Required tier templates for compatibility */
  requiredTierTemplates?: {
    web?: string[];
    api?: string[];
    database?: string[];
  };

  /** Spec files included */
  specFiles?: string[];

  /** Per-tier implementation files */
  tierFiles: {
    web?: ComponentTierFiles;
    api?: ComponentTierFiles;
    database?: ComponentTierFiles;
    deploy?: ComponentTierFiles;
  };

  /** Integration points with existing code */
  integrations?: ComponentIntegration[];

  /** Configuration options */
  configOptions?: ComponentConfigOption[];
}

/**
 * Files for a specific tier in a component
 */
export interface ComponentTierFiles {
  /** Files to create */
  files: string[];

  /** Modifications to existing files */
  modifications?: FileModification[];

  /** Dependencies to add */
  dependencies?: Record<string, string>;
}

/**
 * File modification instruction
 */
export interface FileModification {
  /** Target file path pattern */
  targetPattern: string;

  /** Type of modification */
  type: 'append' | 'prepend' | 'insert' | 'replace';

  /** Content to add/replace */
  content: string;

  /** Marker for insert operations */
  marker?: string;
}

/**
 * Integration point for component
 */
export interface ComponentIntegration {
  /** Integration type */
  type: 'route' | 'middleware' | 'hook' | 'provider' | 'migration';

  /** Description */
  description: string;

  /** File to modify */
  targetFile: string;

  /** Integration code/instructions */
  integration: string;
}

/**
 * Configuration option for component
 */
export interface ComponentConfigOption {
  /** Option name */
  name: string;

  /** Description */
  description: string;

  /** Data type */
  type: 'string' | 'number' | 'boolean' | 'select';

  /** Default value */
  default?: unknown;

  /** Options for select type */
  options?: string[];

  /** Whether this option is required */
  required: boolean;
}

// ============================================================================
// Template Manifest
// ============================================================================

/**
 * Template manifest file (manifest.json)
 */
export interface TemplateManifest {
  /** Schema version */
  $schema?: string;

  /** Template ID */
  id: string;

  /** Template name */
  name: string;

  /** Template type */
  type: TemplateType;

  /** Version */
  version: string;

  /** Description */
  description: string;

  /** Category */
  category: TemplateCategory;

  /** Tags */
  tags: string[];

  /** For tier templates: which tier */
  tier?: TierName;

  /** Framework info (for tier templates) */
  framework?: FrameworkInfo;

  /** Default tier selections (for project templates) */
  defaultTiers?: ProjectTierDefaults;

  /** Compatible tiers (for project templates) */
  compatibleTiers?: ProjectTierCompatibility;

  /** Features */
  features?: string[];

  /** Compatibility */
  compatibleWith?: TierCompatibility;

  /** Files to copy */
  files?: TemplateFileEntry[];

  /** Post-init hook */
  postInit?: {
    commands?: string[];
    message?: string;
  };
}

/**
 * File entry in template manifest
 */
export interface TemplateFileEntry {
  /** Source path relative to template */
  src: string;

  /** Destination path relative to target */
  dest: string;

  /** Whether to process as template (replace variables) */
  template?: boolean;

  /** Condition for including this file */
  condition?: string;
}

// ============================================================================
// Template Selection
// ============================================================================

/**
 * User's template selections for project creation
 */
export interface TemplateSelections {
  /** Project template ID */
  projectTemplate?: string;

  /** Tier template selections */
  tierTemplates?: {
    spec?: string;
    task?: string;
    web?: string;
    api?: string;
    database?: string;
    deploy?: string;
  };

  /** Component templates to include */
  components?: string[];

  /** Configuration values */
  config?: Record<string, unknown>;
}

/**
 * Result of validating template selections
 */
export interface TemplateValidationResult {
  /** Whether selections are valid */
  valid: boolean;

  /** Validation errors */
  errors: TemplateValidationError[];

  /** Validation warnings */
  warnings: TemplateValidationWarning[];

  /** Suggested alternatives */
  suggestions?: TemplateSuggestion[];
}

/**
 * Validation error
 */
export interface TemplateValidationError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Affected tier/template */
  target?: string;
}

/**
 * Validation warning
 */
export interface TemplateValidationWarning {
  /** Warning code */
  code: string;

  /** Warning message */
  message: string;

  /** Affected tier/template */
  target?: string;
}

/**
 * Template suggestion
 */
export interface TemplateSuggestion {
  /** Suggestion type */
  type: 'alternative' | 'recommended' | 'compatible';

  /** Description */
  description: string;

  /** Template ID */
  templateId: string;

  /** Which tier this is for */
  tier?: TierName;
}

// ============================================================================
// Template Manager Types
// ============================================================================

/**
 * Template listing options
 */
export interface TemplateListOptions {
  /** Filter by type */
  type?: TemplateType;

  /** Filter by tier (for tier templates) */
  tier?: TierName;

  /** Filter by category */
  category?: TemplateCategory;

  /** Filter by tags */
  tags?: string[];

  /** Search query */
  search?: string;

  /** Sort by */
  sortBy?: 'name' | 'popularity' | 'updated';

  /** Limit results */
  limit?: number;
}

/**
 * Result of applying a template
 */
export interface TemplateApplyResult {
  /** Whether apply succeeded */
  success: boolean;

  /** Files created */
  filesCreated: string[];

  /** Files modified */
  filesModified: string[];

  /** Dependencies added */
  dependenciesAdded: Record<string, string>;

  /** Post-init commands to run */
  postInitCommands?: string[];

  /** Next steps message */
  nextSteps?: string;

  /** Errors if failed */
  errors?: string[];
}

// ============================================================================
// Built-in Template IDs
// ============================================================================

/**
 * Built-in project template IDs
 */
export const PROJECT_TEMPLATE_IDS = {
  BLANK: 'blank',
  SAAS_STARTER: 'saas-starter',
  ECOMMERCE: 'e-commerce',
  BLOG_PLATFORM: 'blog-platform',
  API_ONLY: 'api-only',
} as const;

/**
 * Built-in spec tier template IDs
 */
export const SPEC_TEMPLATE_IDS = {
  DEFAULT: 'default',
  DETAILED: 'detailed',
} as const;

/**
 * Built-in task tier template IDs
 */
export const TASK_TEMPLATE_IDS = {
  DEFAULT: 'default',
  AGILE: 'agile',
} as const;

/**
 * Built-in web tier template IDs
 */
export const WEB_TEMPLATE_IDS = {
  NEXTJS: 'nextjs',
  REACT_VITE: 'react-vite',
  VUE3: 'vue3',
  SVELTE_KIT: 'svelte-kit',
  ASTRO: 'astro',
} as const;

/**
 * Built-in API tier template IDs
 */
export const API_TEMPLATE_IDS = {
  HONO: 'hono',
  EXPRESS: 'express',
  FASTIFY: 'fastify',
  NESTJS: 'nestjs',
  FASTAPI: 'fastapi',
  GO_CHI: 'go-chi',
} as const;

/**
 * Built-in database tier template IDs
 */
export const DATABASE_TEMPLATE_IDS = {
  POSTGRESQL: 'postgresql',
  MYSQL: 'mysql',
  MONGODB: 'mongodb',
  SUPABASE: 'supabase',
  TURSO: 'turso',
} as const;

/**
 * Built-in deploy tier template IDs
 */
export const DEPLOY_TEMPLATE_IDS = {
  DOCKER_COMPOSE: 'docker-compose',
  KUBERNETES: 'kubernetes',
  VERCEL: 'vercel',
  AWS_CDK: 'aws-cdk',
  AWS_TERRAFORM: 'aws-terraform',
  GCP_TERRAFORM: 'gcp-terraform',
  GITHUB_ACTIONS: 'github-actions',
} as const;

/**
 * Built-in component template IDs
 */
export const COMPONENT_TEMPLATE_IDS = {
  AUTH: 'auth',
  PAYMENTS: 'payments',
  NOTIFICATIONS: 'notifications',
  FILE_UPLOAD: 'file-upload',
} as const;

// ============================================================================
// Showcase Templates (Pre-Deployed Demo Apps)
// ============================================================================

/**
 * Showcase category for template gallery
 */
export type ShowcaseCategory =
  | 'business'    // Online stores, SaaS, etc.
  | 'creative'    // Blogs, portfolios, etc.
  | 'community'   // Forums, social apps, etc.
  | 'tools'       // Task managers, dashboards, etc.
  | 'landing';    // Landing pages, marketing sites

/**
 * Complexity level for showcase templates
 */
export type ShowcaseComplexity = 'beginner' | 'intermediate' | 'advanced';

/**
 * Showcase template metadata (template.json)
 */
export interface ShowcaseTemplateMetadata {
  /** Unique template ID */
  id: string;

  /** Template version */
  version: string;

  /** Human-readable name */
  name: string;

  /** Short tagline */
  tagline: string;

  /** Full description */
  description: string;

  /** Emoji icon */
  icon: string;

  /** Category for organization */
  category: ShowcaseCategory;

  /** Complexity level */
  complexity: ShowcaseComplexity;

  /** Showcase deployment info */
  showcase: ShowcaseDeploymentInfo;

  /** Features list with details */
  features: ShowcaseFeature[];

  /** Tech stack details */
  stack: ShowcaseStack;

  /** Setup information */
  setup: ShowcaseSetupInfo;

  /** Target audience */
  suitableFor: string[];

  /** Not recommended for */
  notSuitableFor: string[];

  /** Search tags */
  tags: string[];
}

/**
 * Showcase deployment information
 */
export interface ShowcaseDeploymentInfo {
  /** Live demo URL */
  url: string;

  /** Local development URL (used for status checks in dev) */
  localUrl?: string;

  /** Preview image paths (relative to template) */
  previewImages: string[];

  /** Demo login credentials (if applicable) */
  demoCredentials?: {
    email: string;
    password: string;
  };

  /** Clickable features to try in demo */
  featuresToTry: string[];
}

/**
 * Feature in a showcase template
 */
export interface ShowcaseFeature {
  /** Feature name */
  name: string;

  /** Feature description */
  description: string;

  /** Which tier implements this */
  tier: 'web' | 'api' | 'database';

  /** Whether it's included by default */
  included: boolean;

  /** Optional: depends on other features */
  dependsOn?: string[];
}

/**
 * Tech stack for showcase template
 */
export interface ShowcaseStack {
  /** Web tier stack */
  web: {
    framework: string;
    features: string[];
    styling?: string;
    routing?: string;
  };

  /** API tier stack */
  api: {
    framework: string;
    features: string[];
    auth?: string;
    orm?: string;
  };

  /** Database tier stack */
  database: {
    type: string;
    orm?: string;
    features?: string[];
  };
}

/**
 * Setup information for showcase template
 */
export interface ShowcaseSetupInfo {
  /** Estimated setup time in seconds */
  estimatedTime: number;

  /** Human-readable setup steps */
  steps: string[];

  /** Prerequisites */
  requirements: string[];

  /** Environment variables needed */
  envVars?: Record<string, string>;
}

/**
 * Showcase deployment configuration (showcase.json)
 */
export interface ShowcaseDeployConfig {
  /** Template ID reference */
  templateId: string;

  /** Deployment type */
  deployType: 'docker' | 'vercel' | 'railway' | 'fly';

  /** Deployment URL pattern */
  urlPattern: string;

  /** Health check endpoint */
  healthCheck: {
    endpoint: string;
    expectedStatus: number;
  };

  /** Database configuration */
  database?: {
    type: string;
    resetInterval?: string;
    seedOnReset: boolean;
  };

  /** Auto-reset configuration */
  autoReset?: {
    enabled: boolean;
    cron?: string;
    keepData?: string[];
  };

  /** Resource limits */
  resources?: {
    memory?: string;
    cpu?: string;
    instances?: number;
  };
}

/**
 * Showcase template summary (for listing)
 */
export interface ShowcaseTemplateSummary {
  /** Template ID */
  id: string;

  /** Name */
  name: string;

  /** Tagline */
  tagline: string;

  /** Icon */
  icon: string;

  /** Category */
  category: ShowcaseCategory;

  /** Complexity */
  complexity: ShowcaseComplexity;

  /** Live demo URL */
  showcaseUrl: string;

  /** Primary preview image */
  previewImage: string;

  /** Main features (top 3-5) */
  highlights: string[];

  /** Tags for search */
  tags: string[];
}

/**
 * Built-in showcase template IDs
 */
export const SHOWCASE_TEMPLATE_IDS = {
  ONLINE_STORE: 'online-store',
  BLOG: 'blog',
  PORTFOLIO: 'portfolio',
  TASK_MANAGER: 'task-manager',
  LANDING_PAGE: 'landing-page',
} as const;
