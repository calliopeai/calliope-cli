/**
 * Calliope CLI - Markdown Rendering
 *
 * Simple markdown to ANSI terminal rendering with syntax highlighting.
 */

import { colors as COLORS } from './styles.js';

// Language-specific syntax patterns
const SYNTAX_PATTERNS: Record<string, Array<{ pattern: RegExp; color: string }>> = {
  javascript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof)\b/g, color: 'magenta' },
    { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, color: 'yellow' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /\/\/.*$/gm, color: 'gray' },
    { pattern: /\/\*[\s\S]*?\*\//g, color: 'gray' },
    { pattern: /\b\d+\.?\d*\b/g, color: 'cyan' },
    { pattern: /[{}[\]();,]/g, color: 'white' },
  ],
  typescript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof|interface|type|enum|implements|extends|public|private|protected|readonly|as|is)\b/g, color: 'magenta' },
    { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, color: 'yellow' },
    { pattern: /:\s*(string|number|boolean|void|any|never|unknown|object)\b/g, color: 'cyan' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /\/\/.*$/gm, color: 'gray' },
    { pattern: /\/\*[\s\S]*?\*\//g, color: 'gray' },
    { pattern: /\b\d+\.?\d*\b/g, color: 'cyan' },
  ],
  python: [
    { pattern: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|and|or|not|in|is|None|True|False|self)\b/g, color: 'magenta' },
    { pattern: /(["'])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/g, color: 'green' },
    { pattern: /#.*$/gm, color: 'gray' },
    { pattern: /\b\d+\.?\d*\b/g, color: 'cyan' },
    { pattern: /@\w+/g, color: 'yellow' },
  ],
  bash: [
    { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|read|local|export|source)\b/g, color: 'magenta' },
    { pattern: /(["'])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /#.*$/gm, color: 'gray' },
    { pattern: /\$\w+|\$\{[^}]+\}/g, color: 'cyan' },
    { pattern: /\b\d+\b/g, color: 'cyan' },
  ],
  json: [
    { pattern: /"[^"]*"\s*:/g, color: 'cyan' },
    { pattern: /:\s*"[^"]*"/g, color: 'green' },
    { pattern: /\b(true|false|null)\b/g, color: 'yellow' },
    { pattern: /\b-?\d+\.?\d*\b/g, color: 'magenta' },
  ],
  rust: [
    { pattern: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|break|continue|self|Self|where|async|await|move|ref|static|unsafe|extern)\b/g, color: 'magenta' },
    { pattern: /\b(true|false|None|Some|Ok|Err)\b/g, color: 'yellow' },
    { pattern: /(["'])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /\/\/.*$/gm, color: 'gray' },
    { pattern: /\b\d+\.?\d*\b/g, color: 'cyan' },
  ],
  go: [
    { pattern: /\b(func|return|if|else|for|range|switch|case|default|var|const|type|struct|interface|package|import|go|defer|chan|select|make|new|nil|true|false)\b/g, color: 'magenta' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: 'green' },
    { pattern: /\/\/.*$/gm, color: 'gray' },
    { pattern: /\b\d+\.?\d*\b/g, color: 'cyan' },
  ],
};

// Map common language aliases
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  rs: 'rust',
  golang: 'go',
};

/**
 * Apply syntax highlighting to code
 */
function highlightCode(code: string, language: string): string {
  const lang = LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase();
  const patterns = SYNTAX_PATTERNS[lang];

  if (!patterns) {
    // No highlighting for unknown languages - just dim it slightly
    return `${COLORS.white}${code}${COLORS.reset}`;
  }

  // Apply patterns in order (later patterns can override)
  let result = code;
  const colorMap: Map<number, { end: number; color: string }> = new Map();

  for (const { pattern, color } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      colorMap.set(start, { end, color });
    }
  }

  // Build result string with colors
  const positions = Array.from(colorMap.keys()).sort((a, b) => b - a);
  for (const start of positions) {
    const { end, color } = colorMap.get(start)!;
    const colorCode = COLORS[color as keyof typeof COLORS] || COLORS.white;
    result = result.slice(0, start) + colorCode + result.slice(start, end) + COLORS.reset + result.slice(end);
  }

  return result;
}

/**
 * Render markdown to ANSI terminal output
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  for (const line of lines) {
    // Code block handling
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End of code block - render it
        const code = codeBlockContent.join('\n');
        const highlighted = highlightCode(code, codeBlockLang);
        result.push(`${COLORS.bgGray}${COLORS.white}  ${codeBlockLang || 'code'}  ${COLORS.reset}`);
        for (const codeLine of highlighted.split('\n')) {
          result.push(`${COLORS.dim}│${COLORS.reset} ${codeLine}`);
        }
        result.push(`${COLORS.dim}╰${'─'.repeat(40)}${COLORS.reset}`);
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = '';
      } else {
        // Start of code block
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      result.push(`${COLORS.bold}${COLORS.cyan}${line.slice(4)}${COLORS.reset}`);
      continue;
    }
    if (line.startsWith('## ')) {
      result.push(`${COLORS.bold}${COLORS.brightCyan}${line.slice(3)}${COLORS.reset}`);
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(`${COLORS.bold}${COLORS.brightCyan}${COLORS.underline}${line.slice(2)}${COLORS.reset}`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      result.push(`${COLORS.dim}${'─'.repeat(40)}${COLORS.reset}`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      result.push(`${COLORS.dim}│${COLORS.reset} ${COLORS.italic}${line.slice(2)}${COLORS.reset}`);
      continue;
    }

    // Lists
    if (/^[\s]*[-*+]\s/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] || '';
      const content = line.replace(/^[\s]*[-*+]\s/, '');
      result.push(`${indent}${COLORS.cyan}•${COLORS.reset} ${content}`);
      continue;
    }
    if (/^[\s]*\d+\.\s/.test(line)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)$/);
      if (match) {
        result.push(`${match[1]}${COLORS.cyan}${match[2]}.${COLORS.reset} ${match[3]}`);
        continue;
      }
    }

    // Inline formatting
    let formattedLine = line;

    // Inline code
    formattedLine = formattedLine.replace(/`([^`]+)`/g, `${COLORS.bgGray}${COLORS.white} $1 ${COLORS.reset}`);

    // Bold
    formattedLine = formattedLine.replace(/\*\*([^*]+)\*\*/g, `${COLORS.bold}$1${COLORS.reset}`);
    formattedLine = formattedLine.replace(/__([^_]+)__/g, `${COLORS.bold}$1${COLORS.reset}`);

    // Italic
    formattedLine = formattedLine.replace(/\*([^*]+)\*/g, `${COLORS.italic}$1${COLORS.reset}`);
    formattedLine = formattedLine.replace(/_([^_]+)_/g, `${COLORS.italic}$1${COLORS.reset}`);

    // Links [text](url)
    formattedLine = formattedLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${COLORS.underline}${COLORS.blue}$1${COLORS.reset}${COLORS.dim} ($2)${COLORS.reset}`);

    result.push(formattedLine);
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    const code = codeBlockContent.join('\n');
    const highlighted = highlightCode(code, codeBlockLang);
    result.push(`${COLORS.bgGray}${COLORS.white}  ${codeBlockLang || 'code'}  ${COLORS.reset}`);
    for (const codeLine of highlighted.split('\n')) {
      result.push(`${COLORS.dim}│${COLORS.reset} ${codeLine}`);
    }
  }

  return result.join('\n');
}

/**
 * Strip markdown formatting (for plain text output)
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => {
      // Keep code content, remove backticks
      return match.replace(/```\w*\n?/g, '').trim();
    })
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, (match) => match);
}
