# Friday

Clean up web newsletters with the [Readbility algorithm][readability] and email
them to yourself.

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
<!-- someday, bundle everything into 'friday.js' and then:
    If `node` is already in your [path][], just move `friday.js` to `~/bin/friday`
    (or `~/.local/bin/friday` or whatever) and run it like any other program on
    your system.
-->

### Flags

* `-b`, `--browse`: Open the parsed article in your default browser.
* `-s`, --send-email, `--send`, `--email`: Send the parsed article via email
  (requires SMTP config).
* `-e`, `--embed-images`, `--embed`: Download and embed images directly into
   the HTML as base64 data URIs.

## Authors

Gemini 3.5 Flash and Kevin Ernst.

## License

[WTFPL](https://www.wtfpl.net/about) Version 2 or any later version.

[readability]: https://github.com/mozilla/readability
[this one]: https://raw.githubusercontent.com/oxalorg/sakura/master/css/sakura.css
[sakura]: https://oxal.org/projects/sakura
[path]: https://en.wikipedia.org/wiki/PATH_(variable)
