---
name: fix-bug
description: "Fix a bug with minimal-risk workflow (diagnose -> plan -> implement -> verify -> review)."
agent: Implementer
tools: ['vscode', 'execute', 'read', 'tavily/search', 'structured-thinking/*', 'edit', 'search','todo']
argument-hint: "bug description + reproduction steps"
---

# Bug Fix Workflow
1. Diagnose: Use read / search / grep to locate the root cause.
2. Plan:
  - If DB schema change is needed: Plan to create a Migration SQL file. DO NOT execute DDL directly.
  - If Code change: Identify exact files.
3. Implement:
  - Apply minimal edits.
  - Create migration files if needed.
4. Verify: Run tests or lint locally.
5. Review: MUST hand off to Reviewer for final safety check.