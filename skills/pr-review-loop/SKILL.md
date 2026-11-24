---
name: pr-review-loop
description: Run up to three fresh-reviewer review and fix rounds on an open pull request, then record every finding and how it was handled in the PR description. Use before requesting human review, and again after pushing code changes to a reviewed PR.
---

# PR Review Loop

Run a bounded loop of fresh agent reviews and fixes on an open pull request,
then write the evidence into the PR description. A human reviewer can then
trust that the PR had full reviews with fixes, and spend their time on what
smells off, maintainability, and fit with the spec.

Files that come with this skill:

- `references/reviewer-prompt.md`: the prompt each reviewer gets.
- `references/review-criteria.md`: the criteria each reviewer gets.
- `references/agent-notes.md`: how to start a fresh reviewer and pick its
  model in specific coding agents.
- `assets/evidence-template.md`: the "Review evidence" section.
- `assets/pr-review-guidance.md`: text a project copies to adopt the process.

## Terms

- **Run:** one use of this skill on a PR. Runs are numbered from 1.
- **Round:** one fresh review of the whole branch, followed by fixes. A run
  has at most three rounds. Round numbers keep counting across runs.
- **Reviewed commit:** the head commit when a round starts.
- **Finding ID:** `R<round>-<number>`, such as `R2-3`. The number is the
  reviewer's issue number. IDs never change.
- **Evidence head:** the last commit the run produced or reviewed that is on
  the remote branch. See section 9.

## Rules that always apply

- Never decline or defer a finding without the author's approval.
- Never review your own fixes in place of a fresh reviewer.
- Never squash, rebase, amend, or force-push during the loop. Every fix
  commit stays on the branch so every commit link in the evidence works.
- Never create an issue the author did not pick.
- Only one writer works in the checkout at a time.
- Write one evidence section in the PR body. The only PR comments the loop
  posts are the full reviewer reports, one per round, each collapsed. Never
  reply to them or discuss findings in comments.
- Every finding appears in the evidence once, including declined and
  deferred ones.

## 1. Check that the loop can start

1. Run `git fetch origin`.
2. Read the PR for the current branch:

   ```bash
   gh pr view --json number,url,state,body,baseRefName,headRefName,headRefOid,isDraft,closingIssuesReferences
   ```

3. Stop and tell the author if any of these is true:
   - there is no PR, or its state is not `OPEN` (a draft is fine);
   - the checked-out branch is not the PR's `headRefName`;
   - `git status --porcelain` prints anything;
   - `git rev-parse HEAD` does not equal `headRefOid`. Ask the author to push
     or pull first.

## 2. Find the project's rules

Do not bring your own rules. Take them from the project:

- coding, testing, and GitHub rules from `AGENTS.md` and the files it links;
- the commit message style from those rules and `git log -n 30 --format=%s`;
- validation commands from `AGENTS.md`, other project docs, and the CI
  workflows that run on pull requests.

Pick the validation commands that apply to the changed files. Leave out
commands the project marks as needing a person, such as tasks that touch a
live cluster. If you cannot tell which commands apply, ask the author once,
and suggest that they record the answer in `AGENTS.md`.

Find the requirements for the reviewer:

- each issue in `closingIssuesReferences`, and issues the PR body links,
  read with `gh issue view <number> --json title,body`;
- any spec or plan file that the PR body or a linked issue names.

If you find none, use `none found`.

## 3. Read the existing evidence

Count the lines of the PR body that consist of exactly
`<!-- pr-review-loop:start -->` or exactly `<!-- pr-review-loop:end -->`.
A marker inside other text on a line does not count.

- Neither marker: this is run 1 and round 1. There are no earlier findings.
- One of each, start before end: read the section. Its tables are in the
  collapsed review log. The new run number is one
  more than the highest Run in the rounds table. The next round number is one
  more than the highest Round. Earlier findings are the rounds table and the
  Fixed, Declined, and Deferred tables.
- Anything else: stop and ask the author to fix the PR body.

The trigger for this run is the author's words if they gave a reason when
they started the skill. Otherwise use `initial` for run 1 and `new commits`
for later runs.

## 4. Run each round

Repeat these steps until a stop condition in section 7 is met.

1. **Record the reviewed commit:** `git rev-parse HEAD`.
2. **Validate, round 1 only.** In round 1 of a run, run the validation
   commands on the reviewed commit, as section 8 describes. In later rounds,
   the previous round's step 7 already validated this commit. If a command
   fails on the branch but not on the merge base, the branch is not ready
   for review: stop early before starting a reviewer, and ask the author to
   fix the branch and run the skill again.
3. **Start a fresh reviewer.** See section 5. Fill in
   `references/reviewer-prompt.md`:
   - `{{PR_DESCRIPTION}}`: the PR body, without the evidence section;
   - `{{REQUIREMENTS}}`: the issues, spec, and plan from section 2;
   - `{{BASE_SHA}}`: `git merge-base origin/<baseRefName> <reviewed commit>`;
   - `{{REVIEWED_SHA}}`: the reviewed commit;
   - `{{EARLIER_FINDINGS}}`: the rounds and the Fixed, Declined, and Deferred
     tables from earlier rounds of this and earlier runs, or `none`;
   - `{{VALIDATION_COMMANDS}}`: each command and its result.

   Give the reviewer `references/review-criteria.md` with the prompt.
4. **Check the report.** It must have the sections the prompt asks for, with
   numbered issues and a final "Human Reviewer Callouts (Non-Blocking)"
   section. A severity heading or "Declined to judge" section with nothing
   in it is left out, so a missing one means none. If the reviewer fails or the report is unusable, start one more
   fresh reviewer. If that also fails, stop early (section 11).
   Keep the usable report as written; section 9 posts it as a PR comment.
5. **Propose a ruling** on every finding: fix, decline with a reason, or
   defer. A decline reason cites a specific line, fact, or requirement. Also
   propose a ruling on every "Declined to judge" item: set it aside, or treat
   it as a finding. Either way, give it the next finding ID in this round. An
   item set aside goes in the Declined table with severity `Not graded` and
   the author's reason, so later reviewers and the human reviewer see it.
   - A finding or "Declined to judge" item that repeats an earlier declined
     or `Not graded` item, and names no code change or new evidence, gets no
     new ID, no table row, and no question to the author. Drop it and tell
     the author in the round message which earlier IDs came back, in one
     line.
   - When it names a code change or new evidence, treat it as new: give it
     an ID, propose a ruling, and name the earlier ID in the finding.
6. **Fix and ask.**
   - Fix the Critical and Important findings you propose to fix, without
     waiting: correctness findings first, then structural findings. See
     section 6.
   - Then send the author one message for the round. It lists every proposed
     decline and deferral, every Minor finding you propose to fix, and every
     "Declined to judge" ruling. The author approves each one or changes it
     to a fix.
   - Fix what the author changed to a fix, then the Minor findings the author
     approved.
7. **Validate** on the new head (section 8). Skip this when the round made
   no commits.
8. **Push.** Check that `git ls-remote origin refs/heads/<headRefName>` still
   prints the reviewed commit. If it does not, someone else pushed: stop
   early without pushing. Otherwise run `git push origin HEAD:<headRefName>`.
   Skip the push when the round made no commits.

## 5. Choose the reviewer

- Each round uses a fresh reviewer that has not seen the fixes being made.
  `references/agent-notes.md` says how to start one in specific agents.
- If no fresh reviewer is available, stop and say so. Do not review the
  branch yourself instead.
- Use the most capable model available.
- When more than one model family is available, change family each round,
  continuing from the family of the last round in the evidence. Different
  families find different problems.
- When only one family is available, keep going with it and say so in the
  Result line.

## 6. Make fixes and commits

- Give each accepted finding its own commit. When one change fixes several
  findings, one commit may name all of them.
- Follow the project's commit style and name the finding IDs, for example
  `fix(tasks): quote stage input before the guard (R1-1)`.
- A correctness fix comes with a test that fails before the fix and passes
  after, unless the project's testing rules rule out a new test. Run the test
  before the fix and see it fail.
- A structural fix is proven by a green suite.
- When no new test is written, record the direct check you used instead.
- You may hand a fix to one worker agent. It commits its own fix. Do not let
  two writers work in the checkout at the same time.
- If a fix or commit fails and you cannot resolve it, stop early.

## 7. Stop

Stop the run when either is true:

- **Clean round:** the round has no Critical or Important findings that were
  accepted for fixing. A round with no findings at all is clean, so a clean
  first round ends the run after one review. If a clean round fixes Minor
  findings, do not review again. Mark those fixes
  `not reviewed by a fresh reviewer`.
- **Cap reached:** this run has had three rounds. If the third round has
  accepted Critical or Important findings, fix them, validate, and push, but
  do not review again. Mark those fixes `not reviewed by a fresh reviewer`.

Then write the evidence (section 9) and ask about follow-up issues
(section 10).

## 8. Validate

- Run each validation command from section 2 and record the command and its
  result.
- Record a command you cannot run as `not run` with the reason.
- When a command fails, run it on the merge base in a separate worktree
  (`git worktree add <temp dir> <merge base>`). If it also fails there,
  record it as `baseline failure`, not as a pass. Remove the worktree after.
- When a command fails on the branch but not on the merge base before round
  1's review, stop early as step 2 of section 4 says. When it fails after a
  round's fixes, fix the failure before you push. If you cannot, stop early.

## 9. Write the evidence

1. Post the full reports (see "Post the full reports" below), so each
   round of this run has a report link for the rounds table.
2. Fill in `assets/evidence-template.md` from all runs. A human reviewer
   reads only the part above the review log, so keep it short: one plain
   sentence per item, and leave out empty parts.
   - **Evidence head:** the last commit the run reviewed or produced that is
     on the remote branch. This is the last pushed fix commit when the final
     round made fixes, and otherwise the commit the final round reviewed.
     Never name a commit that was not pushed.
   - Compare it with `headRefOid` from a fresh `gh pr view` and name the PR
     head in the note when it differs.
   - **Result:** this run's outcome and number of rounds, and the counts of
     fixed, declined, and deferred findings across all runs.
   - **For you to check:** the last round's callouts, merged with earlier
     callouts that still apply, then one line for the fixes made in the
     final round of this run, which no fresh reviewer has seen.
   - **Visible findings:** a short table of the fixed Critical and Important
     findings from all runs, a count of the fixed Minor findings, and one
     line for each declined or deferred finding.
   - **Review log:** add this run's rows to the rounds table and its findings
     to the Fixed, Declined, and Deferred tables, after the earlier rows. The
     Report cell links the round's report comment, or says `-` when the
     round has no usable report.
   - When a later commit reverts or replaces an earlier fix, keep that row
     and its ID, and add `Reverted by <sha> (<reason>)` or
     `Later replaced by <ID>` to its Fix cell.
   - **Validation:** the results on the evidence head.
   - Never put full reports in the PR body. They live in the report
     comments.
3. Read the PR body again right before writing, with
   `gh pr view <number> --json body`. Check the markers again as section 3
   does.
4. Replace only the text from the start marker to the end marker. If there
   are no markers, add the section to the end of the body after a blank line.
   Leave the rest of the body as written.
5. If the new body is longer than 65,536 characters, do not edit the PR.
   Tell the author that the evidence could not be written, give them the
   evidence section, and ask them to make room in the PR body. Then try this
   step again.
6. Write the body to a temporary file and run
   `gh pr edit <number> --body-file <file>`.

### Post the full reports

Each round with a usable report gets one PR comment that holds its full
report. A human reviewer opens it from the rounds table when they want the
detail.

1. Look for report comments that already exist, so a second write of the
   evidence does not post them twice:
   `gh api repos/{owner}/{repo}/issues/<number>/comments --paginate --jq '.[] | select(.body | startswith("<!-- pr-review-loop:report ")) | [.html_url, (.body | split("\n")[0])] | @tsv'`.
2. For each round of this run that has a usable report and no comment yet:
   - In the report, replace every `<!--` with `&lt;!--` and every
     `</details>` with `&lt;/details>`, so a report that quotes the markers
     cannot break the comment.
   - Write the comment to a temporary file in this form, then run
     `gh pr comment <number> --body-file <file>`. It prints the comment URL.

     ```markdown
     <!-- pr-review-loop:report run=<run> round=<round> -->
     <details><summary>pr-review-loop: run <run> round <round> full report (<model>, <short reviewed sha>)</summary>

     <report>

     </details>
     ```

   - If the comment would pass 65,536 characters, split the report at a
     `###` heading into numbered parts. Post each part with the first line
     `<!-- pr-review-loop:report run=<run> round=<round> part=<n> -->`, and
     link part 1 from the rounds table.
3. Earlier versions of this skill kept full reports in the PR body, in
   `<details><summary>Run <run> round <round> full report</summary>` blocks
   in the review log. If the section you read in section 3 has such blocks,
   post each one as a report comment the same way, link it from its rounds
   table row, and leave the block out of the new section. A block that says
   `Full report removed for size.` has no report to post: its Report cell
   says `removed for size`.

## 10. Ask about follow-up issues

After a clean or capped run, list the deferred findings that say
`not filed` and ask the author which should become issues. Create only the
issues the author picks, following the project's GitHub rules, with
`gh issue create`. Put the issue numbers in the Deferred table and write the
evidence again as section 9 describes. The others stay `not filed`.

## 11. Stop early

Stop early when:

- round 1 validation fails because of the branch;
- a reviewer fails twice in a row;
- someone else pushed to the branch during a round;
- a fix, commit, validation, or push fails and you cannot resolve it;
- the PR body markers are broken.

When you stop early, do not push work that failed validation. Write the
evidence you have, with outcome `Incomplete: <reason>`, unless the markers
are broken. If the run stops before the current round has a usable report,
add a rounds table row for that round with findings `-` and verdict
`Reviewer failed` or `Not reviewed: <reason>`. That keeps the run and round
numbers in the evidence, so the next run does not reuse them. List a fix
that was committed but not pushed in the Fixed table
with `not pushed: <reason>` in place of a commit link, so the evidence
never links to a commit the PR does not have. Do not ask about follow-up issues. Tell the author what
happened and what to do next.
