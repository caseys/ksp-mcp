# kOS Telnet Protocol Analysis

**Date**: 2024-12-14
**Status**: COMPLETE - Protocol fully understood from kOS source code

## Overview

kOS provides a telnet server (default port 5410) for remote command execution. This document provides a complete analysis based on kOS source code examination.

## Source Code References

- `/Users/casey/src/KOS/src/kOS.Safe/UserIO/UnicodeCommand.cs` - All control character definitions
- `/Users/casey/src/KOS/src/kOS.Safe/Screen/ScreenSnapshot.cs` - Screen diff algorithm
- `/Users/casey/src/KOS/src/kOS/UserIO/TelnetSingletonServer.cs` - Telnet server implementation
- `/Users/casey/src/KOS/src/kOS/UserIO/TerminalUnicodeMapper.cs` - Terminal output conversion

## Key Finding: Two-Part Output Format

Each command produces output in TWO distinct formats, sent sequentially:

### Part 1: Plain Text (CRLF-terminated)
```
COMMAND\r\n
RESULT\r\n
(many \r\n for screen scrolling)
```
- Echo of the command followed by CRLF (`\r\n` = `0d 0a`)
- Result (if any) followed by CRLF
- Then screen scrolling: many consecutive CRLFs
- **Simple PRINT commands reliably produce this format**

### Part 2: Control Character Block (Marker-based)
```
[marker]echo[marker]result[marker]
```
- Uses Private Use Area character U+E006 (`ee 80 86` in UTF-8)
- Format varies: `\uE006 XX YY` where XX can be `00` or position info
- Used for terminal screen positioning and formatting
- Final marker has no content after it (end signal)

## Complete Test Results

### Test 1: PRINT 1+1. (Simple arithmetic)
```
Plain text: PRINT 1+1.\r\n 2\r\n
Markers:    [07]PRINT 1+1. [08]2 [09](end)
```

### Test 2: PRINT "hello world". (String output)
```
Plain text: PRINT "hello world".\r\n hello world\r\n
Markers:    [10]PRINT "hello world". [11]hello world [12](end)
```

### Test 3: SET X TO 42. (No output command)
```
Plain text: SET X TO 42.\r\n
Markers:    [09]SET X TO 42. [0a](end)
```

### Test 4: PRINT SHIP:ORBIT:APOAPSIS. (Telemetry)
```
Plain text: PRINT SHIP:ORBIT:APOAPSIS.\r\n 82.7236998269\r\n
Markers:    [16]PRINT SHIP:ORBIT:APOAPSIS. [17][16]82.7237... [17](end)
```

### Test 5: LIST. (Multi-line tabular output)
```
Plain text: (minimal - mostly in marker section)
Markers:    Complex with column positioning:
            [12]LIST. [13](ctrl) [12]/ [13]Name [21 13]Size [14]--- [15]Free space... [17](end)

Note: Byte after ee 80 86 varies:
- 00 XX = normal line marker
- 21 XX = column position (0x21 = column 33 for "Size" column)
```

### Test 6: INVALID_COMMAND. (Error output)
```
Plain text: Error message with \r\n terminators:
            _______________\r\n
            VERBOSE DESCRIPTION\r\n
            Undefined Variable Name 'invalid_command'.\r\n
            At interpreter, line 7\r\n
            INVALID_COMMAND.\r\n
            ^\r\n

Markers:    Complex multi-segment with many [ee 80 94] cursor controls
```

## Marker Format Details

### Basic Format
```
Byte sequence: ee 80 86 XX YY [content]
               └──────┘ └──┘
                  │      └─── Two bytes: position/counter info
                  └────────── UTF-8 encoding of U+E006 (Private Use Area)
```

### Byte Variations Observed
| Pattern | Meaning |
|---------|---------|
| `ee 80 86 00 XX` | Normal line marker, XX = counter |
| `ee 80 86 21 XX` | Column position 33 (0x21), used in LIST |
| `ee 80 86 0b 10` | Row 11, column 16 (possibly) |
| `ee 80 94` | U+E014 - cursor control/positioning |

### Counter Behavior
- **Global per session**: Persists across commands and even reconnections
- **NOT strictly incrementing**: Can repeat (12→13→12) or skip (15→17)
- **Used for terminal state**: More like cursor position than sequence number
- **End marker**: Has no content after it

## Critical Findings

### What Works for Simple Commands (PRINT, SET)
1. **Plain text CRLF** - Reliable for echo and result
2. **Pattern**: `ECHO\r\n` then `RESULT\r\n` (if any)
3. **Timing**: Plain text comes FIRST, markers come AFTER scrolling

### What's Complex (LIST, Errors)
1. **Tabular output** uses column positioning markers
2. **Errors** have multi-line formatted output
3. **Plain text section** may be minimal or mixed with scrollback

### Previous Code Assumptions (INCORRECT!)
The original code assumed these control characters:
- NAK (0x15) before command echo
- SYN (0x16) between echo and result
- ETB (0x17) at end of output

**This was COMPLETELY WRONG.** These characters NEVER appear in kOS output!
The code was timing out on EVERY command because `waitFor(/\u0017/)` never matched.

## Complete UnicodeCommand Enum (from kOS source)

kOS uses Unicode Private Use Area (0xE000-0xF8FF) for terminal control:

```
BREAK             = 0xE000  // Interrupt signal
DIE               = 0xE001  // Close connection
CLEARSCREEN       = 0xE002  // Clear and home cursor
REQUESTREPAINT    = 0xE003  // Request full redraw
TITLEBEGIN        = 0xE004  // Start title string
TITLEEND          = 0xE005  // End title string
TELEPORTCURSOR    = 0xE006  // Move cursor: + col + row bytes
UPCURSORONE       = 0xE007  // Move cursor up
DOWNCURSORONE     = 0xE008  // Move cursor down
LEFTCURSORONE     = 0xE009  // Move cursor left
RIGHTCURSORONE    = 0xE00A  // Move cursor right
HOMECURSOR        = 0xE00B  // Cursor to line start
ENDCURSOR         = 0xE00C  // Cursor to line end
PAGEUPCURSOR      = 0xE00D  // Page up
PAGEDOWNCURSOR    = 0xE00E  // Page down
DELETELEFT        = 0xE00F  // Backspace
DELETERIGHT       = 0xE010  // Delete
STARTNEXTLINE     = 0xE011  // CR+LF equivalent
LINEFEEDKEEPCOL   = 0xE012  // LF only
GOTOLEFTEDGE      = 0xE013  // CR only
SCROLLSCREENUPONE = 0xE014  // Scroll up one line
SCROLLSCREENDOWNONE = 0xE015 // Scroll down one line
RESIZESCREEN      = 0xE016  // Resize: + width + height bytes
BEEP              = 0xE017  // Terminal bell
REVERSESCREENMODE = 0xE018  // Reverse video
NORMALSCREENMODE  = 0xE019  // Normal video
```

### TELEPORTCURSOR Format (0xE006)

This is the most common control we see. Format:
```
ee 80 86   XX   YY   [content]
└──────┘   └─┘  └─┘
U+E006    col  row
```

Example: `ee 80 86 21 0f` = position cursor at column 33, row 15

### SCROLLSCREENUPONE (0xE014)

Multiple consecutive 0xE014 chars = scroll up that many lines:
```
ee 80 94 ee 80 94 ee 80 94  = scroll up 3 lines
```

## Protocol Layers

### Layer 1: Standard Telnet (RFC 854)
- IAC (0xFF) escape sequences
- Terminal type negotiation (RFC 1091)
- Window size negotiation (RFC 1073)
- Character-at-a-time vs line-at-a-time mode

### Layer 2: kOS Terminal Commands (UnicodeCommand)
- Private Use Area characters for screen control
- Screen diff algorithm sends only changed portions
- TELEPORTCURSOR positions text at specific row/col

### Layer 3: Application Output
- Plain text with CRLF line endings
- Command echo followed by result
- This is what we want to parse!

## How kOS Sends Output

From `ScreenSnapshot.DiffFrom()` (lines 102-216):

1. **Calculate scroll delta** between old and new screen state
2. **For each changed row**, find diff chunks
3. **For each diff chunk**:
   - If cursor is already at position: just write content
   - Otherwise: TELEPORTCURSOR(col, row) + content
4. **Final cursor position**: TELEPORTCURSOR to actual cursor location

This explains why we see TELEPORTCURSOR commands with row numbers that look like "counters" - they're actually screen row positions!

## Recommended Parsing Strategy

### For Simple Commands (PRINT, SET) - Use CRLF
```typescript
// Wait for CRLF (end of echo line)
output = await waitFor(/\r\n/, timeout);

// Brief delay for result to arrive
await delay(50);

// Drain buffer (gets result line + scrolling + markers)
while (moreData = read()) output += moreData;

// Clean output: strip echo, markers, control chars
return cleanOutput(command, output);
```

**Why this works:**
- CRLF appears immediately after echo and result
- Simple and fast - no complex pattern matching
- Works for all tested PRINT/SET commands

### For Complex Commands (LIST, etc.) - May need marker parsing
If CRLF-based parsing fails, fall back to looking for the marker pattern.
The empty end marker `ee 80 86 XX YY` with no content after signals completion.

## Test Commands

```bash
# Fresh session test
timeout 10 bash -c '{
  sleep 1; printf "1\n"
  sleep 2; printf "YOUR_COMMAND\n"
  sleep 5
} | nc 127.0.0.1 5410' > /tmp/kos-test.bin

# View hex output
xxd /tmp/kos-test.bin | tail -40
```

## Files

- `/Users/casey/src/ksp-mcp/src/transport/kos-connection.ts` - Main execute() method
- `/Users/casey/src/ksp-mcp/src/transport/socket-transport.ts` - TCP transport
- `/Users/casey/src/ksp-mcp/src/transport/transport.ts` - Base class with waitFor()
- `/Users/casey/src/ksp-mcp/docs/kos-protocol-analysis.md` - This document
