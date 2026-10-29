// Markdown-lite → React elements. No HTML is ever injected, so nothing a
// friend types can run in your browser.
//   **bold**  *italic* / _italic_  ~~strike~~  `code`  ```blocks```
//   > quote lines, http(s) links, @mentions, line breaks.

import { Fragment } from 'react';

const INLINE_RE = /(```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\n]+\*(?!\w)|(?<![\w_])_[^_\n]+_(?!\w)|https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]|(?<![a-z0-9_.-])@[a-z0-9_.-]{2,32})/gi;

export function render(body, { members = [], me } = {}) {
  if (!body) return null;
  const byName = new Map(members.map((m) => [m.username.toLowerCase(), m]));
  let key = 0;

  const inline = (text) => {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(INLINE_RE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(token(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const token = (t) => {
    const k = key++;
    if (t.startsWith('```')) {
      const inner = t.slice(3, -3).replace(/^[a-z0-9+#-]*\n/i, '').replace(/^\n|\n$/g, '');
      return <pre key={k}><code>{inner}</code></pre>;
    }
    if (t.startsWith('`')) return <code key={k}>{t.slice(1, -1)}</code>;
    if (t.startsWith('**')) return <strong key={k}>{inline(t.slice(2, -2))}</strong>;
    if (t.startsWith('~~')) return <s key={k}>{inline(t.slice(2, -2))}</s>;
    if (t.startsWith('*') || t.startsWith('_')) return <em key={k}>{inline(t.slice(1, -1))}</em>;
    if (t.startsWith('@')) {
      const name = t.slice(1).replace(/[.-]+$/, '');
      const trail = t.slice(1 + name.length);
      const everyone = name.toLowerCase() === 'everyone';
      const user = byName.get(name.toLowerCase());
      if (!everyone && !user) return t;
      const isMe = everyone || (me && user.id === me);
      return (
        <Fragment key={k}>
          <span className={`mention${isMe ? ' mention-me' : ''}`} title={user ? `@${user.username}` : undefined}>@{everyone ? 'everyone' : user.display_name}</span>
          {trail}
        </Fragment>
      );
    }
    return <a key={k} href={t} target="_blank" rel="noopener noreferrer">{t}</a>;
  };

  // Line by line so "> quote" works and code blocks can span lines.
  const blocks = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      let j = i;
      let buf = line;
      // Find the closing fence (same line or later).
      if (!(line.length > 3 && line.endsWith('```'))) {
        for (j = i + 1; j < lines.length; j++) {
          buf += '\n' + lines[j];
          if (lines[j].includes('```')) break;
        }
      }
      if (buf.endsWith('```') && buf.length >= 6) {
        blocks.push(token(buf));
        i = j + 1;
        continue;
      }
      // Unclosed fence: treat as text.
    }
    if (line.startsWith('> ') || line === '>') {
      const quote = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quote.push(lines[i].slice(2));
        i++;
      }
      blocks.push(<blockquote key={key++}>{render(quote.join('\n'), { members, me })}</blockquote>);
      continue;
    }
    blocks.push(<Fragment key={key++}>{inline(line)}{i < lines.length - 1 ? <br /> : null}</Fragment>);
    i++;
  }
  return blocks;
}

// Does this body mention the given user (or everyone)? Used for the
// highlight on the message row; the server decides the badge counts.
export function mentionsMe(message, me) {
  return Array.isArray(message.mentions) && message.mentions.includes(me);
}
