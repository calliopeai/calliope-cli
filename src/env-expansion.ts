/**
 * Environment template expansion helpers.
 *
 * Supports ${NAME} and ${NAME:-default} placeholders.
 */

export interface ExpandedEnvValue {
  expanded: string;
  missing: string[];
}

export function expandEnvTemplate(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): ExpandedEnvValue {
  const missing = new Set<string>();

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, raw) => {
    const [name, fallback] = raw.split(':-', 2);
    const envValue = env[name];

    if (envValue !== undefined) {
      return envValue;
    }
    if (fallback !== undefined) {
      return fallback;
    }

    missing.add(name);
    return match;
  });

  return {
    expanded,
    missing: [...missing],
  };
}

export function expandEnvMap(
  values: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): {
  expanded: Record<string, string>;
  missing: string[];
} {
  if (!values) {
    return { expanded: {}, missing: [] };
  }

  const expanded: Record<string, string> = {};
  const missing = new Set<string>();

  for (const [key, value] of Object.entries(values)) {
    const result = expandEnvTemplate(value, env);
    expanded[key] = result.expanded;
    for (const name of result.missing) {
      missing.add(name);
    }
  }

  return {
    expanded,
    missing: [...missing],
  };
}
