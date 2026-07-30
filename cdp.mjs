import WebSocket from 'ws'
const [,, id, expr, port='9223'] = process.argv
const t = (await (await fetch(`http://localhost:${port}/json`)).json()).find(x => x.id === id)
const ws = new WebSocket(t.webSocketDebuggerUrl)
ws.on('open', () => ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression:expr, returnByValue:true, awaitPromise:true}})))
ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id===1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result)); ws.close(); process.exit(0) } })
