#!/usr/local/modules/nodejs/22.23.2/bin/node
//
// Assisted-by: aider 0.86.2 + gemini/gemini-3.1-pro-preview
//
import { join } from 'node:path';
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

//const url = "https://static.nytimes.com/email-content/NE_sample.html";
const CACHE_DIR = join(homedir(), '.cache', 'readable-newsletters');
const CACHE_TIMEOUT = 604800000;  // 7 days
const ARC90_READABILITY_CSS = 'https://raw.githubusercontent.com/masukomi/arc90-readability/refs/heads/master/css/readability.css';

async function main() {
	const { values, positionals } = parseArgs({          
		options: {             
			browse: { type: 'boolean', short: 'b', default: false }
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

  // get the Arc90 original CSS and inject it
  //const css = await getCachedFile(ARC90_READABILITY_CSS);
  //const style = document.createElement('style');
  //style.textContent = css;

	const purify = DOMPurify(dom.window);
	const purified = purify.sanitize(article.content);
	const beautified = beautify.html(purified, { indent_size: 2 });

	if (values.browse) {
		//const proc = spawn('bat', ["-l", "html"],
		const proc = spawn('browser', [],
                       { stdio: ['pipe', 'inherit', 'inherit'] });
		proc.stdin.end(beautified);
	} else {
		process.stdout.write(beautified);
	}
}

//async function openBrowser

async function getCachedFile(url, ttlMs = CACHE_TIMEOUT) {
	const hash = createHash('sha256').update(url).digest('hex')
	const filePath = join(CACHE_DIR, hash);

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
