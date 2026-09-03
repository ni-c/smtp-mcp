# Recording for docs/public/demo.gif.
#
# Prerequisites:
#   - vhs (https://github.com/charmbracelet/vhs) and its ttyd/ffmpeg dependencies
#   - npm run build, so dist/ is current
#   - the sandbox running, because the server connects on startup:
#       docker compose -f test/integration/compose.yml up -d --wait
#
# Run it from the REPOSITORY ROOT, not from docs/:
#   vhs docs/demo.tape
#
# Two traps worth knowing before editing this file:
#
#   1. The MCP Inspector CLI does NOT inherit the environment. Every variable
#      needs its own `-e` flag, which is why the `mcp` helper below exists —
#      exporting them would look like it worked and would not.
#   2. Inside a Hide block use vhs's own `Sleep`, never the shell's. The shell's
#      blocks the recorder and the tape ends before any output appears.
#
# Three beats, and they are the argument this project makes: the tools exist,
# a send stops and asks, and a recipient outside the allowlist never gets that
# far. Nothing here sends anything — the second beat is the first of two calls
# and the third is a refusal.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 590
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms

Hide
Type `mcp() { npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e SMTP_HOST=127.0.0.1 -e SMTP_PORT=1025 -e SMTP_TLS=none -e SMTP_USER=demo -e SMTP_PASSWORD=demo -e "SMTP_FROM=Demo <demo@example.net>" -e SMTP_ALLOW_SEND=true -e SMTP_ALLOWED_RECIPIENTS=@example.net "$@" 2>/dev/null; }`
Enter
Type "clear"
Enter
Sleep 500ms
Show

Type "mcp --method tools/list | jq -r '.tools[].name'"
Enter
Sleep 6s

Type `mcp --method tools/call --tool-name send_mail --tool-arg 'to=["anna@example.net"]' --tool-arg 'subject=Quarterly report' --tool-arg 'body=Here it is.' | jq -r '.content[0].text'`
Enter
Sleep 8s

Type `mcp --method tools/call --tool-name send_mail --tool-arg 'to=["stranger@evil.example"]' --tool-arg 'subject=Quarterly report' --tool-arg 'body=Here it is.' | jq -r '.content[0].text'`
Enter
Sleep 8s
