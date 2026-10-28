import { readFile, writeFile } from 'node:fs/promises';
import { ACTIONS } from '../dist/runtime.js';

await writeFile(new URL('./actions.json', import.meta.url), JSON.stringify({ version: 1, actions: ACTIONS }, null, 2) + '\n');

const chapters = [
  ['architecture', '架构'], ['configuration', '配置与运行'], ['api', '动作与事件'],
  ['extensions', '抖音扩展与媒体'],
  ['astrbot', 'AstrBot 接口手册'],
  ['transports', '传输、SDK 与 MCP'], ['development', '扩展与测试'], ['security', '安全与运维'],
];
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(value) {
  const codes = [];
  const protectedText = value.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(`<code>${escape(code)}</code>`) - 1}\u0000`);
  return escape(protectedText)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
      const local = /^(?:docs\/)?([a-z-]+)\.md$/.exec(target);
      const href = local ? `#${local[1]}` : target;
      return /^(https?:\/\/|#[a-z-]+)/.test(href) ? `<a href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index++;
      out.push(`<div class="codeblock"><span class="language">${escape(language || 'text')}</span><pre><code>${escape(code.join('\n'))}</code></pre></div>`);
      continue;
    }
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index++; continue; }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1] || '')) {
      const cells = value => value.trim().slice(1, -1).split('|').map(cell => cell.trim());
      const heads = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(cells(lines[index++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${heads.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(?:- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items = [];
      while (index < lines.length && /^(?:- |\d+\. )/.test(lines[index])) items.push(lines[index++].replace(/^(?:- |\d+\. )/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !/^(?:#|```|\||- |\d+\. )/.test(lines[index])) paragraph.push(lines[index++]);
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

const sections = await Promise.all(chapters.map(async ([id, title]) => `<section id="${id}"><div class="chapter-label">DYTRANOB DOCUMENTATION / ${escape(id.toUpperCase())}</div>${render(await readFile(new URL(`${id}.md`, import.meta.url), 'utf8'))}</section>`));
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>DyTranOb · 开发文档</title><style>
:root{color-scheme:light;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#35433c;background:#f8faf8;font-size:14px;line-height:1.9}*{box-sizing:border-box}body{margin:0}a{color:#327152;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible{outline:3px solid #94bca2;outline-offset:4px}.sidebar{position:fixed;inset:0 auto 0 0;width:250px;background:#fff;border-right:1px solid #e7ede8;padding:35px 26px;display:flex;flex-direction:column}.brand{font-size:25px;color:#254b33;font-weight:700;letter-spacing:-1px}.brand small{display:block;font-size:9px;letter-spacing:2px;font-weight:400;color:#91a296;margin-top:3px}.sidebar nav{margin-top:35px;display:grid;gap:8px}.sidebar nav a{font-size:12px;padding:9px 12px;border-radius:6px;color:#748679}.sidebar nav a:hover{background:#f0f6f1;text-decoration:none;color:#3b7250}.back{margin-top:auto;font-size:11px;color:#93a399}main{margin-left:250px;max-width:1250px;padding:48px 60px 70px}header{border-bottom:1px solid #e4ebe5;padding-bottom:30px;margin-bottom:40px}.version{font:10px Consolas,monospace;padding:3px 7px;background:#eef5ef;border:1px solid #dde9df;border-radius:4px;color:#7a9b83}.intro{font-size:28px;font-weight:600;letter-spacing:.3px;margin:12px 0 8px}header p{font-size:12px;color:#8a9d8f;max-width:600px}section{padding-top:15px;margin-bottom:65px;scroll-margin-top:25px}.chapter-label{font:8px Consolas,monospace;letter-spacing:1.8px;color:#9aada0}h1{font-size:25px;font-weight:600;line-height:1.5;margin:9px 0 20px;color:#2a4d35}h2{font-size:17px;font-weight:600;margin:35px 0 12px;padding-bottom:8px;border-bottom:1px solid #e7ede8;color:#42614b}h3{font-size:14px;margin:25px 0 10px}p{font-size:12px;color:#74857a;margin:12px 0}strong{color:#526c59;font-weight:600}li{font-size:12px;color:#798b7f;margin:7px 0}ul,ol{padding-left:22px}code{font:10px/1.8 Consolas,'Courier New',monospace;background:#edf3ee;color:#5a7c63;padding:2px 5px;border-radius:3px}pre code{font-size:11px;line-height:1.9;background:none;padding:0;white-space:pre}pre{margin:0;overflow:auto;padding:20px 22px;tab-size:2}.codeblock{background:#f1f6f2;border:1px solid #e2ece4;border-radius:8px;margin:18px 0;position:relative;overflow:hidden}.language{display:block;text-align:right;padding:7px 12px 0;color:#a0b2a5;font:8px Consolas,monospace;letter-spacing:.7px}.codeblock pre{padding-top:9px}.table-wrap{overflow:auto;border:1px solid #e1e9e3;border-radius:8px;margin:18px 0;background:#fff}table{border-collapse:collapse;min-width:100%;font-size:11px}th{text-align:left;background:#f2f7f3;color:#647f6c;font-weight:600}td,th{padding:11px 13px;border-bottom:1px solid #eaf0eb;vertical-align:top}td{color:#84968a}td code{font-size:9px}tr:last-child td{border-bottom:0}footer{font-size:10px;color:#9eb0a3;border-top:1px solid #e3ebe5;padding-top:20px}.notice{padding:15px 18px;background:#f0f6f1;border:1px solid #dceade;border-radius:8px;font-size:11px;color:#799581}.source-links{margin-top:15px;font-size:10px}.source-links a{margin-right:14px}@media(max-width:1000px){.sidebar{width:215px;padding:30px 22px}main{margin-left:215px;padding:35px}}@media(max-width:700px){.sidebar{position:static;width:100%;padding:22px;border-right:0;border-bottom:1px solid #e4ece6}.brand{font-size:22px}.sidebar nav{display:flex;flex-wrap:wrap;gap:4px;margin-top:18px}.sidebar nav a{font-size:10px;padding:5px 8px}.back{margin-top:15px;font-size:10px}main{margin-left:0;padding:28px 20px}.intro{font-size:24px}h1{font-size:22px}h2{font-size:16px}.chapter-label{font-size:7px}section{margin-bottom:45px}table{min-width:650px}pre{padding:15px}pre code{font-size:10px}}@media print{.sidebar{display:none}main{margin:0;padding:0;max-width:none}.table-wrap{overflow:visible}table{min-width:0}.codeblock{break-inside:avoid}a{color:inherit}}
</style></head><body><aside class="sidebar"><a class="brand" href="/">DyTranOb<small>DEVELOPER DOCUMENTATION</small></a><nav aria-label="文档章节">${chapters.map(([id, title], index) => `<a href="#${id}">${String(index + 1).padStart(2, '0')}　${title}</a>`).join('')}</nav><a class="back" href="/">← 返回运行时控制台</a></aside><main><header><span class="version">v0.1.0 · ONEBOT V11</span><div class="intro">开发文档</div><p>从原生会话到统一动作与事件。了解运行时架构、账号配置、协议边界与各入口的接入方式。</p><div class="notice">首版实现：自动化测试与离线演示使用 Mock / SDK 替身；尚未使用真实抖音账号完成端到端验收。项目不包含插件系统。</div><div class="source-links"><a href="https://github.com/zhinjs/douyin-im" target="_blank" rel="noopener noreferrer">douyin-im ↗</a><a href="https://github.com/botuniverse/onebot-11" target="_blank" rel="noopener noreferrer">OneBot v11 ↗</a><a href="https://github.com/modelcontextprotocol/typescript-sdk" target="_blank" rel="noopener noreferrer">MCP SDK ↗</a></div></header>${sections.join('\n')}<footer>DyTranOb 0.1.0 · 本页面由 docs/*.md 生成。运行 node docs/build.mjs 更新。</footer></main></body></html>`;
await writeFile(new URL('readme.html', import.meta.url), html, 'utf8');
console.error(`Built docs/readme.html (${chapters.length} chapters).`);
