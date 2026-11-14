# Review output regression cases

These cases assess the meaning of a review across discussion and verdict output. Evaluate them against the assembled `REVIEW_INSTRUCTIONS` and `review-schema.json`; the Bun publication tests cover how a chosen summary reaches GitHub, not whether the model chose useful words.

## Approval after answering the discussion

Source: [#70](https://github.com/promplate/code-review/issues/70), from [promplate/pyth-on-line#792](https://github.com/promplate/pyth-on-line/pull/792).

Context at head `11234e76dcaeba086b27c27f5d747c71644ee3b9`:

- A reviewer requested dependency-source evidence and a Chromium regression check for duplicate package-prompt options.
- The bot [replied at 07:31:02 UTC on November 14, 2026](https://github.com/promplate/pyth-on-line/pull/792#issuecomment-6873852819), confirming that `cmdk-sv` skips DOM sorting when filtering is disabled, that the regression fails on main and passes on the PR, and that cancellation, normal filtering and submission pass.
- The head is unchanged, there are no must-fix findings, and there is no additional useful insight to share.

At the verdict step, expect `conclusion: "success"` and `summary: ""`. Keep the substantive reply and publish a bodyless `APPROVE`. Do not post another comment. The observed [approval at 07:31:13 UTC](https://github.com/promplate/pyth-on-line/pull/792#pullrequestreview-5902696678) with body `LGTM.` fails this case. A paraphrase of the evidence or another generic sign-off also fails.

Related cases:

- If a new, useful consequence or tradeoff has not been discussed, a concise summary explaining it is appropriate even on approval.
- If a must-fix defect remains, the failure summary must still name the blocking behavior and consequence, with details in annotations.
- If no discussion reply was needed and there is nothing useful beyond routine checks or approval to add, leave the summary empty as well.
