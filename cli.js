#!/usr/bin/env node

const { JSDOM } = require('jsdom')
const fs = require('fs-extra')
const { marked } = require('marked')
const http = require('http')
const chokidar = require('chokidar')
const fm = require('front-matter')
const path = require('path')

let sseClients = []

const reloadScript = `<script>new EventSource('/__reload').onmessage=()=>location.reload()</script>`

const mainHelpString = `teeny - a very simple static site generator

Usage: teeny <command> [options]

Commands:
  init                Initializes a new teeny project (creates pages/, static/, templates/)
  build               Builds the teeny project and outputs all static files to ./public/
  develop [-p PORT]   Runs a development server with hot reloading to serve your site's files (default port: 8000)
  version             Show the current version

Options:
  -h, --help        Show this help message
`

const initHelpString = `Usage: teeny init

Initializes a new hello world teeny project ready to use (creates pages/, static/, templates/)
`

const buildHelpString = `Usage: teeny build

Builds the teeny project and outputs all static files to ./public/
`

const developHelpString = `Usage: teeny develop [-p PORT]

Runs a development server with hot reloading to serve your site's files.

    -p, --port     port to run the server on (default: 8000)
`

const versionHelpString = `Usage: teeny version

Shows the current version
`

const commandToHelpString = {
    init: initHelpString,
    build: buildHelpString,
    develop: developHelpString,
    version: versionHelpString,
}

const defaultTeenyConfig = `
module.exports = {
    plugins: []
}`

const helpArgs = ['-h', '--help']

const DEFAULT_PORT = 8000

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
    await fs.writeFile('teeny.config.js', defaultTeenyConfig)
}

async function build({ isDevelop } = { isDevelop: false }) {
    let config = {}
    try {
        console.log('pwd', process.cwd())
        const configPath = path.resolve(process.cwd(), 'teeny.config.js')
        if (!fs.exists(configPath)) {
            console.warn('[WARNING] Could not load teeny.config.js file. Proceeding to build without plugins.')
        } else {
            config = require(configPath)
        }
    } catch (e) {
        console.error('[ERROR] Error loading teeny.config.js\n')
        throw e
    }

    const plugins = config.plugins || []

    // we don't want verbose output on isDevelop as it could be too much noise
    // can reconsider this and make it a config option in the future
    const verboseMode = config.verboseBuild && !isDevelop

    await fs.emptyDir('public/')

    await safeExecute(
        async () =>
            await fs.copy('templates/', 'public/', { filter: (f) => !f.startsWith('.') && !f.endsWith('.html') })
    )
    await safeExecute(
        async () => await fs.copy('pages/', 'public/', { filter: (f) => !f.startsWith('.') && !f.endsWith('.md') })
    )
    await safeExecute(async () => await fs.copy('static/', 'public/'), { filter: (f) => !f.startsWith('.') })

    await processDirectory('pages', plugins, verboseMode)

    for (const plugin of plugins) {
        if (!('onBuildComplete' in plugin)) {
            continue
        }

        if (verboseMode) {
            console.info(`Running onBuildComplete for plugin: ${plugin.name} (v${plugin.version})`)
        }
        plugin.onBuildComplete(fs, path.resolve(process.cwd(), 'public'))
    }
}

async function processDirectory(directoryPath, plugins, verboseMode) {
    let contents = await fs.readdir(`${directoryPath}/`)
    const processPagePromises = []
    for (const fileOrDirPath of contents) {
        const fullPath = `${directoryPath}/${fileOrDirPath}`
        const isDirectory = (await fs.lstat(fullPath)).isDirectory()
        if (isDirectory) {
            await processDirectory(fullPath)
            continue
        }
        processPagePromises.push(processPage(fullPath, plugins, verboseMode))
    }
    await Promise.all(processPagePromises)
}

async function processPage(pagePath, plugins, verboseMode) {
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
        console.warn(
            `[WARNING] Could not find element with id 'page-content' in template ${templatePath}. Generating page without markdown content.`
        )
    }

    const wrapperHtmlElement = document.getElementsByTagName('html')
    if (!wrapperHtmlElement.length) {
        console.error(`Templates should contain the 'html' tag.`)
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

    for (const plugin of plugins) {
        if (!('onPage' in plugin)) {
            continue
        }

        if (verboseMode) {
            console.info(`Running onPage for plugin: ${plugin.name} (v${plugin.version})`)
        }
        plugin.onPage({ pagePath, frontmatter, document, markdown })
    }

    const pagePathParts = pagePath.replace('pages/', '').split('/')
    const pageName = pagePathParts.pop().split('.md')[0]
    const targetPath = pagePathParts.join('/')
    await fs.writeFile(`public/${targetPath}/${pageName}.html`, finalHtml)
}

async function develop(commandArgs) {
    let port
    if (!commandArgs || commandArgs.length === 0) {
        port = DEFAULT_PORT
    } else if (commandArgs.length !== 2 || !['-p', '--port'].includes(commandArgs[0])) {
        // either accept 0 or two args
        console.error(`Invalid command: teeny develop ${commandArgs.join(' ')}\n${commandToHelpString['develop']}`)
        process.exit(1)
    } else {
        port = Number(commandArgs[1])
    }

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        console.error(`Invalid port: ${port}. The selected port must be an integer between 1024–65535.`)
        process.exit(1)
    }

    await build({ isDevelop: true })

    startServer(port, true)

    let rebuilding = false
    let debounceTimer = null
    chokidar.watch(['pages/', 'static/', 'templates/'], { ignoreInitial: true }).on('change', (path) => {
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
            setTimeout(() => {
                rebuilding = false
            }, 200)
        }, 100)
    })
}

function startServer(port, hotReload) {
    console.log(`Development server starting on http://localhost:${port}`)

    // we're not adding an onerror event handler to server because most errors
    // from process exits originating from the server will be more useful than
    // the info we can provide.
    // the most common error will be port already in use and the traceback makes that clear
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

function main() {
    // attributes: { template: "custom.html" }
    // body: "# My normal markdown ..."
    const scriptArgs = process.argv.slice(2)
    const command = scriptArgs[0]
    const commandArgs = scriptArgs.slice(1)

    if (!command || helpArgs.includes(command)) {
        console.log(mainHelpString)
        process.exit(0)
    }

    const isRequestingCommandHelp = commandArgs.length > 0 && helpArgs.includes(commandArgs[0])
    if (isRequestingCommandHelp) {
        console.log(commandToHelpString[command] || mainHelpString)
        return
    }

    switch (command) {
        case 'init':
            if (commandArgs.length > 0) {
                console.error(`Invalid command: teeny ${scriptArgs.join(' ')}\n${commandToHelpString['init']}`)
                process.exit(1)
            }
            init()
            break
        case 'build':
            if (commandArgs.length > 0) {
                console.error(`Invalid command: teeny ${scriptArgs.join(' ')}\n${commandToHelpString['build']}`)
                process.exit(1)
            }
            build()
            break
        case 'develop':
            develop(commandArgs)
            break
        case 'version':
        case '--version':
        case '-v':
            console.log(require('./package.json').version)
            break
        default:
            console.log(`Command 'teeny ${command}' does not exist.\n`)
            console.log(mainHelpString)
            process.exit(1)
    }
}

main()
