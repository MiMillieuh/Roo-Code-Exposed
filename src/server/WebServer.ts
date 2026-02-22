import * as http from "http"
import * as fs from "fs"
import * as path from "path"
import { WebSocketServer, WebSocket } from "ws"
import * as vscode from "vscode"

import type { ExtensionMessage } from "@roo-code/types"
import type { WebviewMessage } from "../shared/WebviewMessage"

const DEFAULT_WEB_SERVER_PORT = 30000

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".eot": "application/vnd.ms-fontobject",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
}

export type MessageFromExtension = ExtensionMessage
export type MessageFromWebview = WebviewMessage

export type WebServerMessageHandler = (message: MessageFromWebview) => Promise<void>
export type WebServerToolbarActionHandler = (action: string) => Promise<void>

/**
 * WebServer serves the Roo Code webview UI on port 30000 and bridges
 * WebSocket messages between browser clients and the VSCode extension.
 */
export class WebServer {
	private httpServer: http.Server | null = null
	private wss: WebSocketServer | null = null
	private clients: Set<WebSocket> = new Set()
	private messageHandler: WebServerMessageHandler | null = null
	private toolbarActionHandler: WebServerToolbarActionHandler | null = null
	private extensionUri: vscode.Uri
	private outputChannel: vscode.OutputChannel
	private port: number = DEFAULT_WEB_SERVER_PORT
	private password: string = ""

	constructor(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
		this.extensionUri = extensionUri
		this.outputChannel = outputChannel
	}

	public getPort(): number {
		return this.port
	}

	public configure(port: number, password: string): void {
		this.port = port > 0 ? port : DEFAULT_WEB_SERVER_PORT
		this.password = password ?? ""
	}

	public setMessageHandler(handler: WebServerMessageHandler): void {
		this.messageHandler = handler
	}

	public setToolbarActionHandler(handler: WebServerToolbarActionHandler): void {
		this.toolbarActionHandler = handler
	}

	public isRunning(): boolean {
		return this.httpServer !== null && this.httpServer.listening
	}

	/**
	 * Broadcast a message from the extension to all connected browser clients.
	 */
	public broadcastToClients(message: MessageFromExtension): void {
		if (this.clients.size === 0) {
			return
		}
		const data = JSON.stringify({ type: "extension-message", payload: message })
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(data)
			}
		}
	}

	public async start(): Promise<void> {
		if (this.isRunning()) {
			this.outputChannel.appendLine("[WebServer] Already running.")
			return
		}

		const buildDir = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "build").fsPath
		const assetsDir = vscode.Uri.joinPath(this.extensionUri, "assets").fsPath
		const audioDir = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "audio").fsPath

		this.httpServer = http.createServer((req, res) => {
			this.handleRequest(req, res, buildDir, assetsDir, audioDir)
		})

		this.wss = new WebSocketServer({ server: this.httpServer })

		this.wss.on("connection", (ws) => {
			this.clients.add(ws)
			this.outputChannel.appendLine(`[WebServer] Browser client connected. Total clients: ${this.clients.size}`)

			ws.on("message", async (data) => {
				try {
					const parsed = JSON.parse(data.toString())
					// Messages from browser are wrapped as { type: "webview-message", payload: WebviewMessage }
					if (parsed.type === "webview-message" && parsed.payload && this.messageHandler) {
						await this.messageHandler(parsed.payload as MessageFromWebview)
					}
					// Toolbar action messages: { type: "toolbar-action", action: string }
					// These trigger extension-side actions and broadcast the result back to all clients
					if (parsed.type === "toolbar-action" && parsed.action && this.toolbarActionHandler) {
						await this.toolbarActionHandler(parsed.action as string)
					}
				} catch (err) {
					this.outputChannel.appendLine(`[WebServer] Error handling WebSocket message: ${err}`)
				}
			})

			ws.on("close", () => {
				this.clients.delete(ws)
				this.outputChannel.appendLine(
					`[WebServer] Browser client disconnected. Total clients: ${this.clients.size}`,
				)
			})

			ws.on("error", (err) => {
				this.outputChannel.appendLine(`[WebServer] WebSocket error: ${err}`)
				this.clients.delete(ws)
			})
		})

		await new Promise<void>((resolve, reject) => {
			this.httpServer!.listen(this.port, "0.0.0.0", () => {
				this.outputChannel.appendLine(
					`[WebServer] Roo Code web server started on http://0.0.0.0:${this.port}`,
				)
				resolve()
			})
			this.httpServer!.on("error", (err) => {
				this.outputChannel.appendLine(`[WebServer] Failed to start server: ${err}`)
				reject(err)
			})
		})
	}

	public async stop(): Promise<void> {
		if (!this.isRunning()) {
			return
		}

		// Close all WebSocket connections
		for (const client of this.clients) {
			client.terminate()
		}
		this.clients.clear()

		// Close WebSocket server
		await new Promise<void>((resolve) => {
			this.wss?.close(() => resolve())
		})
		this.wss = null

		// Close HTTP server
		await new Promise<void>((resolve, reject) => {
			this.httpServer?.close((err) => {
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			})
		})
		this.httpServer = null

		this.outputChannel.appendLine("[WebServer] Server stopped.")
	}

	private checkBasicAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		if (!this.password) {
			return true // No auth required
		}

		const authHeader = req.headers["authorization"]
		if (authHeader && authHeader.startsWith("Basic ")) {
			const encoded = authHeader.slice("Basic ".length)
			const decoded = Buffer.from(encoded, "base64").toString("utf-8")
			// Accept any username, only check password
			const colonIdx = decoded.indexOf(":")
			const providedPassword = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded
			if (providedPassword === this.password) {
				return true
			}
		}

		// Prompt browser to show login dialog
		res.setHeader("WWW-Authenticate", 'Basic realm="Roo Code"')
		res.writeHead(401, { "Content-Type": "text/plain" })
		res.end("Unauthorized")
		return false
	}

	private handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		buildDir: string,
		assetsDir: string,
		audioDir: string,
	): void {
		const url = req.url || "/"

		// Set CORS headers to allow access from any origin
		res.setHeader("Access-Control-Allow-Origin", "*")
		res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
		res.setHeader("Access-Control-Allow-Headers", "Content-Type")

		if (req.method === "OPTIONS") {
			res.writeHead(204)
			res.end()
			return
		}

		// Enforce basic auth if a password is configured
		if (!this.checkBasicAuth(req, res)) {
			return
		}

		// Parse the URL path
		const urlPath = url.split("?")[0]

		// Route /ext-assets/* to the extension assets directory
		if (urlPath.startsWith("/ext-assets/")) {
			const assetPath = path.join(assetsDir, urlPath.slice("/ext-assets/".length))
			this.serveFile(res, assetPath)
			return
		}

		// Route /audio/* to the webview-ui audio directory
		if (urlPath.startsWith("/audio/")) {
			const audioPath = path.join(audioDir, urlPath.slice("/audio/".length))
			this.serveFile(res, audioPath)
			return
		}

		// Serve the custom index.html for root or SPA routes (no file extension)
		if (urlPath === "/" || !path.extname(urlPath)) {
			this.serveIndexHtml(res, buildDir)
			return
		}

		// Serve static files from build directory
		const filePath = path.join(buildDir, urlPath)

		// Check if file exists, otherwise serve index.html for SPA routing
		if (!fs.existsSync(filePath)) {
			this.serveIndexHtml(res, buildDir)
			return
		}

		this.serveFile(res, filePath)
	}

	/**
	 * Serve a custom index.html that sets up the correct asset URIs for browser access.
	 * The built webview-ui uses window.IMAGES_BASE_URI, AUDIO_BASE_URI, and
	 * MATERIAL_ICONS_BASE_URI globals which need to point to our HTTP server paths.
	 * Also injects a toolbar with action buttons at the top of the page.
	 */
	private serveIndexHtml(res: http.ServerResponse, buildDir: string): void {
		try {
			// The vite build always produces index.js and index.css as the main entry points
			const assetsDir = path.join(buildDir, "assets")
			const jsFile = fs.existsSync(path.join(assetsDir, "index.js")) ? "/assets/index.js" : ""
			const cssFile = fs.existsSync(path.join(assetsDir, "index.css")) ? "/assets/index.css" : ""

			const html = `<!DOCTYPE html>
	<html lang="en">
			<head>
			  <meta charset="utf-8">
			  <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
			  <meta name="theme-color" content="#1e1e1e">
			  <title>Roo Code</title>
			  ${cssFile ? `<link rel="stylesheet" type="text/css" href="${cssFile}">` : ""}
			  <link href="/ext-assets/codicons/codicon.css" rel="stylesheet" />
			  <style>
			    /* Dark mode VSCode-like CSS variables */
			    :root {
			      color-scheme: dark;
			      --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			      --vscode-font-size: 13px;
			      --vscode-editor-background: #1e1e1e;
			      --vscode-editor-foreground: #d4d4d4;
			      --vscode-foreground: #cccccc;
			      --vscode-sideBar-background: #252526;
			      --vscode-sideBar-foreground: #cccccc;
			      --vscode-sideBar-border: #2d2d2d;
			      --vscode-titleBar-activeBackground: #3c3c3c;
			      --vscode-titleBar-activeForeground: #cccccc;
			      --vscode-titleBar-border: #2d2d2d;
			      --vscode-button-background: #0e639c;
			      --vscode-button-foreground: #ffffff;
			      --vscode-button-hoverBackground: #1177bb;
			      --vscode-button-secondaryBackground: #3a3d41;
			      --vscode-button-secondaryForeground: #cccccc;
			      --vscode-input-background: #3c3c3c;
			      --vscode-input-foreground: #cccccc;
			      --vscode-input-border: #3c3c3c;
			      --vscode-focusBorder: #007fd4;
			      --vscode-badge-background: #4d4d4d;
			      --vscode-badge-foreground: #cccccc;
			      --vscode-list-hoverBackground: #2a2d2e;
			      --vscode-list-hoverForeground: #cccccc;
			      --vscode-list-activeSelectionBackground: #094771;
			      --vscode-list-activeSelectionForeground: #ffffff;
			      --vscode-list-focusBackground: #062f4a;
			      --vscode-scrollbarSlider-background: rgba(121,121,121,0.4);
			      --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,0.7);
			      --vscode-scrollbarSlider-activeBackground: rgba(191,191,191,0.4);
			      --vscode-toolbar-hoverBackground: rgba(90,93,94,0.31);
			      --vscode-toolbar-activeBackground: rgba(99,102,103,0.31);
			      --vscode-descriptionForeground: #8b949e;
			      --vscode-errorForeground: #f48771;
			      --vscode-textLink-foreground: #3794ff;
			      --vscode-textCodeBlock-background: #1e1e1e;
			      --vscode-menu-background: #252526;
			      --vscode-menu-foreground: #cccccc;
			      --vscode-notifications-background: #252526;
			      --vscode-notifications-foreground: #cccccc;
			      --vscode-notifications-border: #2d2d2d;
			      --vscode-panel-border: #2d2d2d;
			      --vscode-editorGroup-border: #444444;
			      --vscode-editorWarning-foreground: #cca700;
			      --vscode-editorWarning-background: rgba(204,167,0,0.1);
			      --vscode-dropdown-background: #3c3c3c;
			      --vscode-dropdown-foreground: #cccccc;
			      --vscode-dropdown-border: #3c3c3c;
			      --vscode-disabledForeground: rgba(204,204,204,0.5);
			      --vscode-widget-border: #454545;
			      --vscode-widget-shadow: rgba(0,0,0,0.36);
			      --vscode-charts-red: #f14c4c;
			      --vscode-charts-blue: #3794ff;
			      --vscode-charts-yellow: #cca700;
			      --vscode-charts-orange: #d18616;
			      --vscode-charts-green: #89d185;
			      --vscode-diffEditor-insertedTextBackground: rgba(9,73,11,0.4);
			      --vscode-diffEditor-removedTextBackground: rgba(94,0,0,0.4);
			      --vscode-inputValidation-infoBackground: #063b49;
			      --vscode-inputValidation-infoBorder: #007acc;
			      --vscode-inputValidation-infoForeground: #cccccc;
			      --vscode-inputValidation-warningBackground: #352a05;
			      --vscode-inputValidation-warningBorder: #b89500;
			      --vscode-inputValidation-warningForeground: #cccccc;
			      --vscode-editorHoverWidget-background: #252526;
			      --vscode-editorHoverWidget-foreground: #cccccc;
			      --vscode-editorHoverWidget-border: #454545;
			      --vscode-banner-background: #04395e;
			      --vscode-banner-foreground: #cccccc;
			      --vscode-sideBarSectionHeader-background: #00000000;
			      --vscode-sideBarSectionHeader-foreground: #cccccc;
			      --vscode-sideBarSectionHeader-border: rgba(204,204,204,0.2);
			    }
			    #roo-web-toolbar {
			      display: flex;
			      align-items: center;
			      gap: 4px;
			      padding: 4px 8px;
			      background: var(--vscode-titleBar-activeBackground, #3c3c3c);
			      border-bottom: 1px solid var(--vscode-titleBar-border, #2d2d2d);
			      position: sticky;
			      top: 0;
			      z-index: 9999;
			      flex-shrink: 0;
			    }
			    #roo-web-toolbar .roo-tb-btn {
			      display: flex;
			      align-items: center;
			      justify-content: center;
			      width: 28px;
			      height: 28px;
			      border: none;
			      background: transparent;
			      color: var(--vscode-titleBar-activeForeground, #cccccc);
			      cursor: pointer;
			      border-radius: 4px;
			      font-size: 16px;
			      padding: 0;
			      transition: background 0.15s;
			      text-decoration: none;
			    }
			    #roo-web-toolbar .roo-tb-btn:hover {
			      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
			    }
			    #roo-web-toolbar .roo-tb-btn.active {
			      background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.18));
			    }
			    #roo-web-toolbar .roo-tb-separator {
			      width: 1px;
			      height: 20px;
			      background: var(--vscode-titleBar-border, #2d2d2d);
			      margin: 0 4px;
			    }
			    #roo-web-toolbar .roo-tb-title {
			      font-size: 12px;
			      font-weight: 600;
			      color: var(--vscode-titleBar-activeForeground, #cccccc);
			      margin-right: 4px;
			      font-family: var(--vscode-font-family, sans-serif);
			      letter-spacing: 0.5px;
			    }
			    #roo-web-toolbar .roo-tb-spacer {
			      flex: 1;
			    }
			    #roo-web-toolbar .roo-tb-status {
			      font-size: 11px;
			      color: var(--vscode-descriptionForeground, #8b949e);
			      font-family: var(--vscode-font-family, sans-serif);
			    }
			    html, body {
			      margin: 0;
			      padding: 0;
			      height: 100%;
			      display: flex;
			      flex-direction: column;
			      background-color: var(--vscode-editor-background, #1e1e1e);
			      color: var(--vscode-editor-foreground, #d4d4d4);
			      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
			      font-size: var(--vscode-font-size, 13px);
			    }
			    #root {
			      flex: 1;
			      overflow: auto;
			      min-height: 0;
			      background-color: var(--vscode-editor-background, #1e1e1e);
			    }
			  </style>
	   <script>
	     window.IMAGES_BASE_URI = "/ext-assets/images"
	     window.AUDIO_BASE_URI = "/audio"
	     window.MATERIAL_ICONS_BASE_URI = "/ext-assets/vscode-material-icons/icons"
	   </script>
	 </head>
	 <body>
	   <div id="roo-web-toolbar">
	     <span class="roo-tb-title">Roo Code</span>
	     <div class="roo-tb-separator"></div>
	     <button class="roo-tb-btn" id="roo-btn-new-task" title="New Task">
	       <i class="codicon codicon-edit"></i>
	     </button>
	     <button class="roo-tb-btn" id="roo-btn-history" title="Task History">
	       <i class="codicon codicon-history"></i>
	     </button>
	     <button class="roo-tb-btn" id="roo-btn-marketplace" title="Marketplace">
	       <i class="codicon codicon-extensions"></i>
	     </button>
	     <div class="roo-tb-separator"></div>
	     <button class="roo-tb-btn" id="roo-btn-settings" title="Settings">
	       <i class="codicon codicon-settings-gear"></i>
	     </button>
	     <button class="roo-tb-btn" id="roo-btn-cloud" title="Cloud">
	       <i class="codicon codicon-cloud"></i>
	     </button>
	     <div class="roo-tb-spacer"></div>
	     <span class="roo-tb-status" id="roo-ws-status">Connecting...</span>
	   </div>
	   <noscript>You need to enable JavaScript to run this app.</noscript>
	   <div id="root"></div>
	   <script>
	     (function() {
	       var ws = null;
	       var reconnectTimer = null;
	       var statusEl = document.getElementById('roo-ws-status');

	       function setStatus(text, color) {
	         if (statusEl) {
	           statusEl.textContent = text;
	           statusEl.style.color = color || '';
	         }
	       }

	       function connect() {
	         var wsUrl = 'ws://' + window.location.host;
	         ws = new WebSocket(wsUrl);

	         ws.addEventListener('open', function() {
	           setStatus('Connected', '#4ec9b0');
	         });

	         ws.addEventListener('close', function() {
	           setStatus('Disconnected', '#f48771');
	           ws = null;
	           if (reconnectTimer) clearTimeout(reconnectTimer);
	           reconnectTimer = setTimeout(connect, 2000);
	         });

	         ws.addEventListener('error', function() {
	           setStatus('Error', '#f48771');
	         });

	         ws.addEventListener('message', function(event) {
	           try {
	             var data = JSON.parse(event.data);
	             if (data.type === 'extension-message' && data.payload) {
	               window.dispatchEvent(new MessageEvent('message', { data: data.payload }));
	             }
	           } catch(e) {}
	         });
	       }

	       function sendToolbarAction(action) {
	         if (ws && ws.readyState === WebSocket.OPEN) {
	           ws.send(JSON.stringify({ type: 'toolbar-action', action: action }));
	         }
	       }

	       // Wire up toolbar buttons
	       document.getElementById('roo-btn-new-task').addEventListener('click', function() {
	         sendToolbarAction('newTask');
	       });
	       document.getElementById('roo-btn-history').addEventListener('click', function() {
	         sendToolbarAction('history');
	       });
	       document.getElementById('roo-btn-marketplace').addEventListener('click', function() {
	         sendToolbarAction('marketplace');
	       });
	       document.getElementById('roo-btn-settings').addEventListener('click', function() {
	         sendToolbarAction('settings');
	       });
	       document.getElementById('roo-btn-cloud').addEventListener('click', function() {
	         sendToolbarAction('cloud');
	       });

	       connect();

	       // Expose ws for the vscode.ts wrapper to use
	       window.__rooWebSocket = {
	         getWs: function() { return ws; },
	         send: function(msg) {
	           if (ws && ws.readyState === WebSocket.OPEN) {
	             ws.send(JSON.stringify({ type: 'webview-message', payload: msg }));
	           }
	         }
	       };
	     })();
	   </script>
	   ${jsFile ? `<script type="module" src="${jsFile}"></script>` : ""}
	 </body>
</html>`

			res.writeHead(200, { "Content-Type": "text/html" })
			res.end(html)
		} catch (err) {
			this.outputChannel.appendLine(`[WebServer] Error serving index.html: ${err}`)
			res.writeHead(500, { "Content-Type": "text/plain" })
			res.end("Internal Server Error")
		}
	}

	private serveFile(res: http.ServerResponse, filePath: string): void {
		try {
			if (!fs.existsSync(filePath)) {
				res.writeHead(404, { "Content-Type": "text/plain" })
				res.end("Not Found")
				return
			}

			const ext = path.extname(filePath).toLowerCase()
			const contentType = MIME_TYPES[ext] || "application/octet-stream"
			const content = fs.readFileSync(filePath)

			res.writeHead(200, { "Content-Type": contentType })
			res.end(content)
		} catch (err) {
			this.outputChannel.appendLine(`[WebServer] Error serving file ${filePath}: ${err}`)
			res.writeHead(500, { "Content-Type": "text/plain" })
			res.end("Internal Server Error")
		}
	}
}
