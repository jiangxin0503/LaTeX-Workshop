import * as vscode from 'vscode'
import * as fs from 'fs'

import {Extension} from '../../main'

const bibEntries = ['article', 'book', 'bookinbook', 'booklet', 'collection', 'conference', 'inbook',
                    'incollection', 'inproceedings', 'inreference', 'manual', 'mastersthesis', 'misc',
                    'mvbook', 'mvcollection', 'mvproceedings', 'mvreference', 'online', 'patent', 'periodical',
                    'phdthesis', 'proceedings', 'reference', 'report', 'set', 'suppbook', 'suppcollection',
                    'suppperiodical', 'techreport', 'thesis', 'unpublished']

interface CitationRecord {
    key: string
    [key: string]: string | undefined
}

export class Citation {
    extension: Extension
    suggestions: vscode.CompletionItem[]
    citationInBib: { [id: string]: CitationRecord[] } = {}
    citationData: { [id: string]: {item: {}, text: string, position: vscode.Position, file: string} } = {}
    refreshTimer: number

    constructor(extension: Extension) {
        this.extension = extension
    }

    provide(args?: {document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext}) : vscode.CompletionItem[] {
        if (Date.now() - this.refreshTimer < 1000) {
            return this.suggestions
        }
        this.refreshTimer = Date.now()

        const items: CitationRecord[] = []
        Object.keys(this.citationInBib).forEach(bibPath => {
            this.citationInBib[bibPath].forEach(item => items.push(item))
        })

        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        this.suggestions = items.map(item => {
            const citation = new vscode.CompletionItem(item.key, vscode.CompletionItemKind.Reference)
            citation.detail = item.title
            switch (configuration.get('intellisense.citation.label') as string) {
                case 'bibtex key':
                default:
                    citation.label = item.key
                    break
                case 'title':
                    if (item.title) {
                        citation.label = item.title as string
                        citation.detail = undefined
                    } else {
                        citation.label = item.key
                    }
                    break
                case 'authors':
                    if (item.author) {
                        citation.label = item.author as string
                        citation.detail = undefined
                    } else {
                        citation.label = item.key
                    }
                    break
            }

            citation.filterText = `${item.key} ${item.author} ${item.title} ${item.journal}`
            citation.insertText = item.key
            citation.documentation = Object.keys(item)
                .filter(key => (key !== 'key'))
                .map(key => `${key}: ${item[key]}`)
                .join('\n')
            if (args) {
                citation.range = args.document.getWordRangeAtPosition(args.position, /[-a-zA-Z0-9_:\.]+/)
            }
            return citation
        })
        return this.suggestions
    }

    browser(args?: {document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext}) {
        this.provide(args)
        const items: CitationRecord[] = []
        Object.keys(this.citationInBib).forEach(bibPath => {
            this.citationInBib[bibPath].forEach(item => items.push(item))
        })
        const pickItems: vscode.QuickPickItem[] = items.map(item => {
            return {
                label: item.title ? item.title as string : '',
                description: `${item.key}`,
                detail: `Authors: ${item.author ? item.author : 'Unknown'}, publication: ${item.journal ? item.journal : (item.publisher ? item.publisher : 'Unknown')}`
            }
        })
        vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Press ENTER to insert citation key at cursor',
            matchOnDetail: true,
            matchOnDescription: true
        }).then(selected => {
            if (!selected) {
                return
            }
            if (vscode.window.activeTextEditor) {
                const editor = vscode.window.activeTextEditor
                const content = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), editor.selection.start))
                let start = editor.selection.start
                if (content.lastIndexOf('\\cite') > content.lastIndexOf('}')) {
                    const curlyStart = content.lastIndexOf('{') + 1
                    const commaStart = content.lastIndexOf(',') + 1
                    start = editor.document.positionAt(curlyStart > commaStart ? curlyStart : commaStart)
                }
                editor.edit(edit => edit.replace(new vscode.Range(start, editor.selection.start), selected.description || ''))
            }
        })
    }

    parseBibFile(bibPath: string) {
        this.extension.logger.addLogMessage(`Parsing .bib entries from ${bibPath}`)
        const items: CitationRecord[] = []
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        if (fs.statSync(bibPath).size >= (configuration.get('intellisense.citation.maxfilesizeMB') as number) * 1024 * 1024) {
            this.extension.logger.addLogMessage(`${bibPath} is too large, ignoring it.`)
            this.citationInBib[bibPath] = items
            return
        }
        const content = fs.readFileSync(bibPath, 'utf-8')
        const contentNoNewLine = content.replace(/[\r\n]/g, ' ')
        const itemReg = /@(\w+)\s*{/g
        let result = itemReg.exec(contentNoNewLine)
        let prevResult: RegExpExecArray | null = null
        let numLines = 1
        let prevPrevResultIndex = 0
        while (result || prevResult) {
            if (prevResult && bibEntries.indexOf(prevResult[1].toLowerCase()) > -1) {
                const itemString = contentNoNewLine.substring(prevResult.index, result ? result.index : undefined).trim()
                const item = this.parseBibString(itemString)
                if (item !== undefined) {
                    items.push(item)
                    numLines = numLines + content.substring(prevPrevResultIndex, prevResult.index).split('\n').length - 1
                    prevPrevResultIndex = prevResult.index
                    this.citationData[item.key] = {
                        item,
                        text: Object.keys(item)
                            .filter(key => (key !== 'key'))
                            .sort((a, b) => {
                                if (a.toLowerCase() === 'title') {
                                    return -1
                                }
                                if (b.toLowerCase() === 'title') {
                                    return 1
                                }
                                if (a.toLowerCase() === 'author') {
                                    return -1
                                }
                                if (b.toLowerCase() === 'author') {
                                    return 1
                                }
                                return 0
                            })
                            .map(key => `${key}: ${item[key]}`)
                            .join('\n\n'),
                        position: new vscode.Position(numLines - 1, 0),
                        file: bibPath
                    }
                } else {
                    // TODO we could consider adding a diagnostic for this case so the issue appears in the Problems list
                    this.extension.logger.addLogMessage(`Warning - following .bib entry in ${bibPath} has no cite key:\n${itemString}`)
                }
            }
            prevResult = result
            if (result) {
                result = itemReg.exec(contentNoNewLine)
            }
        }
        this.extension.logger.addLogMessage(`Parsed ${items.length} .bib entries from ${bibPath}.`)
        this.citationInBib[bibPath] = items
    }

    forgetParsedBibItems(bibPath: string) {
        this.extension.logger.addLogMessage(`Forgetting parsed bib entries for ${bibPath}`)
        delete this.citationInBib[bibPath]
    }

    parseBibString(item: string) {
        const bibDefinitionReg = /((@)[a-zA-Z]+)\s*(\{)\s*([^\s,]*)/g
        let regResult = bibDefinitionReg.exec(item)
        if (!regResult) {
            return undefined
        }
        item = item.substr(bibDefinitionReg.lastIndex)
        const bibItem: CitationRecord = { key: regResult[4] }
        const bibAttrReg = /([a-zA-Z0-9\!\$\&\*\+\-\.\/\:\;\<\>\?\[\]\^\_\`\|]+)\s*(\=)/g
        regResult = bibAttrReg.exec(item)
        while (regResult) {
            const attrKey = regResult[1]
            item = item.substr(bibAttrReg.lastIndex)
            bibAttrReg.lastIndex = 0
            const commaPos = /,/g.exec(item)
            const quotePos = /\"/g.exec(item)
            const bracePos = /{/g.exec(item)
            let attrValue = ''
            if (commaPos && ((!quotePos || (quotePos && (commaPos.index < quotePos.index)))
                && (!bracePos || (bracePos && (commaPos.index < bracePos.index))))) {
                // No deliminator
                attrValue = item.substring(0, commaPos.index).trim()
                item = item.substr(commaPos.index)
            } else if (bracePos && (!quotePos || quotePos.index > bracePos.index)) {
                // Use curly braces
                let nested = 0
                for (let i = bracePos.index; i < item.length; ++i) {
                    const char = item[i]
                    if (char === '{' && item[i - 1] !== '\\') {
                        nested++
                    } else if (char === '}' && item[i - 1] !== '\\') {
                        nested--
                    }
                    if (nested === 0) {
                        attrValue = item.substring(bracePos.index + 1, i)
                                        .replace(/(\\.)|({)/g, '$1').replace(/(\\.)|(})/g, '$1')
                        item = item.substr(i)
                        break
                    }
                }
            } else if (quotePos) {
                // Use double quotes
                for (let i = quotePos.index + 1; i < item.length; ++i) {
                    if (item[i] === '"') {
                        attrValue = item.substring(quotePos.index + 1, i)
                                        .replace(/(\\.)|({)/g, '$1').replace(/(\\.)|(})/g, '$1')
                        item = item.substr(i)
                        break
                    }
                }
            }
            bibItem[attrKey.toLowerCase()] = attrValue
            regResult = bibAttrReg.exec(item)
        }
        return bibItem
    }
}
