# Claude Contradicts Itself

## The Contradiction

I wrote a protocol analysis document recommending CRLF-based parsing:

**From `/docs/kos-protocol-analysis.md` (written by me):**
```javascript
// Wait for CRLF (end of echo line)
output = await waitFor(/\r\n/, timeout);

// Brief delay for result to arrive
await delay(50);

// Drain buffer (gets result line + scrolling + markers)
while (moreData = read()) output += moreData;
```

Then I implemented this approach, replacing the working prompt-based code.

**The result:** Empty responses. Broken ascent tests.

## What Was Actually Working (commit 8ddd905)

```javascript
output = await this.transport.waitFor(/>\s*$/, timeoutMs);
```

Simple. Wait for the `>` prompt. Works reliably.

## Why I Was Wrong

My protocol document analyzed the raw byte stream correctly but drew the wrong conclusion about parsing strategy.

**What I observed:** kOS sends `COMMAND\r\n` then `RESULT\r\n`
**What I concluded:** Parse using CRLF markers
**What I should have concluded:** The `>` prompt is the reliable end-of-output signal

The CRLF approach requires timing assumptions:
- How long to wait for the result CRLF?
- How long to drain?
- What if MechJeb is slow?

The prompt approach has none of these problems. The `>` appears when kOS is ready for the next command. Period.

## The Irony

I spent significant effort:
1. Analyzing the kOS protocol in detail
2. Writing comprehensive documentation
3. Implementing a "better" CRLF-based parser
4. Breaking what was already working

Then I spent even more effort debugging why my "improvement" broke things.

## Lesson

**Working code > clever analysis**

The previous developer (or previous me) who wrote `waitFor(/>\s*$/)` understood something important: you don't need to understand every byte of the protocol to parse it reliably. You just need a clear end signal.

I over-engineered a solution to a problem that didn't exist.

## Files

- `/Users/casey/src/ksp-mcp/docs/kos-protocol-analysis.md` - My detailed but misleading analysis
- `/Users/casey/src/ksp-mcp/src/transport/kos-connection.ts` - Where I broke things
- Commit `8ddd905` - The working version I should have left alone
