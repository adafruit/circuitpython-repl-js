const CHAR_CTRL_A = '\x01';
const CHAR_CTRL_B = '\x02';
const CHAR_CTRL_C = '\x03';
const CHAR_CTRL_D = '\x04';
const CHAR_CTRL_E = '\x05';
const CHAR_CRLF = '\x0a\x0d';
const CHAR_BKSP = '\x08';
const CHAR_TITLE_START = "\x1b]0;";
const CHAR_TITLE_END = "\x1b\\";
const CHAR_RAW_PASTE_UNSUPPORTED = "R\x00";
const CHAR_RAW_PASTE_SUPPORTED = "R\x01";
const REGEX_RAW_PASTE_RESPONSE = /R[\x00\x01]..\x01/;

const MODE_NORMAL = 1;
const MODE_RAW = 2;
const MODE_RAWPASTE = 3;

const TYPE_DIR = 16384;
const TYPE_FILE = 32768;
const DEBUG = false;

export const LINE_ENDING_CRLF = "\r\n";
export const LINE_ENDING_LF = "\n";

const CONTROL_SEQUENCES = [
    REGEX_RAW_PASTE_RESPONSE
];

// Mostly needed when the terminal echos back the input
const IGNORE_OUTPUT_LINE_PREFIXES = [/^\... /, /^>>> /];

// Default timeouts in milliseconds (can be overridden with properties)
const PROMPT_TIMEOUT = 20000;
const CODE_EXECUTION_TIMEOUT = 15000;
const PROMPT_CHECK_INTERVAL = 50;

const REGEX_PROMPT_RAW_MODE = /raw REPL; CTRL-B to exit/;

// Class to use python code to get file information
// We want to do stuff like writing files, reading files, and listing files
export class FileOps {
    constructor(repl, checkReadOnly=true) {
        this._repl = repl;
        this._isReadOnly = null;
        this._doCheckReadOnly = checkReadOnly;
    }

    async _checkReadOnly() {
        if (!this._doCheckReadOnly) {
            return;
        }

        if (this._isReadOnly == null) {
            this._isReadOnly = await this.isReadOnly();
        }

        if (this._isReadOnly()) {
            throw new Error("File System is Read Only. Try disabling or ejecting the drive.");
        }
    }

    async _checkReplErrors() {
        let error = this._repl.getErrorOutput();
        if (error) {
            console.error("Python Error - " + error.type + ": " + error.message);
            if (error.type == "OSError" && error.errno == 30) {
                this._isReadOnly = true;
                // Throw an error if needed
                await this._checkReadOnly();
            }
        }

        return error;
    }

    // Write a file to the device path with contents beginning at offset. Modification time can be set and if raw is true, contents is written as binary
    async _writeRawFile(path, contents, offset=0, modificationTime=null) {
        let byteString = "";
        // Contents needs to be converted from a ArrayBuffer to a byte string
        let view = new Uint8Array(contents);
        for (let byte of view) {
            byteString += String.fromCharCode(byte);
        }
        contents = btoa(byteString);  // Convert binary string to base64

        let code = `
import binascii
with open("${path}", "wb") as f:
    f.seek(${offset})
    byte_string = binascii.a2b_base64("${contents}")
    f.write(byte_string)
`;

        if (modificationTime) {
            code += `os.utime("${path}", (os.path.getatime("${path}"), ${modificationTime}))\n`;
        }
        await this._repl.execRawPasteMode(code);
    }

    async _writeTextFile(path, contents, offset=0, modificationTime=null) {
        // The contents needs to be converted from a UInt8Array to a string
        contents = String.fromCharCode.apply(null, contents);
        contents = contents.replace(/"/g, '\\"');

        let code = `
with open("${path}", "w") as f:
    f.seek(${offset})
    f.write("""${contents}""")
`;

        if (modificationTime) {
            code += `os.utime("${path}", (os.path.getatime("${path}"), ${modificationTime}))\n`;
        }
        await this._repl.execRawPasteMode(code);
    }

    // Write a file to the device path with contents beginning at offset. Modification time can be set and if raw is true, contents is written as binary
    async writeFile(path, contents, offset=0, modificationTime=null, raw=false) {
        this._repl.terminalOutput = DEBUG;

        if (raw) {
            await this._writeRawFile(path, contents, offset, modificationTime);
        } else {
            await this._writeTextFile(path, contents, offset, modificationTime);
        }

        this._repl.terminalOutput = true;
    }

    async _readRawFile(path) {
        try {
            let code = `
import binascii
with open("${path}", "rb") as f:
    byte_string = f.read()
    print(binascii.b2a_base64(byte_string, False))
`;
            let result = await this._repl.execRawPasteMode(code);
            if (this._checkReplErrors()) {
                return null;
            }

            // strip the b, ending newline, and quotes from the beginning and end
            result = result.slice(2, -3);

            // convert the base64 string to an ArrayBuffer. Each byte of the Array buffer is a byte of the file with a value between 0-255
            result = atob(result);  // Convert base64 to binary string
            let length = result.length;
            let buffer = new ArrayBuffer(length);
            let view = new Uint8Array(buffer);
            for (let i = 0; i < length; i++) {
                view[i] = result.charCodeAt(i);
            }

            result = new Blob([buffer]);
            return result;
        } catch(error) {
            return null;
        }
    }

    async _readTextFile(path) {
        try {
            let code = `
with open("${path}", "r") as f:
    print(f.read())
`;
            let result = await this._repl.execRawPasteMode(code);
            if (await this._checkReplErrors()) {
                return null;
            }

            // Remove last 2 bytes from the result because \r\n is added to the end
            return result.slice(0, -2);
        } catch(error) {
            return null;
        }
    }

    // Read a file from the device
    async readFile(path, raw=false) {
        let result;
        this._repl.terminalOutput = DEBUG;

        if (raw) {
            result = await this._readRawFile(path);
        } else {
            result = await this._readTextFile(path);
        }

        this._repl.terminalOutput = true;
        return result;
    }

    // List files using paste mode on the device returning the result as a javascript array
    // We need the file name, whether or not it is a directory, file size and file date
    async listDir(path) {
        this._repl.terminalOutput = DEBUG;
        // Mask sure path has a trailing slash
        if (path[path.length - 1] != "/") {
            path += "/";
        }

        let code = `
import os
import time
contents = os.listdir("${path}")
for item in contents:
    result = os.stat("${path}" + item)
    print(item, result[0], result[6], result[9])
`;
        const result = await this._repl.execRawPasteMode(code);
        let contents = [];
        if (!result) {
            return contents;
        }
        for (let line of result.split("\n")) {
            let [name, isDir, fileSize, fileDate] = line.split(" ");
            contents.push({
                path: name,
                isDir: isDir == TYPE_DIR,
                fileSize: parseInt(fileSize),
                fileDate: parseInt(fileDate) * 1000,
            });
        }
        this._repl.terminalOutput = true;
        return contents;
    }

    async isReadOnly() {
        this._repl.terminalOutput = DEBUG;

        let code = `
import storage
print(storage.getmount("/").readonly)
`;
        let result = await this._repl.execRawPasteMode(code);
        let isReadOnly = result.match("True") != null;
        this._repl.terminalOutput = true;

        return isReadOnly;
    }

    async makeDir(path, modificationTime=null) {
        await this._checkReadOnly();
        this._repl.terminalOutput = DEBUG;
        let code = `os.mkdir("${path}")\n`;
        if (modificationTime) {
            code += `os.utime("${path}", (os.path.getatime("${path}"), ${modificationTime}))\n`;
        }
        await this._repl.execRawPasteMode(code);
        this._checkReplErrors();
        this._repl.terminalOutput = true;
    }

    async delete(path) {
        await this._checkReadOnly();
        this._repl.terminalOutput = DEBUG;
        let code = `
import os

stat = os.stat("${path}")
if stat[0] == ${TYPE_FILE}:
    os.remove("${path}")
else:
    os.rmdir("${path}")
`;
        await this._repl.execRawPasteMode(code);
        this._checkReplErrors();
        this._repl.terminalOutput = true;
    }

    async move(oldPath, newPath) {
        await this._checkReadOnly();
        // we need to check if the new path already exists
        // Return true on success and false on failure

        this._repl.terminalOutput = DEBUG;
        let code = `
import os
os.rename("${oldPath}", "${newPath}")
`;
        await this._repl.execRawPasteMode(code);
        let error = this._checkReplErrors();
        this._repl.terminalOutput = true;
        return !error;
    }
}

export class REPL {
    constructor() {
        this._pythonCodeRunning = false;
        this._codeOutput = '';
        this._errorOutput = '';
        this._serialInputBuffer = '';
        this._checkingPrompt = false;
        this._titleMode = false;
        this.promptTimeout = PROMPT_TIMEOUT;
        this.promptCheckInterval = PROMPT_CHECK_INTERVAL;
        this.title = '';
        this.serialTransmit = null;
        this._inputLineEnding = LINE_ENDING_CRLF;   // The line ending the REPL returns
        this._outputLineEnding = LINE_ENDING_LF;     // The line ending for the code result
        this._tokenQueue = [];
        this._mode = MODE_NORMAL;
        this._codeCheckPointer = 0; // Used for looking at code output
        this._promptCheckPointer = 0; // Used for looking at prompt output/control characters
        this._ctrlDCount = 0;
        this.terminalOutput = true;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _timeout(callback, ms) {
        return Promise.race([callback(), this._sleep(ms).then(() => {throw Error("Timed Out");})]);
    }

    _getControlCharBuffer() {
        // Return the Serial Buffer from _controlCharPointer to the next line ending and update the position of the pointer
        let bufferLines, controlChar = '';
        let remainingBuffer = this._serialInputBuffer.slice(this._controlCharPointer);
        if (remainingBuffer.includes(this._inputLineEnding)) {
            [controlChar, ...bufferLines] = remainingBuffer.split(this._inputLineEnding);
            this._controlCharPointer += controlChar.length + this._inputLineEnding.length;
        }
        return controlChar;
    }

    _getInputBufferLines() {
        return this._serialInputBuffer.split(this._inputLineEnding);
    }

    _lineIsPrompt(prompt_regex) {
        let lines = this._getInputBufferLines();
        if (lines.length == 0) {
            return false;
        }
        let lastLine = lines[lines.length - 1];
        return lastLine.match(prompt_regex);
    }

    _checkForModeChange() {
        let lines = this._getInputBufferLines();
        for (let line of lines) {
            if (line.match(REGEX_PROMPT_RAW_MODE)) {
                this._mode = MODE_RAW;
            }
        }
    }

    _currentLineIsNormalPrompt() {
        return this._lineIsPrompt(/>>> $/);
    }

    _currentLineIsPastePrompt() {
        return this._lineIsPrompt(/=== $/);
    }

    _currentLineIsPrompt() {
        if (this._mode == MODE_NORMAL) {
            return this._currentLineIsNormalPrompt();
        }

        return false;
    }

    _regexEscape(regexString) {
        return regexString.replace(/\\/, "\\\\");
    }

    setLineEnding(lineEnding) {
        if (lineEnding != LINE_ENDING_CRLF && lineEnding != LINE_ENDING_LF) {
            throw new Error("Line ending expected to be either be LINE_ENDING_CRLF or LINE_ENDING_LF")
        }

        this._outputLineEnding = lineEnding;
    }

    // This should help detect lines like ">>> ", but not ">>> 1+1"
    async checkPrompt() {
        if (this._mode == MODE_RAWPASTE) {
            let bytes = this._serialInputBuffer.slice(this._promptCheckPointer);
            this._promptCheckPointer += bytes.length;
            while (bytes.length > 0) {
                if (bytes.slice(0, 1).match(CHAR_CTRL_D)) {
                    this._ctrlDCount++;
                    //console.log("CTRL-D Count: " + this._ctrlDCount);
                } else {
                    if (this._ctrlDCount == 1) {
                        // Code Output
                        this._codeOutput += bytes.slice(0, 1);
                    } else if (this._ctrlDCount == 2) {
                        // Error Output
                        this._errorOutput += bytes.slice(0, 1);
                    } else if (this._ctrlDCount > 2) {
                        // Code is done running
                        this._pythonCodeRunning = false;
                    } else if (!this._pythonCodeRunning && bytes.slice(0, 1).match(">")) {
                        // We're at a prompt
                        this._mode = MODE_RAW;
                        return;
                    }
                }

                bytes = bytes.slice(1); // Remove the first byte
            }

            return;
        }

        // Only allow one instance of this function to run at a time (unless this could cause it to miss a prompt)
        if (!this._currentLineIsPrompt()) {
            return;
        }

        // Check again after a short delay to see if it's still a prompt
        await this._sleep(this.promptCheckInterval);

        if (!this._currentLineIsPrompt()) {
            return;
        }

        this._pythonCodeRunning = false;
    }

    async waitForPrompt() {
        this._pythonCodeRunning = true;

        // Wait for a prompt
        try {
            await this._timeout(
                async () => {
                    while (this._pythonCodeRunning) {
                        await this.getToPrompt();
                        await this._sleep(100);
                    }
                }, this.promptTimeout
            );
        } catch (error) {
            console.error("Awaiting prompt timed out.");
            return false;
        }
        return true;
    }

    async softRestart() {
        await this.serialTransmit(CHAR_CTRL_D);
    }

    async interruptCode() {
        this._pythonCodeRunning = true;
        // Wait for a prompt
        try {
            await this._timeout(
                async () => {
                    while (this._pythonCodeRunning) {
                        await this.serialTransmit(CHAR_CTRL_C);
                        await this.checkPrompt();
                        await this._sleep(50);
                    }
                }, this.promptTimeout
            );
        } catch (error) {
            console.error("Awaiting prompt timed out.");
            return false;
        }

    }

    getErrorOutput(raw = false) {
        if (raw) {
            return this._errorOutput;
        }
        if (!this._errorOutput) {
            return null;
        }
        let errorOutput = this._errorOutput;
        let errorLines = errorOutput.split(this._inputLineEnding);
        let error = {
            file: null,
            line: null,
            type: null,
            message: null,
            errno: null,
        };
        if (errorLines.length > 0) {
            error.file = errorLines[1].match(/File "(.*)"/)[1];
            error.line = parseInt(errorLines[1].match(/line (\d+)/)[1]);
            error.type = errorLines[2].match(/(.+?):/)[1];
            error.message = errorLines[2].match(/: (.+)$/)[1];
            if (error.type == "OSError") {
                error.errno = parseInt(error.message.match(/\[Errno (\d+)\]/)[1]);
                error.message = error.message.replace(/\[Errno \d+\] /, '');
            }
        }
        error.raw = errorOutput;
        return error;
    }

    getCodeOutput() {
        return this._codeOutput;
    }

    async getToPrompt() {
        // We use GetToPrompt to ensure we are at a known place before running code
        // This will get from Paste Mode or Running App to Normal Prompt
        await this.interruptCode();
        // This will get from Raw Paste or Raw Mode to Normal Prompt
        await this.serialTransmit(CHAR_CTRL_B + CHAR_CTRL_D + CHAR_CTRL_B);
        this._mode = MODE_NORMAL;
    }

    async execRawMode(code) {
        await this.enterRawMode();
        await this.serialTransmit(code);
        return await this.finishRawMode();
    }

    async execRawPasteMode(code, codeTimeoutMs=CODE_EXECUTION_TIMEOUT) {
        let success = await this.enterRawPasteMode();
        //console.log("Success: " + success);
        if (success) {
            // We're in raw mode only
            await this.serialTransmit(code);
            // We need to use flow control
            let flowControlWindowSize = this._readSerialBytes(2);
            // Convert 2 bytes from unsigned little endian to an integer
            flowControlWindowSize = flowControlWindowSize.charCodeAt(0) + (flowControlWindowSize.charCodeAt(1) << 8);
            let remainingWindowSize = flowControlWindowSize;
            this._readSerialBytes(1); // Skip the last byte
            this._clearSerialBytes(); // Clear the serial buffer to remove the previous Raw Prompt
            //console.log("Flow Control Window Size: " + remainingWindowSize);
            // Send the code in chunks up to the window size
            let codeLength = code.length;
            let codePointer = 0;
            while (codePointer < codeLength) {
                let chunk = code.slice(codePointer, codePointer + remainingWindowSize);
                await this.serialTransmit(chunk);
                codePointer += remainingWindowSize;
                // Reduce the remain window size
                remainingWindowSize -= chunk.length;
                if (remainingWindowSize <= 0) {
                    // Read the next byte at the flow control pointer
                    let instruction = this._readSerialBytes(1);
                    if (instruction.match(CHAR_CTRL_A)) {
                        remainingWindowSize = flowControlWindowSize;
                    } else if (instruction.match(CHAR_CTRL_D)) {
                        // We're done
                        break;
                    }
                }
            }
            // Inform the device we're done
            await this.serialTransmit(CHAR_CTRL_D);
            this._ctrlDCount = 0;
            this._pythonCodeRunning = true;
            this._codeOutput = '';
            this._errorOutput = '';
            await this._waitForCodeExecution(codeTimeoutMs);
            this._clearSerialBytes();
            await this.exitRawMode();
            return this._codeOutput.slice(Math.ceil(this._codeOutput.length / 2));
        } else {
            await this.execRawMode(code);
        }
    }

    async _waitForCodeExecution(codeTimeoutMs=CODE_EXECUTION_TIMEOUT) {
        // Wait for the code to finish running, so we can capture the output
        if (codeTimeoutMs) {
            try {
                await this._timeout(
                    async () => {
                        while (this._pythonCodeRunning) {
                            await this._sleep(100);
                        }
                    }, codeTimeoutMs
                );
            } catch (error) {
                console.log("Code timed out.");
            }
        } else {
            // Run without timeout
            while (this._pythonCodeRunning) {
                await this._sleep(100);
            }
        }
    }

    _readSerialBytes(byteCount, offset=null) {
        if (offset == null) {
            offset = this._promptCheckPointer;
        }
        let bytes = this._serialInputBuffer.slice(offset, offset + byteCount);
        this._promptCheckPointer += byteCount;
        return bytes;
    }

    _clearSerialBytes(offset=null) {
        // Should this only clear up to the lower of the 2 pointers? (codeCheckPointer and promptCheckPointer)
        if (offset == null) {
            offset = this._promptCheckPointer;
        }
        if (offset > this._serialInputBuffer.length) {
            offset = this._serialInputBuffer.length;
        }

        this._serialInputBuffer = this._serialInputBuffer.slice(offset);
        this._promptCheckPointer -= offset;
        this._codeCheckPointer -= offset;
    }

    async enterRawPasteMode() {
        await this.enterRawMode();
        let bufferLength = this._serialInputBuffer.length;
        await this.serialTransmit(CHAR_CTRL_E + "A" + CHAR_CTRL_A);
        await this._timeout(
            async () => {
                while (this._serialInputBuffer.length < bufferLength + 2) {
                    await this._sleep(100);
                }
            }, this.promptTimeout
        );
        if (this._serialInputBuffer.length < bufferLength + 2) {
            console.error("Failed to enter raw paste mode.");
            return;
        }
        // Grab the two characters after bufferLength
        let response = this._readSerialBytes(2, bufferLength);

        if (response.match(CHAR_RAW_PASTE_UNSUPPORTED)) {
            console.error("Device does not support raw paste mode.");
        } else if (response.match(CHAR_RAW_PASTE_SUPPORTED)) {
            this._mode = MODE_RAWPASTE;
            return true;
        } else if (response == "ra") {
            console.error("Device does not understand or support raw paste mode.");
        }

        return false;
    }

    // Execute pasted code
    async finishRawMode() {
        this._pythonCodeRunning = true;
        this._codeOutput = '';
        this._errorOutput = '';
        await this.serialTransmit(CHAR_CTRL_D);

        // Wait for the code to finish running, so we can capture the output
        await this._waitForCodeExecution();

        this._mode = MODE_NORMAL;
        return this._codeOutput;
    }

    async _waitForModeChange(mode) {
        await this._timeout(
            async () => {
                while (this._mode != mode) {
                    this._checkForModeChange();
                    await this._sleep(100);
                }
            }, this.promptTimeout
        );
    }

    // Raw mode allows code execution without echoing back to the terminal
    async enterRawMode() {
        if (this._mode == MODE_RAW) {
            return;
        }
        await this.getToPrompt();
        await this.serialTransmit(CHAR_CTRL_A);
        await this._waitForModeChange(MODE_RAW);
    }

    async exitRawMode() {
        await this.serialTransmit(CHAR_CTRL_B);
        // Wait for >>> to be displayed
        this._mode = MODE_NORMAL;
    }

    _getSerialCodeOutput() {
        let bufferLines, codeline = '';
        // Get the remaining buffer from _codeCheckPointer to the next line ending and update the position of the pointer
        let remainingBuffer = this._serialInputBuffer.slice(this._codeCheckPointer);
        if (remainingBuffer.includes(this._inputLineEnding)) {
            [codeline, ...bufferLines] = remainingBuffer.split(this._inputLineEnding);
            this._codeCheckPointer += codeline.length + this._inputLineEnding.length;
        }
        return this._formatCodeOutput(codeline);
    }

    _formatCodeOutput(codeline) {
        // Remove lines that are prompts or control characters and strip control sequences
        // Return the result
        for (let prefix of IGNORE_OUTPUT_LINE_PREFIXES) {
            if (codeline.match(prefix)) {
                return '';
            }
        }
        for (let sequence of CONTROL_SEQUENCES) {
            codeline = codeline.replace(sequence, '');
        }
        return codeline;
    }

    async onSerialReceive(e) {
        // We tokenize the serial data to handle special character sequences (currently titles only)
        // We don't want to modify e.data, so we make a copy of it
        let data = e.data;

        // Prepend a partial token if it exists
        if (this._partialToken) {
            data = this._partialToken + data;
            this._partialToken = null;
        }

        // Tokenize the larger string and send to the parent
        let tokens = this._tokenize(data);

        // Remove any partial tokens and store for the next serial data receive
        if (tokens.length && this._hasPartialToken(tokens.slice(-1))) {
            this._partialToken = tokens.pop();
        }

        // Send only full tokens to the token queue
        for (let token of tokens) {
            this._tokenQueue.push(token);
        }
        await this._processQueuedTokens();
        if (this.terminalOutput) {
            return data;
        }

        return "";
    }

    async _processQueuedTokens() {
        if (this._processing) {
            return;
        }
        this._processing = true;
        while (this._tokenQueue.length) {
            await this._processToken(this._tokenQueue.shift());
        }
        this._processing = false;
    }

    async _processToken(token) {
        if (token == CHAR_TITLE_START) {
            this._titleMode = true;
            //console.log("Title Start");
            this._setTitle("");
        } else if (token == CHAR_TITLE_END) {
            //console.log("Title End");
            this._titleMode = false;
        } else if (this._titleMode) {
            //console.log("New Title: " + token);
            this._setTitle(token, true);
        }

        let codelines = [];
        let codeline;
        this._serialInputBuffer += token;
        if (this._pythonCodeRunning) {
            // Check if we are at a prompt
            this.checkPrompt(); // Run asynchronously to avoid blocking the serial receive

            if (this._mode != MODE_RAWPASTE) {
                do {
                    codeline = this._getSerialCodeOutput();
                    if (codeline) {
                        codelines.push(codeline);
                    }
                } while (codeline.length > 0);
            }
        }

        // Is it still running? Then we add to code output if there is any
        if (this._pythonCodeRunning && codelines.length > 0) {
            for (codeline of codelines) {
                //console.log(codeline);
                if (!codeline.match(/^\... /) && !codeline.match(/^>>> /) && !codeline.match(/^=== /)) {
                    if (this._mode != MODE_RAWPASTE) {
                        if (codeline.match(REGEX_PROMPT_RAW_MODE)) {
                            this._mode = MODE_RAW;
                            continue;
                        }
                    }
                    this._codeOutput += codeline + this._outputLineEnding;
                }
            }
        }
    }

    // Placeholder Function
    setTitle(title, append=false) {
        return;
    }

    _setTitle(title, append=false) {
        if (append) {
            title = this.title + title;
        }

        this.title = title;

        this.setTitle(title, append);
    }

    getVersion() {
        return this._parseTitleInfo(/\| REPL \| (.*)$/);
    }

    getIpAddress() {
        return this._parseTitleInfo(/((?:\d{1,3}\.){3}\d{1,3})/);
    }

    _parseTitleInfo(regex) {
        if (this.title) {
            let matches = this.title.match(regex);
            if (matches && matches.length >= 2) {
                return matches[1];
            }
        }

        return null;
    }

    async _serialTransmit(msg) {
        if (!this.serialTransmit) {
            console.log("Default serial transmit function called. Message: " + msg);
            throw new Error("REPL serialTransmit must be connected to an external transmit function");
        } else {
            return await this.serialTransmit(msg);
        }
    }

    // Allows for supplied python code to be run on the device via the REPL in normal mode
    async runCode(code, codeTimeoutMs=CODE_EXECUTION_TIMEOUT) {
        await this.getToPrompt();
        return this.execRawPasteMode(code + LINE_ENDING_LF, codeTimeoutMs);
    }

    // Split a string up by full title start and end character sequences
    _tokenize(string) {
        const tokenRegex = new RegExp("(" + this._regexEscape(CHAR_TITLE_START) + "|" + this._regexEscape(CHAR_TITLE_END) + "|" + this._regexEscape(CHAR_CTRL_D) + ")", "gi");
        return string.split(tokenRegex);
    }

    // Check if a chunk of data has a partial title start/end character sequence at the end
    _hasPartialToken(chunk) {
        const partialToken = /\\x1b(?:\](?:0"?)?)?$/gi;
        return partialToken.test(chunk);
    }
}