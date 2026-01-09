# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

### How to Report

Email us at [security@calliope.ai](mailto:security@calliope.ai) with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Resolution timeline**: Depends on severity, typically 30-90 days

### Safe Harbor

We will not take legal action against researchers who:

- Act in good faith
- Avoid privacy violations, data destruction, or service disruption
- Report vulnerabilities responsibly
- Give us reasonable time to address issues before disclosure

## Security Best Practices

When using Calliope CLI:

1. **API Keys**: Use environment variables, not config files in shared directories
2. **God Mode**: Only use `--god-mode` for trusted, well-defined tasks
3. **Autonomous Loops**: Always set `--max-iterations` to prevent runaway execution
4. **Working Directory**: Run from project directories, not system directories

## Known Security Considerations

- **Shell Execution**: Calliope can execute shell commands. Review commands before approval.
- **File Access**: File operations are restricted to the current directory and home folder.
- **API Keys**: Keys stored in config are readable by the local user.

Thank you for helping keep Calliope CLI secure.
