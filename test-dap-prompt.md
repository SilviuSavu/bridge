# Test all DAP (Debug Adapter Protocol) bridge handlers

The VS Code MCP Bridge extension at `/Users/savusilviu/bridge` exposes debug capabilities over a Unix socket. You can call these handlers via the socket at `~/Library/Application Support/YuTengjing.vscode-mcp/vscode-mcp-{hash}.sock` (hash is MD5 of the workspace path, first 8 chars).

Use this node helper to call handlers:

```javascript
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const workspacePath = '/Users/savusilviu/bridge';
const hash = crypto.createHash('md5').update(workspacePath).digest('hex').slice(0, 8);
const sock = path.join(os.homedir(), 'Library/Application Support/YuTengjing.vscode-mcp', `vscode-mcp-${hash}.sock`);

function call(id, method, params) {
  return new Promise((resolve) => {
    const client = net.createConnection(sock, () => {
      client.write(JSON.stringify({ id, method, params }));
    });
    client.on('data', d => { resolve(JSON.parse(d.toString())); client.end(); });
    setTimeout(() => { resolve({ error: 'timeout' }); }, 15000);
  });
}
```

## Test files to create

### 1. `test-dap-node.js` (JavaScript — uses built-in `node` debugger)

```javascript
function fibonacci(n) {
  if (n <= 1) return n;
  const a = fibonacci(n - 1);
  const b = fibonacci(n - 2);
  return a + b;
}

function processArray(items) {
  const results = [];
  for (const item of items) {
    const value = fibonacci(item);
    results.push({ input: item, output: value });
  }
  return results;
}

const data = [3, 5, 7];
const output = processArray(data);
console.log(JSON.stringify(output, null, 2));
```

### 2. `test-dap-python.py` (Python — uses `debugpy`)

```python
def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

data = [64, 34, 25, 12, 22, 11, 90]
sorted_data = bubble_sort(data.copy())
print(f"Original: {data}")
print(f"Sorted: {sorted_data}")
```

## Tests to run

### Test 1: debugGetState (no session)
- Call `debugGetState` with `{}`
- Expect: `{ status: "noSession" }`

### Test 2: debugSetBreakpoints
- Set breakpoints in `test-dap-node.js` at lines 2, 10, and 11 (0-indexed)
- Expect: all breakpoints verified

### Test 3: debugGetBreakpoints
- Call `debugGetBreakpoints` with `{}`
- Expect: 3 breakpoints listed with correct file and lines
- Call `debugGetBreakpoints` with `{ filePath: "test-dap-node.js" }`
- Expect: same 3 breakpoints

### Test 4: Conditional breakpoint
- Set a breakpoint at line 11 with `condition: "item === 5"`
- Start debug session and verify it stops only when `item === 5`

### Test 5: debugStart (Node.js)
- Start with: `{ type: "node", request: "launch", name: "test", program: "/Users/savusilviu/bridge/test-dap-node.js" }`
- Expect: `{ success: true, sessionId: "...", sessionName: "..." }`

### Test 6: debugWaitForEvent (breakpoint hit)
- Call `debugWaitForEvent` with `{ timeoutMs: 10000 }`
- Expect: `{ event: "stopped", reason: "breakpoint", threadId: ..., file: "...test-dap-node.js", line: ... }`

### Test 7: debugGetThreads
- Call `debugGetThreads` with `{}`
- Expect: at least one thread with `id` and `name`

### Test 8: debugGetStackTrace
- Call with the threadId from step 6
- Expect: stack frames with `id`, `name`, `source`, `line`, `column`
- Verify the top frame is in `test-dap-node.js`

### Test 9: debugGetScopes
- Call with the `frameId` from the top stack frame
- Expect: scopes array (typically "Local: ...", "Closure", "Global")

### Test 10: debugGetVariables
- Call with the `variablesReference` from the first (local) scope
- Expect: variables with `name`, `value`, `type`, `variablesReference`
- If any variable has `variablesReference > 0`, call `debugGetVariables` again to expand it (test nested objects/arrays)

### Test 11: debugEvaluate
- Evaluate `n` in the current frame — expect a number
- Evaluate `n * 2` — expect computed result
- Evaluate `JSON.stringify({test: true})` — expect a string
- Evaluate with `context: "hover"` — verify it works
- Evaluate with `context: "watch"` — verify it works

### Test 12: debugStepOver
- Call `debugStepOver` then `debugWaitForEvent`
- Verify line number advances by one
- Verify variables update after the step

### Test 13: debugStepInto
- Position at a function call, then `debugStepInto`
- Call `debugWaitForEvent`, verify you're now inside the called function
- Check stack trace has the new frame on top

### Test 14: debugStepOut
- While inside a function, call `debugStepOut`
- Call `debugWaitForEvent`, verify you're back in the caller
- Check stack trace lost the inner frame

### Test 15: debugPause
- Remove all breakpoints, continue execution
- Quickly call `debugPause`
- Call `debugWaitForEvent`, expect `reason: "pause"`
- Verify you can inspect state while paused

### Test 16: debugContinue
- Set a second breakpoint further in the code
- Call `debugContinue` then `debugWaitForEvent`
- Verify it stops at the next breakpoint, not the same one

### Test 17: debugRemoveAllBreakpoints
- Call with `{}` to remove all
- Call `debugGetBreakpoints` — expect empty array
- Continue — program should run to completion

### Test 18: debugWaitForEvent (terminated)
- After program finishes, the wait should return `{ event: "terminated" }`

### Test 19: debugWaitForEvent (timeout)
- With no session, call `debugWaitForEvent` with `{ timeoutMs: 1000 }`
- Expect: `{ event: "noSession" }` or `{ event: "timeout" }`

### Test 20: debugStop
- Start a new session, hit a breakpoint
- Call `debugStop`
- Verify `debugGetState` returns `{ status: "noSession" }`

### Test 21: Logpoints
- Set a breakpoint with `logMessage: "Value is {item}"` (no condition)
- Run — program should NOT stop but the log message should appear in debug console
- Verify program runs to completion

### Test 22: Python debugging
- Remove all breakpoints, stop any session
- Set breakpoint in `test-dap-python.py` at line 4 (inside the inner loop)
- Start with: `{ type: "debugpy", request: "launch", name: "test-py", program: "/Users/savusilviu/bridge/test-dap-python.py" }`
- Wait for stop, inspect variables (`arr`, `i`, `j`, `n`)
- Evaluate `arr[j] > arr[j+1]`
- Step over, verify `arr` changes after a swap
- Continue to completion

### Test 23: Multiple breakpoints, multiple stops
- Set breakpoints at lines 2 AND 11 in `test-dap-node.js`
- Start session, verify it stops at the first breakpoint hit
- Continue, verify it stops at the next one
- Continue through all stops until terminated

### Test 24: Hit count breakpoint
- Set breakpoint at line 11 with `hitCondition: "3"` (stop on 3rd hit)
- Run and verify it stops with `item === 7` (third element in the array)

## Cleanup
- Delete `test-dap-node.js` and `test-dap-python.py` after all tests pass
- Call `debugRemoveAllBreakpoints` and `debugStop`
