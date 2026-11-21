//! Error type shared by every catalog API.

use std::fmt;

use crate::source::Source;

/// Errors returned by the catalog.
///
/// Fetch and parse problems that happen *during an import* do not surface here: they end the run with status
/// `failed`/`incomplete` and are recorded in [`crate::ImportReport`] and `catalog_imports`.
#[derive(Debug)]
#[non_exhaustive]
pub enum CatalogError {
    /// SQLite error.
    Db(rusqlite::Error),
    /// The embedding application's database layer failed (e.g. its blocking writer task panicked).
    Storage(String),
    /// Invalid configuration. The message names the variable.
    Config(String),
    /// The source is not enabled, or lacks the operator ID it needs.
    SourceDisabled(Source),
    /// Another import of this source is still running.
    Busy(Source),
    /// Invalid caller input (tampered cursor, unknown category, too many ids, ...).
    InvalidInput(String),
    /// Unknown game (or not visible).
    NotFound,
    /// Malformed data that cannot be processed (e.g. an unreadable manifest).
    Data(String),
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "catalog database: {e}"),
            Self::Storage(e) => write!(f, "catalog storage: {e}"),
            Self::Config(e) => write!(f, "catalog configuration: {e}"),
            Self::SourceDisabled(s) => write!(f, "catalog source {} is not enabled", s.id()),
            Self::Busy(s) => write!(f, "an import of {} is already running", s.id()),
            Self::InvalidInput(e) => write!(f, "invalid input: {e}"),
            Self::NotFound => f.write_str("game not found"),
            Self::Data(e) => write!(f, "catalog data: {e}"),
        }
    }
}

impl std::error::Error for CatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Db(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for CatalogError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
}

impl From<serde_json::Error> for CatalogError {
    fn from(e: serde_json::Error) -> Self {
        Self::Data(e.to_string())
    }
}

/// Result alias used throughout the crate.
pub type Result<T, E = CatalogError> = std::result::Result<T, E>;
