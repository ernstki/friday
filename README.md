# Friday

Clean up web newsletters with the [Readbility algorithm][readability] and email
them to yourself.

Requires **Node.js ≥ 14**, because some dependencies use null-coalescing
operators. Tested with Node.js 22.

## Initial Setup

```bash
mkdir -p ~/.config/friday
cp sample-config.json ~/.config/friday/config.json
```

Now, edit `config.json` in your favorite editor to customize it and/or add SMTP
authentication credentials.

If a `~/.config/friday/style.css` is found, that will be used, with a fallback
to `style.css` in the current working directory. You can also specify a URL to
a CSS file, _e.g._ [this one][] for [Sakura][], which will be downloaded and
cached locally.

## Usage

Run the script by passing a URL; for example:

```bash
    node friday.js https://static.nytimes.com/email-content/NE_sample.html
```

Or, if `node` is in your [path][], this will work, too:

```bash
./friday.js https://static.nytimes.com/email-content/NE_sample.html
```

You can also specify a list of URLs in your `config.json` (using the `"urls"`
array) to process them in batch if no URL is provided on the command line.

For newsletters that don't have a stable URL (_e.g._, a "latest" page that
embeds the actual newsletter), you can provide an object with a CSS selector to
extract the real URL; for example:

```json
"urls": [
  {
    "url": "https://changelog.com/news",
    "selector": "#newsletter_iframe",
    "attribute": "src"
  }
]
```

<!-- someday, bundle everything into 'friday.js' and then:
    If `node` is already in your [path][], just move `friday.js` to `~/bin/friday`
    (or `~/.local/bin/friday` or whatever) and run it like any other program on
    your system.
-->

### Flags

* `-b`, `--browse`: Open the parsed article in your default browser.
* `-w`, `--wait`: When using `--browse`, keep the local server running until a key is pressed (useful for viewing source or refreshing).
* `-s`, --send-email, `--send`, `--email`: Send the parsed article via email
  (requires SMTP config).
* `-e`, `--embed-images`, `--embed`: Download and embed images directly into
   the HTML as base64 data URIs.
* `-c`, `--clean-urls`: Remove tracking parameters from URLs using ClearURLs rules.
* `-v`, `--verbose`: Enable verbose logging (e.g., show cleaned URLs).

## Security

The resulting HTML newsletters are prevented from running JavaScript in two ways:

1. **DOMPurify:** By default, `DOMPurify` automatically strips out all
   `<script>` tags, `javascript:` URIs, and inline event handlers (like
   `onclick="..."`).
2. **Content-Security-Policy (CSP):** A strict CSP meta tag is injected into
   the `<head>` of the generated HTML (`default-src 'none'`). Because there is
   no `script-src` defined, the browser will strictly refuse to execute any
   JavaScript, even if a script tag somehow bypassed the sanitizer.

## Authors

Gemini 3.5 Flash and Kevin Ernst.

## License

[WTFPL](https://www.wtfpl.net/about) Version 2 or any later version.

[readability]: https://github.com/mozilla/readability
[this one]: https://raw.githubusercontent.com/oxalorg/sakura/master/css/sakura.css
[sakura]: https://oxal.org/projects/sakura
[path]: https://en.wikipedia.org/wiki/PATH_(variable)
