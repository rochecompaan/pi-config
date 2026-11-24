# Evidence template

Only the text from `<!-- pr-review-loop:start -->` to
`<!-- pr-review-loop:end -->` goes into the PR body. Full reviewer reports
never go in the body: each one is a PR comment, linked from the rounds
table. Fill in every
`{{...}}` placeholder. Repeat a line or table row once for each item.

The part above the review log is what a human reviewer reads. Keep it
short: one plain sentence per item, no file paths, and no section that has
nothing in it. Everything else goes in the collapsed review log.

Values:

- `{{HEAD_NOTE}}`: `the PR head when this was written`, or
  `the PR head was <sha> when this was written` when they differ.
- `{{OUTCOME}}`: `Clean`, `Cap reached`, or `Incomplete: <reason>`.
- `{{ROUNDS_WORD}}`: `round` or `rounds`.
- `{{UNREVIEWED}}`: a check item for fixes made in the final round of the
  latest run, such as
  `3 Minor fixes made after the last review were not reviewed again (R4-1 to R4-3).`
  Leave it out when there are none.
- `{{IMPORTANT_HEADING}}`: `Important fixes`, or
  `Critical and Important fixes` when any fixed finding is Critical. Start a
  Critical row's finding with `**Critical:**`.
- `{{FIX_SHORT}}`: the fix commit. Add `not reviewed again`,
  `reverted by <sha> (<reason>)`, or `later replaced by <ID>` when they apply.
- `{{FIX}}`: the fix commit, then the test that failed before and passes
  after, or the direct check used instead. Mark fixes made in the final
  round of a run with `not reviewed by a fresh reviewer`.
- `{{SEVERITY}}`: `Critical`, `Important`, `Minor`, or `Not graded` for a
  "Declined to judge" item the author set aside.
- `{{FOLLOW_UP}}`: an issue reference such as `#831`, or `not filed`.
- `{{REPORT_LINK}}`: `[report](<comment URL>)` for the round's report
  comment, `-` when the round has no usable report, or `removed for size`
  for a report an earlier version of the skill removed.
- When only one model family was available, end the Result line with
  `Only one model family was available.`

Leave out these parts when they are empty: "For you to check", the
Critical and Important fixes table, the Minor fixes line, "Declined",
"Deferred", and the Fixed, Declined, and Deferred tables in the log. Leave
out the heading with the part. Never write a table row or line of `(none)`.

<!-- pr-review-loop:start -->
## Review evidence

**Result:** Run {{RUN}}: {{OUTCOME}} after {{RUN_ROUNDS}} {{ROUNDS_WORD}}. {{TOTAL}} findings across all runs: {{FIXED}} fixed, {{DECLINED}} declined, {{DEFERRED}} deferred.

**Reviewed at** `{{EVIDENCE_HEAD}}`, {{HEAD_NOTE}}. Later pushes are not reviewed.

**For you to check**
- {{CALLOUT}}
- {{UNREVIEWED}}

**{{IMPORTANT_HEADING}}**
| ID | Finding | Fix |
|---|---|---|
| {{ID}} | {{FINDING}} | {{FIX_SHORT}} |

{{MINOR_FIXED}} Minor fixes are in the review log.

**Declined**
- {{ID}}: {{FINDING}}. {{REASON}}

**Deferred**
- {{ID}}: {{FINDING}}. {{FOLLOW_UP}}

<details><summary>Review log: rounds, all findings, validation</summary>

### Rounds
| Run | Round | Trigger | Model | Commit reviewed | Findings | Verdict | Report |
|---|---|---|---|---|---|---|---|
| {{RUN}} | {{ROUND}} | {{TRIGGER}} | {{MODEL}} | `{{REVIEWED_SHA}}` | {{FINDING_COUNT}} | {{VERDICT}} | {{REPORT_LINK}} |

### Fixed
| ID | Severity | Finding | Fix |
|---|---|---|---|
| {{ID}} | {{SEVERITY}} | {{FINDING}} (`{{FILE_LINE}}`) | {{FIX}} |

### Declined
| ID | Severity | Finding | Reason |
|---|---|---|---|
| {{ID}} | {{SEVERITY}} | {{FINDING}} | {{REASON}} |

### Deferred
| ID | Severity | Finding | Follow-up |
|---|---|---|---|
| {{ID}} | {{SEVERITY}} | {{FINDING}} | {{FOLLOW_UP}} |

### Validation on `{{EVIDENCE_HEAD}}`
- `{{COMMAND}}`: {{COMMAND_RESULT}}

</details>
<!-- pr-review-loop:end -->
