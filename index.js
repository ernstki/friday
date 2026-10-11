#!/usr/bin/env node
//
// Assisted-by: aider 0.86.2 + gemini/gemini-3.1-pro-preview
//
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';

import { Readability } from '@mozilla/readability';
import jsdom from 'jsdom';
const { JSDOM } = jsdom;
import DOMPurify from 'dompurify';
import beautify from 'js-beautify';
import nodemailer from 'nodemailer';

//const url = "https://static.nytimes.com/email-content/NE_sample.html";
const CACHE_DIR = join(homedir(), '.cache', 'readable-newsletters');
const CONFIG_FILE = join(homedir(), '.config', 'readable-newsletters.json');
const CACHE_TIMEOUT = 604800000;  // 7 days
// https://oxal.org/projects/sakura
const DEFAULT_CSS = 'https://raw.githubusercontent.com/oxalorg/sakura/1eab9fd871abc74ec74d1a6f18ee56148f5a4b8f/css/sakura.css';

async function main() {
  const config = await loadConfig();

  const { values, positionals } = parseArgs({          
    options: {             
      browse: { type: 'boolean', short: 'b', default: config.browse || false },
      email: { type: 'boolean', short: 'e', default: false },
      'embed-images': { type: 'boolean', short: 'i', default: config.embedImages || false }
    },                     
    allowPositionals: true
  });                      

  const url = positionals[0];
  if (!url) {
    console.error("ERROR: Expected (at least) a URL.");
    process.exit(1);
  }

  const rawHtml = await getCachedFile(url);
  const dom = new JSDOM(rawHtml, { url });
  const { document } = dom.window;
  const article = new Readability(document).parse();

  if (!article?.content) {
    console.error("ERROR: Article had no content after parsing.");
    process.exit(1);
  }

  let content = article.content;

  if (values['embed-images']) {
    content = await embedImagesAsDataUris(content, url);
  }

  const purify = DOMPurify(dom.window);
  const purified = purify.sanitize(content);
  
  let css;
  if (config.cssPath) {
    css = await readFile(config.cssPath, 'utf-8');
  } else {
    const cssUrl = config.cssUrl || DEFAULT_CSS;
    const cssBuffer = await getCachedFile(cssUrl);
    css = cssBuffer.toString('utf-8');
  }

  // 3. Wrap the purified content in a full HTML document with the CSS and CSP injected
  const fullHtml = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:;">
    <title>${article.title || 'Article'}</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="readability-content">
      ${article.title ? `<h1>${article.title}</h1>` : ''}
      ${purified}
    </div>
  </body>
</html>`;

  const beautified = beautify.html(fullHtml, { indent_size: 2 });

  if (values.email) {
    if (!config.smtp || !config.email || !config.email.to || !config.email.from) {
      console.error("ERROR: Missing 'smtp' or 'email' configuration in config file.");
      process.exit(1);
    }

    const transporter = nodemailer.createTransport(config.smtp);
    const mailOptions = {
      from: config.email.from,
      to: config.email.to,
      subject: article.title || 'Readable Newsletter',
      html: beautified
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('Email sent successfully: ' + info.response);
    } catch (error) {
      console.error('Error sending email:', error);
      process.exit(1);
    }
  } else if (values.browse) {
    //const proc = spawn('bat', ["-l", "html"],
    const proc = spawn('browser', [],
                       { stdio: ['pipe', 'inherit', 'inherit'] });
    proc.stdin.end(beautified);
  } else {
    console.log(beautified);
  }
}

async function embedImagesAsDataUris(html, baseUrl) {
  const dom = new JSDOM(html);
  const images = dom.window.document.querySelectorAll('img');
  
  for (const img of images) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;

    try {
      const imgUrl = new URL(src, baseUrl).href;
      const buffer = await getCachedFile(imgUrl);
      
      const ext = extname(new URL(imgUrl).pathname).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.svg') mimeType = 'image/svg+xml';

      const base64 = buffer.toString('base64');
      img.setAttribute('src', `data:${mimeType};base64,${base64}`);
      img.removeAttribute('srcset'); // Remove srcset to force use of the data URI
    } catch (err) {
      console.warn(`Warning: Failed to embed image ${src}:`, err.message);
    }
  }
  
  return dom.window.document.body.innerHTML;
}

async function loadConfig() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    console.warn(`Failed to read config file at ${CONFIG_FILE}:`, err.message);
    return {};
  }
}

async function getCachedFile(url, ttlMs = CACHE_TIMEOUT) {
  const hash = createHash('sha256').update(url).digest('hex')
  const parsedUrl = new URL(url);
  const ext = extname(parsedUrl.pathname);
  const filePath = join(CACHE_DIR, hash + ext);

  try {
    const fileStat = await stat(filePath);
    if (Date.now() - fileStat.mtimeMs < ttlMs) {
      return readFile(filePath);
    }
  } catch {}

  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(filePath, buffer);
  return buffer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
