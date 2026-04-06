module.exports = {
    verboseBuild: true,
    skipPluginsOnDevelop: true,
    plugins: [
        require('./plugins/test-plugin')({
            siteUrl: 'https://example.com',
            title: 'My Site',
            description: 'My site RSS feed',
        })
    ],
}