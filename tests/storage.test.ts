/**
 * Tests for storage module - templates and active todo
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initStorage,
  getTemplates,
  saveTemplate,
  deleteTemplate,
  setActiveTodo,
  getActiveTodo,
  addTodo,
  paths,
} from '../src/storage.js';

describe('Template Storage', () => {
  const templatesFile = path.join(paths.templates, 'prompts.json');

  beforeEach(() => {
    initStorage();
    // Clean up templates file
    if (fs.existsSync(templatesFile)) {
      fs.unlinkSync(templatesFile);
    }
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(templatesFile)) {
      fs.unlinkSync(templatesFile);
    }
  });

  it('should return empty array when no templates exist', () => {
    const templates = getTemplates();
    expect(templates).toEqual([]);
  });

  it('should save a template', () => {
    const template = saveTemplate('test-template', 'Test prompt content');

    expect(template.name).toBe('test-template');
    expect(template.prompt).toBe('Test prompt content');
    expect(template.createdAt).toBeDefined();
  });

  it('should retrieve saved templates', () => {
    saveTemplate('template1', 'Prompt 1');
    saveTemplate('template2', 'Prompt 2');

    const templates = getTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.map(t => t.name)).toContain('template1');
    expect(templates.map(t => t.name)).toContain('template2');
  });

  it('should overwrite template with same name', () => {
    saveTemplate('test', 'Original prompt');
    saveTemplate('test', 'Updated prompt');

    const templates = getTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].prompt).toBe('Updated prompt');
  });

  it('should delete a template', () => {
    saveTemplate('to-delete', 'Will be deleted');
    expect(getTemplates()).toHaveLength(1);

    const result = deleteTemplate('to-delete');
    expect(result).toBe(true);
    expect(getTemplates()).toHaveLength(0);
  });

  it('should return false when deleting non-existent template', () => {
    const result = deleteTemplate('non-existent');
    expect(result).toBe(false);
  });
});

describe('Active TODO', () => {
  beforeEach(() => {
    initStorage();
  });

  it('should return null when no active todo', () => {
    setActiveTodo(null);
    const active = getActiveTodo();
    expect(active).toBeNull();
  });

  it('should set and get active todo', () => {
    // Create a todo first
    const todo = addTodo('Test task for active', { priority: 'high' });

    setActiveTodo(todo.id);
    const active = getActiveTodo();

    expect(active).not.toBeNull();
    expect(active?.id).toBe(todo.id);
    expect(active?.content).toBe('Test task for active');
  });

  it('should clear active todo', () => {
    const todo = addTodo('Another test task');
    setActiveTodo(todo.id);
    expect(getActiveTodo()).not.toBeNull();

    setActiveTodo(null);
    expect(getActiveTodo()).toBeNull();
  });
});
