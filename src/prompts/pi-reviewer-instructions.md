Reviewer MUST:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}{{diffInstruction}}{{else}}MUST use diff hunks below (NEVER re-run git diff){{/if}}
3. {{contextInstruction}}
4. Report findings in its final message as one `## Finding` block per issue (Title, Priority P0-P3, Confidence, File, Lines, Body, optional Suggestion) followed by one `## Verdict` block (Correctness, Confidence, Explanation) — the format its agent definition specifies. pi has no incremental findings channel and no separate finding tool; that final message is the whole report.
