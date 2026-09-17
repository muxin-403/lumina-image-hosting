'use strict';

/**
 * 极简 Markdown -> HTML 渲染器（仅用于把 docs/API.md 渲染成可浏览页面）
 * ------------------------------------------------------------------
 * 支持：标题 / 有序无序列表 / 表格 / 围栏代码块 / 行内代码 / 粗体 /
 *       链接 / 引用 / 分隔线 / 段落。
 * 目标不是完整实现 CommonMark，而是「单一文档源」：文档只维护一份
 * Markdown，站点直接渲染，避免 HTML 与 MD 两份内容漂移。
 * 所有文本都经过 HTML 转义后再拼接，因此没有 XSS 风险。
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内元素：先转义，再替换 Markdown 语法 */
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label, href) =>
      `<a href="${href.replace(/"/g, '%22')}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`,
  );
  return out;
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/**
 * @param {string} md Markdown 源文本
 * @returns {string} HTML 片段
 */
function render(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, '').trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      out.push(
        `<pre class="code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = slug(text);
      if (level === 2) toc.push({ id, text });
      out.push(`<h${level} id="${id}">${inline(text)}<a class="anchor" href="#${id}">#</a></h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${header
          .map((c) => `<th>${inline(c)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        i += 1;
        // 处理列表项的续行（缩进 2 空格以上）
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          text += ` ${lines[i].trim()}`;
          i += 1;
        }
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // 段落（连续非空行合并）
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*(#{1,6}\s|```|\||>|\s*([-*+]|\d+\.)\s)/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc };
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

module.exports = { render, escapeHtml };
