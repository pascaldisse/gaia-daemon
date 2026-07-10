//! The app's own scriptable debug door (CDP-style), used by agents to test the
//! real app; Safari Web Inspector (tauri devtools feature) is the human door.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

const DEFAULT_DEBUG_PORT: u16 = 9333;
const MAX_LOGS: usize = 2000;

struct DebugState {
    port: u16,
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    logs: Mutex<VecDeque<Value>>,
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
    let response = match read_request(&mut stream) {
        Ok(request) => route(request, app, state),
        Err(e) => json_response(400, json!({ "ok": false, "error": e })),
    };
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
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

    let headers = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().ok_or_else(|| "missing request line".to_string())?;
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
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "bad content-length".to_string())?;
            }
        }
    }

    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed before body".to_string());
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);

    Ok(Request { method, path, body })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn route(request: Request, app: tauri::AppHandle, state: Arc<DebugState>) -> Vec<u8> {
    let method = request.method.as_str();
    let path = request.path.as_str();
    match (method, path) {
        ("POST", "/eval") => {
            let source = String::from_utf8_lossy(&request.body).to_string();
            match eval_in_page(app, state, &source, Duration::from_secs(10)) {
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
            let value = serde_json::from_slice::<Value>(&request.body).unwrap_or_else(|_| {
                json!({ "msg": String::from_utf8_lossy(&request.body).to_string() })
            });
            let mut logs = state.logs.lock().unwrap();
            logs.push_back(value);
            while logs.len() > MAX_LOGS {
                logs.pop_front();
            }
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
        ("GET", "/info") => match eval_in_page(
            app,
            state,
            "({url:location.href,title:document.title,ready:document.readyState})",
            Duration::from_secs(5),
        ) {
            Ok(body) => raw_response(200, "application/json", body.into_bytes()),
            Err(error) => json_response(504, json!({ "ok": false, "error": error })),
        },
        ("GET", "/screenshot") => screenshot_response(app),
        _ => json_response(404, json!({ "ok": false, "error": "unknown endpoint" })),
    }
}

fn eval_in_page(
    app: tauri::AppHandle,
    state: Arc<DebugState>,
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
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())?;
        window.eval(&script).map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(timeout)
            .map_err(|_| "eval timeout".to_string())
    })();

    state.pending.lock().unwrap().remove(&id);
    result
}

fn screenshot_response(app: tauri::AppHandle) -> Vec<u8> {
    let result = (|| -> Result<Vec<u8>, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let x = (f64::from(pos.x) / scale).round();
        let y = (f64::from(pos.y) / scale).round();
        let w = (f64::from(size.width) / scale).round();
        let h = (f64::from(size.height) / scale).round();
        let path = "/tmp/gaia-shell-debug-shot.png";
        let status = Command::new("screencapture")
            .args(["-x", &format!("-R{x},{y},{w},{h}"), path])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("screencapture failed: {status}"));
        }
        std::fs::read(path).map_err(|e| e.to_string())
    })();

    match result {
        Ok(bytes) => raw_response(200, "image/png", bytes),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
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
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut response = headers.into_bytes();
    response.extend_from_slice(&body);
    response
}
