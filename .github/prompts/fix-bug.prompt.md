---
name: fix-bug
description: "Fix a bug with minimal-risk workflow (diagnose -> plan -> implement -> verify)."
agent: Implementer
tools: ['vscode', 'execute', 'read', 'tavily/search', 'filesystem/*', 'structured-thinking/*', 'edit', 'search']
argument-hint: "bug description + reproduction steps"
---

Workflow:
1) Diagnose using read/search only.
2) Propose a plan.
3) Implement small diff.
4) Verify via tests/lint.
5) Summarize changes + files touched + follow-ups.
