#!/usr/bin/env node
//
//  friday.js - email cleaned web newsletters to yourself
//
//  Homepage:     https://github.com/ernstki/friday
//  License:      WTFPL Version 2 (or later)
//  Assisted-by:  aider 0.86.2 + gemini/gemini-3.1-pro-preview
//
import { join, extname, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, exec } from 'node:child_process';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

import { Readability } from '@mozilla/readability';
import jsdom from 'jsdom';
const { JSDOM } = jsdom;
import DOMPurify from 'dompurify';
import beautify from 'js-beautify';
import nodemailer from 'nodemailer';
import sharp from 'sharp';

const CACHE_DIR = join(homedir(), '.cache', 'friday');
const CONFIG_DIR = join(homedir(), '.config', 'friday'); const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CACHE_TIMEOUT = 604800000;  // 7 days
const MAX_IMAGE_DIMENSION = 500;
const DEFAULT_CSS = 'style.css';

let isVerbose = false;

function logStatus(msg) {
  if (!process.stdout.isTTY) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  } else {
    console.log(msg);
  }
}

function logInfo(msg) {
  if (!isVerbose) return;
  if (!process.stdout.isTTY) {
    console.info(`[${new Date().toISOString()}] INFO: ${msg}`);
  } else {
    console.info(`INFO: ${msg}`);
  }
}

function logError(msg) {
  if (!process.stderr.isTTY) {
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
  } else {
    console.error(`ERROR: ${msg}`);
  }
}

function logWarning(msg) {
  if (!process.stderr.isTTY) {
    console.warn(`[${new Date().toISOString()}] WARNING: ${msg}`);
  } else {
    console.warn(`WARNING: ${msg}`);
  }
}

function printHelp() {
  console.log(`Usage: friday [options] [URL...]

Clean up web newsletters with the Readability algorithm and email them to
yourself.

Options:
  URL...              One or more URLs, if not specified in 'config.json'
  -h, --help          Show this help message and exit
  -b, --browse        Open the parsed article in your default browser
  -w, --wait          When using --browse, keep the local server running
                      until a key is pressed
  -s, --send-email    Send the parsed article via email; requires SMTP
                      config (aliases: --send, --email)
  -e, --embed-images  Download and embed images directly into the HTML as
                      base64 data URIs (alias: --embed)
  -c, --clean-urls    Remove tracking parameters from URLs using ClearURLs
                      rules (alias: --clean)
  -v, --verbose       Enable verbose logging (e.g., show cleaned URLs)`);
}

async function resolveTargetUrl(item) {
  if (typeof item === 'string') {
    return item;
  }

  if (typeof item === 'object' && item.url && item.selector) {
    logStatus(`Fetching wrapper page: ${item.url}`);
    try {
      const rawHtml = await getCachedFile(item.url);
      const dom = new JSDOM(rawHtml, { url: item.url });
      const element = dom.window.document.querySelector(item.selector);

      if (element) {
        const attr = item.attribute || (element.tagName === 'A' ? 'href' : 'src');
        const extractedPath = element.getAttribute(attr);

        if (extractedPath) {
          const targetUrl = new URL(extractedPath, item.url).href;
          logStatus(`Extracted actual URL: ${targetUrl}`);
          return targetUrl;
        } else {
          logError(`Attribute '${attr}' not found on element matching '${item.selector}'`);
          return null;
        }
      } else {
        logError(`Selector '${item.selector}' not found on ${item.url}`);
        return null;
      }
    } catch (err) {
      logError(`Processing wrapper ${item.url}: ${err.message}`);
      return null;
    }
  }

  logError(`Invalid URL item format: ${JSON.stringify(item)}`);
  return null;
}

async function processArticle(url, config, values) {
  const shouldSendEmail = values['send-email'] || values.send || values.email;
  const shouldEmbed = values['embed-images'] || values.embed;
  const shouldClean = values['clean-urls'] || values.clean;

  logStatus(`Processing: ${url}`);

  let rawHtml;
  try {
    rawHtml = await getCachedFile(url);
  } catch (err) {
    logError(`Failed to fetch article after retries: ${url} (${err.message})`);
    return;
  }

  const dom = new JSDOM(rawHtml, { url });

  if (shouldClean) {
    await cleanUrls(dom);
  }

  const { document } = dom.window;
  const article = new Readability(document).parse();

  if (!article?.content) {
    logError(`Article had no content after parsing: ${url}`);
    return;
  }

  let content = article.content;

  if (shouldEmbed) {
    const maxDim = config.maxImageDimension || MAX_IMAGE_DIMENSION;
    content = await embedImagesAsDataUris(content, url, maxDim);
  }

  const purify = DOMPurify(dom.window);
  const purified = purify.sanitize(content);

  let css;
  const cssSource = config.css || DEFAULT_CSS;
  if (cssSource.startsWith('http://') || cssSource.startsWith('https://')) {
    try {
      const cssBuffer = await getCachedFile(cssSource);
      css = cssBuffer.toString('utf-8');
    } catch (err) {
      logWarning(`Failed to fetch CSS from ${cssSource}, falling back to empty styles.`);
      css = '';
    }
  } else if (isAbsolute(cssSource)) {
    css = await readFile(cssSource, 'utf-8');
  } else {
    try {
      css = await readFile(join(CONFIG_DIR, cssSource), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          css = await readFile(join(process.cwd(), cssSource), 'utf-8');
        } catch (err2) {
          if (err2.code === 'ENOENT') {
            const scriptDir = dirname(fileURLToPath(import.meta.url));
            css = await readFile(join(scriptDir, cssSource), 'utf-8');
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
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
      ${article.title ? `<a href="${url}"><h1>${article.title}</h1></a>` : ''}
      ${purified}
    </div>
  </body>
</html>`;

  const beautified = beautify.html(fullHtml, { indent_size: 2 });

  if (shouldSendEmail) {
    if (!config.smtp || !config.email || !config.email.to || !config.email.from) {
      logError("Missing 'smtp' or 'email' configuration in config file.");
      process.exit(1);
    }

    const transporter = nodemailer.createTransport(config.smtp);
    const mailOptions = {
      from: config.email.from,
      to: config.email.to,
      subject: article.title || 'Friday Newsletter',
      html: beautified
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      logStatus(`Email sent successfully: "${article.title || url}" to ${obfuscateEmail(config.email.to)} (${info.response})`);
    } catch (error) {
      logError(`Failed to send email for "${url}" (${error.message})`);
    }
  } else if (values.browse) {
    await openInBrowser(beautified, values.wait);
  } else {
    console.log(beautified);
  }
}

function obfuscateEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  const first = local.slice(0, 2);
  const last = local.slice(-2);
  return `${first}***${last}@${domain}`;
}

async function cleanUrls(dom) {
  const rulesUrl = 'https://rules1.clearurls.xyz/data.minify.json';
  let rulesData;
  try {
    const buffer = await getCachedFile(rulesUrl);
    rulesData = JSON.parse(buffer.toString('utf-8'));
  } catch (err) {
    logWarning(`Failed to load ClearURLs rules: ${err.message}`);
    return;
  }

  const elements = dom.window.document.querySelectorAll('a[href], img[src], iframe[src]');
  for (const el of elements) {
    const attr = el.hasAttribute('href') ? 'href' : 'src';
    let urlString = el.getAttribute(attr);
    if (!urlString || urlString.startsWith('data:') || urlString.startsWith('#')) continue;

    try {
      let url = new URL(urlString, dom.window.location.href);
      let urlStr = url.href;
      const originalUrl = urlStr;
      let changed = false;

      for (const provider of Object.values(rulesData.providers)) {
        if (!new RegExp(provider.urlPattern, 'i').test(urlStr)) continue;

        const isException = (provider.exceptions || []).some(exc => new RegExp(exc, 'i').test(urlStr));
        if (isException) continue;

        for (const red of (provider.redirections || [])) {
          const match = urlStr.match(new RegExp(red, 'i'));
          if (match && match[1]) {
            urlStr = decodeURIComponent(match[1]);
            url = new URL(urlStr);
            changed = true;
          }
        }

        if (provider.rules && provider.rules.length > 0) {
          const params = Array.from(url.searchParams.keys());
          for (const param of params) {
            if (provider.rules.some(rule => new RegExp(`^${rule}$`, 'i').test(param))) {
              url.searchParams.delete(param);
              changed = true;
            }
          }
        }

        for (const rawRule of (provider.rawRules || [])) {
          const newHref = url.href.replace(new RegExp(rawRule, 'ig'), '');
          if (newHref !== url.href) {
            url = new URL(newHref);
            changed = true;
          }
        }

        if (changed) {
          urlStr = url.href;
        }
      }

      if (changed) {
        el.setAttribute(attr, url.href);
        logInfo(`Cleaned URL: ${originalUrl} -> ${url.href}`);
      }
    } catch (e) { /* ignore invalid URLs */ }
  }
}

async function openInBrowser(htmlContent, wait = false) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);

      if (!wait) {
        server.close();
        resolve();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;

      let command;
      switch (process.platform) {
        case 'darwin': command = `open "${url}"`; break;
        case 'win32':  command = `start "" "${url}"`; break;
        default:       command = `xdg-open "${url}"`; break;
      }

      exec(command, (error) => {
        if (error) {
          logError(`Failed to open browser (${error.message})`);
          server.close();
          resolve();
        }
      });

      if (wait) {
        console.log(`Serving on ${url}`);
        console.log('Press any key to continue...');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.once('data', () => {
          server.close();
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.pause();
          resolve();
        });
      }
    });
  });
}

async function embedImagesAsDataUris(html, baseUrl, maxDimension) {
  const dom = new JSDOM(html);
  const images = dom.window.document.querySelectorAll('img');

  for (const img of images) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;

    try {
      const imgUrl = new URL(src, baseUrl).href;
      const buffer = await getCachedFile(imgUrl);

      const resizedBuffer = await sharp(buffer)
        .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
        .toBuffer();

      const ext = extname(new URL(imgUrl).pathname).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.svg') mimeType = 'image/svg+xml';

      const base64 = resizedBuffer.toString('base64');
      img.setAttribute('src', `data:${mimeType};base64,${base64}`);
      img.removeAttribute('srcset'); // Remove srcset to force use of the data URI
    } catch (err) {
      logWarning(`Failed to embed image ${src}: ${err.message}`);
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
    logWarning(`Failed to read config file at ${CONFIG_FILE}: ${err.message}`);
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

  let res;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      break; // Success, exit the retry loop
    } catch (err) {
      if (attempt === maxRetries) {
        throw err; // Max retries reached, throw the error
      }
      const delay = 1000 * (2 ** attempt); // 1s, 2s, 4s
      logWarning(`Fetch failed for ${url} (${err.message}). Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(filePath, buffer);
  return buffer;
}

async function main() {
  const config = await loadConfig();

  const { values, positionals } = parseArgs({
    options: {
      browse: { type: 'boolean', short: 'b', default: config.browse || false },
      'send-email': { type: 'boolean', short: 's', default: false },
      send: { type: 'boolean', default: false },
      email: { type: 'boolean', default: false },
      'embed-images': { type: 'boolean', short: 'e', default: config.embedImages || false },
      embed: { type: 'boolean', default: false },
      'clean-urls': { type: 'boolean', short: 'c', default: config.cleanUrls || false },
      clean: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: config.verbose || false },
      wait: { type: 'boolean', short: 'w', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  isVerbose = values.verbose;

  let urls = positionals;
  if (urls.length === 0 && config.urls && Array.isArray(config.urls) && config.urls.length > 0) {
    urls = config.urls;
  }

  if (urls.length === 0) {
    logError("Expected (at least) a URL.\nRun 'friday --help' for usage information.");
    process.exit(1);
  }

  for (const item of urls) {
    const targetUrl = await resolveTargetUrl(item);
    if (targetUrl) {
      await processArticle(targetUrl, config, values);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
