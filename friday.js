#!/usr/bin/env node
//
// Assisted-by: aider 0.86.2 + gemini/gemini-3.1-pro-preview
//
import { join, extname, isAbsolute } from 'node:path';
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
const CONFIG_DIR = join(homedir(), '.config', 'friday');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CACHE_TIMEOUT = 604800000;  // 7 days
const MAX_IMAGE_DIMENSION = 500;
const DEFAULT_CSS = 'style.css';

function printHelp() {
  console.log(`Usage: friday [options] [url...]

Clean up web newsletters with the Readability algorithm and email them to yourself.
If no URLs are provided on the command line, it will look for a "urls" array in config.json.

Options:
  -b, --browse          Open the parsed article in your default browser.
  -w, --wait            When using --browse, keep the local server running until a key is pressed.
  -s, --send-email      Send the parsed article via email (requires SMTP config).
                        (Aliases: --send, --email)
  -e, --embed-images    Download and embed images directly into the HTML as base64 data URIs.
                        (Alias: --embed)
  -h, --help            Show this help message and exit.`);
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
      wait: { type: 'boolean', short: 'w', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  let urls = positionals;
  if (urls.length === 0 && config.urls && Array.isArray(config.urls) && config.urls.length > 0) {
    urls = config.urls;
  }

  if (urls.length === 0) {
    console.error("ERROR: Expected (at least) a URL.");
    console.error("Run 'friday --help' for usage information.");
    process.exit(1);
  }

  for (const item of urls) {
    const targetUrl = await resolveTargetUrl(item);
    if (targetUrl) {
      await processArticle(targetUrl, config, values);
    }
  }
}

async function resolveTargetUrl(item) {
  if (typeof item === 'string') {
    return item;
  }

  if (typeof item === 'object' && item.url && item.selector) {
    console.log(`Fetching wrapper page: ${item.url}`);
    try {
      const rawHtml = await getCachedFile(item.url);
      const dom = new JSDOM(rawHtml, { url: item.url });
      const element = dom.window.document.querySelector(item.selector);

      if (element) {
        const attr = item.attribute || (element.tagName === 'A' ? 'href' : 'src');
        const extractedPath = element.getAttribute(attr);

        if (extractedPath) {
          const targetUrl = new URL(extractedPath, item.url).href;
          console.log(`Extracted actual URL: ${targetUrl}`);
          return targetUrl;
        } else {
          console.error(`ERROR: Attribute '${attr}' not found on element matching '${item.selector}'`);
          return null;
        }
      } else {
        console.error(`ERROR: Selector '${item.selector}' not found on ${item.url}`);
        return null;
      }
    } catch (err) {
      console.error(`ERROR processing wrapper ${item.url}:`, err.message);
      return null;
    }
  }

  console.error(`ERROR: Invalid URL item format: ${JSON.stringify(item)}`);
  return null;
}

async function processArticle(url, config, values) {
  const shouldSendEmail = values['send-email'] || values.send || values.email;
  const shouldEmbed = values['embed-images'] || values.embed;

  console.log(`Processing: ${url}`);
  const rawHtml = await getCachedFile(url);
  const dom = new JSDOM(rawHtml, { url });
  const { document } = dom.window;
  const article = new Readability(document).parse();

  if (!article?.content) {
    console.error(`ERROR: Article had no content after parsing: ${url}`);
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
    const cssBuffer = await getCachedFile(cssSource);
    css = cssBuffer.toString('utf-8');
  } else if (isAbsolute(cssSource)) {
    css = await readFile(cssSource, 'utf-8');
  } else {
    try {
      css = await readFile(join(CONFIG_DIR, cssSource), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        css = await readFile(join(process.cwd(), cssSource), 'utf-8');
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
      console.error("ERROR: Missing 'smtp' or 'email' configuration in config file.");
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
      console.log('Email sent successfully: ' + info.response);
    } catch (error) {
      console.error(`ERROR: Failed to send email (${error})`);
    }
  } else if (values.browse) {
    await openInBrowser(beautified, values.wait);
  } else {
    console.log(beautified);
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
          console.error(`ERROR: Failed to open browser (${error.message})`);
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
