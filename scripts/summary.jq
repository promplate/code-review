# What a run page says when the reviewer itself had nothing to add: the verdict it reached and how much detail sits beside it.
# $conclusion is the verdict that page shows, which differs from the review's own when a commit is published on its own.
def summary_line($conclusion):
  if (.summary | test("\\S")) then .summary
  else "\(if $conclusion == "failure" then "Changes requested" else "Approved" end) · \(.annotations | length) annotation\(if (.annotations | length) == 1 then "" else "s" end)" end;
