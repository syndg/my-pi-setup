# Third-party notices

## pi-mcp-adapter

Parts of the MCP connection, OAuth, callback, credential-storage, schema,
search, approval, and output-hardening design were selectively adapted from
`pi-mcp-adapter@2.21.1`, upstream commit
`7dfe06899279832dd320a7c228e48e8a9f503807`:

- Repository: <https://github.com/nicobailon/pi-mcp-adapter>
- Copyright: Copyright (c) 2026 Nico Bailon
- License: MIT

The Code Mode extension is not a runtime consumer of `pi-mcp-adapter` and does
not import its private modules.

MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## just-bash

Code Mode uses `just-bash@3.2.0` as its sandboxed guest runtime. See the
package's bundled `LICENSE` file in `node_modules/just-bash` for its license
terms and notices.

## Model Context Protocol TypeScript SDK

Code Mode uses the official split-v2 packages
`@modelcontextprotocol/client@2.0.0` and
`@modelcontextprotocol/core@2.0.0`. See their bundled `LICENSE` files for
license terms.
