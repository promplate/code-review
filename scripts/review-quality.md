# Review output regression cases

These cases assess the meaning of a review across discussion and verdict output. Evaluate them against the assembled `REVIEW_INSTRUCTIONS` and `review-schema.json`; the Bun publication tests cover how a chosen summary reaches GitHub, not whether the model chose useful words.

## Approval after answering the discussion

Source: [#70](https://github.com/promplate/code-review/issues/70).

A reviewer asks for evidence the diff alone does not settle. The review answers in a substantive reply, the head stays where it was, there are no must-fix findings, and nothing useful remains to add.

At the verdict step, expect `conclusion: "success"` and `summary: ""`. Keep the substantive reply and publish a bodyless `APPROVE`. Do not post another comment. An approval carrying `LGTM.` or another generic sign-off fails this case, and so does restating the evidence already given.

Related cases:

- If a new, useful consequence or tradeoff has not been discussed, a concise summary explaining it is appropriate even on approval.
- If a must-fix defect remains, the failure summary must still name the blocking behavior and consequence, with details in annotations.
- If no discussion reply was needed and there is nothing useful beyond routine checks or approval to add, leave the summary empty as well.
