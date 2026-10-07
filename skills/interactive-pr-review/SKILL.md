---
name: interactive-pr-review
description: Use when a completed /review has listed its findings and the user wants to discuss them or draft inline PR feedback.
---

# Interactive PR Review

Use the findings and PR context from the completed `/review`.
Turn those findings into informal comments with concrete fixes.
Handle one finding at a time. Post nothing until the user approves that comment and its exact location.

## Review loop

1. Show one finding with its file, exact line range, and diff side (old or new). Include the proposed comment separately, ready to post.
2. Write the comment in simple, informal English. Explain what goes wrong and when it happens. Suggest a specific change that fixes it. Include a short code suggestion or outline when it makes the feedback easier to understand. Prefer to include one for code-related findings. Use a snippet for a small change and an outline for a wider fix. Do not ask the user whether to include it. Vary requests to fit the finding instead of repeating "Can you..." or "Could you...". For example: "Please include...", "One option is...", or "How about...?". Omit priority labels, severity tags, and formal review headings.
3. Ask whether to post, revise, or skip. Stop and wait. Approval covers only the current wording and location. If the user asks for changes, show the revised draft and ask again. If they skip, move to the next finding without posting.
4. Before posting, fetch the current PR head and diff. If either changed since the draft, recheck the finding and location. Show the updated draft and request approval again.
5. Post the exact approved text as an inline review comment. Anchor it to the approved file, diff side, start and end lines, and current commit. Use the host API that supports line-range comments. If exact placement is unavailable, stop and ask the user. Do not substitute a nearby range or a general PR comment.
6. Confirm the posted comment with its link. Then show the next finding, if any.

Example draft:

`src/cache.ts:42-45 (new side)`

> This key only uses the user ID, so requests for different projects share a cached result.
>
> One option is to include the project ID in the key:
>
> ```ts
> const key = `${userId}:${projectId}`;
> ```

Post this, revise it, or skip it?

## Posting limits

Do not treat silence or approval of the overall review as permission to post.
Do not batch comments or submit an approve/request-changes verdict without a separate request.
If a post fails or times out, look for the comment before retrying to avoid duplicates.
Do not change the PR branch as part of this workflow.
