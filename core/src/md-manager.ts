/**
 * CLAUDE.md Manager
 * Manages CLAUDE.md project instruction files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeMdInfo, ClaudeMdSection, ClaudeMdTemplate } from './types';
import { normalizePath } from './utils/path-utils';

/**
 * Estimate tokens from character count
 * Based on empirical testing: ~3.4 chars per token for markdown
 */
const CHARS_PER_TOKEN = 3.4;

/**
 * CLAUDE.md Manager class
 */
export class ClaudeMdManager {
  private templates: Map<string, ClaudeMdTemplate> = new Map();

  constructor() {
    this.initializeDefaultTemplates();
  }

  /**
   * Get CLAUDE.md information for a project
   */
  getInfo(projectPath: string): ClaudeMdInfo {
    const normalizedPath = normalizePath(projectPath);
    const claudeMdPath = path.join(normalizedPath, 'CLAUDE.md');

    if (!fs.existsSync(claudeMdPath)) {
      return {
        path: claudeMdPath,
        exists: false,
        sizeBytes: 0,
        wordCount: 0,
        estimatedTokens: 0,
        sections: [],
      };
    }

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const stats = fs.statSync(claudeMdPath);

    return {
      path: claudeMdPath,
      exists: true,
      sizeBytes: stats.size,
      wordCount: this.countWords(content),
      estimatedTokens: this.estimateTokens(content),
      lastModified: stats.mtime,
      sections: this.parseSections(content),
    };
  }

  /**
   * Read CLAUDE.md content
   */
  read(projectPath: string): string | null {
    const normalizedPath = normalizePath(projectPath);
    const claudeMdPath = path.join(normalizedPath, 'CLAUDE.md');

    if (!fs.existsSync(claudeMdPath)) {
      return null;
    }

    return fs.readFileSync(claudeMdPath, 'utf-8');
  }

  /**
   * Write CLAUDE.md content
   */
  write(projectPath: string, content: string): void {
    const normalizedPath = normalizePath(projectPath);
    const claudeMdPath = path.join(normalizedPath, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, content);
  }

  /**
   * Append content to CLAUDE.md
   */
  append(projectPath: string, content: string): void {
    const existing = this.read(projectPath) || '';
    this.write(projectPath, existing + '\n' + content);
  }

  /**
   * Delete CLAUDE.md
   */
  delete(projectPath: string): boolean {
    const normalizedPath = normalizePath(projectPath);
    const claudeMdPath = path.join(normalizedPath, 'CLAUDE.md');

    if (fs.existsSync(claudeMdPath)) {
      fs.unlinkSync(claudeMdPath);
      return true;
    }

    return false;
  }

  /**
   * Backup CLAUDE.md
   */
  backup(projectPath: string, backupSuffix?: string): string | null {
    const content = this.read(projectPath);
    if (!content) {
      return null;
    }

    const normalizedPath = normalizePath(projectPath);
    const suffix = backupSuffix || new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(normalizedPath, `CLAUDE.md.backup-${suffix}`);
    fs.writeFileSync(backupPath, content);

    return backupPath;
  }

  /**
   * Restore CLAUDE.md from backup
   */
  restore(projectPath: string, backupPath: string): boolean {
    if (!fs.existsSync(backupPath)) {
      return false;
    }

    const content = fs.readFileSync(backupPath, 'utf-8');
    this.write(projectPath, content);
    return true;
  }

  /**
   * Get a specific section from CLAUDE.md
   */
  getSection(projectPath: string, sectionTitle: string): string | null {
    const content = this.read(projectPath);
    if (!content) {
      return null;
    }

    const sections = this.parseSections(content);
    const section = sections.find(
      (s) => s.title.toLowerCase() === sectionTitle.toLowerCase()
    );

    if (!section) {
      return null;
    }

    const lines = content.split('\n');
    return lines.slice(section.startLine, section.endLine).join('\n');
  }

  /**
   * Update a specific section in CLAUDE.md
   */
  updateSection(projectPath: string, sectionTitle: string, newContent: string): boolean {
    const content = this.read(projectPath);
    if (!content) {
      return false;
    }

    const sections = this.parseSections(content);
    const section = sections.find(
      (s) => s.title.toLowerCase() === sectionTitle.toLowerCase()
    );

    if (!section) {
      return false;
    }

    const lines = content.split('\n');
    const headingLine = lines[section.startLine];
    const newLines = [
      ...lines.slice(0, section.startLine),
      headingLine,
      newContent,
      ...lines.slice(section.endLine),
    ];

    this.write(projectPath, newLines.join('\n'));
    return true;
  }

  /**
   * Add a new section to CLAUDE.md
   */
  addSection(projectPath: string, title: string, content: string, level: number = 2): void {
    const heading = '#'.repeat(level) + ' ' + title;
    const sectionContent = `\n${heading}\n\n${content}\n`;
    this.append(projectPath, sectionContent);
  }

  /**
   * Remove a section from CLAUDE.md
   */
  removeSection(projectPath: string, sectionTitle: string): boolean {
    const content = this.read(projectPath);
    if (!content) {
      return false;
    }

    const sections = this.parseSections(content);
    const section = sections.find(
      (s) => s.title.toLowerCase() === sectionTitle.toLowerCase()
    );

    if (!section) {
      return false;
    }

    const lines = content.split('\n');
    const newLines = [
      ...lines.slice(0, section.startLine),
      ...lines.slice(section.endLine),
    ];

    this.write(projectPath, newLines.join('\n'));
    return true;
  }

  /**
   * Estimate token impact of CLAUDE.md on requests
   */
  estimateImpact(projectPath: string, requestsPerDay: number = 100): {
    tokensPerRequest: number;
    costPerRequestUsd: number;
    dailyCostUsd: number;
    monthlyCostUsd: number;
  } {
    const info = this.getInfo(projectPath);

    // Cache write price for Opus 4.5: $6.25 per 1M tokens
    // Cache read price: $0.50 per 1M tokens
    const CACHE_WRITE_PRICE = 6.25 / 1_000_000;
    const CACHE_READ_PRICE = 0.5 / 1_000_000;

    // Assume cache expires every 5 minutes
    const cacheWritesPerDay = Math.min(requestsPerDay, 24 * 12); // Max 288 per day
    const cacheReadsPerDay = Math.max(0, requestsPerDay - cacheWritesPerDay);

    const dailyCacheWriteCost = cacheWritesPerDay * info.estimatedTokens * CACHE_WRITE_PRICE;
    const dailyCacheReadCost = cacheReadsPerDay * info.estimatedTokens * CACHE_READ_PRICE;
    const dailyCost = dailyCacheWriteCost + dailyCacheReadCost;

    // Average cost per request
    const avgCostPerRequest = dailyCost / requestsPerDay;

    return {
      tokensPerRequest: info.estimatedTokens,
      costPerRequestUsd: avgCostPerRequest,
      dailyCostUsd: dailyCost,
      monthlyCostUsd: dailyCost * 30,
    };
  }

  /**
   * Create CLAUDE.md from template
   */
  createFromTemplate(projectPath: string, templateName: string): boolean {
    const template = this.templates.get(templateName);
    if (!template) {
      return false;
    }

    this.write(projectPath, template.content);
    return true;
  }

  /**
   * List available templates
   */
  listTemplates(): ClaudeMdTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Add a custom template
   */
  addTemplate(template: ClaudeMdTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Get a template by name
   */
  getTemplate(name: string): ClaudeMdTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Validate CLAUDE.md structure
   */
  validate(projectPath: string): { valid: boolean; issues: string[] } {
    const content = this.read(projectPath);
    const issues: string[] = [];

    if (!content) {
      return { valid: false, issues: ['CLAUDE.md does not exist'] };
    }

    // Check for common issues
    const info = this.getInfo(projectPath);

    // Token limit warning
    if (info.estimatedTokens > 50000) {
      issues.push(
        `Very large file (~${info.estimatedTokens} tokens). Consider splitting or trimming.`
      );
    } else if (info.estimatedTokens > 20000) {
      issues.push(
        `Large file (~${info.estimatedTokens} tokens). May significantly impact costs.`
      );
    }

    // Check for sections
    if (info.sections.length === 0) {
      issues.push('No markdown sections found. Consider organizing with headings.');
    }

    // Check for very long lines
    const lines = content.split('\n');
    const longLines = lines.filter((l) => l.length > 500);
    if (longLines.length > 0) {
      issues.push(`${longLines.length} lines exceed 500 characters. Consider breaking up.`);
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Parse sections from content
   */
  private parseSections(content: string): ClaudeMdSection[] {
    const sections: ClaudeMdSection[] = [];
    const lines = content.split('\n');

    let currentSection: ClaudeMdSection | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Close previous section
        if (currentSection) {
          currentSection.endLine = i;
          currentSection.contentLength = lines
            .slice(currentSection.startLine + 1, i)
            .join('\n').length;
          currentSection.estimatedTokens = Math.ceil(
            currentSection.contentLength / CHARS_PER_TOKEN
          );
          sections.push(currentSection);
        }

        // Start new section
        currentSection = {
          title: headingMatch[2].trim(),
          level: headingMatch[1].length,
          startLine: i,
          endLine: lines.length,
          contentLength: 0,
          estimatedTokens: 0,
        };
      }
    }

    // Close last section
    if (currentSection) {
      currentSection.endLine = lines.length;
      currentSection.contentLength = lines
        .slice(currentSection.startLine + 1)
        .join('\n').length;
      currentSection.estimatedTokens = Math.ceil(
        currentSection.contentLength / CHARS_PER_TOKEN
      );
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * Count words in content
   */
  private countWords(content: string): number {
    return content.split(/\s+/).filter((w) => w.length > 0).length;
  }

  /**
   * Estimate tokens from content
   */
  private estimateTokens(content: string): number {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  /**
   * Initialize default templates
   */
  private initializeDefaultTemplates(): void {
    this.templates.set('minimal', {
      name: 'minimal',
      description: 'Minimal CLAUDE.md with basic project info',
      estimatedTokens: 100,
      content: `# Project Instructions

## Overview
Brief description of the project.

## Key Commands
\`\`\`bash
npm install    # Install dependencies
npm run build  # Build project
npm test       # Run tests
\`\`\`

## Important Notes
- Note 1
- Note 2
`,
    });

    this.templates.set('standard', {
      name: 'standard',
      description: 'Standard CLAUDE.md with common sections',
      estimatedTokens: 500,
      content: `# Project Instructions

## Overview
Brief description of the project and its purpose.

## Tech Stack
- Language: TypeScript
- Framework:
- Database:

## Project Structure
\`\`\`
src/
├── index.ts
├── components/
└── utils/
\`\`\`

## Key Commands
\`\`\`bash
npm install    # Install dependencies
npm run dev    # Development mode
npm run build  # Build for production
npm test       # Run tests
\`\`\`

## Coding Standards
- Use TypeScript strict mode
- Follow existing code patterns
- Add tests for new features

## Important Notes
- Note 1
- Note 2
`,
    });

    this.templates.set('detailed', {
      name: 'detailed',
      description: 'Detailed CLAUDE.md with comprehensive documentation',
      estimatedTokens: 2000,
      content: `# Project Instructions

## Overview
Detailed description of the project, its goals, and architecture.

## Tech Stack
| Component | Technology |
|-----------|------------|
| Language | TypeScript |
| Framework |  |
| Database |  |
| Testing |  |

## Project Structure
\`\`\`
src/
├── index.ts          # Entry point
├── components/       # UI components
├── services/         # Business logic
├── utils/           # Utility functions
└── types/           # TypeScript definitions
\`\`\`

## Key Commands
\`\`\`bash
# Development
npm install          # Install dependencies
npm run dev          # Start development server
npm run build        # Build for production

# Testing
npm test             # Run all tests
npm run test:watch   # Watch mode

# Database
npm run db:migrate   # Run migrations
npm run db:seed      # Seed database
\`\`\`

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/items | List all items |
| POST | /api/items | Create item |
| PUT | /api/items/:id | Update item |
| DELETE | /api/items/:id | Delete item |

## Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| DATABASE_URL | DB connection | |
| API_KEY | API key | |

## Coding Standards
- Use TypeScript strict mode
- Follow existing code patterns
- Add tests for new features
- Document public APIs
- Use meaningful variable names

## Common Tasks
### Adding a new feature
1. Create feature branch
2. Implement feature
3. Add tests
4. Update documentation
5. Create PR

### Debugging
- Check logs in \`/tmp/app.log\`
- Use \`--debug\` flag for verbose output

## Important Notes
- Never commit secrets
- Run tests before pushing
- Update CHANGELOG for releases
`,
    });
  }
}

/**
 * Create a new CLAUDE.md manager instance
 */
export function createClaudeMdManager(): ClaudeMdManager {
  return new ClaudeMdManager();
}
