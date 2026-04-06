module.exports = function rssPlugin(config = {}) {
    const {
        siteUrl = '',
        title = 'RSS Feed',
        description = '',
        outputPath = 'feed.xml',
    } = config

    const items = []

    return {
        name: 'test-plugin',
        version: '1.0.0',
        onPage: ({ pagePath, frontmatter, document }) => {
            const urlPath = pagePath.replace(/^pages/, '').replace(/\.md$/, '.html')
            const link = `${siteUrl}${urlPath}`

            items.push({
                title: frontmatter.title || document.title || urlPath,
                link,
                guid: link,
                description: frontmatter.description || document.querySelector('p')?.textContent || '',
                pubDate: frontmatter.date ? new Date(frontmatter.date).toUTCString() : null,
            })
        },
        onBuildComplete: (fs, outputDir) => {
            const itemsXml = items.map(({ title, link, guid, description, pubDate }) => `
    <item>
      <title>${escapeXml(title)}</title>
      <link>${link}</link>
      <guid>${guid}</guid>
      <description>${escapeXml(description)}</description>
      ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
    </item>`).join('')

            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${siteUrl}</link>
    <description>${escapeXml(description)}</description>
    ${itemsXml}
  </channel>
</rss>`

            fs.writeFileSync(`${outputDir}/${outputPath}`, xml)
        },
    }
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}
