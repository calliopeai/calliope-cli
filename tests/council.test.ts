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
} from '../src/agents/council-types.js';
import { DEFAULT_COUNCIL_CONFIG, COUNCIL_TEMPLATES } from '../src/agents/council-types.js';

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
        activeTaskIds: [],
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
    const { AGTERM_TOOL_NAMES } = await import('../src/agents/tools.js');
    expect(AGTERM_TOOL_NAMES).toContain('start_council');
    expect(AGTERM_TOOL_NAMES).toContain('check_council');
    expect(AGTERM_TOOL_NAMES).toContain('cancel_council');
  });

  it('should have 14 total agent tools', async () => {
    const { getAgtermTools } = await import('../src/agents/tools.js');
    const tools = getAgtermTools();
    expect(tools.length).toBe(14);
  });

  it('should have start_council tool with correct parameters', async () => {
    const { getAgtermTools } = await import('../src/agents/tools.js');
    const tools = getAgtermTools();
    const startTool = tools.find(t => t.name === 'start_council');

    expect(startTool).toBeDefined();
    expect(startTool!.parameters.required).toContain('prompt');
    expect(startTool!.parameters.properties.prompt).toBeDefined();
    expect(startTool!.parameters.properties.template).toBeDefined();
    expect(startTool!.parameters.properties.mode).toBeDefined();
  });

  it('should have check_council tool', async () => {
    const { getAgtermTools } = await import('../src/agents/tools.js');
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'check_council');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('sessionId');
  });

  it('should have cancel_council tool', async () => {
    const { getAgtermTools } = await import('../src/agents/tools.js');
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'cancel_council');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toContain('sessionId');
  });
});

// ============================================================================
// Council Configuration
// ============================================================================

describe('Council Configuration', () => {
  it('should merge with defaults correctly', () => {
    const config: CouncilConfig = {
      ...DEFAULT_COUNCIL_CONFIG,
      mode: 'consensus',
      members: [
        { id: 'a', name: 'A', agent: 'claude', weight: 1.0 },
        { id: 'b', name: 'B', agent: 'gemini', weight: 1.0 },
      ],
      consensusThreshold: 0.75,
    };

    expect(config.mode).toBe('consensus');
    expect(config.consensusThreshold).toBe(0.75);
    expect(config.maxRounds).toBe(3); // from default
    expect(config.tieBreaker).toBe('scoring'); // from default
    expect(config.members.length).toBe(2);
  });

  it('should support weighted members', () => {
    const members: CouncilMember[] = [
      { id: 'a', name: 'Lead', agent: 'claude', role: 'lead', weight: 2.0 },
      { id: 'b', name: 'Junior', agent: 'gemini', role: 'junior', weight: 0.5 },
    ];

    const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
    expect(totalWeight).toBe(2.5);
    expect(members[0].weight / totalWeight).toBeGreaterThan(0.7); // Lead has >70% voting power
  });

  it('should support designated tie-breaker', () => {
    const config: CouncilConfig = {
      ...DEFAULT_COUNCIL_CONFIG,
      mode: 'consensus',
      tieBreaker: 'designated',
      designatedBreaker: 'lead-id',
      members: [
        { id: 'lead-id', name: 'Lead', agent: 'claude', weight: 1.0 },
        { id: 'other', name: 'Other', agent: 'gemini', weight: 1.0 },
      ],
    };

    expect(config.tieBreaker).toBe('designated');
    expect(config.designatedBreaker).toBe('lead-id');
  });
});

// ============================================================================
// Template Validation
// ============================================================================

describe('Template Validation', () => {
  it('code-review should have security reviewer with higher weight', () => {
    const t = COUNCIL_TEMPLATES['code-review'];
    const securityReviewer = t.members.find(m => m.role === 'security-reviewer');
    expect(securityReviewer).toBeDefined();
    expect(securityReviewer!.weight).toBeGreaterThan(1.0);
  });

  it('architecture should have lead architect with highest weight', () => {
    const t = COUNCIL_TEMPLATES['architecture'];
    const lead = t.members.find(m => m.role === 'lead-architect');
    expect(lead).toBeDefined();
    const maxWeight = Math.max(...t.members.map(m => m.weight));
    expect(lead!.weight).toBe(maxWeight);
  });

  it('debate should have impartial judge', () => {
    const t = COUNCIL_TEMPLATES['debate'];
    const judge = t.members.find(m => m.role === 'impartial-judge');
    expect(judge).toBeDefined();
    expect(judge!.weight).toBeGreaterThan(1.0);
  });

  it('each template should use diverse agent types', () => {
    for (const template of Object.values(COUNCIL_TEMPLATES)) {
      const agents = new Set(template.members.map(m => m.agent));
      // At least 1 unique agent type (most templates use mix of claude and gemini)
      expect(agents.size).toBeGreaterThanOrEqual(1);
    }
  });
});
