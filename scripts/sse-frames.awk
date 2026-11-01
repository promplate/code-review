# One process per connection: EOF discards a partial frame instead of advancing the replay cursor.
{
  sub(/\r$/, "")
  frame = frame $0 "\n"
  if ($0 ~ /^id: /) id = substr($0, 5)
  if ($0 == "") {
    printf "%s", frame
    fflush()
    if (id != "") cursor = id
    id = ""
    frame = ""
  }
}
END { if (cursor_file != "" && cursor != "") print cursor > cursor_file }
