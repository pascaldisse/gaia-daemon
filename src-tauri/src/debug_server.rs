//! The app's own scriptable debug door (CDP-style), used by agents to test the
//! real app; Safari Web Inspector (tauri devtools feature) is the human door.

use std::collections::{HashMap, VecDeque};
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;
use tungstenite::{accept_hdr, Message};

const DEFAULT_DEBUG_PORT: u16 = 9333;
const MAX_LOGS: usize = 2000;

struct DebugState {
    port: u16,
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    logs: Mutex<VecDeque<Value>>,
    cdp_seq: AtomicU64,
    cdp_clients: Mutex<HashMap<u64, mpsc::Sender<String>>>,
}

pub fn spawn(app: tauri::AppHandle) {
    let Some(port) = debug_port() else {
        eprintln!("[gaia-shell] debug server disabled");
        return;
    };
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[gaia-shell] debug server disabled: bind 127.0.0.1:{port} failed: {e}");
            return;
        }
    };
    eprintln!(
        "[gaia-shell] debug server on http://127.0.0.1:{port} (/eval /console /screenshot /info)"
    );

    let state = Arc::new(DebugState {
        port,
        seq: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        logs: Mutex::new(VecDeque::new()),
        cdp_seq: AtomicU64::new(1),
        cdp_clients: Mutex::new(HashMap::new()),
    });

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let state = Arc::clone(&state);
                    thread::spawn(move || handle_connection(stream, app, state));
                }
                Err(e) => eprintln!("[gaia-shell] debug server accept failed: {e}"),
            }
        }
    });
}

pub fn init_script() -> String {
    let Some(port) = debug_port() else {
        return String::new();
    };
    format!(
        "(()=>{{if(window.__gaiaDebugHooked)return;window.__gaiaDebugHooked=true;const post=(level,args)=>{{try{{fetch('http://127.0.0.1:{port}/__log',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{ts:Date.now(),level,msg:args.map(a=>{{try{{return typeof a==='string'?a:JSON.stringify(a)}}catch(_){{return String(a)}}}}).join(' ')}})}})}}catch(_){{}}}};for(const l of['log','info','warn','error','debug']){{const orig=console[l].bind(console);console[l]=(...a)=>{{post(l,a);orig(...a)}}}}window.addEventListener('error',e=>post('error',[e.message+' @'+e.filename+':'+e.lineno]));window.addEventListener('unhandledrejection',e=>post('error',['unhandledrejection: '+String(e.reason)]))}})();"
    )
}

fn debug_port() -> Option<u16> {
    std::env::var("GAIA_SHELL_DEBUG_PORT")
        .unwrap_or_else(|_| DEFAULT_DEBUG_PORT.to_string())
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
}

fn handle_connection(mut stream: TcpStream, app: tauri::AppHandle, state: Arc<DebugState>) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(e) => {
            let _ = stream.write_all(&json_response(400, json!({ "ok": false, "error": e })));
            let _ = stream.flush();
            return;
        }
    };

    if request.path.starts_with("/devtools/page/") && request.is_websocket_upgrade() {
        let label = request.path["/devtools/page/".len()..]
            .split('?')
            .next()
            .unwrap_or("main")
            .to_string();
        handle_cdp_connection(stream, request.raw, app, state, label);
        return;
    }

    let response = route(request, app, state);
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    raw: Vec<u8>,
}

impl Request {
    fn is_websocket_upgrade(&self) -> bool {
        self.headers
            .get("upgrade")
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed before headers".to_string());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 1024 * 1024 {
            return Err("headers too large".to_string());
        }
    };

    let headers_text = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = headers_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "missing path".to_string())?
        .to_string();

    let mut content_length = 0_usize;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if name == "content-length" {
                content_length = value
                    .parse::<usize>()
                    .map_err(|_| "bad content-length".to_string())?;
            }
            headers.insert(name, value);
        }
    }

    let raw = buf.clone();
    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    if !(path.starts_with("/devtools/page/")
        && headers
            .get("upgrade")
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false))
    {
        while body.len() < content_length {
            let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("connection closed before body".to_string());
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(content_length);
    }

    Ok(Request {
        method,
        path,
        headers,
        body,
        raw,
    })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn route(request: Request, app: tauri::AppHandle, state: Arc<DebugState>) -> Vec<u8> {
    let method = request.method.as_str();
    let path = request.path.as_str();
    if method == "OPTIONS" {
        return empty_response(204);
    }
    match (method, path) {
        ("POST", "/eval") => {
            let source = String::from_utf8_lossy(&request.body).to_string();
            match eval_in_page(app, state, "main", &source, Duration::from_secs(10)) {
                Ok(body) => raw_response(200, "application/json", body.into_bytes()),
                Err(error) => json_response(504, json!({ "ok": false, "error": error })),
            }
        }
        ("POST", "/__result") => {
            if let Ok(value) = serde_json::from_slice::<Value>(&request.body) {
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
                        let _ = sender.send(String::from_utf8_lossy(&request.body).to_string());
                    }
                }
            }
            empty_response(204)
        }
        ("POST", "/__log") => {
            let value = serde_json::from_slice::<Value>(&request.body).unwrap_or_else(
                |_| json!({ "msg": String::from_utf8_lossy(&request.body).to_string() }),
            );
            let mut logs = state.logs.lock().unwrap();
            logs.push_back(value.clone());
            while logs.len() > MAX_LOGS {
                logs.pop_front();
            }
            drop(logs);
            broadcast_cdp_console(&state, &value);
            empty_response(204)
        }
        ("GET", "/console") | ("GET", "/console?clear=1") => {
            let mut logs = state.logs.lock().unwrap();
            let snapshot: Vec<Value> = logs.iter().cloned().collect();
            if path == "/console?clear=1" {
                logs.clear();
            }
            json_response(200, Value::Array(snapshot))
        }
        ("GET", "/json") | ("GET", "/json/list") => {
            json_response(200, cdp_targets(&app, state.port))
        }
        ("GET", "/json/version") => json_response(
            200,
            json!({
                "Browser": "gaia-shell/1.0",
                "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": format!("ws://127.0.0.1:{}/devtools/page/main", state.port),
            }),
        ),
        ("GET", "/info") => info_response(app),
        ("GET", "/screenshot") => screenshot_response(app, "main"),
        _ => json_response(404, json!({ "ok": false, "error": "unknown endpoint" })),
    }
}

fn eval_in_page(
    app: tauri::AppHandle,
    state: Arc<DebugState>,
    label: &str,
    source: &str,
    timeout: Duration,
) -> Result<String, String> {
    let id = state.seq.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    state.pending.lock().unwrap().insert(id, sender);

    let result = (|| {
        let source_json = serde_json::to_string(source).map_err(|e| e.to_string())?;
        let port = state.port;
        let script = format!(
            "(async()=>{{let o;try{{const v=await (0,eval)({source_json});let s;try{{s=JSON.parse(JSON.stringify(v===undefined?null:v))}}catch(_){{s=String(v)}}o={{id:{id},ok:true,value:s}}}}catch(e){{o={{id:{id},ok:false,error:String(e&&e.stack||e)}}}}try{{await fetch('http://127.0.0.1:{port}/__result',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify(o)}})}}catch(_){{}}}})();"
        );
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| format!("no {label} window"))?;
        window.eval(&script).map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(timeout)
            .map_err(|_| "eval timeout".to_string())
    })();

    state.pending.lock().unwrap().remove(&id);
    result
}

fn screenshot_response(app: tauri::AppHandle, label: &str) -> Vec<u8> {
    match screenshot_bytes(app, label) {
        Ok(bytes) => raw_response(200, "image/png", bytes),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
}

fn info_response(app: tauri::AppHandle) -> Vec<u8> {
    let (sender, receiver) = mpsc::channel();
    if let Err(error) = app.clone().run_on_main_thread(move || {
        let windows: Vec<Value> = app
            .webview_windows()
            .into_iter()
            .map(|(label, window)| {
                let mut info = serde_json::Map::new();
                info.insert("label".to_string(), Value::String(label));
                if let Ok(scale_factor) = window.scale_factor() {
                    info.insert("scaleFactor".to_string(), json!(scale_factor));
                }
                if let Ok(position) = window.outer_position() {
                    info.insert(
                        "outerPosition".to_string(),
                        json!({ "x": position.x, "y": position.y }),
                    );
                }
                if let Ok(size) = window.outer_size() {
                    info.insert(
                        "outerSize".to_string(),
                        json!({ "width": size.width, "height": size.height }),
                    );
                }
                Value::Object(info)
            })
            .collect();
        let _ = sender.send(json!({ "ok": true, "windows": windows }));
    }) {
        return json_response(500, json!({ "ok": false, "error": error.to_string() }));
    }

    match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(value) => json_response(200, value),
        Err(_) => json_response(500, json!({ "ok": false, "error": "info timeout" })),
    }
}

struct PrependStream {
    prefix: Cursor<Vec<u8>>,
    stream: TcpStream,
}

impl Read for PrependStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.prefix.read(buf)?;
        if n > 0 {
            return Ok(n);
        }
        self.stream.read(buf)
    }
}

impl Write for PrependStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stream.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

fn handle_cdp_connection(
    stream: TcpStream,
    request_head: Vec<u8>,
    app: tauri::AppHandle,
    state: Arc<DebugState>,
    label: String,
) {
    let wrapped = PrependStream {
        prefix: Cursor::new(request_head),
        stream,
    };
    let mut ws = match accept_hdr(
        wrapped,
        |_request: &tungstenite::handshake::server::Request, response| Ok(response),
    ) {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[gaia-shell] CDP websocket handshake failed: {e}");
            return;
        }
    };
    let _ = ws
        .get_mut()
        .stream
        .set_read_timeout(Some(Duration::from_millis(100)));

    let client_id = state.cdp_seq.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    state.cdp_clients.lock().unwrap().insert(client_id, sender);

    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let response =
                    handle_cdp_message(text.as_ref(), app.clone(), Arc::clone(&state), &label);
                if let Some(response) = response {
                    if ws.send(Message::Text(response.into())).is_err() {
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Binary(_)) => {}
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                while let Ok(event) = receiver.try_recv() {
                    if ws.send(Message::Text(event.into())).is_err() {
                        state.cdp_clients.lock().unwrap().remove(&client_id);
                        return;
                    }
                }
            }
            Err(_) => break,
        }
    }

    state.cdp_clients.lock().unwrap().remove(&client_id);
}

fn handle_cdp_message(
    text: &str,
    app: tauri::AppHandle,
    state: Arc<DebugState>,
    label: &str,
) -> Option<String> {
    let request = serde_json::from_str::<Value>(text).ok()?;
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let response = match method {
        "Runtime.evaluate" => {
            let expression = params
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or("");
            match eval_in_page(app, state, label, expression, Duration::from_secs(10)) {
                Ok(body) => cdp_eval_success(id, &body),
                Err(error) => cdp_eval_error(id, error),
            }
        }
        "Page.captureScreenshot" => match screenshot_bytes(app, label) {
            Ok(bytes) => json!({ "id": id, "result": { "data": base64_encode(&bytes) } }),
            Err(error) => {
                json!({ "id": id, "result": { "data": "" }, "error": { "message": error } })
            }
        },
        "Page.navigate" => {
            if let Some(url) = params.get("url").and_then(Value::as_str) {
                if let Some(window) = app.get_webview_window(label) {
                    if let Ok(url_json) = serde_json::to_string(url) {
                        let _ = window.eval(&format!("location.href={url_json}"));
                    }
                }
            }
            json!({ "id": id, "result": { "frameId": label } })
        }
        _ => json!({ "id": id, "result": {} }),
    };
    serde_json::to_string(&response).ok()
}

fn cdp_eval_success(id: Value, body: &str) -> Value {
    let bridge = serde_json::from_str::<Value>(body)
        .unwrap_or_else(|_| json!({ "ok": false, "error": body }));
    if bridge.get("ok").and_then(Value::as_bool) == Some(false) {
        return cdp_eval_error(
            id,
            bridge
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("eval failed")
                .to_string(),
        );
    }
    let value = bridge.get("value").cloned().unwrap_or(Value::Null);
    let result = if value.is_null() {
        json!({ "type": "undefined" })
    } else {
        let ty = match &value {
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            Value::Array(_) | Value::Object(_) => "object",
            Value::Null => "undefined",
        };
        json!({ "type": ty, "value": value })
    };
    json!({ "id": id, "result": { "result": result } })
}

fn cdp_eval_error(id: Value, error: String) -> Value {
    json!({
        "id": id,
        "result": {
            "result": { "type": "undefined" },
            "exceptionDetails": {
                "text": error,
                "exceptionId": 1,
                "columnNumber": 0,
                "lineNumber": 0,
            }
        }
    })
}

fn cdp_targets(app: &tauri::AppHandle, port: u16) -> Value {
    let targets = app
        .webview_windows()
        .keys()
        .map(|label| {
            json!({
                "id": label,
                "type": "page",
                "title": "GAIA",
                "url": "",
                "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{label}"),
                "devtoolsFrontendUrl": "",
            })
        })
        .collect();
    Value::Array(targets)
}

fn broadcast_cdp_console(state: &Arc<DebugState>, value: &Value) {
    let level = value.get("level").and_then(Value::as_str).unwrap_or("log");
    let msg = value.get("msg").and_then(Value::as_str).unwrap_or("");
    let ts = value
        .get("ts")
        .and_then(Value::as_f64)
        .unwrap_or_else(|| state.seq.load(Ordering::Relaxed) as f64);
    let event = json!({
        "method": "Runtime.consoleAPICalled",
        "params": {
            "type": level,
            "args": [{ "type": "string", "value": msg }],
            "executionContextId": 1,
            "timestamp": ts,
        }
    })
    .to_string();

    let mut clients = state.cdp_clients.lock().unwrap();
    clients.retain(|_, sender| sender.send(event.clone()).is_ok());
}

fn screenshot_bytes(app: tauri::AppHandle, label: &str) -> Result<Vec<u8>, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no {label} window"))?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let x = (f64::from(pos.x) / scale).round() as i32;
    let y = (f64::from(pos.y) / scale).round() as i32;
    let w = (f64::from(size.width) / scale).round() as i32;
    let h = (f64::from(size.height) / scale).round() as i32;
    let rect = format!("{x},{y},{w},{h}");
    let path = "/tmp/gaia-shell-debug-shot.png";
    let output = Command::new("screencapture")
        .args(["-x", &format!("-R{rect}"), path])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "screencapture failed for rect {rect}: {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(b2 & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn empty_response(status: u16) -> Vec<u8> {
    raw_response(status, "text/plain", Vec::new())
}

fn json_response(status: u16, value: Value) -> Vec<u8> {
    raw_response(
        status,
        "application/json",
        serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec()),
    )
}

fn raw_response(status: u16, content_type: &str, body: Vec<u8>) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        504 => "Gateway Timeout",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 86400\r\n\r\n",
        body.len()
    );
    let mut response = headers.into_bytes();
    response.extend_from_slice(&body);
    response
}
