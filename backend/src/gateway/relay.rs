//! Moving bytes between the browser and HolyWisp once both sides are upgraded.
//!
//! **Zero-copy path (Linux).** The upgraded connection is downcast back to the raw `TcpStream`
//! (`Upgraded::downcast::<TokioIo<ConnIo>>`). Each direction then runs `splice(2)`: socket → pipe → socket, so
//! payload bytes never enter user space. Pipes are created nonblocking (`O_NONBLOCK | O_CLOEXEC`) and every call
//! uses `SPLICE_F_NONBLOCK`; readiness comes from tokio (`readable()`/`writable()` + `try_io`, which clears
//! readiness on `EAGAIN`). A direction only fills its pipe when the pipe is empty and only drains it when it holds
//! data, so `EAGAIN` always means "the socket is not ready" and never spins. The syscalls go through `rustix`
//! (Bytecode Alliance, safe wrappers, no libc), which keeps the crate `#![forbid(unsafe_code)]`; no maintained crate
//! offers tokio-integrated socket-to-socket splicing, and the logic is small enough to own and test.
//!
//! **Copy path.** Elsewhere, when the downcast fails, when [`zero_copy_available`] reports that `splice` is
//! unusable (e.g. a seccomp filter without it), or when a connection's two pipes cannot be created (the process is
//! out of file descriptors: splicing costs four more per connection), `tokio::io::copy_bidirectional` relays through
//! user-space buffers.
//!
//! Both paths behave the same: bytes already buffered on either side (the client's bytes after its request head,
//! HolyWisp's first Wisp frame right after its `101`) are written first; EOF in one direction half-closes the other
//! side's write half and the other direction continues until it ends too (no idle timeout: Wisp connections are
//! long-lived and HolyWisp sends no pings); a write towards the browser that makes no progress for
//! [`WRITE_STALL_TIMEOUT`] ends the connection (the copy path inherits this from [`ConnIo`]); byte counters update
//! as data moves.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use bytes::Bytes;
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _, ReadBuf};
use tokio::net::TcpStream;

#[cfg(target_os = "linux")]
use crate::server::{ConnIo, WRITE_STALL_TIMEOUT};

/// What a finished relay moved.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Traffic {
    /// Browser → HolyWisp.
    pub up: u64,
    /// HolyWisp → browser.
    pub down: u64,
    pub zero_copy: bool,
}

/// Process-wide relay counters (diagnostics, metrics).
#[derive(Debug, Default)]
pub struct RelayCounters {
    /// Bytes browser → HolyWisp.
    pub up: AtomicU64,
    /// Bytes HolyWisp → browser.
    pub down: AtomicU64,
    /// Connections relayed with `splice(2)`.
    pub zero_copy: AtomicU64,
    /// Connections relayed by copying.
    pub copied: AtomicU64,
}

/// Relay until both directions end (or one fails).
pub async fn relay(
    upgraded: Upgraded,
    upstream: TcpStream,
    upstream_rest: Bytes,
    zero_copy: bool,
    counters: &RelayCounters,
) -> io::Result<Traffic> {
    #[cfg(target_os = "linux")]
    {
        if zero_copy {
            return match upgraded.downcast::<TokioIo<ConnIo>>() {
                Ok(parts) => {
                    let client = parts.io.into_inner().into_inner();
                    splice_both(client, upstream, parts.read_buf, upstream_rest, counters).await
                }
                Err(upgraded) => {
                    copy_streams(TokioIo::new(upgraded), Bytes::new(), upstream, upstream_rest, counters).await
                }
            };
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = zero_copy;
    // `Upgraded` yields the client's already-buffered bytes first and still has the ConnIo write-stall timeout.
    copy_streams(TokioIo::new(upgraded), Bytes::new(), upstream, upstream_rest, counters).await
}

/// The copy path: `client_rest` (client bytes read before the upgrade) goes upstream first, `upstream_rest`
/// (HolyWisp's bytes after its `101`) to the client, then `copy_bidirectional`. `client` must bring its own
/// write-stall timeout ([`ConnIo`](crate::server::ConnIo)).
async fn copy_streams<C: AsyncRead + AsyncWrite + Unpin>(
    client: C,
    client_rest: Bytes,
    upstream: TcpStream,
    upstream_rest: Bytes,
    counters: &RelayCounters,
) -> io::Result<Traffic> {
    counters.copied.fetch_add(1, Ordering::Relaxed);
    let mut client = Counted { io: client, counter: &counters.up };
    let mut upstream = Counted { io: upstream, counter: &counters.down };
    let rest_up = write_rest(&mut upstream, client_rest, &counters.up).await?;
    let rest_down = write_rest(&mut client, upstream_rest, &counters.down).await?;
    let (up, down) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(Traffic { up: up + rest_up, down: down + rest_down, zero_copy: false })
}

/// Write bytes buffered before the relay started (`client_rest`, `upstream_rest`) and **drop them** before the pump
/// loop (WAVE-D D19): hyper hands the upgraded connection over with `read_buf.freeze()`, which shares the
/// allocation the request head was parsed from, so keeping `rest` would keep up to the whole head buffer (8 KiB
/// normally, about 1 MiB after a flooded head) alive for the connection's lifetime. Returns the length written.
async fn write_rest<W: AsyncWrite + Unpin>(to: &mut W, rest: Bytes, counter: &AtomicU64) -> io::Result<u64> {
    let len = rest.len() as u64;
    if len > 0 {
        to.write_all(&rest).await?;
        counter.fetch_add(len, Ordering::Relaxed);
    }
    drop(rest);
    Ok(len)
}

/// Counts bytes read through it into a shared counter; writes pass through.
struct Counted<'a, T> {
    io: T,
    counter: &'a AtomicU64,
}

impl<T: AsyncRead + Unpin> AsyncRead for Counted<'_, T> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let res = Pin::new(&mut this.io).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = res {
            this.counter.fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        }
        res
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Counted<'_, T> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
    }
}

/// Whether `splice(2)` works in this process (checked once at startup with a socket pair: socket → pipe → socket).
/// `Err` carries the reason (e.g. `EPERM` from a seccomp filter).
pub fn zero_copy_available() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux::probe().map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("splice(2) is Linux-only".into())
    }
}

#[cfg(target_os = "linux")]
async fn splice_both(
    mut client: TcpStream,
    mut upstream: TcpStream,
    client_rest: Bytes,
    upstream_rest: Bytes,
    counters: &RelayCounters,
) -> io::Result<Traffic> {
    // Both pipes before anything moves: a process at its file-descriptor limit copies this connection instead of
    // dropping it after the 101 was already sent.
    let (up_pipe, down_pipe) = match (linux::Pipe::new(), linux::Pipe::new()) {
        (Ok(up), Ok(down)) => (up, down),
        (Err(e), _) | (_, Err(e)) => {
            tracing::debug!(error = %e, "no pipes for splice(2); relaying this connection by copying");
            let client = ConnIo::new(client, WRITE_STALL_TIMEOUT);
            return copy_streams(client, client_rest, upstream, upstream_rest, counters).await;
        }
    };
    counters.zero_copy.fetch_add(1, Ordering::Relaxed);
    let rest_up = write_rest(&mut upstream, client_rest, &counters.up).await?;
    let rest_down = tokio::time::timeout(WRITE_STALL_TIMEOUT, write_rest(&mut client, upstream_rest, &counters.down))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the client stopped reading"))??;
    let (up, down) = tokio::try_join!(
        linux::pump(&client, &upstream, &up_pipe, &counters.up, None),
        linux::pump(&upstream, &client, &down_pipe, &counters.down, Some(WRITE_STALL_TIMEOUT)),
    )?;
    Ok(Traffic { up: up + rest_up, down: down + rest_down, zero_copy: true })
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::os::fd::{AsFd, OwnedFd};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use rustix::net::Shutdown;
    use rustix::pipe::{PipeFlags, SpliceFlags, pipe_with, splice};
    use tokio::io::Interest;
    use tokio::net::TcpStream;

    /// Bytes moved per `splice` call at most (the default pipe capacity).
    const CHUNK: usize = 64 * 1024;

    fn flags() -> SpliceFlags {
        SpliceFlags::MOVE | SpliceFlags::NONBLOCK
    }

    /// A nonblocking pipe carrying one direction of a connection (read end, write end).
    pub(super) struct Pipe(OwnedFd, OwnedFd);

    impl Pipe {
        pub(super) fn new() -> io::Result<Self> {
            let (r, w) = pipe_with(PipeFlags::CLOEXEC | PipeFlags::NONBLOCK)?;
            Ok(Self(r, w))
        }
    }

    /// One direction: `src` → `pipe` → `dst` until `src` reaches EOF (then `dst`'s write half is shut down).
    /// `stall`: longest time a write to `dst` may make no progress. `pipe` must be empty and used by this call only.
    pub(super) async fn pump(
        src: &TcpStream,
        dst: &TcpStream,
        pipe: &Pipe,
        counter: &AtomicU64,
        stall: Option<Duration>,
    ) -> io::Result<u64> {
        let Pipe(pipe_r, pipe_w) = pipe;
        let mut total = 0u64;
        loop {
            // Fill the (empty) pipe from the socket.
            let filled = loop {
                src.readable().await?;
                match src.try_io(Interest::READABLE, || {
                    splice(src.as_fd(), None, pipe_w, None, CHUNK, flags()).map_err(io::Error::from)
                }) {
                    Ok(n) => break n,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e),
                }
            };
            if filled == 0 {
                // EOF: pass the half-close on; the other direction keeps running.
                let _ = rustix::net::shutdown(dst.as_fd(), Shutdown::Write);
                return Ok(total);
            }
            // Drain the pipe into the other socket.
            let mut left = filled;
            let mut deadline = stall.map(|d| tokio::time::Instant::now() + d);
            while left > 0 {
                match deadline {
                    Some(at) => tokio::time::timeout_at(at, dst.writable())
                        .await
                        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the client stopped reading"))??,
                    None => dst.writable().await?,
                }
                match dst.try_io(Interest::WRITABLE, || {
                    splice(pipe_r, None, dst.as_fd(), None, left, flags()).map_err(io::Error::from)
                }) {
                    Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "splice wrote nothing")),
                    Ok(n) => {
                        left -= n;
                        total += n as u64;
                        counter.fetch_add(n as u64, Ordering::Relaxed);
                        deadline = stall.map(|d| tokio::time::Instant::now() + d);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e),
                }
            }
        }
    }

    /// socket → pipe → socket with one byte over a Unix socket pair (no network involved).
    pub(super) fn probe() -> io::Result<()> {
        use std::io::{Read as _, Write as _};
        use std::os::unix::net::UnixStream;
        let (mut a, b) = UnixStream::pair()?;
        let (c, mut d) = UnixStream::pair()?;
        let (pipe_r, pipe_w) = pipe_with(PipeFlags::CLOEXEC | PipeFlags::NONBLOCK)?;
        a.write_all(b"g")?;
        let into_pipe = splice(&b, None, &pipe_w, None, 1, flags())?;
        let out_of_pipe = splice(&pipe_r, None, &c, None, 1, flags())?;
        let mut got = [0u8; 1];
        d.read_exact(&mut got)?;
        if (into_pipe, out_of_pipe, got) == (1, 1, *b"g") {
            Ok(())
        } else {
            Err(io::Error::other("splice moved unexpected data"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt as _;
    use tokio::net::TcpListener;

    async fn pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let (a, b) = tokio::join!(TcpStream::connect(addr), l.accept());
        (a.unwrap(), b.unwrap().0)
    }

    #[test]
    fn splice_is_available_here() {
        if cfg!(target_os = "linux") {
            zero_copy_available().expect("splice(2) works on this Linux host");
        } else {
            assert!(zero_copy_available().is_err());
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn splice_pump_moves_large_streams_and_half_closes() {
        // client <-> [a | b] relay [c | d] <-> server
        let (mut client, a) = pair().await;
        let (c, mut server) = pair().await;
        let counters = RelayCounters::default();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let reply: Vec<u8> = (0..500_000u32).map(|i| (i % 13) as u8).collect();
        let (sent, got_reply) = (data.clone(), reply.clone());
        let ends = async move {
            let writer = async {
                client.write_all(&sent).await.unwrap();
                client.shutdown().await.unwrap();
                let mut back = Vec::new();
                client.read_to_end(&mut back).await.unwrap();
                back
            };
            let echo = async {
                let mut seen = Vec::new();
                server.read_to_end(&mut seen).await.unwrap(); // ends when the relay passes the half-close on
                server.write_all(&got_reply).await.unwrap();
                server.shutdown().await.unwrap();
                seen
            };
            tokio::join!(writer, echo)
        };
        let relay = async {
            let (up_pipe, down_pipe) = (linux::Pipe::new().unwrap(), linux::Pipe::new().unwrap());
            tokio::try_join!(
                linux::pump(&a, &c, &up_pipe, &counters.up, None),
                linux::pump(&c, &a, &down_pipe, &counters.down, Some(WRITE_STALL_TIMEOUT))
            )
        };
        let ((back, seen), moved) = tokio::join!(ends, relay);
        let (up, down) = moved.unwrap();
        assert_eq!(seen, data, "every byte arrives in order");
        assert_eq!(back, reply);
        assert_eq!((up, down), (data.len() as u64, reply.len() as u64));
        assert_eq!(counters.up.load(Ordering::Relaxed), up);
        assert_eq!(counters.down.load(Ordering::Relaxed), down);
    }

    /// The copy path on raw sockets (the fallback when no pipes can be created): bytes buffered on both sides at
    /// upgrade time go first and in order, EOF half-closes the other side, and the counters see everything.
    #[tokio::test]
    async fn copy_fallback_writes_buffered_bytes_first_and_half_closes() {
        // client <-> [a | relay | c] <-> server
        let (mut client, a) = pair().await;
        let (c, mut server) = pair().await;
        let counters = RelayCounters::default();
        let relay = copy_streams(
            crate::server::ConnIo::new(a, crate::server::WRITE_STALL_TIMEOUT),
            Bytes::from_static(b"client-early|"),
            c,
            Bytes::from_static(b"server-first|"),
            &counters,
        );
        let ends = async {
            let client_side = async {
                client.write_all(b"client-later").await.unwrap();
                client.shutdown().await.unwrap();
                let mut got = Vec::new();
                client.read_to_end(&mut got).await.unwrap();
                got
            };
            let server_side = async {
                let mut got = Vec::new();
                server.read_to_end(&mut got).await.unwrap(); // ends when the client's EOF is passed on
                server.write_all(b"server-later").await.unwrap();
                server.shutdown().await.unwrap();
                got
            };
            tokio::join!(client_side, server_side)
        };
        let (traffic, (to_client, to_server)) = tokio::join!(relay, ends);
        let traffic = traffic.unwrap();
        assert_eq!(to_server, b"client-early|client-later");
        assert_eq!(to_client, b"server-first|server-later");
        assert_eq!((traffic.up, traffic.down, traffic.zero_copy), (25, 25, false));
        assert_eq!((counters.up.load(Ordering::Relaxed), counters.down.load(Ordering::Relaxed)), (25, 25));
        assert_eq!((counters.copied.load(Ordering::Relaxed), counters.zero_copy.load(Ordering::Relaxed)), (1, 0));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(start_paused = true)]
    async fn a_reader_that_stops_reading_is_cut_off() {
        let (mut client, a) = pair().await;
        let (c, mut server) = pair().await;
        let counters = RelayCounters::default();
        // The server floods; the client never reads. Socket buffers fill, then the write to `a` stalls.
        let flood = tokio::spawn(async move {
            let chunk = vec![0u8; 64 * 1024];
            while server.write_all(&chunk).await.is_ok() {}
        });
        let started = tokio::time::Instant::now();
        let pipe = linux::Pipe::new().unwrap();
        let err = linux::pump(&c, &a, &pipe, &counters.down, Some(WRITE_STALL_TIMEOUT)).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= WRITE_STALL_TIMEOUT);
        flood.abort();
        let _ = client.shutdown().await;
    }

    /// WAVE-D D19: once the buffered bytes are written upstream, nothing of the head's buffer stays referenced, so a
    /// connection opened with a 60 KB head retains no more heap than one opened with a 1 KB head.
    #[tokio::test]
    async fn buffered_bytes_are_released_before_the_pump() {
        struct Owner(Vec<u8>, #[allow(dead_code)] std::sync::Arc<()>);
        impl AsRef<[u8]> for Owner {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }
        for size in [1024usize, 60 * 1024] {
            let probe = std::sync::Arc::new(());
            let whole = Bytes::from_owner(Owner(vec![7; size + 512], probe.clone()));
            // Like hyper's `read_buf.freeze()` remainder: a slice sharing the head's allocation.
            let rest = whole.slice(size..);
            drop(whole);
            assert_eq!(std::sync::Arc::strong_count(&probe), 2, "the slice keeps the allocation");
            let mut sink = Vec::new();
            let counter = AtomicU64::new(0);
            assert_eq!(write_rest(&mut sink, rest, &counter).await.unwrap(), 512);
            assert_eq!(sink.len(), 512);
            assert_eq!(std::sync::Arc::strong_count(&probe), 1, "released after the write ({size} B head)");
        }
    }
}
