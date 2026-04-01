#!/usr/bin/env node

const { JSDOM } = require('jsdom')
const fs = require('fs-extra')
const { marked } = require('marked')
const http = require('http')
const chokidar = require('chokidar')
const fm = require('front-matter')

let sseClients = []

const reloadScript = `<script>new EventSource('/__reload').onmessage=()=>location.reload()</script>`

// attributes: { template: "custom.html" }
// body: "# My normal markdown ..."
const scriptArgs = process.argv.slice(2)
const command = scriptArgs[0]

const helpText = `teeny - a very simple static site generator

Usage: teeny <command> [options]

Commands:
  init              Scaffold a new site (creates pages/, static/, templates/)
  build             Build the site into the public/ directory
  develop [port]    Build and start a dev server with live reload (default port: 8000)
  version           Show the current version

Options:
  -h, --help        Show this help message`

if (!command || command === '--help' || command === '-h') {
    console.log(helpText)
    process.exit(0)
}

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
    case 'version':
    case '--version':
    case '-v':
        console.log(require('./package.json').version)
        break
    default:
        console.log(`Command 'teeny ${command}' does not exist.\n`)
        console.log(helpText)
        process.exit(1)
}

async function build() {
    await fs.emptyDir('public/')

    await safeExecute(
        async () =>
            await fs.copy('templates/', 'public/', { filter: (f) => !f.startsWith('.') && !f.endsWith('.html') })
    )
    await safeExecute(
        async () => await fs.copy('pages/', 'public/', { filter: (f) => !f.startsWith('.') && !f.endsWith('.md') })
    )
    await safeExecute(async () => await fs.copy('static/', 'public/'), { filter: (f) => !f.startsWith('.') })

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
    const server = startServer(port, true)
    let rebuilding = false
    let debounceTimer = null
    chokidar
        .watch(['pages/', 'static/', 'templates/'], { ignoreInitial: true })
        .on('change', (path) => {
            if (rebuilding) return
            clearTimeout(debounceTimer)
            debounceTimer = setTimeout(async () => {
                rebuilding = true
                console.log(`Detected change in file ${path}. Rebuilding...`)
                try {
                    await build()
                    sseClients.forEach((client) => client.write('data: reload\n\n'))
                } catch (err) {
                    console.error('Build failed:', err.message)
                }
                setTimeout(() => { rebuilding = false }, 200)
            }, 100)
        })
}

async function init() {
    await safeExecute(async () => await fs.mkdir('pages/'))
    await safeExecute(async () => await fs.mkdir('static/'))
    await safeExecute(async () => await fs.mkdir('templates/'))

    const examplePage = `---\ntemplate: homepage\n---\n# Hello World`
    const exampleTemplate = `<html><body><p>My first Teeny page</p><div id='page-content'></div><script type="text/javascript" src='main.js'></body></html>`
    const defaultTemplate = `<html><body><div id='page-content'></div></body></html>`
    const exampleStaticAssetJs = `console.log('hello world')`

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
    const dom = await JSDOM.fromFile(templatePath)
    const parsedHtml = marked(markdown)
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

    let title = frontmatter.title
    if (!title) {
        const h1s = document.getElementsByTagName('h1')
        if (h1s.length) {
            title = h1s[0].innerHTML
        }
    }

    if (title) {
        document.title = title
    }

    const finalHtml = document.getElementsByTagName('html')[0].outerHTML

    const pagePathParts = pagePath.replace('pages/', '').split('/')
    const pageName = pagePathParts.pop().split('.md')[0]
    const targetPath = pagePathParts.join('/')
    await fs.writeFile(`public/${targetPath}/${pageName}.html`, finalHtml)
}

function startServer(port, hotReload) {
    console.log(`Development server starting on http://localhost:${port}`)
    return http
        .createServer(function (req, res) {
            const url = req.url

            if (hotReload && url === '/__reload') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                })
                sseClients.push(res)
                req.on('close', () => {
                    sseClients = sseClients.filter((c) => c !== res)
                })
                return
            }

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
                if (hotReload && filePath.endsWith('.html')) {
                    data = data.toString().replace('</body>', reloadScript + '</body>')
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
