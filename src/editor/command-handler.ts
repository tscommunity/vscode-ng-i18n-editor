import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsPromises, existsSync, exists } from 'fs';
import { FileUtils } from '../modules/common/file.util';
import { Xliff } from '../modules/xliff/xliff';
import { StringUtils } from '../modules/common/string.util';

const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: `0 0 1px 0`,
    borderStyle: `dashed`, //TODO: file bug, this shouldn't throw a lint error.
    borderColor: `red`
});

const keyDecoration = vscode.window.createTextEditorDecorationType({
    outline: '4px double green'
});

export class EditorCommandHanlder {


    private activeCodeRevealEditor!: vscode.TextEditor;

    private static readonly commandResultMap = {
        'list-xliff-files': 'list-xliff-files-loaded',
        'load-xliff-file': 'xliff-file-loaded',
        'load-trans-unit-code-ctx': 'trans-unit-code-ctx-loaded',
        'update-trans-unit': 'trans-unit-updated',
    };

    constructor(
        private webview: vscode.Webview,
        private setting: INgI18nExtSetting,
    ) {

    }

    updateSetting(setting: INgI18nExtSetting) {
        this.setting = setting;
    }

    handle<K extends i18nWebView.CommandName>(command: K, message: i18nWebView.I18nTranslateWebViewCommandMap[K]) {
        console.log(`command received: ${command}`, message);
        const handlerName = command.split('-')
            .map((val, idx) => idx === 0 ? val : `${val[0].toUpperCase()}${val.substring(1)}`)
            .join('');
        const handler = (this as any)[handlerName] as Function;
        const callbackCmd = (EditorCommandHanlder.commandResultMap as any)[command];
        if (typeof handler === 'function') {
            handler.apply(this, [message]);
        } else {
            if (callbackCmd) {
                const errorMsg = `handler not found for command: ${command}, expected: ${handlerName}`;
                const error = this.buildErrorCallbackResult(command, message, errorMsg, -1);
                this.sendMessage(callbackCmd, error as any);
                console.warn(errorMsg, command, message);
            } else {
                throw new Error(`handler not found for command: ${command}, expected: ${handlerName}`);
            }
        }
    }

    listXliffFiles(command: i18nWebView.ListXliffFilesCommand) {
        const baseDir = vscode.workspace.rootPath;
        let detectionRootFolder = path.resolve(baseDir!, this.setting.dir);
        let result: i18nWebView.ListXliffFilesResultEvent = {
            ...this.buildCallbackResultBase(
                'list-xliff-files', command
            ),
            dir: detectionRootFolder,
            locales: this.setting.locales,
            files: this.setting.editor.messageLocations.map(i => {
                return {
                    name: i,
                    path: path.resolve(detectionRootFolder, i)
                };
            }),
        };
        this.sendMessage('list-xliff-files-loaded', result);
    }

    loadXliffFile(command: i18nWebView.LoadXliffFileCommand) {
        const file = command.xliffFile;
        const tarLocale = command.locale;
        const targetXliff = FileUtils.getCorrespondingTranslationFile(file, tarLocale);
        let result: i18nWebView.LoadXliffFileResultEvent = {} as any;
        Promise.all(
            [
                fsPromises.readFile(file, { encoding: 'utf8' }),
                existsSync(targetXliff) ? fsPromises.readFile(targetXliff, { encoding: 'utf8' }) : Promise.resolve('NOT-EXISTS')
            ]
        ).then((fileReadResults) => {
            let sourceContent = fileReadResults[0];
            let targetContent = fileReadResults[1];
            const { transUnitByMsgId, errors, sourceLocale } = Xliff.loadTransUnits(sourceContent, '');
            if (errors && errors.length > 0 || !sourceLocale) {
                const errMsg = `failed to load trans units from ${file}. Errors: ${errors?.join('; ')}`;
                result = this.buildErrorCallbackResult('xliff-file-loaded', command, errMsg) as any;
            } else {
                if (targetContent !== 'NOT-EXISTS') {
                    const {
                        transUnitByMsgId: translationById,
                        errors: tErrors,
                        sourceLocale: tSourceLocale,
                        targetLocale: tTargetLocale,
                    } = Xliff.loadTransUnits(targetContent, '');
                    if (tErrors && tErrors.length > 0) {
                        const errMsg = `failed to load translations from ${targetXliff}. Errors: ${errors?.join('; ')}`;
                        result = this.buildErrorCallbackResult('xliff-file-loaded', command, errMsg) as any;
                    } else if (tSourceLocale !== sourceLocale) {
                        const errMsg = `the translation file source locale is not match. actual: ${tSourceLocale}, expected: ${sourceLocale}`;
                        result = this.buildErrorCallbackResult('xliff-file-loaded', command, errMsg) as any;
                    } else if (tTargetLocale !== tarLocale) {
                        const errMsg = `the translation file target locale is not match. actual: ${tTargetLocale}, expected: ${tarLocale}`;
                        result = this.buildErrorCallbackResult('xliff-file-loaded', command, errMsg) as any;
                    } else {
                        // populate translations
                        const resultTransUnits = Object.values(transUnitByMsgId).map(transUnit => {
                            const transItem = translationById[transUnit.key];
                            if (transItem) {
                                transUnit.target = transItem.target;
                                transUnit.target_parts = transItem.target_parts ?? [];
                                transUnit.target_identifier = transItem.target_identifier;
                                transUnit.state = transItem.state ?? 'needs-translation';
                            }
                            return transUnit;
                        });
                        result = {
                            ...this.buildCallbackResultBase('xliff-file-loaded', command),
                            xliffFile: file,
                            sourceLangCode: sourceLocale,
                            targetLangCode: tarLocale,
                            transUnits: resultTransUnits,
                        };
                    }
                }
            }
            this.sendMessage('xliff-file-loaded', result);
        }).catch((err) => {
            const errMsg = `failed to read ${file}. Errors: ${err}`;
            result = this.buildErrorCallbackResult('xliff-file-loaded', command, errMsg) as any;
            this.sendMessage('xliff-file-loaded', result);
        });
    }

    loadTransUnitCodeCtx(command: i18nWebView.LoadTransUnitCodeContextCommand) {

    }

    updateTransUnit(command: i18nWebView.TransUnitUpdateCommand) {

    }

    revealCodeCtx(command: i18nWebView.CodeContextRevealCommand) {
        const baseDir = vscode.workspace.rootPath;
        let codeFileLocation = path.resolve(baseDir!, command.file);
        let result: i18nWebView.CodeContextRevealResultEvent = {} as any;
        exists(codeFileLocation, (exists: boolean) => {
            if (exists) {
                const codeFileUri = vscode.Uri.parse('file:///' + codeFileLocation);
                vscode.workspace.openTextDocument(codeFileUri).then((doc) => {
                    vscode.window.showTextDocument(doc, this.activeCodeRevealEditor?.viewColumn ?? vscode.ViewColumn.Beside).then(editor => {
                        this.activeCodeRevealEditor = editor;
                        const block = command.blocks[0];
                        const line = editor.document.lineAt(block.start - 1);
                        let keywordRange: vscode.Range | null = null;
                        if (block.needle) {
                            // searching keyword
                            const searchNeedle = StringUtils.isIdFromDigest(block.needle) ? ` i18n` : `@@${block.needle}`;
                            keywordRange = this.locateKeywordInDocument(searchNeedle, line, editor.document);
                            if (!keywordRange) {
                                const errMsg = `failed to locate the key '${block.needle}' in '${command.file}'.`;
                                result = this.buildErrorCallbackResult('code-ctx-revealed', command, errMsg) as any;
                                this.sendMessage('code-ctx-revealed', result);
                            }
                        }
                        vscode.commands
                            .executeCommand('revealLine', { lineNumber: line.lineNumber, at: 'center' })
                            .then(() => {
                                editor.setDecorations(decoration, [{ range: line.range }]);
                                if (keywordRange && !editor.selection.isEqual(keywordRange)) {
                                    editor.selections = [new vscode.Selection(keywordRange.start, keywordRange.end)];
                                    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
                                    editor.setDecorations(keyDecoration, [{ range: keywordRange }]);
                                }
                            });
                    });
                }, (err) => {
                    const errMsg = `failed to reveal code context for '${command.file}': ${err.toString()}.`;
                    result = this.buildErrorCallbackResult('code-ctx-revealed', command, errMsg) as any;
                    this.sendMessage('code-ctx-revealed', result);
                });
            } else {
                const errMsg = `failed to reveal code context for '${command.file}': file not exists.`;
                result = this.buildErrorCallbackResult('code-ctx-revealed', command, errMsg) as any;
                this.sendMessage('code-ctx-revealed', result);
            }
        });
    }

    private locateKeywordInDocument(keyword: string, line: vscode.TextLine, doc: vscode.TextDocument): vscode.Range | null {
        for (let l = line.lineNumber; l > 0; l--) {
            const tarLine = doc.lineAt(l);
            const keywordPos = tarLine.text.indexOf(keyword);
            if (keywordPos === -1) {
                continue;
            }
            const startPos = new vscode.Position(l, keywordPos);
            const endPos = new vscode.Position(l, keywordPos + keyword.length);
            const range = new vscode.Range(startPos, endPos);
            return range;
        }
        return null;
    }

    private sendMessage<K extends i18nWebView.CommandName>(type: K, message: i18nWebView.I18nTranslateWebViewCommandMap[K]) {
        this.webview.postMessage({
            command: type,
            data: message
        });
    }

    private buildCallbackResultBase(
        commandName: i18nWebView.CommandName,
        source: ExtEventBase,
        time: Date = new Date()
    ): ExtResultCallbackEvent {
        const result: ExtResultCallbackEvent = {
            time: time,
            hash: time.getTime().toString(),
            commandHash: source.hash,
            commandName: commandName,
            success: true
        };
        return result;
    }

    private buildErrorCallbackResult(
        commandName: i18nWebView.CommandName,
        event: ExtEventBase,
        errorMessage: string,
        errorCode: number = 0
    ): ExtResultCallbackEvent {
        const now = new Date();
        const result = this.buildCallbackResultBase(commandName, event, now);
        result.success = false;
        result.error = {
            code: errorCode,
            message: errorMessage,
        };
        return result;
    }
}