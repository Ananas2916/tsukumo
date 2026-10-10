/**
 * Minimal, safe Markdown for chat replies.
 *
 * Agents often reply in markdown ("**frieren** = ..."): read aloud it is
 * cleaned up by the backend, but in the chat it should look formatted.
 * Supports paragraphs, lists, code blocks, `code`, **bold**, *italic* and
 * [links](https://...). It builds DOM nodes: no innerHTML, so no HTML from
 * the agent is ever interpreted.
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      fragment.append(node('code', token.slice(1, -1)));
    } else if (token.startsWith('**') || token.startsWith('__')) {
      fragment.append(node('strong', token.slice(2, -2)));
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'));
      const url = token.slice(token.indexOf('(') + 1, -1);
      if (/^https?:\/\//i.test(url)) {
        const link = node('a', label);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        fragment.append(link);
      } else {
        fragment.append(label);
      }
    } else {
      fragment.append(node('em', token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

/** Markdown text -> DOM fragment. */
export function renderMarkdown(source) {
  const root = document.createDocumentFragment();
  const lines = String(source ?? '').replace(/\r/g, '').split('\n');
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    paragraph.forEach((line, index) => {
      if (index) p.append(document.createElement('br'));
      p.append(inline(line));
    });
    root.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) root.append(list);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      const pre = document.createElement('pre');
      pre.append(node('code', code.join('\n')));
      root.append(pre);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      const ordered = /^\s*\d/.test(line);
      if (!list || (list.tagName === 'OL') !== ordered) {
        flushList();
        list = document.createElement(ordered ? 'ol' : 'ul');
      }
      const item = document.createElement('li');
      item.append(inline(bullet[1]));
      list.append(item);
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const strong = document.createElement('p');
      strong.className = 'md-heading';
      strong.append(inline(heading[1]));
      root.append(strong);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return root;
}
