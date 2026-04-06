# Plugin System

## API

A plugin is a function that takes options and returns an object with optional hooks:

```js
module.exports = function myPlugin(opts) {
  // shared state lives here in the closure
  return {
    beforeBuild({ config }),
    transformPage({ pagePath, frontmatter, markdown, document }),
    afterBuild({ outputDir, fs }),
  }
}
```

### Hooks

**`beforeBuild({ config })`** — Called once before the build starts. Access to site config.

**`transformPage({ pagePath, frontmatter, markdown, document })`** — Called for each `.md` page after markdown is rendered and injected into the template DOM. The `document` is a full JSDOM document — plugins can modify any part of the HTML (head, body, attributes, etc.).

**`afterBuild({ outputDir, fs })`** — Called once after all pages are written. Can write additional files (RSS feeds, search indexes, sitemaps) to the output directory.

### State

Plugins use closures for cross-hook state. No special API needed:

```js
module.exports = function rssPlugin(opts) {
  const pages = []  // accumulates across transformPage calls

  return {
    transformPage({ frontmatter }) {
      pages.push({ title: frontmatter.title, date: frontmatter.date })
    },
    afterBuild({ outputDir, fs }) {
      // pages array is full here
      fs.writeFileSync(`${outputDir}/feed.xml`, buildFeed(pages))
    },
  }
}
```

### Registration

Plugins are registered in `teeny.config.js`:

```js
module.exports = {
  plugins: [
    require('./plugins/search')({ maxResults: 5 }),
    require('./plugins/rss')({ siteUrl: 'https://example.com', title: 'My Blog' }),
  ],
}
```

Plugins run in registration order.

## Core implementation

Minimal changes to `cli.js`:

1. Load `teeny.config.js` if it exists (with fallback to `{}`)
2. In `build()`, call `beforeBuild` on each plugin before processing
3. In `processPage()`, call `transformPage` on each plugin after markdown injection but before writing the HTML
4. In `build()`, call `afterBuild` on each plugin after all pages are processed

Estimated ~15-20 lines of new code in the core.

## Design decisions

- **Plugins modify the DOM, not raw HTML strings** — safer, composable, multiple plugins don't conflict
- **No special file injection API** — plugins either inline styles/scripts into the DOM during `transformPage`, or write files during `afterBuild` and let the user add `<link>`/`<script>` tags to their templates
- **No plugin-to-plugin communication** — keeps things simple, plugins are independent
