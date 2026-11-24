//! Online checks of the real fetchers (network; run by hand and by the integration step): a limited GamePix import
//! through `CatalogFetcher::for_feeds` and one thumbnail through the cache and `CatalogFetcher::for_thumbnails`.

mod common;

use common::games;
use common::*;
use gnome_server::games::GamesOptions;
use http::StatusCode;

#[tokio::test]
#[ignore = "fetches feeds.gamepix.com and img.gamepix.com"]
async fn gamepix_import_and_one_thumbnail() {
    let app = games::app_with(&[("GNOME_CATALOG_SOURCES", "gamepix")], |_| {}, GamesOptions::default()).await;
    let res = app
        .send_admin(games::admin_post(
            "/admin/catalog/import",
            &serde_json::json!({"sources": ["gamepix"], "limit": 96}),
        ))
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    games::settle(&app).await;
    let runs = app.send_admin(games::admin_get("/admin/catalog/imports")).await.json();
    assert_eq!(runs["runs"][0]["status"], "incomplete", "a limited run: {runs}");
    let list = app.send(get("/api/games?limit=1")).await.json();
    let thumb = list["items"][0]["thumbnail"].as_str().unwrap().to_string();
    let res = app.send(get(&thumb)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.header("content-type").unwrap().starts_with("image/"));
}
