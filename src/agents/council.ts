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
import type { SubAgentType, TaskPriority } from './types.js';

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
      activeTaskIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(session.id, session);

    // Start council lifecycle
    this.runCouncilLifecycle(session, cwd).catch(err => {
      if (this.isCancelled(session)) {
        return;
      }
      session.status = 'failed';
      session.error = err instanceof Error ? err.message : String(err);
      session.completedAt = new Date();
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
    session.updatedAt = new Date();

    await this.cancelTrackedTasks(session);

    if (session.linkedSwarmId) {
      try {
        await swarmManager.cancelSwarm(session.linkedSwarmId);
      } catch {
        // Best effort cancellation
      }
      session.linkedSwarmId = undefined;
    }

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
      if (this.isCancelled(session)) {
        session.completedAt = session.completedAt || new Date();
        session.updatedAt = new Date();
        return;
      }
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
        const task = await this.runTrackedTask(session, prompt, member.agent, {
          priority: 'normal',
          cwd,
        });

        if (this.isCancelled(session) || task.status === 'cancelled') {
          return;
        }

        if (task.status !== 'completed') {
          session.deliberations.push({
            memberId: member.id,
            memberName: member.name,
            response: `Error: ${task.error || `Task ended with status: ${task.status}`}`,
            timestamp: new Date(),
          });
          return;
        }

        const entry: DeliberationEntry = {
          memberId: member.id,
          memberName: member.name,
          response: task.result || '(no response)',
          timestamp: new Date(),
        };

        session.deliberations.push(entry);
        session.updatedAt = new Date();
      } catch (error) {
        if (this.isCancelled(session)) {
          return;
        }
        session.deliberations.push({
          memberId: member.id,
          memberName: member.name,
          response: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      }
    });

    await Promise.allSettled(deliberationPromises);
    session.updatedAt = new Date();

    if (this.isCancelled(session)) return;

    // Phase 2: Cross-scoring (LLM-based with heuristic fallback)
    session.status = 'scoring';
    session.updatedAt = new Date();

    const scoringResults = await this.crossScoreAsync(session, cwd);
    session.scores = scoringResults;

    if (this.isCancelled(session)) return;

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
      if (this.isCancelled(session)) return;

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
        const task = await this.runTrackedTask(session, prompt, member.agent, {
          priority: 'normal',
          cwd,
        });

        if (this.isCancelled(session) || task.status === 'cancelled') {
          return;
        }

        if (task.status !== 'completed') {
          session.deliberations.push({
            memberId: member.id,
            memberName: member.name,
            response: `Error: ${task.error || `Task ended with status: ${task.status}`}`,
            timestamp: new Date(),
          });
          continue;
        }

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
        if (this.isCancelled(session)) {
          return;
        }
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
          const task = await this.runTrackedTask(session, prompt, member.agent, {
            priority: 'normal',
            cwd,
          });

          if (this.isCancelled(session) || task.status === 'cancelled') {
            return;
          }

          if (task.status !== 'completed') {
            session.deliberations.push({
              memberId: member.id,
              memberName: member.name,
              response: `Error: ${task.error || `Task ended with status: ${task.status}`}`,
              timestamp: new Date(),
              votes: 0,
            });
            return;
          }

          const entry: DeliberationEntry = {
            memberId: member.id,
            memberName: member.name,
            response: task.result || '(no response)',
            timestamp: new Date(),
            votes: 0,
          };

          session.deliberations.push(entry);
        } catch (error) {
          if (this.isCancelled(session)) {
            return;
          }
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

      if (this.isCancelled(session)) return;

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
    session.linkedSwarmId = swarmSession.id;

    // Wait for swarm to complete (poll at 2s intervals).
    // Timeout scales with maxRounds (each round ≈ 5 min), minimum 5 minutes,
    // so large councils get proportionally more time to finish.
    const timeoutMs = Math.max(5 * 60_000, session.config.maxRounds * 5 * 60_000);
    const pollIntervalMs = 2000;
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
    let attempts = 0;
    while (
      !this.isCancelled(session) &&
      !['completed', 'failed', 'cancelled'].includes(swarmSession.status) &&
      attempts < maxAttempts
    ) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      attempts++;
    }

    session.linkedSwarmId = undefined;

    if (this.isCancelled(session) || swarmSession.status === 'cancelled') {
      return;
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

    if (this.isCancelled(session)) {
      return;
    }

    // Phase 2: Overseer reviews
    session.status = 'reviewing';
    session.updatedAt = new Date();

    const reviewPrompt = `You are the overseer reviewing results from your team.

Original task: ${session.prompt}

Team results:
${swarmSession.result}

Review these results. Synthesize, correct errors, fill gaps, and produce the final authoritative response.`;

    try {
      const reviewTask = await this.runTrackedTask(session, reviewPrompt, lead.agent, {
        priority: 'high',
        cwd,
      });

      if (this.isCancelled(session) || reviewTask.status === 'cancelled') {
        return;
      }

      if (reviewTask.status !== 'completed') {
        throw new Error(reviewTask.error || `Task ended with status: ${reviewTask.status}`);
      }

      session.deliberations.push({
        memberId: lead.id,
        memberName: lead.name,
        response: reviewTask.result || '(no review)',
        timestamp: new Date(),
      });

      session.result = reviewTask.result || swarmSession.result;
      session.winnerId = lead.id;
    } catch (error) {
      if (this.isCancelled(session)) {
        return;
      }
      // Fall back to swarm results
      session.result = swarmSession.result;
      session.error = `Overseer review failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
  }

  /**
   * LLM-based cross-scoring: spawns a scoring agent to evaluate responses.
   * Returns null if LLM scoring fails (caller should fall back to heuristic).
   */
  private async llmCrossScore(session: CouncilSession, cwd?: string): Promise<Score[] | null> {
    const entries = session.deliberations;
    if (entries.length === 0) return null;

    const responseSummaries = entries.map((entry, i) =>
      `--- Response ${i + 1} (by ${entry.memberName}) ---\n${entry.response}`
    ).join('\n\n');

    const scoringPrompt = `You are an impartial judge evaluating ${entries.length} responses to the following prompt:

"${session.prompt}"

Here are the responses:

${responseSummaries}

Evaluate each response on correctness, completeness, and quality. Return ONLY a JSON array of scores (0-100), one per response, in the same order they were presented. Example for 3 responses: [85, 72, 90]

Return ONLY the JSON array, no other text.`;

    try {
      const task = await this.runTrackedTask(session, scoringPrompt, 'calliope', {
        priority: 'normal',
        cwd,
      });

      if (this.isCancelled(session) || task.status === 'cancelled') {
        return null;
      }

      if (task.status !== 'completed') {
        return null;
      }

      const result = (task.result || '').trim();

      // Extract JSON array from response (handle markdown fences, leading text, etc.)
      const arrayMatch = result.match(/\[[\s\d,]+\]/);
      if (!arrayMatch) return null;

      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed) || parsed.length !== entries.length) return null;

      // Validate all entries are numbers in range
      const numericScores: number[] = parsed.map((v: unknown) => {
        const n = Number(v);
        if (isNaN(n)) throw new Error('non-numeric score');
        return Math.max(0, Math.min(100, Math.round(n)));
      });

      const scores: Score[] = entries.map((entry, i) => {
        entry.score = numericScores[i];
        return {
          scorerId: 'llm',
          targetId: entry.memberId,
          score: numericScores[i],
          weight: 1.0,
        };
      });

      return scores;
    } catch {
      return null;
    }
  }

  private async runTrackedTask(
    session: CouncilSession,
    prompt: string,
    agent: SubAgentType,
    options: {
      priority?: TaskPriority;
      cwd?: string;
      timeout?: number;
    } = {}
  ): Promise<Awaited<ReturnType<typeof orchestrator.spawnAgent>>> {
    const task = await orchestrator.spawnAgent(prompt, agent, {
      background: true,
      priority: options.priority,
      cwd: options.cwd,
      timeout: options.timeout,
    });

    this.trackTask(session, task.id);

    try {
      return await orchestrator.waitForTask(task.id);
    } finally {
      this.untrackTask(session, task.id);
    }
  }

  private trackTask(session: CouncilSession, taskId: string): void {
    if (!session.activeTaskIds.includes(taskId)) {
      session.activeTaskIds.push(taskId);
    }
  }

  private untrackTask(session: CouncilSession, taskId: string): void {
    const index = session.activeTaskIds.indexOf(taskId);
    if (index !== -1) {
      session.activeTaskIds.splice(index, 1);
    }
  }

  private isCancelled(session: CouncilSession): boolean {
    return session.status === 'cancelled';
  }

  private async cancelTrackedTasks(session: CouncilSession): Promise<void> {
    const taskIds = [...session.activeTaskIds];
    session.activeTaskIds.length = 0;
    await Promise.allSettled(taskIds.map(taskId => orchestrator.cancelTask(taskId)));
  }

  /**
   * Heuristic cross-scoring fallback: scores based on response structure.
   */
  private heuristicCrossScore(session: CouncilSession): Score[] {
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
   * Cross-score deliberations (sync fallback for non-competitive callers).
   */
  private crossScore(session: CouncilSession): Score[] {
    return this.heuristicCrossScore(session);
  }

  /**
   * Async cross-scoring: tries LLM evaluation first, falls back to heuristics.
   */
  private async crossScoreAsync(session: CouncilSession, cwd?: string): Promise<Score[]> {
    if (this.isCancelled(session)) {
      return [];
    }
    const llmScores = await this.llmCrossScore(session, cwd);
    if (this.isCancelled(session)) {
      return [];
    }
    if (llmScores) return llmScores;
    return this.heuristicCrossScore(session);
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
    for (const session of this.sessions.values()) {
      void this.cancelTrackedTasks(session);
      if (session.linkedSwarmId) {
        void swarmManager.cancelSwarm(session.linkedSwarmId);
      }
    }
    this.sessions.clear();
  }
}

/**
 * Singleton council manager instance
 */
export const councilManager = new CouncilManager();
