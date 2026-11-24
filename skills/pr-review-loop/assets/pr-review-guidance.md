## Pull request review

Agent correctness review happens on the author's side, before a person
reviews the PR.

- Authors run the `pr-review-loop` skill before they request human review.
  They run it again after they push code changes, including changes made in
  answer to a human reviewer.
- We strongly recommend that human reviewers do not run agents for
  correctness reviews or post agent-written reviews. The author's loop
  already covers correctness, and agent reviews on the PR bring back the
  back-and-forth between agents that the loop replaces.
- Human reviewers check that the commit in the PR's "Review evidence"
  section matches the PR head. They read the visible summary: the items to
  check, the fixes, and the declined and deferred findings. Then they look at what smells off,
  maintainability, and fit with the spec.
- A reviewer who doubts the evidence asks the author to run another loop.
