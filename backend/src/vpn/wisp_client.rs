//! A minimal Wisp v1 client: one TCP stream over one WebSocket (WAVE-C §6.1), used by the server-side VPN exit
//! check to reach the internet through a location's own HolyWisp instance. Promoted from the test client in
//! `backend/tests/holywisp_e2e.rs`, which stays as the end-to-end check of the gateway.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::gateway::upstream::UpstreamAddr;

const CONNECT: u8 = 0x01;
const DATA: u8 = 0x02;
const CONTINUE: u8 = 0x03;
const CLOSE: u8 = 0x04;
const TCP: u8 = 0x01;
/// Wisp CLOSE reason "voluntary".
pub const CLOSE_VOLUNTARY: u8 = 0x02;
/// Largest frame accepted from the server (payload + 5 header bytes).
pub const MAX_FRAME: usize = 64 * 1024 + 5;
const STREAM_ID: u32 = 1;
const CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WispError {
    /// TCP connect, WebSocket handshake or the server's first frame (CONTINUE on stream 0) failed.
    Upstream,
    /// The server closed the stream (Wisp CLOSE; its reason byte kept for diagnostics).
    Closed(u8),
    /// The caller's deadline ran out (the exit check's 15 s).
    Timeout,
}

impl std::fmt::Display for WispError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Upstream => f.write_str("the Wisp server cannot be reached"),
            Self::Closed(r) => write!(f, "the Wisp server closed the stream (reason {r:#04x})"),
            Self::Timeout => f.write_str("timed out"),
        }
    }
}

impl std::error::Error for WispError {}

/// What ended the stream, seen by the pump.
#[derive(Debug, Default)]
struct End {
    /// The server's CLOSE reason, or `None` while open / when the WebSocket failed.
    close: Option<u8>,
    /// Bytes received from the server so far.
    received: u64,
    /// A protocol violation (an oversized or malformed frame).
    broken: bool,
}

/// One Wisp TCP stream. Reads and writes go through an in-memory duplex pumped by a task that owns the WebSocket;
/// shutting down the write side sends Wisp CLOSE.
#[derive(Debug)]
pub struct WispStream {
    io: DuplexStream,
    end: Arc<Mutex<End>>,
}

fn frame(kind: u8, stream: u32, payload: &[u8]) -> Message {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.push(kind);
    f.extend_from_slice(&stream.to_le_bytes());
    f.extend_from_slice(payload);
    Message::binary(f)
}

fn parse(bytes: &[u8]) -> Option<(u8, u32, &[u8])> {
    if bytes.len() < 5 {
        return None;
    }
    Some((bytes[0], u32::from_le_bytes(bytes[1..5].try_into().ok()?), &bytes[5..]))
}

impl WispStream {
    /// Connect to `upstream` (a location's HolyWisp), handshake on the route's canonical path as the gateway writes it
    /// (`/wisp/p/<id>/`; no cookies, no `X-Forwarded-For`), then CONNECT a TCP stream to `host:port`. Honours CONTINUE
    /// flow control; frames over 64 KiB are an error. `timeout` bounds the TCP connect, the handshake and the
    /// server's first frame.
    pub async fn connect(
        upstream: &UpstreamAddr,
        path: &str,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<WispStream, WispError> {
        let opened = tokio::time::timeout(timeout, async {
            let tcp = upstream.connect_within(timeout).await.map_err(|_| WispError::Upstream)?;
            let url = format!("ws://{}{path}", upstream.authority());
            let request = url.into_client_request().map_err(|_| WispError::Upstream)?;
            let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
            let (mut ws, _) = tokio_tungstenite::client_async_with_config(request, tcp, Some(config))
                .await
                .map_err(|_| WispError::Upstream)?;
            // The server's first frame: CONTINUE on stream 0 with the initial buffer (packets in flight per stream).
            let window = loop {
                match ws.next().await {
                    Some(Ok(Message::Binary(b))) => match parse(&b) {
                        Some((CONTINUE, 0, p)) if p.len() >= 4 => {
                            break u32::from_le_bytes(p[..4].try_into().map_err(|_| WispError::Upstream)?);
                        }
                        _ => return Err(WispError::Upstream),
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => return Err(WispError::Upstream),
                }
            };
            Ok::<_, WispError>((ws, window))
        })
        .await;
        // Within `timeout` the server must accept the handshake and send its first frame: a server that stays silent
        // is an unusable upstream, like one that refuses the connection.
        let (mut ws, window) = match opened {
            Ok(r) => r?,
            Err(_) => return Err(WispError::Upstream),
        };
        let mut connect = vec![TCP];
        connect.extend_from_slice(&port.to_le_bytes());
        connect.extend_from_slice(host.as_bytes());
        ws.send(frame(CONNECT, STREAM_ID, &connect)).await.map_err(|_| WispError::Upstream)?;
        let (io, bridge) = tokio::io::duplex(256 * 1024);
        let end = Arc::new(Mutex::new(End::default()));
        tokio::spawn(pump(ws, bridge, window, end.clone()));
        Ok(WispStream { io, end })
    }

    /// Why the stream ended, once it did: the server's CLOSE (`Closed(reason)`), or `Upstream` when the WebSocket
    /// failed or broke the protocol. `None` while it is open.
    pub fn error(&self) -> Option<WispError> {
        let end = self.end.lock().unwrap_or_else(|e| e.into_inner());
        if end.broken {
            return Some(WispError::Upstream);
        }
        end.close.map(WispError::Closed)
    }

    /// Bytes received from the server so far.
    pub fn received(&self) -> u64 {
        self.end.lock().unwrap_or_else(|e| e.into_inner()).received
    }
}

async fn pump<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    mut bridge: DuplexStream,
    mut window: u32,
    end: Arc<Mutex<End>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    loop {
        tokio::select! {
            n = bridge.read(&mut buf), if window > 0 => match n {
                Ok(0) | Err(_) => {
                    // Half-close: Wisp v1 has none, so the stream is closed for both directions.
                    let _ = ws.send(frame(CLOSE, STREAM_ID, &[CLOSE_VOLUNTARY])).await;
                    let _ = ws.close(None).await;
                    return;
                }
                Ok(n) => {
                    if ws.send(frame(DATA, STREAM_ID, &buf[..n])).await.is_err() {
                        break;
                    }
                    window -= 1;
                }
            },
            msg = ws.next() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if b.len() > MAX_FRAME {
                        end.lock().unwrap_or_else(|e| e.into_inner()).broken = true;
                        break;
                    }
                    match parse(&b) {
                        Some((DATA, STREAM_ID, payload)) => {
                            end.lock().unwrap_or_else(|e| e.into_inner()).received += payload.len() as u64;
                            if bridge.write_all(payload).await.is_err() {
                                break;
                            }
                        }
                        Some((CONTINUE, STREAM_ID, p)) if p.len() >= 4 => {
                            window = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                        }
                        Some((CLOSE, STREAM_ID, p)) => {
                            end.lock().unwrap_or_else(|e| e.into_inner()).close = Some(p.first().copied().unwrap_or(0));
                            break;
                        }
                        Some(_) => {}
                        None => {
                            end.lock().unwrap_or_else(|e| e.into_inner()).broken = true;
                            break;
                        }
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => {
                    end.lock().unwrap_or_else(|e| e.into_inner()).broken = true;
                    break;
                }
            },
        }
    }
    let _ = bridge.shutdown().await;
    let _ = ws.close(None).await;
}

impl AsyncRead for WispStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for WispStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    /// Sends Wisp CLOSE (the pump sees the end of the write side).
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}
