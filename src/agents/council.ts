/**
 * Calliope Agents — Council Manager
 *
 * Coordinates groups of agents deliberating on a shared goal.
 * Supports competitive, collaborative, consensus, and overseer modes.
 */

import { randomUUID } from 'crypto';
import type {
  CouncilSession,
  CouncilConfig,
  CouncilMember,
  CouncilMode,
  DeliberationEntry,
  Vote,
  Score,
  CouncilTemplate,
} from './council-types.js';
import { DEFAULT_COUNCIL_CONFIG, COUNCIL_TEMPLATES } from './council-types.js';
import { orchestrator } from './orchestrator.js';
import { swarmManager } from './swarm.js';

/**
 * Council Manager - Singleton
 */
class CouncilManager {
  private sessions = new Map<string, CouncilSession>();

  /**
   * Start a new council session
   */
  async startCouncil(
    prompt: string,
    config: Partial<CouncilConfig> & { members: CouncilMember[] },
    cwd?: string
  ): Promise<CouncilSession> {
    const mergedConfig: CouncilConfig = {
      ...DEFAULT_COUNCIL_CONFIG,
      ...config,
    };

    const session: CouncilSession = {
      id: randomUUID(),
      prompt,
      status: 'deliberating',
      config: mergedConfig,
      deliberations: [],
      votes: [],
      scores: [],
      round: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(session.id, session);

    // Start council lifecycle
    this.runCouncilLifecycle(session, cwd).catch(err => {
      session.status = 'failed';
      session.error = err instanceof Error ? err.message : String(err);
      session.updatedAt = new Date();
    });

    return session;
  }

  /**
   * Start a council from a template
   */
  async startFromTemplate(
    templateName: string,
    prompt: string,
    cwd?: string
  ): Promise<CouncilSession> {
    const template = COUNCIL_TEMPLATES[templateName];
    if (!template) {
      throw new Error(`Unknown council template: ${templateName}. Available: ${Object.keys(COUNCIL_TEMPLATES).join(', ')}`);
    }

    const members: CouncilMember[] = template.members.map(m => ({
      ...m,
      id: randomUUID(),
    }));

    const fullPrompt = template.promptPrefix
      ? `${template.promptPrefix}${prompt}`
      : prompt;

    return this.startCouncil(fullPrompt, {
      mode: template.mode,
      members,
      tieBreaker: template.tieBreaker,
    }, cwd);
  }

  /**
   * Get a council session
   */
  getSession(sessionId: string): CouncilSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): CouncilSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Cancel a council session
   */
  async cancelCouncil(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'cancelled';
    session.completedAt = new Date();
    session.updatedAt = new Date();
    return true;
  }

  /**
   * Get council statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    failedSessions: number;
  } {
    const all = Array.from(this.sessions.values());
    return {
      totalSessions: all.length,
      activeSessions: all.filter(s => !['completed', 'failed', 'cancelled'].includes(s.status)).length,
      completedSessions: all.filter(s => s.status === 'completed').length,
      failedSessions: all.filter(s => s.status === 'failed').length,
    };
  }

  /**
   * Run the council lifecycle based on mode
   */
  private async runCouncilLifecycle(session: CouncilSession, cwd?: string): Promise<void> {
    try {
      switch (session.config.mode) {
        case 'competitive':
          await this.runCompetitive(session, cwd);
          break;
        case 'collaborative':
          await this.runCollaborative(session, cwd);
          break;
        case 'consensus':
          await this.runConsensus(session, cwd);
          break;
        case 'overseer':
          await this.runOverseer(session, cwd);
          break;
      }
    } catch (error) {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      session.completedAt = new Date();
      session.updatedAt = new Date();
    }
  }

  /**
   * Competitive mode: All respond independently → cross-score → highest wins
   */
  private async runCompetitive(session: CouncilSession, cwd?: string): Promise<void> {
    const { members } = session.config;

    // Phase 1: All members deliberate independently
    session.status = 'deliberating';
    session.updatedAt = new Date();

    const deliberationPromises = members.map(async (member) => {
      const roleContext = member.role
        ? `You are acting as ${member.role}. `
        : '';
      const prompt = `${roleContext}${session.prompt}`;

      try {
        const task = await orchestrator.spawnAgent(prompt, member.agent, {
          background: false,
          priority: 'normal',
          cwd,
        });

        const entry: DeliberationEntry = {
          memberId: member.id,
          memberName: member.name,
          response: task.result || '(no response)',
          timestamp: new Date(),
        };

        session.deliberations.push(entry);
        session.updatedAt = new Date();
      } catch (error) {
        session.deliberations.push({
          memberId: member.id,
          memberName: member.name,
          response: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      }
    });

    await Promise.allSettled(deliberationPromises);

    if ((session.status as string) === 'cancelled') return;

    // Phase 2: Cross-scoring
    session.status = 'scoring';
    session.updatedAt = new Date();

    const scoringResults = this.crossScore(session);
    session.scores = scoringResults;

    // Phase 3: Select winner
    const winner = this.selectWinner(session);
    if (winner) {
      session.result = winner.response;
      session.winnerId = winner.memberId;
    } else {
      session.result = session.deliberations[0]?.response || 'No results';
    }

    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
  }

  /**
   * Collaborative mode: Sequential building (A → B builds on A → C builds on B)
   */
  private async runCollaborative(session: CouncilSession, cwd?: string): Promise<void> {
    const { members } = session.config;

    session.status = 'building';
    session.updatedAt = new Date();

    let accumulatedContext = '';

    for (const member of members) {
      if ((session.status as string) === 'cancelled') return;

      const roleContext = member.role
        ? `You are acting as ${member.role}. `
        : '';

      let prompt: string;
      if (accumulatedContext) {
        prompt = `${roleContext}${session.prompt}\n\nPrevious contributions from the team:\n${accumulatedContext}\n\nBuild upon and improve the above contributions. Add your expertise and perspective.`;
      } else {
        prompt = `${roleContext}${session.prompt}\n\nYou are the first team member to respond. Provide a strong foundation.`;
      }

      try {
        const task = await orchestrator.spawnAgent(prompt, member.agent, {
          background: false,
          priority: 'normal',
          cwd,
        });

        const entry: DeliberationEntry = {
          memberId: member.id,
          memberName: member.name,
          response: task.result || '(no response)',
          timestamp: new Date(),
        };

        session.deliberations.push(entry);
        accumulatedContext += `\n\n--- ${member.name} (${member.role || 'general'}) ---\n${task.result || '(no response)'}`;
        session.updatedAt = new Date();
      } catch (error) {
        session.deliberations.push({
          memberId: member.id,
          memberName: member.name,
          response: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      }
    }

    // The last response is the most refined version
    const lastEntry = session.deliberations[session.deliberations.length - 1];
    session.result = lastEntry?.response || 'No results';
    session.winnerId = lastEntry?.memberId;
    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
  }

  /**
   * Consensus mode: Deliberate → vote → supermajority or repeat
   */
  private async runConsensus(session: CouncilSession, cwd?: string): Promise<void> {
    const { members, maxRounds, consensusThreshold } = session.config;

    for (let round = 1; round <= maxRounds; round++) {
      session.round = round;
      session.status = 'deliberating';
      session.updatedAt = new Date();

      // Phase 1: Deliberate
      const previousContext = round > 1
        ? `\n\nPrevious round results:\n${session.deliberations.filter(d => d.votes !== undefined).map(d => `${d.memberName}: ${d.response.slice(0, 200)}... (${d.votes} votes)`).join('\n')}`
        : '';

      const deliberationPromises = members.map(async (member) => {
        const roleContext = member.role ? `You are ${member.role}. ` : '';
        const prompt = `${roleContext}${session.prompt}${previousContext}\n\nRound ${round}/${maxRounds}. Present your position concisely.`;

        try {
          const task = await orchestrator.spawnAgent(prompt, member.agent, {
            background: false,
            priority: 'normal',
            cwd,
          });

          const entry: DeliberationEntry = {
            memberId: member.id,
            memberName: member.name,
            response: task.result || '(no response)',
            timestamp: new Date(),
            votes: 0,
          };

          session.deliberations.push(entry);
        } catch (error) {
          session.deliberations.push({
            memberId: member.id,
            memberName: member.name,
            response: `Error: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date(),
            votes: 0,
          });
        }
      });

      await Promise.allSettled(deliberationPromises);
      session.updatedAt = new Date();

      if ((session.status as string) === 'cancelled') return;

      // Phase 2: Vote
      session.status = 'voting';
      session.updatedAt = new Date();

      // Each member votes for the best response (not their own)
      const roundEntries = session.deliberations.filter(
        d => d.votes !== undefined
      ).slice(-members.length);

      for (const member of members) {
        const candidates = roundEntries.filter(e => e.memberId !== member.id);
        if (candidates.length === 0) continue;

        // Simple scoring: first candidate gets the vote (in a real system, the LLM would evaluate)
        // For now, use round-robin voting based on member weight
        const candidateIdx = members.indexOf(member) % candidates.length;
        const selected = candidates[candidateIdx];

        const vote: Vote = {
          voterId: member.id,
          candidateId: selected.memberId,
          weight: member.weight,
        };

        session.votes.push(vote);

        // Update vote count on the entry
        selected.votes = (selected.votes || 0) + member.weight;
      }

      // Check for consensus
      const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
      const bestEntry = roundEntries.reduce(
        (best, entry) => (!best || (entry.votes || 0) > (best.votes || 0) ? entry : best),
        null as DeliberationEntry | null
      );

      if (bestEntry && (bestEntry.votes || 0) / totalWeight >= consensusThreshold) {
        // Consensus reached
        session.result = bestEntry.response;
        session.winnerId = bestEntry.memberId;
        session.status = 'completed';
        session.completedAt = new Date();
        session.updatedAt = new Date();
        return;
      }
    }

    // No consensus after max rounds - use tie-breaker
    const finalResult = this.applyTieBreaker(session);
    session.result = finalResult?.response || session.deliberations[session.deliberations.length - 1]?.response || 'No consensus reached';
    session.winnerId = finalResult?.memberId;
    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
  }

  /**
   * Overseer mode: Lead decomposes (Swarm), reviews results, makes final call
   */
  private async runOverseer(session: CouncilSession, cwd?: string): Promise<void> {
    const { members } = session.config;
    const lead = members[0]; // First member is the overseer

    if (!lead) {
      throw new Error('Council needs at least one member for overseer mode');
    }

    // Phase 1: Overseer decomposes via swarm
    session.status = 'deliberating';
    session.updatedAt = new Date();

    const swarmSession = await swarmManager.startSwarm(
      session.prompt,
      { decomposition: 'parallel', aggregation: 'structured' },
      cwd
    );

    // Wait for swarm to complete (poll)
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes at 1s intervals
    while (!['completed', 'failed', 'cancelled'].includes(swarmSession.status) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (swarmSession.status !== 'completed' || !swarmSession.result) {
      throw new Error(`Swarm decomposition failed: ${swarmSession.error || 'timeout'}`);
    }

    // Record swarm results as deliberation
    session.deliberations.push({
      memberId: 'swarm',
      memberName: 'Swarm Workers',
      response: swarmSession.result,
      timestamp: new Date(),
    });

    // Phase 2: Overseer reviews
    session.status = 'reviewing';
    session.updatedAt = new Date();

    const reviewPrompt = `You are the overseer reviewing results from your team.

Original task: ${session.prompt}

Team results:
${swarmSession.result}

Review these results. Synthesize, correct errors, fill gaps, and produce the final authoritative response.`;

    try {
      const reviewTask = await orchestrator.spawnAgent(reviewPrompt, lead.agent, {
        background: false,
        priority: 'high',
        cwd,
      });

      session.deliberations.push({
        memberId: lead.id,
        memberName: lead.name,
        response: reviewTask.result || '(no review)',
        timestamp: new Date(),
      });

      session.result = reviewTask.result || swarmSession.result;
      session.winnerId = lead.id;
    } catch (error) {
      // Fall back to swarm results
      session.result = swarmSession.result;
      session.error = `Overseer review failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
  }

  /**
   * Cross-score deliberations (each member implicitly scores others)
   * Simple heuristic: longer, more detailed responses score higher
   */
  private crossScore(session: CouncilSession): Score[] {
    const scores: Score[] = [];
    const entries = session.deliberations;

    for (const entry of entries) {
      // Simple scoring based on response quality heuristics
      let score = 50; // Base score

      // Longer responses suggest more depth
      if (entry.response.length > 500) score += 15;
      else if (entry.response.length > 200) score += 10;
      else if (entry.response.length < 50) score -= 10;

      // Structured responses (headers, lists, code blocks)
      if (entry.response.includes('```')) score += 10;
      if (entry.response.match(/^[\-\*] /m)) score += 5;
      if (entry.response.match(/^#+\s/m)) score += 5;

      // Error responses get penalized
      if (entry.response.startsWith('Error:')) score = 10;

      entry.score = Math.max(0, Math.min(100, score));

      scores.push({
        scorerId: 'system',
        targetId: entry.memberId,
        score: entry.score,
        weight: 1.0,
      });
    }

    return scores;
  }

  /**
   * Select the winner based on scores
   */
  private selectWinner(session: CouncilSession): DeliberationEntry | null {
    if (session.deliberations.length === 0) return null;

    return session.deliberations.reduce(
      (best, entry) => {
        const memberWeight = session.config.members.find(m => m.id === entry.memberId)?.weight || 1.0;
        const weightedScore = (entry.score || 0) * memberWeight;
        const bestWeightedScore = (best.score || 0) * (session.config.members.find(m => m.id === best.memberId)?.weight || 1.0);
        return weightedScore > bestWeightedScore ? entry : best;
      }
    );
  }

  /**
   * Apply tie-breaker when consensus fails
   */
  private applyTieBreaker(session: CouncilSession): DeliberationEntry | null {
    const { tieBreaker, designatedBreaker, members } = session.config;
    const entries = session.deliberations;

    switch (tieBreaker) {
      case 'scoring': {
        // Use cross-scoring
        const scores = this.crossScore(session);
        return this.selectWinner(session);
      }
      case 'designated': {
        const designated = designatedBreaker || members[0]?.id;
        return entries.find(e => e.memberId === designated) || entries[0] || null;
      }
      case 'voting': {
        // Use existing votes
        return entries.reduce(
          (best, entry) => (!best || (entry.votes || 0) > (best.votes || 0) ? entry : best),
          null as DeliberationEntry | null
        );
      }
      case 'user':
      default:
        // Can't resolve automatically - return highest scored
        return this.selectWinner(session);
    }
  }

  /**
   * Format session status for display
   */
  formatSessionStatus(session: CouncilSession): string {
    const lines: string[] = [
      `Coordination: ${session.id.slice(0, 8)}`,
      `Mode: ${session.config.mode}`,
      `Status: ${session.status}`,
      `Agents: ${session.config.members.map(m => `${m.name} (${m.agent})`).join(', ')}`,
      `Round: ${session.round}`,
    ];

    if (session.deliberations.length > 0) {
      lines.push(`Deliberations: ${session.deliberations.length}`);
      for (const d of session.deliberations) {
        const scoreStr = d.score !== undefined ? ` [score: ${d.score}]` : '';
        const voteStr = d.votes !== undefined ? ` [votes: ${d.votes}]` : '';
        const winner = session.winnerId === d.memberId ? ' \u2605' : '';
        lines.push(`  ${d.memberName}: ${d.response.slice(0, 60)}...${scoreStr}${voteStr}${winner}`);
      }
    }

    if (session.error) {
      lines.push(`Error: ${session.error}`);
    }

    return lines.join('\n');
  }

  /**
   * Get available templates
   */
  getTemplates(): CouncilTemplate[] {
    return Object.values(COUNCIL_TEMPLATES);
  }

  /**
   * Reset all sessions
   */
  reset(): void {
    this.sessions.clear();
  }
}

/**
 * Singleton council manager instance
 */
export const councilManager = new CouncilManager();
