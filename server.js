#!/usr/bin/env node
/**
 * figma-mcp server.js
 *
 * Minimal MCP server exposing Figma tools:
 *  - list_projects (team)
 *  - list_project_files (project)
 *  - get_file (file JSON or specific nodes)
 *  - generate_frontend (fetches Figma JSON and returns generated frontend files)
 *
 * Usage:
 *   FIGMA_TOKEN=your_token node server.js
 *
 * In Claude Desktop config, point an MCP server entry at this script (stdio transport).
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Node 18+ has fetch; if your Node doesn't, uncomment the following line
// import fetch from 'node-fetch';

const FIGMA_API_BASE = 'https://api.figma.com/v1';

function figmaFetch(path, token, qs = '') {
  const url = `${FIGMA_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  return fetch(url, {
    headers: {
      'X-Figma-Token': token
    }
  });
}

function colorObjToRgba(c, a = 1) {
  // Figma colors are { r,g,b } floats 0..1
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const alpha = typeof a === 'number' ? a : 1;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fillToCssColor(fill) {
  if (!fill) return null;
  if (fill.type === 'SOLID' && fill.color) {
    const a = (typeof fill.opacity === 'number') ? fill.opacity : (fill.opacity ?? 1);
    return colorObjToRgba(fill.color, a);
  }
  return null;
}

function escapeJsxText(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// find first FRAME node (by recursion) or find node by id
function findFrameNode(documentNode, nodeId = null) {
  if (nodeId) {
    // search by id
    let stack = [documentNode];
    while (stack.length) {
      const n = stack.shift();
      if (!n) continue;
      if (n.id === nodeId) return n;
      if (n.children) stack.push(...n.children);
    }
    return null;
  }
  // else find first FRAME under pages -> children
  if (!documentNode.children) return null;
  for (const page of documentNode.children) {
    if (!page.children) continue;
    for (const child of page.children) {
      if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'INSTANCE' || child.type === 'GROUP' || child.type === 'RECTANGLE') {
        return child;
      }
    }
  }
  // fallback: traverse for any FRAME deeper
  let stack = [...(documentNode.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.type === 'FRAME') return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

function nodeToJsx(node, frameBox) {
  // node.absoluteBoundingBox may be undefined for some nodes; guard
  const box = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.round(box.x - (frameBox?.x || 0));
  const top = Math.round(box.y - (frameBox?.y || 0));
  const width = Math.round(box.width || 0);
  const height = Math.round(box.height || 0);

  let styleParts = [
    `position: 'absolute'`,
    `left: ${left}px`,
    `top: ${top}px`,
    `width: ${width}px`,
    `height: ${height}px`
  ];

  // background fill
  let bg = null;
  if (Array.isArray(node.fills) && node.fills.length > 0) {
    const cssC = fillToCssColor(node.fills[0]);
    if (cssC) bg = cssC;
  }

  if (bg) styleParts.push(`background: '${bg}'`);

  // basic element for TEXT, else div
  if (node.type === 'TEXT') {
    const text = escapeJsxText(node.characters || '');
    // check font size
    let fontSize = (node.style && node.style.fontSize) ? node.style.fontSize : null;
    if (fontSize) styleParts.push(`fontSize: ${fontSize}px`);
    return `<div style={{${styleParts.join(', ')}}}>${text}</div>`;
  } else {
    // If node has children, we will produce a wrapper and children inserted later by generator recursion.
    const content = (node.children && node.children.length > 0) ? `{/* children inserted by generator */}` : '';
    return `<div style={{${styleParts.join(', ')}}}>${content}</div>`;
  }
}

function traverseAndGenerate(nodes, frameBox) {
  // produce JSX lines for all descendants (flat absolute positioning)
  const jsxParts = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.shift();
    if (!node) continue;
    // For frames/groups with children, we still render each child absolutely; keep flat absolute layout
    jsxParts.push(nodeToJsx(node, frameBox));
    if (node.children && node.children.length) stack.push(...node.children);
  }
  return jsxParts.join('\n');
}

function reactAppFromFrame(frameNode) {
  const frameBox = frameNode.absoluteBoundingBox || { x: 0, y: 0, width: 800, height: 600 };
  // We will render all top-level children absolutely positioned inside a relative container sized to frame
  const children = frameNode.children || [];
  const childrenJsx = traverseAndGenerate(children, frameBox);

  const react = `import React from "react";

export default function App() {
  return (
    <div style={{ position: 'relative', width: ${Math.round(frameBox.width)} , height: ${Math.round(frameBox.height)}, border: '1px solid #e5e7eb' }}>
      ${childrenJsx}
    </div>
  );
}
`;
  return react;
}

async function generateFilesFromFigmaFile(fileJson, nodeId = null, opts = {}) {
  // find the frame to generate from
  const doc = fileJson.document;
  const frame = findFrameNode(doc, nodeId);
  if (!frame) {
    // fallback: try first page's first child
    const fallback = (doc.children && doc.children[0] && doc.children[0].children && doc.children[0].children[0]) || null;
    if (!fallback) throw new Error('No frame found in file.');
    // use fallback
    const fallbackJsx = reactAppFromFrame(fallback);
    return {
      'App.jsx': fallbackJsx,
      'README.md': `Generated from Figma file: fallback frame (${fallback.name})`
    };
  } else {
    const appJsx = reactAppFromFrame(frame);
    const pkg = {
      name: "figma-generated-app",
      version: "0.0.0",
      private: true,
      scripts: {
        dev: "vite"
      },
      dependencies: {
        react: "^18.2.0",
        "react-dom": "^18.2.0"
      },
      devDependencies: {
        vite: "^5.0.0"
      }
    };
    const indexHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Figma Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from "react";
      import { createRoot } from "react-dom/client";
      import App from "./App.jsx";
      const root = createRoot(document.getElementById("root"));
      root.render(React.createElement(App));
    </script>
  </body>
</html>
`;

    return {
      'App.jsx': appJsx,
      'index.html': indexHtml,
      'package.json': JSON.stringify(pkg, null, 2),
      'README.md': `This code was auto-generated from a Figma file by a local MCP server.
Run:
  npm install
  npm run dev
Then open: http://localhost:5173 (Vite default)
`
    };
  }
}

/* -------------------------
   Create MCP server & tools
   ------------------------- */
const server = new McpServer({
  name: 'figma-local-mcp',
  version: '0.1.0'
});

// Helper to return Figmas errors nicely as tool errors
function handleFigmaResponse(res) {
  if (!res.ok) throw new Error(`Figma API error ${res.status} ${res.statusText}`);
  return res.json();
}

/* 1) list projects for a team (team_id must be found in Figma UI) */
server.registerTool(
  'list_projects',
  {
    title: 'List Figma projects for a team',
    description: 'Returns a list of projects for the given team id.',
    inputSchema: {
      team_id: z.string(),
      token: z.string().optional()
    },
    outputSchema: {
      projects: z.array(z.object({
        id: z.string(),
        name: z.string(),
        last_modified: z.string().optional()
      }))
    }
  },
  async ({ team_id, token }) => {
    token = token || process.env.FIGMA_TOKEN;
    if (!token) throw new Error('FIGMA token required (pass token or set FIGMA_TOKEN env var).');
    const res = await figmaFetch(`/teams/${team_id}/projects`, token);
    const json = await handleFigmaResponse(res);
    const projects = (json.projects || []).map(p => ({ id: p.id, name: p.name, last_modified: p.last_modified }));
    //return { projects };
    return {
      content: [{ type: 'text', text: JSON.stringify({ projects }, null, 2) }],
      structuredContent: { projects }
    };
  }
);

/* 2) list files in a project */
server.registerTool(
  'list_project_files',
  {
    title: 'List files in a Figma project',
    description: 'Given project_id, returns files in that project',
    inputSchema: {
      project_id: z.string(),
      token: z.string().optional()
    },
    outputSchema:{
      files: z.array(z.object({ id: z.string(), name: z.string(), thumbnailUrl: z.string().optional() }))
    }
  },
  async ({ project_id, token }) => {
    token = token || process.env.FIGMA_TOKEN;
    if (!token) throw new Error('FIGMA token required.');
    const res = await figmaFetch(`/projects/${project_id}/files`, token);
    const json = await handleFigmaResponse(res);
    const files = (json.files || []).map(f => ({ id: f.key, name: f.name, thumbnailUrl: f.thumbnail_url }));
    //return { files };
    return {
      content: [{ type: 'text', text: JSON.stringify({ files }, null, 2) }],
      structuredContent: { files }
    };
  }
);

/* 3) get file JSON (optionally specific node ids) */
server.registerTool(
  'get_file',
  {
    title: 'Fetch Figma file JSON or nodes',
    description: 'Fetches full file JSON or specific nodes if ids provided.',
    inputSchema: {
      file_id: z.string(),
      node_ids: z.array(z.string()).optional(),
      token: z.string().optional()
    },
    outputSchema: {
      file: z.any()
    }
  },
  async ({ file_id, node_ids, token }) => {
    token = token || process.env.FIGMA_TOKEN;
    if (!token) throw new Error('FIGMA token required.');
    if (Array.isArray(node_ids) && node_ids.length > 0) {
      const qs = `ids=${encodeURIComponent(node_ids.join(','))}`;
      const res = await figmaFetch(`/files/${file_id}/nodes`, token, qs);
      const json = await handleFigmaResponse(res);
      //return { file: json };
      return {
        content: [{ type: 'text', text: JSON.stringify({ file: json }, null, 2) }],
        structuredContent: { file: json }
      };
    } else {
      const res = await figmaFetch(`/files/${file_id}`, token);
      const json = await handleFigmaResponse(res);
      //return { file: json };
      return {
        content: [{ type: 'text', text: JSON.stringify({ file: json }, null, 2) }],
        structuredContent: { file: json }
      };
    }
  }
);

/* 4) generate_frontend: the magic tool — fetches the file, converts to simple React files, returns an object of files */
server.registerTool(
  'generate_frontend',
  {
    title: 'Generate frontend code from Figma file',
    description: 'Fetches Figma file JSON in background and returns generated frontend files (React+Vite minimal skeleton).',
    inputSchema: {
      file_id: z.string(),
      node_id: z.string().optional(),
      token: z.string().optional(),
      framework: z.enum(['react','html']).optional()
    },
    outputSchema: {
      files: z.record(z.string())
    }
  },
  async ({ file_id, node_id, token, framework }) => {
    token = token || process.env.FIGMA_TOKEN;
    if (!token) throw new Error('FIGMA token required.');
    // fetch file
    const res = await figmaFetch(`/files/${file_id}`, token);
    const fileJson = await handleFigmaResponse(res);
    // convert to files
    const files = await generateFilesFromFigmaFile(fileJson, node_id || null, { framework: framework || 'react' });
    //return { files };
     return {
      content: [{ type: 'text', text: JSON.stringify({ files }, null, 2) }],
      structuredContent: { files }
    };
  }
);

/* run server over stdio (Claude Desktop will launch this script as a subprocess) */
// async function main() {
//   // Use the stdio transport (most clients spawn the process and talk stdio)
//   const transport = new StdioServerTransport();
//   await server.run({ transport });
//   // server.run will block and handle tool calls
// }
async function main() {
  // Use the stdio transport (Claude Desktop or Cursor will launch this script as a subprocess)
  const transport = new StdioServerTransport();
  await server.connect(transport); // ✅ use connect() instead of run()
}

main().catch(err => {
  console.error('MCP server error:', err);
  process.exit(1);
});
