# Attribution

This extension is a **strict Hashline adaptation**, not a claim of full Oh My Pi parity.

It adapts protocol and integration ideas from the MIT-licensed [`@oh-my-pi/hashline`](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline) and Oh My Pi renderer/integration:

- session-local full normalized snapshots and content-derived tags;
- `[path#TAG]` headers and `N:line` read rows;
- seen-row provenance and original-snapshot line ranges;
- replace, delete, insert-before, insert-after, head, and tail operations;
- full preflight before one write; and
- a bounded call projection that hides raw edit protocol and safely degrades to complete-argument preview when provider partial cadence is unavailable.

The structured JSON schema, 64-bit SHA-256 prefix, strict no-recovery semantics, Node filesystem integration, and renderer are maintained here. OMP's text DSL/parser, native hash/recovery, tree-sitter blocks, multi-file edits, diagnostics, and advanced viewport/30fps renderer are not included.

The read/path/image adapters and diff presentation also adapt behavior from Pi 0.82.0's MIT-licensed source. The extension uses the public Pi factories and mutation queue; it does not deep-import Pi internals. The display diff implementation in `diff.ts`, path normalization in `path.ts`, and image MIME detection in `image-mime.ts` identify their adapted origin in source comments.

Runtime diffing uses [`diff` 8.0.4](https://www.npmjs.com/package/diff) (jsdiff), distributed under the BSD-3-Clause license.

## Oh My Pi MIT license

Copyright (c) 2025 Mario Zechner

Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE.

## Pi MIT license

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE.
