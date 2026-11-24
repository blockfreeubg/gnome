//! `GET /ads.txt` on the app origin from the operator's file (`GNOME_ADS_TXT`, WAVE-C D22): the game networks'
//! publisher terms ask for it. Read on each request (≤ 64 KiB), so a changed file applies at once.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{StatusCode, header};

use crate::state::AppState;

/// Largest file served.
pub const MAX_ADS_TXT: u64 = 64 << 10;

pub async fn serve(State(state): State<AppState>) -> Response {
    let Some(path) = state.config.ads_txt.clone() else { return StatusCode::NOT_FOUND.into_response() };
    let read = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if meta.len() > MAX_ADS_TXT {
            return Err(format!("{} is larger than 64 KiB", path.display()));
        }
        std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
    })
    .await;
    match read {
        Ok(Ok(body)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
            body,
        )
            .into_response(),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "GNOME_ADS_TXT is not served");
            StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
