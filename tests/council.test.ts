import { describe, it, expect } from 'vitest';
import type {
  CouncilSession,
  CouncilConfig,
  CouncilMember,
  CouncilMode,
  CouncilTemplate,
  DeliberationEntry,
  Vote,
  Score,
  TieBreaker,
} from '../src/agterm/council-types.js';
import { DEFAULT_COUNCIL_CONFIG, COUNCIL_TEMPLATES } from '../src/agterm/council-types.js';

// ============================================================================
// Council Types
// ============================================================================

describe('Council Types', () => {
  describe('DEFAULT_COUNCIL_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_COUNCIL_CONFIG.mode).toBe('competitive');
      expect(DEFAULT_COUNCIL_CONFIG.tieBreaker).toBe('scoring');
      expect(DEFAULT_COUNCIL_CONFIG.maxRounds).toBe(3);
      expect(DEFAULT_COUNCIL_CONFIG.consensusThreshold).toBe(0.67);
    });
  });

  describe('CouncilSession structure', () => {
    it('should have all required fields', () => {
      const members: CouncilMember[] = [
        { id: 'a', name: 'Agent A', agent: 'claude', weight: 1.0 },
      ];

      const session: CouncilSession = {
        id: 'test',
        prompt: 'Review this code',
        status: 'deliberating',
        config: { ...DEFAULT_COUNCIL_CONFIG, members },
        deliberations: [],
        votes: [],
        scores: [],
        round: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(session.id).toBeDefined();
      expect(session.prompt).toBeDefined();
      expect(session.status).toBe('deliberating');
      expect(session.config.members.length).toBe(1);
      expect(session.round).toBe(1);
    });

    it('should support all status values', () => {
      const statuses: CouncilSession['status'][] = [
        'deliberating', 'voting', 'scoring', 'building', 'reviewing',
        'completed', 'failed', 'cancelled',
      ];
      expect(statuses.length).toBe(8);
    });
  });

  describe('CouncilMember', () => {
    it('should support optional role and weight', () => {
      const member: CouncilMember = {
        id: 'test',
        name: 'Reviewer',
        agent: 'claude',
        role: 'security-expert',
        weight: 1.5,
      };

      expect(member.role).toBe('security-expert');
      expect(member.weight).toBe(1.5);
    });
  });

  describe('DeliberationEntry', () => {
    it('should support optional score and votes', () => {
      const entry: DeliberationEntry = {
        memberId: 'a',
        memberName: 'Agent A',
        response: 'My analysis is...',
        timestamp: new Date(),
        score: 85,
        votes: 3,
      };

      expect(entry.score).toBe(85);
      expect(entry.votes).toBe(3);
    });
  });

  describe('Vote', () => {
    it('should have voter and candidate', () => {
      const vote: Vote = {
        voterId: 'a',
        candidateId: 'b',
        weight: 1.0,
      };

      expect(vote.voterId).toBe('a');
      expect(vote.candidateId).toBe('b');
    });
  });

  describe('Score', () => {
    it('should have scorer, target, and score', () => {
      const score: Score = {
        scorerId: 'a',
        targetId: 'b',
        score: 75,
        weight: 1.0,
      };

      expect(score.score).toBe(75);
    });
  });
});

// ============================================================================
// Council Templates
// ============================================================================

describe('Council Templates', () => {
  it('should have 5 built-in templates', () => {
    expect(Object.keys(COUNCIL_TEMPLATES).length).toBe(5);
  });

  it('should have code-review template', () => {
    const template = COUNCIL_TEMPLATES['code-review'];
    expect(template).toBeDefined();
    expect(template.mode).toBe('competitive');
    expect(template.members.length).toBe(3);
    expect(template.members[2].role).toBe('security-reviewer');
    expect(template.members[2].weight).toBe(1.2);
  });

  it('should have architecture template', () => {
    const template = COUNCIL_TEMPLATES['architecture'];
    expect(template).toBeDefined();
    expect(template.mode).toBe('collaborative');
    expect(template.members[0].weight).toBe(1.5); // Lead architect has higher weight
    expect(template.tieBreaker).toBe('designated');
  });

  it('should have security-audit template', () => {
    const template = COUNCIL_TEMPLATES['security-audit'];
    expect(template).toBeDefined();
    expect(template.mode).toBe('competitive');
    expect(template.members.length).toBe(3);
    expect(template.promptPrefix).toContain('security audit');
  });

  it('should have brainstorm template', () => {
    const template = COUNCIL_TEMPLATES['brainstorm'];
    expect(template).toBeDefined();
    expect(template.mode).toBe('collaborative');
    expect(template.tieBreaker).toBe('voting');
  });

  it('should have debate template', () => {
    const template = COUNCIL_TEMPLATES['debate'];
    expect(template).toBeDefined();
    expect(template.mode).toBe('competitive');
    expect(template.members.length).toBe(3);
    // Judge should have higher weight
    expect(template.members[2].weight).toBe(1.5);
    expect(template.members[2].role).toBe('impartial-judge');
  });

  it('all templates should have required fields', () => {
    for (const [name, template] of Object.entries(COUNCIL_TEMPLATES)) {
      expect(template.name).toBe(name);
      expect(template.description).toBeTruthy();
      expect(template.mode).toBeTruthy();
      expect(template.members.length).toBeGreaterThan(0);
      expect(template.tieBreaker).toBeTruthy();

      // Every member should have name, agent, weight
      for (const member of template.members) {
        expect(member.name).toBeTruthy();
        expect(member.agent).toBeTruthy();
        expect(member.weight).toBeGreaterThan(0);
      }
    }
  });

  it('all templates should have prompt prefixes', () => {
    for (const template of Object.values(COUNCIL_TEMPLATES)) {
      expect(template.promptPrefix).toBeTruthy();
    }
  });
});

// ============================================================================
// Council Modes
// ============================================================================

describe('Council Modes', () => {
  it('should have all 4 modes', () => {
    const modes: CouncilMode[] = ['consensus', 'competitive', 'collaborative', 'overseer'];
    expect(modes.length).toBe(4);
  });

  it('should have all 4 tie-breakers', () => {
    const breakers: TieBreaker[] = ['voting', 'scoring', 'designated', 'user'];
    expect(breakers.length).toBe(4);
  });
});

// ============================================================================
// Integration: AGTERM_TOOL_NAMES
// ============================================================================

describe('Council Tool Integration', () => {
  it('should include council tools in AGTERM_TOOL_NAMES', async () => {
    const { AGTERM_TOOL_NAMES } = await import('../src/agterm/tools.js');
    expect(AGTERM_TOOL_NAMES).toContain('start_council');
    expect(AGTERM_TOOL_NAMES).toContain('check_council');
    expect(AGTERM_TOOL_NAMES).toContain('cancel_council');
  });

  it('should have 10 total agterm tools', async () => {
    const { getAgtermTools } = await import('../src/agterm/tools.js');
    const tools = getAgtermTools();
    expect(tools.length).toBe(10);
  });

  it('should have start_council tool with correct parameters', async () => {
    const { getAgtermTools } = await import('../src/agterm/tools.js');
    const tools = getAgtermTools();
    const startTool = tools.find(t => t.name === 'start_council');

    expect(startTool).toBeDefined();
    expect(startTool!.parameters.required).toContain('prompt');
    expect(startTool!.parameters.properties.prompt).toBeDefined();
    expect(startTool!.parameters.properties.template).toBeDefined();
    expect(startTool!.parameters.properties.mode).toBeDefined();
  });
});
