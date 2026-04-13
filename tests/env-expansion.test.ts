import { describe, it, expect } from 'vitest';
import { expandEnvTemplate, expandEnvMap } from '../src/env-expansion.js';

describe('expandEnvTemplate', () => {
  it('should replace a variable from the environment', () => {
    const result = expandEnvTemplate('token=${API_TOKEN}', { API_TOKEN: 'secret' });
    expect(result).toEqual({
      expanded: 'token=secret',
      missing: [],
    });
  });

  it('should use a fallback when the variable is unset', () => {
    const result = expandEnvTemplate('mode=${MODE:-safe}', {});
    expect(result).toEqual({
      expanded: 'mode=safe',
      missing: [],
    });
  });

  it('should report missing variables without removing the placeholder', () => {
    const result = expandEnvTemplate('token=${API_TOKEN}', {});
    expect(result).toEqual({
      expanded: 'token=${API_TOKEN}',
      missing: ['API_TOKEN'],
    });
  });
});

describe('expandEnvMap', () => {
  it('should expand all values and aggregate missing variables once', () => {
    const result = expandEnvMap(
      {
        API_TOKEN: '${TOKEN}',
        ENDPOINT: '${HOST:-localhost}:${PORT:-3000}',
        COPY: '${TOKEN}',
      },
      { TOKEN: 'abc123' },
    );

    expect(result).toEqual({
      expanded: {
        API_TOKEN: 'abc123',
        ENDPOINT: 'localhost:3000',
        COPY: 'abc123',
      },
      missing: [],
    });
  });

  it('should return an empty map for undefined input', () => {
    expect(expandEnvMap(undefined, { TOKEN: 'abc123' })).toEqual({
      expanded: {},
      missing: [],
    });
  });
});
