const [port, expression, timeoutMs = '15000'] = process.argv.slice(2);
if (!port || !expression) throw new Error('port + expression required');
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const answer = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, Number(timeoutMs));
  ws.onopen = () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,userGesture:true}}));
  ws.onmessage = ({data}) => { const msg=JSON.parse(data); if(msg.id !== 1) return; clearTimeout(timer);ws.close();resolve(msg); };
  ws.onerror = reject;
});
console.log(JSON.stringify(answer,null,2));
if (answer.error || answer.result?.exceptionDetails) process.exitCode = 1;
