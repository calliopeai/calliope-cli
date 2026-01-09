# Contributing to Calliope CLI

Thank you for your interest in contributing to Calliope CLI! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/calliopeai/calliope-cli/issues)
2. If not, create a new issue using the Bug Report template
3. Include as much detail as possible: steps to reproduce, expected behavior, environment info

### Suggesting Features

1. Check existing issues and discussions for similar ideas
2. Create a new issue using the Feature Request template
3. Describe the problem you're solving and your proposed solution

### Submitting Code

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run tests and ensure the build passes
5. Commit your changes with clear commit messages
6. Push to your fork
7. Open a Pull Request

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/calliope-cli.git
cd calliope-cli

# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/bin.js
```

## Code Style

- Use TypeScript
- Follow existing code patterns
- Keep changes focused and minimal
- Add comments for complex logic

## Commit Messages

- Use clear, descriptive commit messages
- Start with a verb (Add, Fix, Update, Remove)
- Reference issues when applicable (`Fixes #123`)

## Pull Request Process

1. Update documentation if needed
2. Ensure all checks pass
3. Request review from maintainers
4. Address feedback promptly

## Questions?

- Join our [Discord](https://discord.gg/calliope)
- Check the [Documentation](https://docs.calliope.ai/cli/)

Thank you for contributing!
