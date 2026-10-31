# One process per connection: EOF discards a partial frame instead of advancing the replay cursor.
{
  sub(/\r$/, "")
  frame = frame $0 "\n"
  if ($0 == "") {
    printf "%s", frame
    fflush()
    frame = ""
  }
}
