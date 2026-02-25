/**
 * Knowledge Pipeline
 *
 * Orchestrates: identify → store identification → format → store knowledge.
 *
 * The pipeline is the V2 entry point for knowledge generation. It coordinates
 * identifiers (which discover/resolve content) with formatters (which transform
 * content into knowledge documents). The KnowledgeGenerator delegates to this
 * pipeline while maintaining its backwards-compatible API.
 */

import type { IdentificationResult, IdentifierType } from './identifier-types';
import { getIdentificationStore } from './identification-store';
import { getIdentifier, getAllIdentifiers } from './identifiers/index';
import { getFormatter } from './formatters/index';
import { getKnowledgeStore } from './store';
import type { Knowledge } from './types';

export class KnowledgePipeline {
  /**
   * Discover candidates for a project using one or all identifier types.
   * Stores identification results and returns them.
   */
  async discover(
    project: string,
    identifierType?: IdentifierType,
  ): Promise<IdentificationResult[]> {
    if (identifierType) {
      const identifier = getIdentifier(identifierType);
      return identifier.discover(project);
    }

    // Run all identifiers
    const allResults: IdentificationResult[] = [];
    for (const identifier of getAllIdentifiers()) {
      try {
        const results = await identifier.discover(project);
        allResults.push(...results);
      } catch (err) {
        console.error(`[KnowledgePipeline] Identifier ${identifier.type} failed:`, err);
      }
    }
    return allResults;
  }

  /**
   * Generate knowledge from an existing identification result.
   * Loads the identification, formats it, stores the knowledge, and updates the identification status.
   */
  async generate(
    identificationId: string,
    project: string,
    options?: { title?: string },
  ): Promise<Knowledge> {
    const idStore = getIdentificationStore();
    const knowledgeStore = getKnowledgeStore();

    // Load identification
    const identification = idStore.get(identificationId);
    if (!identification) {
      throw new Error(`Identification ${identificationId} not found`);
    }

    if (identification.status === 'generated' && identification.knowledgeId) {
      throw new Error(`Identification ${identificationId} already generated as ${identification.knowledgeId}`);
    }

    // Format using the appropriate formatter
    const formatter = getFormatter(identification.identifierType);
    const formatResult = await formatter.format(identification);

    // Allow title override
    const title = options?.title || formatResult.title;

    // Create knowledge document
    const knowledge = knowledgeStore.createKnowledge({
      title,
      type: formatResult.type,
      project,
      parts: formatResult.parts,
      status: 'active',
      sourceSessionId: identification.sessionId,
      sourceAgentId: identification.agentId,
      sourceTimestamp: formatResult.sourceTimestamp,
      sourceIdentifier: identification.identifierType,
      sourceLineIndex: identification.lineIndex,
      sourceTurnIndex: identification.turnIndex,
    });

    // Update identification status
    idStore.update(identificationId, {
      knowledgeId: knowledge.id,
      status: 'generated',
    });

    return knowledge;
  }

  /**
   * Generate knowledge from generic content (manual, no prior identification needed).
   * Identifies the content, then generates knowledge in one step.
   */
  async generateFromGenericContent(
    sessionId: string,
    lineIndex: number,
    project: string,
    title?: string,
  ): Promise<Knowledge> {
    const identifier = getIdentifier('generic-content');

    // Resolve (creates identification result)
    const identification = await identifier.resolve(project, sessionId, lineIndex);
    if (!identification) {
      throw new Error(`No valid content found at session ${sessionId} line ${lineIndex}`);
    }

    // Generate from the identification
    return this.generate(identification.id, project, { title });
  }

  /**
   * Generate knowledge from all validated identifications for a project.
   * Processes sequentially. Uses LLM-suggested title when available.
   */
  async generateValidated(
    project: string,
    identifierType?: IdentifierType,
  ): Promise<{ generated: number; errors: number; skipped: number; results: Array<{ id: string; knowledgeId?: string; error?: string }> }> {
    const idStore = getIdentificationStore();
    const filters: any = { status: 'validated' as const };
    if (identifierType) filters.identifierType = identifierType;

    const validated = idStore.list(filters);
    if (validated.length === 0) {
      return { generated: 0, errors: 0, skipped: 0, results: [] };
    }

    let generated = 0;
    let errors = 0;
    let skipped = 0;
    const results: Array<{ id: string; knowledgeId?: string; error?: string }> = [];

    for (const identification of validated) {
      try {
        // Use LLM-suggested title if available
        const title = identification.suggestedTitle || undefined;
        const knowledge = await this.generate(identification.id, project, { title });
        generated++;
        results.push({ id: identification.id, knowledgeId: knowledge.id });
      } catch (err: any) {
        const msg = err.message || String(err);
        // Skip already-generated (not an error)
        if (msg.includes('already generated')) {
          skipped++;
          results.push({ id: identification.id, error: 'already generated' });
        } else {
          errors++;
          results.push({ id: identification.id, error: msg });
          console.error(`[KnowledgePipeline] Failed to generate ${identification.id}:`, msg);
        }
      }
    }

    // Schedule async vector indexing
    this.indexKnowledgeVectorsAsync();

    return { generated, errors, skipped, results };
  }

  /**
   * Schedule async vector indexing after batch generation.
   */
  private _vectorIndexTimer: ReturnType<typeof setTimeout> | null = null;
  private indexKnowledgeVectorsAsync(): void {
    if (this._vectorIndexTimer) clearTimeout(this._vectorIndexTimer);
    this._vectorIndexTimer = setTimeout(async () => {
      try {
        const { extractKnowledgeVectors } = require('../vector/knowledge-vectors');
        await extractKnowledgeVectors();
      } catch (err) {
        console.error('[KnowledgePipeline] Vector indexing failed:', err);
      }
    }, 5_000);
  }

  /**
   * Preview what knowledge would look like from generic content.
   * Read-only — does not create identifications or knowledge documents.
   */
  async previewGenericContent(
    sessionId: string,
    lineIndex: number,
    project: string,
    title?: string,
  ): Promise<{ title: string; type: string; parts: any[]; sourceTimestamp?: string }> {
    // Build a temporary identification for the formatter (not stored)
    const tempIdentification: IdentificationResult = {
      id: '',
      sessionId,
      lineIndex,
      turnIndex: 0,
      projectPath: project,
      timestamp: new Date().toISOString(),
      identifiedAt: new Date().toISOString(),
      identifierType: 'generic-content',
      status: 'candidate',
    };

    const formatter = getFormatter('generic-content');
    try {
      const result = await formatter.format(tempIdentification);
      return {
        title: title || result.title,
        type: result.type,
        parts: result.parts,
        sourceTimestamp: result.sourceTimestamp,
      };
    } catch {
      throw new Error(`No valid content found at session ${sessionId} line ${lineIndex}`);
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgePipeline | null = null;
export function getKnowledgePipeline(): KnowledgePipeline {
  if (!instance) instance = new KnowledgePipeline();
  return instance;
}
