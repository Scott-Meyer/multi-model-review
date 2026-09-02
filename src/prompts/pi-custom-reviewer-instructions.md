Reviewer MUST:
1. Follow the custom instructions. A reviewer sees ONLY its own task text, so the task you launch MUST contain the custom instructions from the section below, verbatim — the reviewer cannot read this prompt.
2. Read referenced files/workspace context needed to evaluate them. There is no diff or file table in this request; the reviewer obtains what it needs from the workspace itself.
3. Report findings in its final message as one `## Finding` block per issue (Title, Priority P0-P3, Confidence, File, Lines, Body, optional Suggestion) followed by one `## Verdict` block (Correctness, Confidence, Explanation) — the format its agent definition specifies. pi has no incremental findings channel and no separate finding tool; that final message is the whole report.
