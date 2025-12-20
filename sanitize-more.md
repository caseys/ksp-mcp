# Archived sanitizeToolText (pre-Unicode update)

```
function sanitizeToolText(text) {
  if (!text) {
    return '(no output)';
  }
  const cleaned = text
    .replace(/[^\t\n\r\x20-\x7E]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length ? cleaned : '(no output)';
}
```

Captured from `ollama-tools/agent.js` before loosening the character filter.
