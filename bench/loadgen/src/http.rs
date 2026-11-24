//! A minimal HTTP/1.1 client (keep-alive, Content-Length and chunked bodies) for the ticket API and `http` mode.
use crate::ws::read_head;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

pub struct Response {
    pub status: u16,
    pub head: String,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
    pub fn headers<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.head.lines().skip(1).filter_map(move |l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

pub struct Client {
    pub r: BufReader<TcpStream>,
    pub w: TcpStream,
}

impl Client {
    pub fn new(s: TcpStream) -> io::Result<Self> {
        s.set_nodelay(true)?;
        Ok(Client { r: BufReader::with_capacity(64 << 10, s.try_clone()?), w: s })
    }
    pub fn send(&mut self, req: &[u8]) -> io::Result<()> {
        self.w.write_all(req)
    }
    /// Read one response; `keep_body` false discards the body while counting it.
    pub fn recv(&mut self, head_req: bool, keep_body: bool) -> io::Result<Response> {
        let head = read_head(&mut self.r)?;
        let status = head.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let mut resp = Response { status, head, body: Vec::new() };
        if head_req || status == 304 || status == 204 || (100..200).contains(&status) {
            return Ok(resp);
        }
        let chunked = resp.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
        if chunked {
            loop {
                let mut line = String::new();
                self.r.read_line(&mut line)?;
                let n = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))?;
                self.body(n, keep_body, &mut resp.body)?;
                let mut crlf = [0u8; 2];
                self.r.read_exact(&mut crlf)?;
                if n == 0 {
                    break;
                }
            }
        } else if let Some(n) = resp.header("content-length").and_then(|v| v.parse::<usize>().ok()) {
            self.body(n, keep_body, &mut resp.body)?;
        } else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "response without a length"));
        }
        Ok(resp)
    }
    fn body(&mut self, mut n: usize, keep: bool, out: &mut Vec<u8>) -> io::Result<()> {
        while n > 0 {
            let buf = self.r.fill_buf()?;
            if buf.is_empty() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "body truncated"));
            }
            let k = buf.len().min(n);
            if keep {
                out.extend_from_slice(&buf[..k]);
            }
            self.r.consume(k);
            n -= k;
        }
        Ok(())
    }
}

pub fn build_request(method: &str, path: &str, host: &str, headers: &[String], body: &[u8]) -> Vec<u8> {
    let mut r = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n");
    for h in headers {
        r.push_str(h);
        r.push_str("\r\n");
    }
    if method == "POST" || !body.is_empty() {
        r.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    r.push_str("\r\n");
    let mut v = r.into_bytes();
    v.extend_from_slice(body);
    v
}

/// Parse `http://host:port/path` (or ws://) into (host:port, path).
pub fn split_url(url: &str) -> Option<(String, String)> {
    let rest = url.split_once("://")?.1;
    let (hp, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    Some((hp.to_string(), path.to_string()))
}

/// Mint a Wisp ticket the way the engine host does: an anonymous session first (its cookie), then
/// `POST /api/wisp/ticket` with `X-GNOME-Request: 1`. Returns (ticket, wisp_url, cookie).
pub fn mint_ticket(api: &str, cookie: Option<&str>) -> io::Result<(String, String, Option<String>)> {
    let (hp, _) = split_url(api).ok_or_else(|| io::Error::other("bad --ticket-api"))?;
    let mut c = Client::new(TcpStream::connect(&hp)?)?;
    let mut headers = vec!["X-GNOME-Request: 1".to_string(), "Content-Type: application/json".to_string()];
    if let Some(ck) = cookie {
        headers.push(format!("Cookie: {ck}"));
    }
    c.send(&build_request("POST", "/api/wisp/ticket", &hp, &headers, b""))?;
    let r = c.recv(false, true)?;
    if r.status != 200 {
        return Err(io::Error::other(format!("ticket mint: HTTP {} {}", r.status, String::from_utf8_lossy(&r.body))));
    }
    let new_cookie = r.headers("set-cookie").next().and_then(|v| v.split(';').next()).map(str::to_string);
    let body = String::from_utf8_lossy(&r.body).into_owned();
    let field = |name: &str| -> Option<String> {
        let i = body.find(&format!("\"{name}\":\""))? + name.len() + 4;
        Some(body[i..i + body[i..].find('"')?].to_string())
    };
    let ticket = field("ticket").ok_or_else(|| io::Error::other("no ticket in the response"))?;
    let url = field("wisp_url").ok_or_else(|| io::Error::other("no wisp_url in the response"))?;
    Ok((ticket, url, new_cookie.or(cookie.map(str::to_string))))
}
