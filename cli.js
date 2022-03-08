#!/usr/bin/env node

const { JSDOM } = require('jsdom')
const fs = require('fs-extra')
const { marked } = require('marked')
const http = require('http')
const chokidar = require('chokidar')
const fm = require('front-matter')

const templateUsageMap = new Map() // key = templatePath, value = Set of pagePaths
const pageUsageMap = new Map() // key = pagePath, value = templatePath

// attributes: { template: "custom.html" }
// body: "# My normal markdown ..."
const scriptArgs = process.argv.slice(2)
const command = scriptArgs[0]

switch (command) {
    case 'build':
        build()
        break
    case 'develop':
        develop(scriptArgs[1] ? Number(scriptArgs[1]) : 8000)
        break
    case 'init':
        init()
        break
    default:
        console.log(`Command 'teeny ${command}' does not exist.`)
        process.exit(1)
}

async function build() {
    await fs.emptyDir('public/')

    await safeExecute(
        async () =>
            await fs.copy('templates/', 'public/', {
                filter: (src, dest) => isNotHiddenFile(src) && !src.endsWith('.html'),
            })
    )
    await safeExecute(
        async () =>
            await fs.copy('pages/', 'public/', {
                filter: (src, dest) => isNotHiddenFile(src) && !src.endsWith('.md'),
            })
    )
    await safeExecute(
        async () => await fs.copy('static/', 'public/', { filter: (src, dest) => isNotHiddenFile(src) })
    )

    await processDirectory('pages')
}

async function processDirectory(directoryPath) {
    let contents = await fs.readdir(`${directoryPath}/`)
    const processPagePromises = []
    for (const element of contents) {
        const isDirectory = (await fs.lstat(`${directoryPath}/${element}`)).isDirectory()
        if (isDirectory) {
            await processDirectory(`${directoryPath}/${element}`, processPagePromises)
            continue
        }
        processPagePromises.push(processPage(`${directoryPath}/${element}`))
    }
    await Promise.all(processPagePromises)
}

async function develop(port) {
    await build()
    const server = startServer(port)
    const watcher = chokidar.watch(['pages/', 'static/', 'templates/']).on('change', async (path, _) => {
        console.log(`Detected change in file ${path}.`)
        if (
            path.startsWith('static/') ||
            (path.startsWith('templates/') && !path.endsWith('.html')) ||
            (path.startsWith('pages/') && !path.endsWith('.md'))
        ) {
            await safeExecute(
                async () =>
                    await fs.copy(path, `public/${path.substring(path.split('/')[0].length + 1)}`, {
                        filter: (src, dest) => isNotHiddenFile(src),
                    })
            )
        } else if (path.startsWith('pages/')) {
            processPage(path)
        } else if (templateUsageMap.has(path)) {
            templateUsageMap.get(path).forEach((element) => {
                processPage(element)
            })
        }
    })
}

async function init() {
    await safeExecute(async () => await fs.mkdir('pages/'))
    await safeExecute(async () => await fs.mkdir('static/'))
    await safeExecute(async () => await fs.mkdir('templates/'))

    const examplePage = `---\ntemplate: homepage\ntitle: Teeny page\nauthor: teeny\n---\n\n# Hello World\n`

    const exampleTemplate = `<html>\n    <head>\n        <title>{{ title }}</title>\n        <meta name="author" content="{{ author }}" />\n    </head>\n\n    <body>\n        <p>My first Teeny page</p>\n        <div id="page-content"></div>\n        <script type="text/javascript" src="main.js"></script>\n    </body>\n</html>\n`
    const defaultTemplate = `<html>\n    <body>\n        <div id="page-content"></div>\n    </body>\n</html>\n`
    const exampleStaticAssetJs = `console.log('hello world')\n`

    await fs.writeFile('pages/index.md', examplePage)
    await fs.writeFile('templates/homepage.html', exampleTemplate)
    await fs.writeFile('templates/default.html', defaultTemplate)
    await fs.writeFile('static/main.js', exampleStaticAssetJs)
}

async function processPage(pagePath) {
    let templatePath = 'templates/default.html'
    const fileData = await fs.readFile(pagePath, 'utf-8')
    const { attributes: frontmatter, body: markdown } = await fm(fileData)
    if (frontmatter.template) {
        templatePath = `templates/${frontmatter.template}.html`
    }

    if (pageUsageMap.has(pagePath)) {
        templateUsageMap.get(pageUsageMap.get(pagePath)).delete(pagePath)
    }

    if (templateUsageMap.has(templatePath)) {
        templateUsageMap.get(templatePath).add(pagePath)
    } else {
        templateUsageMap.set(templatePath, new Set([pagePath]))
    }

    pageUsageMap.set(pagePath, templatePath)

    let templateString = await fs.readFile(templatePath, 'utf-8')

    for (const key in frontmatter) {
        templateString = templateString.replaceAll(`{{ ${key} }}`, frontmatter[key])
    }

    const dom = new JSDOM(templateString)
    const parsedHtml = marked.parse(markdown)
    const document = dom.window.document

    const pageContentElement = document.getElementById('page-content')

    if (pageContentElement) {
        pageContentElement.innerHTML = parsedHtml
    } else {
        console.log(
            `Could not find element with id 'page-content' in template ${templatePath}. Generating page without markdown content.`
        )
    }

    const wrapperHtmlElement = document.getElementsByTagName('html')
    if (!wrapperHtmlElement.length) {
        console.log(`Templates should contain the 'html' tag.`)
        process.exit(1)
    }

    if (!document.title || document.title == `{{ title }}`) {
        if (!frontmatter.title) {
            const h1s = document.getElementsByTagName('h1')
            if (h1s.length) {
                document.title = h1s[0].innerHTML
            }
        } else {
            document.title = frontmatter.title
        }
    }

    const finalHtml = document.getElementsByTagName('html')[0].outerHTML

    const pagePathParts = pagePath.replace('pages/', '').split('/')
    const pageName = pagePathParts.pop().split('.md')[0]
    const targetPath = pagePathParts.join('/')
    await fs.outputFile(`public/${targetPath}/${pageName}.html`, finalHtml)
    console.log(`Build public/${targetPath}/${pageName}.html`)
}

function startServer(port) {
    console.log(`Development server starting on http://localhost:${port}`)
    return http
        .createServer(function (req, res) {
            const url = req.url
            let filePath = url
            if (url === '/') {
                filePath = '/index.html'
            } else if (!url.includes('.')) {
                filePath += '.html'
            }
            fs.readFile('public' + filePath, function (err, data) {
                if (err) {
                    res.writeHead(404)
                    res.end('<h1>404: Page not found</h1>')
                    return
                }
                res.writeHead(200)
                res.end(data)
            })
        })
        .listen(port)
}

async function safeExecute(func) {
    try {
        await func()
    } catch {}
}

function isNotHiddenFile(src) {
    return !src.match(/.+\/\..*/)
}
