# One process per connection: EOF discards a partial frame.
{
  sub(/\r$/, "")
  # curl -i puts response headers before the body. Reject non-SSE bytes before they can enter the log.
  if (response_file != "" && !headers_done) {
    if ($1 ~ /^HTTP\//) { status = $2; media = "" }
    if (tolower($0) ~ /^content-type:/) { media = tolower($0); sub(/^[^:]*:[ \t]*/, "", media); sub(/[ \t]*;.*/, "", media); sub(/[ \t]*$/, "", media) }
    if ($0 == "") {
      if (status >= 100 && status < 200) { status = ""; media = ""; next }
      headers_done = 1
      print status " " media > response_file
      close(response_file)
      if (status != 200 || media != "text/event-stream") exit
      if (status == 200 && media == "text/event-stream" && reconnect_file != "") {
        while ((getline line < reconnect_file) > 0) print line
        close(reconnect_file)
        fflush()
      }
    }
    next
  }
  if (response_file != "" && (status != 200 || media != "text/event-stream")) next
  frame = frame $0 "\n"
  if ($0 == "") {
    printf "%s", frame
    fflush()
    frame = ""
  }
}
