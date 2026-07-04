/**
 * Tests for src/project-config.ts
 *
 * Covers: findProjectConfig, parseConfigFile, loadProjectConfig,
 * getProjectConfig, generateDefaultConfig, createProjectConfig,
 * buildProjectContext
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  findProjectConfig,
  parseConfigFile,
  loadProjectConfig,
  getProjectConfig,
  generateDefaultConfig,
  createProjectConfig,
  buildProjectContext,
} from '../src/project-config.js';

// ---------------------------------------------------------------------------
// Test fixture directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-projcfg-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findProjectConfig
// ---------------------------------------------------------------------------

describe('findProjectConfig', () => {
  it('should return null when no config file exists', () => {
    const result = findProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('should find .calliope in the same directory', () => {
    const configPath = path.join(tmpDir, '.calliope');
    fs.writeFileSync(configPath, 'project: TestProject\n');
    const result = findProjectConfig(tmpDir);
    expect(result).toBe(configPath);
  });

  it('should find .calliope.conf in the same directory', () => {
    const configPath = path.join(tmpDir, '.calliope.conf');
    fs.writeFileSync(configPath, 'project: TestProject\n');
    const result = findProjectConfig(tmpDir);
    expect(result).toBe(configPath);
  });

  it('should find calliope.conf in the same directory', () => {
    const configPath = path.join(tmpDir, 'calliope.conf');
    fs.writeFileSync(configPath, 'project: TestProject\n');
    const result = findProjectConfig(tmpDir);
    expect(result).toBe(configPath);
  });

  it('should find .calliope in parent directory', () => {
    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir);
    const configPath = path.join(tmpDir, '.calliope');
    fs.writeFileSync(configPath, 'project: ParentProject\n');
    const result = findProjectConfig(subDir);
    expect(result).toBe(configPath);
  });

  it('should prefer .calliope over .calliope.conf', () => {
    const configPath1 = path.join(tmpDir, '.calliope');
    const configPath2 = path.join(tmpDir, '.calliope.conf');
    fs.writeFileSync(configPath1, 'project: First\n');
    fs.writeFileSync(configPath2, 'project: Second\n');
    const result = findProjectConfig(tmpDir);
    expect(result).toBe(configPath1);
  });
});

// ---------------------------------------------------------------------------
// parseConfigFile
// ---------------------------------------------------------------------------

describe('parseConfigFile', () => {
  it('should parse empty content', () => {
    expect(parseConfigFile('')).toEqual({});
  });

  it('should skip comment lines', () => {
    const result = parseConfigFile('# This is a comment\n');
    expect(result).toEqual({});
  });

  it('should parse project key-value', () => {
    const result = parseConfigFile('project: My Project\n');
    expect(result.project).toBe('My Project');
  });

  it('should parse description key-value', () => {
    const result = parseConfigFile('description: A cool project\n');
    expect(result.description).toBe('A cool project');
  });

  it('should parse provider key-value', () => {
    const result = parseConfigFile('provider: anthropic\n');
    expect(result.provider).toBe('anthropic');
  });

  it('should parse model key-value', () => {
    const result = parseConfigFile('model: claude-sonnet-4\n');
    expect(result.model).toBe('claude-sonnet-4');
  });

  it('should parse maxiterations', () => {
    const result = parseConfigFile('maxiterations: 100\n');
    expect(result.maxIterations).toBe(100);
  });

  it('should parse max-iterations', () => {
    const result = parseConfigFile('max-iterations: 50\n');
    expect(result.maxIterations).toBe(50);
  });

  it('should parse max_iterations', () => {
    const result = parseConfigFile('max_iterations: 25\n');
    expect(result.maxIterations).toBe(25);
  });

  it('should parse prefix as systemPromptPrefix', () => {
    const result = parseConfigFile('prefix: You are a helpful assistant\n');
    expect(result.systemPromptPrefix).toBe('You are a helpful assistant');
  });

  it('should parse systempromptprefix', () => {
    const result = parseConfigFile('systempromptprefix: Custom prefix\n');
    expect(result.systemPromptPrefix).toBe('Custom prefix');
  });

  it('should parse suffix as systemPromptSuffix', () => {
    const result = parseConfigFile('suffix: Always respond in JSON\n');
    expect(result.systemPromptSuffix).toBe('Always respond in JSON');
  });

  it('should parse systempromptsuffix', () => {
    const result = parseConfigFile('systempromptsuffix: Custom suffix\n');
    expect(result.systemPromptSuffix).toBe('Custom suffix');
  });

  it('should parse [tech] section into list', () => {
    const content = '[tech]\ntypescript\nreact\nnode\n';
    const result = parseConfigFile(content);
    expect(result.tech).toEqual(['typescript', 'react', 'node']);
  });

  it('should parse [conventions] section into list', () => {
    const content = '[conventions]\nUse functional components\nPrefer async/await\n';
    const result = parseConfigFile(content);
    expect(result.conventions).toEqual(['Use functional components', 'Prefer async/await']);
  });

  it('should parse [ignore] section into list', () => {
    const content = '[ignore]\nnode_modules/\ndist/\n';
    const result = parseConfigFile(content);
    expect(result.ignore).toEqual(['node_modules/', 'dist/']);
  });

  it('should parse [commands] section into key:value map', () => {
    const content = '[commands]\nbuild: npm run build\ntest: npm test\n';
    const result = parseConfigFile(content);
    expect(result.commands).toEqual({ build: 'npm run build', test: 'npm test' });
  });

  it('should handle [commands] with colon in script', () => {
    const content = '[commands]\nstart: node server.js --port:3000\n';
    const result = parseConfigFile(content);
    expect(result.commands?.start).toBe('node server.js --port:3000');
  });

  it('should parse multiple sections', () => {
    const content = `project: Full Project
provider: openai
model: gpt-4

[tech]
python
fastapi

[ignore]
venv/
__pycache__/
`;
    const result = parseConfigFile(content);
    expect(result.project).toBe('Full Project');
    expect(result.provider).toBe('openai');
    expect(result.tech).toEqual(['python', 'fastapi']);
    expect(result.ignore).toEqual(['venv/', '__pycache__/']);
  });

  it('should flush section when another section starts', () => {
    const content = '[tech]\ntypescript\n[conventions]\nUse async/await\n';
    const result = parseConfigFile(content);
    expect(result.tech).toEqual(['typescript']);
    expect(result.conventions).toEqual(['Use async/await']);
  });

  it('should ignore unknown key-value pairs without crashing', () => {
    const result = parseConfigFile('unknownkey: some value\n');
    expect(result).toEqual({});
  });

  it('should handle empty section', () => {
    const content = '[tech]\n[conventions]\nuse patterns\n';
    const result = parseConfigFile(content);
    expect(result.tech).toBeUndefined();
    expect(result.conventions).toEqual(['use patterns']);
  });
});

// ---------------------------------------------------------------------------
// loadProjectConfig
// ---------------------------------------------------------------------------

describe('loadProjectConfig', () => {
  it('should load and parse a valid config file', () => {
    const configPath = path.join(tmpDir, '.calliope');
    fs.writeFileSync(configPath, 'project: TestProject\nmodel: claude-3\n');
    const result = loadProjectConfig(configPath);
    expect(result).not.toBeNull();
    expect(result?.project).toBe('TestProject');
    expect(result?.model).toBe('claude-3');
  });

  it('should return null for non-existent file', () => {
    const result = loadProjectConfig(path.join(tmpDir, 'nonexistent.conf'));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getProjectConfig
// ---------------------------------------------------------------------------

describe('getProjectConfig', () => {
  it('should return null when no config file found', () => {
    const result = getProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('should return parsed config when file exists', () => {
    const configPath = path.join(tmpDir, '.calliope');
    fs.writeFileSync(configPath, 'project: Found Project\n');
    const result = getProjectConfig(tmpDir);
    expect(result?.project).toBe('Found Project');
  });
});

// ---------------------------------------------------------------------------
// generateDefaultConfig
// ---------------------------------------------------------------------------

describe('generateDefaultConfig', () => {
  it('should generate a config string with default project name', () => {
    const result = generateDefaultConfig();
    expect(result).toContain('project: My Project');
    expect(result).toContain('[tech]');
    expect(result).toContain('[conventions]');
    expect(result).toContain('[ignore]');
    expect(result).toContain('[commands]');
  });

  it('should use provided project name', () => {
    const result = generateDefaultConfig('Calliope CLI');
    expect(result).toContain('project: Calliope CLI');
  });

  it('should include node_modules in ignore section', () => {
    const result = generateDefaultConfig();
    expect(result).toContain('node_modules/');
  });
});

// ---------------------------------------------------------------------------
// createProjectConfig
// ---------------------------------------------------------------------------

describe('createProjectConfig', () => {
  it('should create .calliope file in the given directory', () => {
    const createdPath = createProjectConfig(tmpDir);
    expect(createdPath).toBe(path.join(tmpDir, '.calliope'));
    expect(fs.existsSync(createdPath)).toBe(true);
  });

  it('should create file with given project name', () => {
    createProjectConfig(tmpDir, 'My CLI App');
    const content = fs.readFileSync(path.join(tmpDir, '.calliope'), 'utf-8');
    expect(content).toContain('project: My CLI App');
  });

  it('should use directory basename when no project name given', () => {
    createProjectConfig(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.calliope'), 'utf-8');
    expect(content).toContain(`project: ${path.basename(tmpDir)}`);
  });
});

// ---------------------------------------------------------------------------
// buildProjectContext
// ---------------------------------------------------------------------------

describe('buildProjectContext', () => {
  it('should return empty string for empty config', () => {
    expect(buildProjectContext({})).toBe('');
  });

  it('should include project name', () => {
    const result = buildProjectContext({ project: 'Test App' });
    expect(result).toContain('Project: Test App');
  });

  it('should include description', () => {
    const result = buildProjectContext({ description: 'A test description' });
    expect(result).toContain('Description: A test description');
  });

  it('should include tech stack', () => {
    const result = buildProjectContext({ tech: ['typescript', 'react'] });
    expect(result).toContain('Tech stack: typescript, react');
  });

  it('should include conventions', () => {
    const result = buildProjectContext({ conventions: ['Use functional components', 'Prefer async'] });
    expect(result).toContain('Project conventions:');
    expect(result).toContain('- Use functional components');
    expect(result).toContain('- Prefer async');
  });

  it('should prepend systemPromptPrefix', () => {
    const result = buildProjectContext({
      project: 'MyApp',
      systemPromptPrefix: 'You are an expert',
    });
    expect(result.startsWith('You are an expert')).toBe(true);
  });

  it('should append systemPromptSuffix', () => {
    const result = buildProjectContext({
      project: 'MyApp',
      systemPromptSuffix: 'Always be concise',
    });
    expect(result.endsWith('Always be concise')).toBe(true);
  });

  it('should not include tech when empty array', () => {
    const result = buildProjectContext({ tech: [] });
    expect(result).not.toContain('Tech stack');
  });

  it('should not include conventions when empty array', () => {
    const result = buildProjectContext({ conventions: [] });
    expect(result).not.toContain('Project conventions');
  });

  it('should build comprehensive context', () => {
    const result = buildProjectContext({
      project: 'Calliope',
      description: 'AI CLI',
      tech: ['typescript', 'node'],
      conventions: ['ESM only'],
      systemPromptPrefix: 'PREFIX',
      systemPromptSuffix: 'SUFFIX',
    });
    expect(result).toContain('PREFIX');
    expect(result).toContain('Project: Calliope');
    expect(result).toContain('Description: AI CLI');
    expect(result).toContain('Tech stack: typescript, node');
    expect(result).toContain('Project conventions:');
    expect(result).toContain('- ESM only');
    expect(result).toContain('SUFFIX');
  });
});
