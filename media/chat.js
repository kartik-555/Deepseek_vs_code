/*
 * DeepSeek Harness chat webview.
 *
 * Plain browser JavaScript: no imports, no bundler syntax, no eval, no inline
 * event handler attributes, no localStorage. The host document shell loads this
 * with a nonce and a strict CSP.
 *
 * The webview keeps the transcript as an id-keyed item map plus one DOM node per
 * item, so a mutation re-renders only the node it touches.
 */
'use strict';

(function () {
  /* acquireVsCodeApi must be called exactly once. */
  const vscode = acquireVsCodeApi();

  /* ------------------------------------------------------------ constants */

  const RUNTIME_LABELS = {
    idle: 'Idle',
    starting: 'Starting',
    ready: 'Ready',
    stopped: 'Stopped',
    failed: 'Failed'
  };

  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0
  };

  const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const IMAGE_MAGIC = [
    ['iVBOR', 'image/png'],
    ['/9j/', 'image/jpeg'],
    ['UklGR', 'image/webp'],
    ['R0lGOD', 'image/gif']
  ];
  const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };

  const DIFF_TOOLS = ['write', 'edit', 'multi_edit'];
  const FILE_ARG_KEYS = [
    'path',
    'file_path',
    'filePath',
    'filepath',
    'filename',
    'file',
    'target',
    'target_path',
    'targetPath',
    'notebook_path'
  ];

  const OUTPUT_PREVIEW_LIMIT = 4000;
  const SCROLL_FOLLOW_THRESHOLD = 48;

  const ICON_CHECK =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path d="M3.2 8.6l3.1 3.1 6.5-7.2" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CROSS =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round"/></svg>';
  const ICON_TRASH =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path d="M3.4 4.6h9.2M6.4 4.6V3.2h3.2v1.4M4.6 4.6l.6 8.2h5.6l.6-8.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------------------------------------------------------------- state */

  const state = {
    settings: {
      showReasoning: true,
      animateChunks: false,
      model: '',
      provider: '',
      reasoningEffort: '',
      resolvedRoute: '',
      permissionMode: ''
    },
    runtime: { state: 'idle', detail: '' },
    sessions: [],
    session: null,
    activeSessionId: '',
    itemOrder: [],
    items: new Map(),
    nodes: new Map(),
    seenUsage: new Map(),
    usage: normalizeUsage(null),
    running: false,
    turnStartedAt: 0,
    timer: 0,
    resizeObserver: null,
    follow: true,
    pendingImages: [],
    contextChips: []
  };

  let dom = null;

  /* ---------------------------------------------------------------- utils */

  function byId(id) {
    return document.getElementById(id);
  }

  function str(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }

  function truncate(text, max) {
    const value = str(text);
    return value.length > max ? value.slice(0, max - 1) + '\u2026' : value;
  }

  function formatCount(value) {
    const n = Number(value) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
  }

  function formatTokens(value) {
    const n = Number(value) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return n < 10000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n / 1000) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
  }

  function formatTime(at) {
    const value = Number(at);
    if (!value) return '';
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      return '';
    }
  }

  function relativeTime(at) {
    const value = Number(at);
    if (!value || !isFinite(value)) return 'unknown';
    const diff = Date.now() - value;
    if (diff < 45000) return 'just now';
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    try {
      return new Date(value).toLocaleDateString();
    } catch (error) {
      return 'older';
    }
  }

  function elapsedLabel(milliseconds) {
    const total = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' + seconds : String(seconds));
  }

  /* ------------------------------------------------------------- markdown */

  function escapeHtml(value) {
    return str(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeHref(href) {
    const value = str(href).trim();
    if (!value) return '';
    if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(value)) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
    return value;
  }

  const CODE_TOKEN = '\u0000';

  function renderInline(escaped) {
    const codes = [];
    let text = escaped.replace(/`([^`\n]+)`/g, function (match, code) {
      codes.push(code);
      return CODE_TOKEN + (codes.length - 1) + CODE_TOKEN;
    });

    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (match, label, href) {
      const safe = sanitizeHref(href);
      if (!safe) return label;
      return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });

    text = text.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    text = text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

    return text.replace(new RegExp(CODE_TOKEN + '(\\d+)' + CODE_TOKEN, 'g'), function (match, index) {
      return '<code class="inline-code">' + codes[Number(index)] + '</code>';
    });
  }

  function codeBlockHtml(lang, code) {
    return (
      '<div class="code-block">' +
      '<div class="code-head"><span class="code-lang">' +
      escapeHtml(lang || 'text') +
      '</span><button type="button" class="code-copy" data-action="copy-code">Copy</button></div>' +
      '<pre class="code-pre"><code>' +
      code +
      '</code></pre></div>'
    );
  }

  function isTableSeparator(line) {
    if (line.indexOf('-') === -1) return false;
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
  }

  function splitRow(line) {
    let value = line.trim();
    if (value.charAt(0) === '|') value = value.slice(1);
    if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1);
    return value.split('|');
  }

  function startsBlock(lines, index) {
    const line = lines[index];
    if (!line.trim()) return true;
    if (/^(\s*)(```+|~~~+)\s*[A-Za-z0-9_+#.-]*\s*$/.test(line)) return true;
    if (/^#{1,6}\s+/.test(line)) return true;
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) return true;
    if (/^\s{0,3}&gt;\s?/.test(line)) return true;
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) return true;
    if (line.indexOf('|') !== -1 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
    return false;
  }

  function renderList(lines, start, indent, firstMarker) {
    const ordered = /^\d/.test(firstMarker);
    const items = [];
    let current = null;
    let i = start;

    while (i < lines.length) {
      const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
      if (match) {
        const itemIndent = match[1].length;
        if (itemIndent < indent) break;
        if (itemIndent > indent + 1 && current) {
          const nested = renderList(lines, i, itemIndent, match[2]);
          current.nested.push(nested.html);
          i = nested.next;
          continue;
        }
        if (/^\d/.test(match[2]) !== ordered) break;
        current = { text: match[3], nested: [] };
        items.push(current);
        i++;
        continue;
      }
      if (!lines[i].trim()) {
        const next = lines[i + 1];
        const nextMatch = next ? /^(\s*)([-*+]|\d+[.)])\s+/.exec(next) : null;
        if (nextMatch && nextMatch[1].length >= indent) {
          i++;
          continue;
        }
        break;
      }
      if (current && /^\s+\S/.test(lines[i])) {
        current.text += '<br />' + lines[i].trim();
        i++;
        continue;
      }
      break;
    }

    const tag = ordered ? 'ol' : 'ul';
    const html =
      '<' +
      tag +
      ' class="md-list">' +
      items
        .map(function (item) {
          return '<li>' + renderInline(item.text) + (item.nested.length ? item.nested.join('') : '') + '</li>';
        })
        .join('') +
      '</' +
      tag +
      '>';

    return { html: html, next: i };
  }

  function renderTable(lines, start) {
    const header = splitRow(lines[start]);
    const separators = splitRow(lines[start + 1]);
    const aligns = separators.map(function (cell) {
      const value = cell.trim();
      const left = value.charAt(0) === ':';
      const right = value.charAt(value.length - 1) === ':';
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });

    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
      rows.push(splitRow(lines[i]));
      i++;
    }

    const cell = function (tag, value, index) {
      const align = aligns[index] || '';
      const cls = align ? ' class="md-align-' + align + '"' : '';
      return '<' + tag + cls + '>' + renderInline(str(value).trim()) + '</' + tag + '>';
    };

    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    html += header
      .map(function (value, index) {
        return cell('th', value, index);
      })
      .join('');
    html += '</tr></thead>';
    if (rows.length) {
      html += '<tbody>';
      html += rows
        .map(function (row) {
          return (
            '<tr>' +
            header
              .map(function (unused, index) {
                return cell('td', row[index] === undefined ? '' : row[index], index);
              })
              .join('') +
            '</tr>'
          );
        })
        .join('');
      html += '</tbody>';
    }
    html += '</table></div>';
    return { html: html, next: i };
  }

  /**
   * The markdown subset in the contract: fenced code, inline code, bold,
   * italic, strikethrough, links, ATX headings, ul/ol lists (nested), block
   * quotes, horizontal rules, and tables. Every input is escaped first, so no
   * model or file text can become markup.
   */
  function renderMarkdown(source) {
    const escaped = escapeHtml(str(source).replace(/\r\n?/g, '\n'));
    const lines = escaped.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      const fence = /^(\s*)(```+|~~~+)\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
      if (fence) {
        const marker = fence[2].charAt(0);
        const closer = new RegExp('^\\s*' + marker + '{3,}\\s*$');
        const body = [];
        const lang = fence[3] || '';
        i++;
        while (i < lines.length) {
          if (closer.test(lines[i])) {
            i++;
            break;
          }
          body.push(lines[i]);
          i++;
        }
        out.push(codeBlockHtml(lang, body.join('\n')));
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + ' class="md-h md-h' + level + '">' + renderInline(heading[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
        out.push('<hr class="md-hr" />');
        i++;
        continue;
      }

      if (/^\s{0,3}&gt;\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s{0,3}&gt;\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s{0,3}&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote class="md-quote">' + renderMarkdown(quote.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const table = renderTable(lines, i);
        out.push(table.html);
        i = table.next;
        continue;
      }

      const listMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
      if (listMatch) {
        const list = renderList(lines, i, listMatch[1].length, listMatch[2]);
        out.push(list.html);
        i = list.next;
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        paragraph.push(lines[i].trim());
        i++;
      }
      if (!paragraph.length) {
        paragraph.push(lines[i].trim());
        i++;
      }
      out.push('<p class="md-p">' + renderInline(paragraph.join('<br />')) + '</p>');
    }

    return out.join('');
  }

  /* ----------------------------------------------------------- item tools */

  function normalizeUsage(usage) {
    const source = usage && typeof usage === 'object' ? usage : {};
    const pick = function (key) {
      const value = Number(source[key]);
      return isFinite(value) && value > 0 ? value : 0;
    };
    const result = {
      inputTokens: pick('inputTokens'),
      outputTokens: pick('outputTokens'),
      cacheReadTokens: pick('cacheReadTokens'),
      cacheWriteTokens: pick('cacheWriteTokens'),
      totalTokens: 0
    };
    const total = Number(source.totalTokens);
    result.totalTokens =
      isFinite(total) && total > 0
        ? total
        : result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
    return result;
  }

  function addUsage(a, b) {
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      totalTokens: a.totalTokens + b.totalTokens
    };
  }

  function subtractUsage(a, b) {
    const diff = function (x, y) {
      return Math.max(0, x - y);
    };
    return {
      inputTokens: diff(a.inputTokens, b.inputTokens),
      outputTokens: diff(a.outputTokens, b.outputTokens),
      cacheReadTokens: diff(a.cacheReadTokens, b.cacheReadTokens),
      cacheWriteTokens: diff(a.cacheWriteTokens, b.cacheWriteTokens),
      totalTokens: diff(a.totalTokens, b.totalTokens)
    };
  }

  function sameUsage(a, b) {
    return (
      a.inputTokens === b.inputTokens &&
      a.outputTokens === b.outputTokens &&
      a.cacheReadTokens === b.cacheReadTokens &&
      a.cacheWriteTokens === b.cacheWriteTokens &&
      a.totalTokens === b.totalTokens
    );
  }

  function usageTitle(usage) {
    return (
      'Input ' +
      usage.inputTokens +
      ', output ' +
      usage.outputTokens +
      ', cache read ' +
      usage.cacheReadTokens +
      ', cache write ' +
      usage.cacheWriteTokens +
      ', total ' +
      usage.totalTokens +
      ' tokens'
    );
  }

  function usageLine(usage) {
    const parts = [formatTokens(usage.inputTokens) + ' in', formatTokens(usage.outputTokens) + ' out'];
    if (usage.cacheReadTokens || usage.cacheWriteTokens) {
      parts.push(formatTokens(usage.cacheReadTokens + usage.cacheWriteTokens) + ' cached');
    }
    return parts.join(' \u00b7 ');
  }

  function prettyArgs(argsText) {
    const raw = str(argsText).trim();
    if (!raw) return '';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
      return raw;
    }
  }

  function filePathFromArgs(argsText) {
    const raw = str(argsText).trim();
    if (!raw) return '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return '';
    }
    if (!parsed || typeof parsed !== 'object') return '';

    const containers = [parsed];
    if (parsed.arguments && typeof parsed.arguments === 'object') containers.push(parsed.arguments);
    if (parsed.args && typeof parsed.args === 'object') containers.push(parsed.args);
    if (parsed.input && typeof parsed.input === 'object') containers.push(parsed.input);

    for (let c = 0; c < containers.length; c++) {
      const container = containers[c];
      for (let k = 0; k < FILE_ARG_KEYS.length; k++) {
        const value = container[FILE_ARG_KEYS[k]];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }

    for (let c = 0; c < containers.length; c++) {
      const container = containers[c];
      const keys = Object.keys(container);
      for (let k = 0; k < keys.length; k++) {
        const value = container[keys[k]];
        if (typeof value === 'string' && value.length < 400 && /[\\/]|\.\w{1,8}$/.test(value)) return value.trim();
      }
    }
    return '';
  }

  function miniButton(label, action, data) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini-button';
    button.textContent = label;
    button.setAttribute('data-action', action);
    if (data) {
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) button.setAttribute('data-' + keys[i], str(data[keys[i]]));
    }
    return button;
  }

  function statusGlyph(status) {
    const glyph = create('span', 'tool-glyph glyph-' + status);
    if (status === 'running') {
      glyph.innerHTML = '<span class="spinner"></span>';
    } else if (status === 'ok') {
      glyph.innerHTML = ICON_CHECK;
    } else {
      glyph.innerHTML = ICON_CROSS;
    }
    return glyph;
  }

  function itemStatus(value) {
    return value === 'ok' || value === 'error' ? value : 'running';
  }

  function baseItem(item, extraClass) {
    const node = document.createElement('article');
    node.className = 'item item-' + str(item.kind) + (extraClass ? ' ' + extraClass : '');
    node.setAttribute('data-id', str(item.id));
    node.setAttribute('data-kind', str(item.kind));
    return node;
  }

  function attachDetails(node, className, label, bodyNode, open) {
    const details = document.createElement('details');
    details.className = className;
    const summary = document.createElement('summary');
    summary.textContent = label;
    details.appendChild(summary);
    if (bodyNode) details.appendChild(bodyNode);
    if (open) details.open = true;
    node.appendChild(details);
    return details;
  }

  /* -------------------------------------------------------- item renderers */

  function renderUserItem(item) {
    const node = baseItem(item);
    const bubble = create('div', 'user-bubble');
    if (str(item.text)) {
      const body = create('div', 'md user-text');
      body.innerHTML = renderMarkdown(item.text);
      bubble.appendChild(body);
    } else {
      bubble.appendChild(create('div', 'md item-note', 'Image attachment'));
    }
    node.appendChild(bubble);

    const meta = create('div', 'item-meta');
    if (str(item.context)) {
      const tag = create('span', 'context-tag', truncate(item.context, 28));
      tag.title = str(item.context);
      meta.appendChild(tag);
    }
    if (Number(item.images) > 0) {
      meta.appendChild(create('span', 'item-note', Number(item.images) === 1 ? '1 image' : item.images + ' images'));
    }
    const time = formatTime(item.at);
    if (time) meta.appendChild(create('span', 'item-note', time));
    if (meta.childNodes.length) node.appendChild(meta);
    return node;
  }

  function renderAssistantItem(item) {
    const node = baseItem(item);

    if (state.settings.showReasoning && str(item.reasoning)) {
      const body = create('div', 'md reasoning-body');
      body.innerHTML = renderMarkdown(item.reasoning);
      attachDetails(node, 'reasoning', 'Reasoning', body, false);
    }

    if (str(item.text)) {
      const body = create('div', 'md');
      body.innerHTML = renderMarkdown(item.text);
      node.appendChild(body);
    } else if (!str(item.reasoning)) {
      node.appendChild(create('div', 'md item-note', '\u2026'));
    }

    const meta = create('div', 'item-meta');
    if (item.turn !== undefined && item.turn !== null) {
      meta.appendChild(
        create('span', 'item-note', 'turn ' + str(item.turn) + ' \u00b7 step ' + str(item.step === undefined ? '' : item.step))
      );
    }
    const usage = item.usage ? normalizeUsage(item.usage) : null;
    if (usage && usage.totalTokens > 0) {
      const chip = create('span', 'item-usage', usageLine(usage));
      chip.title = usageTitle(usage);
      meta.appendChild(chip);
    }
    const time = formatTime(item.at);
    if (time) meta.appendChild(create('span', 'item-note', time));
    if (meta.childNodes.length) node.appendChild(meta);
    return node;
  }

  function renderToolItem(item) {
    const status = itemStatus(item.status);
    const node = baseItem(item, 'tool-' + status);

    const head = create('div', 'tool-head');
    head.appendChild(statusGlyph(status));
    head.appendChild(create('span', 'tool-name', str(item.name) || 'tool'));
    const summary = create('span', 'tool-summary', str(item.summary));
    if (str(item.summary)) summary.title = str(item.summary);
    head.appendChild(summary);

    const path = filePathFromArgs(item.argsText);
    const actions = create('div', 'tool-actions');
    if (path) {
      actions.appendChild(miniButton('Open', 'open-file', { path: path }));
      if (DIFF_TOOLS.indexOf(str(item.name)) !== -1) {
        actions.appendChild(miniButton('Diff', 'open-diff', { path: path }));
      }
    }
    if (actions.childNodes.length) head.appendChild(actions);
    node.appendChild(head);

    const argsText = prettyArgs(item.argsText);
    if (argsText) {
      const pre = document.createElement('pre');
      pre.textContent = argsText;
      attachDetails(node, 'tool-section tool-args', 'Arguments', pre, status === 'error');
    }

    const output = str(item.output);
    const truncated = !!item.outputTruncated || output.length > OUTPUT_PREVIEW_LIMIT;
    if (output) {
      const body = create('div', 'tool-output-body');
      body.textContent = truncated ? output.slice(0, OUTPUT_PREVIEW_LIMIT) : output;
      const details = document.createElement('details');
      details.className = 'tool-section tool-output';
      const label = create('summary', '', 'Output \u00b7 ' + formatCount(output.length) + ' chars');
      details.appendChild(label);
      details.appendChild(body);
      if (truncated) {
        body.classList.add('clamped');
        const foot = create('div', 'tool-output-foot');
        foot.appendChild(
          create('span', '', item.outputTruncated ? 'Output truncated by the host.' : 'Output truncated.')
        );
        foot.appendChild(miniButton('Show all', 'expand-output', null));
        details.appendChild(foot);
      }
      if (status === 'error') details.open = true;
      node.appendChild(details);
    } else if (status === 'running') {
      node.appendChild(create('div', 'tool-empty', 'Waiting for output\u2026'));
    }
    return node;
  }

  function renderSubagentItem(item) {
    const status = itemStatus(item.status);
    const node = baseItem(item);
    const head = create('div', 'subagent-head');
    head.appendChild(statusGlyph(status));
    head.appendChild(create('span', 'subagent-provider', str(item.provider) || 'subagent'));
    head.appendChild(create('span', 'item-note', 'child session'));
    const id = create('span', 'subagent-id', str(item.childSessionId));
    id.title = str(item.childSessionId);
    head.appendChild(id);
    node.appendChild(head);
    if (str(item.summary)) node.appendChild(create('div', 'subagent-summary', str(item.summary)));
    return node;
  }

  function renderNoticeItem(item) {
    const level = item.level === 'warn' || item.level === 'error' ? item.level : 'info';
    const node = baseItem(item, 'level-' + level);
    node.appendChild(create('span', 'notice-glyph', level === 'info' ? 'i' : '!'));
    node.appendChild(create('span', 'notice-text', str(item.text)));
    return node;
  }

  function renderFallbackItem(item) {
    const node = baseItem(item);
    const body = create('div', 'md');
    body.appendChild(create('p', 'md-p', str(item.text) || str(item.kind) + ' item'));
    node.appendChild(body);
    return node;
  }

  function itemElement(item) {
    switch (item.kind) {
      case 'user':
        return renderUserItem(item);
      case 'assistant':
        return renderAssistantItem(item);
      case 'tool':
        return renderToolItem(item);
      case 'subagent':
        return renderSubagentItem(item);
      case 'notice':
        return renderNoticeItem(item);
      default:
        return renderFallbackItem(item);
    }
  }

  /* -------------------------------------------------- transcript plumbing */

  function captureUi(node) {
    if (!node) return null;
    const details = node.querySelectorAll('details');
    const open = [];
    for (let i = 0; i < details.length; i++) open.push(details[i].open);
    return { open: open, expanded: !!node.querySelector('.tool-output-body.expanded') };
  }

  function restoreUi(node, ui) {
    if (!node || !ui) return;
    const details = node.querySelectorAll('details');
    for (let i = 0; i < details.length && i < ui.open.length; i++) details[i].open = ui.open[i];
    if (!ui.expanded) return;
    const body = node.querySelector('.tool-output-body');
    if (!body) return;
    const item = state.items.get(str(node.getAttribute('data-id')));
    if (item) body.textContent = str(item.output);
    body.classList.remove('clamped');
    body.classList.add('expanded');
    const foot = node.querySelector('.tool-output-foot');
    if (foot && foot.parentNode) foot.parentNode.removeChild(foot);
  }

  function appendItem(item) {
    if (state.items.has(str(item.id))) {
      updateItem(str(item.id), item);
      return;
    }
    state.items.set(str(item.id), item);
    state.itemOrder.push(str(item.id));
    trackItemUsage(item);
    const node = itemElement(item);
    state.nodes.set(str(item.id), node);
    dom.transcript.insertBefore(node, dom.working);
    if (item.kind === 'user') {
      setFollow(true);
      scrollToBottom();
    }
    maybeScroll();
  }

  function updateItem(id, patch) {
    const item = state.items.get(id);
    if (!item) return;
    if (patch && typeof patch === 'object') {
      const keys = Object.keys(patch);
      for (let i = 0; i < keys.length; i++) item[keys[i]] = patch[keys[i]];
    }
    trackItemUsage(item);
    const old = state.nodes.get(id);
    const ui = captureUi(old);
    const fresh = itemElement(item);
    restoreUi(fresh, ui);
    if (old && old.parentNode === dom.transcript) dom.transcript.replaceChild(fresh, old);
    else dom.transcript.insertBefore(fresh, dom.working);
    state.nodes.set(id, fresh);
    maybeScroll();
  }

  function removeItem(id) {
    const tracked = state.seenUsage.get(id);
    if (tracked) {
      state.usage = subtractUsage(state.usage, tracked);
      state.seenUsage.delete(id);
      updateUsageDisplay();
    }
    const node = state.nodes.get(id);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    state.nodes.delete(id);
    state.items.delete(id);
    const index = state.itemOrder.indexOf(id);
    if (index !== -1) state.itemOrder.splice(index, 1);
    updateEmptyState();
  }

  function clearTranscript() {
    const ids = state.itemOrder.slice();
    for (let i = 0; i < ids.length; i++) {
      const node = state.nodes.get(ids[i]);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    state.itemOrder = [];
    state.items.clear();
    state.nodes.clear();
    state.seenUsage.clear();
  }

  function trackItemUsage(item) {
    if (!item || item.kind !== 'assistant') return;
    const id = str(item.id);
    const previous = state.seenUsage.get(id) || ZERO_USAGE;
    const next = normalizeUsage(item.usage);
    if (sameUsage(previous, next)) return;
    state.usage = addUsage(state.usage, subtractUsage(next, previous));
    state.seenUsage.set(id, next);
    updateUsageDisplay();
  }

  function updateEmptyState() {
    if (!dom) return;
    dom.emptyState.hidden = state.itemOrder.length > 0;
  }

  function updateUsageDisplay() {
    if (!dom) return;
    const usage = state.usage;
    if (!usage || usage.totalTokens <= 0) {
      dom.usage.textContent = '';
      dom.usage.hidden = true;
      dom.usage.removeAttribute('title');
      return;
    }
    dom.usage.hidden = false;
    dom.usage.textContent = usageLine(usage) + ' \u00b7 ' + formatTokens(usage.totalTokens) + ' total';
    dom.usage.title = usageTitle(usage);
  }

  /* ------------------------------------------------------- scroll follow */

  function scrollToBottom() {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }

  function isNearBottom() {
    const node = dom.transcript;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= SCROLL_FOLLOW_THRESHOLD;
  }

  function setFollow(follow) {
    if (follow === state.follow) return;
    state.follow = follow;
    updateJumpButton();
  }

  function updateJumpButton() {
    if (!dom) return;
    dom.jumpLatest.hidden = state.follow;
  }

  function maybeScroll() {
    /* A layout change (composer resize, collapsing tool card) can leave the
       flag stale while the view is still at the bottom; recover before giving
       up on following. */
    reattachFollowIfAtBottom();
    if (state.follow) scrollToBottom();
  }

  function onTranscriptScroll() {
    setFollow(isNearBottom());
  }

  /* Growing the composer, opening the session panel, or resizing the view
     moves the bottom without any scroll, so only re-attach here: detaching
     stays the user's gesture. */
  function reattachFollowIfAtBottom() {
    if (dom && isNearBottom()) setFollow(true);
  }

  function observeTranscriptSize() {
    if (typeof ResizeObserver !== 'function') return;
    state.resizeObserver = new ResizeObserver(function () {
      reattachFollowIfAtBottom();
    });
    state.resizeObserver.observe(dom.transcript);
  }

  /* ------------------------------------------------------ running / timer */

  function setRunning(running, resetTimer) {
    const next = !!running;
    state.running = next;
    if (state.session) state.session.running = next;
    if (next) {
      if (resetTimer || !state.turnStartedAt) state.turnStartedAt = Date.now();
      startTimer();
    } else {
      state.turnStartedAt = 0;
      stopTimer();
    }
    updateWorking();
    updateSendState();
  }

  function startTimer() {
    if (state.timer) return;
    tickTimer();
    state.timer = window.setInterval(tickTimer, 1000);
  }

  function stopTimer() {
    if (!state.timer) return;
    window.clearInterval(state.timer);
    state.timer = 0;
  }

  function tickTimer() {
    if (!dom) return;
    const text = state.running && state.turnStartedAt ? elapsedLabel(Date.now() - state.turnStartedAt) : '0:00';
    dom.workingElapsed.textContent = text;
  }

  function updateWorking() {
    if (!dom) return;
    dom.working.hidden = !state.running;
    dom.transcript.setAttribute('aria-busy', state.running ? 'true' : 'false');
    tickTimer();
  }

  /* ------------------------------------------------------------- composer */

  function autosize() {
    if (!dom) return;
    const input = dom.input;
    const previous = input.style.height;
    input.style.height = 'auto';
    const max = Math.max(48, Math.round(window.innerHeight * 0.4));
    input.style.height = Math.min(input.scrollHeight, max) + 'px';
    if (input.style.height !== previous) reattachFollowIfAtBottom();
  }

  function updateSendState() {
    if (!dom) return;
    const hasContent = dom.input.value.trim().length > 0 || state.pendingImages.length > 0;
    dom.btnSend.hidden = state.running;
    dom.btnStop.hidden = !state.running;
    dom.btnSend.disabled = !hasContent;
    dom.btnStop.disabled = !state.running;
  }

  function focusComposer() {
    if (!dom) return;
    try {
      dom.input.focus();
    } catch (error) {
      /* the webview may not be visible yet */
    }
  }

  function submit() {
    const text = dom.input.value.replace(/\s+$/, '');
    const images = state.pendingImages.slice();
    if (!text.trim() && images.length === 0) return;
    const payload = { text: text };
    const labels = state.contextChips
      .map(function (chip) {
        return chip.label;
      })
      .filter(function (label) {
        return !!label;
      });
    if (labels.length) payload.contextLabel = labels.join(', ');
    if (images.length) {
      payload.images = images.map(function (image) {
        return { data: image.data, mimeType: image.mimeType, name: image.name };
      });
    }
    post('submit', payload);
    dom.input.value = '';
    state.contextChips = [];
    state.pendingImages = [];
    renderChips();
    autosize();
    updateSendState();
    focusComposer();
  }

  function onComposerKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      if (state.running) {
        event.preventDefault();
        post('stop');
        return;
      }
      if (!dom.sessionPanel.hidden) {
        event.preventDefault();
        togglePanel(false);
      }
    }
  }

  function detectImageMime(declared, data) {
    const normalized = str(declared).toLowerCase();
    if (ALLOWED_IMAGE_TYPES.indexOf(normalized) !== -1) return normalized;
    for (let i = 0; i < IMAGE_MAGIC.length; i++) {
      if (str(data).indexOf(IMAGE_MAGIC[i][0]) === 0) return IMAGE_MAGIC[i][1];
    }
    return '';
  }

  function readImageFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) {
        showToast('error', 'Could not read the pasted image.');
        return;
      }
      const data = result.slice(comma + 1);
      const mimeType = detectImageMime(file.type, data);
      if (!mimeType) {
        showToast('warn', 'Unsupported image type. Paste a PNG, JPEG, WebP, or GIF.');
        return;
      }
      const extension = IMAGE_EXTENSIONS[mimeType] || 'png';
      state.pendingImages.push({
        data: data,
        mimeType: mimeType,
        name: str(file.name) || 'pasted-image-' + (state.pendingImages.length + 1) + '.' + extension,
        preview: 'data:' + mimeType + ';base64,' + data
      });
      renderChips();
      updateSendState();
    };
    reader.onerror = function () {
      showToast('error', 'Could not read the pasted image.');
    };
    reader.readAsDataURL(file);
  }

  function onComposerPaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const items = clipboard.items || [];
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.kind === 'file' && /^image\//i.test(str(item.type))) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    for (let i = 0; i < files.length; i++) readImageFile(files[i]);
  }

  function renderChips() {
    if (!dom) return;
    const container = dom.contextChips;
    while (container.firstChild) container.removeChild(container.firstChild);

    state.contextChips.forEach(function (chip, index) {
      const node = create('span', 'chip');
      const label = create('span', 'chip-label', chip.label);
      label.title = chip.detail || chip.label;
      node.appendChild(label);
      const remove = create('button', 'chip-remove', '\u00d7');
      remove.type = 'button';
      remove.setAttribute('data-action', 'remove-chip');
      remove.setAttribute('data-index', String(index));
      remove.setAttribute('aria-label', 'Remove context ' + chip.label);
      node.appendChild(remove);
      container.appendChild(node);
    });

    state.pendingImages.forEach(function (image, index) {
      const node = create('span', 'chip chip-image');
      const thumb = document.createElement('img');
      thumb.src = image.preview;
      thumb.alt = '';
      node.appendChild(thumb);
      const label = create('span', 'chip-label', image.name);
      node.appendChild(label);
      const remove = create('button', 'chip-remove', '\u00d7');
      remove.type = 'button';
      remove.setAttribute('data-action', 'remove-image');
      remove.setAttribute('data-index', String(index));
      remove.setAttribute('aria-label', 'Remove image ' + image.name);
      node.appendChild(remove);
      container.appendChild(node);
    });

    container.hidden = container.childNodes.length === 0;
  }

  /* -------------------------------------------------------- session panel */

  function itemCountLabel(count) {
    const value = Number(count) || 0;
    return value === 1 ? '1 item' : value + ' items';
  }

  function renderSessionList() {
    if (!dom) return;
    const list = dom.sessionList;
    while (list.firstChild) list.removeChild(list.firstChild);

    const sessions = (Array.isArray(state.sessions) ? state.sessions.slice() : []).sort(function (a, b) {
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });

    if (!sessions.length) {
      list.appendChild(create('li', 'session-empty', 'No saved sessions yet.'));
      return;
    }

    sessions.forEach(function (session) {
      const current = str(session.id) === state.activeSessionId;
      const row = create('li', 'session-row' + (current ? ' current' : ''));
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'session-open';
      open.setAttribute('data-action', 'session-open');
      open.setAttribute('data-id', str(session.id));
      const title = str(session.title) || 'Untitled session';
      open.title = title;
      open.appendChild(create('span', 'session-open-title', title));
      open.appendChild(
        create('span', 'session-open-meta', relativeTime(session.updatedAt) + ' \u00b7 ' + itemCountLabel(session.itemCount))
      );
      row.appendChild(open);
      if (current) row.appendChild(create('span', 'session-current-badge', 'current'));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button session-delete';
      remove.setAttribute('data-action', 'session-delete');
      remove.setAttribute('data-id', str(session.id));
      remove.title = 'Delete session';
      remove.setAttribute('aria-label', 'Delete session ' + title);
      remove.innerHTML = ICON_TRASH;
      row.appendChild(remove);

      list.appendChild(row);
    });
  }

  function togglePanel(force) {
    if (!dom) return;
    const show = typeof force === 'boolean' ? force : !!dom.sessionPanel.hidden;
    dom.sessionPanel.hidden = !show;
    dom.btnSessions.setAttribute('aria-expanded', show ? 'true' : 'false');
    reattachFollowIfAtBottom();
    if (show) post('refreshSessions');
  }

  /* -------------------------------------------------------- header / misc */

  function applySettingsDisplay() {
    if (!dom) return;
    const settings = state.settings;
    const model = [settings.provider, settings.model].filter(function (value) {
      return !!value;
    });
    if (state.settings.reasoningEffort) model.push('effort ' + state.settings.reasoningEffort);
    dom.modelLabel.textContent = model.join(' \u00b7 ');
    dom.modelLabel.title = model.length
      ? 'Active model: ' + model.join(' / ') + (state.settings.resolvedRoute ? '\n' + state.settings.resolvedRoute : '') +
        '\nClick to choose another model'
      : 'Choose a model';
    dom.permissionLabel.textContent = settings.permissionMode ? 'permissions: ' + settings.permissionMode : '';
    dom.metaLine.hidden = !dom.modelLabel.textContent && !dom.permissionLabel.textContent;
  }

  function applyRuntime(payload) {
    if (!dom) return;
    const requested = str(payload && payload.state);
    const name = Object.prototype.hasOwnProperty.call(RUNTIME_LABELS, requested) ? requested : 'idle';
    const detail = str(payload && payload.detail);
    state.runtime = { state: name, detail: detail };
    dom.runtimeBadge.className = 'runtime-badge state-' + name;
    dom.runtimeLabel.textContent = RUNTIME_LABELS[name];
    dom.runtimeBadge.title = 'Runtime: ' + RUNTIME_LABELS[name] + (detail ? ' \u2014 ' + detail : '') + ' (click for diagnostics)';
    if (name === 'failed') showToast('error', detail || 'The DSH runtime failed.');
  }

  let toastTimer = 0;

  function showToast(level, text) {
    if (!dom) return;
    const message = str(text);
    if (!message) return;
    const name = level === 'warn' || level === 'error' ? level : 'info';
    dom.toast.className = 'toast level-' + name;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      function () {
        dom.toast.hidden = true;
        toastTimer = 0;
      },
      name === 'error' ? 8000 : 5000
    );
  }

  /* ----------------------------------------------------- host side effects */

  function post(type, payload) {
    if (payload === undefined) vscode.postMessage({ type: type });
    else vscode.postMessage({ type: type, payload: payload });
  }

  function applySession(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    clearTranscript();
    state.session = snapshot;
    state.activeSessionId = str(snapshot.id);
    state.usage = normalizeUsage(snapshot.usage);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object' || !item.id) continue;
      const id = str(item.id);
      state.items.set(id, item);
      state.itemOrder.push(id);
      state.seenUsage.set(id, normalizeUsage(item.usage));
      const node = itemElement(item);
      state.nodes.set(id, node);
      fragment.appendChild(node);
    }
    dom.transcript.insertBefore(fragment, dom.working);

    const title = str(snapshot.title) || 'New session';
    dom.sessionTitle.textContent = title;
    dom.sessionTitle.title = title;
    document.title = title + ' \u2014 DeepSeek Harness';

    updateEmptyState();
    updateUsageDisplay();
    setRunning(!!snapshot.running, true);
    renderSessionList();
    setFollow(true);
    updateJumpButton();
    scrollToBottom();
    focusComposer();
  }

  function applyBootstrap(payload) {
    const folderName = str(payload.folderName);
    state.folderName = folderName;
    state.folderPath = str(payload.folderPath);
    state.dataDir = str(payload.dataDir);
    state.multiRoot = !!payload.multiRoot;

    dom.folderName.textContent = folderName || 'repository';
    dom.folderName.title = state.folderPath || folderName;
    dom.btnSelectFolder.hidden = !(state.multiRoot || !folderName);

    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    state.settings.showReasoning = settings.showReasoning !== false;
    state.settings.animateChunks = !!settings.animateChunks;
    state.settings.model = str(settings.model);
    state.settings.provider = str(settings.provider);
    state.settings.reasoningEffort = str(settings.reasoningEffort);
    state.settings.resolvedRoute = str(payload.resolvedRoute);
    state.settings.permissionMode = str(settings.permissionMode);
    applySettingsDisplay();

    applyRuntime(payload.runtime || { state: 'idle', detail: '' });
    state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    renderSessionList();
    if (payload.session) applySession(payload.session);
  }

  function applyMutations(payload) {
    const sessionId = str(payload.sessionId);
    if (sessionId && state.activeSessionId && sessionId !== state.activeSessionId) return;
    const mutations = Array.isArray(payload.mutations) ? payload.mutations : [];
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      if (!mutation || typeof mutation !== 'object') continue;
      if (mutation.op === 'append' && mutation.item && mutation.item.id) appendItem(mutation.item);
      else if (mutation.op === 'update' && mutation.id) updateItem(str(mutation.id), mutation.patch);
      else if (mutation.op === 'remove' && mutation.id) removeItem(str(mutation.id));
    }
    updateEmptyState();
    maybeScroll();
  }

  function applyStatus(payload) {
    const sessionId = str(payload.sessionId);
    if (sessionId && state.activeSessionId && sessionId !== state.activeSessionId) return;
    setRunning(!!payload.running, !!payload.running);
  }

  function applyTitle(payload) {
    const id = str(payload.sessionId);
    const title = str(payload.title);
    if (!title) return;
    if (state.session && id && id === state.activeSessionId) {
      state.session.title = title;
      dom.sessionTitle.textContent = title;
      dom.sessionTitle.title = title;
      document.title = title + ' \u2014 DeepSeek Harness';
    }
    for (let i = 0; i < state.sessions.length; i++) {
      if (str(state.sessions[i].id) === id) state.sessions[i].title = title;
    }
    renderSessionList();
  }

  function applyContext(payload) {
    const detail = str(payload.detail);
    const label = str(payload.label);
    if (detail) {
      const current = dom.input.value;
      dom.input.value = current.trim() ? current.replace(/\s+$/, '') + '\n\n' + detail : detail;
    }
    if (label) {
      const exists = state.contextChips.some(function (chip) {
        return chip.label === label && chip.detail === detail;
      });
      if (!exists) state.contextChips.push({ label: label, detail: detail });
    }
    renderChips();
    autosize();
    updateSendState();
    focusComposer();
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    switch (message.type) {
      case 'bootstrap':
        applyBootstrap(payload);
        break;
      case 'session':
        applySession(payload.session);
        break;
      case 'mutations':
        applyMutations(payload);
        break;
      case 'status':
        applyStatus(payload);
        break;
      case 'sessions':
        state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        renderSessionList();
        break;
      case 'title':
        applyTitle(payload);
        break;
      case 'runtime':
        applyRuntime(payload);
        break;
      case 'context':
        applyContext(payload);
        break;
      case 'insertText':
        applyContext(payload);
        break;
      case 'notice':
        showToast(payload.level, payload.text);
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- actions */

  function copyText(text, button) {
    const done = function (ok) {
      if (!button) return;
      const original = button.textContent;
      button.textContent = ok ? 'Copied' : 'Copy failed';
      window.setTimeout(function () {
        button.textContent = original;
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(fallbackCopy(text));
        }
      );
      return;
    }
    done(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return !!ok;
    } catch (error) {
      return false;
    }
  }

  function itemFromTarget(target) {
    const node = target.closest('.item[data-id]');
    if (!node) return null;
    return state.items.get(str(node.getAttribute('data-id'))) || null;
  }

  function expandOutput(target) {
    const node = target.closest('.item[data-id]');
    const item = itemFromTarget(target);
    if (!node || !item) return;
    const body = node.querySelector('.tool-output-body');
    if (!body) return;
    body.textContent = str(item.output);
    body.classList.remove('clamped');
    body.classList.add('expanded');
    const foot = node.querySelector('.tool-output-foot');
    if (foot && foot.parentNode) foot.parentNode.removeChild(foot);
  }

  function removeContextChip(index) {
    const chip = state.contextChips[index];
    if (!chip) return;
    if (chip.detail) {
      const current = dom.input.value;
      const at = current.indexOf(chip.detail);
      if (at !== -1) {
        const before = current.slice(0, at).replace(/\s+$/, '');
        const after = current.slice(at + chip.detail.length).replace(/^\s+/, '');
        dom.input.value = before && after ? before + '\n\n' + after : before + after;
      }
    }
    state.contextChips.splice(index, 1);
    renderChips();
    autosize();
    updateSendState();
  }

  function onDocumentClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = str(target.getAttribute('data-action'));
    const path = str(target.getAttribute('data-path'));
    const id = str(target.getAttribute('data-id'));
    const index = Number(target.getAttribute('data-index'));

    switch (action) {
      case 'copy-code': {
        const block = target.closest('.code-block');
        const code = block ? block.querySelector('code') : null;
        if (code) copyText(code.textContent || '', target);
        break;
      }
      case 'expand-output':
        expandOutput(target);
        break;
      case 'select-model':
        post('selectModel');
        break;
      case 'open-file':
        if (path) post('openFile', { path: path });
        break;
      case 'open-diff':
        if (path) post('openDiff', { path: path });
        break;
      case 'session-open':
        if (id) {
          post('openSession', { id: id });
          togglePanel(false);
        }
        break;
      case 'session-delete':
        if (id) post('deleteSession', { id: id });
        break;
      case 'remove-chip':
        removeContextChip(index);
        break;
      case 'remove-image':
        if (index >= 0) {
          state.pendingImages.splice(index, 1);
          renderChips();
          updateSendState();
        }
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ init */

  function bindHeader() {
    dom.runtimeBadge.addEventListener('click', function () {
      post('showLogs');
    });
    dom.btnSessions.addEventListener('click', function () {
      togglePanel();
    });
    dom.btnCloseSessions.addEventListener('click', function () {
      togglePanel(false);
    });
    dom.btnNewSession.addEventListener('click', function () {
      post('newSession');
      togglePanel(false);
    });
    dom.btnRefreshSessions.addEventListener('click', function () {
      post('refreshSessions');
    });
    dom.btnWebUi.addEventListener('click', function () {
      post('openWebUi');
    });
    dom.btnRevealData.addEventListener('click', function () {
      post('revealDataDir');
    });
    dom.btnSelectFolder.addEventListener('click', function () {
      post('selectFolder');
    });
    dom.btnDiagnostics.addEventListener('click', function () {
      post('showLogs');
    });
    dom.btnRestartRuntime.addEventListener('click', function () {
      post('restartRuntime');
      showToast('info', 'Restarting the DSH runtime\u2026');
    });
  }

  function bindComposer() {
    dom.input.addEventListener('input', function () {
      autosize();
      updateSendState();
    });
    dom.input.addEventListener('keydown', onComposerKeydown);
    dom.input.addEventListener('paste', onComposerPaste);
    dom.btnSend.addEventListener('click', submit);
    dom.btnStop.addEventListener('click', function () {
      post('stop');
    });
    dom.btnAttach.addEventListener('click', function () {
      post('attachSelection');
    });
    dom.btnFiles.addEventListener('click', function () {
      post('pickFiles');
    });
    dom.toast.addEventListener('click', function () {
      dom.toast.hidden = true;
    });
  }

  function bindTranscript() {
    dom.transcript.addEventListener('scroll', onTranscriptScroll, { passive: true });
    dom.jumpLatest.addEventListener('click', function () {
      setFollow(true);
      scrollToBottom();
    });
  }

  function init() {
    dom = {
      app: byId('app'),
      header: byId('header'),
      folderName: byId('folder-name'),
      sessionTitle: byId('session-title'),
      runtimeBadge: byId('runtime-badge'),
      runtimeLabel: byId('runtime-label'),
      btnSessions: byId('btn-sessions'),
      btnNewSession: byId('btn-new-session'),
      btnWebUi: byId('btn-web-ui'),
      btnRevealData: byId('btn-reveal-data'),
      btnSelectFolder: byId('btn-select-folder'),
      metaLine: byId('meta-line'),
      modelLabel: byId('model-label'),
      permissionLabel: byId('permission-label'),
      sessionPanel: byId('session-panel'),
      sessionList: byId('session-list'),
      btnRefreshSessions: byId('btn-refresh-sessions'),
      btnCloseSessions: byId('btn-close-sessions'),
      btnDiagnostics: byId('btn-diagnostics'),
      btnRestartRuntime: byId('btn-restart-runtime'),
      transcript: byId('transcript'),
      emptyState: byId('empty-state'),
      working: byId('working'),
      workingElapsed: byId('working-elapsed'),
      jumpLatest: byId('jump-latest'),
      composer: byId('composer'),
      input: byId('composer-input'),
      btnSend: byId('btn-send'),
      btnStop: byId('btn-stop'),
      btnAttach: byId('btn-attach'),
      btnFiles: byId('btn-files'),
      contextChips: byId('context-chips'),
      usage: byId('usage'),
      toast: byId('toast')
    };

    bindHeader();
    bindComposer();
    bindTranscript();
    observeTranscriptSize();
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', autosize);

    applySettingsDisplay();
    applyRuntime({ state: 'idle', detail: '' });
    renderSessionList();
    renderChips();
    updateEmptyState();
    updateUsageDisplay();
    updateWorking();
    updateSendState();
    updateJumpButton();
    autosize();

    /* The listener above is installed before this fires, per the contract. */
    post('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
