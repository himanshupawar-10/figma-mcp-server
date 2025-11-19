# Figma MCP Server

Minimal local MCP (Model Context Protocol) server that exposes a few Figma-related tools to LLM clients (e.g., Claude Desktop, Cursor) over stdio. It can list projects/files, fetch file JSON (or nodes), and generate a simple React+Vite frontend from a Figma frame.

## Quick summary
- Exposes 4 tools over stdio:
  - list_projects — list projects for a Figma team
  - list_project_files — list files in a Figma project
  - get_file — fetch full file JSON or specified nodes
  - generate_frontend — generate simple React+Vite files from a Figma frame
- Built with @modelcontextprotocol/sdk and Zod for schemas.
- Intended to be launched by an LLM client which speaks MCP over stdio.

## Prerequisites
- Node.js 18+ (native fetch)
- npm
- A Figma personal access token (optional for discovery; required for calls that access Figma)
- Claude Desktop / another MCP-capable client to spawn the process

## Install
From the project root:
```powershell
npm install
```

Optionally create a `.env`:
```
FIGMA_TOKEN=your_figma_personal_access_token
```

## Run (manual)
- Windows cmd:
```cmd
set FIGMA_TOKEN=your_token
node server.js
```
- PowerShell:
```powershell
$env:FIGMA_TOKEN = "your_token"
node server.js
```

Note: the process will open stdio transport and wait for an LLM client to connect; it does not expose an HTTP port.

## Configure Claude Desktop (stdio transport)
1. Add a new MCP server entry in Claude Desktop.
2. Program/Command: `node`
3. Arguments: `["C:\\Users\\PawarMrHimanshuMahes\\Desktop\\Projects\\Figma_MCP\\server.js"]`
4. Working directory: `C:\Users\PawarMrHimanshuMahes\Desktop\Projects\Figma_MCP`
5. Ensure the client spawns the process (stdio). If tools don't appear:
   - Run `node server.js` manually to verify the process stays running and emits no immediate error.
   - Confirm Node >= 18.
   - Confirm the path / args are correct and tools are registered before connect().

## Tool reference

- list_projects
  - Input: { team_id: string, token?: string }
  - Output: { projects: [{ id: string, name: string, last_modified?: string }] }

- list_project_files
  - Input: { project_id: string, token?: string }
  - Output: { files: [{ id: string, name: string, thumbnailUrl?: string }] }

- get_file
  - Input: { file_id: string, node_ids?: string[], token?: string }
  - Output: { file: any }  — full Figma file JSON or nodes response

- generate_frontend
  - Input: { file_id: string, node_id?: string, token?: string, framework?: "react"|"html" }
  - Output: { files: Record<string, string> } — generated filename → content

Handlers return both:
- content: text blocks for the LLM view
- structuredContent: validated data for client UI

## How the stdio / MCP handshake works (high level)
- Client launches `node server.js` and opens stdio pipes.
- Server instantiates McpServer, registers tools (with Zod schemas), then calls `server.connect(transport)`.
- Client sends initialize; server answers with name/version and tool metadata.
- Client calls `tools/list` to discover tools (serialized from Zod schemas).
- When a tool is invoked (`tools/call`), the SDK validates inputs, runs the handler, and returns content + structuredContent.

Important: register tools before calling `server.connect()` so discovery works.

## Troubleshooting
- "No tools" in client:
  - Ensure input/output schemas are Zod objects (z.object(...)) — malformed schemas break discovery.
  - Confirm registerTool calls run before `server.connect`.
  - Run `node server.js` manually to capture startup errors.
- Figma API errors:
  - Ensure `FIGMA_TOKEN` is valid and passed (env or per-call).
  - Check Figma rate limits and error payloads.
- Node issues:
  - Use Node 18+ so fetch is available; the project is ESM (`"type":"module"` in package.json).

## Development notes
- Key generator helpers are in `server.js`:
  - figmaFetch, color utilities, findFrameNode, nodeToJsx, traverseAndGenerate, reactAppFromFrame, generateFilesFromFigmaFile.
- To improve fidelity:
  - Expand nodeToJsx to support more Figma node types, fonts and layout behaviors.
  - Add logging (console or a logger) for handler entry/exit and Figma responses.
- To test locally: call tools via an MCP-capable client or temporarily add a CLI/testing harness that calls the handlers directly.

## Running generated frontend
- generate_frontend returns files (App.jsx, index.html, package.json, etc.).
- To run a generated React app:
  - Save files into a new directory, run `npm install` then `npm run dev` (Vite).
  - Open the dev URL (typically http://localhost:5173).

## Files of interest
- server.js — MCP server + tool implementations and Figma helpers
- package.json / package-lock.json — dependencies
- readme.md — this document

## License
MIT