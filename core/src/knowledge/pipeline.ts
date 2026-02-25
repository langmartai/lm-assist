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
